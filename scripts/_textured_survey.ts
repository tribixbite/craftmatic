/**
 * Slice-4 evidence: what the "Textured + shapes" profile does to every LEGO
 * colour, and how much slack the shape bias actually has.
 *
 * For each LDraw colour with a known hex it prints the default profile's block,
 * the textured profile's block, the OKLab distance to the winner, and the
 * distance to the best SHAPE-CAPABLE candidate — so the effect of
 * `SHAPE_PENALTY` is visible per colour instead of inferred.
 *
 * Usage: bun scripts/_textured_survey.ts [--changed] [--csv]
 */
import { LDRAW_COLOR_RGB, ldrawColorToBlock } from '../web/src/engine/ldraw-colors.ts';
import {
  matchTextured, texturedLdrawColorToBlock, TEXTURED_PALETTE, SHAPE_PENALTY, rgbToOklab,
} from '../web/src/engine/textured-palette.ts';
import { SHAPE_VARIANTS } from '../web/src/engine/block-shapes.ts';

const onlyChanged = process.argv.includes('--changed');
const csv = process.argv.includes('--csv');

/**
 * `--probe #RRGGBB` — the top candidates for one colour with per-axis OKLab
 * deltas, chroma and hue. Tuning the gates off estimated numbers is how the
 * first cut shipped olive green as yellow bamboo planks.
 */
const probe = process.argv.find(a => a.startsWith('--probe='))?.slice('--probe='.length);
if (probe) {
  const rgb: [number, number, number] = [
    parseInt(probe.slice(1, 3), 16), parseInt(probe.slice(3, 5), 16), parseInt(probe.slice(5, 7), 16),
  ];
  const lab = rgbToOklab(...rgb);
  const pol = (l: readonly number[]) => ({
    C: Math.hypot(l[1]!, l[2]!), h: (Math.atan2(l[2]!, l[1]!) * 180 / Math.PI + 360) % 360,
  });
  const src = pol(lab);
  console.log(`source ${probe}  L ${lab[0].toFixed(3)}  a ${lab[1].toFixed(3)}  b ${lab[2].toFixed(3)}  C ${src.C.toFixed(3)}  h ${src.h.toFixed(0)}°`);
  const rows = TEXTURED_PALETTE.map(c => {
    const l = rgbToOklab(...(c.rgb as [number, number, number]));
    const p = pol(l);
    let dh = Math.abs(p.h - src.h); if (dh > 180) dh = 360 - dh;
    return {
      block: c.block.replace('minecraft:', ''),
      shapeable: SHAPE_VARIANTS[c.block]?.slab ? 'yes' : 'no',
      d: Math.hypot(lab[0] - l[0], lab[1] - l[1], lab[2] - l[2]).toFixed(3),
      dL: (l[0] - lab[0]).toFixed(3),
      C: p.C.toFixed(3), dh: dh.toFixed(0),
    };
  }).sort((a, b) => Number(a.d) - Number(b.d)).slice(0, 10);
  console.table(rows);
  process.exit(0);
}

const shapeCapable = TEXTURED_PALETTE.filter(c => SHAPE_VARIANTS[c.block]?.slab);
const shapeLab = shapeCapable.map(c => ({ block: c.block, lab: rgbToOklab(...(c.rgb as [number, number, number])) }));
const plainLab = TEXTURED_PALETTE.filter(c => !SHAPE_VARIANTS[c.block]?.slab)
  .map(c => ({ block: c.block, lab: rgbToOklab(...(c.rgb as [number, number, number])) }));

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

const rows: Array<Record<string, string | number>> = [];
let changed = 0, shaped = 0;

for (const [idStr, hex] of Object.entries(LDRAW_COLOR_RGB)) {
  const id = Number(idStr);
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) continue;
  const rgb: [number, number, number] = [
    parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
  ];
  const lab = rgbToOklab(...rgb);
  const dflt = ldrawColorToBlock(id);
  const tex = texturedLdrawColorToBlock(id);
  const m = matchTextured(...rgb);
  let bestShape = shapeLab[0]!, bestShapeD = Infinity;
  for (const s of shapeLab) {
    const d = dist(lab, s.lab);
    if (d < bestShapeD) { bestShapeD = d; bestShape = s; }
  }
  let bestPlain = plainLab[0]!, bestPlainD = Infinity;
  for (const s of plainLab) {
    const d = dist(lab, s.lab);
    if (d < bestPlainD) { bestPlainD = d; bestPlain = s; }
  }
  const isShaped = SHAPE_VARIANTS[tex]?.slab != null;
  if (tex !== dflt) changed++;
  if (isShaped) shaped++;
  if (onlyChanged && tex === dflt) continue;
  rows.push({
    id, hex,
    default: dflt.replace('minecraft:', ''),
    textured: tex.replace('minecraft:', ''),
    shapeable: isShaped ? 'yes' : 'no',
    dist: m.distance.toFixed(3),
    bestShape: bestShape.block.replace('minecraft:', ''),
    bestShapeDist: bestShapeD.toFixed(3),
    bestPlain: bestPlain.block.replace('minecraft:', ''),
    bestPlainDist: bestPlainD.toFixed(3),
    margin: (bestShapeD - bestPlainD).toFixed(3),
  });
}

if (csv) {
  console.log(Object.keys(rows[0]!).join(','));
  for (const r of rows) console.log(Object.values(r).join(','));
} else {
  console.table(rows);
}
console.log(JSON.stringify({
  shapePenalty: SHAPE_PENALTY,
  colours: Object.keys(LDRAW_COLOR_RGB).length,
  remapped: changed,
  landingOnShapeCapable: shaped,
  candidates: TEXTURED_PALETTE.length,
  shapeCapableCandidates: shapeCapable.length,
}));
