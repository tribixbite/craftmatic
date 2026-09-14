import { test } from 'vitest';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import * as codec from '../bedrock/hotschem/HotSchem_BP/scripts/live-import.js';
import * as geometry from '../bedrock/hotschem/HotSchem_BP/scripts/placement-geometry.js';
import * as plan from '../bedrock/hotschem/HotSchem_BP/scripts/plan.js';

function runtime(properties = new Map(), failWrite = () => false) {
  const events = {}, replies = [], messages = [], models = {}, playerProperties = new Map();
  const event = name => ({ subscribe(fn) { events[name] = fn; } });
  const world = {
    getDynamicProperty: k => properties.get(k),
    setDynamicProperty(k, v) { if (failWrite(k, v)) throw Error('Storage full'); if (v === undefined) properties.delete(k); else properties.set(k, v); },
    getAllPlayers: () => [],
    afterEvents: { worldLoad: event('worldLoad'), playerSpawn: event('playerSpawn'), itemUse: event('itemUse') },
    beforeEvents: { playerInteractWithBlock: event('interact') },
  };
  const system = { currentTick: 1, run: fn => fn(), runJob: gen => { for (const _ of gen) {} }, runInterval() {}, runTimeout() {}, afterEvents: { scriptEventReceive: event('script') } };
  class Form { title() { return this; } body() { return this; } textField() { return this; } button() { return this; } submitButton() { return this; } async show() { return replies.shift() || { canceled: true }; } }
  const p = { id: 'p', dimension: { id: 'minecraft:overworld', heightRange: { min: -64, max: 320 } }, sendMessage: m => messages.push(m.text), getDynamicProperty: k => playerProperties.get(k), setDynamicProperty: (k, v) => playerProperties.set(k, v) };
  const tags = new Set(); Object.assign(p, { typeId: 'minecraft:player', hasTag: k => tags.has(k), addTag: k => tags.add(k), removeTag: k => tags.delete(k), getTags: () => [...tags] });
  const context = vm.createContext({ ...codec, ...geometry, ...plan, world, system, MODELS: models, console: { warn() {} }, ActionFormData: Form, ModalFormData: Form, BlockPermutation: { resolve(name, states) { if (name === 'minecraft:not_real') throw Error('Unsupported block'); return { name, states }; } } });
  const source = fs.readFileSync(new URL('../bedrock/hotschem/HotSchem_BP/scripts/main.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source + '\nglobalThis.api = { pasteImport, state, storeImport, receiveStream };', context);
  return { ...context.api, p, properties, events, replies, messages, models, playerProperties, boot: async () => { events.worldLoad(); await new Promise(resolve => setImmediate(resolve)); } };
}
const model = () => ({ title: 'Import test', w: 8, h: 4, l: 8, palette: [['minecraft:stone', {}]], ops: [[0, 0, 0, 7, 0, 7, 0]] });
test('actual runtime accepts multipart forms, persists and reloads without world block access', async () => {
  const r = runtime(); await r.boot();
  r.playerProperties.set('hotschem:plan', JSON.stringify({ scale: .5, rotation: 90 }));
  const m = model(), encoded = codec.encodeModel(m);
  r.replies.push(...codec.makeParts(encoded, 100).map(part => ({ canceled: false, formValues: [part] })));
  await r.pasteImport(r.p);
  assert.equal(Object.keys(r.models).length, 1);
  assert.equal(r.state(r.p).scale, .5); assert.equal(r.state(r.p).rotation, 90);
  const restarted = runtime(r.properties); await restarted.boot();
  assert.deepEqual(JSON.parse(JSON.stringify(restarted.models)), JSON.parse(JSON.stringify(r.models)));
  assert.ok(r.messages.some(m => m.includes('Saved in this world')));
});
test('runtime refuses unsupported palette and rolls back failed persistence', async () => {
  const r = runtime(); await r.boot(); const m = model(); m.palette[0][0] = 'minecraft:not_real';
  r.replies.push({ canceled: false, formValues: [codec.makeParts(codec.encodeModel(m))[0]] });
  await r.pasteImport(r.p); assert.equal(Object.keys(r.models).length, 0); assert.equal(r.properties.size, 0);
  const broken = runtime(new Map(), k => k === 'hotschem:imports'); await broken.boot();
  assert.throws(() => broken.storeImport('12345678', codec.encodeModel(model())), /Storage full/);
  assert.equal(broken.properties.size, 0);
});
test('stream acknowledges only a persisted model and duplicates do not place or duplicate it', async () => {
  const r = runtime(); await r.boot();
  const encoded = codec.encodeModel(model()), id = codec.checksum(encoded);
  const parts = codec.makeParts(encoded, 100);
  for (const part of parts.slice(0, -1)) await r.receiveStream(r.p, part);
  assert.equal(r.p.hasTag(`hs_ready_${id}`), false);
  await r.receiveStream(r.p, parts.at(-1));
  assert.equal(r.p.hasTag(`hs_ready_${id}`), true);
  for (const part of parts) await r.receiveStream(r.p, part);
  assert.equal(Object.keys(r.models).length, 1);
  const restarted = runtime(r.properties); await restarted.boot();
  assert.equal(Object.keys(restarted.models).length, 1);
});
test('stream failure never publishes readiness when world storage fails', async () => {
  const r = runtime(new Map(), k => k === 'hotschem:imports'); await r.boot();
  const encoded = codec.encodeModel(model()), id = codec.checksum(encoded);
  for (const part of codec.makeParts(encoded, 100)) await r.receiveStream(r.p, part);
  assert.equal(r.p.hasTag(`hs_ready_${id}`), false);
  assert.equal(r.p.hasTag(`hs_error_${id}`), true);
  assert.equal(Object.keys(r.models).length, 0);
  assert.equal(r.properties.size, 0);
});
