/**
 * Minimal Bedrock script host for the placement runtime, shared by the wand's
 * size/aim tests and the collider-scale tests. It evaluates the SERIALIZED
 * runtime that ships inside a generated pack, so the tests exercise the code
 * the device runs rather than a TypeScript copy of it.
 */
import { vi } from 'vitest';
import { buildPlacementPackAssets } from '../web/src/engine/bedrock-placement-pack.js';

export function host(spec: Parameters<typeof buildPlacementPackAssets>[0]) {
  const assets = buildPlacementPackAssets(spec);
  const responses: any[] = [];
  const buttons: string[][] = [];
  class Form {
    labels: string[] = [];
    title() { return this; } body() { return this; } button(l: string) { this.labels.push(l); return this; } textField() { return this; }
    async show() { buttons.push(this.labels); return responses.shift() ?? { canceled: true }; }
  }
  const intervals = new Map<number, any>();
  /** `fill`'s documented cap, which `fillBlocks` shares: 32768 blocks per call. */
  const FILL_LIMIT = 32768;
  /** A stand-in for the real class, so an argument that is not one is rejected the way the game rejects it. */
  class BlockVolume {
    constructor(readonly from: { x: number; y: number; z: number }, readonly to: { x: number; y: number; z: number }) {}
  }
  const fills: Array<{ from: any; to: any; block: string; options?: unknown }> = [];
  const spawned: Array<{ typeId: string; at: any; entity: any }> = [];
  const set: Array<{ pos: any; states: any }> = [];
  const commands: string[] = [];
  const actionBars: string[] = [];
  const playerProperties = new Map<string, unknown>();
  const blocks = new Map<string, any>();
  let loaded = false;
  const makeEntity = (id: string, typeId: string) => ({ id, typeId, nameTag: '', dimension: { id: 'overworld' }, events: [] as string[], teleport: vi.fn(), setRotation: vi.fn(), remove: vi.fn(), triggerEvent(ev: string) { this.events.push(ev); }, getComponent: () => undefined });
  const dimension: any = { id: 'overworld', heightRange: { min: -64, max: 320 }, spawnParticle: vi.fn(),
    runCommand: (command: string) => {
      if (command.startsWith('tickingarea remove ')) { loaded = false; return { successCount: 1 }; }
      if (command.startsWith('tickingarea add ')) { loaded = true; return { successCount: 1 }; }
      commands.push(command); return { successCount: 1 };
    },
    // Faithful to @minecraft/server 2.x: `fillBlocks(volume: BlockVolumeBase,
    // block, options?)`. The native binding REJECTS a plain {from, to} object,
    // and the pack's runtime wraps the call in try/catch - a stub that accepts
    // anything hides a clear that never happens (the stale-collider bug).
    fillBlocks: (volume: any, block: string, options?: { blockFilter?: { includeTypes?: string[] } }) => {
      if (!(volume instanceof BlockVolume)) throw new TypeError('Native type conversion failed: expected BlockVolume');
      fills.push({ from: { ...volume.from }, to: { ...volume.to }, block, options });
      const span = (a: number, b: number): number => Math.abs(b - a) + 1;
      const cells = span(volume.from.x, volume.to.x) * span(volume.from.y, volume.to.y) * span(volume.from.z, volume.to.z);
      if (cells > FILL_LIMIT) throw new Error(`The volume of blocks is too large (${cells} > ${FILL_LIMIT})`);
      const include = options?.blockFilter?.includeTypes;
      for (let x = Math.min(volume.from.x, volume.to.x); x <= Math.max(volume.from.x, volume.to.x); x++)
        for (let y = Math.min(volume.from.y, volume.to.y); y <= Math.max(volume.from.y, volume.to.y); y++)
          for (let z = Math.min(volume.from.z, volume.to.z); z <= Math.max(volume.from.z, volume.to.z); z++) {
            const b = blocks.get(`${x},${y},${z}`);
            if (!b || (include && !include.includes(b.typeId))) continue;
            blocks.delete(`${x},${y},${z}`);
          }
    },
    getBlock: (pos: any) => {
      if (!loaded) return undefined;
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (!blocks.has(key)) blocks.set(key, { typeId: 'minecraft:air', permutation: { getState: () => undefined }, setPermutation(perm: any) { this.typeId = perm.id; this.permutation = { getState: (k: string) => perm.states[k] }; set.push({ pos: { ...pos }, states: perm.states }); } });
      return blocks.get(key);
    },
    getEntities: () => [],
    spawnEntity: (typeId: string, at: any) => { const entity = makeEntity(`e${spawned.length + 1}`, typeId); spawned.push({ typeId, at, entity }); return entity; } };
  let use: any;
  let hit: any;
  const player: any = { id: 'player', location: { x: 100, y: 64, z: 200 }, dimension, selectedSlotIndex: 0,
    getBlockFromViewDirection: () => hit,
    getDynamicProperty: (key: string) => playerProperties.get(key),
    setDynamicProperty: (key: string, value: unknown) => playerProperties.set(key, value),
    getComponent: () => undefined, sendMessage: vi.fn(), onScreenDisplay: { setActionBar: (s: string) => actionBars.push(s) } };
  const world = { afterEvents: { itemUse: { subscribe: (fn: any) => { use = fn; } }, playerLeave: { subscribe: vi.fn() } },
    getAllPlayers: () => [player], getDimension: () => dimension,
    getEntity: (id: string) => spawned.find(s => s.entity.id === id)?.entity,
    structureManager: { createFromWorld: vi.fn(), get: () => undefined, place: vi.fn(), delete: vi.fn() } };
  const system = { run: (fn: any) => fn(), runTimeout: (fn: any) => queueMicrotask(fn), runInterval: (fn: any, ticks: number) => { intervals.set(ticks, fn); } };
  const BlockPermutation = { resolve: (id: string, states: any) => ({ id, states }) };
  const source = assets.script.replace(/^import .*;\s*$/gm, '');
  new Function('world', 'system', 'StructureSaveMode', 'BlockPermutation', 'BlockVolume', 'ActionFormData', 'ModalFormData', source)(world, system, { Memory: 'memory' }, BlockPermutation, BlockVolume, Form, Form);
  const flush = async (turns = 400) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };
  const open = async (...r: any[]) => { responses.push(...r); use({ itemStack: { typeId: assets.itemId }, source: player }); await flush(); };
  return { assets, open, flush, intervals, spawned, set, commands, actionBars, player, buttons, playerProperties, setHit: (h: any) => { hit = h; }, blocks, fills };
}
