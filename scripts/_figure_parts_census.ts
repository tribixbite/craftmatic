/**
 * Where every part of every NPC figure goes: its rig slot, and which body
 * slots the figure lacks (the rig then supplies a default, or nothing). Also
 * lists the figure-vocabulary parts left OUT of every figure (they stay in the
 * building shell where the source put them: a leg or hair that floats there
 * once its figure walks away).
 *
 * Usage: bun scripts/_figure_parts_census.ts <source.ldr|.mpd|.io>... [--support]
 *   --support  also says which of the loose parts nothing carries (no part's box within
 *              SUPPORT_LDU under its bottom, overlapping it in plan): the ones in the air.
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { embeddedPartTexts, parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.ts';
import { assembleMinifig, classifyFigurePart, figureAnchor } from '../web/src/engine/minifig-rig.ts';
import { isFigurePart } from '../web/src/engine/ldraw-entity-compiler.ts';

const CLEGO = 'C:/git/clego';
setLDrawRoot(`${CLEGO}/extracted/studio_release/app/ldraw`);
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync(`${CLEGO}/ldraw_ref`)) process.env.CRAFTMATIC_LDRAW_REF = `${CLEGO}/ldraw_ref`;

const SUPPORT = process.argv.includes('--support');
/** How far (LDU) under a part's bottom another part's box may end and still carry it. */
const SUPPORT_LDU = 4;

for (const file of process.argv.slice(2).filter(a => !a.startsWith('--'))) {
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
  console.log(`${basename(file)}: ${scene.figures.length} NPC figures`);
  scene.figures.forEach((f, k) => {
    const root = figureAnchor(f.bricks, scene.meshes);
    const a = assembleMinifig(f.bricks, scene.meshes);
    const parts = f.bricks.map(b => `${b.part.replace(/\.dat$/i, '')}:${root ? classifyFigurePart(root.system, b.part, desc(b)) : '?'}`);
    console.log(`  fig${k + 1} ${root?.system} synthesized=[${a.synthesized?.join(',') ?? ''}] ${parts.join(' ')}`);
  });
  const inFigure = new Set(scene.figures.flatMap(f => f.bricks));
  const loose = bricks.filter(b => !inFigure.has(b) && isFigurePart(b.part, desc(b)));
  const byDesc = new Map<string, number>();
  for (const b of loose) byDesc.set(`${b.part.replace(/\.dat$/i, '')} ${desc(b).slice(0, 40)}`, (byDesc.get(`${b.part.replace(/\.dat$/i, '')} ${desc(b).slice(0, 40)}`) ?? 0) + 1);
  console.log(`  figure parts outside every NPC: ${loose.length}`);
  for (const [k, n] of [...byDesc].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`     ${n} x ${k}`);
  if (SUPPORT) {
    // Is each loose part carried? Its world box against every other part's: a part whose box
    // touches its bottom (within SUPPORT_LDU, overlapping in plan) or holds it (its box inside
    // another's, a goblet in a cupboard's hollow) is supported; anything else is in the air.
    const boxOf = (b: ParsedBrick): { min: number[]; max: number[] } | null => {
      const m = scene.meshes.get(b.part);
      if (!m) return null;
      const r = b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const cx of [m.bounds.min[0], m.bounds.max[0]]) for (const cy of [m.bounds.min[1], m.bounds.max[1]]) for (const cz of [m.bounds.min[2], m.bounds.max[2]]) {
        const w = [b.x + r[0]! * cx + r[1]! * cy + r[2]! * cz, b.y + r[3]! * cx + r[4]! * cy + r[5]! * cz, b.z + r[6]! * cx + r[7]! * cy + r[8]! * cz];
        for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i]!, w[i]!); max[i] = Math.max(max[i]!, w[i]!); }
      }
      return { min, max };
    };
    const others = bricks.filter(b => !loose.includes(b)).map(b => ({ b, box: boxOf(b) })).filter(o => o.box) as Array<{ b: ParsedBrick; box: { min: number[]; max: number[] } }>;
    const floating: string[] = [];
    let sideHeld = 0;
    for (const b of loose) {
      const box = boxOf(b);
      if (!box) continue;
      // LDraw y is DOWN: the part's bottom is box.max[1].
      const carried = others.some(({ box: o }) => {
        const plan = o.min[0]! < box.max[0]! - 1 && o.max[0]! > box.min[0]! + 1 && o.min[2]! < box.max[2]! - 1 && o.max[2]! > box.min[2]! + 1;
        return plan && o.min[1]! <= box.max[1]! + SUPPORT_LDU && o.max[1]! >= box.max[1]! - SUPPORT_LDU - 1;
      });
      // Held from the side (a bar in a clip, a key on a hook): any other box touching it within 1 LDU.
      const touched = carried || others.some(({ box: o }) => [0, 1, 2].every(i => o.min[i]! <= box.max[i]! + 1 && o.max[i]! >= box.min[i]! - 1));
      if (!touched) floating.push(`${b.part.replace(/\.dat$/i, '')} ${desc(b).slice(0, 30)} @ ${b.x.toFixed(0)},${b.y.toFixed(0)},${b.z.toFixed(0)}`);
      else if (!carried) sideHeld++;
    }
    console.log(`  of those, held only from the side (touching another part): ${sideHeld}; touching nothing at all (in the air): ${floating.length}`);
    for (const f of floating) console.log(`     ${f}`);
  }
}
