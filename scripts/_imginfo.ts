import sharp from 'sharp';
for (const f of process.argv.slice(2)) {
  const m = await sharp(f).metadata();
  console.log(`${f}: ${m.width}x${m.height} ${m.format}`);
}
