/**
 * List the corpus files a landmark designer must NEVER open (plan A section 3.3).
 *
 *   bun scripts/_cleanroom_denylist.ts "notre dame" eiffel neuschwanstein [--index <index.json>] [--json]
 *
 * Matches every keyword against the set NAMES in the models index (case, spaces and punctuation ignored) and prints
 * each set with every corpus path the index lists for it. Every designer brief includes this output as "never open";
 * `_cleanroom_check.ts` reads the same list to score the finished design.
 */
import { readFileSync } from 'node:fs';
import { matchDenylist, type DenylistIndex } from '../web/src/engine/byom/fingerprint.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const indexPath = flag('index') ?? 'web/public/lego-models-index.json';
const keywords = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--index');

if (keywords.length === 0) {
  console.error('usage: bun scripts/_cleanroom_denylist.ts <keyword>... [--index <index.json>] [--json]');
  process.exit(2);
}

const entries = matchDenylist(JSON.parse(readFileSync(indexPath, 'utf8')) as DenylistIndex, keywords);
if (args.includes('--json')) {
  console.log(JSON.stringify(entries, null, 2));
} else {
  for (const e of entries) console.log(`${e.setId}  ${e.name}\n${e.paths.map((p) => `    ${p}`).join('\n')}`);
  console.error(`${entries.length} sets, ${entries.reduce((n, e) => n + e.paths.length, 0)} files match ${JSON.stringify(keywords)}`);
}
