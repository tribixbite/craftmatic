/**
 * Which moulds build 76417 Gringotts' vault-cart rail, and are they contiguous?
 *
 * For each source it prints the
 * mould census with the LDraw library description of every distinct mould,
 * the ride pieces' world positions, and then a spatial "chain" analysis: for
 * every mould placed at least MIN_RUN times it measures the same-mould
 * nearest-neighbour distances and reports moulds whose placements form a
 * 1-wide run (each placement has ~2 neighbours within CHAIN_LDU) — the
 * signature of a rail laid piece after piece around a curve.
 *
 * Usage: bun scripts/_coaster_mould_chain.ts <model.ldr> [more.ldr …]
 */
import { readFileSync, existsSync } from 'node:fs';
import { parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { partStem } from '../web/src/engine/part-id.ts';
import { coasterTrackProfile } from '../web/src/engine/coaster-track.ts';

const LIB = 'C:/git/clego/extracted/studio_release/app/ldraw';
const LIB_DIRS = [`${LIB}/parts`, `${LIB}/UnOfficial/parts`, `${LIB}/p`, `${LIB}/UnOfficial/p`];
const MIN_RUN = 6;
const CHAIN_LDU = Number(process.env['CHAIN_LDU'] ?? 60);

/** First line of the mould's .dat, minus the leading `0 `; or where it was NOT found. */
function describe(stem: string): string {
  for (const dir of LIB_DIRS) {
    const file = `${dir}/${stem}.dat`;
    if (existsSync(file)) {
      const first = readFileSync(file, 'latin1').split(/\r?\n/)[0] ?? '';
      return first.replace(/^0\s*/, '') + (dir.includes('UnOfficial') ? '  [unofficial]' : '');
    }
  }
  return '<< NOT IN LIBRARY >>';
}

const RAIL_WORDS = /rail|track|arch|girder|beam|train|chute|slide|ramp|curve|coaster|tube|hose|bar|fence|ladder|round.*corner|macaroni|bow/i;

const d3 = (a: ParsedBrick, b: ParsedBrick) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

for (const file of process.argv.slice(2).filter(a => !a.startsWith('--'))) {
  const label = file.replace(/.*lego_sets[/\\]/, '');
  const bricks = parseLDrawDocument(readFileSync(file, 'latin1')).bricks;
  console.log(`\n=== ${label}: ${bricks.length} placements ===`);

  // Model extent, so a Y value can be read as "how high".
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of bricks) {
    lo[0] = Math.min(lo[0]!, b.x); lo[1] = Math.min(lo[1]!, b.y); lo[2] = Math.min(lo[2]!, b.z);
    hi[0] = Math.max(hi[0]!, b.x); hi[1] = Math.max(hi[1]!, b.y); hi[2] = Math.max(hi[2]!, b.z);
  }
  console.log(`  origin extent x ${lo[0]}..${hi[0]}  y ${lo[1]}..${hi[1]} (LDraw y down)  z ${lo[2]}..${hi[2]}`);

  // Census with descriptions.
  const byStem = new Map<string, ParsedBrick[]>();
  for (const b of bricks) {
    const s = partStem(b.part);
    (byStem.get(s) ?? byStem.set(s, []).get(s)!).push(b);
  }
  console.log(`  distinct moulds: ${byStem.size}`);
  const rows = [...byStem].map(([s, list]) => ({ s, n: list.length, desc: describe(s) })).sort((a, b) => b.n - a.n);
  if (process.argv.includes('--census')) {
    for (const r of rows) console.log(`    ${String(r.n).padStart(4)} x ${r.s.padEnd(10)} ${r.desc}`);
  }
  console.log('  moulds whose description matches a rail-like word:');
  for (const r of rows) if (RAIL_WORDS.test(r.desc)) console.log(`    ${String(r.n).padStart(4)} x ${r.s.padEnd(10)} ${r.desc}`);
  const missing = rows.filter(r => r.desc.startsWith('<<'));
  console.log(`  moulds NOT in the library (${missing.length}): ${missing.map(r => `${r.s}x${r.n}`).join(' ') || 'none'}`);

  // Ride pieces.
  console.log('  ride pieces (world origin, rotation):');
  for (const b of bricks) {
    const s = partStem(b.part);
    if (['26021', '24869', '25059', '80562'].includes(s) || coasterTrackProfile(b.part)) {
      console.log(`    ${s.padEnd(6)} c${b.color} at (${b.x}, ${b.y}, ${b.z}) rot [${(b.rot ?? []).join(' ')}]`);
    }
  }

  // Chain analysis per mould.
  console.log(`  same-mould chain analysis (>= ${MIN_RUN} placements, neighbour radius ${CHAIN_LDU} LDU):`);
  console.log('    n  mould     nn-median  nn-max  deg2  deg<=2  comps(largest)  y-span  description');
  const chainRows: string[] = [];
  for (const { s, n, desc } of rows) {
    if (n < MIN_RUN) continue;
    const list = byStem.get(s)!;
    const nn: number[] = [];
    const deg: number[] = [];
    const adj: number[][] = list.map(() => []);
    for (let i = 0; i < list.length; i++) {
      let best = Infinity;
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const d = d3(list[i]!, list[j]!);
        best = Math.min(best, d);
        if (d <= CHAIN_LDU) adj[i]!.push(j);
      }
      nn.push(best);
      deg.push(adj[i]!.length);
    }
    // Connected components under the chain radius.
    const comp = new Array<number>(list.length).fill(-1);
    let nComp = 0; let largest = 0;
    for (let i = 0; i < list.length; i++) {
      if (comp[i] !== -1) continue;
      const stack = [i]; comp[i] = nComp; let size = 0;
      while (stack.length) {
        const k = stack.pop()!; size++;
        for (const j of adj[k]!) if (comp[j] === -1) { comp[j] = nComp; stack.push(j); }
      }
      largest = Math.max(largest, size); nComp++;
    }
    const sorted = [...nn].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)]!;
    const ys = list.map(b => b.y);
    const ySpan = Math.max(...ys) - Math.min(...ys);
    const deg2 = deg.filter(d => d === 2).length;
    const degLe2 = deg.filter(d => d <= 2).length;
    chainRows.push(`    ${String(n).padStart(4)} ${s.padEnd(9)} ${med.toFixed(1).padStart(9)} ${sorted.at(-1)!.toFixed(1).padStart(7)} ${String(deg2).padStart(5)} ${String(degLe2).padStart(7)} ${String(nComp).padStart(5)}(${largest})`.padEnd(66) + ` ${String(ySpan).padStart(6)}  ${desc}`);
  }
  for (const r of chainRows) console.log(r);
}
