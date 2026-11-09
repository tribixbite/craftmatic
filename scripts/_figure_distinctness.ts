/**
 * Figure design study (BIZ-21, WP-F01): measure the candidate figures against the
 * minifigure composite and draw the contact sheet the user picks from (U4).
 *
 *   bun scripts/_figure_distinctness.ts                 # table + output/f01/candidates.jpg
 *   bun scripts/_figure_distinctness.ts --parts 3062b.dat 3941.dat   # part bounds (LDU), to design with
 *
 * Reads parts from clego's `ldraw_ref/official` (CRAFTMATIC_LDRAW_REF overrides).
 * Candidates: test/fixtures/figures/*.ldr. The maths lives in
 * web/src/engine/figure-brickling.ts (shared with test/figure-brickling.test.ts).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  type FigTri, type PartResolver, type View, PLAYER_HEIGHT_BLOCKS, draftCanon, figureHeight, flattenFigure, measureDistinctness,
  minifigReferenceLdr, passesDistinctness, renderFigure, compatibilityProblems,
} from '../web/src/engine/figure-brickling.js';

const REF = process.env.CRAFTMATIC_LDRAW_REF ?? 'C:/git/clego/ldraw_ref';
const ROOT = resolve(import.meta.dir, '..');
export const FIXTURES = join(ROOT, 'test/fixtures/figures');

/** Resolve a part name against the official library's parts/, parts/s/ and p/ folders. */
export function officialResolver(ref = REF): PartResolver {
  return (name: string): string | null => {
    for (const dir of ['parts', 'p', 'parts']) {
      const f = join(ref, 'official', dir, name);
      if (existsSync(f)) return readFileSync(f, 'utf8');
    }
    return null;
  };
}

/** Load one candidate fixture (by file stem) as tagged triangles. */
export function loadCandidate(stem: string, resolver = officialResolver()): FigTri[] {
  return flattenFigure(readFileSync(join(FIXTURES, `${stem}.ldr`), 'utf8'), resolver);
}

/** The minifig composite as tagged triangles. */
export const loadMinifig = (resolver = officialResolver()): FigTri[] => flattenFigure(minifigReferenceLdr(), resolver);

const f2 = (n: number): string => n.toFixed(2);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resolver = officialResolver();
  const pi = args.indexOf('--parts');
  if (pi >= 0) {
    for (const p of args.slice(pi + 1)) {
      const tris = flattenFigure(`1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${p}`, resolver);
      // flattenFigure grounds the part; recompute raw bounds from a shifted copy is unnecessary: report extents.
      const xs = tris.flatMap(t => [t.a[0], t.b[0], t.c[0]]), ys = tris.flatMap(t => [t.a[1], t.b[1], t.c[1]]), zs = tris.flatMap(t => [t.a[2], t.b[2], t.c[2]]);
      const span = (v: number[]): string => `${Math.min(...v).toFixed(1)}..${Math.max(...v).toFixed(1)}`;
      console.log(`${p}: x ${span(xs)}  y(from base) ${span(ys)}  z ${span(zs)}`);
    }
    return;
  }

  const stems = readdirSync(FIXTURES).filter(f => f.endsWith('.ldr')).map(f => f.replace(/\.ldr$/, '')).sort();
  const minifig = loadMinifig(resolver);
  const figs = stems.map(s => ({ stem: s, tris: loadCandidate(s, resolver) }));

  console.log('| candidate | height LDU | front IoU (centred / best shift) | side IoU (centred / best shift) | head/height (minifig) | shoulder/height (minifig) | head diff | shoulder diff | gate |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const { stem, tris } of figs) {
    const d = measureDistinctness(tris, minifig);
    console.log(`| ${stem} | ${f2(d.heightLdu)} | ${f2(d.frontIou)} / ${f2(d.frontIouBestShift)} | ${f2(d.sideIou)} / ${f2(d.sideIouBestShift)} | ${f2(d.candidate.headToHeight)} (${f2(d.minifig.headToHeight)}) | ${f2(d.candidate.shoulderToHeight)} (${f2(d.minifig.shoulderToHeight)}) | ${(d.headRatioDifference * 100).toFixed(0)}% | ${(d.shoulderRatioDifference * 100).toFixed(0)}% | ${passesDistinctness(d) ? 'PASS' : 'FAIL'} |`);
  }
  console.log('\nDraft canon (LDU over the sole) and compatibility:');
  for (const { stem, tris } of figs) {
    const c = draftCanon(tris);
    const bl = PLAYER_HEIGHT_BLOCKS / c.heightLdu;
    console.log(`${stem}: hip ${c.hipHeightLdu.toFixed(0)}, eye ${c.eyeHeightLdu.toFixed(0)}, width ${c.widthLdu.toFixed(0)} (body ${c.bodyWidthLdu.toFixed(0)}), depth ${c.depthLdu.toFixed(0)}; at player scale (1.8 blocks): hip ${(c.hipHeightLdu * bl).toFixed(2)}, width ${(c.widthLdu * bl).toFixed(2)} (body ${(c.bodyWidthLdu * bl).toFixed(2)}), depth ${(c.depthLdu * bl).toFixed(2)} blocks; problems: ${compatibilityProblems(tris).join('; ') || 'none'}`);
  }
  console.log(`minifig: height ${figureHeight(minifig).toFixed(1)}`);

  // Contact sheet: one row per figure (minifig reference first), front / side / back.
  const CELL_W = 300, CELL_H = 400, LABEL_H = 34, VIEWS: View[] = ['front', 'side', 'back'];
  const rows = [{ stem: 'minifigure (reference)', tris: minifig }, ...figs];
  const W = CELL_W * VIEWS.length, H = (CELL_H + LABEL_H) * rows.length;
  const comps: sharp.OverlayOptions[] = [];
  for (let r = 0; r < rows.length; r++) {
    const { stem, tris } = rows[r]!;
    const d = r === 0 ? null : measureDistinctness(tris, minifig);
    const text = d ? `${stem}   ${d.heightLdu.toFixed(0)} LDU   IoU front ${f2(d.frontGate)} side ${f2(d.sideGate)}` : `${stem}   ${figureHeight(tris).toFixed(0)} LDU`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#14161b"/><text x="12" y="23" font-family="Arial" font-size="18" fill="#e8eaf0">${text}</text></svg>`;
    comps.push({ input: Buffer.from(svg), left: 0, top: r * (CELL_H + LABEL_H) });
    // All figures of one row use the minifig-relative scale so heights compare honestly.
    const scalePx = Math.round(330 * figureHeight(tris) / 140);
    for (let v = 0; v < VIEWS.length; v++) {
      const raw = renderFigure(tris, VIEWS[v]!, CELL_W * 2, CELL_H * 2, scalePx * 2);
      const png = await sharp(Buffer.from(raw), { raw: { width: CELL_W * 2, height: CELL_H * 2, channels: 3 } }).resize(CELL_W, CELL_H).png().toBuffer();
      comps.push({ input: png, left: v * CELL_W, top: r * (CELL_H + LABEL_H) + LABEL_H });
    }
  }
  const outDir = join(ROOT, 'output/f01');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'candidates.jpg');
  const jpg = await sharp({ create: { width: W, height: H, channels: 3, background: '#181b21' } }).composite(comps).jpeg({ quality: 88 }).toBuffer();
  writeFileSync(out, jpg);
  console.log(`\nwrote ${out} (${W}x${H}, ${(jpg.length / 1024).toFixed(0)} KB)`);
}

if (import.meta.main) await main();
