/**
 * Run the moving-part discovery (`discoverInteractives`) on LDraw sources
 * without building a pack: every part found (kind, mould, how it moves) and
 * every part matched but left static, with the rule. The fast loop for a rule
 * change; the pack's own report (`_ix_audit_report.ts`) is the final word.
 *
 * Usage: bun scripts/_ix_discover.ts <model.ldr|.mpd>... [--kind=turnable]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseLDrawDocument, embeddedPartTexts } from '../web/src/engine/ldraw-parser.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.ts';
import { discoverInteractives } from '../web/src/engine/bedrock-interactives.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const kind = process.argv.find(a => a.startsWith('--kind='))?.slice(7);
for (const file of process.argv.slice(2).filter(a => !a.startsWith('--'))) {
  const doc = parseLDrawDocument(readFileSync(file, 'utf8'));
  seedDatTexts(embeddedPartTexts(doc));
  const scene = await discoverSceneActors(doc.bricks);
  const found = discoverInteractives(doc.bricks, scene.meshes, { exclude: scene.figureBricks });
  const count = (list: Array<{ kind: string; part: string; reason?: string }>): string[] => {
    const m = new Map<string, number>();
    for (const x of list) if (!kind || x.kind === kind) { const k = `${x.kind} ${x.part}${x.reason ? `: ${x.reason}` : ''}`; m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m].map(([k, n]) => `${k} x${n}`);
  };
  console.log(`${basename(file)}: found ${found.items.length}, static ${found.skipped.length}`);
  for (const l of count(found.items.map(i => ({ kind: i.kind + (i.slide ? ' (slides)' : ''), part: i.part })))) console.log(`  found  ${l}`);
  for (const l of count(found.skipped)) console.log(`  static ${l}`);
}
