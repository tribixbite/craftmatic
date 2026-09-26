import { describe, expect, it } from 'vitest';
import { MINIFIG_WAND_API_GLOBAL, minifigWandScript } from '../web/src/engine/bedrock-minifig-wand.js';

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
  colours: [[4, 'Red', 'textures/entity/craftmatic_swatch_4'], [14, 'Yellow', 'textures/entity/craftmatic_swatch_14']] as [number, string, string][],
  firstTranslucentColour: 2,
  defaults: {
    minifig: { ...Object.fromEntries(slotNames.flatMap((slot) => [[`craftmatic:${slot}`, 0], [`craftmatic:c_${slot}`, 0]])), 'craftmatic:pose': 0 },
    minidoll: {},
  },
  presets: [], worldCap: 2, savedCap: 2, pageSize: 8,
  poses: [['Standing', false], ['Waving', false], ['Sitting', true]] as [string, boolean][],
};

type Response = { canceled?: boolean; selection?: number; formValues?: unknown[]; cancelationReason?: string };
interface Form { kind: string; title: string; body: string; buttons: string[]; icons: Array<string | undefined>; fields: any[] }
/** A scripted answer: a fixed response, or one computed from the form on screen (pick a button by its label). */
type Answer = Response | ((form: Form) => Response);

/** Answer the form by pressing the first button whose label starts with `label` (the current choice may carry a "> " mark). */
const pick = (label: string): Answer => (form) => {
  const index = form.buttons.findIndex((b) => b.replace(/^> /, '').startsWith(label));
  if (index < 0) throw new Error(`no "${label}" button on "${form.title}": ${form.buttons.join(' | ')}`);
  return { selection: index };
};
const close: Answer = { canceled: true };
const values = (...formValues: unknown[]): Answer => ({ formValues });

function host(answers: Answer[] = [], runtimeConfig: any = config, opts: { deferProperties?: boolean } = {}) {
  /** Bedrock applies `setProperty` at the end of the tick: queued here until the next timeout. */
  const pending: Array<() => void> = [];
  let nextId = 1;
  const entities = new Map<string, any>();
  const forms: Form[] = [];
  const messages: string[] = [];
  const subscribers = { itemUse: [] as Function[], leave: [] as Function[], interact: [] as Function[], spawn: [] as Function[], load: [] as Function[] };
  const intervals: Function[] = [];
  const solid = new Set<string>();
  class Entity {
    id = `entity-${nextId++}`;
    typeId = runtimeConfig.figureType;
    properties = new Map<string, unknown>();
    dynamic = new Map<string, unknown>();
    removed = false;
    events: string[] = [];
    nameTag = '';
    rotation = { x: 0, y: 0 };
    location: any;
    dimension: any;
    components: Record<string, any> = {};
    constructor(dimension: any, location: any, typeId?: string) { this.dimension = dimension; this.location = { ...location }; if (typeId) this.typeId = typeId; entities.set(this.id, this); }
    getProperty(key: string) { return this.properties.get(key); }
    setProperty(key: string, value: unknown) { if (opts.deferProperties) pending.push(() => this.properties.set(key, value)); else this.properties.set(key, value); }
    getDynamicProperty(key: string) { return this.dynamic.get(key); }
    setDynamicProperty(key: string, value: unknown) { if (value === undefined) this.dynamic.delete(key); else this.dynamic.set(key, value); }
    triggerEvent(name: string) { this.events.push(name); }
    teleport(at: any) { this.location = { ...at }; }
    getRotation() { return { ...this.rotation }; }
    setRotation(r: any) { this.rotation = { ...r }; }
    getComponent(name: string) { return this.components[name]; }
    remove() { this.removed = true; entities.delete(this.id); }
  }
  const dimensions: Record<string, any> = Object.fromEntries(['overworld', 'nether', 'the_end'].map((id) => [id, {
    id,
    spawnEntity(type: string, at: any) { return new Entity(dimensions[id], at, type); },
    getEntities({ type }: any) { return [...entities.values()].filter((e) => !e.removed && e.dimension.id === id && e.typeId === type); },
    getBlock({ x, y, z }: any) { const k = `${x},${y},${z}`; return { isAir: !solid.has(k), isLiquid: false }; },
  }]));
  const dynamic = new Map<string, unknown>();
  const player: any = {
    id: 'player-1', typeId: 'minecraft:player', location: { x: 0.5, y: 64, z: 0.5 }, dimension: dimensions.overworld,
    isSneaking: false, selectedSlotIndex: 0, heldItem: undefined, rotation: { x: 0, y: 0 }, inView: [] as any[],
    sendMessage(value: unknown) { messages.push(String(value)); },
    getDynamicProperty(key: string) { return dynamic.get(key); },
    setDynamicProperty(key: string, value: unknown) { dynamic.set(key, value); },
    getRotation() { return { ...player.rotation }; },
    getBlockFromViewDirection() { return { block: { location: { x: 8, y: 70, z: 9 } }, face: 'Up' }; },
    getEntitiesFromViewDirection() { return player.inView.map((entity: any) => ({ entity, distance: 3 })); },
    getComponent() { return { container: { getItem: () => player.heldItem } }; },
  };
  class FormBase {
    form: Form;
    constructor(kind: string) { this.form = { kind, title: '', body: '', buttons: [], icons: [], fields: [] }; forms.push(this.form); }
    title(text: string) { this.form.title = text; return this; }
    body(text: string) { this.form.body = text; return this; }
    button(label: string, icon?: string) { this.form.buttons.push(label); this.form.icons.push(icon); return this; }
    button1(label: string) { this.form.buttons[0] = label; return this; }
    button2(label: string) { this.form.buttons[1] = label; return this; }
    textField(...args: any[]) { this.form.fields.push(args); return this; }
    submitButton() { return this; }
    async show() {
      const answer = answers.shift() ?? close;
      return typeof answer === 'function' ? answer(this.form) : answer;
    }
  }
  class ActionFormData extends FormBase { constructor() { super('action'); } }
  class ModalFormData extends FormBase { constructor() { super('modal'); } }
  class MessageFormData extends FormBase { constructor() { super('message'); } }
  const world: any = {
    afterEvents: {
      itemUse: { subscribe: (fn: Function) => subscribers.itemUse.push(fn) },
      playerLeave: { subscribe: (fn: Function) => subscribers.leave.push(fn) },
      playerSpawn: { subscribe: (fn: Function) => subscribers.spawn.push(fn) },
      entityLoad: { subscribe: (fn: Function) => subscribers.load.push(fn) },
    },
    beforeEvents: { playerInteractWithEntity: { subscribe: (fn: Function) => subscribers.interact.push(fn) } },
    getEntity: (id: string) => entities.get(id), getDimension: (id: string) => dimensions[id], getAllPlayers: () => [player],
  };
  const system: any = {
    currentTick: 0,
    run(fn: Function) { fn(); }, runTimeout(fn: Function) { for (const apply of pending.splice(0)) apply(); fn(); },
    runInterval(fn: Function) { intervals.push(fn); },
  };
  const source = minifigWandScript(runtimeConfig).replace(/^import .*;\n/gm, '');
  const reload = () => new Function('world', 'system', 'ActionFormData', 'ModalFormData', 'MessageFormData', 'FormCancelationReason', source)(
    world, system, ActionFormData, ModalFormData, MessageFormData, { UserBusy: 'UserBusy' },
  );
  reload();
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const use = async (sneaking = false) => {
    player.isSneaking = sneaking;
    subscribers.itemUse[0]!({ source: player, itemStack: { typeId: runtimeConfig.itemId } });
    await flush();
  };
  const interact = async (target: any) => {
    const event: any = { itemStack: { typeId: runtimeConfig.itemId }, player, target, cancel: false };
    subscribers.interact[0]!(event);
    await flush();
    return event;
  };
  const figures = () => [...entities.values()].filter((e) => e.typeId === runtimeConfig.figureType);
  const api = () => (globalThis as any)[MINIFIG_WAND_API_GLOBAL];
  return { dimensions, entities, forms, intervals, messages, player, subscribers, use, interact, flush, reload, figures, solid, system, api, Entity };
}

describe('Bedrock minifig wand behavior host', () => {
  it('serialises without references outside itself', () => {
    const js = minifigWandScript(config as any);
    expect(js).toContain('import { ActionFormData, ModalFormData, MessageFormData, FormCancelationReason } from "@minecraft/server-ui"');
    expect(js).not.toMatch(/__name|import_|require\(/);
  });

  it('restores interrupted edits on reload (keeping how they live) while deleting only disposable drafts', () => {
    const h = host();
    const edited = h.dimensions.overworld.spawnEntity(config.figureType, { x: 3, y: 64, z: 3 });
    edited.setProperty('craftmatic:draft', true);
    edited.setDynamicProperty('craftmatic:editing_placed', true);
    edited.setProperty('craftmatic:torso', 1);
    const statue = h.dimensions.overworld.spawnEntity(config.figureType, { x: 6, y: 64, z: 6 });
    statue.setProperty('craftmatic:draft', true);
    statue.setDynamicProperty('craftmatic:editing_placed', true);
    statue.setDynamicProperty('craftmatic:mf_mode', 'stay');
    const disposable = h.dimensions.nether.spawnEntity(config.figureType, { x: 0, y: 64, z: 0 });
    disposable.setProperty('craftmatic:draft', true);
    h.reload();
    expect(h.entities.has(edited.id)).toBe(true);
    expect(edited.getProperty('craftmatic:draft')).toBe(false);
    expect(edited.getProperty('craftmatic:torso')).toBe(1);
    expect(edited.getDynamicProperty('craftmatic:editing_placed')).toBeUndefined();
    expect(edited.events).toEqual(['craftmatic:release']);
    // A figure that was told to stand still keeps standing still (the walker's `seated` home).
    expect(JSON.parse(statue.getDynamicProperty('craftmatic:fig')).mode).toBe('seated');
    expect(h.entities.has(disposable.id)).toBe(false);
  });

  it('sweeps a leaked draft when its chunk loads after the script started, but not a live one', async () => {
    const h = host([close]);
    await h.use();
    const [live] = h.figures();
    const leaked = h.dimensions.overworld.spawnEntity(config.figureType, { x: 9, y: 64, z: 9 });
    leaked.setProperty('craftmatic:draft', true);
    const edited = h.dimensions.overworld.spawnEntity(config.figureType, { x: 7, y: 64, z: 7 });
    edited.setProperty('craftmatic:draft', true);
    edited.setDynamicProperty('craftmatic:editing_placed', true);
    for (const e of [live, leaked, edited]) h.subscribers.load[0]!({ entity: e });
    expect(h.entities.has(live.id)).toBe(true);
    expect(h.entities.has(leaked.id)).toBe(false);
    expect(edited.getProperty('craftmatic:draft')).toBe(false);
  });

  it('shows the draft ahead and to the right of the view, facing the player, never at the feet', async () => {
    const h = host([close]);
    await h.use();
    const [draft] = h.figures();
    // Yaw 0 looks along +z; the player's right is -x (Minecraft: east is on the left facing south).
    expect(draft.location.z - h.player.location.z).toBeCloseTo(3.2);
    expect(draft.location.x - h.player.location.x).toBeCloseTo(-3.2);
    const toPlayer = Math.atan2(-(h.player.location.x - draft.location.x), h.player.location.z - draft.location.z) * 180 / Math.PI;
    expect(draft.rotation.y).toBeCloseTo(toPlayer);
  });

  it('falls back to a nearer spot when the preferred one is walled in', async () => {
    const h = host([close]);
    h.solid.add('-3,64,3'); // the block 3.2 ahead / 3.2 right of (0.5, 64, 0.5)
    await h.use();
    const [draft] = h.figures();
    expect(Math.hypot(draft.location.x - h.player.location.x, draft.location.z - h.player.location.z)).toBeGreaterThan(1);
    expect(`${Math.floor(draft.location.x)},${Math.floor(draft.location.y)},${Math.floor(draft.location.z)}`).not.toBe('-3,64,3');
  });

  it('keeps the main menu to five buttons a phone shows unscrolled, with plain glyphs and no bare percent', async () => {
    const h = host([close]);
    await h.use();
    const main = h.forms[0]!;
    expect(main.buttons.slice(0, 4)).toEqual(['Parts and colours', 'Pose: Standing', 'Place', 'My figures']);
    for (const form of h.forms) for (const text of [form.title, form.body, ...form.buttons]) expect(text).not.toMatch(/[%…›‹]/);
  });

  it.each(['mf1|m|to=973pbs:14', 'mf1|m|to=973pbs:14|n=One|n=Two', `mf1|m|to=973pbs:14|n=${'x'.repeat(25)}`])('rejects invalid name fields atomically: %s', async (code) => {
    const h = host([pick('Name and figure code'), values('Wanted', code), close, close]);
    await h.use();
    const [draft] = h.figures();
    expect(draft.getProperty('craftmatic:torso')).toBe(0);
    expect(draft.getProperty('craftmatic:c_torso')).toBe(0);
    expect(h.messages.some((message) => /name/i.test(message))).toBe(true);
  });

  it('names colours, shows their swatches, and writes LDraw colour ids into codes', async () => {
    const h = host([
      pick('Parts and colours'), pick('Torso'), pick('Colour'), pick('Yellow'), close, close, close,
    ]);
    await h.use();
    const colourForm = h.forms.find((f) => f.title === 'Torso colour')!;
    expect(colourForm.buttons).toEqual(['> Red', 'Yellow', 'Back']);
    expect(colourForm.icons.slice(0, 2)).toEqual(['textures/entity/craftmatic_swatch_4', 'textures/entity/craftmatic_swatch_14']);
    expect(h.api().code(h.player)).toContain('to=973:14');
  });

  it('builds the next screen after the edit has landed (properties apply at the end of the tick)', async () => {
    const h = host([pick('Parts and colours'), pick('Torso'), pick('Printed torso'), close, close, close], config, { deferProperties: true });
    await h.use();
    const after = h.forms.filter((f) => f.title === 'Torso')[1]!;
    expect(after.body).toContain('Now: Printed torso');
    expect(after.buttons).toContain('> Printed torso');
  });

  it('maps later part and colour pages back to absolute property indices', async () => {
    const paged = structuredClone(config) as any;
    paged.library.minifig.torso = Array.from({ length: 10 }, (_, i) => [`973p${i}`, `Torso ${i}`, 'Core']);
    paged.colours = Array.from({ length: 14 }, (_, i) => [i + 100, `Colour ${i}`]);
    const h = host([
      pick('Parts and colours'), pick('Torso'), pick('Next page'), pick('Torso 9'),
      pick('Colour'), pick('Next page'), pick('Colour 13'), close, close, close,
    ], paged);
    await h.use();
    const [draft] = h.figures();
    expect(draft.getProperty('craftmatic:torso')).toBe(9);
    expect(draft.getProperty('craftmatic:c_torso')).toBe(13);
  });

  it('rejects an invalid code without partially mutating the draft', async () => {
    const bad = 'mf1|m|to=973pbs:14|he=missing:4|n=Bad';
    const h = host([pick('Name and figure code'), values('Wanted', bad), close, close]);
    await h.use();
    const [draft] = h.figures();
    expect(draft.getProperty('craftmatic:torso')).toBe(0);
    expect(draft.getProperty('craftmatic:c_torso')).toBe(0);
    expect(h.messages.some((m) => m.includes('missing is not in this pack library'))).toBe(true);
  });

  it('saves the renamed figure with the new name encoded in its code, and says so', async () => {
    const h = host([pick('My figures'), pick('Save this figure'), values('New Knight'), close]);
    await h.use();
    const saved = JSON.parse(String(h.player.getDynamicProperty('craftmatic:creator:saved')));
    expect(saved).toEqual([expect.objectContaining({ n: 'New Knight' })]);
    expect(saved[0].c).toContain('|n=New Knight');
    expect(h.forms.at(-1)!.body).toContain('Saved New Knight.');
  });

  it('reports corrupt saved data and refuses to exceed the dynamic-property limit', async () => {
    const corrupt = host([pick('My figures'), close, close]);
    corrupt.player.setDynamicProperty('craftmatic:creator:saved', '{not-json');
    await corrupt.use();
    expect(corrupt.messages).toContain('Saved figure data was corrupt; it was ignored.');

    const roomy = { ...config, savedCap: 1000 };
    const full = host([pick('My figures'), pick('Save this figure'), values('Overflow'), close], roomy);
    const original = JSON.stringify([{ n: 'large', c: 'x'.repeat(32_700) }]);
    full.player.setDynamicProperty('craftmatic:creator:saved', original);
    await full.use();
    expect(full.messages).toContain('Saved figure storage is full - delete one.');
    expect(full.player.getDynamicProperty('craftmatic:creator:saved')).toBe(original);
  });

  it('quick-places an owned walking copy at the aim point and applies a cross-dimension cap', async () => {
    const h = host([close]);
    await h.use(); // creates a draft
    await h.use(true);
    const placed = h.figures().find((e) => !e.getProperty('craftmatic:draft'));
    expect(placed.location).toEqual({ x: 8.5, y: 71, z: 9.5 });
    expect(placed.getDynamicProperty('craftmatic:owner')).toBe('player-1');
    expect(placed.getDynamicProperty('craftmatic:mf_mode')).toBe('walk');
    h.dimensions.nether.spawnEntity(config.figureType, { x: 0, y: 1, z: 0 }).setProperty('craftmatic:draft', false);
    await h.use(true);
    expect(h.messages).toContain('Figure cap reached (2).');
  });

  it('places a figure that walks or stands still, and a sitting pose never walks', async () => {
    const walker = host([pick('Place'), pick('Place it where it stands'), pick('Walk around')]);
    await walker.use();
    const [w] = walker.figures();
    expect(w.getProperty('craftmatic:draft')).toBe(false);
    expect(w.events).toContain('craftmatic:release');
    expect(w.getDynamicProperty('craftmatic:fig')).toBeUndefined();

    const statue = host([pick('Place'), pick('Place it where it stands'), pick('Stand still')]);
    await statue.use();
    const [s] = statue.figures();
    expect(s.getDynamicProperty('craftmatic:mf_mode')).toBe('stay');
    expect(JSON.parse(s.getDynamicProperty('craftmatic:fig'))).toMatchObject({ mode: 'seated', home: [s.location.x, s.location.y, s.location.z] });

    const sitter = host([pick('Pose'), pick('Sitting'), pick('Place'), pick('Place it where it stands'), pick('Walk around')]);
    await sitter.use();
    const [sat] = sitter.figures();
    expect(sat.getProperty('craftmatic:pose')).toBe(2);
    expect(sat.getDynamicProperty('craftmatic:mf_mode')).toBe('stay');
  });

  it('returns to the Place screen when there is no block in view to place on', async () => {
    const h = host([pick('Place'), pick('Place it where I look'), pick('Stand still'), close, close]);
    h.player.getBlockFromViewDirection = () => undefined;
    await h.use();
    expect(h.messages).toContain('Look at a block within 96 blocks.');
    expect(h.forms.map((f) => f.title).slice(-3)).toEqual(['Put it where you look', 'Place', 'Minifig Creator']);
    expect(h.figures()[0].getProperty('craftmatic:draft')).toBe(true);
  });

  it('sits the figure on a free seat in view, with its home on the seat', async () => {
    const h = host([pick('Place'), pick('Sit on the seat')]);
    const seat = new h.Entity(h.dimensions.overworld, { x: 4, y: 64, z: 4 }, 'craftmatic:set_seat');
    const riders: any[] = [];
    seat.components['minecraft:rideable'] = { seatCount: 1, getRiders: () => riders, addRider: (e: any) => { riders.push(e); return true; } };
    h.player.inView = [seat];
    await h.use();
    const fig = h.figures()[0];
    expect(riders).toEqual([fig]);
    expect(fig.getDynamicProperty('craftmatic:mf_mode')).toBe('seat');
    expect(JSON.parse(fig.getDynamicProperty('craftmatic:fig')).home).toEqual([4, 64, 4]);
  });

  it('finds the seat nearest the view direction when the view ray misses it (touch has no crosshair)', async () => {
    const h = host([pick('Place'), pick('Sit on the seat')]);
    const make = (at: any) => {
      const seat = new h.Entity(h.dimensions.overworld, at, 'craftmatic:set_seat');
      const riders: any[] = [];
      seat.components['minecraft:rideable'] = { seatCount: 1, getRiders: () => riders, addRider: (e: any) => { riders.push(e); return true; } };
      return { seat, riders };
    };
    const ahead = make({ x: 0.5, y: 64, z: 4.5 });   // 10 degrees below the view, straight ahead
    const aside = make({ x: 5.5, y: 64, z: 1.5 });   // well off to the side
    h.player.getViewDirection = () => ({ x: 0, y: -0.2, z: 1 });
    h.player.getHeadLocation = () => ({ x: 0.5, y: 65.6, z: 0.5 });
    h.dimensions.overworld.getEntities = ((all: any) => (q: any) => (q?.maxDistance ? [...h.entities.values()] : all(q)))(h.dimensions.overworld.getEntities);
    await h.use();
    expect(ahead.riders).toHaveLength(1);
    expect(aside.riders).toHaveLength(0);
  });

  it('asks before discarding, and Undo brings the draft back as it was', async () => {
    const h = host([
      pick('Parts and colours'), pick('Torso'), pick('Printed torso'), close, close,
      pick('Discard draft'), { selection: 0 },
    ]);
    await h.use();
    expect(h.figures()).toHaveLength(0);
    expect(h.forms.find((f) => f.kind === 'message')!.buttons).toEqual(['Discard it', 'Keep it']);
    expect(h.api().undo(h.player)).toBe('Discard draft');
    const [back] = h.figures();
    expect(back.getProperty('craftmatic:draft')).toBe(true);
    expect(back.getProperty('craftmatic:torso')).toBe(1);
    expect(h.api().state(h.player).draft).toBe(back.id);
    // Undo again: the torso change.
    h.api().undo(h.player);
    expect(back.getProperty('craftmatic:torso')).toBe(0);
  });

  it('undoes a place: the figure is the draft again, where it stood', () => {
    const h = host();
    const api = h.api();
    const draft = api.draft(h.player);
    const spot = { ...draft.location };
    api.place(h.player, 'aim', 'walk');
    expect(draft.location).toEqual({ x: 8.5, y: 71, z: 9.5 });
    expect(draft.getProperty('craftmatic:draft')).toBe(false);
    expect(api.state(h.player).draft).toBeUndefined();
    expect(api.undo(h.player)).toBe('Place Custom Minifig');
    expect(draft.location).toEqual(spot);
    expect(draft.getProperty('craftmatic:draft')).toBe(true);
    expect(draft.events.at(-1)).toBe('craftmatic:npc_off');
    expect(draft.getDynamicProperty('craftmatic:editing_placed')).toBeUndefined();
    expect(api.state(h.player)).toMatchObject({ draft: draft.id, editing: false });
  });

  it('undoes a deleted saved figure', async () => {
    const h = host();
    h.api().save(h.player, 'One');
    h.api().save(h.player, 'Two');
    h.api().deleteSaved(h.player, 0);
    expect(h.api().saved(h.player).map((s: any) => s.n)).toEqual(['Two']);
    h.api().undo(h.player);
    expect(h.api().saved(h.player).map((s: any) => s.n)).toEqual(['One', 'Two']);
  });

  it('player leave removes a draft', async () => {
    const leaving = host([close]);
    await leaving.use();
    expect(leaving.figures()).toHaveLength(1);
    leaving.subscribers.leave[0]!({ playerId: leaving.player.id });
    expect(leaving.figures()).toHaveLength(0);
  });

  it('restores a placed figure after edit-close and refuses a different owner', async () => {
    const h = host([close]);
    const placed = h.dimensions.overworld.spawnEntity(config.figureType, { x: 3, y: 64, z: 3 });
    placed.setProperty('craftmatic:draft', false);
    placed.setDynamicProperty('craftmatic:owner', h.player.id);
    // Its figure-life home (scripts/figures.js) from before the edit.
    placed.setDynamicProperty('craftmatic:fig', '{"home":[0,64,0],"area":[-7,-7,7,7],"ground":63.5,"f":1,"mode":"roam"}');
    const event = await h.interact(placed);
    expect(event.cancel).toBe(true);
    expect(placed.getProperty('craftmatic:draft')).toBe(false);
    expect(placed.events).toEqual(['craftmatic:npc_off', 'craftmatic:release']);
    // Released: the walker re-reads its home where it now stands.
    expect(placed.getDynamicProperty('craftmatic:fig')).toBeUndefined();
    expect(h.forms[0]!.title).toBe('Editing Custom Minifig');

    placed.setDynamicProperty('craftmatic:owner', 'somebody-else');
    await h.interact(placed);
    expect(h.messages).toContain('Only the figure owner can edit this figure.');
    expect(h.forms).toHaveLength(1);
  });

  it('asks before an edit puts the draft away; keeping it changes nothing, editing is undoable', async () => {
    const h = host([close, { selection: 1 }]);
    await h.use(); // a draft exists
    const [draft] = h.figures();
    const placed = h.dimensions.overworld.spawnEntity(config.figureType, { x: 3, y: 64, z: 3 });
    placed.setProperty('craftmatic:draft', false);
    placed.setDynamicProperty('craftmatic:owner', h.player.id);
    await h.interact(placed); // answers "Keep my draft"
    expect(h.forms.at(-1)!.kind).toBe('message');
    expect(h.entities.has(draft.id)).toBe(true);
    expect(placed.getProperty('craftmatic:draft')).toBe(false);

    h.forms.length = 0;
    const edit = host([close, { selection: 0 }, pick('Remove this figure'), { selection: 0 }]);
    await edit.use();
    const [editDraft] = edit.figures();
    const other = edit.dimensions.overworld.spawnEntity(config.figureType, { x: 3, y: 64, z: 3 });
    other.setProperty('craftmatic:draft', false);
    other.setDynamicProperty('craftmatic:owner', edit.player.id);
    other.setDynamicProperty('craftmatic:mf_mode', 'stay');
    other.setProperty('craftmatic:torso', 1);
    await edit.interact(other); // "Edit it", then Remove this figure, confirmed
    expect(edit.entities.has(editDraft.id)).toBe(false);
    expect(edit.entities.has(other.id)).toBe(false);
    expect(edit.api().undo(edit.player)).toBe('Remove Custom Minifig');
    const restored = edit.figures().find((e) => e.getProperty('craftmatic:torso') === 1)!;
    expect(restored.getProperty('craftmatic:draft')).toBe(false);
    expect(restored.getDynamicProperty('craftmatic:mf_mode')).toBe('stay');
    expect(edit.api().undo(edit.player)).toBe('Discard draft');
    expect(edit.figures().filter((e) => e.getProperty('craftmatic:draft'))).toHaveLength(1);
  });

  it('retries UserBusy three times without leaving a draft, and hotbar-opens only on activation transition', async () => {
    const busy = host(Array.from({ length: 4 }, () => ({ canceled: true, cancelationReason: 'UserBusy' })));
    await busy.use();
    expect(busy.messages).toContain('Close the chat or other screen and open the wand again.');
    expect(busy.figures()).toHaveLength(0);

    const hotbar = host([close, close]);
    hotbar.player.heldItem = { typeId: config.itemId };
    hotbar.intervals[0]!(); await hotbar.flush();
    hotbar.intervals[0]!(); await hotbar.flush();
    expect(hotbar.forms).toHaveLength(1);
    hotbar.player.heldItem = undefined; hotbar.intervals[0]!();
    hotbar.player.heldItem = { typeId: config.itemId }; hotbar.intervals[0]!(); await hotbar.flush();
    expect(hotbar.forms).toHaveLength(2);
  });

  it('does not pop the menu for a wand already in hand when the world loads', async () => {
    const h = host([close]);
    h.system.currentTick = 10;
    h.subscribers.spawn[0]!({ player: h.player, initialSpawn: true });
    h.player.heldItem = { typeId: config.itemId };
    h.system.currentTick = 40; h.intervals[0]!(); await h.flush();
    expect(h.forms).toHaveLength(0);
    h.player.heldItem = undefined; h.system.currentTick = 200; h.intervals[0]!();
    h.player.heldItem = { typeId: config.itemId }; h.intervals[0]!(); await h.flush();
    expect(h.forms).toHaveLength(1);
  });

  it('publishes the operations the forms use, for the pack GameTest', async () => {
    const h = host();
    const api = h.api();
    const draft = api.draft(h.player);
    api.setPart(h.player, 'torso', 1);
    api.setColour(h.player, 'torso', 1);
    api.setPose(h.player, 1);
    api.setName(h.player, 'Knight');
    expect(draft.getProperty('craftmatic:torso')).toBe(1);
    expect(draft.getProperty('craftmatic:c_torso')).toBe(1);
    expect(draft.getProperty('craftmatic:pose')).toBe(1);
    expect(draft.nameTag).toBe('Knight');
    expect(api.state(h.player).history).toEqual(['Torso part', 'Torso colour', 'Pose', 'Name']);
    const code = api.code(h.player);
    api.setPart(h.player, 'torso', 0);
    api.applyCode(h.player, code);
    expect(draft.getProperty('craftmatic:torso')).toBe(1);
    expect(() => api.setName(h.player, 'a|b')).toThrow(/Name must be/);
  });
});
