#!/usr/bin/env bun
/** Geocode all 12 evaluation addresses — output as coords for batch script. */
import { resolve } from 'path';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';
if (!API_KEY) { console.error('Set GOOGLE_MAPS_API_KEY'); process.exit(1); }

const ADDRESSES: Record<string, string> = {
  sf: '2340 Francisco St, San Francisco, CA 94123',
  newton: '240 Highland St, Newton, MA 02465',
  sanjose: '525 S Winchester Blvd, San Jose, CA 95128',
  walpole: '13 Union St, Walpole, NH 03608',
  byron: '2431 72nd St SW, Byron Center, MI 49315',
  vinalhaven: '216 Zekes Point Rd, Vinalhaven, ME 04863',
  suttonsbay: '5835 S Bridget Rose Ln, Suttons Bay, MI 49682',
  losangeles: '2607 Glendower Ave, Los Angeles, CA 90027',
  seattle: '4810 SW Ledroit Pl, Seattle, WA 98136',
  austin: '8504 Long Canyon Dr, Austin, TX 78730',
  minneapolis: '2730 Ulysses St NE, Minneapolis, MN 55418',
  charleston: '41 Legare St, Charleston, SC 29401',
};

for (const [name, addr] of Object.entries(ADDRESSES)) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${API_KEY}`;
  const resp = await fetch(url);
  const data = await resp.json() as any;
  if (data.results?.length) {
    const loc = data.results[0].geometry.location;
    console.log(`${name}: ${loc.lat},${loc.lng}`);
  } else {
    console.error(`${name}: FAILED`);
  }
}
