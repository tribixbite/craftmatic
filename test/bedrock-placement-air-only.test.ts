/**
 * Marketplace-safe placement (BIZ-26, WP-M07): with `marketplacePlacement` (the
 * X-02 profile's `flags.marketplacePlacement`) the SERIALISED Brick Wand places
 * only into air. A footprint holding the player's own blocks gets a prompt
 * ("n foreign blocks": Find a clear spot / Move / Cancel) and is never
 * written to; Undo restores the world exactly; no ticking area outlives a
 * placement, a preflight or an Undo; chat stays under 28 characters and is
 * sent on first join only. Without the flag nothing changes (dev pack).
 *
 * Runs on the headless simulator through test/_placement-host.ts, over real
 * structure blocks (the host's default tiles are empty).
 */
import { describe, expect, it } from 'vitest';
import { host } from './_placement-host.js';
import { plainText } from '../web/src/sim/script-host/text.js';
import { buildNimbusPack, text, unzipAll } from './pack-profile-support.js';

const spec = (marketplace: boolean) => ({
  stem: 'aironly', label: 'Air Only (aironly-1)', width: 20, height: 4, length: 20,
  tiles: [0, 10].map((dx, i) => ({ identifier: `craftmatic:t${i}`, dx, dy: 0, dz: 0, width: 10, height: 4, length: 20, nonAir: 1 })),
  actors: [{ typeId: 'craftmatic:fig', label: 'Figure 1', x: 3, y: 1, z: 3 }],
  previewPoints: [{ x: 0.5, y: 0.5, z: 0.5 }], settleTicks: 0, finalHoldTicks: 0,
  ...(marketplace ? { marketplacePlacement: true } : {}),
});

const PLAYER = { x: 10, y: 20, z: 30 };

/** One world; each tile is given a few real stone blocks so a placement writes something Undo must take back. */
function world(marketplace = true) {
  const h = host(spec(marketplace), { playerAt: PLAYER });
  for (const [i, t] of spec(marketplace).tiles.entries()) {
    const indices = new Int32Array(t.width * t.height * t.length).fill(-1);
    for (const [x, y, z] of [[1, 0, 1], [2, 1, 2], [5, 2, 5]] as const) indices[x * t.height * t.length + y * t.length + z] = 0;
    h.engine.structures.set(t.identifier, { size: { x: t.width, y: t.height, z: t.length }, palette: [{ typeId: 'minecraft:brick_block', states: {} }], indices, extra: new Int32Array(0) });
    void i;
  }
  const dim = h.engine.dimension('overworld');
  /** Every block of a box as text: the world "byte for byte". */
  const snapshot = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): string => {
    const out: string[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) { const p = dim.permutationAt(x, y, z); out.push(`${p.typeId}${JSON.stringify(p.states)}`); }
    return out.join('|');
  };
  const typeAt = (x: number, y: number, z: number): string => dim.permutationAt(x, y, z).typeId;
  const messages = (): string[] => h.player.sendMessage.mock.calls.map((c: unknown[]) => String(c[0]));
  /** Every form shown, as `title | body`. */
  const forms = (): string[] => h.engine.timeline.of('form').map(e => plainText(e.text));
  const formTitles = (): string[] => h.buttons.map(b => b.join(' / '));
  const pin = async () => { await h.open({ action: 'Pin corner at my feet' }, { canceled: true }); };
  const live = () => h.spawned.filter(s => s.typeId === 'craftmatic:fig' && (s as any).sim.valid);
  return { h, dim, snapshot, typeAt, messages, forms, formTitles, pin, live };
}

describe('Brick Wand places only into air under the marketplace profile', () => {
  it('places onto clear ground without a prompt, replaces nothing, and leaves no ticking area', async () => {
    const w = world();
    const { h } = w;
    await w.pin();
    await h.open({ action: 'Place' }, { selection: 0 });
    expect(w.messages().concat(h.actionBars).some(m => m.includes('Placed Air Only'))).toBe(true);
    expect(w.typeAt(11, 20, 31)).toBe('minecraft:brick_block');
    // No foreign-block prompt on clear ground, and the replace warning is gone.
    expect(h.buttons.flat().some(b => b.includes('Find a clear spot'))).toBe(false);
    expect(h.runtimeAreas()).toHaveLength(0);
  });

  it('placing over one foreign block refuses and offers a clear spot; nothing is replaced', async () => {
    const w = world();
    const { h } = w;
    // The player's own block, in a cell the first tile's structure would write.
    h.blocks.set('11,20,31', { typeId: 'minecraft:diamond_block' });
    const before = w.snapshot(0, 15, 20, 60, 30, 70);
    await w.pin();
    await h.open({ action: 'Place' }, { action: 'Cancel' });
    // The prompt names the count and offers all three ways out.
    const prompt = w.forms().find(f => f.includes('Find a clear spot'));
    expect(prompt, w.forms().join('\n')).toBeDefined();
    expect(prompt).toMatch(/1 foreign block/);
    expect(h.buttons.some(b => b.some(l => l.startsWith('Find a clear spot')) && b.some(l => l.startsWith('Move')) && b.some(l => l.startsWith('Cancel')))).toBe(true);
    // Cancel: nothing was written, nothing saved, nothing spawned, no area held.
    expect(w.snapshot(0, 15, 20, 60, 30, 70)).toBe(before);
    expect(w.typeAt(11, 20, 31)).toBe('minecraft:diamond_block');
    expect(h.commands.filter(c => c.startsWith('structure load'))).toHaveLength(0);
    expect(h.engine.structures.size).toBe(2);
    expect(w.live()).toHaveLength(0);
    expect(h.runtimeAreas()).toHaveLength(0);
  });

  it('Find a clear spot moves the pin to a footprint with no foreign block, then places there; the foreign block stays', async () => {
    const w = world();
    const { h } = w;
    h.blocks.set('11,20,31', { typeId: 'minecraft:diamond_block' });
    await w.pin();
    await h.open({ action: 'Place' }, { action: 'Find a clear spot' }, { action: 'Place now' });
    expect(w.typeAt(11, 20, 31)).toBe('minecraft:diamond_block');
    const loads = h.commands.filter(c => c.startsWith('structure load'));
    expect(loads).toHaveLength(2);
    // Same height, a different corner, and the whole new footprint was air before it.
    const at = loads[0]!.split(' ').slice(3, 6).map(Number);
    expect(at[1]).toBe(20);
    expect(at[0] === 10 && at[2] === 30).toBe(false);
    expect(w.live()).toHaveLength(1);
    expect(h.runtimeAreas()).toHaveLength(0);
  });

  it('Move returns to the wand menu without placing', async () => {
    const w = world();
    const { h } = w;
    h.blocks.set('11,20,31', { typeId: 'minecraft:diamond_block' });
    await w.pin();
    await h.open({ action: 'Place' }, { action: 'Move' }, { canceled: true });
    expect(h.commands.filter(c => c.startsWith('structure load'))).toHaveLength(0);
    expect(h.buttons.at(-1)!.some(l => l.startsWith('Place'))).toBe(true);
  });

  it('Undo restores every block and entity exactly, and leaves no ticking area', async () => {
    const w = world();
    const { h } = w;
    // Foreign blocks around the footprint (outside it) must be untouched too.
    h.blocks.set('9,20,30', { typeId: 'minecraft:diamond_block' });
    h.blocks.set('30,20,50', { typeId: 'minecraft:gold_block' });
    const before = w.snapshot(0, 10, 20, 60, 40, 70);
    await w.pin();
    await h.open({ action: 'Place' }, { selection: 0 });
    expect(w.snapshot(0, 10, 20, 60, 40, 70)).not.toBe(before);
    expect(w.live()).toHaveLength(1);
    await h.open({ action: 'Undo last placement' });
    expect(w.snapshot(0, 10, 20, 60, 40, 70)).toBe(before);
    expect(w.live()).toHaveLength(0);
    expect(h.runtimeAreas()).toHaveLength(0);
    expect(h.engine.structures.size).toBe(2);
  });

  it('a second placement over the first one\'s blocks is refused until Undo', async () => {
    const w = world();
    const { h } = w;
    await w.pin();
    await h.open({ action: 'Place' }, { selection: 0 });
    const after = w.snapshot(0, 10, 20, 60, 40, 70);
    await h.open({ action: 'Place' }, { action: 'Cancel' });
    expect(w.forms().some(f => /foreign block/.test(f))).toBe(true);
    expect(w.snapshot(0, 10, 20, 60, 40, 70)).toBe(after);
  });
});

describe('marketplace chat and guide', () => {
  it('sends chat only on first join and never more than 28 characters; everything else is the action bar', async () => {
    const w = world();
    const { h } = w;
    h.host.deliver('playerSpawn', { player: h.player, initialSpawn: true });
    await h.flush();
    const joinChat = w.messages();
    expect(joinChat.length).toBeGreaterThan(0);
    for (const m of joinChat) expect(plainText(m).length, m).toBeLessThanOrEqual(28);
    // A respawn is not a first join.
    h.host.deliver('playerSpawn', { player: h.player, initialSpawn: false });
    await h.flush();
    expect(w.messages()).toEqual(joinChat);
    // Placing and undoing talk through the action bar, not chat.
    await w.pin();
    await h.open({ action: 'Place' }, { selection: 0 });
    await h.open({ action: 'Undo last placement' });
    expect(w.messages()).toEqual(joinChat);
    expect(h.actionBars.some(m => m.includes('Undo complete'))).toBe(true);
  });

  it('offers a two-page guide in the wand menu', async () => {
    const w = world();
    const { h } = w;
    await h.open({ action: 'Guide' }, { action: 'Next' }, { action: 'Close' });
    const titles = w.forms().map(f => f.split('|')[0]!.trim());
    expect(titles.some(t => t.includes('Guide 1/2'))).toBe(true);
    expect(titles.some(t => t.includes('Guide 2/2'))).toBe(true);
  });
});

describe('the dev pack is unchanged', () => {
  it('without the flag a placement over a foreign block still replaces it, with no prompt', async () => {
    const w = world(false);
    const { h } = w;
    h.blocks.set('11,20,31', { typeId: 'minecraft:diamond_block' });
    await w.pin();
    await h.open({ action: 'Place' }, { selection: 0 });
    expect(w.typeAt(11, 20, 31)).toBe('minecraft:brick_block');
    expect(h.buttons.flat().some(b => b.includes('Find a clear spot'))).toBe(false);
  });
});

describe('the X-02 profile switches it on', () => {
  it('flags.marketplacePlacement reaches the shipped wand; a dev pack carries no marketplace key', async () => {
    const script = async (flags?: { marketplacePlacement: boolean }): Promise<string> => {
      const files = await unzipAll(await buildNimbusPack(flags ? { flags } : undefined));
      const name = [...files.keys()].find(k => k.endsWith('scripts/placement.js'))!;
      return text(files.get(name)!);
    };
    expect(await script({ marketplacePlacement: true })).toContain('"marketplace":true');
    expect(await script()).not.toContain('"marketplace"');
  }, 240_000);
});
