/**
 * Cloudflare Worker: CORS proxy for LDraw model sources + BFF API.
 *
 * Routes:
 *   craftmatic.click/ldraw-omr/*         → library.ldraw.org/library/omr/*
 *   craftmatic.click/ldraw-parts/*       → library.ldraw.org/library/{official,unofficial}/*
 *   craftmatic.click/seymouria-ldr/*     → seymouria.pl/Download/OfficialLegoSets_LDR/*
 *   craftmatic.click/bff/inventory/{num} → BrickLink Studio BFF API (server-side token)
 *
 * The /ldraw-parts route is what makes the 3D direct renderer work in
 * PRODUCTION: the parts library is dev-only on the local box (served from a
 * clego install via Vite middleware), so without this proxy the deployed app
 * has no .dat geometry and the renderer falls back to voxelization. This
 * proxies individual part/subpart/primitive files from the official LDraw
 * library (falling back to the unofficial library), CORS-enabled and
 * edge-cached, so every supported set renders with real brick geometry.
 */

const SOURCES = {
  '/ldraw-omr':     'https://library.ldraw.org/library/omr',
  '/seymouria-ldr': 'https://seymouria.pl/Download/OfficialLegoSets_LDR',
};

const BFF_BASE = 'https://api.prod.studio.bricklink.info/api/v1';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

/** Fetch an anonymous BFF token server-side (avoids CORS on token endpoint). */
async function getBffToken() {
  const r = await fetch(`${BFF_BASE}/authorization/token/anonymous`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`BFF token HTTP ${r.status}`);
  const data = await r.json();
  return data.token;
}

/** Fetch set inventory from BFF API using a fresh anonymous token. */
async function getBffInventory(setNum) {
  const token = await getBffToken();
  const params = new URLSearchParams({
    breakMinifigures: 'true',
    breakParts:       'true',
    breakSubsets:     'true',
    includeVariants:  'true',
  });
  const r = await fetch(
    `${BFF_BASE}/info/set/${encodeURIComponent(setNum)}/inventory?${params}`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } },
  );
  if (r.status === 404) {
    return new Response('{"items":[]}', {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
  if (!r.ok) throw new Error(`BFF inventory HTTP ${r.status}`);
  const json = await r.text();
  return new Response(json, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ── BFF inventory proxy ───────────────────────────────────────────────────
    const bffMatch = url.pathname.match(/^\/bff\/inventory\/(.+)$/);
    if (bffMatch && request.method === 'GET') {
      try {
        return await getBffInventory(decodeURIComponent(bffMatch[1]));
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    }

    // ── LDraw parts library proxy (official → unofficial fallback) ───────────
    // The client probes several candidate paths per part (parts/, p/,
    // parts/s/, p/48/, UnOfficial/...). We relay each to the matching upstream
    // library dir. Hits are edge-cached for a week; genuine 404s briefly.
    //
    // CRITICAL caching rule (prod incident 2026-08-17): a cold big-set load
    // bursts hundreds of part fetches; upstream rate-limiting then returns
    // errors, and blanket `cacheTtl + cacheEverything` EDGE-CACHED those
    // failures for a week — thousands of real parts "missing" until the cache
    // aged out. cacheTtlByStatus long-caches ONLY successes, and upstream
    // throttle/5xx responses are relayed as 503 no-store (NOT converted to a
    // cacheable 404) so the client retries instead of recording a miss.
    if (url.pathname.startsWith('/ldraw-parts/') && (request.method === 'GET' || request.method === 'HEAD')) {
      let rest = url.pathname.slice('/ldraw-parts/'.length).replace(/\.\./g, '');
      let libs = ['official', 'unofficial'];
      const unof = rest.match(/^unofficial\/(.*)$/i);
      if (unof) { rest = unof[1]; libs = ['unofficial']; }
      if (rest) {
        let sawTransient = false;
        for (const lib of libs) {
          const r = await fetch(`https://library.ldraw.org/library/${lib}/${rest}`, {
            method: 'GET',
            headers: { 'User-Agent': 'craftmatic-proxy/1.0' },
            cf: {
              cacheEverything: true,
              cacheTtlByStatus: { '200-299': 604800, '404': 300, '400-499': 0, '500-599': 0 },
            },
          });
          if (r.ok) {
            return new Response(request.method === 'HEAD' ? null : r.body, {
              status: 200,
              headers: {
                ...CORS_HEADERS,
                'Cache-Control': 'public, max-age=604800, immutable',
                'Content-Type': 'text/plain; charset=utf-8',
              },
            });
          }
          if (r.status !== 404 && r.status !== 410) sawTransient = true;
        }
        if (sawTransient) {
          return new Response(null, {
            status: 503,
            headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store', 'Retry-After': '2' },
          });
        }
      }
      return new Response(null, {
        status: 404,
        headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=600' },
      });
    }

    // ── LDraw / Seymouria CORS proxy ─────────────────────────────────────────
    let upstream = null;
    let strippedPath = url.pathname;
    for (const [prefix, upstreamBase] of Object.entries(SOURCES)) {
      if (url.pathname.startsWith(prefix)) {
        upstream = upstreamBase;
        strippedPath = url.pathname.slice(prefix.length).replace(/^\//, '');
        break;
      }
    }
    if (!upstream || !strippedPath) return new Response('Not found', { status: 404 });

    const upstreamUrl = `${upstream}/${strippedPath}`;
    const resp = await fetch(upstreamUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'craftmatic-proxy/1.0' },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });

    const headers = new Headers({
      ...CORS_HEADERS,
      'Cache-Control': 'public, max-age=86400',
      'Content-Type': resp.headers.get('Content-Type') ?? 'application/octet-stream',
    });

    return new Response(resp.body, { status: resp.status, headers });
  },
};
