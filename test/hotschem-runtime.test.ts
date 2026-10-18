/**
 * The HotSchem Live behaviour pack (bedrock/hotschem/HotSchem_BP), loaded
 * UNMODIFIED - manifest, item and every script - on the headless simulator
 * (test/_sim-host.ts), and driven the way a player and the companion page
 * drive it: the Planner item and its forms for a pasted import, `/scriptevent
 * hotschem:stream <part>` for a streamed one, a world reopen for a restart.
 *
 * Everything is read back from outside the scripts: the world's saved import
 * library (`hotschem:imports` and its chunk properties), the player's saved
 * plan (`hotschem:plan`), their tags, chat and the forms shown. The old host
 * reached into main.js (pasteImport, state, storeImport, MODELS) through a vm
 * context; where it asserted on an internal the assertion is now on what that
 * internal leaves in the world.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as codec from '../bedrock/hotschem/HotSchem_BP/scripts/live-import.js';
import { simHost, solidBelow } from './_sim-host.js';
import type { FormAnswer, ShownForm } from '../web/src/sim/script-host/ui-module.js';
import type { SimEntity } from '../web/src/sim/entity/entity.js';

const PACK = fileURLToPath(new URL('../bedrock/hotschem/HotSchem_BP/', import.meta.url));

/** Every file of the pack by path from its root: scripts as modules, the rest as files. */
function packContents(): { modules: Record<string, string>; files: Record<string, string> } {
  const modules: Record<string, string> = {}, files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const rel = path.relative(PACK, full).split(path.sep).join('/');
      (rel.endsWith('.js') ? modules : files)[rel] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(PACK);
  return { modules, files };
}

interface RuntimeOptions {
  /** World-storage writes that fail as a full world store does (fault injection on `world.setDynamicProperty`). */
  failWrite?: (key: string) => boolean;
  /** Import parts to paste into the Planner's import form, in order. */
  parts?: string[];
  /** Palette names the device refuses (`BlockPermutation.resolve` throws for them). */
  unknownBlocks?: string[];
  /**
   * The player's plan as the world saved it (`hotschem:plan`), in place before the world ticks: the pack's
   * preview interval reads every player's plan on its first pass, so a plan written later is never read.
   */
  plan?: Record<string, unknown>;
}

/** One world with the pack, one player standing on it, the scripts started and the saved imports loaded. */
async function runtime(o: RuntimeOptions = {}) {
  const parts = [...(o.parts ?? [])];
  const forms: ShownForm[] = [];
  /** The Planner, answered as a child pasting an import: Library → Import → Paste, one part per form, then close. */
  const chooser = (f: ShownForm): FormAnswer => {
    forms.push(f);
    if (f.kind === 'action' && f.buttons.some(b => b.startsWith('Import · paste local file'))) return parts.length ? { button: 'Import · paste local file' } : { cancel: true };
    if (f.title === 'Import local build') return parts.length ? { button: 0 } : { cancel: true };
    if (f.kind === 'modal' && f.title === 'HotSchem · Paste import') return parts.length ? { values: [parts.shift()] } : { cancel: true };
    return { cancel: true };
  };
  const { modules, files } = packContents();
  const h = simHost({ modules, files, entry: 'scripts/main.js', terrain: solidBelow(0), chooser, deferScripts: true });
  const server: any = h.host.builtin('@minecraft/server');
  if (o.unknownBlocks?.length) {
    // Fault injection standing in for the device's block registry: the simulator knows no vanilla id list
    // (every `minecraft:` id resolves), while the game refuses an id it does not have.
    const resolve = server.BlockPermutation.resolve, unknown = new Set(o.unknownBlocks);
    server.BlockPermutation.resolve = (id: string, states?: Record<string, unknown>) => { if (unknown.has(id)) throw new Error(`Unsupported block ${id}`); return resolve(id, states); };
  }
  if (o.failWrite) {
    // Fault injection: a world store that refuses the write (the device throws when world storage is full).
    const world = h.world, set = world.setDynamicProperty, fail = o.failWrite;
    world.setDynamicProperty = (k: string, v?: unknown) => { if (fail(k)) throw new Error('Storage full'); return set(k, v); };
  }
  h.start();
  const player: SimEntity = h.addPlayer('Player', { x: 0.5, y: 0, z: 0.5 });
  const p = h.api(player);
  if (o.plan) player.dynamic.set('hotschem:plan', JSON.stringify(o.plan));
  /** Let the world settle: worldLoad, the saved-import job, anything a form or a stream started. */
  const settle = (ticks = 20): Promise<void> => h.runAsync(ticks);
  await settle();
  const worldIds = (): string[] => h.world.getDynamicPropertyIds();
  const index = (): Array<{ key: string; count: number; size: number }> => JSON.parse(h.world.getDynamicProperty('hotschem:imports') || '[]');
  return {
    h, p, player, forms, settle, worldIds, index,
    plan: (): { key: string | null; scale: number; rotation: number } => JSON.parse(p.getDynamicProperty('hotschem:plan') || 'null'),
    messages: (): string[] => h.lines('chat', 'Player'),
    /** Use the Planner (the item-use event), answering its forms with the parts queued. */
    usePlanner: async (): Promise<void> => { h.engine.emit('itemUse', { source: player, itemTypeId: 'hotschem:planner' }); await settle(60); },
    /** `/scriptevent <id> <message>` run by the player (the companion page's stream and the plan command). */
    scriptEvent: async (id: string, message: string): Promise<void> => { h.engine.emit('scriptEventReceive', { id, message, sourceEntity: player }); await settle(10); },
    /** The body of the last Plan build form shown (the imported model's title and size as the Planner shows them). */
    lastPlanBody: (): string | undefined => forms.filter(f => f.title === 'HotSchem · Plan build').at(-1)?.body,
    /** Reopen the world: a fresh script over the same saved world. */
    restart: async (): Promise<void> => { h.reload(); await settle(); },
  };
}
const model = () => ({ title: 'Import test', w: 8, h: 4, l: 8, palette: [['minecraft:stone', {}]], ops: [[0, 0, 0, 7, 0, 7, 0]] });

test('actual runtime accepts multipart forms, persists and reloads without world block access', async () => {
  const m = model(), encoded = codec.encodeModel(m);
  const r = await runtime({ parts: codec.makeParts(encoded, 100), plan: { scale: .5, rotation: 90 } });
  await r.usePlanner();
  // One model in the world's library, and the player's plan now names it (the old host counted MODELS).
  assert.equal(r.index().length, 1);
  assert.equal(r.plan().key, r.index()[0]!.key);
  assert.equal(r.plan().scale, .5); assert.equal(r.plan().rotation, 90);
  const shown = r.lastPlanBody();
  assert.ok(shown?.startsWith('Import test'));
  // A restarted world loads the same model back from its storage: selected by title, the Planner shows the same
  // model, size and plan (the old host compared the decoded MODELS objects).
  await r.restart();
  await r.scriptEvent('hotschem:plan', 'Import');
  assert.equal(r.lastPlanBody(), shown);
  assert.ok(r.messages().some(m => m.includes('Saved in this world')));
});
test('runtime refuses unsupported palette and rolls back failed persistence', async () => {
  const m = model(); m.palette[0]![0] = 'minecraft:not_real';
  const r = await runtime({ parts: [codec.makeParts(codec.encodeModel(m))[0]!], unknownBlocks: ['minecraft:not_real'] });
  await r.usePlanner();
  // Nothing imported and nothing written to the world (the old host: MODELS empty, world properties empty).
  assert.equal(r.index().length, 0); assert.equal(r.worldIds().length, 0);
  // A world whose store refuses the index write: the import fails with the store's error and its chunk writes
  // are rolled back (the old host called storeImport directly and saw it throw "Storage full").
  const broken = await runtime({ parts: codec.makeParts(codec.encodeModel(model()), 100), failWrite: k => k === 'hotschem:imports' });
  await broken.usePlanner();
  assert.ok(broken.messages().some(line => /Storage full/.test(line)));
  assert.equal(broken.worldIds().length, 0);
});
test('stream acknowledges only a persisted model and duplicates do not place or duplicate it', async () => {
  const r = await runtime();
  const encoded = codec.encodeModel(model()), id = codec.checksum(encoded);
  const parts = codec.makeParts(encoded, 100);
  for (const part of parts.slice(0, -1)) await r.scriptEvent('hotschem:stream', part);
  assert.equal(r.p.hasTag(`hs_ready_${id}`), false);
  await r.scriptEvent('hotschem:stream', parts.at(-1)!);
  assert.equal(r.p.hasTag(`hs_ready_${id}`), true);
  for (const part of parts) await r.scriptEvent('hotschem:stream', part);
  assert.equal(r.index().length, 1);
  await r.restart();
  assert.equal(r.index().length, 1);
  // The restarted world has the model back (selectable by title), as the old host's restarted MODELS held one.
  await r.scriptEvent('hotschem:plan', 'Import');
  assert.ok(r.lastPlanBody()?.startsWith('Import test'));
});
test('stream failure never publishes readiness when world storage fails', async () => {
  const r = await runtime({ failWrite: k => k === 'hotschem:imports' });
  const encoded = codec.encodeModel(model()), id = codec.checksum(encoded);
  for (const part of codec.makeParts(encoded, 100)) await r.scriptEvent('hotschem:stream', part);
  assert.equal(r.p.hasTag(`hs_ready_${id}`), false);
  assert.equal(r.p.hasTag(`hs_error_${id}`), true);
  assert.equal(r.index().length, 0);
  assert.equal(r.worldIds().length, 0);
});
