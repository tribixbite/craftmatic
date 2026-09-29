/**
 * PNG writer for `holeShot` (web/src/engine/figure-holes.ts): one posed,
 * orthographic view of a figure in its swatch colours with its enclosed
 * see-through holes magenta. Shared by `_figure_holes.ts` (built packs) and
 * `_figure_compile_holes.ts` (in-process compiles).
 */
import sharp from 'sharp';
import { holeShot, type FigurePoseName, type UvFloorModel } from '../web/src/engine/figure-holes.ts';
import { resolveLdrawEntityMaterial } from '../web/src/engine/ldraw-entity-materials.ts';
import type { GeoEntryLike } from '../web/src/engine/bedrock-geometry-faces.ts';

/** Render `entry` in `pose` looking along `view` to `out`, scaled up to ~900 px. */
export async function writeHoleShot(entry: GeoEntryLike, pose: FigurePoseName, view: string, out: string, pixel = 0.05, onlyBones?: (bone: string) => boolean, uvFloor: UvFloorModel = 'none'): Promise<void> {
  const r = holeShot(entry, pose, view, pixel, g => (g.texture ? [230, 200, 160] : resolveLdrawEntityMaterial(g.ldrawColor ?? 16).rgb), onlyBones, uvFloor);
  const scale = Math.max(1, Math.floor(900 / Math.max(r.W, r.H)));
  await sharp(Buffer.from(r.rgb), { raw: { width: r.W, height: r.H, channels: 3 } }).resize(r.W * scale, r.H * scale, { kernel: 'nearest' }).png().toFile(out);
  console.log(`shot ${out} ${r.W}x${r.H} px of ${pixel} u, x${scale}`);
}
