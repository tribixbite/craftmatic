/**
 * Cloudflare Worker: CORS proxy for LDraw model sources + BFF API.
 *
 * Routes:
 *   craftmatic.click/ldraw-omr/*         → library.ldraw.org/library/omr/*
 *   craftmatic.click/seymouria-ldr/*     → seymouria.pl/Download/OfficialLegoSets_LDR/*
 *   craftmatic.click/bff/inventory/{num} → BrickLink Studio BFF API (server-side token)
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
