/**
 * Bedrock entity diagnostic: submodel groups, discovered components and the
 * compiled seat/collision/bounds for a model. Usage:
 *   bun scripts/_entity_seat_probe.ts <model> "<label>" [auto|car|plane|boat]
 */
import { readFileSync } from 'node:fs';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { embeddedPartTexts, parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { discoverPlayableComponents } from '../web/src/engine/playable-components.ts';
import { compileLdrawEntityGeometry } from '../web/src/engine/ldraw-entity-compiler.ts';
setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const [file, label, mode] = process.argv.slice(2);
let text: string; let custom = new Map<string, string>();
if (/\.io$/i.test(file!)) { const b = readFileSync(file!); const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); text = io.text; custom = io.customParts; }
else text = readFileSync(file!, 'utf8');
const doc = parseLDrawDocument(synthesizeLSynth(text).text);
seedDatTexts([...embeddedPartTexts(doc), ...custom]);
const groups = new Map<string, number>();
for (const b of doc.bricks) { const k = (b.sourcePath ?? []).join('/') || '(root)'; groups.set(k, (groups.get(k) ?? 0) + 1); }
console.log('submodel groups:', [...groups].sort((a, b) => b[1] - a[1]).slice(0, 25));
const { components, warnings } = discoverPlayableComponents(doc.bricks, label!, (mode as any) ?? 'auto');
console.log('components', components.map(c => ({ id: c.id, kind: c.kind, n: c.bricks.length, prov: c.provenance, seatAnchor: c.seatAnchor, bounds: c.bounds })), warnings);
for (const c of components) {
  const g = await compileLdrawEntityGeometry(c.id, c.kind, c.bricks, { facing: c.forwardDirection ?? 'auto', userSeatAnchor: c.seatAnchor, quality: 'balanced' });
  const geo = (g.value as any)['minecraft:geometry'];
  const d = geo[0].description;
  console.log(c.id, 'seat', g.seatPosition, 'collision', g.collisionBox, 'bounds w/h', d.visible_bounds_width, d.visible_bounds_height, 'transform', g.transform, 'cubes', g.diagnostics.cubeCount, 'cell', g.diagnostics.quality.microcellLdu);
}
