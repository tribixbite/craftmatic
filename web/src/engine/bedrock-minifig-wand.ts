/**
 * Dependency-free Bedrock runtime of the Minifig Creator wand, serialized into
 * the behaviour pack as `scripts/minifig-wand.js` (design:
 * `docs/minifig-creator-wand.md`, device findings: `docs/bedrock-addon-guide.md`
 * "Minifig Creator wand").
 *
 * Every operation a form button performs is a plain function of the player
 * (`draft`, `setPart`, `place`, `undo`, ...). The forms only choose which one
 * to call, and the same functions are published on `globalThis` under
 * `MINIFIG_WAND_API_GLOBAL`, so the pack's GameTest (`gametest-pack.ts`,
 * `creator_wand_<id>`) drives exactly what a tap drives: a simulated player
 * cannot answer a `server-ui` form.
 */
import type { MinifigCreatorConfig } from './minifig-creator-types.js';

/** The `globalThis` key the runtime publishes its operations under (for GameTest). */
export const MINIFIG_WAND_API_GLOBAL = 'craftmaticMinifigWand';

/** Keep every runtime dependency explicit: this function is emitted with toString(). */
function minifigWandRuntime(
  C: any,
  world: any,
  system: any,
  ActionFormData: any,
  ModalFormData: any,
  MessageFormData: any,
  FormCancelationReason: any,
  apiName: string,
): void {
  interface Step { label: string; undo: () => string | void }
  interface PlayerState {
    /** The entity the wand dresses: the player's draft, or a placed figure picked up to edit. */
    draft?: string | undefined;
    /** `draft` is a placed figure being edited (it goes back to its life on Done). */
    editing?: boolean;
    showing?: boolean;
    /** Undo steps, newest last; this session only. */
    history: Step[];
    /** One line of feedback for the next main-menu body ("Loaded Knight."). */
    note?: string | undefined;
    /** `system.currentTick` of the player's first spawn: the hotbar does not auto-open while the world settles. */
    joined?: number;
  }
  const state = new Map<string, PlayerState>();
  const held = new Set<string>();
  const HISTORY = 20;
  const DRAFT = 'craftmatic:draft', POSE = 'craftmatic:pose', OWNER = 'craftmatic:owner';
  const EDITING = 'craftmatic:editing_placed', MODE = 'craftmatic:mf_mode', HOME = 'craftmatic:fig';
  const savedKey = `craftmatic:${C.id}:saved`;
  const slots = C.library.minifig;
  const allSlots = ['head', 'hair', 'torso', 'arms', 'hands', 'hips', 'legs', 'held_right', 'held_left', 'back'];
  const slotNames = allSlots.filter((slot) => Array.isArray(slots[slot]));
  const slotKeys: Record<string, string> = { head: 'he', hair: 'ha', torso: 'to', arms: 'ar', hands: 'hd', hips: 'hi', legs: 'le', held_right: 'hr', held_left: 'hl', back: 'bk' };
  const keySlots = Object.fromEntries(Object.entries(slotKeys).map(([name, key]) => [key, name]));
  const slotLabel: Record<string, string> = { head: 'Head', hair: 'Hair or hat', torso: 'Torso', arms: 'Arms', hands: 'Hands', hips: 'Hips', legs: 'Legs', held_right: 'Right hand', held_left: 'Left hand', back: 'Cape or pack' };
  const poses: Array<[string, boolean]> = C.poses?.length ? C.poses : [['Standing', false]];
  const pageSize = Math.max(1, Number(C.pageSize) || 8);
  const rad = Math.PI / 180;

  // Bedrock's form renderer deletes a bare `%` (bedrockInGameText in playable-addon.ts).
  const say = (text: unknown): string => String(text).replace(/\s*%/g, ' percent');
  const tell = (p: any, message: unknown) => {
    const text = message instanceof Error ? message.message : message;
    try { p.sendMessage(say(text)); } catch { /* the player left */ }
  };
  const st = (p: any): PlayerState => {
    let value = state.get(p.id);
    if (!value) { value = { history: [] }; state.set(p.id, value); }
    return value;
  };
  /** A figure Undo re-created answers to its old id too, so older undo steps still find it. */
  const aliases = new Map<string, string>();
  const entity = (id?: string): any => {
    if (!id) return undefined;
    for (let hops = 0; aliases.has(id) && hops < 32; hops++) id = aliases.get(id)!;
    try {
      const e = world.getEntity(id);
      return e && e.isValid !== false ? e : undefined;
    } catch { return undefined; }
  };
  const nameOf = (e: any): string => (e && e.nameTag) || 'Custom Minifig';
  const poseOf = (e: any): number => { try { return Number(e.getProperty(POSE) || 0); } catch { return 0; } };
  const modeOf = (e: any): 'walk' | 'stay' | 'seat' => {
    let mode: unknown;
    try { mode = e.getDynamicProperty(MODE); } catch { /* none */ }
    return mode === 'stay' || mode === 'seat' ? mode : 'walk';
  };

  // --- Where the draft stands --------------------------------------------------
  const yawOf = (p: any): number => { try { return Number(p.getRotation().y) || 0; } catch { return 0; } };
  const open2 = (dim: any, x: number, y: number, z: number): boolean => {
    // An unloaded block is not air (CLAUDE.md): only a block the world returns counts as open.
    try {
      const b = dim.getBlock({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) });
      return !!b && (b.isAir || b.isLiquid);
    } catch { return false; }
  };
  /**
   * Where the draft is shown: ahead and to the RIGHT of the view. A phone draws
   * every form over the middle of the screen, and a draft straight ahead (or at
   * the player's feet, where it used to spawn) is hidden behind it: on the Saga
   * the form spans about 35 degrees either side of centre, and 3.2 ahead, 3.2
   * right is 45 degrees (at 2.5/2.5 the figure's feet were below the screen
   * edge). Nearer spots are tried when that one is blocked.
   */
  const previewSpot = (p: any) => {
    const yaw = yawOf(p) * rad;
    const fx = -Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = -Math.sin(yaw);
    const l = p.location;
    for (const [f, r] of [[3.2, 3.2], [2.5, 2.5], [2.5, 1.5], [2, 0], [1.2, 0]] as Array<[number, number]>) {
      const at = { x: l.x + fx * f + rx * r, y: l.y, z: l.z + fz * f + rz * r };
      if (open2(p.dimension, at.x, at.y, at.z) && open2(p.dimension, at.x, at.y + 1, at.z)) return at;
    }
    return { x: l.x, y: l.y, z: l.z };
  };
  const faceToward = (e: any, target: any) => {
    try { const l = e.location; e.setRotation({ x: 0, y: Math.atan2(-(target.x - l.x), target.z - l.z) / rad }); } catch { /* keep its facing */ }
  };
  const bringToView = (p: any, e: any) => {
    const at = previewSpot(p);
    try {
      if (e.dimension?.id !== p.dimension?.id) e.teleport(at, { dimension: p.dimension }); else e.teleport(at);
    } catch { /* it stays where it is */ }
    faceToward(e, p.location);
  };

  // --- The figure being dressed --------------------------------------------------
  const snapshot = (e: any) => ({
    props: [
      ...slotNames.flatMap((slot) => [[`craftmatic:${slot}`, e.getProperty(`craftmatic:${slot}`)], [`craftmatic:c_${slot}`, e.getProperty(`craftmatic:c_${slot}`)]]),
      [POSE, poseOf(e)],
    ] as Array<[string, unknown]>,
    name: e.nameTag || '',
  });
  const restore = (e: any, snap: ReturnType<typeof snapshot>) => {
    for (const [key, value] of snap.props) if (value !== undefined) e.setProperty(key, value);
    e.nameTag = snap.name;
  };
  /**
   * The player's draft (spawned on demand), or the placed figure they are
   * editing. `show` brings a draft beside the view (only when the wand
   * OPENS: an edit must not move it under the player's eyes).
   */
  const ensureDraft = (p: any, show = false): any => {
    const s = st(p);
    const existing = entity(s.draft);
    if (existing) { if (show && !s.editing) bringToView(p, existing); return existing; }
    s.draft = undefined; s.editing = false;
    const draft = p.dimension.spawnEntity(C.figureType, previewSpot(p));
    draft.setProperty(DRAFT, true);
    draft.setDynamicProperty(OWNER, p.id);
    for (const [name, value] of Object.entries(C.defaults.minifig)) draft.setProperty(name, value);
    faceToward(draft, p.location);
    s.draft = draft.id;
    return draft;
  };
  const figureOf = (p: any): any => ensureDraft(p);

  // --- Undo -----------------------------------------------------------------------
  const remember = (p: any, label: string, undo: () => string | void) => {
    const s = st(p);
    s.history.push({ label, undo });
    if (s.history.length > HISTORY) s.history.shift();
  };
  /** Record how a figure looks now, so Undo can put the look back. */
  const rememberLook = (p: any, e: any, label: string) => {
    const id = e.id, snap = snapshot(e);
    remember(p, label, () => {
      const target = entity(id);
      if (!target) return 'That figure is gone.';
      restore(target, snap);
      return undefined;
    });
  };
  const undo = (p: any): string | undefined => {
    const last = st(p).history.pop();
    if (!last) { tell(p, 'Nothing to undo.'); return undefined; }
    let problem: string | void;
    try { problem = last.undo(); } catch (error) { problem = String(error); }
    if (problem) tell(p, problem);
    st(p).note = problem ? `Could not undo ${last.label}.` : `Undone: ${last.label}.`;
    return last.label;
  };

  // --- Edits (each one undoable) ----------------------------------------------------
  const setPart = (p: any, slot: string, index: number) => {
    const e = figureOf(p);
    rememberLook(p, e, `${slotLabel[slot] || slot} part`);
    e.setProperty(`craftmatic:${slot}`, index);
  };
  const setColour = (p: any, slot: string, index: number) => {
    const e = figureOf(p);
    rememberLook(p, e, `${slotLabel[slot] || slot} colour`);
    e.setProperty(`craftmatic:c_${slot}`, index);
  };
  const setPose = (p: any, index: number) => {
    const e = figureOf(p);
    rememberLook(p, e, 'Pose');
    e.setProperty(POSE, index);
  };
  const checkName = (name: string) => {
    if (!name || name.length > 24 || /[\r\n|]/.test(name)) throw new Error('Name must be 1-24 characters without | or line breaks.');
  };
  const setName = (p: any, name: string) => {
    name = String(name).trim();
    checkName(name);
    const e = figureOf(p);
    rememberLook(p, e, 'Name');
    e.nameTag = name;
  };

  // --- Portable figure codes (LDraw ids, never property indices) ----------------------
  const figureCode = (e: any, name = nameOf(e)) => {
    const fields = ['mf1', 'm'];
    for (const slot of slotNames) {
      const partIndex = Number(e.getProperty(`craftmatic:${slot}`) || 0);
      const colourIndex = Number(e.getProperty(`craftmatic:c_${slot}`) || 0);
      const part = slots[slot]?.[partIndex]?.[0] || '';
      const colourId = C.colours[colourIndex]?.[0];
      if (colourId === undefined) throw new Error(`Colour index ${colourIndex} is not in this pack library.`);
      fields.push(`${slotKeys[slot]}=${part}:${colourId}`);
    }
    fields.push(`n=${String(name).slice(0, 24)}`);
    return fields.join('|');
  };
  const decodeCode = (code: string) => {
    const fields = String(code).trim().split('|');
    if (fields[0] !== 'mf1' || fields[1] !== 'm') throw new Error('That is not a minifig figure code.');
    const values: Array<[string, number, number]> = [];
    const seen = new Set<string>();
    let name: string | undefined;
    for (const field of fields.slice(2)) {
      const equals = field.indexOf('=');
      if (equals < 1) throw new Error('That figure code contains a malformed field.');
      const short = field.slice(0, equals);
      const value = field.slice(equals + 1);
      if (short === 'n') {
        if (name !== undefined || !value.trim() || value.length > 24 || /[\r\n|]/.test(value)) throw new Error('Figure name is missing, duplicated, or invalid.');
        name = value;
        continue;
      }
      const slot = keySlots[short];
      if (!slot || seen.has(slot)) throw new Error(`Unknown or duplicate figure field ${short}.`);
      seen.add(slot);
      const colon = value.lastIndexOf(':');
      if (colon < 0) throw new Error(`Missing colour for ${slot}.`);
      const part = value.slice(0, colon);
      const colourId = Number(value.slice(colon + 1));
      if ((part && !/^[A-Za-z0-9_-]+$/.test(part)) || !/^\d+$/.test(value.slice(colon + 1))) throw new Error(`Invalid ${slot} field.`);
      const partIndex = (slots[slot] || []).findIndex((entry: any[]) => entry[0] === part);
      const colourIndex = C.colours.findIndex((entry: any[]) => entry[0] === colourId);
      if (partIndex < 0) throw new Error(`${part || '(none)'} is not in this pack library.`);
      if (colourIndex < 0) throw new Error(`Colour ${colourId} is not in this pack library.`);
      values.push([slot, partIndex, colourIndex]);
    }
    if (name === undefined) throw new Error('Figure code has no name.');
    return { name, values };
  };
  /** Apply a code to the figure being dressed. Decoded in full first: a bad code changes nothing. */
  const applyCode = (p: any, code: string, name?: string, label = 'Figure code') => {
    const decoded = decodeCode(code);
    if (name !== undefined) { checkName(name); decoded.name = name; }
    const e = figureOf(p);
    rememberLook(p, e, label);
    for (const [slot, partIndex, colourIndex] of decoded.values) {
      e.setProperty(`craftmatic:${slot}`, partIndex);
      e.setProperty(`craftmatic:c_${slot}`, colourIndex);
    }
    e.nameTag = decoded.name;
  };

  // --- Saved figures (a player dynamic property, per pack) ----------------------------
  const readSaved = (p: any): Array<{ n: string; c: string }> => {
    try {
      const raw = String(p.getDynamicProperty(savedKey) || '[]');
      const value = JSON.parse(raw);
      if (!Array.isArray(value)) throw new Error('not an array');
      return value.filter((saved: any) => saved && typeof saved.n === 'string' && typeof saved.c === 'string').slice(0, C.savedCap);
    } catch { tell(p, 'Saved figure data was corrupt; it was ignored.'); return []; }
  };
  const writeSaved = (p: any, all: any[]) => {
    const encoded = JSON.stringify(all);
    if (encoded.length > 32767) { tell(p, 'Saved figure storage is full - delete one.'); return false; }
    try { p.setDynamicProperty(savedKey, encoded); return true; }
    catch { tell(p, 'Saved figure storage could not be updated.'); return false; }
  };
  const save = (p: any, name: string): boolean => {
    name = String(name).trim();
    checkName(name);
    const all = readSaved(p);
    if (all.length >= C.savedCap) { tell(p, 'Library full - delete one.'); return false; }
    const e = figureOf(p);
    if (e.nameTag !== name) { rememberLook(p, e, 'Name'); e.nameTag = name; }
    all.push({ n: name, c: figureCode(e, name) });
    if (!writeSaved(p, all)) return false;
    st(p).note = `Saved ${name}.`;
    return true;
  };
  const load = (p: any, index: number): boolean => {
    const entry = readSaved(p)[index];
    if (!entry) { tell(p, 'No saved figure there.'); return false; }
    applyCode(p, entry.c, undefined, `Load ${entry.n}`);
    st(p).note = `Loaded ${entry.n}.`;
    return true;
  };
  const deleteSaved = (p: any, index: number): boolean => {
    const all = readSaved(p);
    const [entry] = all.splice(index, 1);
    if (!entry || !writeSaved(p, all)) return false;
    remember(p, `Delete ${entry.n}`, () => {
      const now = readSaved(p);
      now.splice(Math.min(index, now.length), 0, entry);
      return writeSaved(p, now) ? undefined : 'Could not put the saved figure back.';
    });
    st(p).note = `Deleted ${entry.n}.`;
    return true;
  };

  // --- A figure's life after the wand -------------------------------------------------
  /**
   * Let a figure go. `walk`: the figure-life walker (scripts/figures.js)
   * adopts it with a roaming home where it stands. `stay` / `seat`: its home
   * is written as the walker's `seated` mode, which the walker never walks,
   * so it holds its place and pose (on a seat, the seat).
   */
  const release = (e: any, mode: 'walk' | 'stay' | 'seat', at?: any) => {
    e.setProperty(DRAFT, false);
    e.setDynamicProperty(EDITING, undefined);
    e.setDynamicProperty(MODE, mode);
    e.triggerEvent('craftmatic:release');
    if (mode === 'walk') { e.setDynamicProperty(HOME, undefined); return; }
    const l = at ?? e.location;
    e.setDynamicProperty(HOME, JSON.stringify({ home: [l.x, l.y, l.z], area: [l.x - 1, l.z - 1, l.x + 1, l.z + 1], ground: l.y - 0.5, f: 1, mode: 'seated' }));
  };
  /** Take a figure back as a draft: it stops walking. A placed one is flagged so a reload restores it. */
  const hold = (e: any, placed: boolean) => {
    // Persist this before `draft`: a script or world reload must restore an
    // edited NPC, not mistake it for a disposable preview.
    e.setDynamicProperty(EDITING, placed ? true : undefined);
    e.setProperty(DRAFT, true);
    e.triggerEvent('craftmatic:npc_off');
  };
  const riderOff = (e: any) => {
    try { const ride = e.getComponent('minecraft:riding')?.entityRidingOn; ride?.getComponent('minecraft:rideable')?.ejectRider(e); } catch { /* not riding */ }
  };
  /** Put a picked-up figure back into its life (Done, closing the wand, leaving). */
  const finish = (p: any) => {
    const s = st(p);
    if (!s.editing) return;
    const e = entity(s.draft);
    s.draft = undefined; s.editing = false;
    if (e) release(e, modeOf(e));
  };
  /** The current draft is replaced (undo of a place or a removal): a draft is removed, an edit finished. */
  const clearCurrent = (p: any, keep: string) => {
    const s = st(p);
    const current = entity(s.draft);
    if (!current || current.id === keep) return;
    if (s.editing) finish(p); else { try { current.remove(); } catch { /* gone */ } s.draft = undefined; }
  };
  const worldCount = () => {
    let count = 0;
    const editingIds = new Set([...state.values()].filter((s) => s.editing && s.draft).map((s) => s.draft));
    for (const id of ['overworld', 'nether', 'the_end']) {
      try { count += [...world.getDimension(id).getEntities({ type: C.figureType })].filter((e: any) => !e.getProperty(DRAFT) || editingIds.has(e.id)).length; } catch { /* no such dimension */ }
    }
    return count;
  };
  const aimTarget = (p: any) => {
    let hit: any;
    try { hit = p.getBlockFromViewDirection?.({ maxDistance: 96, includeLiquidBlocks: false, includePassableBlocks: false }); } catch { return undefined; }
    const b = hit?.block?.location;
    if (!b) return undefined;
    const face = String(hit.face || 'Up');
    const dx = face === 'East' ? 1 : face === 'West' ? -1 : 0;
    const dy = face === 'Up' ? 1 : face === 'Down' ? -1 : 0;
    const dz = face === 'South' ? 1 : face === 'North' ? -1 : 0;
    return { x: b.x + dx + 0.5, y: b.y + dy, z: b.z + dz + 0.5 };
  };
  /** The nearest rideable with a free seat on the player's line of sight (any pack's seat, a boat, a minecart). */
  const seatInView = (p: any, except: any) => {
    let hits: any[] = [];
    try { hits = p.getEntitiesFromViewDirection?.({ maxDistance: 8 }) ?? []; } catch { return undefined; }
    for (const hit of hits) {
      const t = hit?.entity;
      if (!t || t.id === except?.id || t.typeId === C.figureType || t.typeId === 'minecraft:player') continue;
      let ride: any;
      try { ride = t.getComponent('minecraft:rideable'); } catch { continue; }
      if (!ride) continue;
      let riders: any[] = [];
      try { riders = ride.getRiders?.() ?? []; } catch { /* treat as free */ }
      if (riders.length >= (Number(ride.seatCount) || 1)) continue;
      return t;
    }
    return undefined;
  };

  /**
   * Place the figure being dressed. `where`: `here` (it stays where it
   * stands), `aim` (moved to the block the player looks at), `seat` (onto
   * the free seat the player looks at), `copy` (a copy at the aimed block;
   * the draft is kept). `mode` is what it does once let go.
   */
  const place = (p: any, where: 'here' | 'aim' | 'seat' | 'copy', mode: 'walk' | 'stay' = 'walk'): any => {
    const s = st(p);
    const adds = where === 'copy' || !s.editing;
    if (adds && worldCount() >= C.worldCap) { tell(p, `Figure cap reached (${C.worldCap}).`); return undefined; }
    const e = figureOf(p);
    let target: any;
    if (where === 'aim' || where === 'copy') {
      target = aimTarget(p);
      if (!target) { tell(p, 'Look at a block within 96 blocks.'); return undefined; }
    }
    let seat: any;
    if (where === 'seat') {
      seat = seatInView(p, e);
      if (!seat) { tell(p, 'Look at a free seat within 8 blocks.'); return undefined; }
    }
    // A pose that only reads standing still (sitting) never walks.
    const still = poses[poseOf(e)]?.[1];
    const wanted: 'walk' | 'stay' = still ? 'stay' : mode;
    const name = nameOf(e);
    if (where === 'copy') {
      const copy = p.dimension.spawnEntity(C.figureType, target);
      restore(copy, snapshot(e));
      copy.setDynamicProperty(OWNER, p.id);
      try { copy.setRotation(e.getRotation()); } catch { /* default facing */ }
      release(copy, wanted);
      const id = copy.id;
      remember(p, 'Place a copy', () => { try { entity(id)?.remove(); } catch { /* gone */ } });
      s.note = `Placed a copy of ${name}.`;
      return copy;
    }
    const id = e.id, wasEditing = !!s.editing;
    const before = { location: { ...e.location }, mode: modeOf(e) };
    if (target) { try { e.teleport(target); } catch { /* stays */ } }
    s.draft = undefined; s.editing = false;
    e.setDynamicProperty(OWNER, p.id);
    let seated = false;
    if (seat) {
      riderOff(e);
      try { seated = !!seat.getComponent('minecraft:rideable').addRider(e); } catch { seated = false; }
      // Its home is the seat (the rider moves onto it on a later tick).
      if (seated) release(e, 'seat', seat.location);
      else { try { e.teleport(seat.location); } catch { /* beside it */ } release(e, 'stay'); tell(p, 'That seat would not take the figure; it stands beside it.'); }
    } else {
      riderOff(e);
      release(e, wanted);
    }
    remember(p, wasEditing ? `Move ${name}` : `Place ${name}`, () => {
      const t = entity(id);
      if (!t) return 'That figure is gone.';
      clearCurrent(p, id);
      riderOff(t);
      try { t.teleport(before.location); } catch { /* where it is */ }
      hold(t, wasEditing);
      if (wasEditing) t.setDynamicProperty(MODE, before.mode);
      s.draft = id; s.editing = wasEditing;
      return undefined;
    });
    s.note = seat ? (seated ? `${name} sits on the seat.` : `${name} stands by the seat.`)
      : `${name} ${wanted === 'walk' ? 'walks about' : 'stands here'}${still && mode === 'walk' ? ' (a sitting pose stays put)' : ''}.`;
    tell(p, s.note);
    return e;
  };
  /** Remove the figure being dressed: the draft is discarded, an edited figure deleted. Undo brings it back. */
  const remove = (p: any): boolean => {
    const s = st(p);
    const e = entity(s.draft);
    if (!e) { s.draft = undefined; s.editing = false; tell(p, 'Nothing to remove.'); return false; }
    const snap = snapshot(e), at = { ...e.location }, dim = e.dimension, wasEditing = !!s.editing, mode = modeOf(e), name = nameOf(e), oldId = e.id;
    let rotation: any;
    try { rotation = e.getRotation(); } catch { /* default */ }
    try { e.remove(); } catch { /* gone */ }
    s.draft = undefined; s.editing = false;
    remember(p, wasEditing ? `Remove ${name}` : 'Discard draft', () => {
      clearCurrent(p, '');
      const back = dim.spawnEntity(C.figureType, at);
      aliases.set(oldId, back.id);
      restore(back, snap);
      back.setDynamicProperty(OWNER, p.id);
      try { if (rotation) back.setRotation(rotation); } catch { /* default */ }
      if (wasEditing) release(back, mode === 'seat' ? 'stay' : mode);
      else { back.setProperty(DRAFT, true); s.draft = back.id; s.editing = false; }
    });
    s.note = wasEditing ? `Removed ${name}.` : 'Draft discarded.';
    tell(p, s.note);
    return true;
  };
  /** Pick up one of the player's placed figures to edit it in place; the current draft is put away (undoable). */
  const pickUp = (p: any, target: any): boolean => {
    const s = st(p);
    if (s.draft === target.id) return true;
    const owner = target.getDynamicProperty(OWNER);
    if (owner && owner !== p.id) { tell(p, 'Only the figure owner can edit this figure.'); return false; }
    if (s.editing) finish(p);
    else if (entity(s.draft)) remove(p);
    target.setDynamicProperty(OWNER, p.id);
    hold(target, true);
    s.draft = target.id; s.editing = true;
    return true;
  };
  const quickPlace = (p: any) => {
    const s = st(p);
    if (s.showing) return;
    if (!entity(s.draft) || s.editing) { system.run(() => open(p)); return; }
    place(p, 'copy', 'walk');
  };

  // --- Forms ------------------------------------------------------------------------------
  const show = async (p: any, form: any) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: any;
      try { response = await form.show(p); } catch (error) { tell(p, `The wand screen failed: ${error}`); return { canceled: true }; }
      if (!response.canceled || response.cancelationReason !== FormCancelationReason.UserBusy) return response;
      if (attempt < 3) await new Promise<void>((resolve) => system.runTimeout(resolve, 10));
    }
    tell(p, 'Close the chat or other screen and open the wand again.');
    return { canceled: true, busy: true };
  };
  /** An ActionFormData whose buttons carry their own handlers. */
  const menu = (title: string, body: string) => {
    const form = new ActionFormData().title(say(title)).body(say(body));
    const actions: Array<() => any> = [];
    return {
      add(label: string, action: () => any, icon?: string) { if (icon) form.button(say(label), icon); else form.button(say(label)); actions.push(action); },
      async run(p: any, onCancel: () => any) {
        const response = await show(p, form);
        if (response.busy) return 'busy';
        if (response.canceled || response.selection === undefined || !actions[response.selection]) return onCancel();
        return actions[response.selection]!();
      },
    };
  };
  const partName = (e: any, slot: string) => slots[slot]?.[Number(e.getProperty(`craftmatic:${slot}`) || 0)]?.[1] || 'None';
  const colourName = (e: any, slot: string) => C.colours[Number(e.getProperty(`craftmatic:c_${slot}`) || 0)]?.[1] || '';
  /**
   * Run an edit, then the next screen ONE TICK later: Bedrock applies
   * `setProperty` at the end of the tick, so a screen built at once still
   * read the old part ("Now: Plain torso" after choosing the printed one, Saga).
   */
  const guard = async (p: any, action: () => any, then: () => any) => {
    try { action(); } catch (error) { tell(p, error); }
    await new Promise<void>((resolve) => system.runTimeout(resolve, 1));
    return then();
  };

  async function mainMenu(p: any): Promise<unknown> {
    const s = st(p);
    const e = figureOf(p);
    const editing = !!s.editing;
    const name = nameOf(e);
    const note = s.note ? `${s.note}\n` : '';
    s.note = undefined;
    const lastUndo = s.history[s.history.length - 1];
    // The five buttons a phone shows without scrolling come first; X closes.
    const m = menu(editing ? `Editing ${name}` : 'Minifig Creator', editing
      ? `${note}${name} holds still while you edit. Done lets it ${modeOf(e) === 'walk' ? 'walk again' : 'stay where it is'}.`
      : `${note}${name} stands beside you. Close to look at it.`);
    m.add('Parts and colours', () => partsMenu(p));
    m.add(`Pose: ${poses[poseOf(e)]?.[0] ?? 'Standing'}`, () => poseMenu(p));
    m.add(editing ? 'Move or sit' : 'Place', () => placeMenu(p));
    if (editing) m.add('Done', () => finish(p));
    else m.add('My figures', () => savedFigures(p));
    if (lastUndo) m.add(`Undo: ${lastUndo.label}`, () => { undo(p); return mainMenu(p); });
    m.add('Name and figure code', () => identity(p));
    m.add(editing ? 'Remove this figure' : 'Discard draft', () => confirmRemove(p));
    return m.run(p, () => undefined);
  }
  async function partsMenu(p: any): Promise<unknown> {
    const e = figureOf(p);
    const m = menu('Parts and colours', `${nameOf(e)}: choose a part to change it or its colour.`);
    for (const slot of slotNames) {
      // An empty optional slot (no hair, nothing held) has no colour to show.
      const worn = !!slots[slot]?.[Number(e.getProperty(`craftmatic:${slot}`) || 0)]?.[0];
      m.add(`${slotLabel[slot]}: ${partName(e, slot)}${worn ? `, ${colourName(e, slot)}` : ''}`, () => slotMenu(p, slot));
    }
    m.add('Back', () => mainMenu(p));
    return m.run(p, () => mainMenu(p));
  }
  async function slotMenu(p: any, slot: string, page = 0): Promise<unknown> {
    const e = figureOf(p);
    const list = slots[slot] || [];
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    page = Math.max(0, Math.min(page, pages - 1));
    const start = page * pageSize;
    const current = Number(e.getProperty(`craftmatic:${slot}`) || 0);
    const m = menu(slotLabel[slot] || slot, `Now: ${partName(e, slot)}, ${colourName(e, slot)}.${pages > 1 ? ` Page ${page + 1} of ${pages}.` : ''}`);
    const colourIndex = Number(e.getProperty(`craftmatic:c_${slot}`) || 0);
    m.add(`Colour: ${colourName(e, slot)}`, () => colourMenu(p, slot, Math.floor(colourIndex / pageSize)), C.colours[colourIndex]?.[2]);
    list.slice(start, start + pageSize).forEach((entry: any[], k: number) => {
      const index = start + k;
      m.add(`${index === current ? '> ' : ''}${entry[1]}`, () => guard(p, () => setPart(p, slot, index), () => slotMenu(p, slot, page)));
    });
    if (page + 1 < pages) m.add('Next page', () => slotMenu(p, slot, page + 1));
    if (page > 0) m.add('Previous page', () => slotMenu(p, slot, page - 1));
    m.add('Back', () => partsMenu(p));
    return m.run(p, () => partsMenu(p));
  }
  async function colourMenu(p: any, slot: string, page = 0): Promise<unknown> {
    const e = figureOf(p);
    const pages = Math.max(1, Math.ceil(C.colours.length / pageSize));
    page = Math.max(0, Math.min(page, pages - 1));
    const start = page * pageSize;
    const current = Number(e.getProperty(`craftmatic:c_${slot}`) || 0);
    const m = menu(`${slotLabel[slot] || slot} colour`, `Now: ${colourName(e, slot)}. Page ${page + 1} of ${pages}.`);
    C.colours.slice(start, start + pageSize).forEach((entry: any[], k: number) => {
      const index = start + k;
      m.add(`${index === current ? '> ' : ''}${entry[1]}`, () => guard(p, () => setColour(p, slot, index), () => slotMenu(p, slot)), entry[2]);
    });
    if (page + 1 < pages) m.add('Next page', () => colourMenu(p, slot, page + 1));
    if (page > 0) m.add('Previous page', () => colourMenu(p, slot, page - 1));
    m.add('Back', () => slotMenu(p, slot));
    return m.run(p, () => slotMenu(p, slot));
  }
  async function poseMenu(p: any): Promise<unknown> {
    const e = figureOf(p);
    const current = poseOf(e);
    const m = menu('Pose', `${nameOf(e)} is ${String(poses[current]?.[0] ?? 'Standing').toLowerCase()}. A sitting pose stays put when placed.`);
    poses.forEach(([label], index) => m.add(`${index === current ? '> ' : ''}${label}`, () => guard(p, () => { setPose(p, index); st(p).note = `Pose: ${label}.`; }, () => mainMenu(p))));
    m.add('Back', () => mainMenu(p));
    return m.run(p, () => mainMenu(p));
  }
  async function modeMenu(p: any, where: 'here' | 'aim' | 'copy'): Promise<unknown> {
    const m = menu(where === 'copy' ? 'Place a copy' : where === 'aim' ? 'Put it where you look' : 'Place it here', 'What should it do there?');
    m.add('Walk around', () => { place(p, where, 'walk'); return where === 'copy' ? mainMenu(p) : undefined; });
    m.add('Stand still', () => { place(p, where, 'stay'); return where === 'copy' ? mainMenu(p) : undefined; });
    m.add('Back', () => placeMenu(p));
    return m.run(p, () => placeMenu(p));
  }
  async function placeMenu(p: any): Promise<unknown> {
    const s = st(p);
    const editing = !!s.editing;
    const m = menu(editing ? 'Move or sit' : 'Place', `Figures placed: ${worldCount()} of ${C.worldCap}.`);
    m.add(editing ? 'Leave it here' : 'Place it where it stands', () => modeMenu(p, 'here'));
    m.add(editing ? 'Move it where I look' : 'Place it where I look', () => modeMenu(p, 'aim'));
    m.add('Sit on the seat I look at', () => (place(p, 'seat') ? undefined : placeMenu(p)));
    if (!editing) m.add('Place a copy where I look', () => modeMenu(p, 'copy'));
    m.add('Back', () => mainMenu(p));
    return m.run(p, () => mainMenu(p));
  }
  async function confirmRemove(p: any): Promise<unknown> {
    const s = st(p);
    const e = figureOf(p);
    const response = await show(p, new MessageFormData().title(say(s.editing ? 'Remove this figure?' : 'Discard the draft?'))
      .body(say(`${nameOf(e)} is ${s.editing ? 'removed from the world' : 'discarded'}. Undo in the wand menu brings it back.`))
      .button1(say(s.editing ? 'Remove it' : 'Discard it')).button2('Keep it'));
    if (response.busy) return 'busy';
    if (response.canceled || response.selection !== 0) return mainMenu(p);
    remove(p);
    return undefined;
  }
  async function identity(p: any): Promise<unknown> {
    const e = figureOf(p);
    const code = figureCode(e);
    const response = await show(p, new ModalFormData().title(say('Name and figure code'))
      .textField('Name', 'Shown above the figure', { defaultValue: nameOf(e) })
      .textField('Figure code (paste one to load it)', 'mf1|m|...', { defaultValue: code }).submitButton('Apply'));
    if (response.busy) return 'busy';
    if (response.canceled) return mainMenu(p);
    const name = String(response.formValues?.[0] ?? '').trim();
    const typed = String(response.formValues?.[1] ?? '').trim();
    try {
      if (typed && typed !== code) applyCode(p, typed, name, 'Name and figure code');
      else if (name !== nameOf(e)) setName(p, name);
    } catch (error) { tell(p, error); return identity(p); }
    return mainMenu(p);
  }
  async function savedFigures(p: any): Promise<unknown> {
    const e = figureOf(p);
    const all = readSaved(p);
    const m = menu('My figures', `Saved figures: ${all.length} of ${C.savedCap}.`);
    m.add('Save this figure', async () => {
      const answer = await show(p, new ModalFormData().title(say('Save')).textField('Name', 'Figure name', { defaultValue: nameOf(e) }).submitButton('Save'));
      if (answer.busy) return 'busy';
      if (!answer.canceled) { try { save(p, String(answer.formValues?.[0] ?? '')); } catch (error) { tell(p, error); } }
      return mainMenu(p);
    });
    if (all.length) m.add('Load a saved figure', () => pickSaved(p, 'Load'));
    m.add('Show the code in chat', () => { tell(p, figureCode(e)); st(p).note = 'The code is in chat.'; return mainMenu(p); });
    if (all.length) m.add('Delete a saved figure', () => pickSaved(p, 'Delete'));
    m.add('Back', () => mainMenu(p));
    return m.run(p, () => mainMenu(p));
  }
  async function pickSaved(p: any, verb: 'Load' | 'Delete'): Promise<unknown> {
    const all = readSaved(p);
    const m = menu(`${verb} a saved figure`, verb === 'Load' ? 'The figure you are dressing takes its parts and name.' : 'Undo in the wand menu brings it back.');
    all.forEach((saved, index) => m.add(saved.n, () => guard(p, () => (verb === 'Load' ? load(p, index) : deleteSaved(p, index)), () => mainMenu(p))));
    m.add('Back', () => savedFigures(p));
    return m.run(p, () => savedFigures(p));
  }

  const open = async (p: any) => {
    const s = st(p);
    if (s.showing) return;
    s.showing = true;
    const hadDraft = !!entity(s.draft);
    let outcome: unknown;
    try {
      ensureDraft(p, true);
      outcome = await mainMenu(p);
    } catch (error) { tell(p, error); }
    finally {
      s.showing = false;
      // A draft spawned for a menu that never showed (another screen was up) is not left behind.
      if (outcome === 'busy' && !hadDraft && !s.editing) { try { entity(s.draft)?.remove(); } catch { /* gone */ } s.draft = undefined; }
      // Closing the wand while editing puts the figure back into its life.
      finish(p);
    }
  };
  const interact = async (p: any, target: any) => {
    if (target.typeId !== C.figureType) { open(p); return; }
    const s = st(p);
    if (s.showing) { tell(p, 'Close the current wand screen before editing another figure.'); return; }
    if (target.id === s.draft) { open(p); return; }
    const owner = target.getDynamicProperty(OWNER);
    if (owner && owner !== p.id) { tell(p, 'Only the figure owner can edit this figure.'); return; }
    if (entity(s.draft) && !s.editing) {
      // Editing another figure puts the draft away: ask first (it used to vanish silently).
      s.showing = true;
      let response: any;
      try {
        response = await show(p, new MessageFormData().title(say('Edit this figure?'))
          .body(say(`Editing ${nameOf(target)} puts your draft away. Undo in the wand menu brings it back.`))
          .button1('Edit it').button2('Keep my draft'));
      } finally { s.showing = false; }
      if (response.canceled || response.selection !== 0) return;
    }
    if (pickUp(p, target)) await open(p);
  };

  world.afterEvents.itemUse.subscribe((ev: any) => {
    if (ev.itemStack.typeId !== C.itemId) return;
    if (ev.source.isSneaking) system.run(() => quickPlace(ev.source));
    else system.run(() => open(ev.source));
  });
  world.beforeEvents.playerInteractWithEntity.subscribe((ev: any) => {
    if (ev.itemStack?.typeId !== C.itemId) return;
    ev.cancel = true;
    // Before-event callbacks are restricted: forms and entity writes wait one tick.
    system.run(() => { interact(ev.player, ev.target); });
  });
  world.afterEvents.playerSpawn?.subscribe((ev: any) => {
    if (ev.initialSpawn && ev.player) st(ev.player).joined = system.currentTick;
  });
  world.afterEvents.playerLeave.subscribe((ev: any) => {
    const s = state.get(ev.playerId);
    if (s?.editing) {
      const e = entity(s.draft);
      if (e) release(e, modeOf(e));
    } else if (s?.draft) { try { entity(s.draft)?.remove(); } catch { /* gone */ } }
    state.delete(ev.playerId); held.delete(ev.playerId);
  });
  // Sweep leaked drafts after a script or world reload; placed figures are preserved,
  // and one interrupted while being edited goes back to its life.
  // A figure only exists for the script once its chunk loads, and at script
  // start the chunks round the player usually have not: on the Saga a draft
  // left at the player's feet survived the reload sweep and stood there
  // afterwards (2026-09-26). So each figure is also checked as it LOADS; one
  // that is some online player's current draft or edit is left alone.
  const sweep = (e: any) => {
    try {
      if (e?.typeId !== C.figureType || !e.getProperty(DRAFT)) return;
      for (const s of state.values()) if (s.draft === e.id) return;
      if (e.getDynamicProperty(EDITING)) release(e, modeOf(e));
      else e.remove();
    } catch { /* it went away */ }
  };
  system.run(() => {
    for (const id of ['overworld', 'nether', 'the_end']) {
      try { for (const e of world.getDimension(id).getEntities({ type: C.figureType })) sweep(e); } catch { /* no such dimension */ }
    }
  });
  world.afterEvents.entityLoad?.subscribe((ev: any) => sweep(ev.entity));
  system.runInterval(() => {
    const online = new Set<string>();
    for (const p of world.getAllPlayers().filter(Boolean)) {
      online.add(p.id);
      let item: any;
      try { item = p.getComponent('minecraft:inventory')?.container?.getItem(p.selectedSlotIndex); } catch { /* no inventory */ }
      // A seated pinball player taps hotbar slots as flippers (bedrock-pinball.ts): not a wand.
      if (item?.typeId === C.itemId && !p.hasTag?.('craftmatic_pinball')) {
        if (!held.has(p.id)) {
          held.add(p.id);
          // Holding the wand when the world loads does not pop the menu over the loading screens.
          const joined = state.get(p.id)?.joined;
          const settling = joined !== undefined && system.currentTick - joined < 100;
          if (!settling) system.run(() => open(p));
        }
      } else held.delete(p.id);
    }
    for (const id of held) if (!online.has(id)) held.delete(id);
  }, 5);

  const api = {
    draft: (p: any) => ensureDraft(p, true),
    setPart, setColour, setPose, setName, applyCode: (p: any, code: string) => applyCode(p, code),
    code: (p: any) => figureCode(figureOf(p)),
    save, load, deleteSaved, saved: readSaved,
    place, quickPlace, pickUp, finish, remove, undo,
    state: (p: any) => { const s = st(p); return { draft: s.draft, editing: !!s.editing, history: s.history.map((h) => h.label) }; },
  };
  try { (globalThis as any)[apiName] = api; } catch { /* no global object */ }
}

/** Serialize the creator's interactive draft/place/save/edit runtime. */
export function minifigWandScript(config: MinifigCreatorConfig): string {
  return `import { world, system } from "@minecraft/server";\nimport { ActionFormData, ModalFormData, MessageFormData, FormCancelationReason } from "@minecraft/server-ui";\nconst C=${JSON.stringify(config)};\n(${minifigWandRuntime.toString()})(C,world,system,ActionFormData,ModalFormData,MessageFormData,FormCancelationReason,${JSON.stringify(MINIFIG_WAND_API_GLOBAL)});`;
}
