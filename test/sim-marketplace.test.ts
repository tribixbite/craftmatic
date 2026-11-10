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
});
