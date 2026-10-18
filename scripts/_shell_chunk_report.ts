/**
 * What a built pack's STATIC SHELL costs, per actor: cuboids, meshes, bones
 * (and how many of them carry no cube), geo.json bytes, the longest numeric
 * literal, the chunk roots and radii the diagnostics record, and how many
 * shell actors the placement spawns. Compares two builds side by side when
 * given two packs (before / after a change).
 *
 * Usage: bun scripts/_shell_chunk_report.ts <pack.mcaddon> [other.mcaddon]
 *
 * Reads the pack as shipped (zip entries), so the numbers are what the device
 * loads, not what the exporter meant to write.
 */
import { readFileSync } from 'node:fs';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.ts';
import { isShellEntityId } from '../web/src/engine/bedrock-building-shell.ts';

interface GeoCube { origin?: number[]; size?: number[] }
interface GeoBone { name: string; parent?: string; cubes?: GeoCube[] }
interface GeoDoc { 'minecraft:geometry'?: Array<{ bones?: GeoBone[] }> }

interface ShellActorReport {
  id: string;
  bytes: number;
  cubes: number;
  meshes: number;
  bones: number;
  emptyBones: number;
  /** Characters of the longest number literal in the geometry text (a rounding leak reads ~18). */
  longestLiteral: number;
}

interface PackReport {
  file: string;
  shellActors: ShellActorReport[];
  /** Shell actors the placement CONFIG spawns, by type id. */
  placed: string[];
  spatialShell?: unknown;
  packCuboids?: number;
  packEntities?: number;
  shellGeoBytes: number;
}

const toArrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/**
 * A shell actor by either id scheme: the lattice ids the engine writes now
 * (`isShellEntityId`) or the list-position `…_shell_chunk_<n>` ids of the
 * unshipped first split, so a before/after comparison reads both builds.
 */
const isShellActor = (id: string): boolean => isShellEntityId(id) || /_shell_chunk_\d+$/.test(id.replace(/^[^:]*:/, ''));

async function report(file: string): Promise<PackReport> {
  const buffer = toArrayBuffer(readFileSync(file));
  const entries = listZipEntries(buffer);
  const text = async (name: string): Promise<string> => new TextDecoder().decode(await extractFile(buffer, name));
  const shellActors: ShellActorReport[] = [];
  for (const name of entries) {
    const m = /\/models\/entity\/([^/]+)\.geo\.json$/.exec(name);
    if (!m || !isShellActor(m[1]!) || /_lod$/.test(m[1]!)) continue;
    const raw = await text(name);
    const doc = JSON.parse(raw) as GeoDoc;
    let cubes = 0, bones = 0, emptyBones = 0;
    for (const g of doc['minecraft:geometry'] ?? []) for (const bone of g.bones ?? []) {
      bones++;
      const n = bone.cubes?.length ?? 0;
      cubes += n;
      if (!n) emptyBones++;
    }
    let longestLiteral = 0;
    for (const lit of raw.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []) longestLiteral = Math.max(longestLiteral, lit.length);
    shellActors.push({ id: m[1]!, bytes: raw.length, cubes, meshes: (doc['minecraft:geometry'] ?? []).length, bones, emptyBones, longestLiteral });
  }
  shellActors.sort((a, b) => a.id.localeCompare(b.id));
  const placement = entries.find(n => /_BP\/scripts\/placement\.js$/.test(n));
  const placed: string[] = [];
  if (placement) {
    const script = await text(placement);
    const config = /const CONFIG = (\{.*?\});\n/s.exec(script);
    if (config) {
      const parsed = JSON.parse(config[1]!) as { actors?: Array<{ typeId: string }>; shellMigrations?: unknown };
      for (const a of parsed.actors ?? []) if (isShellActor(a.typeId)) placed.push(a.typeId);
    }
  }
  const diagName = entries.find(n => /_BP\/craftmatic-diagnostics\.json$/.test(n));
  let spatialShell: unknown, packCuboids: number | undefined, packEntities: number | undefined;
  if (diagName) {
    const diag = JSON.parse(await text(diagName)) as { pack?: { cuboids?: number; entities?: number }; spatialShell?: unknown };
    spatialShell = diag.spatialShell; packCuboids = diag.pack?.cuboids; packEntities = diag.pack?.entities;
  }
  return { file, shellActors, placed, spatialShell, packCuboids, packEntities, shellGeoBytes: shellActors.reduce((n, a) => n + a.bytes, 0) };
}

function print(r: PackReport): void {
  console.log(`\n== ${r.file}`);
  console.log(`pack cuboids ${r.packCuboids ?? '?'}, pack entities ${r.packEntities ?? '?'}, shell geo.json bytes ${r.shellGeoBytes.toLocaleString()} over ${r.shellActors.length} shell definition(s); placed shell actors ${r.placed.length}`);
  console.log('entity'.padEnd(40) + 'cubes'.padStart(8) + 'meshes'.padStart(8) + 'bones'.padStart(7) + 'empty'.padStart(7) + 'bytes'.padStart(11) + 'maxLit'.padStart(8));
  for (const a of r.shellActors) console.log(a.id.padEnd(40) + String(a.cubes).padStart(8) + String(a.meshes).padStart(8) + String(a.bones).padStart(7) + String(a.emptyBones).padStart(7) + a.bytes.toLocaleString().padStart(11) + String(a.longestLiteral).padStart(8));
  if (r.spatialShell) console.log(`spatialShell: ${JSON.stringify(r.spatialShell)}`);
}

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: bun scripts/_shell_chunk_report.ts <pack.mcaddon> [other.mcaddon]'); process.exit(2); }
const reports = await Promise.all(files.map(report));
for (const r of reports) print(r);
if (reports.length === 2) {
  const [a, b] = reports as [PackReport, PackReport];
  const pct = (x: number, y: number) => y === 0 ? 'n/a' : `${((x / y - 1) * 100).toFixed(1)} %`;
  console.log(`\nshell geo bytes: ${a.shellGeoBytes.toLocaleString()} -> ${b.shellGeoBytes.toLocaleString()} (${pct(b.shellGeoBytes, a.shellGeoBytes)}); pack cuboids ${a.packCuboids} -> ${b.packCuboids}; placed shell actors ${a.placed.length} -> ${b.placed.length}`);
}
