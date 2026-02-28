#!/usr/bin/env bun
/**
 * Download Street View and Mapillary images for comparison addresses.
 * Saves as static files in web/public/comparison/ so deployed site has no API dependency.
 *
 * Usage: bun scripts/download-comparison-media.ts
 *   env: GOOGLE_API_KEY, MAPILLARY_ACCESS_TOKEN
 */

import { resolve } from 'node:path';

const DATA_PATH = resolve(import.meta.dir, '../output/comparison/comparison-data.json');
const OUT_DIR = resolve(import.meta.dir, '../web/public/comparison');

interface ApiRecord {
  name: string;
  status: string;
  data: Record<string, unknown>;
}
interface LocData {
  key: string;
  apis: ApiRecord[];
}

const svKey = process.env.GOOGLE_MAPS_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
const mlyToken = process.env.MAPILLARY_ACCESS_TOKEN ?? '';

if (!svKey) console.warn('⚠ GOOGLE_API_KEY not set — skipping Street View downloads');
if (!mlyToken) console.warn('⚠ MAPILLARY_ACCESS_TOKEN not set — skipping Mapillary downloads');

const data: LocData[] = JSON.parse(await Bun.file(DATA_PATH).text());

let downloaded = 0;
let skipped = 0;
let failed = 0;

for (const loc of data) {
  const svApi = loc.apis.find(a => a.name === 'Google Street View' && a.status === 'ok');
  const mlyApi = loc.apis.find(a => a.name === 'Mapillary' && a.status === 'ok');

  // Download Street View panorama
  if (svKey && svApi?.data?.panoId) {
    const panoId = String(svApi.data.panoId);
    const heading = svApi.data.heading ? String(svApi.data.heading).replace('°', '') : '0';
    const outFile = `${OUT_DIR}/${loc.key}-streetview.jpg`;

    if (await Bun.file(outFile).exists()) {
      console.log(`  skip ${loc.key}-streetview.jpg (exists)`);
      skipped++;
    } else {
      const url = `https://maps.googleapis.com/maps/api/streetview?size=640x400&pano=${encodeURIComponent(panoId)}&heading=${heading}&pitch=5&key=${svKey}`;
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (resp.ok && resp.headers.get('content-type')?.startsWith('image/')) {
          const buf = await resp.arrayBuffer();
          await Bun.write(outFile, buf);
          const kb = Math.round(buf.byteLength / 1024);
          console.log(`  ✓ ${loc.key}-streetview.jpg (${kb}KB)`);
          downloaded++;
        } else {
          console.warn(`  ✗ ${loc.key}-streetview.jpg — HTTP ${resp.status}`);
          failed++;
        }
      } catch (e) {
        console.warn(`  ✗ ${loc.key}-streetview.jpg — ${(e as Error).message}`);
        failed++;
      }
    }
  }

  // Download Mapillary thumbnail
  if (mlyToken && mlyApi?.data?.bestImageId) {
    const imageId = String(mlyApi.data.bestImageId);
    const outFile = `${OUT_DIR}/${loc.key}-mapillary.jpg`;

    if (await Bun.file(outFile).exists()) {
      console.log(`  skip ${loc.key}-mapillary.jpg (exists)`);
      skipped++;
    } else {
      // First get the thumb URL via graph API (it returns a CDN URL with TTL)
      const metaUrl = `https://graph.mapillary.com/${imageId}?fields=thumb_1024_url&access_token=${mlyToken}`;
      try {
        const metaResp = await fetch(metaUrl, { signal: AbortSignal.timeout(10000) });
        if (!metaResp.ok) {
          console.warn(`  ✗ ${loc.key}-mapillary.jpg — meta HTTP ${metaResp.status}`);
          failed++;
          continue;
        }
        const meta = await metaResp.json() as { thumb_1024_url?: string };
        const thumbUrl = meta.thumb_1024_url;
        if (!thumbUrl) {
          console.warn(`  ✗ ${loc.key}-mapillary.jpg — no thumb_1024_url in response`);
          failed++;
          continue;
        }

        const resp = await fetch(thumbUrl, { signal: AbortSignal.timeout(15000) });
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          await Bun.write(outFile, buf);
          const kb = Math.round(buf.byteLength / 1024);
          console.log(`  ✓ ${loc.key}-mapillary.jpg (${kb}KB)`);
          downloaded++;
        } else {
          console.warn(`  ✗ ${loc.key}-mapillary.jpg — image HTTP ${resp.status}`);
          failed++;
        }
      } catch (e) {
        console.warn(`  ✗ ${loc.key}-mapillary.jpg — ${(e as Error).message}`);
        failed++;
      }
    }
  }
}

console.log(`\nDone: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);
