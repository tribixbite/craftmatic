/**
 * Device-measured facts about Bedrock that no documentation states, each with
 * the evidence it was measured by. The simulator's modules CONSULT this
 * registry (they read their numbers from it and name the quirk they apply),
 * so a fact is written once, next to its proof, and a device round that
 * re-measures it changes one row.
 *
 * `simulated` says what the engine does with a fact:
 *   - `modelled`: the engine behaves this way;
 *   - `partial`: modelled in the common case, with a stated gap;
 *   - `device-only`: the engine cannot show it (rendering, client timing,
 *     touch hardware). A scenario step that depends on it is reported
 *     `device-only`, never passed.
 *
 * Adding a fact: a row here with its evidence (a path under `output/`, a
 * commit, a doc section and the date), then the module that applies it reads
 * `quirk(<id>)`. See docs/sim-engine.md "The quirk registry".
 */

/** The engine module a quirk bears on. */
export type QuirkArea = 'world' | 'entity' | 'physics' | 'script-host' | 'input' | 'render' | 'camera' | 'ui' | 'commands';

export interface Quirk {
  id: QuirkId;
  /** The fact, as a rule the engine can apply. */
  rule: string;
  /** Where it was measured: evidence path, commit or doc section, and the date. */
  evidence: string;
  appliesTo: readonly QuirkArea[];
  simulated: 'modelled' | 'partial' | 'device-only';
  /** The measured numbers the engine uses (units in the key's name or the rule). */
  values?: Readonly<Record<string, number>>;
  /** For `partial`: what is not modelled. */
  gap?: string;
}

export type QuirkId =
  | 'add-rider-spawn-tick' | 'tp-dismounts' | 'rider-eye-above-seat' | 'seat-z-is-nose' | 'sneak-dismounts'
  | 'tap-is-hit' | 'hold-is-interact' | 'no-selection-box-passes-taps' | 'unloaded-block-undefined'
  | 'unloaded-entity-invisible' | 'group-removal-strips-base' | 'float-property-int-literal'
  | 'entity-id-leading-digit' | 'pushable-dropped' | 'form-deletes-percent' | 'hover-controller-speed'
  | 'hover-climb-descend' | 'hover-descend-needs-jump' | 'camera-pitch-limit' | 'camera-roll-animation-only'
  | 'client-entity-lag' | 'rider-yaw-lag' | 'actor-draw-ceiling' | 'cull-by-collision-box' | 'box-uv-sub-unit-faces'
  | 'coplanar-hatching' | 'slow-falling-gravity' | 'fill-volume-limit' | 'structure-load-keeps-states'
  | 'no-dismount-event' | 'dynamic-property-string-limit' | 'simulation-distance' | 'native-mount-bursts';

const QUIRKS: readonly Quirk[] = [
  { id: 'add-rider-spawn-tick', rule: '`Rideable.addRider` can refuse a rider in the tick either entity spawned; a retry a couple of ticks later succeeds.', evidence: 'Pixel 2026-09-29: the orbit companion refused at placement and was seated seconds later by rides.js (TASKS-BEDROCK-ADDON.md "Nimbus follow-ups", `SEAT_RETRIES` in bedrock-placement-pack.ts)', appliesTo: ['entity'], simulated: 'modelled' },
  { id: 'tp-dismounts', rule: 'Teleporting a riding player (`/tp @s ~ ~ ~`, and the script `teleport` of the rider itself) dismounts it; teleporting the RIDDEN entity carries its riders.', evidence: 'Saga 2026-09-29 (TASKS-BEDROCK-ADDON.md "Phones": "/tp @s ~ ~ ~ DISMOUNTS"); rides and coasters carry riders by teleporting the seat (physics spec §4.7)', appliesTo: ['entity', 'commands'], simulated: 'partial', gap: 'the script-API teleport of the rider itself is assumed to behave like /tp (not measured separately)' },
  { id: 'rider-eye-above-seat', rule: 'A riding player\'s eye is 1.12 blocks above its seat position.', evidence: 'CLAUDE.md "A minecraft:rideable seat\'s +Z is the entity\'s NOSE" (measured 2026-09-26); cockpit-seat.ts', appliesTo: ['entity', 'physics'], simulated: 'modelled', values: { eyeAboveSeatBlocks: 1.12 } },
  { id: 'seat-z-is-nose', rule: 'A `minecraft:rideable` seat position is in the entity frame with +Z the nose, turned by the entity yaw.', evidence: 'CLAUDE.md (every compiled seat was mirrored until 2026-09-26)', appliesTo: ['entity'], simulated: 'modelled' },
  { id: 'sneak-dismounts', rule: 'Sneak (the touch sneak button) dismounts a rider from a vanilla rideable; there is no dismount event in @minecraft/server 2.9.', evidence: 'TASKS-BEDROCK-ADDON.md Nimbus ("sneak gets off"; a sneak at ALT 169 dropped the Saga rider 229 blocks), physics spec §4.6', appliesTo: ['entity', 'input'], simulated: 'modelled' },
  { id: 'tap-is-hit', rule: 'A touch TAP on an entity fires `entityHitEntity` (the player hits it); it does not fire the interact.', evidence: 'Pixel round 29c (10788 slide seat: three taps boarded nobody, `/ride` worked); add-on guide "The slide\'s seat could not be boarded by a tap"; pinball measurements', appliesTo: ['input'], simulated: 'partial', values: { reachBlocks: 5 }, gap: 'the pick reach (5 blocks, the creative reach the QA worlds play in) is assumed, not measured on the phones' },
  { id: 'hold-is-interact', rule: 'A press held ~0.5 s fires `playerInteractWithEntity`; a vanilla rideable mounts on it.', evidence: 'add-on guide "The slide\'s seat could not be boarded by a tap" (2026-09-29); CLAUDE.md "A touch tap is entityHitEntity"', appliesTo: ['input', 'entity'], simulated: 'partial', values: { holdTicks: 10, reachBlocks: 5 }, gap: 'the hold time (~0.5 s) is from the pinball rounds; the reach is assumed as for a tap' },
  { id: 'no-selection-box-passes-taps', rule: 'A block whose `minecraft:selection_box` is false is passed by the tap ray (a tap reaches an entity inside a collider); `playerInteractWithBlock` never fires for it.', evidence: 'add-on guide "The slide\'s seat could not be boarded by a tap"; docs/bedrock-interactivity.md "Taps through walls"', appliesTo: ['input', 'world'], simulated: 'modelled' },
  { id: 'unloaded-block-undefined', rule: '`Dimension.getBlock` returns undefined outside the loaded/simulated area; it is not air.', evidence: 'CLAUDE.md "An unloaded block is not air" (Pixel 2026-09-25: an empty car fell 250 blocks)', appliesTo: ['world', 'script-host'], simulated: 'modelled' },
  { id: 'unloaded-entity-invisible', rule: '`world.getEntity` and `getEntities` see only entities in loaded chunks; an entity outside them does not tick.', evidence: 'bedrock-placement-pack.ts undo ("world.getEntity sees only loaded ones"); CLAUDE.md GameTest "Entity being invalid" ~100 blocks out', appliesTo: ['entity', 'script-host'], simulated: 'modelled' },
  { id: 'group-removal-strips-base', rule: 'Removing a component group removes its components from the entity even where the base components declare them.', evidence: 'CLAUDE.md (a size_100 that only removed groups left vehicles unrideable, 2026-09-26)', appliesTo: ['entity'], simulated: 'modelled' },
  { id: 'float-property-int-literal', rule: 'A `float` actor property written with an integer literal (`"default": 0`) is rejected and the entity loses its WHOLE property component: `getProperty` returns undefined and `setProperty` throws.', evidence: 'CLAUDE.md "Bedrock rejects a float actor property written as an integer literal" (2026-09-21, content log)', appliesTo: ['entity'], simulated: 'modelled' },
  { id: 'entity-id-leading-digit', rule: 'An entity identifier whose name begins with a digit is refused; the type never exists and every spawn fails.', evidence: 'CLAUDE.md (`craftmatic:10303_cart`, 2026-09-21)', appliesTo: ['entity'], simulated: 'modelled' },
  { id: 'pushable-dropped', rule: 'Format 1.26.30 dropped `minecraft:pushable`: a definition that declares it fails to parse and the type does not exist.', evidence: 'CLAUDE.md (pinball shipped twice with nothing moving, 2026-09-24)', appliesTo: ['entity'], simulated: 'modelled' },
  { id: 'form-deletes-percent', rule: 'The form renderer deletes a bare `%` from a form\'s text.', evidence: 'CLAUDE.md "Bedrock\'s form renderer deletes a bare %" (Pixel 2026-09-21)', appliesTo: ['ui'], simulated: 'modelled' },
  { id: 'hover-controller-speed', rule: 'The hover mount controller (`free_camera_controlled` + `movement.hover`) cruises at v ≈ 120·flying_speed + 2.3 blocks/s toward the look direction.', evidence: 'Pixel 2026-09-29: 0.09 → 13.1 blocks/s (round 29d), 0.3 → 38.3 blocks/s (`output/nimbus-pixel-0929/`); physics spec §4.6', appliesTo: ['physics'], simulated: 'modelled', values: { blocksPerSecondPerFlyingSpeed: 120, offsetBlocksPerSecond: 2.3 } },
  { id: 'hover-climb-descend', rule: 'On a hover mount Jump climbs ~20-22 blocks/s; the descend group (vertical_movement_action -0.5) sinks ~4 blocks/s.', evidence: 'Saga 2026-09-29 (`output/nimbus-saga-0929/`, climb ~20), Pixel 2026-09-29 (dive ~4 down, climb ~22)', appliesTo: ['physics'], simulated: 'modelled', values: { climbBlocksPerSecond: 21, descendBlocksPerSecond: 4 } },
  { id: 'hover-descend-needs-jump', rule: 'The descend group acts only while Jump is held; look pitch alone does not descend a hover mount.', evidence: 'Saga 26.52 (physics spec §4.6, `FLYER.DIVE_PITCH_DEG`); fix `a754a7de`', appliesTo: ['physics', 'input'], simulated: 'modelled' },
  { id: 'camera-pitch-limit', rule: '`setCamera` takes a pitch within ±90 only; outside it throws.', evidence: 'CLAUDE.md "A Bedrock camera cannot roll per tick" (Pixel 26.51)', appliesTo: ['camera'], simulated: 'modelled' },
  { id: 'camera-roll-animation-only', rule: 'Roll exists only as a `playAnimation` keyframe; keyframes >0.05 s apart, a re-issued animation is never drawn, Euler keys interpolate linearly.', evidence: 'CLAUDE.md camera gotcha (2026-09-24..29, `camprobe`)', appliesTo: ['camera', 'render'], simulated: 'device-only' },
  { id: 'client-entity-lag', rule: 'The client draws entities ~3.5 ticks behind the server.', evidence: 'CLAUDE.md (marker-measured, `camprobe`, `animLag` 3.5)', appliesTo: ['render', 'camera'], simulated: 'device-only', values: { ticks: 3.5 } },
  { id: 'rider-yaw-lag', rule: 'A rider\'s reported yaw is the client\'s and trails its vehicle ~6 ticks.', evidence: 'CLAUDE.md camera gotcha', appliesTo: ['camera', 'input'], simulated: 'device-only', values: { ticks: 6 } },
  { id: 'actor-draw-ceiling', rule: 'On 26.51/26.52 no actor draws past ~70-72 blocks, whatever its collision box.', evidence: 'round 2026-09-26a, `output/device-round-2026-09-26a/pixel/cull_*.png` (CLAUDE.md)', appliesTo: ['render'], simulated: 'modelled', values: { blocks: 70 } },
  { id: 'cull-by-collision-box', rule: 'Below the ceiling an actor culls at ≈ 64 × max(1, collision box diagonal) blocks.', evidence: 'CLAUDE.md (2026-09-22)', appliesTo: ['render'], simulated: 'modelled', values: { blocksPerDiagonal: 64 } },
  { id: 'box-uv-sub-unit-faces', rule: 'Bedrock floors a box-UV cube\'s DECLARED size and does not draw a side face whose height floors to 0.', evidence: 'Pixel probe 2026-09-29 (CLAUDE.md; `UvFloorModel`, `_figure_compile_holes.ts`)', appliesTo: ['render'], simulated: 'device-only', gap: 'the snapshot rasteriser draws every face' },
  { id: 'coplanar-hatching', rule: 'Two colours on one plane hatch (z-fight) on the device.', evidence: 'CLAUDE.md "Two colours on one plane hatch on the device" (`_render_fault_audit.ts`)', appliesTo: ['render'], simulated: 'device-only' },
  { id: 'slow-falling-gravity', rule: 'Slow falling lowers gravity to 0.01 blocks/tick² while falling and prevents fall damage.', evidence: 'Pixel 2026-09-29 float-down 89 blocks in 11 s, unharmed (`output/nimbus-pixel-0929/`)', appliesTo: ['physics'], simulated: 'modelled', values: { gravity: 0.01 } },
  { id: 'fill-volume-limit', rule: '`fillBlocks` takes a BlockVolume INSTANCE (a plain {from,to} is rejected) and at most 32768 blocks per call.', evidence: 'test/_placement-host.ts (the stale-collider bug), @minecraft/server 2.x docs', appliesTo: ['script-host', 'world'], simulated: 'modelled', values: { maxBlocks: 32768 } },
  { id: 'structure-load-keeps-states', rule: '`structure load` turned by a rotation moves each block but keeps its states (a custom block\'s shape in its id/state is NOT turned).', evidence: 'bedrock-placement-pack.ts (the clearance-form re-set after a turned load, 2026-09-25)', appliesTo: ['commands', 'world'], simulated: 'partial', gap: 'vanilla direction states (stairs, doors) are not turned either; the game turns those' },
  { id: 'no-dismount-event', rule: '@minecraft/server 2.9 has no dismount event: a runtime polls who is aboard.', evidence: 'physics spec §4.6 (flyer.js polls every 10 ticks)', appliesTo: ['script-host'], simulated: 'modelled' },
  { id: 'dynamic-property-string-limit', rule: 'A string dynamic property holds at most 32,767 characters; a longer one throws.', evidence: 'bedrock-placement-pack.ts undo record chunks (2026-09-25)', appliesTo: ['script-host'], simulated: 'modelled', values: { maxChars: 32767 } },
  { id: 'simulation-distance', rule: 'Chunks within the simulation distance of a player (and inside ticking areas) are loaded; outside them blocks read undefined and entities freeze.', evidence: 'CLAUDE.md "An unloaded block is not air" (a GameTest vehicle ~100 blocks out stopped being readable)', appliesTo: ['world'], simulated: 'partial', values: { chunks: 6 }, gap: 'the phones\' exact simulation distance is not measured; 6 chunks (96 blocks) matches the ~100-block GameTest loss' },
  { id: 'native-mount-bursts', rule: 'A client-driven mount reports ~0 velocity and its server position moves in bursts (CMVT cadence ~4 ticks).', evidence: 'physics spec §4.6 (`DRIVER_SPEED_WINDOW_TICKS`; Saga 2-tick deltas 0/24.9/60.2/99.0 mph)', appliesTo: ['physics'], simulated: 'partial', values: { burstTicks: 4 }, gap: 'the engine moves the mount every tick (smooth); the driver HUD\'s burst averaging is not exercised' },
];

const BY_ID = new Map<QuirkId, Quirk>(QUIRKS.map(q => [q.id, q]));

/** A quirk by id (throws for an unknown id: a typo must not silently read no fact). */
export function quirk(id: QuirkId): Quirk {
  const q = BY_ID.get(id);
  if (!q) throw new Error(`unknown quirk ${id}`);
  return q;
}

/** A quirk's measured number. */
export function quirkValue(id: QuirkId, key: string): number {
  const v = quirk(id).values?.[key];
  if (v === undefined) throw new Error(`quirk ${id} has no value ${key}`);
  return v;
}

/** Every registered quirk, in registry order. */
export function allQuirks(): readonly Quirk[] { return QUIRKS; }

/** The quirks an area of the engine cannot simulate: what a scenario touching it must report as device-only. */
export function deviceOnly(area: QuirkArea): Quirk[] { return QUIRKS.filter(q => q.simulated === 'device-only' && q.appliesTo.includes(area)); }
