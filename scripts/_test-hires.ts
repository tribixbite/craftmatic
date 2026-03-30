import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderSatelliteHiRes } from '../src/render/png-renderer.js';

sharp.concurrency(1);
const root = resolve(import.meta.dir, '..');
const tilesDir = join(root, 'output/tiles');
const dotenv = await Bun.file(join(root, '.env')).text();
const apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim()!;

const name = 'test-newton-headless';
const lat = 42.3435, lng = -71.2215, zoom = 20, resolution = 4;

const schemPath = join(tilesDir, `${name}-v26.schem`);
const grid = await parseToGrid(schemPath);
console.log(`Grid: ${grid.width}x${grid.height}x${grid.length}`);

const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=640x640&maptype=satellite&key=${apiKey}`;
const resp = await fetch(url);
const satJpg = Buffer.from(await resp.arrayBuffer());
const { data: satRaw, info } = await sharp(satJpg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
console.log(`Satellite: ${info.width}x${info.height}`);

const png = await renderSatelliteHiRes(grid, satRaw, info.width, info.height, { resolution, lat, zoom });
const jpg = await sharp(png).jpeg({ quality: 85 }).toBuffer();
const outPath = join(tilesDir, `sv-${name}-hires.jpg`);
await Bun.write(outPath, jpg);
console.log(`Wrote: ${outPath} (${(jpg.length / 1024).toFixed(0)}KB)`);
