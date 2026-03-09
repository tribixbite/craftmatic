/**
 * Cloudflare Worker: CORS proxy for LDraw OMR.
 * Route: craftmatic.click/ldraw-omr/* → library.ldraw.org/library/omr/*
 */

const UPSTREAM = 'https://library.ldraw.org/library/omr';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Strip /ldraw-omr prefix to get filename
    const filename = url.pathname.replace(/^\/ldraw-omr\/?/, '');
    if (!filename) return new Response('Not found', { status: 404 });

    const upstreamUrl = `${UPSTREAM}/${filename}`;

    const resp = await fetch(upstreamUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'craftmatic-omr-proxy/1.0' },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });

    const headers = new Headers({
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
      'Content-Type': resp.headers.get('Content-Type') ?? 'application/octet-stream',
    });

    return new Response(resp.body, { status: resp.status, headers });
  },
};
