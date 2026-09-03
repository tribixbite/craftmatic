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
  async fetch(request, env) {
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

    // ── Model corpus (same-origin, edge-compressed) ──────────────────────────
    // The viewer used to fetch models + the index straight from the R2 public
    // dev domain (pub-*.r2.dev), which serves bytes UNCOMPRESSED and off-zone
    // (extra TLS handshake, no edge cache). Serving them through this worker
    // puts them on the zone: Cloudflare gzip/brotli-compresses text responses
    // (a 2.4 MB index → ~0.5 MB; .ldr models ~4-5x smaller) and edge-caches
    // hits. Model keys are case-SENSITIVE exact relpaths under models/.
    if ((request.method === 'GET' || request.method === 'HEAD') && env?.MODELS) {
      let key = null, ctype = 'text/plain; charset=utf-8', ttl = 3600;
      if (url.pathname === '/lego-models-index.json') {
        key = 'lego-models-index.json';
        ctype = 'application/json';
        ttl = 300; // index updates on every corpus sync
      } else if (url.pathname.startsWith('/lego-models/')) {
        const rest = decodeURIComponent(url.pathname.slice('/lego-models/'.length)).replace(/\.\./g, '');
        if (rest) {
          key = `models/${rest}`;
          if (/\.(io|lxf|bin)$/i.test(rest)) ctype = 'application/octet-stream';
        }
      }
      if (key) {
        try {
          const obj = await env.MODELS.get(key);
          if (obj) {
            return new Response(request.method === 'HEAD' ? null : obj.body, {
              status: 200,
              headers: {
                ...CORS_HEADERS,
                'Cache-Control': `public, max-age=${ttl}`,
                'Content-Type': ctype,
              },
            });
          }
        } catch { /* R2 hiccup — fall through to 404 */ }
        return new Response(null, {
          status: 404,
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=60' },
        });
      }
    }

    // ── Batched parts multi-get ──────────────────────────────────────────────
    // A cold big-set load needs hundreds of small .dat files; fetching them
    // one-by-one is round-trip-bound even over H2. The client aggregates
    // pending part fetches and asks for up to ~48 R2 keys at once here; the
    // JSON response compresses well at the edge. R2-only — names the mirror
    // doesn't have come back in `missing` and the client falls back to the
    // per-file route (which still knows the upstream library).
    if (url.pathname === '/ldraw-parts/_batch' && request.method === 'GET' && env?.MODELS) {
      const files = (url.searchParams.get('files') || '')
        .split(',').map(s => s.trim().replace(/\.\./g, '')).filter(Boolean).slice(0, 64);
      const found = {};
      const missing = [];
      await Promise.all(files.map(async rest => {
        const unof = rest.match(/^unofficial\/(.*)$/i);
        const keys = unof
          ? [`ldraw/unofficial/${unof[1]}`.toLowerCase()]
          : [`ldraw/${rest}`.toLowerCase(), `ldraw/unofficial/${rest}`.toLowerCase()];
        for (const k of keys) {
          try {
            const obj = await env.MODELS.get(k);
            if (obj) { found[rest] = await obj.text(); return; }
          } catch { /* hiccup — treat as missing; client falls back */ }
        }
        missing.push(rest);
      }));
      return new Response(JSON.stringify({ found, missing }), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=604800',
        },
      });
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
      // Decode before building the R2 key: the library ships p/box3#8p.dat,
      // whose `#` the client must send as %23 or the URL ends at a fragment.
      // Left encoded, the key lookup misses an object that IS mirrored — the
      // same break already fixed on /lego-models/. Malformed escapes fall back
      // to the raw path rather than throwing a 500.
      let rest = url.pathname.slice('/ldraw-parts/'.length).replace(/\.\./g, '');
      try { rest = decodeURIComponent(rest); } catch { /* keep as-is */ }
      let libs = ['official', 'unofficial'];
      const unof = rest.match(/^unofficial\/(.*)$/i);
      if (unof) { rest = unof[1]; libs = ['unofficial']; }
      // R2-FIRST: the library is mirrored into the corpus bucket under
      // ldraw/<relpath> (scripts/sync-ldraw-r2.mjs). Self-hosted reads can't
      // be rate-limited; upstream below is only the fallback for unsynced
      // keys. Bare paths check the official mirror; UnOfficial/-prefixed
      // requests check the unofficial mirror key.
      if (rest && env?.MODELS) {
        // Keys are synced LOWERCASED (R2 is case-sensitive; the client's
        // normId() lowercases every request, LDraw filenames are lowercase
        // by convention). Bare paths check the official mirror THEN the
        // unofficial mirror (mirroring the upstream fallback order) so
        // unofficial-only parts are still served without touching upstream.
        const r2Keys = unof
          ? [`ldraw/unofficial/${rest}`.toLowerCase()]
          : [`ldraw/${rest}`.toLowerCase(), `ldraw/unofficial/${rest}`.toLowerCase()];
        for (const r2Key of r2Keys) {
          try {
            const obj = await env.MODELS.get(r2Key);
            if (obj) {
              return new Response(request.method === 'HEAD' ? null : obj.body, {
                status: 200,
                headers: {
                  ...CORS_HEADERS,
                  'Cache-Control': 'public, max-age=604800, immutable',
                  'Content-Type': 'text/plain; charset=utf-8',
                },
              });
            }
          } catch { /* R2 hiccup — fall through */ }
        }
      }
      if (rest) {
        let sawTransient = false;
        for (const lib of libs) {
          // One in-worker retry after a beat: upstream throttling is bursty
          // (per-second), so a brief wait often clears it without bouncing
          // the failure all the way back to the client.
          let r;
          for (let attempt = 0; attempt < 2; attempt++) {
            // Re-encode per segment for the upstream URL — `rest` is decoded
            // now, and a raw `#` would truncate the request at the fragment.
            r = await fetch(`https://library.ldraw.org/library/${lib}/${rest.split('/').map(encodeURIComponent).join('/')}`, {
              method: 'GET',
              headers: { 'User-Agent': 'craftmatic-proxy/1.0' },
              cf: {
                cacheEverything: true,
                cacheTtlByStatus: { '200-299': 604800, '404': 300, '400-499': 0, '500-599': 0 },
              },
            });
            if (r.ok || r.status === 404 || r.status === 410) break;
            if (attempt === 0) await new Promise(res => setTimeout(res, 600));
          }
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
