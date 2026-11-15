/**
 * How much of each face-art file the compiler's photo-skin drop (`photoSkinColour`, head-face.ts) removes.
 * Usage: bun scripts/_face_art_skin_probe.ts <art-dir>
 */
import { photoSkinColour, PHOTO_SKIN_TOLERANCE } from '../web/src/engine/head-face.ts';
import { readFaceArtDir } from './model-source.ts';

for (const [id, art] of readFaceArtDir(process.argv[2]!)) {
  let opaque = 0, dropped = 0;
  const skin = photoSkinColour(art);
  for (let i = 0; i < art.width * art.height; i++) {
    if (art.rgba[i * 4 + 3]! < 128) continue;
    opaque++;
    if (skin && Math.hypot(art.rgba[i * 4]! - skin[0], art.rgba[i * 4 + 1]! - skin[1], art.rgba[i * 4 + 2]! - skin[2]) < PHOTO_SKIN_TOLERANCE) dropped++;
  }
  console.log(`${id.padEnd(12)} opaque ${String(opaque).padStart(5)} dropped ${String(dropped).padStart(5)} (${opaque ? Math.round(100 * dropped / opaque) : 0} %) skin ${skin ? skin.map(Math.round).join(',') : '-'}`);
}
