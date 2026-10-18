import { describe, expect, it } from 'vitest';
import { MINIFIG_WAND_API_GLOBAL, creatorFigureBehavior, minifigWandScript } from '../web/src/engine/bedrock-minifig-wand.js';
import { ORDER } from '../web/src/sim/core/engine.js';
import { lookAt } from '../web/src/sim/input/touch.js';
import type { FormAnswer, ShownForm } from '../web/src/sim/script-host/ui-module.js';
import { simHost, solidBelow } from './_sim-host.js';

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
interface Form { kind: string; title: string; body: string; buttons: string[]; icons: Array<string | undefined> }

/** A set's seat: rideable by one, with the thin box a set's invisible seat has. */
const SEAT_TYPE = 'craftmatic:set_seat';
const SEAT_DEFINITION = { components: { 'minecraft:rideable': { seat_count: 1, seats: [{ position: [0, 0.1, 0] }] }, 'minecraft:collision_box': { width: 0.2, height: 0.1 } } };
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

/**
 * The SERIALISED wand runtime (`scripts/minifig-wand.js`) on the headless
 * simulator (test/_sim-host.ts): the creator figure declared as the pack
 * declares it (`creatorFigureBehavior`), a player standing on stone at
 * (0.5, 64, 0.5) looking along +z, nether and End loaded by ticking areas, and
 * the forms answered by `answers` in order. A form stays open for one tick
 * before its answer arrives (a thumb is never faster), so a figure the wand
 * spawns is never seated in its own spawn tick (quirk `add-rider-spawn-tick`).
 *
 * What the old fake modelled that stays a fixture here: the block the player
 * looks at (`getBlockFromViewDirection`, a stone block at (8, 70, 9) the
 * view ray itself does not reach from a yaw-0 look), and - for one test -
 * actor properties applied at the END of the tick (`deferProperties`), the
 * device timing that test pins.
 */
function host(answers: Answer[] = [], runtimeConfig: any = config, opts: { deferProperties?: boolean; loadRadius?: number | false } = {}) {
  const forms: Form[] = [];
  /** Answers waiting for their tick: resolved at the start of the next tick. */
  const waiting: Array<() => void> = [];
  const chooser = (shown: ShownForm): Promise<FormAnswer> => {
    const form: Form = { kind: shown.kind, title: shown.title, body: shown.body, buttons: shown.buttons, icons: shown.icons ?? [] };
    forms.push(form);
    const answer = answers.shift() ?? close;
    const r = typeof answer === 'function' ? answer(form) : answer;
    const reply: FormAnswer = r.canceled ? { cancel: true, ...(r.cancelationReason === 'UserBusy' ? { reason: 'UserBusy' as const } : {}) } : r.formValues ? { values: r.formValues } : { button: r.selection ?? 0 };
    return new Promise(resolve => waiting.push(() => resolve(reply)));
  };
  const h = simHost({
    script: minifigWandScript(runtimeConfig), entities: { [runtimeConfig.figureType]: creatorFigureBehavior(runtimeConfig, '1.26.30'), [SEAT_TYPE]: SEAT_DEFINITION },
    terrain: solidBelow(64), chooser, loadRadius: opts.loadRadius ?? 1024,
  });
  // Nether and the End: loaded where the tests put figures (the wand counts its cap across every dimension).
  for (const dim of ['minecraft:nether', 'minecraft:the_end']) h.engine.tickingAreas.set(dim, { name: dim, dimension: dim, x0: -64, z0: -64, x1: 64, z1: 64 });
  h.engine.updateLoaded();
  h.engine.addSystem({ name: 'form-answers', order: ORDER.input, tick: () => { for (const answer of waiting.splice(0)) answer(); } });
  /** Actor property writes queued to the end of the tick (`deferProperties`). */
  const pending: Array<() => void> = [];
  if (opts.deferProperties) h.engine.addSystem({ name: 'end-of-tick-properties', order: ORDER.observers, tick: () => { for (const apply of pending.splice(0)) apply(); } });
  // Every entity's triggered events are listed on `.events` (the assertions the tests make).
  h.engine.on('entitySpawn', ({ entity }) => {
    if (entity.isPlayer) return;
    const e = h.api(entity);
    e.events = [] as string[];
    const trigger = e.triggerEvent;
    e.triggerEvent = (ev: string) => { e.events.push(ev); return trigger(ev); };
    if (opts.deferProperties) { const set = e.setProperty; e.setProperty = (k: string, v: unknown) => { pending.push(() => set(k, v)); }; }
  });
  const sim = h.addPlayer('Player', { x: 0.5, y: 64, z: 0.5 });
  const player = h.api(sim);
  // The block the player looks at: stone at (8, 70, 9), its top face.
  h.setBlock(8, 70, 9, 'minecraft:stone');
  player.getBlockFromViewDirection = () => ({ block: h.dimension().getBlock({ x: 8, y: 70, z: 9 }), face: 'Up' });
  const dimensions = { overworld: h.dimension('overworld'), nether: h.dimension('nether'), the_end: h.dimension('the_end') };
  /** Let the world run until the forms are answered and every wait is over. */
  const flush = async (): Promise<void> => { await h.runAsync(80); };
  const use = async (sneaking = false): Promise<void> => {
    h.controls(sim, { sneak: sneaking });
    h.host.deliver('itemUse', { source: player, itemStack: { typeId: runtimeConfig.itemId } });
    await flush();
  };
  /** A held press on `target` (the cancelable before-event), then the world runs; returns whether the wand cancelled it. */
  const interact = async (target: any): Promise<{ cancel: boolean }> => {
    const cancel = h.host.before('playerInteractWithEntity', { itemStack: { typeId: runtimeConfig.itemId }, player, target });
    await flush();
    return { cancel };
  };
  const figures = (): any[] => [...h.engine.entities.values()].filter(e => e.valid && e.typeId === runtimeConfig.figureType).map(e => h.api(e));
  const api = () => (globalThis as any)[MINIFIG_WAND_API_GLOBAL];
  return {
    h, dimensions, forms, player, sim, use, interact, flush, figures, api,
    /** Whether an entity id is still in the world. */
    entities: { has: (id: string): boolean => h.engine.entities.get(id)?.valid === true },
    /** Every chat line the player was sent. */
    get messages(): string[] { return h.lines('chat'); },
    /** The wand runtime's hotbar poll (its first interval). */
    poll: (): void => h.host.scheduler.intervals()[0]!.fn(),
    /** Put `typeId` in the selected hotbar slot (undefined: an empty hand). */
    hold: (typeId: string | undefined): void => { h.host.playerState(sim).items[player.selectedSlotIndex] = typeId; },
    /** A set's seat (a thin box, as a set's seat is) at `at`. */
    seat: (at: { x: number; y: number; z: number }): any => h.api(h.spawn(SEAT_TYPE, at)),
    /** The world is reopened: the wand's script starts again over the same entities. */
    reload: (): void => { h.reload(); },
  };
}

describe('Bedrock minifig wand behavior host', () => {
  it('serialises without references outside itself', () => {
    const js = minifigWandScript(config as any);
    expect(js).toContain('import { ActionFormData, ModalFormData, MessageFormData, FormCancelationReason } from "@minecraft/server-ui"');
    expect(js).not.toMatch(/__name|import_|require\(/);
  });

  it('restores interrupted edits on reload (keeping how they live) while deleting only disposable drafts', async () => {
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
    await h.flush();
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
    // Two drafts saved by an earlier session lie in chunks nobody has loaded since the script started ...
    const leaked = h.h.api(h.h.spawn(config.figureType, { x: 2009, y: 64, z: 9 }));
    leaked.setProperty('craftmatic:draft', true);
    const edited = h.h.api(h.h.spawn(config.figureType, { x: 2007, y: 64, z: 7 }));
    edited.setProperty('craftmatic:draft', true);
    edited.setDynamicProperty('craftmatic:editing_placed', true);
    h.h.run(1);
    expect(h.h.engine.isEntityLoaded(h.h.simOf(leaked)!)).toBe(false);
    // ... until a ticking area loads them (`entityLoad`); the live draft's own chunk loads again too.
    h.h.engine.tickingAreas.set('far', { name: 'far', dimension: 'minecraft:overworld', x0: 2000, z0: 0, x1: 2015, z1: 15 });
    h.h.host.deliver('entityLoad', { entity: live });
    await h.flush();
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
    expect(draft.getRotation().y).toBeCloseTo(toPlayer);
  });

  it('falls back to a nearer spot when the preferred one is walled in', async () => {
    const h = host([close]);
    h.h.setBlock(-3, 64, 3, 'minecraft:stone'); // the block 3.2 ahead / 3.2 right of (0.5, 64, 0.5)
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
    expect(placed.getDynamicProperty('craftmatic:owner')).toBe(h.player.id);
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
    const seat = h.seat({ x: 4, y: 64, z: 4 });
    lookAt(h.sim, { x: 4, y: 64.05, z: 4 }); // the view ray meets the seat
    await h.use();
    const fig = h.figures()[0];
    expect(seat.getComponent('minecraft:rideable').getRiders().map((r: any) => r.id)).toEqual([fig.id]);
    expect(fig.getDynamicProperty('craftmatic:mf_mode')).toBe('seat');
    expect(JSON.parse(fig.getDynamicProperty('craftmatic:fig')).home).toEqual([4, 64, 4]);
  });

  it('finds the seat nearest the view direction when the view ray misses it (touch has no crosshair)', async () => {
    const h = host([pick('Place'), pick('Sit on the seat')]);
    const make = (at: any) => {
      const seat = h.seat(at);
      return { seat, riders: () => seat.getComponent('minecraft:rideable').getRiders() };
    };
    const ahead = make({ x: 0.5, y: 64, z: 4.5 });   // 10 degrees below the view, straight ahead
    const aside = make({ x: 5.5, y: 64, z: 1.5 });   // well off to the side
    // Looking along (0, -0.2, 1): the ray passes over the thin seat ahead.
    h.sim.rotation = { x: Math.atan2(0.2, 1) * 180 / Math.PI, y: 0 };
    expect(h.player.getEntitiesFromViewDirection({ maxDistance: 8 }).some((hit: any) => hit.entity.id === ahead.seat.id)).toBe(false);
    await h.use();
    expect(ahead.riders()).toHaveLength(1);
    expect(aside.riders()).toHaveLength(0);
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
    leaving.h.host.deliver('playerLeave', { playerId: leaving.player.id });
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
    hotbar.hold(config.itemId);
    hotbar.poll(); await hotbar.flush();
    hotbar.poll(); await hotbar.flush();
    expect(hotbar.forms).toHaveLength(1);
    hotbar.hold(undefined); hotbar.poll();
    hotbar.hold(config.itemId); hotbar.poll(); await hotbar.flush();
    expect(hotbar.forms).toHaveLength(2);
  });

  it('does not pop the menu for a wand already in hand when the world loads', async () => {
    const h = host([close]);
    // The world has run 10 ticks when the player first spawns, holding the wand.
    h.h.engine.tick = 10;
    h.h.host.deliver('playerSpawn', { player: h.player, initialSpawn: true });
    h.hold(config.itemId);
    h.h.engine.tick = 40; h.poll(); await h.flush();
    expect(h.forms).toHaveLength(0);
    h.hold(undefined); h.h.engine.tick = 200; h.poll();
    h.hold(config.itemId); h.poll(); await h.flush();
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
