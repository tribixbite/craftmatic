/**
 * Cloudflare Worker: CORS proxy for LDraw model sources.
 *
 * Routes:
 *   craftmatic.click/ldraw-omr/*      → library.ldraw.org/library/omr/*
 *   craftmatic.click/seymouria-ldr/*  → seymouria.pl/Download/OfficialLegoSets_LDR/*
 */

const SOURCES = {
  '/ldraw-omr':     'https://library.ldraw.org/library/omr',
  '/seymouria-ldr': 'https://seymouria.pl/Download/OfficialLegoSets_LDR',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Match route prefix
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
