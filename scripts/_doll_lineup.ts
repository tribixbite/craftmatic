/**
 * A model's mini-dolls in a LINE-UP, as an LDraw file any viewer draws: the
 * close-up that says whether each doll is whole, which a whole-model render
 * of a 2,000-part set cannot.
 *
 * Row 1 (back) is every doll group as the SOURCE places it (turned to face the
 * camera, its parts kept exactly where the source put them relative to its
 * torso); row 2 (front) is the same doll as the Bedrock rig ASSEMBLES it
 * (`assembleMinifig`: canonical joints, synthesised parts, bound hair and held
 * items) - what the pack ships. A head's `HEAD_PRINT` line is kept, so the
 * viewer's face-art path can draw it. Loose doll heads (spare heads, a doll
 * whose body the source lost) stand at the end of row 1.
 *
 * Usage: bun scripts/_doll_lineup.ts <source.ldr|.mpd|.io> <out.ldr> [--all-figures]
 *   --all-figures: minifigs too (default mini-dolls only).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { embeddedPartTexts, parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.ts';
import { assembleMinifig, classifyMiniDollPart, figureAnchor } from '../web/src/engine/minifig-rig.ts';

const CLEGO = 'C:/git/clego';
setLDrawRoot(`${CLEGO}/extracted/studio_release/app/ldraw`);
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync(`${CLEGO}/ldraw_ref`)) process.env.CRAFTMATIC_LDRAW_REF = `${CLEGO}/ldraw_ref`;

const [file, out] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const ALL = process.argv.includes('--all-figures');
if (!file || !out) { console.error('usage: bun scripts/_doll_lineup.ts <source> <out.ldr> [--all-figures]'); process.exit(2); }

/** Spacing between dolls in a row, and between the two rows (LDU). */
const PITCH = 60, ROW_GAP = 120;
type M3 = number[];
const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mul = (a: M3, b: M3): M3 => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!));
const tr = (a: M3): M3 => [a[0]!, a[3]!, a[6]!, a[1]!, a[4]!, a[7]!, a[2]!, a[5]!, a[8]!];
const app = (m: M3, v: number[]): number[] => [0, 1, 2].map(r => m[r * 3]! * v[0]! + m[r * 3 + 1]! * v[1]! + m[r * 3 + 2]! * v[2]!);
const f = (n: number): string => (Math.abs(n) < 5e-5 ? '0' : String(Math.round(n * 1e4) / 1e4));
/**
 * Every placement turned 90 degrees about Y: the row runs along Z and the dolls
 * face -X, which is where the viewer's ront camera looks from for a model
 * longest along Z (its model-aware front), so the capture is of their faces.
 */
const TURN: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const line = (b: ParsedBrick, pos: number[], rot: M3): string[] => [
  ...(b.headPrint ? [`0 !CRAFTMATIC HEAD_PRINT ${b.headPrint}`] : []),
  `1 ${b.color} ${app(TURN, pos).map(f).join(' ')} ${mul(TURN, rot).map(f).join(' ')} ${b.part}`,
];

const bytes = readFileSync(file);
let text: string, custom = new Map<string, string>();
if (/\.io$/i.test(file)) {
  const io = await extractIoModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  text = io.text; custom = io.customParts;
} else text = bytes.toString('utf8');
const doc = parseLDrawDocument(synthesizeLSynth(text).text);
seedDatTexts([...embeddedPartTexts(doc), ...custom]);
const scene = await discoverSceneActors(doc.bricks, createPartGeometryProvider());
const desc = (b: ParsedBrick): string => scene.meshes.get(b.part)?.description ?? '';

const lines: string[] = [`0 Doll line-up of ${file.replace(/\\/g, '/')}`, '0 Name: doll-lineup.ldr', '0 // row 1 (back, z=+ROW_GAP): source groups; row 2 (front): as the rig assembles them'];
let k = 0;
const groups = [...scene.figures, ...scene.posedFigures].map(g => g.bricks);
for (const bricks of groups) {
  const root = figureAnchor(bricks, scene.meshes);
  if (!root || (!ALL && root.system !== 'minidoll')) continue;
  const anchor = bricks[root.index]!;
  // Source row: undo the anchor's yaw and translation, so the doll faces −Z.
  const R = anchor.rot ?? I3;
  const Rt = tr(R);
  const x = k * PITCH;
  for (const b of bricks) {
    const rel = app(Rt, [b.x - anchor.x, b.y - anchor.y, b.z - anchor.z]);
    lines.push(...line(b, [rel[0]! + x, rel[1]!, rel[2]! + ROW_GAP], mul(Rt, b.rot ?? I3)));
  }
  // Rig row: the assembled figure is already in its own (torso) frame.
  try {
    const a = assembleMinifig(bricks, scene.meshes);
    for (const b of a.bricks) lines.push(...line(b, [b.x + x, b.y, b.z], b.rot ?? I3));
    lines.push(`0 // doll ${k + 1}: synthesized=[${a.synthesized.join(',')}] bystanders=[${a.bystanders.join(',')}]`);
  } catch (e) {
    lines.push(`0 // doll ${k + 1}: assembly failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  k++;
}
// Loose doll heads: at the end of the source row, at the height a head sits.
const inGroup = new Set(groups.flat());
for (const b of doc.bricks) {
  if (inGroup.has(b) || classifyMiniDollPart(b.part, desc(b)) !== 'doll_head') continue;
  lines.push(...line(b, [k * PITCH, -33.2, ROW_GAP], I3));
  k++;
}
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`${out}: ${k} dolls/heads`);
