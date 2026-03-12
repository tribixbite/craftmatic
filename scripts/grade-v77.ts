import sharp from 'sharp';
import { resolve } from 'path';
import { existsSync } from 'fs';

// v78 grading: tight OSM mask + luminance contrast enforcement
const buildings = [
  { name: 'Flatiron-v78', sat: 'output/tiles/sat-ref-flatiron.jpg', iso: 'output/tiles/flatiron-v78-iso.jpg', topdown: 'output/tiles/flatiron-v78-topdown.jpg' },
  { name: 'Sentinel-v78', sat: 'output/tiles/sat-ref-sentinel.jpg', iso: 'output/tiles/sentinel-v78-iso.jpg', topdown: 'output/tiles/sentinel-v78-topdown.jpg' },
  { name: 'Noe-v78', sat: 'output/tiles/sat-ref-noe.jpg', iso: 'output/tiles/noe-v78-iso.jpg', topdown: 'output/tiles/noe-v78-topdown.jpg' },
  { name: 'Francisco-v78', sat: 'output/tiles/sat-ref-francisco.jpg', iso: 'output/tiles/francisco-v78-iso.jpg', topdown: 'output/tiles/francisco-v78-topdown.jpg' },
  { name: 'Beach-v78', sat: 'output/tiles/sat-ref-beach.jpg', iso: 'output/tiles/beach-v78-iso.jpg', topdown: 'output/tiles/beach-v78-topdown.jpg' },
  { name: 'Green-v78', sat: 'output/tiles/sat-ref-green.jpg', iso: 'output/tiles/green-v78-iso.jpg', topdown: 'output/tiles/green-v78-topdown.jpg' },
  { name: 'Dakota-v78', sat: 'output/tiles/sat-ref-dakota.jpg', iso: 'output/tiles/dakota-v78-iso.jpg', topdown: 'output/tiles/dakota-v78-topdown.jpg' },
  { name: 'StPatricks-v78', sat: 'output/tiles/sat-ref-stpatricks.jpg', iso: 'output/tiles/stpatricks-v78-iso.jpg', topdown: 'output/tiles/stpatricks-v78-topdown.jpg' },
];

for (const b of buildings) {
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
  const outPath = `output/tiles/grade-v78-${b.name.toLowerCase().replace(/\s+/g, '-')}.jpg`;
  await Bun.write(outPath, composite);
  console.log(`${b.name}: ${outPath} (${(composite.length / 1024).toFixed(0)}KB)`);
}
