import sharp from 'sharp';
import { resolve } from 'path';

// Multi-view composite: satellite | ISO | top-down for better VLM grading
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
    name: 'Noe-v75',
    sat: 'output/tiles/sat-ref-noe.jpg',
    iso: 'output/tiles/noe-v75-iso.jpg',
    topdown: '', // no topdown yet
  },
  {
    name: 'Montgomery-v75c',
    sat: 'output/tiles/sat-ref-transamerica.jpg',
    iso: 'output/tiles/montgomery-v75c-iso.jpg',
    topdown: 'output/tiles/montgomery-v75c-topdown.jpg',
  },
];

for (const b of buildings) {
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

  const outPath = `output/tiles/grade-v75d-${b.name.toLowerCase().replace(/\s+/g, '-')}.jpg`;
  await Bun.write(outPath, composite);
  console.log(`${b.name}: ${outPath} (${(composite.length / 1024).toFixed(0)}KB)`);
}
