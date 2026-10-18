/**
 * Probe a vehicle source with the entity compiler's OWN preparation
 * (prepareEntityPlacements): level, clusters, extras, stand rule, then the
 * facing votes and the cockpit it would choose. Usage:
 *   bun scripts/_vehicle_probe.ts <model> [--label=…] [--mode=…]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { embeddedPartTexts, parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { discoverPlayableComponents, type VehicleMode } from '../web/src/engine/playable-components.ts';
import { prepareEntityPlacements, findCockpit, LDU_PER_BLOCK } from '../web/src/engine/ldraw-entity-compiler.ts';
import { inferVehicleNose } from '../web/src/engine/vehicle-facing.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const file = process.argv[2]!;
const flag = (n: string): string | undefined => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const label = flag('label') ?? basename(file).replace(/\.[^.]+$/, '');
let text: string; let customParts = new Map<string, string>();
if (/\.io$/i.test(file)) { const b = readFileSync(file); const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); text = io.text; customParts = io.customParts; }
else text = readFileSync(file, 'utf8');
const doc = parseLDrawDocument(synthesizeLSynth(text).text);
seedDatTexts([...embeddedPartTexts(doc), ...customParts]);
const disc = discoverPlayableComponents(doc.bricks, label, (flag('mode') as VehicleMode | undefined) ?? 'auto');
console.log('components', disc.components.map(c => ({ id: c.id, kind: c.kind, n: c.bricks.length, prov: c.provenance })), disc.warnings);
const comp = disc.components[0];
if (!comp) process.exit(0);
const prep = await prepareEntityPlacements(comp.kind, comp.bricks, createPartGeometryProvider());
const { placed, meshes } = prep;
const xs = placed.map(b => b.x), ys = placed.map(b => b.y), zs = placed.map(b => b.z);
const spanX = Math.max(...xs) - Math.min(...xs), spanZ = Math.max(...zs) - Math.min(...zs), spanY = Math.max(...ys) - Math.min(...ys);
console.log('level', Math.round(prep.level.angleDeg * 10) / 10, 'primary placements', placed.length, 'internals skipped', prep.skippedInternalCount);
console.log('span LDU x', Math.round(spanX), 'y', Math.round(spanY), 'z', Math.round(spanZ), '-> blocks', (spanX / LDU_PER_BLOCK).toFixed(1), 'x', (spanY / LDU_PER_BLOCK).toFixed(1), 'x', (spanZ / LDU_PER_BLOCK).toFixed(1));
console.log('displayDropped', prep.displayDropped, 'detached', prep.detached);
for (const e of prep.extras) console.log('  extra', e.role.padEnd(8), String(e.sourceIndices.length).padStart(4), 'parts', e.reason, '| centre', e.centreLdu.map(v => Math.round(v)).join(','), 'floor', Math.round(e.floorLdu), e.facingLdu ? `facing ${e.facingLdu.map(v => v.toFixed(2)).join(',')}` : '');
const isWheel = (b: { part: string }): boolean => /wheel|tire|^(56908|44771|44772|87697|92912|15413|41897|23798|23799)/.test(b.part.replace(/^.*[/\\]/, '').replace(/\.dat$/i, '').toLowerCase()) || /^[~=_]*\s*(Wheel|Tyre|Tire)\b/i.test(meshes.get(b.part)?.description ?? '');
const facing = inferVehicleNose(placed, comp.kind, { meshes, isWheel });
console.log('facing', facing.nose, facing.source, 'agreement', facing.agreement);
for (const v of facing.votes) console.log('  vote', v.signal.padEnd(18), 'x', v.x.toFixed(2), 'z', v.z.toFixed(2), 'w', v.weight.toFixed(2), v.detail ?? '');
const cockpit = findCockpit(placed, meshes, { nose: facing.nose, isXLongitudinal: facing.axis === 'x', forwardSign: facing.sign, spanX, spanZ });
console.log('cockpit', cockpit.source, '|', cockpit.detail, '| eye LDU', cockpit.eyeLdu.map(v => Math.round(v)).join(','), '| driver parts removed', cockpit.driverParts.length);
if (flag('extremes')) {
  const sorted = [...placed].sort((a, b) => a.x - b.x);
  const show = (b: typeof placed[number]): string => `${b.part.replace(/^.*[/\\]/, '')} c${b.color} @ ${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.z)}`;
  console.log('min x:', sorted.slice(0, 6).map(show).join(' | '));
  console.log('max x:', sorted.slice(-6).map(show).join(' | '));
  const sz = [...placed].sort((a, b) => a.z - b.z);
  console.log('min z:', sz.slice(0, 6).map(show).join(' | '));
  console.log('max z:', sz.slice(-6).map(show).join(' | '));
  const hist = new Map<number, number>();
  for (const b of placed) hist.set(Math.floor(b.x / 100) * 100, (hist.get(Math.floor(b.x / 100) * 100) ?? 0) + 1);
  console.log('x histogram (100 LDU bins):', [...hist].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' '));
  const hz = new Map<number, number>();
  for (const b of placed) hz.set(Math.floor(b.z / 100) * 100, (hz.get(Math.floor(b.z / 100) * 100) ?? 0) + 1);
  console.log('z histogram (100 LDU bins):', [...hz].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' '));
}
if (flag('glass')) {
  const { isRoundGlowPart, isGlassPart } = await import('../web/src/engine/vehicle-facing.ts');
  const isT = (c: number): boolean => (c >= 33 && c <= 47) || c === 52 || c === 54 || c === 111 || c === 32 || c === 57;
  for (const b of placed) if (isT(b.color)) console.log('  trans', b.part.replace(/^.*[/\\]/, '').padEnd(12), 'c', b.color, 'desc', JSON.stringify(meshes.get(b.part)?.description ?? null), 'glow', isRoundGlowPart(b.part, meshes.get(b.part)?.description), 'glass', isGlassPart(b.part, meshes.get(b.part)), '@', Math.round(b.x), Math.round(b.z));
}
