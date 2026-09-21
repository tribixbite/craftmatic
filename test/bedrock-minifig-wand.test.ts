import { describe, expect, it } from 'vitest';
import { minifigWandScript } from '../web/src/engine/bedrock-minifig-wand.js';

const slotNames = ['head', 'hair', 'torso', 'arms', 'hands', 'hips', 'legs', 'held_right', 'held_left', 'back'];
const config = {
  id: 'creator', label: 'Creator', itemId: 'craftmatic:creator_wand', shortAlias: 'mf_creator',
  figureType: 'craftmatic:creator_minifig',
  library: {
    minifig: Object.fromEntries(slotNames.map((slot) => [slot, slot === 'torso'
      ? [['973', 'Torso', 'Core'], ['973pbs', 'Printed torso', 'Core']]
      : [['', 'None', 'Core']]])),
    minidoll: {},
  },
  colours: [[4, 'Red'], [14, 'Yellow']] as [number, string][], firstTranslucentColour: 2,
  defaults: {
    minifig: Object.fromEntries(slotNames.flatMap((slot) => [[`craftmatic:${slot}`, 0], [`craftmatic:c_${slot}`, 0]])),
    minidoll: {},
  },
  presets: [], worldCap: 2, savedCap: 2, pageSize: 8,
};

type Response = { canceled?: boolean; selection?: number; formValues?: unknown[]; cancelationReason?: string };

function host(responses: Response[] = [], runtimeConfig: any = config) {
  let nextId = 1;
  const entities = new Map<string, any>();
  const forms: any[] = [];
  const messages: string[] = [];
  const subscribers = { itemUse: [] as Function[], leave: [] as Function[], interact: [] as Function[] };
  const intervals: Function[] = [];
  class Entity {
    id = `entity-${nextId++}`;
    typeId = runtimeConfig.figureType;
    properties = new Map<string, unknown>();
    dynamic = new Map<string, unknown>();
    removed = false;
    events: string[] = [];
    nameTag = '';
    location: any;
    dimension: any;
    constructor(dimension: any, location: any) { this.dimension = dimension; this.location = { ...location }; entities.set(this.id, this); }
    getProperty(key: string) { return this.properties.get(key); }
    setProperty(key: string, value: unknown) { this.properties.set(key, value); }
    getDynamicProperty(key: string) { return this.dynamic.get(key); }
    setDynamicProperty(key: string, value: unknown) { this.dynamic.set(key, value); }
    triggerEvent(name: string) { this.events.push(name); }
    teleport(at: any) { this.location = { ...at }; }
    remove() { this.removed = true; entities.delete(this.id); }
  }
  const dimensions = Object.fromEntries(['overworld', 'nether', 'the_end'].map((id) => [id, {
    id,
    spawnEntity(_type: string, at: any) { return new Entity(dimensions[id], at); },
    getEntities({ type }: any) { return [...entities.values()].filter((e) => !e.removed && e.dimension.id === id && e.typeId === type); },
  }]));
  const dynamic = new Map<string, unknown>();
  const player: any = {
    id: 'player-1', location: { x: 1, y: 64, z: 2 }, dimension: dimensions.overworld,
    isSneaking: false, selectedSlotIndex: 0, heldItem: undefined,
    sendMessage(value: unknown) { messages.push(String(value)); },
    getDynamicProperty(key: string) { return dynamic.get(key); },
    setDynamicProperty(key: string, value: unknown) { dynamic.set(key, value); },
    getBlockFromViewDirection() { return { block: { location: { x: 8, y: 70, z: 9 } }, face: 'Up' }; },
    getComponent() { return { container: { getItem: () => player.heldItem } }; },
  };
  class Form {
    kind: string; buttons: string[] = []; fields: any[] = [];
    constructor(kind: string) { this.kind = kind; forms.push(this); }
    title() { return this; } body() { return this; }
    button(label: string) { this.buttons.push(label); return this; }
    textField(...args: any[]) { this.fields.push(args); return this; }
    submitButton() { return this; }
    async show() { return responses.shift() || { canceled: true }; }
  }
  class ActionFormData extends Form { constructor() { super('action'); } }
  class ModalFormData extends Form { constructor() { super('modal'); } }
  const world: any = {
    afterEvents: {
      itemUse: { subscribe: (fn: Function) => subscribers.itemUse.push(fn) },
      playerLeave: { subscribe: (fn: Function) => subscribers.leave.push(fn) },
    },
    beforeEvents: { playerInteractWithEntity: { subscribe: (fn: Function) => subscribers.interact.push(fn) } },
    getEntity: (id: string) => entities.get(id), getDimension: (id: string) => dimensions[id], getAllPlayers: () => [player],
  };
  const system = {
    run(fn: Function) { fn(); }, runTimeout(fn: Function) { fn(); },
    runInterval(fn: Function) { intervals.push(fn); },
  };
  const source = minifigWandScript(runtimeConfig).replace(/^import .*;\n/gm, '');
  const reload = () => new Function('world', 'system', 'ActionFormData', 'ModalFormData', 'FormCancelationReason', source)(
    world, system, ActionFormData, ModalFormData, { UserBusy: 'UserBusy' },
  );
  reload();
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const use = async (sneaking = false) => {
    player.isSneaking = sneaking;
    subscribers.itemUse[0]({ source: player, itemStack: { typeId: runtimeConfig.itemId } });
    await flush();
  };
  return { dimensions, entities, forms, intervals, messages, player, subscribers, use, flush, reload };
}

describe('Bedrock minifig wand behavior host', () => {
  it('restores interrupted edits on reload while deleting only disposable drafts', () => {
    const h = host();
    const edited = h.dimensions.overworld.spawnEntity(config.figureType, { x: 3, y: 64, z: 3 });
    edited.setProperty('craftmatic:draft', true);
    edited.setDynamicProperty('craftmatic:editing_placed', true);
    edited.setProperty('craftmatic:torso', 1);
    const disposable = h.dimensions.nether.spawnEntity(config.figureType, { x: 0, y: 64, z: 0 });
    disposable.setProperty('craftmatic:draft', true);
    h.reload();
    expect(h.entities.has(edited.id)).toBe(true);
    expect(edited.getProperty('craftmatic:draft')).toBe(false);
    expect(edited.getProperty('craftmatic:torso')).toBe(1);
    expect(edited.getDynamicProperty('craftmatic:editing_placed')).toBeUndefined();
    expect(edited.events).toEqual(['craftmatic:release']);
    expect(h.entities.has(disposable.id)).toBe(false);
  });

  it.each(['mf1|m|to=973pbs:14', 'mf1|m|to=973pbs:14|n=One|n=Two', `mf1|m|to=973pbs:14|n=${'x'.repeat(25)}`])('rejects invalid name fields atomically: %s', async (code) => {
    const h = host([{ selection: 10 }, { formValues: ['Wanted', code] }, { canceled: true }, { canceled: true }]);
    await h.use();
    const draft = [...h.entities.values()][0];
    expect(draft.getProperty('craftmatic:torso')).toBe(0);
    expect(draft.getProperty('craftmatic:c_torso')).toBe(0);
    expect(h.messages.some(message => /name/i.test(message))).toBe(true);
  });
  it('uses LDraw colour IDs in codes selected through the forms', async () => {
    const h = host([
      { selection: 2 }, { selection: 2 }, { selection: 1 }, { selection: 12 },
      { selection: 2 }, { canceled: true }, { canceled: true },
    ]);
    await h.use();
    expect(h.messages.find((m) => m.startsWith('mf1|'))).toContain('to=973:14');
  });

  it('maps later part and colour pages back to absolute property indices', async () => {
    const paged = structuredClone(config) as any;
    paged.library.minifig.torso = Array.from({ length: 10 }, (_, i) => [`973p${i}`, `Torso ${i}`, 'Core']);
    paged.colours = Array.from({ length: 14 }, (_, i) => [i + 100, `Colour ${i}`]);
    const h = host([
      { selection: 2 }, { selection: 8 }, { selection: 1 },
      { selection: 2 }, { selection: 9 }, { selection: 12 }, { selection: 1 }, { canceled: true },
    ], paged);
    await h.use();
    const draft = [...h.entities.values()][0];
    expect(draft.getProperty('craftmatic:torso')).toBe(9);
    expect(draft.getProperty('craftmatic:c_torso')).toBe(13);
  });

  it('rejects an invalid code without partially mutating the draft', async () => {
    const bad = 'mf1|m|to=973pbs:14|he=missing:4|n=Bad';
    const h = host([{ selection: 10 }, { formValues: ['Wanted', bad] }, { canceled: true }, { canceled: true }]);
    await h.use();
    const draft = [...h.entities.values()][0];
    expect(draft.getProperty('craftmatic:torso')).toBe(0);
    expect(draft.getProperty('craftmatic:c_torso')).toBe(0);
    expect(h.messages.some((m) => m.includes('missing is not in this pack library'))).toBe(true);
  });

  it('saves the renamed figure with the new name encoded in its code', async () => {
    const h = host([{ selection: 12 }, { selection: 0 }, { formValues: ['New Knight'] }, { canceled: true }]);
    await h.use();
    const saved = JSON.parse(String(h.player.getDynamicProperty('craftmatic:creator:saved')));
    expect(saved).toEqual([expect.objectContaining({ n: 'New Knight' })]);
    expect(saved[0].c).toContain('|n=New Knight');
  });

  it('reports corrupt saved data and refuses to exceed the dynamic-property limit', async () => {
    const corrupt = host([{ selection: 12 }, { canceled: true }, { canceled: true }]);
    corrupt.player.setDynamicProperty('craftmatic:creator:saved', '{not-json');
    await corrupt.use();
    expect(corrupt.messages).toContain('Saved figure data was corrupt; it was ignored.');

    const roomy = { ...config, savedCap: 1000 };
    const full = host([{ selection: 12 }, { selection: 0 }, { formValues: ['Overflow'] }, { canceled: true }], roomy);
    const original = JSON.stringify([{ n: 'large', c: 'x'.repeat(32_700) }]);
    full.player.setDynamicProperty('craftmatic:creator:saved', original);
    await full.use();
    expect(full.messages).toContain('Saved figure storage is full — delete one.');
    expect(full.player.getDynamicProperty('craftmatic:creator:saved')).toBe(original);
  });

  it('quick-places an owned copy at the aim point and applies a cross-dimension cap', async () => {
    const h = host([{ canceled: true }]);
    await h.use(); // creates a draft
    await h.use(true);
    const placed = [...h.entities.values()].find((e) => !e.getProperty('craftmatic:draft'));
    expect(placed.location).toEqual({ x: 8.5, y: 71, z: 9.5 });
    expect(placed.getDynamicProperty('craftmatic:owner')).toBe('player-1');
    h.dimensions.nether.spawnEntity(config.figureType, { x: 0, y: 1, z: 0 }).setProperty('craftmatic:draft', false);
    await h.use(true);
    expect(h.messages).toContain('Figure cap reached (2).');
  });

  it('discard and player leave remove drafts without silently replacing them', async () => {
    const discarded = host([{ selection: 13 }]);
    await discarded.use();
    expect([...discarded.entities.values()]).toHaveLength(0);
    expect(discarded.forms).toHaveLength(1);

    const leaving = host([{ canceled: true }]);
    await leaving.use();
    expect([...leaving.entities.values()]).toHaveLength(1);
    leaving.subscribers.leave[0]({ playerId: leaving.player.id });
    expect([...leaving.entities.values()]).toHaveLength(0);
  });

  it('restores a placed figure after edit-close and refuses a different owner', async () => {
    const h = host([{ canceled: true }]);
    const placed = h.dimensions.overworld.spawnEntity(config.figureType, { x: 3, y: 64, z: 3 });
    placed.setProperty('craftmatic:draft', false);
    placed.setDynamicProperty('craftmatic:owner', h.player.id);
    const event: any = { itemStack: { typeId: config.itemId }, player: h.player, target: placed, cancel: false };
    h.subscribers.interact[0](event); await h.flush();
    expect(event.cancel).toBe(true);
    expect(placed.getProperty('craftmatic:draft')).toBe(false);
    expect(placed.events).toEqual(['craftmatic:npc_off', 'craftmatic:release']);

    placed.setDynamicProperty('craftmatic:owner', 'somebody-else');
    h.subscribers.interact[0]({ ...event, cancel: false }); await h.flush();
    expect(h.messages).toContain('Only the figure owner can edit this figure.');
    expect(h.forms).toHaveLength(1);
  });

  it('retries UserBusy three times and hotbar-opens only on activation transition', async () => {
    const busy = host(Array.from({ length: 4 }, () => ({ canceled: true, cancelationReason: 'UserBusy' })));
    await busy.use();
    expect(busy.messages).toContain('Close the chat/other screen and open the wand again.');

    const hotbar = host([{ canceled: true }, { canceled: true }]);
    hotbar.player.heldItem = { typeId: config.itemId };
    hotbar.intervals[0](); await hotbar.flush();
    hotbar.intervals[0](); await hotbar.flush();
    expect(hotbar.forms).toHaveLength(1);
    hotbar.player.heldItem = undefined; hotbar.intervals[0]();
    hotbar.player.heldItem = { typeId: config.itemId }; hotbar.intervals[0](); await hotbar.flush();
    expect(hotbar.forms).toHaveLength(2);
  });
});
