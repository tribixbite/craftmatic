/**
 * What a built pack costs a phone, in the unit the device pays for: entity
 * CUBOIDS, per entity and in total, with the shell's grain plan (how much of it
 * runs at each LDU, and what a pinned grain such as the smooth track added) and
 * the native-heap estimate from the Pixel geometry probe.
 *
 * The memory figures are a measured SLOPE, not a measurement of this pack:
 * round 2026-10-27a loaded two builds of 10303 that differ only in 26,660
 * shell cuboids (the smooth track) on the Pixel 8 Pro, alternating, and read
 * +73 / +111 MB native heap (+92 mean, +96 PSS) - 2.7-4.2 MB per 1,000
 * cuboids (`output/device-round-2026-10-27a/pixel/notes.md`). The 30zv
 * geometry probe's 2.0-2.5 per 1,000 (bare box-UV cubes) under-reads a real
 * pack. Whole-process anchor: 10303's default build alone is +275 MB native,
 * +297 MB PSS over no packs (same round).
 *
 * Usage: bun scripts/_pack_cuboids.ts <pack.mcaddon|dir>... [--base=<pack|dir>] [--json=<out>]
 *   --base   compare each pack with the same-named pack there (cuboid and MB deltas)
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readPackDiagnostics, toArrayBuffer } from '../web/src/ui/addon-preview-data.ts';
import { DEVICE_CUBOID_BUDGET } from '../web/src/engine/playable-addon.ts';

/** Pixel 8 Pro native heap per 1,000 pack cuboids, MB (low, high): round 2026-10-27a's two A/B pairs. */
export const PIXEL_NATIVE_MB_PER_1000_CUBES = [2.7, 4.2] as const;

interface ShellPlan {
  budget: number; cuboids: number; fidelity: number; placementsAtGrain: Record<string, number>;
  pinnedParts?: number; pinnedPlacements?: number; pinnedExtraCuboids?: number;
}
interface PackCost {
  file: string; cuboids: number; entities: number; shellCuboids: number; shellPlan: ShellPlan | null;
  /** The largest entities by cube count. */
  top: Array<{ id: string; cubes: number }>;
}

async function packCost(file: string): Promise<PackCost> {
  const d = await readPackDiagnostics<{
    pack?: { cuboids?: number; entities?: number };
    entities?: Record<string, { cubeCount?: number; grainPlan?: ShellPlan }>;
  }>(toArrayBuffer(readFileSync(file)));
  if (!d) throw new Error(`${file}: no craftmatic-diagnostics.json`);
  const ents = Object.entries(d.entities ?? {}).map(([id, e]) => ({ id, cubes: e.cubeCount ?? 0, plan: e.grainPlan }));
  const shell = ents.find(e => /_shell$/.test(e.id));
  return {
    file, cuboids: d.pack?.cuboids ?? ents.reduce((s, e) => s + e.cubes, 0), entities: d.pack?.entities ?? ents.length,
    shellCuboids: shell?.cubes ?? 0, shellPlan: shell?.plan ?? null,
    top: ents.sort((a, b) => b.cubes - a.cubes).slice(0, 5).map(({ id, cubes }) => ({ id, cubes })),
  };
}

const mb = (cubes: number): string => PIXEL_NATIVE_MB_PER_1000_CUBES.map(r => (cubes / 1000 * r).toFixed(0)).join('-');
const packsIn = (p: string): string[] => statSync(p).isDirectory()
  ? readdirSync(p).filter(f => f.endsWith('.mcaddon')).sort().map(f => join(p, f)) : [p];

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const inputs = args.filter(a => !a.startsWith('--')).flatMap(packsIn);
if (!inputs.length) { console.error('usage: bun scripts/_pack_cuboids.ts <pack.mcaddon|dir>... [--base=<pack|dir>] [--json=<out>]'); process.exit(2); }
const baseFlag = flag('base');
const base = new Map((baseFlag ? packsIn(baseFlag) : []).map(f => [basename(f), f]));

const report: Array<PackCost & { base?: PackCost }> = [];
for (const file of inputs) {
  const cost = await packCost(file);
  const bf = base.get(basename(file));
  const b = bf ? await packCost(bf) : undefined;
  report.push({ ...cost, ...(b ? { base: b } : {}) });
  const p = cost.shellPlan;
  console.log(`${basename(file)}: ${cost.cuboids.toLocaleString('en-US')} cuboids over ${cost.entities} entities `
    + `(${(100 * cost.cuboids / DEVICE_CUBOID_BUDGET).toFixed(1)} % of the ${DEVICE_CUBOID_BUDGET.toLocaleString('en-US')} device budget), `
    + `Pixel native ~${mb(cost.cuboids)} MB`);
  if (p) {
    console.log(`  shell ${cost.shellCuboids.toLocaleString('en-US')} cubes; plan budget ${p.budget.toLocaleString('en-US')}, fidelity ${p.fidelity}, placements by grain ${JSON.stringify(p.placementsAtGrain)}`
      + (p.pinnedParts ? `; pinned ${p.pinnedParts} parts / ${p.pinnedPlacements} placements, +${(p.pinnedExtraCuboids ?? 0).toLocaleString('en-US')} planned cuboids` : ''));
  }
  console.log(`  largest: ${cost.top.map(t => `${t.id.replace(/^.*?_(?=shell|car|coaster|fig|door)/, '')} ${t.cubes}`).join(', ')}`);
  if (b) {
    const dc = cost.cuboids - b.cuboids, ds = cost.shellCuboids - b.shellCuboids;
    console.log(`  vs base: ${dc >= 0 ? '+' : ''}${dc.toLocaleString('en-US')} cuboids (${(100 * dc / b.cuboids).toFixed(1)} %; shell ${ds >= 0 ? '+' : ''}${ds.toLocaleString('en-US')}), `
      + `Pixel native ${dc >= 0 ? '+' : '-'}${mb(Math.abs(dc))} MB; base ${b.cuboids.toLocaleString('en-US')} cuboids ~${mb(b.cuboids)} MB, fidelity ${b.shellPlan?.fidelity ?? '-'}`);
  }
}
if (report.length > 1) {
  const sum = report.reduce((s, r) => s + r.cuboids, 0), sumBase = report.reduce((s, r) => s + (r.base?.cuboids ?? 0), 0);
  console.log(`TOTAL ${report.length} packs: ${sum.toLocaleString('en-US')} cuboids, Pixel native ~${mb(sum)} MB`
    + (sumBase ? `; base ${sumBase.toLocaleString('en-US')} (~${mb(sumBase)} MB), delta +${(sum - sumBase).toLocaleString('en-US')} (~${mb(sum - sumBase)} MB)` : ''));
}
const out = flag('json');
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
