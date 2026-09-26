/**
 * Where every part of every NPC figure goes: its rig slot, and which body
 * slots the figure lacks (the rig then supplies a default, or nothing). Also
 * lists the figure-vocabulary parts left OUT of every figure (they stay in the
 * building shell where the source put them: a leg or hair that floats there
 * once its figure walks away).
 *
 * With `--dolls` it is the MINI-DOLL census (docs/bedrock-addon-guide.md,
 * "Mini-doll faces and bodies"): per doll, its head part and print id, which
 * face source the pack will draw (`faceSourceOf`: the LDraw print, seeded face
 * art, or the default doll face), and every body slot - present from the
 * source, synthesised by the rig, or missing - plus the doll parts left loose
 * in the shell. Figures posed past upright stay in the geometry and are
 * counted separately. Totals are given per placement AND per DISTINCT figure
 * (the same doll in several sets, or twice in one, counts once), because a
 * count of placements alone cannot tell one fault repeated from many.
 *
 * Usage: bun scripts/_figure_parts_census.ts <source.ldr|.mpd|.io>...
 *          [--dolls] [--faces=<dir>] [--json=<out.json>]
 *   --faces: the face-art directory a build seeds (`_playable_ref.ts --faces=`);
 *            a head whose print id has art there counts as `art`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { embeddedPartTexts, parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.ts';
import { assembleMinifig, classifyFigurePart, classifyMiniDollPart, figureAnchor, type AssembledMinifig } from '../web/src/engine/minifig-rig.ts';
import { isFigurePart } from '../web/src/engine/ldraw-entity-compiler.ts';
import { faceKey, rasterizeHeadFace } from '../web/src/engine/head-face.ts';

const CLEGO = 'C:/git/clego';
setLDrawRoot(`${CLEGO}/extracted/studio_release/app/ldraw`);
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync(`${CLEGO}/ldraw_ref`)) process.env.CRAFTMATIC_LDRAW_REF = `${CLEGO}/ldraw_ref`;

const argv = process.argv.slice(2);
const DOLLS = argv.includes('--dolls');
const opt = (name: string): string | undefined => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const FACES = opt('faces');
const JSON_OUT = opt('json');
const files = argv.filter(a => !a.startsWith('--'));

/** Which face a head gets in a pack: its LDraw print, seeded art for its print id, or the default face. */
type FaceSource = 'ldraw-print' | 'art' | 'default:no-print-id' | 'default:no-art' | 'default:synth-head' | 'no-head';
/** A body slot's state after assembly. */
type SlotState = 'source' | 'synthesized' | 'missing' | 'n/a';

interface DollRow {
  set: string;
  figure: number;
  posed: boolean;
  head: { part: string; color: number; print: string | null; face: FaceSource } | null;
  torso: { part: string; color: number; synthesized: boolean } | null;
  slots: Record<'hair' | 'head' | 'torso' | 'arm_right' | 'arm_left' | 'hips' | 'legs', SlotState>;
  held: string[];
  /** Parts kept on the body bone with no slot (foreign to the rig). */
  bystanders: string[];
  synthesized: string[];
  key: string;
}

const stem = (p: string): string => p.replace(/\\/g, '/').replace(/^.*\//, '').replace(/\.dat$/i, '').toLowerCase();

function faceSourceOf(head: ParsedBrick | undefined, mesh: LdrawPartMesh | null | undefined): FaceSource {
  if (!head) return 'no-head';
  if (mesh && rasterizeHeadFace(mesh)) return 'ldraw-print';
  if (!head.headPrint) return 'default:no-print-id';
  return FACES && existsSync(join(FACES, `${faceKey(head.headPrint)}.png`)) ? 'art' : 'default:no-art';
}

function dollRow(set: string, figure: number, bricks: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>, posed: boolean): DollRow | null {
  const root = figureAnchor(bricks, meshes);
  if (!root || root.system !== 'minidoll') return null;
  const desc = (b: ParsedBrick): string => meshes.get(b.part)?.description ?? '';
  let a: AssembledMinifig | null = null;
  try { a = assembleMinifig(bricks, meshes); } catch { a = null; }
  const headSrc = bricks.find(b => classifyMiniDollPart(b.part, desc(b)) === 'doll_head');
  const torsoSrc = root.headless ? undefined : bricks[root.index];
  const hairSrc = bricks.find(b => classifyMiniDollPart(b.part, desc(b)) === 'doll_hair');
  const synth = new Set(a?.synthesized ?? []);
  const has = (slot: string): boolean => a ? a.slots.some(s => s === slot) : false;
  const state = (present: boolean, synthesized: boolean): SlotState => (synthesized ? 'synthesized' : present ? 'source' : 'missing');
  const legsPresent = has('legs') || has('hips_legs') || has('leg_right') || has('leg_left');
  const slots: DollRow['slots'] = {
    hair: hairSrc || (a?.slots.includes('headwear') ?? false) ? 'source' : 'missing',
    head: state(has('head'), synth.has('head')),
    torso: state(has('torso'), synth.has('torso')),
    arm_right: state(has('arm_right'), synth.has('right arm')),
    arm_left: state(has('arm_left'), synth.has('left arm')),
    hips: has('hips_legs') && !has('hips') ? 'n/a' : state(has('hips'), synth.has('hips')),
    legs: state(legsPresent, synth.has('legs')),
  };
  const held = a ? a.bricks.filter((_, i) => a!.slots[i] === 'held' && a!.rig.boneOf[i] !== 'body').map(b => stem(b.part)) : [];
  const head = headSrc ? { part: stem(headSrc.part), color: headSrc.color, print: headSrc.headPrint ?? null, face: faceSourceOf(headSrc, meshes.get(headSrc.part)) }
    // A head the rig supplied wears the default doll face.
    : synth.has('head') ? { part: 'synth', color: -1, print: null, face: 'default:synth-head' as FaceSource } : null;
  const torso = torsoSrc ? { part: stem(torsoSrc.part), color: torsoSrc.color, synthesized: false } : a ? { part: 'synth', color: -1, synthesized: true } : null;
  const key = `${head ? `${head.part}/${head.print ?? '-'}/${head.color}` : 'nohead'}|${torso ? `${torso.part}/${torso.color}` : '-'}|${hairSrc ? `${stem(hairSrc.part)}/${hairSrc.color}` : '-'}`;
  return { set, figure, posed, head, torso, slots, held, bystanders: a?.bystanders.map(stem) ?? [], synthesized: [...synth], key };
}

const rows: DollRow[] = [];
const looseAll: Array<{ set: string; part: string; slot: string; desc: string }> = [];

for (const file of files) {
  const bytes = readFileSync(file);
  let text: string, custom = new Map<string, string>();
  if (/\.io$/i.test(file)) {
    const io = await extractIoModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    text = io.text; custom = io.customParts;
  } else text = bytes.toString('utf8');
  const doc = parseLDrawDocument(synthesizeLSynth(text).text);
  seedDatTexts([...embeddedPartTexts(doc), ...custom]);
  const bricks: ParsedBrick[] = doc.bricks;
  const scene = await discoverSceneActors(bricks, createPartGeometryProvider());
  const desc = (b: ParsedBrick): string => scene.meshes.get(b.part)?.description ?? '';
  const set = basename(file).replace(/\.(ldr|mpd|io)$/i, '');
  console.log(`${basename(file)}: ${scene.figures.length} NPC figures, ${scene.posedFigures.length} posed`);
  if (!DOLLS) {
    scene.figures.forEach((f, k) => {
      const root = figureAnchor(f.bricks, scene.meshes);
      const a = assembleMinifig(f.bricks, scene.meshes);
      const parts = f.bricks.map(b => `${b.part.replace(/\.dat$/i, '')}:${root ? classifyFigurePart(root.system, b.part, desc(b)) : '?'}`);
      console.log(`  fig${k + 1} ${root?.system} synthesized=[${a.synthesized?.join(',') ?? ''}] ${parts.join(' ')}`);
    });
  } else {
    const all = [...scene.figures.map(f => ({ bricks: f.bricks, posed: false })), ...scene.posedFigures.map(f => ({ bricks: f.bricks, posed: true }))];
    all.forEach((f, k) => {
      const r = dollRow(set, k + 1, f.bricks, scene.meshes, f.posed);
      if (!r) return;
      rows.push(r);
      const s = r.slots;
      console.log(`  doll${r.figure}${r.posed ? ' (posed, stays geometry)' : ''} head=${r.head ? `${r.head.part}${r.head.print ? `[${r.head.print}]` : ''} face=${r.head.face}` : 'NONE'} torso=${r.torso?.part ?? '-'} hair=${s.hair} armR=${s.arm_right} armL=${s.arm_left} hips=${s.hips} legs=${s.legs}${r.held.length ? ` held=${r.held.join(',')}` : ''}${r.bystanders.length ? ` bystanders=${r.bystanders.join(',')}` : ''}`);
    });
  }
  const inFigure = new Set([...scene.figures, ...(DOLLS ? scene.posedFigures : [])].flatMap(f => f.bricks));
  const loose = bricks.filter(b => !inFigure.has(b) && (DOLLS ? classifyMiniDollPart(b.part, desc(b)) !== null : isFigurePart(b.part, desc(b))));
  for (const b of loose) looseAll.push({ set, part: stem(b.part), slot: classifyMiniDollPart(b.part, desc(b)) ?? '-', desc: desc(b).slice(0, 50) });
  if (DOLLS) {
    // Where each loose doll part is: the nearest figure anchor (torso, or the
    // head standing in for one), in that anchor's frame - the grouping reach
    // it missed, or a part with no body at all (a spare head on a shelf).
    const anchors = [...scene.figures, ...scene.posedFigures].map(f => { const r = figureAnchor(f.bricks, scene.meshes); return r ? f.bricks[r.index]! : null; }).filter((b): b is ParsedBrick => b !== null);
    for (const b of loose) {
      let best: { d: number; rel: number[] } | null = null;
      for (const t of anchors) {
        const R = t.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const v = [b.x - t.x, b.y - t.y, b.z - t.z];
        const rel = [0, 1, 2].map(c => R[c]! * v[0]! + R[3 + c]! * v[1]! + R[6 + c]! * v[2]!);
        const d = Math.hypot(v[0]!, v[1]!, v[2]!);
        if (!best || d < best.d) best = { d, rel };
      }
      console.log(`     loose ${stem(b.part)}${b.headPrint ? `[${b.headPrint}]` : ''} at (${[b.x, b.y, b.z].map(n => n.toFixed(0)).join(',')}) nearest anchor ${best ? `${best.d.toFixed(0)} LDU, local (${best.rel.map(n => n.toFixed(0)).join(',')})` : '-'}`);
    }
  }
  const byDesc = new Map<string, number>();
  for (const b of loose) { const k = `${stem(b.part)} ${desc(b).slice(0, 40)}`; byDesc.set(k, (byDesc.get(k) ?? 0) + 1); }
  console.log(`  ${DOLLS ? 'doll' : 'figure'} parts outside every figure: ${loose.length}`);
  for (const [k, n] of [...byDesc].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`     ${n} x ${k}`);
}

if (DOLLS) {
  // Totals per placement and per DISTINCT doll (head+print+colour, torso+colour, hair+colour).
  const distinct = new Map<string, DollRow>();
  for (const r of rows) if (!distinct.has(r.key)) distinct.set(r.key, r);
  const tally = (list: DollRow[]): Record<string, Record<string, number>> => {
    const t: Record<string, Record<string, number>> = { face: {} };
    for (const r of list) {
      const f = r.head?.face ?? 'no-head';
      t.face![f] = (t.face![f] ?? 0) + 1;
      for (const [slot, st] of Object.entries(r.slots)) { t[slot] ??= {}; t[slot]![st] = (t[slot]![st] ?? 0) + 1; }
    }
    return t;
  };
  const summary = {
    placements: rows.length, distinct: distinct.size, posed: rows.filter(r => r.posed).length,
    perPlacement: tally(rows), perDistinct: tally([...distinct.values()]),
    loose: looseAll.length, looseBySlot: looseAll.reduce<Record<string, number>>((m, l) => { m[l.slot] = (m[l.slot] ?? 0) + 1; return m; }, {}),
  };
  console.log(`\nDOLLS: ${summary.placements} placements, ${summary.distinct} distinct, ${summary.posed} posed`);
  for (const [label, t] of [['per placement', summary.perPlacement], ['per distinct doll', summary.perDistinct]] as const) {
    console.log(`  ${label}:`);
    for (const [k, v] of Object.entries(t)) console.log(`    ${k.padEnd(10)} ${Object.entries(v).map(([s, n]) => `${s}=${n}`).join(' ')}`);
  }
  console.log(`  loose doll parts: ${summary.loose} ${JSON.stringify(summary.looseBySlot)}`);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ summary, rows, loose: looseAll }, null, 1));
}
