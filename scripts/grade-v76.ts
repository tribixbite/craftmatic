import sharp from 'sharp';
import { resolve } from 'path';
import { existsSync } from 'fs';

// v76 grading batch: 3-panel composites (satellite | ISO | top-down)
// All buildings voxelized with tight OSM mask (dilate=1)
const buildings = [
  {
    name: 'Flatiron-v75e',
    sat: 'output/tiles/sat-ref-flatiron.jpg',
    iso: 'output/tiles/flatiron-v75e-iso.jpg',
    topdown: 'output/tiles/flatiron-v75e-topdown.jpg',
  },
  {
    name: 'Sentinel-v75e',
    sat: 'output/tiles/sat-ref-sentinel.jpg',
    iso: 'output/tiles/sentinel-v75e-iso.jpg',
    topdown: 'output/tiles/sentinel-v75e-topdown.jpg',
  },
  {
    name: 'Noe-v76',
    sat: 'output/tiles/sat-ref-noe.jpg',
    iso: 'output/tiles/noe-v76-iso.jpg',
    topdown: 'output/tiles/noe-v76-topdown.jpg',
  },
  {
    name: 'Francisco-v76',
    sat: 'output/tiles/sat-ref-francisco.jpg',
    iso: 'output/tiles/francisco-v76-iso.jpg',
    topdown: 'output/tiles/francisco-v76-topdown.jpg',
  },
  {
    name: 'Beach-v76',
    sat: 'output/tiles/sat-ref-beach.jpg',
    iso: 'output/tiles/beach-v76-iso.jpg',
    topdown: 'output/tiles/beach-v76-topdown.jpg',
  },
  {
    name: 'Green-v76',
    sat: 'output/tiles/sat-ref-green.jpg',
    iso: 'output/tiles/green-v76-iso.jpg',
    topdown: 'output/tiles/green-v76-topdown.jpg',
  },
  {
    name: 'Dakota-v76',
    sat: 'output/tiles/sat-ref-dakota.jpg',
    iso: 'output/tiles/dakota-v76-iso.jpg',
    topdown: 'output/tiles/dakota-v76-topdown.jpg',
  },
  {
    name: 'StPatricks-v76',
    sat: 'output/tiles/sat-ref-stpatricks.jpg',
    iso: 'output/tiles/stpatricks-v76-iso.jpg',
    topdown: 'output/tiles/stpatricks-v76-topdown.jpg',
  },
];

for (const b of buildings) {
  // Skip if any file missing
  if (!existsSync(b.sat) || !existsSync(b.iso) || !existsSync(b.topdown)) {
    console.log(`${b.name}: SKIPPED (missing files)`);
    continue;
  }

  const sat = await sharp(resolve(b.sat)).resize(350, 350, { fit: 'inside' }).toBuffer();
  const iso = await sharp(resolve(b.iso)).resize(350, 350, { fit: 'inside' }).toBuffer();
  const td = await sharp(resolve(b.topdown)).resize(350, 350, { fit: 'inside' }).toBuffer();

  const satMeta = await sharp(sat).metadata();
  const isoMeta = await sharp(iso).metadata();
  const tdMeta = await sharp(td).metadata();
  const maxH = Math.max(satMeta.height!, isoMeta.height!, tdMeta.height!);

  // 3-panel: satellite | ISO render | top-down footprint
  const composite = await sharp({
    create: { width: 1100, height: maxH + 40, channels: 3, background: { r: 30, g: 30, b: 30 } },
  })
    .composite([
      { input: sat, left: 10, top: 30 },
      { input: iso, left: 370, top: 30 },
      { input: td, left: 730, top: 30 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

  const outPath = `output/tiles/grade-v76-${b.name.toLowerCase().replace(/\s+/g, '-')}.jpg`;
  await Bun.write(outPath, composite);
  console.log(`${b.name}: ${outPath} (${(composite.length / 1024).toFixed(0)}KB)`);
}
