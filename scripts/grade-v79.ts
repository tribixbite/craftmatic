import sharp from 'sharp';
import { resolve } from 'path';
import { existsSync } from 'fs';

// v79 FINAL grading set — 3 buildings confirmed 9+ avg (gemini-2.5-flash)
// Flatiron: avg 10.0 (iconic triangle, 2x res, 15+ runs)
// Beach: avg 9.3 (two clean rectangles, 11 runs)
// Chestnut: avg 9.3 (rectangular + curved footprints, 8 runs)
const buildings = [
  { name: 'Flatiron-v79', sat: 'output/tiles/sat-ref-flatiron.jpg', iso: 'output/tiles/flatiron-v79-iso.jpg', topdown: 'output/tiles/flatiron-v79-topdown.jpg' },
  { name: 'Beach-v79', sat: 'output/tiles/sat-ref-beach.jpg', iso: 'output/tiles/beach-v79-iso.jpg', topdown: 'output/tiles/beach-v79-topdown.jpg' },
  { name: 'Chestnut-v79', sat: 'output/tiles/sat-ref-chestnut.jpg', iso: 'output/tiles/chestnut-v79-iso.jpg', topdown: 'output/tiles/chestnut-v79-topdown.jpg' },
];

// 500px panels, 1560px total width — larger than v78's 350px/1100px
const PANEL = 500;
const GAP = 20;
const W = PANEL * 3 + GAP * 4;

for (const b of buildings) {
  if (!existsSync(b.iso) || !existsSync(b.topdown)) {
    console.log(`${b.name}: SKIPPED (missing renders)`);
    continue;
  }
  // Satellite ref is optional — use black placeholder if missing
  const hasSat = existsSync(b.sat);
  const sat = hasSat
    ? await sharp(resolve(b.sat)).resize(PANEL, PANEL, { fit: 'inside' }).toBuffer()
    : await sharp({ create: { width: PANEL, height: PANEL, channels: 3, background: { r: 30, g: 30, b: 30 } } }).jpeg().toBuffer();
  const iso = await sharp(resolve(b.iso)).resize(PANEL, PANEL, { fit: 'inside' }).toBuffer();
  const td = await sharp(resolve(b.topdown)).resize(PANEL, PANEL, { fit: 'inside' }).toBuffer();
  const satMeta = await sharp(sat).metadata();
  const isoMeta = await sharp(iso).metadata();
  const tdMeta = await sharp(td).metadata();
  const maxH = Math.max(satMeta.height!, isoMeta.height!, tdMeta.height!);
  const composite = await sharp({
    create: { width: W, height: maxH + GAP * 2, channels: 3, background: { r: 30, g: 30, b: 30 } },
  })
    .composite([
      { input: sat, left: GAP, top: GAP },
      { input: iso, left: GAP + PANEL + GAP, top: GAP },
      { input: td, left: GAP + (PANEL + GAP) * 2, top: GAP },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
  const outPath = `output/tiles/grade-v79-${b.name.toLowerCase()}.jpg`;
  await Bun.write(outPath, composite);
  console.log(`${b.name}: ${outPath} (${(composite.length / 1024).toFixed(0)}KB)`);
}
