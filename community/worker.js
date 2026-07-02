/**
 * Cloudflare Worker — community.finchwork.app
 *
 * Proxies static JSON files from the finchtoys/finch-releases GitHub repo
 * with edge caching and CORS headers so the Finch app can fetch them directly.
 *
 * Deploy:
 *   1. Create a Worker in the Cloudflare Dashboard (or via Wrangler).
 *   2. Paste this script.
 *   3. Add a Secret: Settings → Variables → Secret variables → GITHUB_TOKEN
 *      (a fine-grained PAT with read-only public repo access is enough)
 *   4. Add a Custom Domain: community.finchwork.app → this Worker.
 *
 * Routes:
 *   GET /extensions.json   → community/extensions.json (recommended extension list)
 *   GET /health            → {"ok":true}
 */

const GITHUB_RAW_BASE =
  'https://raw.githubusercontent.com/finchtoys/finch-releases/main/community';

/** Cache TTL in seconds. GitHub updates are picked up within this window. */
const CACHE_TTL = 3600; // 1 hour

const ROUTES = {
  '/extensions.json': `${GITHUB_RAW_BASE}/extensions.json`,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === '/health') {
      return json({ ok: true });
    }

    const upstream = ROUTES[path];
    if (!upstream) {
      return json({ error: 'Not found', path }, 404);
    }

    // Try the edge cache first
    const cache = caches.default;
    const cacheKey = new Request(upstream, { method: 'GET' });
    let response = await cache.match(cacheKey);

    if (!response) {
      // Cache miss — fetch from GitHub with token to avoid rate limits
      const headers = { 'User-Agent': 'community.finchwork.app/1.0' };
      if (env.GITHUB_TOKEN) {
        headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
      }

      const githubRes = await fetch(upstream, {
        headers,
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
      });

      if (!githubRes.ok) {
        // Pass through GitHub's rate-limit headers for debugging
        const rateLimitInfo = {
          remaining: githubRes.headers.get('x-ratelimit-remaining'),
          reset: githubRes.headers.get('x-ratelimit-reset'),
        };
        return json(
          { error: 'Upstream fetch failed', status: githubRes.status, rateLimitInfo },
          502,
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

      // Store in edge cache (fire and forget)
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    } else {
      // Cache hit
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
