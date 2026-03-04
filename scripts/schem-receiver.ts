/**
 * Simple HTTP server that receives .schem files from the browser's batch
 * voxelize function and saves them to output/tiles/.
 *
 * Usage: bun scripts/schem-receiver.ts
 * Listens on http://localhost:3456
 *
 * The browser POSTs raw binary data to /save/:filename
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = 3456;
const OUTPUT_DIR = join(import.meta.dir, '..', 'output', 'tiles');

await mkdir(OUTPUT_DIR, { recursive: true });

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    // CORS headers for browser requests
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(req.url);

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, dir: OUTPUT_DIR }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // Save file: POST /save/:filename
    if (req.method === 'POST' && url.pathname.startsWith('/save/')) {
      const filename = decodeURIComponent(url.pathname.slice(6));
      if (!filename || filename.includes('..') || filename.includes('/')) {
        return new Response('Invalid filename', { status: 400, headers });
      }

      const data = await req.arrayBuffer();
      const filepath = join(OUTPUT_DIR, filename);
      await Bun.write(filepath, new Uint8Array(data));
      console.log(`Saved: ${filename} (${data.byteLength} bytes)`);
      return new Response(JSON.stringify({ ok: true, filename, bytes: data.byteLength }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404, headers });
  },
});

console.log(`Schem receiver listening on http://localhost:${PORT}`);
console.log(`Saving files to: ${OUTPUT_DIR}`);
