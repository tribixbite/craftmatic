if (typeof globalThis.ProgressEvent === 'undefined') {
  (globalThis as Record<string, unknown>).ProgressEvent = class ProgressEvent extends Event {
    readonly lengthComputable: boolean;
    readonly loaded: number;
    readonly total: number;
    constructor(type: string, init?: { lengthComputable?: boolean; loaded?: number; total?: number }) {
      super(type);
      this.lengthComputable = init?.lengthComputable ?? false;
      this.loaded = init?.loaded ?? 0;
      this.total = init?.total ?? 0;
    }
  };
}

import sharp from 'sharp';

const glb = new Uint8Array(await Bun.file(process.argv[2]).arrayBuffer());
const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
const jsonLen = view.getUint32(12, true);
const jsonBytes = glb.slice(20, 20 + jsonLen);
const json = JSON.parse(new TextDecoder().decode(jsonBytes));
const binOffset = 20 + jsonLen;
const binLen = view.getUint32(binOffset, true);
const binData = glb.slice(binOffset + 8, binOffset + 8 + binLen);

const images = json.images as Array<{ bufferView?: number; mimeType?: string }>;
const bufferViews = json.bufferViews as Array<{ byteOffset?: number; byteLength: number }>;

for (let i = 0; i < images.length; i++) {
  const img = images[i];
  if (img.bufferView === undefined) continue;
  const bv = bufferViews[img.bufferView];
  const offset = bv.byteOffset ?? 0;
  const imgBuf = binData.slice(offset, offset + bv.byteLength);
  
  const s = sharp(Buffer.from(imgBuf));
  const meta = await s.metadata();
  const raw = await s.ensureAlpha().raw().toBuffer();
  
  let totalR = 0, totalG = 0, totalB = 0;
  let darkPx = 0, midPx = 0, lightPx = 0;
  const pixelCount = raw.length / 4;
  
  for (let p = 0; p < raw.length; p += 4) {
    const r = raw[p], g = raw[p+1], b = raw[p+2];
    totalR += r; totalG += g; totalB += b;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < 85) darkPx++;
    else if (lum < 170) midPx++;
    else lightPx++;
  }
  
  const avgR = Math.round(totalR / pixelCount);
  const avgG = Math.round(totalG / pixelCount);
  const avgB = Math.round(totalB / pixelCount);
  const avgLum = Math.round(0.299 * avgR + 0.587 * avgG + 0.114 * avgB);
  
  console.log(`Image ${i}: ${meta.width}x${meta.height} ${img.mimeType || 'unknown'}`);
  console.log(`  Avg RGB: (${avgR}, ${avgG}, ${avgB}) Luminance: ${avgLum}`);
  console.log(`  Dark(<85): ${(darkPx/pixelCount*100).toFixed(1)}% Mid: ${(midPx/pixelCount*100).toFixed(1)}% Light(>170): ${(lightPx/pixelCount*100).toFixed(1)}%`);
}
