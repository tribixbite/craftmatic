/**
 * Where every part of every NPC figure goes: its rig slot, and which body
 * slots the figure lacks (the rig then supplies a default, or nothing). Also
 * lists the figure-vocabulary parts left OUT of every figure (they stay in the
 * building shell where the source put them: a leg or hair that floats there
 * once its figure walks away).
 *
 * Usage: bun scripts/_figure_parts_census.ts <source.ldr|.mpd|.io>...
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

for (const file of process.argv.slice(2)) {
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
}
