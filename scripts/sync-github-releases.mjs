
const token = process.env.GITHUB_TOKEN;
if (!token) {
  throw new Error('Missing GITHUB_TOKEN');
}

const sourceRepo = process.env.SOURCE_REPO || 'puterjam/finch';
const targetRepo = process.env.TARGET_REPO || process.env.GITHUB_REPOSITORY;
const includeDrafts = process.env.INCLUDE_DRAFTS === 'true';
const overwriteAssets = process.env.OVERWRITE_ASSETS === 'true';
const overwriteBody = process.env.OVERWRITE_BODY === 'true';
const skipExistingReleases = process.env.SKIP_EXISTING_RELEASES !== 'false';
const maxReleases = Number(process.env.MAX_RELEASES || '0');

if (!targetRepo) {
  throw new Error('Missing TARGET_REPO or GITHUB_REPOSITORY');
}

const [sourceOwner, sourceName] = splitRepo(sourceRepo);
const [targetOwner, targetName] = splitRepo(targetRepo);

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'finch-release-sync',
};

const targetRepoInfo = await getRepo(targetOwner, targetName);

async function main() {
  console.log(`Source: ${sourceOwner}/${sourceName}`);
  console.log(`Target: ${targetOwner}/${targetName}`);
  console.log(`Options: includeDrafts=${includeDrafts}, overwriteAssets=${overwriteAssets}, overwriteBody=${overwriteBody}, skipExistingReleases=${skipExistingReleases}, maxReleases=${maxReleases || 'all'}`);

  let releases = await listReleases(sourceOwner, sourceName);
  if (!includeDrafts) {
    releases = releases.filter((release) => !release.draft);
  }
  if (maxReleases > 0) {
    releases = releases.slice(0, maxReleases);
  }

  if (releases.length === 0) {
    console.log('No releases to sync.');
    return;
  }

  console.log(`Found ${releases.length} release(s) to sync.`);

  for (const release of releases) {
    await syncRelease(release);
  }

  console.log('Release sync completed.');
}

async function syncRelease(sourceRelease) {
  const tag = sourceRelease.tag_name;
  console.log(`\n==> Syncing ${tag}`);

  let targetRelease = await getReleaseByTag(targetOwner, targetName, tag);

  if (!targetRelease) {
    targetRelease = await createReleaseFromSource(sourceRelease);
    console.log(`Created target release for ${tag}`);
  } else {
    console.log(`Target release already exists for ${tag}`);
    if (skipExistingReleases && !overwriteBody && !overwriteAssets) {
      console.log(`Skipping ${tag} because release already exists.`);
      return;
    }
    if (overwriteBody) {
      targetRelease = await updateRelease(targetRelease.id, sourceRelease);
      console.log(`Updated release metadata for ${tag}`);
    }
  }

  await syncAssets(sourceRelease, targetRelease);
}

async function syncAssets(sourceRelease, targetRelease) {
  const sourceAssets = sourceRelease.assets || [];
  if (sourceAssets.length === 0) {
    console.log('No assets to sync.');
    return;
  }

  const latestTargetRelease = await getReleaseByTag(targetOwner, targetName, targetRelease.tag_name);
  const targetAssets = new Map((latestTargetRelease?.assets || []).map((asset) => [asset.name, asset]));

  for (const asset of sourceAssets) {
    const existing = targetAssets.get(asset.name);
    if (existing && !overwriteAssets) {
      console.log(`- Asset exists, skipping: ${asset.name}`);
      continue;
    }

    if (existing && overwriteAssets) {
      await githubJson(`https://api.github.com/repos/${targetOwner}/${targetName}/releases/assets/${existing.id}`, {
        method: 'DELETE',
      }, false);
      console.log(`- Deleted existing asset: ${asset.name}`);
    }

    const buffer = await downloadAsset(asset.browser_download_url);
    await uploadAsset(targetRelease.upload_url, asset.name, asset.content_type || 'application/octet-stream', buffer);
    console.log(`- Uploaded asset: ${asset.name}`);
  }
}

async function listReleases(owner, repo) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubJson(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return releases;
}

async function getRepo(owner, repo) {
  return githubJson(`https://api.github.com/repos/${owner}/${repo}`);
}

async function getReleaseByTag(owner, repo, tag) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers,
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get release by tag ${tag}: ${response.status} ${body}`);
  }

  return response.json();
}

async function createReleaseFromSource(sourceRelease) {
  return githubJson(`https://api.github.com/repos/${targetOwner}/${targetName}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: sourceRelease.tag_name,
      name: sourceRelease.name || sourceRelease.tag_name,
      body: sourceRelease.body || '',
      draft: includeDrafts ? sourceRelease.draft : false,
      prerelease: sourceRelease.prerelease,
      target_commitish: targetRepoInfo.default_branch,
    }),
  });
}

async function updateRelease(releaseId, sourceRelease) {
  return githubJson(`https://api.github.com/repos/${targetOwner}/${targetName}/releases/${releaseId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: sourceRelease.name || sourceRelease.tag_name,
      body: sourceRelease.body || '',
      draft: includeDrafts ? sourceRelease.draft : false,
      prerelease: sourceRelease.prerelease,
    }),
  });
}

async function uploadAsset(uploadUrlTemplate, assetName, contentType, buffer) {
  const uploadUrl = uploadUrlTemplate.replace('{?name,label}', `?name=${encodeURIComponent(assetName)}`);
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': contentType,
      'Content-Length': String(buffer.byteLength),
    },
    body: buffer,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to upload asset ${assetName}: ${response.status} ${body}`);
  }

  return response.json();
}

async function downloadAsset(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'finch-release-sync',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to download asset ${url}: ${response.status} ${body}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function githubJson(url, init = {}, expectJson = true) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed: ${response.status} ${body}`);
  }

  return expectJson ? response.json() : null;
}

function splitRepo(value) {
  const parts = value.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format: ${value}. Expected owner/repo.`);
  }
  return parts;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
