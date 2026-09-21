/**
 * Walk-through size measurement for a LEGO source (engine/bedrock-scene-actors.ts,
 * `measureSceneAccess` + `recommendAccessScale`): loads a model the way the LEGO tab
 * does, measures its doorways and interior headroom against the player's 1×2-block
 * passage, and prints the recommended size step with its reason.
 *
 * Usage: bun scripts/_access_scale.ts <model.io|.mpd|.ldr> [--cell=<xz>x<y>] [--openings=N] [--json]
 *   --openings=N  list the N easiest openings (default 8)
 *   --json        print the whole measurement as JSON (openings included)
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { embeddedPartTexts, parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { discoverSceneActors, measureSceneAccess, recommendAccessScale } from '../web/src/engine/bedrock-scene-actors.ts';
import { planAddonScale } from '../web/src/engine/addon-scale.ts';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = positional[0];
if (!file) { console.error('usage: bun scripts/_access_scale.ts <model> [--cell=8] [--openings=N] [--json]'); process.exit(2); }

let text: string;
let customParts = new Map<string, string>();
if (/\.io$/i.test(file)) {
  const b = readFileSync(file);
  const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  text = io.text;
  customParts = io.customParts;
} else {
  text = readFileSync(file, 'utf8');
}
const doc = parseLDrawDocument(synthesizeLSynth(text).text);
seedDatTexts([...embeddedPartTexts(doc), ...customParts]);
const bricks: ParsedBrick[] = doc.bricks;

const t0 = Date.now();
const scene = await discoverSceneActors(bricks);
const t1 = Date.now();
const measurement = measureSceneAccess(bricks, scene.meshes, { exclude: scene.figureBricks, ...(flag('cell') ? { cell: { xz: Number(flag('cell').split('x')[0]), y: Number(flag('cell').split('x')[1] ?? flag('cell')) } } : {}) });
const t2 = Date.now();
const recommendation = recommendAccessScale(measurement);
const auto = planAddonScale(bricks, 'auto', basename(file).replace(/\.[^.]+$/, ''));

const blocks = (ldu: number): number => Math.round(ldu / LDU_PER_BLOCK * 100) / 100;
const listed = Number(flag('openings') ?? 8);
const summary = {
  file, bricks: bricks.length, figures: scene.figures.length, doorLeaves: scene.doors.length,
  auto: { scale: auto.scale, cue: auto.cue },
  cell: measurement.cell, grid: measurement.grid,
  openings: measurement.openings.length,
  leafOpenings: measurement.openings.filter(o => o.source === 'door-leaf').length,
  headroomBlocks: measurement.headroomLdu === null ? null : blocks(measurement.headroomLdu),
  /** Openings that clear the passage at each step (cumulative), and those none reaches. */
  passableByStep: Object.fromEntries([...[1, 1.5, 2, 3, 4].map(s => [`${s}x`, measurement.openings.filter(o => o.requiredScale <= s + 1e-9).length]), ['never', measurement.openings.filter(o => o.requiredScale > 4 + 1e-9).length]]),
  interiorFloorCells: measurement.interiorFloorCells,
  topFloorBlocks: measurement.topFloorLdu === null ? null : blocks(measurement.topFloorLdu),
  reach: measurement.reach.map(r => `${r.scale}x: ${r.reachedSurfaces} surfaces, highest ${blocks(r.highestReachedLdu)} blocks (at 100 %)`),
  groundLdu: scene.groundLdu,
  recommendation,
  easiest: measurement.openings.slice(0, listed).map(o => `${o.source} ${o.axis} ${blocks(o.widthLdu)}x${blocks(o.heightLdu)} blocks, needs ${Math.round(o.requiredScale * 100) / 100}x, at ${o.centreLdu.map(v => Math.round(v)).join(',')}`),
  ms: { meshes: t1 - t0, measure: t2 - t1 },
};
if (process.argv.includes('--json')) console.log(JSON.stringify({ ...summary, measurement }, null, 1));
else console.log(JSON.stringify(summary, null, 1));
