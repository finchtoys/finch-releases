/**
 * Cloudflare Worker — community.finchwork.app
 *
 * Serves any JSON file under the `community/` directory of
 * finchtoys/finch-releases as a public API endpoint with edge caching and CORS.
 *
 * File mapping (no code changes needed when adding new files):
 *   GET /extensions.json  → community/extensions.json
 *   GET /skills.json      → community/skills.json
 *   GET /anything.json    → community/anything.json   (auto-discovered)
 *
 * Deploy:
 *   1. Cloudflare Dashboard → Workers & Pages → Create → Deploy a Worker → paste this file.
 *   2. Settings → Variables → Secret variables → add GITHUB_TOKEN
 *      (fine-grained PAT, finchtoys/finch-releases, Contents: Read-only)
 *   3. Settings → Triggers → Custom Domains → community.finchwork.app
 */

const GITHUB_RAW_BASE =
  'https://raw.githubusercontent.com/finchtoys/finch-releases/main/community';

const CACHE_TTL = 3600; // 1 hour

/** Only allow JSON files to prevent arbitrary file exposure. */
function isAllowedPath(pathname) {
  return /^\/[a-z0-9_-]+\.json$/i.test(pathname);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === '/health') {
      return json({ ok: true, base: GITHUB_RAW_BASE });
    }

    // Guard: only serve *.json files, block directory traversal
    if (!isAllowedPath(path)) {
      return json({ error: 'Not found' }, 404);
    }

    const upstream = `${GITHUB_RAW_BASE}${path}`;

    // Try the edge cache first
    const cache = caches.default;
    const cacheKey = new Request(upstream, { method: 'GET' });
    let response = await cache.match(cacheKey);

    if (!response) {
      const headers = { 'User-Agent': 'community.finchwork.app/1.0' };
      if (env.GITHUB_TOKEN) {
        headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
      }

      const githubRes = await fetch(upstream, {
        headers,
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
      });

      if (!githubRes.ok) {
        const rateLimitInfo = {
          remaining: githubRes.headers.get('x-ratelimit-remaining'),
          reset: githubRes.headers.get('x-ratelimit-reset'),
        };
        return json(
          { error: 'Not found or upstream failed', status: githubRes.status, rateLimitInfo },
          githubRes.status === 404 ? 404 : 502,
        );
      }

      response = new Response(githubRes.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`,
          'Access-Control-Allow-Origin': '*',
          'X-Cache': 'MISS',
        },
      });

      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    } else {
      response = new Response(response.body, response);
      response.headers.set('X-Cache', 'HIT');
      response.headers.set('Access-Control-Allow-Origin', '*');
    }

    return response;
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
