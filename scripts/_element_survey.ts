/**
 * Slice-5 evidence: which LEGO parts are worth a semantic Minecraft element,
 * measured rather than guessed.
 *
 * Counts type-1 placements across a sample of the local corpus, joins each part
 * id to the LDraw library's OWN description line (the same authoritative source
 * the slope pass uses — see engine/block-shapes.ts `isSlopeDescription`), and
 * buckets the head of the distribution by the element families the proposal
 * names. Prints, per bucket, the parts ordered by real placement count.
 *
 * Usage: bun scripts/_element_survey.ts [sampleFilesPerDir] [--all]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LIB = 'C:/git/clego/extracted/studio_release/app/ldraw';
const CORPUS = 'C:/git/clego/lego_sets';
const DIRS = ['OMR', 'IOModel2V2', 'DbixConvV3'];
const sample = Number(process.argv[2] ?? 150);
const showAll = process.argv.includes('--all');

const counts = new Map<string, number>();
let files = 0, placements = 0;

for (const dir of DIRS) {
  const full = join(CORPUS, dir);
  if (!existsSync(full)) continue;
  const names = readdirSync(full).filter(n => /\.(ldr|mpd)$/i.test(n)).sort();
  // Evenly spaced sample, so one naming block can't dominate.
  const step = Math.max(1, Math.floor(names.length / sample));
  for (let i = 0; i < names.length; i += step) {
    let text: string;
    try { text = readFileSync(join(full, names[i]!), 'utf-8'); } catch { continue; }
    files++;
    for (const line of text.split('\n')) {
      if (line.charCodeAt(0) !== 49 /* '1' */) continue;
      const tok = line.trim().split(/\s+/);
      if (tok[0] !== '1' || tok.length < 15) continue;
      const id = tok.slice(14).join(' ').replace(/\.dat$/i, '').toLowerCase();
      if (id.includes('/') || id.includes('\\')) continue;   // sub-file / primitive
      counts.set(id, (counts.get(id) ?? 0) + 1);
      placements++;
    }
  }
}

/** First line of a part's .dat, i.e. the library's own description. */
function description(id: string): string {
  for (const p of [`${LIB}/parts/${id}.dat`, `${LIB}/p/${id}.dat`, `${LIB}/UnOfficial/parts/${id}.dat`]) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf-8');
    return text.slice(0, text.indexOf('\n')).replace(/^0\s+/, '').trim();
  }
  return '';
}

/** The element families the proposal names, as description patterns. */
const BUCKETS: ReadonlyArray<readonly [string, RegExp]> = [
  ['pane',     /^(Glass for |Windscreen .*Glass|Pane |Panel .*Glass)|Glass for Window|Glass for Frame/i],
  ['bars',     /Lattice|Grille|Grating|^Bar\b|with Bars|Barred/i],
  ['fence',    /^Fence\b|Railing|^Bar 1 x 4 x 2|Balustrade/i],
  ['ladder',   /Ladder/i],
  ['door',     /^Door\b|Door 1 x|Doorway/i],
  ['trapdoor', /Trap ?Door|Hatch|^Panel .*Shutter|Shutter/i],
  ['flora',    /^Plant\b|^Flower|Foliage|^Bush|Stem|^Grass\b|^Tree\b/i],
  ['rod',      /^Antenna|^Bar\s+\d|Lightsaber|^Hose Rigid|^Support .*Pole|^Pole\b/i],
  ['window',   /^Window\b/i],
];

const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
const head = showAll ? sorted : sorted.slice(0, 3000);

const byBucket = new Map<string, Array<{ id: string; n: number; desc: string }>>();
for (const [id, n] of head) {
  const desc = description(id);
  if (!desc) continue;
  for (const [name, re] of BUCKETS) {
    if (!re.test(desc)) continue;
    const arr = byBucket.get(name) ?? [];
    arr.push({ id, n, desc });
    byBucket.set(name, arr);
    break;                                   // first bucket wins, order matters
  }
}

console.log(`sampled ${files} files · ${placements.toLocaleString()} placements · ${counts.size.toLocaleString()} distinct parts\n`);
for (const [name] of BUCKETS) {
  const arr = byBucket.get(name) ?? [];
  const total = arr.reduce((s, r) => s + r.n, 0);
  console.log(`── ${name} — ${arr.length} parts, ${total.toLocaleString()} placements`);
  for (const r of arr.slice(0, showAll ? 60 : 18)) {
    console.log(`   ${String(r.n).padStart(6)}  ${r.id.padEnd(12)} ${r.desc}`);
  }
  console.log('');
}
