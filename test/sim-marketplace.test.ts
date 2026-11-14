/**
 * T02 (BIZ-26, BIZ-29): the simulator's `--scenario=marketplace`. It plays a store-ready pack the way a Marketplace
 * reviewer and a child would: install, first join, the wand into air only (prompt, clear spot, Cancel), an exact Undo,
 * no ticking area left, two players, no LEGO words in what the sim shows.
 *
 * The packs are the nimbus stand-in (seeded parts, no library: runs in CI): once built with the X-02 store profile
 * and once as the dev pack, whose wand REPLACES blocks and so must fail the scenario.
 */
import { describe, expect, it } from 'vitest';
import { buildNimbusPack } from './pack-profile-support.js';
import { runMarketplace } from '../web/src/sim/adapters/craftmatic/marketplace.js';
import type { ScenarioResult } from '../web/src/sim/scenario/runner.js';
import { rewritePack, type PackFile } from '../web/src/engine/marketplace/rewrite.js';
import { createZip, extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { runCommand } from '../web/src/sim/script-host/commands.js';

const violated = (results: ScenarioResult[], invariant: string): boolean => results.some(r => r.violations.some(v => v.invariant === invariant));

describe('sim-marketplace', () => {
  it('the marketplace scenario fails a pack whose placement replaces a block', async () => {
    const { results } = await runMarketplace(await buildNimbusPack(), { source: 'dev' });
    expect(results.length).toBeGreaterThan(0);
    expect(violated(results, 'foreign-block-replaced'), JSON.stringify(results.map(r => [r.name, r.status, r.violations.map(v => v.invariant)]))).toBe(true);
  }, 300_000);

  // The invariants the wand's air-only promise rests on: none may fire on a store pack.
  const WAND_PROMISES = ['foreign-block-replaced', 'foreign-prompt-missing', 'foreign-prompt-wrote', 'foreign-count-wrong', 'prompt-buttons', 'clear-spot-not-clear',
    'clear-spot-failed', 'undo-inexact', 'ticking-area-left', 'cross-talk', 'first-join-chat', 'first-join-repeated', 'chat-too-long', 'nothing-left-after-undo', 'collider-encoding-differs'];
  it('a store-profile pack keeps the wand promises: prompt, no replacement, exact Undo, no ticking area, per-player welcome', async () => {
    const store = await buildNimbusPack({ flags: { vanillaTextures: false, diagnostics: false, devStamp: false, marketplacePlacement: true, brickBlocks: true, compactColliderStates: true, explicitOnly: true } });
    const { results } = await runMarketplace(store, { source: 'store', quick: true });
    const broken = results.flatMap(r => r.violations.filter(v => WAND_PROMISES.includes(v.invariant)).map(v => `${r.name}: [${v.invariant}] ${v.message}`));
    expect(broken).toEqual([]);
    // The scenarios really ran the flows (a prompt was shown, a clear spot found), not skipped them.
    const cluttered = results.find(r => r.name === 'mp-cluttered')!;
    expect(cluttered.notes.join(' ')).toMatch(/foreign-block prompt: "\d+ foreign blocks? in the way"/);
    expect(cluttered.notes.join(' ')).toMatch(/Find a clear spot: /);
  }, 300_000);

  // Pixel round 2026-11-13: a release's structure ids are `<creator>_<pack>:<pack>/<tile>` (the rewriter nests the
  // namespace folder), and the device answers an UNQUOTED `structure load cmt:a/b ...` with `Syntax error:
  // Unexpected "/"`, so no store pack ever built a model. Quirk `structure-id-slash-needs-quotes`.
  it('a REWRITTEN store pack places its model: the structure id with a slash is quoted (structure-id-slash-needs-quotes)', async () => {
    const store = await buildNimbusPack({ flags: { vanillaTextures: false, diagnostics: false, devStamp: false, marketplacePlacement: true, brickBlocks: true, compactColliderStates: true, explicitOnly: true } });
    const buffer = store.buffer.slice(store.byteOffset, store.byteOffset + store.byteLength) as ArrayBuffer;
    const files: PackFile[] = [];
    for (const name of listZipEntries(buffer)) if (!name.endsWith('/')) files.push({ name, data: new Uint8Array(await extractFile(buffer, name)) });
    const { files: rewritten } = rewritePack(files, { creator: 'cmt', pack: 'nimbus' });
    const structures = rewritten.filter(f => /\/structures\/.+\.mcstructure$/.test(f.name));
    expect(structures.length).toBeGreaterThan(0);
    expect(structures.every(f => /structures\/[^/]+\/[^/]+\//.test(f.name)), structures.map(f => f.name).join(', ')).toBe(true);
    const bytes = await createZip(rewritten, { alwaysDeflate: true });
    const { results } = await runMarketplace(bytes, { source: 'store', quick: true });
    const broken = results.flatMap(r => r.violations.filter(v => WAND_PROMISES.includes(v.invariant)).map(v => `${r.name}: [${v.invariant}] ${v.message}`));
    expect(broken).toEqual([]);
    const placed = results.find(r => r.name === 'mp-cluttered')!;
    expect(placed.notes.join(' ')).toMatch(/Find a clear spot: /);
  }, 300_000);

  it('the simulator refuses an unquoted structure id that contains a slash, as the device does', () => {
    const host = { engine: { structures: new Map(), dimension: () => ({ isLoaded: () => true }) }, timeline: { add: () => {}, callerSource: () => undefined } } as never;
    expect(() => runCommand(host, 'overworld', 'structure load cmt_x:x/tile_0 0 0 0 0_degrees none')).toThrow(/Syntax error: Unexpected "\/"/);
    expect(runCommand(host, 'overworld', 'structure load "cmt_x:x/tile_0" 0 0 0 0_degrees none').successCount).toBe(0);
  });
});
