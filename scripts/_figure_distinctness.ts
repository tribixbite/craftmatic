/**
 * Figure design study (BIZ-21, WP-F01 / F01b): measure the candidate figures against the
 * minifigure composite and draw the contact sheet the user picks from (U4).
 *
 *   bun scripts/_figure_distinctness.ts                 # table over every pass + output/f01b/candidates.jpg
 *   bun scripts/_figure_distinctness.ts --sheet=f01     # the F01 sheet (output/f01/candidates.jpg, front/side/back)
 *   bun scripts/_figure_distinctness.ts --parts 3062b.dat 3941.dat   # part bounds (LDU), to design with
 *
 * The F01b sheet shows the F01b candidates in front, side, back and three-quarter view,
 * under the minifig reference and the best F01 candidate (lowest worst-view IoU), for comparison.
 *
 * Reads parts from clego's `ldraw_ref/official` (CRAFTMATIC_LDRAW_REF overrides).
 * Candidates: test/fixtures/figures/*.ldr, listed per pass in `FIGURE_CANDIDATES`. The maths
 * lives in web/src/engine/figure-brickling.ts (shared with test/figure-brickling*.test.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  type FigTri, type PartResolver, type View, FIGURE_CANDIDATES, PLAYER_HEIGHT_BLOCKS, compatibilityProblems, draftCanon,
  figureHeight, flattenFigure, limbAttachmentGaps, measureDistinctness, minifigReferenceLdr, passesDistinctness, renderFigure,
} from '../web/src/engine/figure-brickling.js';

const REF = process.env.CRAFTMATIC_LDRAW_REF ?? 'C:/git/clego/ldraw_ref';
const ROOT = resolve(import.meta.dir, '..');
export const FIXTURES = join(ROOT, 'test/fixtures/figures');

/** Resolve a part name against the official library's parts/ (incl. parts/s/) and p/ folders. */
export function officialResolver(ref = REF): PartResolver {
  return (name: string): string | null => {
    for (const dir of ['parts', 'p']) {
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

type Pass = keyof typeof FIGURE_CANDIDATES;
interface Fig { stem: string; tris: FigTri[] }

/** The contact sheet of one pass: a label row + one row per figure, the given views as columns. */
async function contactSheet(rows: readonly Fig[], views: readonly View[], minifig: readonly FigTri[], out: string, CELL_H = 400): Promise<void> {
  const CELL_W = 300, LABEL_H = 34;
  const W = CELL_W * views.length, H = (CELL_H + LABEL_H) * rows.length;
  if (W >= 2000 || H >= 2000) throw new Error(`contact sheet ${W}x${H} would reach 2000 px; fewer rows or views`);
  const comps: sharp.OverlayOptions[] = [];
  for (let r = 0; r < rows.length; r++) {
    const { stem, tris } = rows[r]!;
    const d = tris === minifig ? null : measureDistinctness(tris, minifig);
    const text = d ? `${stem}   ${d.heightLdu.toFixed(0)} LDU   IoU front ${f2(d.frontGate)} side ${f2(d.sideGate)}   head ${f2(d.candidate.headToHeight)} shoulder ${f2(d.candidate.shoulderToHeight)}` : `${stem}   ${figureHeight(tris).toFixed(0)} LDU`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#14161b"/><text x="12" y="23" font-family="Arial" font-size="18" fill="#e8eaf0">${text}</text></svg>`;
    comps.push({ input: Buffer.from(svg), left: 0, top: r * (CELL_H + LABEL_H) });
    // All figures use the same LDU scale (a 140 LDU figure fills the cell less a margin), so heights compare honestly across rows.
    const scalePx = Math.round((CELL_H - 70) * figureHeight(tris) / 140);
    for (let v = 0; v < views.length; v++) {
      const raw = renderFigure(tris, views[v]!, CELL_W * 2, CELL_H * 2, scalePx * 2);
      const png = await sharp(Buffer.from(raw), { raw: { width: CELL_W * 2, height: CELL_H * 2, channels: 3 } }).resize(CELL_W, CELL_H).png().toBuffer();
      comps.push({ input: png, left: v * CELL_W, top: r * (CELL_H + LABEL_H) + LABEL_H });
    }
  }
  mkdirSync(resolve(out, '..'), { recursive: true });
  const jpg = await sharp({ create: { width: W, height: H, channels: 3, background: '#181b21' } }).composite(comps).jpeg({ quality: 88 }).toBuffer();
  if (jpg.length >= 4 * 1024 * 1024) throw new Error(`contact sheet is ${jpg.length} bytes; lower the quality`);
  writeFileSync(out, jpg);
  console.log(`\nwrote ${out} (${W}x${H}, ${(jpg.length / 1024).toFixed(0)} KB)`);
}

/** The F01 candidate with the lowest worst-view IoU: the comparison row of the F01b sheet. */
export function bestOf(figs: readonly Fig[], minifig: readonly FigTri[]): Fig {
  const worst = (f: Fig): number => { const d = measureDistinctness(f.tris, minifig); return Math.max(d.frontGate, d.sideGate); };
  return figs.map(f => ({ f, worst: worst(f) })).sort((a, b) => a.worst - b.worst)[0]!.f;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resolver = officialResolver();
  const pi = args.indexOf('--parts');
  if (pi >= 0) {
    for (const p of args.slice(pi + 1)) {
      const tris = flattenFigure(`1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${p}`, resolver);
      // flattenFigure grounds the part, so the y span reads from its base; x/z are the part's own.
      const xs = tris.flatMap(t => [t.a[0], t.b[0], t.c[0]]), ys = tris.flatMap(t => [t.a[1], t.b[1], t.c[1]]), zs = tris.flatMap(t => [t.a[2], t.b[2], t.c[2]]);
      const span = (v: number[]): string => `${Math.min(...v).toFixed(1)}..${Math.max(...v).toFixed(1)}`;
      console.log(`${p}: x ${span(xs)}  y(from base) ${span(ys)}  z ${span(zs)}`);
    }
    return;
  }
  const sheet = (args.find(a => a.startsWith('--sheet='))?.slice(8) ?? 'f01b') as Pass;
  if (!(sheet in FIGURE_CANDIDATES)) throw new Error(`unknown pass "${sheet}"; one of ${Object.keys(FIGURE_CANDIDATES).join(', ')}`);

  const minifig = loadMinifig(resolver);
  const byPass = Object.fromEntries((Object.keys(FIGURE_CANDIDATES) as Pass[]).map(k => [k, FIGURE_CANDIDATES[k].map(stem => ({ stem, tris: loadCandidate(stem, resolver) }))])) as Record<Pass, Fig[]>;
  const figs = (Object.keys(byPass) as Pass[]).flatMap(k => byPass[k].map(f => ({ ...f, pass: k })));

  console.log('| pass | candidate | height LDU | front IoU (centred / best shift) | side IoU (centred / best shift) | head/height (minifig) | shoulder/height (minifig) | head diff | shoulder diff | gate |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const { pass, stem, tris } of figs) {
    const d = measureDistinctness(tris, minifig);
    console.log(`| ${pass} | ${stem} | ${f2(d.heightLdu)} | ${f2(d.frontIou)} / ${f2(d.frontIouBestShift)} | ${f2(d.sideIou)} / ${f2(d.sideIouBestShift)} | ${f2(d.candidate.headToHeight)} (${f2(d.minifig.headToHeight)}) | ${f2(d.candidate.shoulderToHeight)} (${f2(d.minifig.shoulderToHeight)}) | ${(d.headRatioDifference * 100).toFixed(0)}% | ${(d.shoulderRatioDifference * 100).toFixed(0)}% | ${passesDistinctness(d) ? 'PASS' : 'FAIL'} |`);
  }
  console.log('\nDraft canon (LDU over the sole), player-scale sizes and compatibility:');
  console.log('| candidate | hip | eye | width (body) LDU | depth LDU | at 1.8 blocks: width (body) | depth | limb gaps to torso | problems |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const { stem, tris } of figs) {
    const c = draftCanon(tris);
    const bl = PLAYER_HEIGHT_BLOCKS / c.heightLdu;
    const gaps = limbAttachmentGaps(tris);
    console.log(`| ${stem} | ${c.hipHeightLdu.toFixed(0)} | ${c.eyeHeightLdu.toFixed(0)} | ${c.widthLdu.toFixed(0)} (${c.bodyWidthLdu.toFixed(0)}) | ${c.depthLdu.toFixed(0)} | ${(c.widthLdu * bl).toFixed(2)} (${(c.bodyWidthLdu * bl).toFixed(2)}) | ${(c.depthLdu * bl).toFixed(2)} | ${Object.values(gaps).map(g => g.toFixed(0)).join('/')} | ${compatibilityProblems(tris).join('; ') || 'none'} |`);
  }
  console.log(`minifig: height ${figureHeight(minifig).toFixed(1)}`);

  const reference: Fig = { stem: 'minifigure (reference)', tris: minifig };
  if (sheet === 'f01') {
    await contactSheet([reference, ...byPass.f01], ['front', 'side', 'back'], minifig, join(ROOT, 'output/f01/candidates.jpg'));
  } else {
    const best = bestOf(byPass.f01, minifig);
    await contactSheet([reference, { ...best, stem: `${best.stem} (best of F01)` }, ...byPass.f01b], ['front', 'side', 'back', 'quarter'], minifig, join(ROOT, 'output/f01b/candidates.jpg'), 340);
  }
}

if (import.meta.main) await main();
