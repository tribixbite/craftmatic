import sharp from 'sharp';
import { resolve } from 'path';
const buildings = [
  { name: 'Charleston-v78', sat: 'output/tiles/sat-ref-charleston.jpg', iso: 'output/tiles/charleston-v78-iso.jpg', topdown: 'output/tiles/charleston-v78-topdown.jpg' },
  { name: 'Newton-v78', sat: 'output/tiles/sat-ref-newton.jpg', iso: 'output/tiles/newton-v78-iso.jpg', topdown: 'output/tiles/newton-v78-topdown.jpg' },
  { name: 'Seattle-v78', sat: 'output/tiles/sat-ref-seattle.jpg', iso: 'output/tiles/seattle-v78-iso.jpg', topdown: 'output/tiles/seattle-v78-topdown.jpg' },
];
for (const b of buildings) {
  const sat = await sharp(resolve(b.sat)).resize(350, 350, { fit: 'inside' }).toBuffer();
  const iso = await sharp(resolve(b.iso)).resize(350, 350, { fit: 'inside' }).toBuffer();
  const td = await sharp(resolve(b.topdown)).resize(350, 350, { fit: 'inside' }).toBuffer();
  const satMeta = await sharp(sat).metadata();
  const isoMeta = await sharp(iso).metadata();
  const tdMeta = await sharp(td).metadata();
  const maxH = Math.max(satMeta.height!, isoMeta.height!, tdMeta.height!);
  const composite = await sharp({
    create: { width: 1100, height: maxH + 40, channels: 3, background: { r: 30, g: 30, b: 30 } },
  }).composite([
    { input: sat, left: 10, top: 30 },
    { input: iso, left: 370, top: 30 },
    { input: td, left: 730, top: 30 },
  ]).jpeg({ quality: 90 }).toBuffer();
  const outPath = `output/tiles/grade-v78-${b.name.toLowerCase()}.jpg`;
  await Bun.write(outPath, composite);
  console.log(`${b.name}: ${outPath} (${(composite.length / 1024).toFixed(0)}KB)`);
}
