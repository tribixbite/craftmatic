/**
 * Learn which print an OLD LDD decoration id is, from the corpus itself (generality census 2026-11-16, FIG-04).
 *
 * An LDD `.lxf` places every minifig head as design 3626 with the face as a `decoration` id (`59717`). Studio's
 * `ldraw.xml` names 12 such head decorations, the DBIX element tables name none of the old ones (their decoration
 * ids are a different, 7-digit space), so the corpus's 4,491 decorated head placements in 3,647 `.lxf` files drew
 * the default face: 216 distinct decorations, no table. The votes come from the same sets' print-naming
 * conversions through the face-transfer matcher (`scripts/decoration-votes.ts`, shared with the Mecabricks
 * decorations of `_mb_decoration_votes.ts`); `gen-ldd-print-map.py` turns a decoration into a `d:` row only when
 * at least `VOTE_MIN_SETS` different sets agree and the rival prints together hold at most
 * `VOTE_MAX_RIVAL_SHARE` of its sets.
 *
 * Usage: bun scripts/_ldd_decoration_votes.ts [--out=scripts/ldd-decoration-votes.json] [--limit=N] [set…]
 * Offline: run with `CRAFTMATIC_LDRAW_MIRROR=off` in the ENVIRONMENT (ldraw-geometry.ts reads it at import, before
 * any line here runs, so setting it below does not stop prod fetches - a run without it sat on HTTPS for 15 minutes).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import { collectVotes, donorFilesBySet, filesBySet, tallyVotes } from './decoration-votes.ts';

export { setOfFile } from './decoration-votes.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync('C:/git/clego/ldraw_ref')) process.env.CRAFTMATIC_LDRAW_REF = 'C:/git/clego/ldraw_ref';
process.env.CRAFTMATIC_LDRAW_MIRROR ??= 'off';
/** Folders of LDD `.lxf` files (the targets). */
const LXF_DIRS = ['Eurobricks', 'LXF', 'EurobricksTopicLDD', 'EurobricksLDD'];

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = new Set(argv.filter(a => !a.startsWith('--')));
const limit = Number(opt('limit') ?? Infinity);
const outPath = opt('out') ?? 'scripts/ldd-decoration-votes.json';

async function main(): Promise<void> {
  const lxfs = filesBySet(LXF_DIRS, f => /\.lxf$/i.test(f), only);
  const donors = donorFilesBySet(only);
  const sets = [...lxfs.keys()].filter(s => donors.has(s)).slice(0, limit);
  console.log(`${lxfs.size} sets with an .lxf, ${sets.length} with a donor that may name prints`);
  const targets = new Map(sets.map(s => [s, lxfs.get(s)!]));
  const r = await collectVotes({
    targets, donors, provider: createPartGeometryProvider(), log: l => console.log(l),
    decorationsOf: (_path, bricks) => new Map(bricks.flatMap((b, i) => (b.lddDecoration ? [[i, b.lddDecoration] as const] : []))),
  });
  // `lxf` keeps the field name earlier runs wrote.
  const detail = r.votes.map(({ target, head: _head, ...v }) => ({ ...v, lxf: target }));
  const tally = tallyVotes(r.votes);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({
    generated: 'bun scripts/_ldd_decoration_votes.ts', lxfHeads: r.heads, decorated: r.decorated, votes: r.votes.length,
    tally, detail,
  }, null, 1)}\n`);
  console.log(`${r.heads} heads in the .lxf files read, ${r.decorated} with an unprinted decoration; ${r.votes.length} votes over ${Object.keys(tally).length} decorations -> ${outPath}`);
}

if ((import.meta as { main?: boolean }).main) await main();
