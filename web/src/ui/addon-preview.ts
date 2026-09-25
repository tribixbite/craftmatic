/**
 * The add-on WALK: a first-person, in-browser preview of a generated Bedrock
 * add-on, mounted over the LEGO tab's own Three.js renderer. It exists to
 * answer the semantic questions that otherwise cost a 20-90 minute device
 * round ("can a player get to the station?", "what does 150 % do to the
 * stairs?", "where are the figures?") in seconds.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT. The player walks the EXACT collider
 * blocks the pack ships at the chosen size and quarter turn (the wand's own
 * re-lay arithmetic plus the shipped tread plan, engine/addon-walk.ts), so a
 * surface unreachable here is unreachable in game. It does NOT prove Bedrock's
 * rendering, its entity culling, form text, ride physics or memory limits — a
 * device round still decides those, and the banner on screen says so.
 *
 * Division of labour: engine/addon-walk.ts owns motion and collision (pure);
 * ui/addon-preview-data.ts owns reading the pack and the legend arithmetic
 * (pure, unit-tested); this module owns everything visual — the scene, the
 * markers and overlays, the HUD, pointer lock, keys and the touch fallback.
 *
 * Rendering reuses the viewer's WebGLRenderer with a scene of its own (the
 * pack's frame is blocks from the pin, not the model's LDU frame), drawn by
 * this module's own frame loop while the viewer's OrbitControls are disabled;
 * the viewer's loop is idle meanwhile (it composites only on demand). Loaded
 * lazily from lego.ts so the QA surface never grows the main chunk.
 */

import * as THREE from 'three';
import type { LDrawViewer } from '@viewer/ldraw/index.js';
import {
  buildWalkWorld, PLAYER_HEIGHT, spawnState, tickPlayer, TICKS_PER_SECOND,
  type EntitySolid, type PlayerState, type PointReach, type WalkInput, type WalkWorld,
} from '@engine/addon-walk.js';
import { QUARTER_TURNS, type QuarterTurn, type ReachTarget } from '@engine/bedrock-collider-scale.js';
import { COASTER_PHYSICS, RIDE_INTERACT_TEXT } from '@engine/bedrock-coaster.js';
import { PINBALL_INTERACT_TEXT } from '@engine/bedrock-pinball.js';
import { createPinballSim, type PinballSim } from '@engine/pinball-physics.js';
import { SWING_SECONDS, ixClosedBlocks, ixWorldBlocks, type InteractiveRuntimeItem } from '@engine/bedrock-interactives.js';
import {
  coasterCarEyePoint, initCoasterPreviewState, stepCoasterPreviewTick,
  type CoasterPreviewCarFrame, type CoasterPreviewRouteInput, type CoasterPreviewState,
} from '@engine/coaster-preview.js';
import { MINIFIG_ANIMATIONS, MINIFIG_ANIMATION_IDS } from '@engine/minifig-rig.js';
import type { AppearanceCube } from './addon-appearance.js';
import type { ReachWorkerRequest, ReachWorkerResponse } from './addon-reach-worker.js';
import {
  columnBoxes, defaultLegendState, entitySpawnsAt, laidColliderBlocks, LEGEND_KINDS, LEGEND_LABELS, legendCounts, legendKindOf,
  pinballPlanePoint, placedDirection, placedPoint, reachSurfacesFromGrid, recommendedSize, spawnPoint, toggleLegend, treadBlocksAt,
  type AddonEntity, type AddonEntityKind, type AddonPreviewModel, type AddonRoute, type LegendKind, type LegendState, type ReachSurface,
} from './addon-preview-data.js';

// ─── Public surface ──────────────────────────────────────────────────────────

export interface AddonPreviewOptions {
  /** The LEGO tab's viewer: its renderer, container and controls are borrowed while the walk is open. */
  viewer: LDrawViewer;
  model: AddonPreviewModel;
  /** Initial size step (percent); defaults to the pack's recommendation, else 100. */
  sizePct?: number;
  onClose?: () => void;
  onStatus?: (message: string, kind: 'info' | 'error' | 'success') => void;
}

export interface AddonPreviewHandle {
  close(): void;
  setSize(sizePct: number, rotation?: QuarterTurn): void;
  readonly open: boolean;
}

/** The size and turn a walk is showing, for tests and the status line. */
export interface WalkView { sizePct: number; rotation: QuarterTurn }

// ─── Colours ─────────────────────────────────────────────────────────────────

const KIND_COLOR: Record<AddonEntityKind, number> = {
  shell: 0x64748b, figure: 0xf472b6, seat: 0xa78bfa, door: 0x38bdf8, car: 0xfb923c, lift: 0xfacc15, counterweight: 0x94a3b8, vehicle: 0x34d399, screen: 0x67e8f9, other: 0xcbd5e1,
};
const LEGEND_COLOR: Record<LegendKind, number> = {
  model: 0xe2e8f0, figure: KIND_COLOR.figure, seat: KIND_COLOR.seat, door: KIND_COLOR.door, track: 0x22d3ee, vehicle: KIND_COLOR.car, collider: 0x7c8aa5, tread: 0xf5a623,
};
const COLOR_REACHED = 0x22c55e, COLOR_UNREACHED = 0xef4444, COLOR_STATION = 0xfde047, COLOR_CHAIN = 0xf97316;
const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

/** The pack's own sit pose (`MINIFIG_ANIMATIONS`'s `sit` animation, legs -90°),
 * read out as a bone-name -> rotation-degrees overlay for `buildModel`'s
 * `boneWorld` rather than re-typing the numbers here. */
const SIT_POSE_OVERLAY: ReadonlyMap<string, readonly [number, number, number]> = new Map(
  Object.entries(MINIFIG_ANIMATIONS.animations[MINIFIG_ANIMATION_IDS.sit].bones)
    .map(([name, b]) => [name, b.rotation as readonly [number, number, number]] as const),
);

// ─── Entry point ─────────────────────────────────────────────────────────────

/** Open the walk over the viewer. Returns a handle; the HUD's Exit button and Escape (when the pointer is not locked) close it too. */
export function openAddonPreview(opts: AddonPreviewOptions): AddonPreviewHandle {
  const walk = new AddonWalk(opts);
  walk.mount();
  return walk;
}

/** Marker geometry per kind, blocks: the box a marker fills (figures and seats stay player-sized at every wand size). */
const MARKER_SIZE: Record<AddonEntityKind, [number, number, number]> = {
  shell: [0, 0, 0], figure: [0.6, 1.8, 0.6], seat: [0.7, 0.5, 0.7], door: [1, 2, 0.2], car: [1.25, 0.8, 0.8], lift: [1.2, 0.3, 1.2], counterweight: [0.8, 0.8, 0.8], vehicle: [2, 1, 1], screen: [1, 0.8, 0.1], other: [0.6, 0.6, 0.6],
};
/** Kinds whose marker scales with the wand size (entities compiled at the model scale). */
const SCALES_WITH_SIZE = new Set<AddonEntityKind>(['car', 'lift', 'counterweight', 'vehicle', 'screen', 'door']);

interface Marker {
  entity: AddonEntity;
  legend: LegendKind | null;
  mesh: THREE.Mesh;
  beam: THREE.Mesh;
  label: HTMLDivElement;
  /** World position of the marker's base at the current size and turn. */
  at: THREE.Vector3;
  height: number;
  reach: PointReach | null;
  /** `buildModel` already draws this entity's real geometry: keep the beam/label, hide the placeholder box/capsule. */
  hasRealGeometry: boolean;
}

interface Target {
  label: string;
  kind: LegendKind | 'station' | 'lift';
  /** Model blocks at 100 % (the frame `reachPoint` takes). */
  point: { x: number; y: number; z: number };
  /** Null until the verdict arrives from the reach worker. */
  reach: PointReach | null;
  world: THREE.Vector3;
  labelEl: HTMLDivElement;
  labelText: string;
}

class AddonWalk implements AddonPreviewHandle {
  open = false;
  private readonly viewer: LDrawViewer;
  private readonly model: AddonPreviewModel;
  private readonly onStatus: (m: string, k: 'info' | 'error' | 'success') => void;
  private readonly onClose: (() => void) | undefined;

  // Scene
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly worldGroup = new THREE.Group();
  private readonly entityGroup = new THREE.Group();
  private readonly routeGroup = new THREE.Group();
  private readonly reachGroup = new THREE.Group();
  private readonly highlightGroup = new THREE.Group();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly unitBox = new THREE.BoxGeometry(1, 1, 1);
  private readonly plateGeom = new THREE.BoxGeometry(0.92, 0.04, 0.92);

  // View state
  private sizePct: number;
  private rotation: QuarterTurn = 0;
  private legend: LegendState = defaultLegendState();
  private showReach = true;
  private noclip = false;
  private hudVisible = !(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  private laidDims = { width: 1, height: 1, length: 1 };
  private world: WalkWorld | null = null;
  private markers: Marker[] = [];
  private targets: Target[] = [];
  private reachSummary = '';
  private treadCount = 0;
  /** Reach verdicts run off-thread (addon-reach-worker.ts); null when a Worker cannot be made and the inline fallback runs instead. */
  private reachWorker: Worker | null | undefined;
  private reachJob = 0;
  /** What the HUD says about the verdicts: pending, or how long they took. */
  private verdictNote = '';

  // Ride animation and interactivity. `entityHolders` is every drawn entity's
  // Group, by its index in `model.entities` (built once in `buildModel`); the
  // coaster loop repositions the ones that are cars/lifts/counterweights each
  // tick, and the door toggle rotates a door leaf's holder in place.
  private entityHolders = new Map<number, THREE.Group>();
  /** `entity.label` marker, by `model.entities` index — for repositioning a moving car that ships no RP appearance data. */
  private markerByIndex = new Map<number, Marker>();
  /** `${coasterRouteIndex}:${coasterCarIndex}` -> entity index, train 0 only (its slot indices ARE `coasterCarIndex`). */
  private carEntityIndex = new Map<string, number>();
  /** One `stepCoasterPreviewTick` state per route index, riderless by default. */
  private coasterStates = new Map<number, CoasterPreviewState>();
  /** Every route's train-0 car slots' CURRENT world pose this tick, for the
   * "board" reach test and the ride camera; keyed by `entity` index. */
  private carWorld = new Map<number, { x: number; y: number; z: number; yawDeg: number; frame: CoasterPreviewCarFrame }>();
  /** Door LEAF entities toggled open (their holder rotated), by entity index. */
  private openDoorLeaves = new Set<number>();
  /**
   * The moving parts (`model.interactives`, the pack's own
   * `scripts/interactives.js` config), by ITEM index: open or closed (a
   * turnable's accumulated angle), and the angle each is drawn at while it
   * eases toward its target over `SWING_SECONDS`, as the client's Molang does.
   */
  private readonly ixOpen = new Map<number, boolean>();
  private readonly ixTarget = new Map<number, number>();
  private readonly ixShown = new Map<number, number>();
  /** Item index -> entity index, and each interactive holder's un-swung pose. */
  private readonly ixEntity = new Map<number, number>();
  private readonly ixBase = new Map<number, { pos: THREE.Vector3; quat: THREE.Quaternion }>();
  /** The closed leaves' collider blocks, drawn over the static ones (legend: colliders). */
  private ixColliderMesh: THREE.InstancedMesh | null = null;
  /** The nearest thing an Interact key/button would act on right now. */
  private nearestInteract: { label: string; act: () => void } | null = null;
  /** Riding a car: which route/slot, and the player state to restore on dismount. */
  private riding: { routeIndex: number; slot: number; entityIndex: number; restore: PlayerState; restoreYaw: number; restorePitch: number } | null = null;
  /** Sitting at a static (non-coaster) seat: just parks the camera there. */
  private sitting: { entityIndex: number; restore: PlayerState; restoreYaw: number; restorePitch: number } | null = null;
  private interactQueued = false;

  // Pinball: the console/ball/flipper indices into `model.entities` (found
  // once, by matching `model.pinball`'s own type ids — stable across rebuilds
  // since `model.entities` never changes shape, only its placed positions
  // do), the running game while boarded, and each flipper's UN-SPUN base pose
  // (`buildModel`'s own placement) the spin is applied on top of every tick.
  private pinballIndices: { console: number; ball: number; flippers: number[] } | null = null;
  private pinball: {
    sim: PinballSim;
    restore: { state: PlayerState; yaw: number; pitch: number };
    /** The reach overlay / collider / tread / model legend rows, as the user had them before boarding — restored on `leavePinball`. */
    restoreView: { showReach: boolean; collider: boolean; tread: boolean; model: boolean };
  } | null = null;
  private pinballBest = 0;
  /** Each flipper's pivot in WORLD coordinates, this tick's — exposed for the
   * dev hook (`_shoot_addon_walk.mjs`'s close-up shot): a flipper's compiled
   * geometry can sit many blocks from its entity's own placement origin (the
   * bind pose's bone pivots, in 1/16-block units, run well outside the
   * origin), so the pivot the physics itself rotates about is a far more
   * reliable "near the flipper" point than `AddonEntity.x/y/z`. */
  private readonly pinballFlipperPivots = new Map<number, { x: number; y: number; z: number }>();
  private readonly pinballFlipperBase = new Map<number, { pos: THREE.Vector3; quat: THREE.Quaternion }>();
  private readonly touchPinball = { left: false, right: false, launch: false };

  // Player
  private state: PlayerState;
  private prevState: PlayerState;
  private yaw = 0;
  private pitch = 0;
  private accumulator = 0;
  private lastFrame = 0;
  private animId = 0;
  private readonly keys = new Set<string>();
  private jumpQueued = false;
  private touchMove = { x: 0, y: 0 };
  private touchSneak = false;
  private touchSprint = false;
  private touchJump = false;

  // DOM
  private root!: HTMLDivElement;
  private lookLayer!: HTMLDivElement;
  private labelLayer!: HTMLDivElement;
  private hud!: HTMLDivElement;
  private legendEl!: HTMLDivElement;
  private sizeEl!: HTMLDivElement;
  private reachEl!: HTMLDivElement;
  private targetsEl!: HTMLDivElement;
  private hintEl!: HTMLDivElement;
  private interactEl!: HTMLDivElement;
  private touchMoveEl!: HTMLDivElement;
  private pinballTouchEl!: HTMLDivElement;
  private resizeObs: ResizeObserver | null = null;
  private readonly listeners: Array<() => void> = [];
  private savedHover: LDrawViewer['onBrickHover'] = null;
  private savedClick: LDrawViewer['onBrickClick'] = null;
  private readonly isTouch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  constructor(opts: AddonPreviewOptions) {
    this.viewer = opts.viewer;
    this.model = opts.model;
    this.onStatus = opts.onStatus ?? (() => {});
    this.onClose = opts.onClose;
    const rec = recommendedSize(this.model);
    const initial = opts.sizePct ?? rec?.sizePct ?? 100;
    this.sizePct = this.model.sizes.includes(initial) ? initial : 100;
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 800);
    this.state = spawnState(null as unknown as WalkWorld);
    this.prevState = this.state;
    const pb = this.model.pinball;
    if (pb) {
      const flippers = pb.flipperTypes.map(t => this.model.entities.findIndex(e => e.typeId === t));
      const consoleIndex = this.model.entities.findIndex(e => e.typeId === pb.consoleType);
      const ballIndex = this.model.entities.findIndex(e => e.typeId === pb.ballType);
      if (consoleIndex >= 0 && ballIndex >= 0 && flippers.every(i => i >= 0)) this.pinballIndices = { console: consoleIndex, ball: ballIndex, flippers };
    }
  }

  // ── Mount / unmount ─────────────────────────────────────────────────────

  mount(): void {
    const { viewer } = this;
    const container = viewer.container;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    // Borrow the viewer: no orbiting, no turntable, no brick picking while the walk owns the canvas.
    viewer.controls.enabled = false;
    viewer.setAutoRotate(false);
    viewer.setStatsOverlay(false);
    this.savedHover = viewer.onBrickHover; this.savedClick = viewer.onBrickClick;
    viewer.onBrickHover = null; viewer.onBrickClick = null;

    this.scene.background = new THREE.Color(0x0b0d14);
    this.scene.fog = new THREE.Fog(0x0b0d14, 60, 220);
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1a1d2b, 1.1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.6, 1, 0.35);
    this.scene.add(hemi, sun, this.worldGroup, this.entityGroup, this.routeGroup, this.reachGroup, this.highlightGroup);

    this.buildDom(container);
    this.hud.style.display = this.hudVisible ? '' : 'none';
    this.rebuild(true);
    this.open = true;
    // On a phone the viewer panel sits under the tab's controls: bring the walk into sight.
    container.scrollIntoView({ block: 'nearest' });
    this.lastFrame = performance.now();
    this.animId = requestAnimationFrame(this.frame);
    // Dev-only debugging hook, same convention as viewer.ts's __ldrawViewer:
    // expose ride state and interactivity for the console / E2E screenshots,
    // since a moving car's exact position is otherwise only provable by
    // pixel-diffing two screenshots.
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
      (globalThis as Record<string, unknown>)['__addonWalk'] = this;
    }
    this.onStatus(`Add-on walk: ${this.model.label} at ${this.sizePct} % — click the view to look around, WASD to walk, Space to jump, Shift to sneak, F for free-fly, Esc to release the mouse.`, 'info');
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    cancelAnimationFrame(this.animId);
    if (document.pointerLockElement) document.exitPointerLock();
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.resizeObs?.disconnect();
    this.reachWorker?.terminate();
    this.reachWorker = undefined;
    this.reachJob++;
    this.clearGroup(this.worldGroup); this.clearGroup(this.entityGroup); this.clearGroup(this.routeGroup); this.clearGroup(this.reachGroup); this.clearGroup(this.highlightGroup);
    for (const d of this.disposables) d.dispose();
    this.unitBox.dispose(); this.plateGeom.dispose();
    this.root.remove();
    const { viewer } = this;
    viewer.onBrickHover = this.savedHover; viewer.onBrickClick = this.savedClick;
    viewer.controls.enabled = true;
    // The viewer composites on demand; a controls 'change' is its public invalidation, so the model comes back on screen.
    viewer.controls.dispatchEvent({ type: 'change' });
    this.onClose?.();
  }

  setSize(sizePct: number, rotation: QuarterTurn = this.rotation): void {
    if (!this.model.sizes.includes(sizePct)) return;
    const changed = sizePct !== this.sizePct || rotation !== this.rotation;
    this.sizePct = sizePct; this.rotation = rotation;
    if (changed) this.rebuild(true);
  }

  // ── The scene at a size ─────────────────────────────────────────────────

  private clearGroup(g: THREE.Group): void {
    for (const child of [...g.children]) {
      g.remove(child);
      child.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.geometry && m.geometry !== this.unitBox && m.geometry !== this.plateGeom) m.geometry.dispose();
        const mat = (m as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach(x => x.dispose()); else mat?.dispose();
      });
    }
  }

  /** Lay the world, the entities, the track, the reach overlay and the HUD for the current size and turn. */
  private rebuild(respawn: boolean): void {
    const { model, sizePct, rotation } = this;
    const f = sizePct / 100;
    const treads = treadBlocksAt(model, sizePct, rotation);
    this.treadCount = treads.length;
    const laid = laidColliderBlocks(model.cells, model.dims, sizePct, rotation, treads);
    this.laidDims = laid.dims;

    // Dismount/leave a seat across a size or turn change: the world under the
    // ride is about to be torn down and rebuilt.
    if (this.riding || this.sitting) this.dismount();
    if (this.pinball) this.leavePinball();
    this.coasterStates.clear();
    this.carWorld.clear();
    this.openDoorLeaves.clear();
    // A size or turn change re-places the build: every moving part starts closed, as a fresh placement does.
    this.ixOpen.clear(); this.ixTarget.clear(); this.ixShown.clear(); this.ixEntity.clear(); this.ixBase.clear();
    this.ixColliderMesh = null;
    model.entities.forEach((e, i) => { if (e.interactive !== undefined) this.ixEntity.set(e.interactive, i); });
    this.nearestInteract = null;
    this.carEntityIndex.clear();
    model.entities.forEach((e, i) => {
      if (e.coasterRouteIndex !== undefined && e.coasterCarIndex !== undefined) this.carEntityIndex.set(`${e.coasterRouteIndex}:${e.coasterCarIndex}`, i);
    });

    // The walk world (motion + reach) exists from 100 % up; below it the wand merges cells and the walk module declines.
    this.world = null;
    if (sizePct >= 100 && model.cells.length) {
      try { this.world = buildWalkWorld({ cells: model.cells, dims: model.dims, sizePct, rotation, treads, entitySolids: this.computeEntitySolids() }); }
      catch (err) { this.onStatus(`Walk physics unavailable: ${err instanceof Error ? err.message : String(err)}`, 'error'); }
    }
    if (!this.world) this.noclip = true;

    this.clearGroup(this.worldGroup);
    this.buildGround(laid.dims);
    this.buildColliders(columnBoxes(laid.blocks));
    this.buildModel(f);
    this.applyInteractiveColliders();
    model.routes.forEach((_route, routeIndex) => this.initCoasterRoute(routeIndex));

    this.clearGroup(this.reachGroup);
    if (this.world) {
      const reach = this.world.reach();
      const surfaces = reachSurfacesFromGrid(this.world.grid, reach);
      this.buildReach(surfaces);
      const reached = surfaces.filter(s => s.reached).length;
      const columns = new Set(surfaces.filter(s => s.reached).map(s => `${s.x},${s.z}`)).size;
      const highest = reach.highest16 / 16;
      this.reachSummary = `Reach on foot at ${sizePct} % (turn ${rotation}): ${reached.toLocaleString()} of ${surfaces.length.toLocaleString()} standable surfaces over ${columns.toLocaleString()} columns; highest ${highest.toFixed(2)} blocks (${(highest / f).toFixed(2)} at 100 %). Treads laid: ${treads.length}.`;
    } else {
      this.reachSummary = model.cells.length
        ? `No walk below 100 %: the wand merges several cells into a block there and the walk module declines to guess. Free-fly only; the boxes are still the exact re-lay.`
        : 'This pack ships no collider grid, so there is nothing to walk on: free-fly only.';
    }

    this.buildEntities(f);
    this.buildRoutes();
    this.buildHighlights();
    this.applyLegendVisibility();
    this.requestVerdicts();

    if (respawn) this.respawn();
    this.renderHud();
  }

  private buildGround(dims: { width: number; length: number }): void {
    const pad = 24;
    const w = dims.width + 2 * pad, l = dims.length + 2 * pad;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, l), new THREE.MeshStandardMaterial({ color: 0x141827, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(dims.width / 2, -0.002, dims.length / 2);
    this.worldGroup.add(ground);
    const grid = new THREE.GridHelper(Math.max(w, l), Math.max(w, l), 0x3a4160, 0x232a42);
    grid.position.set(dims.width / 2, 0.001, dims.length / 2);
    this.worldGroup.add(grid);
    // The footprint's outline on the ground: where the pin's re-lay ends and the player's own world begins.
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(dims.width, dims.length)), new THREE.LineBasicMaterial({ color: 0x7c8aa5 }));
    outline.rotation.x = -Math.PI / 2;
    outline.position.set(dims.width / 2, 0.01, dims.length / 2);
    this.worldGroup.add(outline);
  }

  private buildColliders(boxes: ReturnType<typeof columnBoxes>): void {
    const solids = boxes.filter(b => !b.tread), treads = boxes.filter(b => b.tread);
    const top = this.laidDims.height || 1;
    const make = (list: typeof boxes, color: THREE.Color | null, name: string): void => {
      if (!list.length) return;
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.05, flatShading: true, ...(color ? { emissive: color, emissiveIntensity: 0.25 } : {}) });
      const mesh = new THREE.InstancedMesh(this.unitBox, mat, list.length);
      const m = new THREE.Matrix4(), c = new THREE.Color();
      list.forEach((b, i) => {
        m.makeScale(1, b.y1 - b.y0, 1);
        m.setPosition(b.x + 0.5, (b.y0 + b.y1) / 2, b.z + 0.5);
        mesh.setMatrixAt(i, m);
        if (color) c.copy(color);
        else {
          // A gentle height ramp so floors and roofs read apart from ten blocks away.
          const t = Math.min(1, b.y1 / top);
          c.setRGB(0.36 + 0.22 * t, 0.40 + 0.22 * t, 0.50 + 0.18 * t);
        }
        mesh.setColorAt(i, c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.name = name;
      this.worldGroup.add(mesh);
    };
    make(solids, null, 'colliders');
    make(treads, new THREE.Color(LEGEND_COLOR.tread), 'treads');
  }

  /**
   * What the pack DRAWS, from its own geometry — the layer that answers "does
   * the model look right" without a phone.
   *
   * Bedrock model units are 1/16 block, so a cube's extent divides by 16 and
   * then scales with the wand size exactly as the colliders do. Cubes are
   * instanced per COLOUR CHUNK (the compiler emits one chunk per material), so
   * a 46,000-cuboid shell is ~80 draw calls rather than 46,000 meshes.
   *
   * Bone transforms are composed up the parent chain, and a cube's own
   * rotation (what a stud facet carries) is applied about its pivot first, so
   * a posed rider and a fanned stud both land where the game puts them.
   */
  private buildModel(f: number): void {
    const appearance = this.model.appearance;
    this.entityHolders.clear();
    this.pinballFlipperBase.clear();
    if (!appearance) return;
    const group = new THREE.Group();
    group.name = 'model';

    const deg = Math.PI / 180;
    // Bedrock adds a playing animation's bone rotation to the geometry's own
    // bind-pose rotation (component-wise, in degrees) rather than composing a
    // second matrix; `overlay` is exactly that addition, used for the sit pose
    // below (`MINIFIG_ANIMATIONS`'s own numbers, not re-derived).
    const boneWorld = (entry: NonNullable<ReturnType<typeof appearance.byType.get>>, overlay?: ReadonlyMap<string, readonly [number, number, number]>): Map<string, THREE.Matrix4> => {
      const byName = new Map(entry.bones.map(b => [b.name, b]));
      const done = new Map<string, THREE.Matrix4>();
      const resolve = (name: string, seen: Set<string>): THREE.Matrix4 => {
        const hit = done.get(name);
        if (hit) return hit;
        const bone = byName.get(name);
        const m = new THREE.Matrix4();
        if (!bone || seen.has(name)) { done.set(name, m); return m; }
        seen.add(name);
        const parent = bone.parent ? resolve(bone.parent, seen) : new THREE.Matrix4();
        // Bedrock turns a bone about its pivot; its rotation is degrees XYZ and
        // Y/Z are negated against three.js' handedness, as the geometry writer
        // emits them (see eulerZYX in ldraw-entity-compiler).
        const [px, py, pz] = bone.pivot;
        const add = overlay?.get(name);
        const [brx, bry, brz] = bone.rotation ?? [0, 0, 0];
        const rx = brx + (add?.[0] ?? 0), ry = bry + (add?.[1] ?? 0), rz = brz + (add?.[2] ?? 0);
        const local = new THREE.Matrix4();
        if (rx || ry || rz) {
          local.makeTranslation(px, py, pz)
            .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx * deg, -ry * deg, -rz * deg, 'ZYX')))
            .multiply(new THREE.Matrix4().makeTranslation(-px, -py, -pz));
        }
        const world = parent.clone().multiply(local);
        done.set(name, world);
        return world;
      };
      for (const b of entry.bones) resolve(b.name, new Set());
      return done;
    };

    const m = new THREE.Matrix4(), cube = new THREE.Matrix4(), spin = new THREE.Matrix4();
    this.model.entities.forEach((entity, index) => {
      if (!entitySpawnsAt(entity, this.sizePct)) return;
      const entry = appearance.byType.get(entity.typeId);
      if (!entry) return;
      const at = placedPoint(entity, this.model.dims, this.sizePct, this.rotation);
      // The actor's own yaw, plus the quarter turn the whole placement took.
      const yaw = (entity.yaw + this.rotation * 90) * deg;
      // A figure seated on a MANUAL seat (`rideOf`) is startRiding()'d at spawn,
      // so `query.is_riding` is true from the first tick and the pack's own
      // sit animation (legs -90°) is its default pose, not the standing bind
      // pose. A coaster car's own posed rider is baked geometry already; this
      // never applies there. Riders inside a coaster car use a DIFFERENT
      // mechanism (rider_N bone visibility), below.
      const overlay = entity.kind === 'figure' && entity.rideOf !== undefined ? SIT_POSE_OVERLAY : undefined;
      const bones = boneWorld(entry, overlay);
      // Which rider variant a coaster car shows by default (occupied: false):
      // `route.cars.slots[coasterCarIndex].rider`, exactly what the pack's own
      // `rider_N` bone-visibility animation keys off. null = don't filter
      // (the fabricated cart has no rider bones at all).
      const activeRider = this.activeRiderOf(entity);

      const holder = new THREE.Group();
      holder.position.set(at.x, at.y, at.z);
      holder.rotation.y = yaw;
      holder.scale.setScalar(f / 16);

      for (const chunk of entry.groups) {
        const cubes = activeRider === null ? chunk.cubes : chunk.cubes.filter(c => {
          const rider = /^rider_(\d+)$/.exec(c.bone);
          return !rider || Number(rider[1]) === activeRider;
        });
        if (!cubes.length) continue;
        if (chunk.texture) {
          // A face atlas: each decal cube draws ONE textured face, nothing else.
          const faces = this.faceDecalMesh(chunk.texture, cubes, bones);
          if (faces) holder.add(faces);
          continue;
        }
        const material = new THREE.MeshStandardMaterial({
          color: chunk.colorHex, roughness: 0.62, metalness: 0.04, flatShading: true,
          ...(chunk.alpha < 1 ? { transparent: true, opacity: Math.max(0.25, chunk.alpha) } : {}),
        });
        this.disposables.push(material);
        const mesh = new THREE.InstancedMesh(this.unitBox, material, cubes.length);
        cubes.forEach((c, i) => {
          const [ox, oy, oz] = c.origin, [sx, sy, sz] = c.size;
          // A zero-thickness cube would vanish; give it a hair so it still reads.
          cube.makeScale(sx || 0.01, sy || 0.01, sz || 0.01);
          cube.setPosition(ox + sx / 2, oy + sy / 2, oz + sz / 2);
          if (c.rotation && c.pivot) {
            const [rx, ry, rz] = c.rotation, [px, py, pz] = c.pivot;
            spin.makeTranslation(px, py, pz)
              .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx * deg, -ry * deg, -rz * deg, 'ZYX')))
              .multiply(new THREE.Matrix4().makeTranslation(-px, -py, -pz));
            cube.premultiply(spin);
          }
          m.copy(bones.get(c.bone) ?? new THREE.Matrix4()).multiply(cube);
          mesh.setMatrixAt(i, m);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.frustumCulled = false;
        holder.add(mesh);
      }
      group.add(holder);
      this.entityHolders.set(index, holder);
      // A pinball flipper's placed pose is the UN-SPUN reference every tick's
      // spin is applied on top of (see `applyPinballFlipperSpin`): capture it
      // here, right after `buildModel` has set it, before any spin runs.
      if (this.pinballIndices?.flippers.includes(index)) this.pinballFlipperBase.set(index, { pos: holder.position.clone(), quat: holder.quaternion.clone() });
      if (entity.interactive !== undefined) this.ixBase.set(entity.interactive, { pos: holder.position.clone(), quat: holder.quaternion.clone() });
    });
    this.worldGroup.add(group);
  }

  /** Face atlases decoded once per pack, by resource path. */
  private readonly faceTextureCache = new Map<string, THREE.Texture>();

  /** The face atlas at `path` as a nearest-sampled texture, or null when the pack does not ship it. */
  private faceTexture(path: string): THREE.Texture | null {
    const hit = this.faceTextureCache.get(path);
    if (hit) return hit;
    const bytes = this.model.faceTextures?.get(path);
    if (!bytes) return null;
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
    const image = new Image();
    const texture = new THREE.Texture(image);
    // Texel-exact, as the game samples an entity texture; row 0 of the PNG is v = 0.
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    image.onload = () => { texture.needsUpdate = true; URL.revokeObjectURL(url); };
    image.src = url;
    this.faceTextureCache.set(path, texture);
    this.disposables.push(texture);
    return texture;
  }

  /**
   * Face decals (`head-face.ts`): one quad per cube on the face its per-face
   * UV names, textured from the atlas, alpha-tested. The corner a texel
   * rectangle's top-left lands on follows the rule the compiler lays the
   * atlas out by, in geometry-JSON terms: north u → +X, south u → −X,
   * east u → +Z, west u → −Z, v → −Y (see `orientFace`).
   */
  private faceDecalMesh(tex: { path: string; width: number; height: number }, cubes: ReadonlyArray<AppearanceCube>, bones: Map<string, THREE.Matrix4>): THREE.Mesh | null {
    const texture = this.faceTexture(tex.path);
    if (!texture) return null;
    const positions: number[] = [], uvs: number[] = [];
    const v = new THREE.Vector3();
    for (const c of cubes) {
      const f = c.faceUv;
      if (!f || f.face === 'up' || f.face === 'down') continue;
      const [ox, oy, oz] = c.origin, [sx, sy, sz] = c.size;
      const x0 = ox, x1 = ox + sx, y0 = oy, y1 = oy + sy, z0 = oz, z1 = oz + sz;
      // Top-left, top-right, bottom-left, bottom-right of the texel rectangle.
      const corners: Array<[number, number, number]> =
        f.face === 'north' ? [[x0, y1, z0], [x1, y1, z0], [x0, y0, z0], [x1, y0, z0]]
          : f.face === 'south' ? [[x1, y1, z1], [x0, y1, z1], [x1, y0, z1], [x0, y0, z1]]
            : f.face === 'east' ? [[x1, y1, z0], [x1, y1, z1], [x1, y0, z0], [x1, y0, z1]]
              : [[x0, y1, z1], [x0, y1, z0], [x0, y0, z1], [x0, y0, z0]];
      const u0 = f.uv[0] / tex.width, u1 = (f.uv[0] + f.size[0]) / tex.width;
      const w0 = f.uv[1] / tex.height, w1 = (f.uv[1] + f.size[1]) / tex.height;
      const cornerUv: Array<[number, number]> = [[u0, w0], [u1, w0], [u0, w1], [u1, w1]];
      const bone = bones.get(c.bone) ?? new THREE.Matrix4();
      for (const k of [0, 2, 1, 1, 2, 3]) {
        v.set(...corners[k]!).applyMatrix4(bone);
        positions.push(v.x, v.y, v.z);
        uvs.push(...cornerUv[k]!);
      }
    }
    if (!positions.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.62, metalness: 0.04 });
    this.disposables.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    return mesh;
  }

  /** The rider variant a coaster car currently shows (see `buildModel`), or
   * null when this entity is not a coaster car slot (nothing to filter). */
  private activeRiderOf(entity: AddonEntity): number | null {
    if (entity.coasterRouteIndex === undefined || entity.coasterCarIndex === undefined) return null;
    const route = this.model.routes[entity.coasterRouteIndex];
    const slot = route?.cars.slots?.[entity.coasterCarIndex];
    return slot ? slot.rider : null;
  }

  /**
   * Static entity collision the player bumps into RIGHT NOW: only where the
   * pack's own behaviour file declares `has_collision: true`
   * (`model.entityCollision`, read by `entityCollisionFromSources`) — a
   * standing figure (0.6 x 1.8, same box as the player), never a ride car
   * (the pack gives those `has_collision: false`; see CLAUDE.md and
   * bedrock-coaster.ts's `coasterCartAssets`/`carBehavior`). Baked once per
   * `rebuild()`, not per tick: nothing here moves (a coaster car's own box is
   * `false`, so a moving entity never needs one).
   */
  private computeEntitySolids(): EntitySolid[] {
    const { model, sizePct, rotation } = this;
    const out: EntitySolid[] = [];
    model.entities.forEach((entity, index) => {
      const box = model.entityCollision.get(entity.typeId);
      if (!box || !entitySpawnsAt(entity, sizePct)) return;
      const at = placedPoint(entity, model.dims, sizePct, rotation);
      out.push({ key: `entity${index}`, x0: at.x - box.width / 2, y0: at.y, z0: at.z - box.width / 2, x1: at.x + box.width / 2, y1: at.y + box.height, z1: at.z + box.width / 2 });
    });
    return out;
  }

  /** The route fields `coaster-preview.ts` needs, off `AddonRoute`. */
  private routeInput(route: AddonRoute): CoasterPreviewRouteInput {
    return {
      points: route.points, cumulative: route.cumulative, length: route.length, closed: route.closed,
      ...(route.station ? { station: { start: route.station.start, end: route.station.end, stop: route.station.stop } } : {}),
      ...(route.chain ? { chain: route.chain } : {}),
      ...(route.lift ? { lift: { deckLength: route.lift.deckLength, travel: route.lift.travel, parkedPoint: route.lift.parkedPoint } } : {}),
      cars: { count: route.cars.count, spacing: route.cars.spacing, extent: route.cars.extent },
    };
  }

  /** The measured wheel-contact spacing of train 0's car at `slot`, when its type measured one. */
  private wheelbaseFor(route: AddonRoute, slot: number): number | undefined {
    const type = route.cars.slots?.[slot]?.type;
    return type ? this.model.coasterTypes[type]?.wheelbase : undefined;
  }

  /** A fresh, riderless ride state for one route (a route too short/degenerate to build a path leaves its cars parked). */
  private initCoasterRoute(routeIndex: number): void {
    const route = this.model.routes[routeIndex];
    if (!route || route.points.length < 2) return;
    try { this.coasterStates.set(routeIndex, initCoasterPreviewState(this.routeInput(route))); }
    catch (err) { this.onStatus(`Route "${route.label}" cannot be animated: ${err instanceof Error ? err.message : String(err)}`, 'error'); }
  }

  /**
   * One physics tick (1/20 s) of every route's train 0, riderless by default
   * — see coaster-preview.ts. Moves the car/platform/counterweight holders
   * (real geometry) or their fallback markers (a pack with no RP appearance
   * data still shows its cars moving), and records each car's current world
   * pose in `carWorld` for the "board" reach test and the ride camera.
   *
   * # TODO: the entity's own transform (position + yaw) is exactly what the
   * real runtime teleports to; the geometry's `track_pitch`/`track_roll` bone
   * animation (the visual bank through a climb or a loop) is NOT applied here
   * — reproducing it needs the per-tick InstancedMesh rebuild `buildModel`
   * does once at rebuild time, which is more than this preview's motion-proof
   * bar needs today.
   */
  private updateCoasterAnimation(): void {
    const { model, sizePct, rotation } = this;
    const f = sizePct / 100;
    for (const [routeIndex, state] of this.coasterStates) {
      const route = model.routes[routeIndex];
      if (!route) continue;
      let result: ReturnType<typeof stepCoasterPreviewTick>;
      try { result = stepCoasterPreviewTick(this.routeInput(route), state, f, COASTER_PHYSICS, (slot: number) => this.wheelbaseFor(route, slot)); }
      catch { continue; }
      this.coasterStates.set(routeIndex, result.state);
      for (const frameResult of result.frames) {
        const entityIndex = this.carEntityIndex.get(`${routeIndex}:${frameResult.slot}`);
        if (entityIndex === undefined) continue;
        const [mx, my, mz] = frameResult.position;
        const w = placedPoint({ x: mx, y: my, z: mz }, model.dims, sizePct, rotation);
        const yawDeg = frameResult.yaw + rotation * 90;
        this.moveEntityHolder(entityIndex, w, yawDeg);
        this.carWorld.set(entityIndex, { x: w.x, y: w.y, z: w.z, yawDeg, frame: frameResult });
      }
      if (route.lift) {
        const [px, py, pz] = route.lift.parkedPoint, [tx, ty, tz] = route.lift.travel, progress = result.state.liftProgress;
        const liftIndex = model.entities.findIndex(e => e.kind === 'lift' && e.coasterRouteIndex === routeIndex);
        if (liftIndex >= 0) {
          const w = placedPoint({ x: px + tx * progress, y: py + ty * progress, z: pz + tz * progress }, model.dims, sizePct, rotation);
          this.moveEntityHolder(liftIndex, w, (model.entities[liftIndex]!.yaw + rotation * 90));
        }
        if (route.lift.counterweightPoint) {
          const [cx, cy, cz] = route.lift.counterweightPoint;
          const cwIndex = model.entities.findIndex(e => e.kind === 'counterweight' && e.coasterRouteIndex === routeIndex);
          if (cwIndex >= 0) {
            const w = placedPoint({ x: cx - tx * progress, y: cy - ty * progress, z: cz - tz * progress }, model.dims, sizePct, rotation);
            this.moveEntityHolder(cwIndex, w, (model.entities[cwIndex]!.yaw + rotation * 90));
          }
        }
      }
    }
  }

  /** Reposition an entity's real-geometry holder and/or its fallback marker (whichever exists) to a fresh world pose. */
  private moveEntityHolder(entityIndex: number, world: { x: number; y: number; z: number }, yawDeg: number): void {
    const yawRad = yawDeg * Math.PI / 180;
    const holder = this.entityHolders.get(entityIndex);
    if (holder) { holder.position.set(world.x, world.y, world.z); holder.rotation.y = yawRad; }
    const marker = this.markerByIndex.get(entityIndex);
    if (marker) {
      marker.mesh.position.set(world.x, world.y + marker.height / 2, world.z);
      marker.mesh.rotation.y = -yawRad;
      const beamTop = marker.beam.scale.y;
      marker.beam.position.set(world.x, beamTop / 2, world.z);
      marker.at.set(world.x, world.y, world.z);
    }
  }

  // ── Interactivity: board a seat/car, dismount, toggle a door ────────────

  /** What an Interact key/button would do right now, and how the HUD prompt reads it. */
  private updateInteract(): void {
    if (this.riding || this.sitting || this.pinball) {
      const label = this.pinball ? 'Shift or Esc to leave pinball' : 'Sneak to dismount';
      this.nearestInteract = { label, act: (): void => { if (this.pinball) this.leavePinball(); else this.dismount(); } };
      this.renderInteractHud();
      return;
    }
    const REACH = 2.5;
    const cam = this.camera.position;
    let best: { d: number; label: string; act: () => void } | null = null;
    const consider = (d: number, label: string, act: () => void): void => { if (d <= REACH && (!best || d < best.d)) best = { d, label, act }; };

    for (const [entityIndex, car] of this.carWorld) consider(Math.hypot(car.x - cam.x, car.y - cam.y, car.z - cam.z), RIDE_INTERACT_TEXT, () => this.board(entityIndex));

    if (this.pinballIndices) {
      const consoleEntity = this.model.entities[this.pinballIndices.console];
      if (consoleEntity && entitySpawnsAt(consoleEntity, this.sizePct)) {
        const at = placedPoint(consoleEntity, this.model.dims, this.sizePct, this.rotation);
        consider(Math.hypot(at.x - cam.x, at.y - cam.y, at.z - cam.z), PINBALL_INTERACT_TEXT, () => this.enterPinball());
      }
    }

    this.model.entities.forEach((entity, index) => {
      if (!entitySpawnsAt(entity, this.sizePct)) return;
      if (entity.kind !== 'seat' && entity.kind !== 'door') return;
      // The pinball console classifies as a seat (a fitting fallback marker
      // for an intentionally invisible entity) but its own interact — "Play
      // pinball", handled above — replaces the plain "Sit".
      if (this.pinballIndices && index === this.pinballIndices.console) return;
      const at = placedPoint(entity, this.model.dims, this.sizePct, this.rotation);
      const d = Math.hypot(at.x - cam.x, at.y - cam.y, at.z - cam.z);
      if (entity.kind === 'seat') consider(d, 'Sit', () => this.sit(index));
      else if (entity.interactive !== undefined && this.model.interactives?.items[entity.interactive]) {
        const item = this.model.interactives.items[entity.interactive]!;
        // A leaf's reach is measured from its middle, not its foot: a tall door is reached at head height.
        const mid = Math.hypot(at.x - cam.x, at.y + 1 - cam.y, at.z - cam.z);
        consider(Math.min(d, mid), this.ixPrompt(item, entity.interactive), () => this.toggleInteractive(entity.interactive!));
      } else consider(d, this.openDoorLeaves.has(index) ? 'Close door' : 'Open door', () => this.toggleDoorLeaf(index));
    });

    this.model.doorCandidates.forEach((cand, index) => {
      if (this.sizePct < cand.requiredSize || !this.world) return;
      const at = placedPoint({ x: cand.x + 0.5, y: cand.y, z: cand.z + 0.5 }, this.model.dims, this.sizePct, this.rotation);
      const d = Math.hypot(at.x - cam.x, at.y - cam.y, at.z - cam.z);
      const id = `cand${index}`;
      consider(d, this.world.isDoorOpen(id) ? 'Close door' : 'Open door', () => this.toggleDoorCandidate(index, at));
    });

    this.nearestInteract = best;
    this.renderInteractHud();
  }

  private renderInteractHud(): void {
    if (!this.interactEl) return;
    this.interactEl.textContent = this.nearestInteract ? `[E] ${this.nearestInteract.label}` : '';
    this.interactEl.style.display = this.nearestInteract ? '' : 'none';
  }

  /** Board the nearest ride car within reach: the camera follows it (`applyRidingCamera`) until dismounted. */
  private board(entityIndex: number): void {
    const entity = this.model.entities[entityIndex];
    if (!entity || entity.coasterRouteIndex === undefined || entity.coasterCarIndex === undefined) return;
    this.riding = { routeIndex: entity.coasterRouteIndex, slot: entity.coasterCarIndex, entityIndex, restore: this.state, restoreYaw: this.yaw, restorePitch: this.pitch };
    this.onStatus(`Boarded ${entity.label} — ${RIDE_INTERACT_TEXT.toLowerCase()}. Sneak (Shift) to dismount.`, 'success');
  }

  /** Sit at a static (non-coaster) seat: parks the camera there, no ride motion. */
  private sit(entityIndex: number): void {
    this.sitting = { entityIndex, restore: this.state, restoreYaw: this.yaw, restorePitch: this.pitch };
    this.onStatus('Seated. Sneak (Shift) to get up.', 'success');
  }

  /** Leave a car or seat, restoring exactly the player state from before boarding. */
  private dismount(): void {
    const saved = this.riding ?? this.sitting;
    if (!saved) return;
    this.state = saved.restore; this.prevState = saved.restore;
    this.yaw = saved.restoreYaw; this.pitch = saved.restorePitch;
    this.riding = null; this.sitting = null;
  }

  // ── Pinball: play the table a pack ships ────────────────────────────────

  /**
   * Board the console: run the SAME `createPinballSim` the device does (never
   * copied — imported straight off `pinball-physics.ts`) over the pack's own
   * `CONFIG.sim`, and take over the camera and flipper/plunger controls until
   * `leavePinball`. The player's own position is frozen (not teleported into
   * the table) so a walk back out lands exactly where boarding happened.
   */
  private enterPinball(): void {
    const cfg = this.model.pinball, idx = this.pinballIndices;
    if (!cfg || !idx) return;
    const restoreView = { showReach: this.showReach, collider: this.legend.collider.show, tread: this.legend.tread.show, model: this.legend.model.show };
    this.pinball = { sim: createPinballSim(cfg.sim), restore: { state: this.state, yaw: this.yaw, pitch: this.pitch }, restoreView };
    // The reach overlay and the raw collider/tread debug boxes answer the
    // wrong question for a table nobody walks on: a pinball playfield's own
    // surfaces read almost entirely "not reached" (nothing here is meant to
    // be stood on), which paints the whole shell red and hides it. Force
    // them off and the full-detail model ON for the duration of the game,
    // whatever the user had toggled; `leavePinball` restores it exactly.
    this.showReach = false;
    this.legend = { ...this.legend, collider: { ...this.legend.collider, show: false }, tread: { ...this.legend.tread, show: false }, model: { ...this.legend.model, show: true } };
    this.applyLegendVisibility();
    this.updatePinballEntities();
    this.setPinballTouchVisible(true);
    this.renderHud();
    // A locked pointer has no screen position: release it so a click picks a half.
    if (document.pointerLockElement) document.exitPointerLock?.();
    this.onStatus(`Playing pinball — ${cfg.label}. Click / tap the left or right half for that flipper (a press while the ball waits launches it), or A/D, Left/Right, W both, hold Space to charge; Shift or Esc to leave.`, 'success');
  }

  /** Leave the table, restoring exactly the player state and the reach/collider/tread/model view from before boarding. The ball/flippers stay where the game left them. */
  private leavePinball(): void {
    if (!this.pinball) return;
    this.state = this.pinball.restore.state; this.prevState = this.state;
    this.yaw = this.pinball.restore.yaw; this.pitch = this.pinball.restore.pitch;
    const rv = this.pinball.restoreView;
    this.showReach = rv.showReach;
    this.legend = { ...this.legend, collider: { ...this.legend.collider, show: rv.collider }, tread: { ...this.legend.tread, show: rv.tread }, model: { ...this.legend.model, show: rv.model } };
    this.applyLegendVisibility();
    this.pinball = null;
    this.setPinballTouchVisible(false);
    this.renderHud();
  }

  /** A/D or Left/Right work one flipper each, W (or the touch "Interact"-style hold buttons) works both; Space holds to charge the plunger and fires on release; Shift or Escape leaves (Escape is also wired directly in the key handler). */
  private pinballInputForTick(): { left: boolean; right: boolean; launch: boolean; leave: boolean } {
    const k = this.keys;
    const both = k.has('KeyW') || k.has('ArrowUp');
    return {
      left: both || k.has('KeyA') || k.has('ArrowLeft') || this.touchPinball.left,
      right: both || k.has('KeyD') || k.has('ArrowRight') || this.touchPinball.right,
      launch: k.has('Space') || this.touchPinball.launch,
      leave: k.has('ShiftLeft') || k.has('ShiftRight'),
    };
  }

  /** One 0.05 s tick of the table's own simulation, called from the walk's existing 20 Hz accumulator (`tick()`) — no separate accumulator needed. */
  private tickPinball(): void {
    const pb = this.pinball;
    if (!pb) return;
    const input = this.pinballInputForTick();
    if (input.leave) { this.leavePinball(); return; }
    const events = pb.sim.step({ left: input.left, right: input.right, launch: input.launch }, 1 / TICKS_PER_SECOND);
    for (const ev of events) if (ev.kind === 'over' && typeof ev.score === 'number' && ev.score > this.pinballBest) this.pinballBest = ev.score;
    this.updatePinballEntities();
  }

  /**
   * Move the ball and swing the flippers to match the sim's current state,
   * mapping the sim's plane exactly as `pinballRuntime` does (`pinballPlanePoint`
   * + `ballOffset`) but through the WALK's own quarter-turn placement
   * (`placedPoint`/`placedDirection`) rather than the runtime's raw
   * continuous-rotation `toWorld` — the walk's world is laid out with the same
   * corner-preserving turn as every other entity here, and using the runtime's
   * own origin/rotation convention would put the table adrift from its shell
   * at any turn but 0.
   */
  private updatePinballEntities(): void {
    const cfg = this.model.pinball, idx = this.pinballIndices, pb = this.pinball;
    if (!cfg || !idx || !pb) return;
    const { dims } = this.model, { sizePct, rotation } = this;
    const st = pb.sim.state;

    const ballModel = pinballPlanePoint(cfg.map, st.u, st.w, cfg.ballH);
    const ballWorld = placedPoint({ x: ballModel.x + cfg.ballOffset[0], y: ballModel.y + cfg.ballOffset[1], z: ballModel.z + cfg.ballOffset[2] }, dims, sizePct, rotation);
    this.moveEntityHolder(idx.ball, ballWorld, 0);

    const floorH = cfg.ballH - cfg.sim.ballRadius;
    const axis = placedDirection({ x: cfg.map.n[0], y: cfg.map.n[1], z: cfg.map.n[2] }, dims, sizePct, rotation);
    const axisVec = new THREE.Vector3(axis.x, axis.y, axis.z);
    if (axisVec.lengthSq() > 1e-12) axisVec.normalize();
    cfg.sim.flippers.forEach((f, i) => {
      const entityIndex = idx.flippers[i];
      if (entityIndex === undefined) return;
      const pivotWorld = placedPoint(pinballPlanePoint(cfg.map, f.pivot[0], f.pivot[1], floorH), dims, sizePct, rotation);
      this.pinballFlipperPivots.set(entityIndex, pivotWorld);
      const angleRad = (cfg.restAngles[i]! - st.flipperAngles[i]!) * cfg.spinSign;
      this.applyPinballFlipperSpin(entityIndex, pivotWorld, axisVec, angleRad);
    });
  }

  /**
   * Swing a flipper's WHOLE holder (every cube in the compiled entity hangs
   * off the same `pb_untilt` bone, per `flipperRig`'s tilt -> spin -> untilt
   * chain) by `angleRad` about `axis` through `pivot`, relative to its
   * UN-SPUN placed pose: this is exactly what the bone chain computes (tilt
   * and untilt cancel at zero spin and conjugate the spin's local-Y rotation
   * into a rotation about the world playfield normal through the shared
   * pivot — see the derivation in the task's own working notes / this
   * module's tests), without rebuilding the entity's per-cube instance
   * matrices every tick.
   */
  private applyPinballFlipperSpin(entityIndex: number, pivot: { x: number; y: number; z: number }, axis: THREE.Vector3, angleRad: number): void {
    const holder = this.entityHolders.get(entityIndex);
    const base = this.pinballFlipperBase.get(entityIndex);
    if (!holder || !base || axis.lengthSq() < 1e-12) return;
    const q = new THREE.Quaternion().setFromAxisAngle(axis, angleRad);
    const pivotVec = new THREE.Vector3(pivot.x, pivot.y, pivot.z);
    holder.position.copy(base.pos.clone().sub(pivotVec).applyQuaternion(q).add(pivotVec));
    holder.quaternion.copy(q.clone().multiply(base.quat));
  }

  /** The fixed spectator camera the real runtime uses while a player is seated: `toWorld(cameraEye)` looking at `toWorld(cameraLook)`. */
  private applyPinballCamera(): void {
    const cfg = this.model.pinball;
    if (!cfg) return;
    const { dims } = this.model, { sizePct, rotation } = this;
    const eye = placedPoint({ x: cfg.cameraEye[0], y: cfg.cameraEye[1], z: cfg.cameraEye[2] }, dims, sizePct, rotation);
    const look = placedPoint({ x: cfg.cameraLook[0], y: cfg.cameraLook[1], z: cfg.cameraLook[2] }, dims, sizePct, rotation);
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.lookAt(look.x, look.y, look.z);
  }

  /** The HUD's bottom-line status while playing: ball/score/best, and the phase (charge bar or game over). */
  private pinballHudLine(): string {
    if (!this.pinball) return '';
    const st = this.pinball.sim.state;
    const base = `Ball ${st.ball}/${st.balls} · ${Math.round(st.score)} · best ${Math.round(this.pinballBest)}`;
    if (st.phase === 'over') return `${base} — GAME OVER, Space for a new game`;
    if (st.phase === 'ready') return `${base} — hold Space to charge ${'|'.repeat(Math.round(st.charge * 10))}`;
    return `${base} — A/D flippers, W both, Shift/Esc leave`;
  }

  /** Swap the touch overlay: the movement stick while walking, big flipper/plunger/leave buttons while playing. No-op off-touch. */
  private setPinballTouchVisible(on: boolean): void {
    if (!this.isTouch) return;
    this.pinballTouchEl.style.display = on ? '' : 'none';
    this.touchMoveEl.style.display = on ? 'none' : '';
  }

  /**
   * Rotate a door LEAF entity's own holder ±90° about its placed origin. A
   * cosmetic swing, not a hinge-accurate one: the compiler does not hand the
   * preview a hinge-edge pivot, so this turns the leaf about whatever point
   * its geometry origin sits at. # TODO: read the leaf's actual hinge offset
   * once bedrock-placement-pack.ts exposes one.
   */
  private toggleDoorLeaf(entityIndex: number): void {
    const entity = this.model.entities[entityIndex];
    if (!entity) return;
    const open = !this.openDoorLeaves.has(entityIndex);
    if (open) this.openDoorLeaves.add(entityIndex); else this.openDoorLeaves.delete(entityIndex);
    const holder = this.entityHolders.get(entityIndex);
    const base = (entity.yaw + this.rotation * 90) * Math.PI / 180;
    if (holder) holder.rotation.y = open ? base + Math.PI / 2 : base;
    const marker = this.markerByIndex.get(entityIndex);
    if (marker) marker.mesh.rotation.y = open ? -base - Math.PI / 2 : -base;
  }

  /** The Interact prompt for a moving part in its current state. */
  private ixPrompt(item: InteractiveRuntimeItem, index: number): string {
    const noun = item.kind === 'turnable' ? 'Turn' : item.kind === 'lever' ? 'Flip lever' : `${this.ixOpen.get(index) ? 'Close' : 'Open'} ${item.label.replace(/ \d+$/, '').toLowerCase()}`;
    return noun;
  }

  /**
   * Toggle a moving part exactly as `scripts/interactives.js` does: a
   * turnable turns a step; anything else opens or closes, a double door's
   * leaves together (`pairs`). A doorway lays its closed cells over the
   * static colliders while closed (`ixClosedBlocks`, the runtime's own
   * `layDoorway` state) and stays blocked when opened at a size where the
   * opening is under the player's 1 x 2-block passage - said in the status.
   * It will not close on the player.
   */
  toggleInteractive(index: number): void {
    const cfg = this.model.interactives, item = cfg?.items[index];
    if (!cfg || !item) return;
    if (item.kind === 'turnable') {
      this.ixTarget.set(index, (this.ixTarget.get(index) ?? 0) + item.angle);
      this.onStatus(`${item.label} turned ${Math.abs(item.angle)} degrees.`, 'info');
      return;
    }
    const open = !this.ixOpen.get(index);
    const group = [index, ...(item.pairs ?? [])];
    if (!open && this.world && item.blocking.length) {
      // Never close a door on the player: the runtime refuses the same way.
      const f = this.sizePct / 100;
      const blocks = ixWorldBlocks(group.flatMap(i => cfg.items[i]?.blocking ?? []), this.model.dims, f, this.rotation);
      const p = this.state, w = 0.3;
      for (const [key, [lo, hi]] of blocks) {
        const [x, y, z] = key.split(',').map(Number) as [number, number, number];
        if (p.x + w > x && p.x - w < x + 1 && p.z + w > z && p.z - w < z + 1 && p.y + PLAYER_HEIGHT > y + lo / 16 && p.y < y + hi / 16) {
          this.onStatus(`You are standing in the ${item.label.toLowerCase()} - step out to close it.`, 'error');
          return;
        }
      }
    }
    for (const i of group) {
      if (!cfg.items[i]) continue;
      this.ixOpen.set(i, open);
      this.ixTarget.set(i, open ? cfg.items[i]!.angle : 0);
    }
    this.applyInteractiveColliders();
    const tooSmall = open && item.passSize !== undefined && !(item.passSize > 0 && this.sizePct >= item.passSize);
    if (tooSmall) {
      const size = item.opening ? `${item.opening.width} x ${item.opening.height} blocks at 100 %` : 'too small';
      this.onStatus(item.passSize ? `${item.label} is open, but its opening is ${size}: too small to walk through at ${this.sizePct} %. Pick ${item.passSize} % or larger to pass.` : `${item.label} is open, but its opening is ${size}: too small to walk through at any wand size.`, 'error');
    } else this.onStatus(`${item.label} ${item.kind === 'lever' ? (open ? 'flipped' : 'flipped back') : open ? 'opened' : 'closed'}${open && item.passSize ? ' - walk through' : ''}.`, 'info');
  }

  /** Lay the closed doorways over the walk world and redraw them (the static collider boxes are drawn once per rebuild). */
  private applyInteractiveColliders(): void {
    const cfg = this.model.interactives;
    if (!cfg) return;
    const f = this.sizePct / 100;
    const closed = ixClosedBlocks(cfg.items, this.model.dims, f, this.rotation, i => this.ixOpen.get(i) === true);
    this.world?.setOverlayBlocks(closed);
    if (this.ixColliderMesh) { this.worldGroup.remove(this.ixColliderMesh); (this.ixColliderMesh.material as THREE.Material).dispose(); this.ixColliderMesh = null; }
    if (!closed.size) return;
    const mat = new THREE.MeshStandardMaterial({ color: LEGEND_COLOR.door, roughness: 0.8, transparent: true, opacity: 0.55, emissive: new THREE.Color(LEGEND_COLOR.door), emissiveIntensity: 0.2 });
    const mesh = new THREE.InstancedMesh(this.unitBox, mat, closed.size);
    const m = new THREE.Matrix4();
    let i = 0;
    for (const [key, [lo, hi]] of closed) {
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      m.makeScale(1, (hi - lo) / 16, 1);
      m.setPosition(x + 0.5, y + (lo + hi) / 32, z + 0.5);
      mesh.setMatrixAt(i++, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = 'colliders-doors';
    mesh.visible = this.legend.collider.show;
    this.ixColliderMesh = mesh;
    this.worldGroup.add(mesh);
  }

  /** Ease every moving part toward its target angle (the client's Molang rate) and swing its holder about the hinge. */
  private updateInteractives(dtSeconds: number): void {
    const cfg = this.model.interactives;
    if (!cfg) return;
    const { sizePct, rotation } = this, dims = this.model.dims;
    for (const [index, target] of this.ixTarget) {
      const item = cfg.items[index];
      const shown = this.ixShown.get(index) ?? 0;
      if (!item || Math.abs(shown - target) < 1e-3) continue;
      const rate = Math.max(Math.abs(item.angle), 1) / SWING_SECONDS;
      const next = shown + Math.max(-rate * dtSeconds, Math.min(rate * dtSeconds, target - shown));
      this.ixShown.set(index, next);
      const entityIndex = this.ixEntity.get(index), base = this.ixBase.get(index);
      const holder = entityIndex !== undefined ? this.entityHolders.get(entityIndex) : undefined;
      if (!holder || !base || !item.pivot || !item.axis) continue;
      const pivot = placedPoint({ x: item.pivot[0], y: item.pivot[1], z: item.pivot[2] }, dims, sizePct, rotation);
      const a = placedDirection({ x: item.axis[0], y: item.axis[1], z: item.axis[2] }, dims, sizePct, rotation);
      const axis = new THREE.Vector3(a.x, a.y, a.z);
      if (axis.lengthSq() < 1e-12) continue;
      axis.normalize();
      if (item.slide) {
        // A drawer, a roller or sliding door: it moves along the axis by the eased distance.
        holder.position.copy(base.pos.clone().add(axis.clone().multiplyScalar(next * item.slide * sizePct / 100)));
        holder.quaternion.copy(base.quat);
        continue;
      }
      // A positive angle is a right-handed turn about the axis (bedrock-interactives.ts `interactiveRig`).
      const q = new THREE.Quaternion().setFromAxisAngle(axis, next * Math.PI / 180);
      const p = new THREE.Vector3(pivot.x, pivot.y, pivot.z);
      holder.position.copy(base.pos.clone().sub(p).applyQuaternion(q).add(p));
      holder.quaternion.copy(q.clone().multiply(base.quat));
    }
  }

  /**
   * Toggle a vanilla door candidate's collision (`WalkWorld.setDoorOpen`): an
   * approximation stated in that method's own doc, not hidden — it drops the
   * whole column's colliders in the opening's height band, which is sound at
   * a door candidate (the wand only proposes one where the opening is
   * exactly door sized). The rendered grey collider boxes do not yet redraw
   * when a door opens; only collision does. # TODO: repaint them too.
   */
  private toggleDoorCandidate(index: number, at: { x: number; y: number; z: number }): void {
    if (!this.world) return;
    const id = `cand${index}`;
    const open = !this.world.isDoorOpen(id);
    this.world.setDoorOpen(id, at.x, at.z, at.y, open);
    this.onStatus(open ? 'Door opened — walk through.' : 'Door closed.', 'info');
  }

  /** The camera while riding a car: the rider's eye through the car's own frame (`coasterCarEyePoint`), the pack's own seat offset when it measured one. */
  private applyRidingCamera(): void {
    if (!this.riding) return;
    const car = this.carWorld.get(this.riding.entityIndex);
    if (!car) return;
    const route = this.model.routes[this.riding.routeIndex];
    const type = route?.cars.slots?.[this.riding.slot]?.type;
    const seat = type ? this.model.coasterTypes[type]?.seat : undefined;
    const [ex, ey, ez] = coasterCarEyePoint(car.frame, seat);
    const eye = placedPoint({ x: ex, y: ey, z: ez }, this.model.dims, this.sizePct, this.rotation);
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = car.yawDeg * Math.PI / 180;
    this.camera.rotation.x = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, -car.frame.pitch * Math.PI / 180));
  }

  /** The camera while sitting at a static seat: parked at the seat's own placed point, facing its yaw. */
  private applySittingCamera(): void {
    if (!this.sitting) return;
    const entity = this.model.entities[this.sitting.entityIndex];
    if (!entity) return;
    const at = placedPoint(entity, this.model.dims, this.sizePct, this.rotation);
    this.camera.position.set(at.x, at.y + PLAYER_HEIGHT - 0.53, at.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = (entity.yaw + this.rotation * 90) * Math.PI / 180;
    this.camera.rotation.x = 0;
  }

  private buildReach(surfaces: ReachSurface[]): void {
    if (!surfaces.length) return;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
    const mesh = new THREE.InstancedMesh(this.plateGeom, mat, surfaces.length);
    const m = new THREE.Matrix4(), good = new THREE.Color(COLOR_REACHED), bad = new THREE.Color(COLOR_UNREACHED);
    surfaces.forEach((s, i) => {
      m.makeTranslation(s.x + 0.5, s.t / 16 + 0.025, s.z + 0.5);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, s.reached ? good : bad);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = 'reach';
    this.reachGroup.add(mesh);
  }

  private buildEntities(f: number): void {
    this.clearGroup(this.entityGroup);
    this.labelLayer.replaceChildren();
    this.markers = [];
    this.targets = [];
    this.markerByIndex.clear();
    const { model } = this;
    const laidHeight = this.laidDims.height;
    const beamGeom = new THREE.CylinderGeometry(0.06, 0.06, 1, 6, 1, true);
    this.disposables.push(beamGeom);
    const addMarker = (entity: AddonEntity, index: number): void => {
      const kind = entity.kind;
      const legend = legendKindOf(kind);
      const [bw, bh, bd] = MARKER_SIZE[kind];
      const s = SCALES_WITH_SIZE.has(kind) ? f : 1;
      const at = placedPoint(entity, model.dims, this.sizePct, this.rotation);
      const color = KIND_COLOR[kind];
      const geom = kind === 'figure' ? new THREE.CapsuleGeometry(0.3, 1.2, 4, 10) : new THREE.BoxGeometry(bw * s, bh * s, bd * s);
      const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.6, transparent: true, opacity: 0.85 }));
      const height = bh * s;
      mesh.position.set(at.x, at.y + height / 2, at.z);
      mesh.rotation.y = -entity.yaw * Math.PI / 180;
      mesh.userData['index'] = index;
      // Real geometry (buildModel) already draws this entity: the solid
      // marker would just be a translucent box floating over it, which is the
      // "capsule markers instead of the pack's own model" complaint. Keep the
      // beam and label (still useful for finding it, and clicking "go" on a
      // NOT-reachable verdict) but hide the placeholder shape.
      const hasRealGeometry = !!model.appearance?.byType.has(entity.typeId);
      // A translucent beam from the ground through the marker: the location, visible through walls when highlighted.
      const beam = new THREE.Mesh(beamGeom, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthTest: false }));
      const beamTop = Math.max(at.y + height + 4, laidHeight + 2);
      beam.scale.set(1, beamTop, 1);
      beam.position.set(at.x, beamTop / 2, at.z);
      beam.visible = false;
      beam.renderOrder = 10;
      this.entityGroup.add(mesh, beam);
      const label = document.createElement('div');
      label.className = 'ap-label';
      label.style.borderColor = hex(color);
      label.textContent = entity.label;
      this.labelLayer.appendChild(label);
      const marker: Marker = { entity, legend, mesh, beam, label, at: new THREE.Vector3(at.x, at.y, at.z), height, reach: null, hasRealGeometry };
      this.markers.push(marker);
      if (index >= 0) this.markerByIndex.set(index, marker);
      // Reach verdict per entity (asked of the worker): can a player on foot stand within a block of where this actor's feet are?
      if (legend && (kind === 'figure' || kind === 'seat' || kind === 'door' || kind === 'vehicle')) {
        this.targets.push({ label: entity.label, kind: legend, point: { x: entity.x, y: entity.y, z: entity.z }, reach: null, world: new THREE.Vector3(at.x, at.y, at.z), labelEl: label, labelText: entity.label });
      }
    };
    model.entities.forEach((e, i) => { if (e.kind !== 'shell' && entitySpawnsAt(e, this.sizePct)) addMarker(e, i); });
    // Runtime door candidates: vanilla doors the wand hangs once the opening is big enough.
    model.doorCandidates.forEach((d, i) => {
      if (this.sizePct < d.requiredSize) return;
      addMarker({ typeId: `door-candidate-${i}`, label: `Vanilla door ${i + 1} (from ${d.requiredSize} %)`, kind: 'door', x: d.x + 0.5, y: d.y, z: d.z + 0.5, yaw: 0 }, -1);
    });
    // The pin marker: the model's corner, where the wand's origin is.
    const pin = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    pin.position.set(0, 0.18, 0);
    this.entityGroup.add(pin);
  }

  private buildRoutes(): void {
    this.clearGroup(this.routeGroup);
    const { model } = this;
    const beamGeom = new THREE.CylinderGeometry(0.08, 0.08, 1, 6, 1, true);
    this.disposables.push(beamGeom);
    const laidHeight = this.laidDims.height;
    const toWorld = (p: readonly [number, number, number]): THREE.Vector3 => {
      const q = placedPoint({ x: p[0], y: p[1], z: p[2] }, model.dims, this.sizePct, this.rotation);
      return new THREE.Vector3(q.x, q.y, q.z);
    };
    model.routes.forEach((route, ri) => {
      const pts = route.points.map(toWorld);
      if (route.closed && pts.length) pts.push(pts[0]!.clone());
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: LEGEND_COLOR.track }));
      line.name = `route-${ri}`;
      this.routeGroup.add(line);
      // The station: the arc span the train brakes in, over the same samples, raised a hair so it wins the depth test.
      if (route.station) {
        const span = this.slice(route, route.station.start, route.station.end).map(toWorld).map(p => p.setY(p.y + 0.03));
        if (span.length > 1) this.routeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(span), new THREE.LineBasicMaterial({ color: COLOR_STATION, linewidth: 2 })));
        const stop = toWorld(route.station.point);
        this.addBeam(this.routeGroup, beamGeom, stop, Math.max(stop.y + 5, laidHeight + 2), COLOR_STATION);
        const stationLabel = this.addLabel(stop, `${route.label} station`, COLOR_STATION);
        this.targets.push({ label: `${route.label} station (boarding)`, kind: 'station', point: { x: route.station.point[0], y: route.station.point[1], z: route.station.point[2] }, reach: null, world: stop, labelEl: stationLabel, labelText: `${route.label} station` });
      }
      if (route.chain) {
        const span = this.slice(route, route.chain.start, route.chain.end).map(toWorld).map(p => p.setY(p.y + 0.03));
        if (span.length > 1) this.routeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(span), new THREE.LineBasicMaterial({ color: COLOR_CHAIN })));
      }
      if (route.lift) {
        const parked = toWorld(route.lift.parkedPoint);
        const delivered = toWorld([route.lift.parkedPoint[0] + route.lift.travel[0], route.lift.parkedPoint[1] + route.lift.travel[1], route.lift.parkedPoint[2] + route.lift.travel[2]]);
        const travel = new THREE.Line(new THREE.BufferGeometry().setFromPoints([parked, delivered]), new THREE.LineDashedMaterial({ color: KIND_COLOR.lift, dashSize: 0.6, gapSize: 0.4 }));
        travel.computeLineDistances();
        this.routeGroup.add(travel);
        let parkedLabel: HTMLDivElement | null = null;
        for (const [p, name] of [[parked, 'lift parked'], [delivered, 'lift delivered']] as const) {
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: KIND_COLOR.lift }));
          dot.position.copy(p);
          this.routeGroup.add(dot);
          const label = this.addLabel(p, `${route.label} ${name}`, KIND_COLOR.lift);
          if (name === 'lift parked') parkedLabel = label;
        }
        if (parkedLabel) this.targets.push({ label: `${route.label} lift (parked deck)`, kind: 'lift', point: { x: route.lift.parkedPoint[0], y: route.lift.parkedPoint[1], z: route.lift.parkedPoint[2] }, reach: null, world: parked, labelEl: parkedLabel, labelText: `${route.label} lift parked` });
        if (route.lift.counterweightPoint) {
          const cw = toWorld(route.lift.counterweightPoint);
          const cwEnd = toWorld([route.lift.counterweightPoint[0] - route.lift.travel[0], route.lift.counterweightPoint[1] - route.lift.travel[1], route.lift.counterweightPoint[2] - route.lift.travel[2]]);
          const cwLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([cw, cwEnd]), new THREE.LineDashedMaterial({ color: KIND_COLOR.counterweight, dashSize: 0.4, gapSize: 0.4 }));
          cwLine.computeLineDistances();
          this.routeGroup.add(cwLine);
        }
      }
      // Car slots: spacing along the track from the station stop, so a train's extent is visible even before a car marker is placed.
      if (route.cars.count > 1 && route.station) {
        for (let k = 0; k < route.cars.count; k++) {
          const arc = route.station.stop + route.cars.extent / 2 - k * route.cars.spacing;
          const p = this.pointAtArc(route, arc);
          if (!p) continue;
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), new THREE.MeshBasicMaterial({ color: KIND_COLOR.car }));
          dot.position.copy(toWorld(p));
          this.routeGroup.add(dot);
        }
      }
    });
  }

  /** The route's samples between two arc lengths (inclusive of the bracketing samples). */
  private slice(route: AddonRoute, a: number, b: number): Array<[number, number, number]> {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const out: Array<[number, number, number]> = [];
    for (let i = 0; i < route.points.length; i++) {
      const c = route.cumulative[i] ?? 0;
      if (c >= lo - 1e-9 && c <= hi + 1e-9) out.push(route.points[i]!);
    }
    return out;
  }

  /** Linear interpolation along the route at an arc length (wrapping on a closed route). */
  private pointAtArc(route: AddonRoute, arc: number): [number, number, number] | null {
    const L = route.length || route.cumulative[route.cumulative.length - 1] || 0;
    if (!L) return null;
    const s = route.closed ? ((arc % L) + L) % L : Math.max(0, Math.min(L, arc));
    for (let i = 1; i < route.points.length; i++) {
      const c0 = route.cumulative[i - 1]!, c1 = route.cumulative[i]!;
      if (s <= c1) {
        const t = c1 > c0 ? (s - c0) / (c1 - c0) : 0;
        const p = route.points[i - 1]!, q = route.points[i]!;
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
      }
    }
    return route.points[route.points.length - 1] ?? null;
  }

  private addBeam(group: THREE.Group, geom: THREE.BufferGeometry, at: THREE.Vector3, top: number, color: number): THREE.Mesh {
    const beam = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, depthTest: false }));
    beam.scale.set(1, top, 1);
    beam.position.set(at.x, top / 2, at.z);
    beam.renderOrder = 10;
    group.add(beam);
    return beam;
  }

  private addLabel(at: THREE.Vector3, text: string, color: number): HTMLDivElement {
    const label = document.createElement('div');
    label.className = 'ap-label';
    label.textContent = text;
    label.style.borderColor = hex(color);
    label.style.color = hex(color);
    this.labelLayer.appendChild(label);
    // A label with no entity: a pseudo-marker so the projection loop places it.
    this.markers.push({ entity: { typeId: '', label: text, kind: 'other', x: 0, y: 0, z: 0, yaw: 0 }, legend: 'track', mesh: new THREE.Mesh(), beam: new THREE.Mesh(), label, at: at.clone(), height: 0.5, reach: null, hasRealGeometry: false });
    return label;
  }

  // ── Reach verdicts, off the main thread ─────────────────────────────────

  /**
   * Ask the worker whether a player on foot reaches each target at this size
   * and turn. The scene is already on screen; the HUD says the verdicts are
   * pending until they arrive, and a stale job (the size changed meanwhile)
   * is ignored by its id. Without a Worker the same code runs inline, deferred
   * a frame so the size change still paints first.
   */
  private requestVerdicts(): void {
    const id = ++this.reachJob;
    if (!this.targets.length || !this.world) { this.verdictNote = ''; return; }
    const req: ReachWorkerRequest = {
      id, cells: this.model.cells, dims: this.model.dims, sizePct: this.sizePct, rotation: this.rotation,
      treads: treadBlocksAt(this.model, this.sizePct, this.rotation),
      targets: this.targets.map((t): ReachTarget => ({ label: t.label, x: t.point.x, y: t.point.y, z: t.point.z })),
    };
    this.verdictNote = `checking ${req.targets.length} points on foot (reach walk + simulated player)…`;
    if (this.reachWorker === undefined) {
      try {
        this.reachWorker = new Worker(new URL('./addon-reach-worker.ts', import.meta.url), { type: 'module' });
        this.reachWorker.onmessage = (e: MessageEvent<ReachWorkerResponse>) => this.applyVerdicts(e.data);
        this.reachWorker.onerror = () => { this.reachWorker?.terminate(); this.reachWorker = null; this.requestVerdicts(); };
      } catch { this.reachWorker = null; }
    }
    if (this.reachWorker) { this.reachWorker.postMessage(req); return; }
    setTimeout(() => {
      if (id !== this.reachJob || !this.open) return;
      void import('./addon-reach-worker.js').then(({ answerReachRequest }) => this.applyVerdicts(answerReachRequest(req)));
    }, 16);
  }

  private applyVerdicts(res: ReachWorkerResponse): void {
    if (res.id !== this.reachJob || !this.open) return;
    if (res.error) { this.verdictNote = `verdicts unavailable: ${res.error}`; this.renderHud(); return; }
    res.results.forEach((reach, i) => {
      const t = this.targets[i];
      if (!t) return;
      t.reach = reach;
      t.labelEl.textContent = `${t.labelText} · ${reach.bfs ? 'reachable' : 'NOT reachable'}`;
      t.labelEl.style.color = hex(reach.bfs ? COLOR_REACHED : COLOR_UNREACHED);
    });
    this.verdictNote = `${res.results.length} points checked in ${(res.ms / 1000).toFixed(1)} s${this.reachWorker ? '' : ' (inline)'}`;
    this.renderHud();
  }

  /** Perimeter boxes per legend row, shown while that row's highlight is on. */
  private buildHighlights(): void {
    this.clearGroup(this.highlightGroup);
    for (const kind of LEGEND_KINDS) {
      const box = new THREE.Box3();
      let any = false;
      if (kind === 'collider' || kind === 'tread') {
        const mesh = this.worldGroup.getObjectByName(kind === 'collider' ? 'colliders' : 'treads') as THREE.InstancedMesh | undefined;
        if (mesh) { mesh.computeBoundingBox(); if (mesh.boundingBox) { box.copy(mesh.boundingBox); any = !box.isEmpty(); } }
      } else if (kind === 'track') {
        for (const child of this.routeGroup.children) if (child instanceof THREE.Line) { child.geometry.computeBoundingBox(); if (child.geometry.boundingBox) { box.union(child.geometry.boundingBox); any = true; } }
      } else {
        for (const mk of this.markers) if (mk.legend === kind && mk.entity.typeId) { box.expandByObject(mk.mesh); any = true; }
      }
      if (!any) continue;
      box.expandByScalar(0.25);
      const helper = new THREE.Box3Helper(box, new THREE.Color(LEGEND_COLOR[kind]));
      helper.name = `hl-${kind}`;
      (helper.material as THREE.LineBasicMaterial).depthTest = false;
      helper.renderOrder = 11;
      this.highlightGroup.add(helper);
    }
  }

  private applyLegendVisibility(): void {
    const { legend } = this;
    const drawn = this.worldGroup.getObjectByName('model'); if (drawn) drawn.visible = legend.model.show;
    const colliders = this.worldGroup.getObjectByName('colliders'); if (colliders) colliders.visible = legend.collider.show;
    const doorColliders = this.worldGroup.getObjectByName('colliders-doors'); if (doorColliders) doorColliders.visible = legend.collider.show;
    const treads = this.worldGroup.getObjectByName('treads'); if (treads) treads.visible = legend.tread.show;
    this.routeGroup.visible = legend.track.show;
    this.reachGroup.visible = this.showReach;
    for (const mk of this.markers) {
      const row = mk.legend;
      const show = row ? legend[row].show : true;
      // A row's "show" toggle still hides everything about that kind, real
      // geometry included (it is how a user isolates one legend row); the
      // placeholder shape ALSO stays hidden the rest of the time, since
      // buildModel already drew the real thing.
      mk.mesh.visible = show && !mk.hasRealGeometry;
      mk.beam.visible = show && !!row && legend[row].highlight;
      mk.label.style.display = show ? '' : 'none';
    }
    for (const kind of LEGEND_KINDS) {
      const h = this.highlightGroup.getObjectByName(`hl-${kind}`);
      if (h) h.visible = legend[kind].show && legend[kind].highlight;
    }
  }

  // ── Player ──────────────────────────────────────────────────────────────

  private respawn(): void {
    const sp = spawnPoint(this.laidDims);
    this.state = spawnState(this.world as WalkWorld, { x: sp.x, y: sp.y, z: sp.z });
    this.prevState = this.state;
    this.yaw = sp.yawDeg * Math.PI / 180;
    this.pitch = -0.08;
    this.accumulator = 0;
  }

  /** Put the player beside a target, in free-fly, so a NOT-reachable verdict can be inspected up close. */
  private goTo(t: Target): void {
    this.noclip = true;
    this.state = { ...this.state, x: t.world.x - 2, y: t.world.y + 1.2, z: t.world.z, vx: 0, vy: 0, vz: 0, onGround: false };
    this.prevState = this.state;
    this.yaw = Math.PI / 2 * 3; // face +x, toward the target
    this.pitch = -0.35;
    this.renderHud();
  }

  private inputForTick(): WalkInput {
    const k = this.keys;
    let fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) + this.touchMove.y;
    let side = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + this.touchMove.x;
    const mag = Math.hypot(fwd, side);
    if (mag > 1) { fwd /= mag; side /= mag; }
    // Camera yaw → world axes. Yaw 0 looks down −z (three's convention); +x is to the right.
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const move = { x: -sin * fwd + cos * side, z: -cos * fwd - sin * side };
    const jump = this.jumpQueued || k.has('Space') || this.touchJump;
    this.jumpQueued = false;
    return { move, jump, sneak: k.has('ShiftLeft') || k.has('ShiftRight') || this.touchSneak, sprint: k.has('ControlLeft') || k.has('ControlRight') || this.touchSprint };
  }

  private tick(): void {
    // Ride motion advances every tick regardless of the player: "riderless by default".
    this.updateCoasterAnimation();
    if (this.interactQueued) { this.interactQueued = false; this.nearestInteract?.act(); }
    const input = this.inputForTick();
    if (this.pinball) {
      this.tickPinball();
      this.prevState = this.state;
      return;
    }
    if (this.riding || this.sitting) {
      // Sneak dismounts instead of its usual meaning while boarded/seated.
      if (input.sneak) this.dismount();
      this.prevState = this.state;
      return;
    }
    this.prevState = this.state;
    if (this.world && !this.noclip) {
      this.state = tickPlayer(this.world, this.state, input).state;
      return;
    }
    // Free-fly: no collision, no gravity. Space rises, Shift sinks; sprint doubles the speed.
    const speed = (input.sprint ? 0.9 : 0.45);
    const up = (input.jump ? 1 : 0) - (input.sneak ? 1 : 0);
    const s = { ...this.state, tick: this.state.tick + 1 };
    s.x += input.move.x * speed; s.z += input.move.z * speed; s.y = Math.max(-2, s.y + up * speed);
    s.vx = 0; s.vy = 0; s.vz = 0; s.onGround = false; s.sneaking = input.sneak;
    this.state = s;
  }

  private readonly frame = (now: number): void => {
    if (!this.open) return;
    this.animId = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.accumulator += dt;
    const step = 1 / TICKS_PER_SECOND;
    let ticks = 0;
    while (this.accumulator >= step && ticks < 5) { this.tick(); this.accumulator -= step; ticks++; }
    if (this.riding) this.applyRidingCamera();
    else if (this.sitting) this.applySittingCamera();
    else if (this.pinball) this.applyPinballCamera();
    else {
      const alpha = Math.min(1, this.accumulator / step);
      const a = this.prevState, b = this.state;
      const eye = (b.sneaking && !this.noclip ? PLAYER_HEIGHT - 0.53 : PLAYER_HEIGHT - 0.18);
      this.camera.position.set(a.x + (b.x - a.x) * alpha, a.y + (b.y - a.y) * alpha + eye, a.z + (b.z - a.z) * alpha);
      this.camera.rotation.set(0, 0, 0);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;
    }
    this.updateInteractives(dt);
    this.updateInteract();
    const { renderer } = this.viewer;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
    this.placeLabels();
    this.updatePositionReadout();
  };

  private placeLabels(): void {
    const w = this.viewer.container.clientWidth, h = this.viewer.container.clientHeight;
    const v = new THREE.Vector3();
    const cam = this.camera.position;
    for (const mk of this.markers) {
      if (mk.label.style.display === 'none') continue;
      v.set(mk.at.x, mk.at.y + mk.height + 0.35, mk.at.z);
      const d = v.distanceTo(cam);
      const row = mk.legend;
      const highlighted = !!row && this.legend[row].highlight;
      if (d > (highlighted ? 400 : 28)) { mk.label.style.visibility = 'hidden'; continue; }
      v.project(this.camera);
      if (v.z > 1 || v.z < -1) { mk.label.style.visibility = 'hidden'; continue; }
      const x = (v.x + 1) / 2 * w, y = (1 - v.y) / 2 * h;
      if (x < -60 || x > w + 60 || y < -20 || y > h + 20) { mk.label.style.visibility = 'hidden'; continue; }
      mk.label.style.visibility = '';
      mk.label.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -100%)`;
      mk.label.style.opacity = highlighted ? '1' : String(Math.max(0.35, 1 - d / 28));
    }
  }

  private updatePositionReadout(): void {
    const el = this.hintEl;
    if (this.riding) { const c = this.camera.position; el.textContent = `riding · ${(this.carWorld.get(this.riding.entityIndex)?.frame.moving ? 'under way' : 'stopped')} · x ${c.x.toFixed(1)} y ${c.y.toFixed(2)} z ${c.z.toFixed(1)}`; return; }
    if (this.sitting) { el.textContent = 'seated'; return; }
    if (this.pinball) { el.textContent = this.pinballHudLine(); return; }
    const s = this.state;
    const f = this.sizePct / 100;
    el.textContent = `${this.noclip ? 'free-fly' : s.onGround ? 'on ground' : 'airborne'} · x ${s.x.toFixed(1)} y ${s.y.toFixed(2)} z ${s.z.toFixed(1)} (blocks from the pin at ${this.sizePct} %; ${(s.y / f).toFixed(2)} up at 100 %)`;
  }

  // ── DOM ─────────────────────────────────────────────────────────────────

  private buildDom(container: HTMLElement): void {
    ensureStyles();
    const root = document.createElement('div');
    root.className = 'ap-root';
    root.innerHTML = `
      <div class="ap-look" tabindex="0" aria-label="Add-on walk view"></div>
      <div class="ap-labels"></div>
      <div class="ap-crosshair"></div>
      <div class="ap-banner">Walks the <b>exact collider blocks</b> this pack lays at the chosen size and turn: unreachable here is unreachable in game. It does <b>not</b> prove Bedrock's rendering, entity culling, form text, ride physics or memory — a device round still decides those.</div>
      <div class="ap-interact"></div>
      <div class="ap-hud">
        <div class="ap-panel ap-legend"></div>
        <div class="ap-panel ap-size"></div>
        <div class="ap-panel ap-reach"></div>
        <div class="ap-panel ap-targets"></div>
      </div>
      <div class="ap-top">
        <button type="button" class="ap-btn" data-act="hud" title="Hide or show the panels (H)">Panels</button>
        <button type="button" class="ap-btn" data-act="respawn" title="Back to the start beside the model (R)">Respawn</button>
        <button type="button" class="ap-btn" data-act="fly" title="Free-fly through everything, no collision (F)">Free-fly</button>
        <button type="button" class="ap-btn ap-exit" data-act="exit" title="Leave the walk and return to the model">Exit walk</button>
      </div>
      <div class="ap-hint"></div>
      <div class="ap-keys">${this.isTouch ? 'Left pad: move · drag right side: look · buttons: jump / sneak / interact / sprint' : 'Click to look · WASD move · Space jump · E interact · Shift sneak/dismount · Ctrl sprint · F fly · R respawn · [ ] size · H panels · Esc release'}</div>
      <div class="ap-touch" ${this.isTouch ? '' : 'hidden'}>
        <div class="ap-stick"><div class="ap-knob"></div></div>
        <div class="ap-touch-btns">
          <button type="button" class="ap-tbtn ap-tbtn-interact" data-t="interact">Interact</button>
          <button type="button" class="ap-tbtn" data-t="jump">Jump</button>
          <button type="button" class="ap-tbtn" data-t="sneak">Sneak</button>
          <button type="button" class="ap-tbtn" data-t="sprint">Sprint</button>
        </div>
      </div>
      <div class="ap-pinball-touch" style="display:none">
        <button type="button" class="ap-tbtn ap-pb-left" data-pb="left">Left</button>
        <button type="button" class="ap-tbtn ap-pb-right" data-pb="right">Right</button>
        <button type="button" class="ap-tbtn ap-tbtn-interact ap-pb-launch" data-pb="launch">Launch</button>
        <button type="button" class="ap-tbtn ap-exit ap-pb-leave" data-pb="leave">Leave</button>
      </div>`;
    container.appendChild(root);
    this.root = root;
    this.lookLayer = root.querySelector('.ap-look')!;
    this.labelLayer = root.querySelector('.ap-labels')!;
    this.interactEl = root.querySelector('.ap-interact')!;
    this.hud = root.querySelector('.ap-hud')!;
    this.legendEl = root.querySelector('.ap-legend')!;
    this.sizeEl = root.querySelector('.ap-size')!;
    this.reachEl = root.querySelector('.ap-reach')!;
    this.targetsEl = root.querySelector('.ap-targets')!;
    this.hintEl = root.querySelector('.ap-hint')!;
    this.touchMoveEl = root.querySelector('.ap-touch')!;
    this.pinballTouchEl = root.querySelector('.ap-pinball-touch')!;
    this.wireInput();
    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(container);
    this.onResize();
  }

  private onResize(): void {
    const w = this.viewer.container.clientWidth || 1, h = this.viewer.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private on<K extends keyof HTMLElementEventMap>(el: HTMLElement | Document | Window, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions): void {
    el.addEventListener(type, fn as EventListener, opts);
    this.listeners.push(() => el.removeEventListener(type, fn as EventListener, opts));
  }

  private wireInput(): void {
    const look = this.lookLayer;
    // Mouse look: pointer lock on click (fine pointers); a plain drag looks around when the lock is refused or on touch.
    this.on(look, 'click', () => { if (!this.isTouch && !this.pinball && document.pointerLockElement !== look) look.requestPointerLock?.(); });
    this.on(document, 'mousemove', (e: MouseEvent) => {
      if (document.pointerLockElement !== look) return;
      this.turn(e.movementX, e.movementY);
    });
    let drag: { id: number; x: number; y: number } | null = null;
    // Pinball: a press on the left / right half of the view holds that
    // flipper, and a press while a ball waits charges the plunger (released on
    // lift) — the same screen halves the pack's tap zones give on the device.
    let pinballPress: { id: number; side: 'left' | 'right'; launch: boolean } | null = null;
    this.on(look, 'pointerdown', (e: PointerEvent) => {
      if (this.pinball) {
        const r = look.getBoundingClientRect();
        const side = e.clientX < r.left + r.width / 2 ? 'left' : 'right';
        const launch = this.pinball.sim.state.phase !== 'play';
        pinballPress = { id: e.pointerId, side, launch };
        this.touchPinball[side] = true;
        if (launch) this.touchPinball.launch = true;
        look.setPointerCapture(e.pointerId);
        return;
      }
      if (document.pointerLockElement === look) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      look.setPointerCapture(e.pointerId);
    });
    const endPinballPress = (e: PointerEvent): void => {
      if (!pinballPress || e.pointerId !== pinballPress.id) return;
      this.touchPinball[pinballPress.side] = false;
      if (pinballPress.launch) this.touchPinball.launch = false;
      pinballPress = null;
    };
    this.on(look, 'pointerup', endPinballPress);
    this.on(look, 'pointercancel', endPinballPress);
    this.on(look, 'pointermove', (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      this.turn((e.clientX - drag.x) * 1.6, (e.clientY - drag.y) * 1.6);
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    const endDrag = (e: PointerEvent): void => { if (drag && e.pointerId === drag.id) drag = null; };
    this.on(look, 'pointerup', endDrag);
    this.on(look, 'pointercancel', endDrag);

    // Keys: only while the walk is open and focus is not in a field; Escape closes when the pointer is free.
    this.on(window, 'keydown', (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.code === 'Escape') { if (this.pinball) { this.leavePinball(); e.preventDefault(); return; } if (!document.pointerLockElement) { this.close(); e.preventDefault(); } return; }
      if (e.code === 'KeyF') { this.toggleFly(); e.preventDefault(); return; }
      if (e.code === 'KeyR') { this.respawn(); e.preventDefault(); return; }
      if (e.code === 'KeyH') { this.toggleHud(); e.preventDefault(); return; }
      if (e.code === 'KeyE' && !e.repeat) { this.interactQueued = true; e.preventDefault(); return; }
      if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        const i = this.model.sizes.indexOf(this.sizePct) + (e.code === 'BracketRight' ? 1 : -1);
        const next = this.model.sizes[i];
        if (next !== undefined) this.setSize(next);
        e.preventDefault(); return;
      }
      if (e.code === 'Space' && !e.repeat) this.jumpQueued = true;
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    this.on(window, 'keyup', (e: KeyboardEvent) => { this.keys.delete(e.code); });
    this.on(window, 'blur', () => { this.keys.clear(); });

    // HUD buttons.
    this.on(this.root, 'click', (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!btn) return;
      const act = btn.dataset['act'];
      if (act === 'exit') this.close();
      else if (act === 'respawn') this.respawn();
      else if (act === 'fly') this.toggleFly();
      else if (act === 'hud') this.toggleHud();
      else if (act === 'size') this.setSize(Number(btn.dataset['size']));
      else if (act === 'turn') this.setSize(this.sizePct, Number(btn.dataset['turn']) as QuarterTurn);
      else if (act === 'reach') { this.showReach = !this.showReach; this.applyLegendVisibility(); this.renderHud(); }
      else if (act === 'show' || act === 'hl') {
        this.legend = toggleLegend(this.legend, btn.dataset['kind'] as LegendKind, act === 'show' ? 'show' : 'highlight');
        this.applyLegendVisibility(); this.renderHud();
      }
      else if (act === 'goto') { const t = this.targets[Number(btn.dataset['i'])]; if (t) this.goTo(t); }
    });

    // Touch: a virtual stick and hold buttons.
    const stick = this.root.querySelector('.ap-stick') as HTMLDivElement;
    const knob = this.root.querySelector('.ap-knob') as HTMLDivElement;
    let stickId: number | null = null;
    const setStick = (e: PointerEvent): void => {
      const r = stick.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width / 2 - 14;
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const m = Math.hypot(dx, dy);
      if (m > R) { dx *= R / m; dy *= R / m; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.touchMove = { x: dx / R, y: -dy / R };
    };
    this.on(stick, 'pointerdown', (e: PointerEvent) => { stickId = e.pointerId; stick.setPointerCapture(e.pointerId); setStick(e); e.preventDefault(); });
    this.on(stick, 'pointermove', (e: PointerEvent) => { if (e.pointerId === stickId) setStick(e); });
    const endStick = (e: PointerEvent): void => { if (e.pointerId !== stickId) return; stickId = null; this.touchMove = { x: 0, y: 0 }; knob.style.transform = ''; };
    this.on(stick, 'pointerup', endStick);
    this.on(stick, 'pointercancel', endStick);
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.ap-tbtn')) {
      const which = b.dataset['t'];
      const set = (on: boolean): void => {
        if (which === 'jump') { this.touchJump = on; if (on) this.jumpQueued = true; }
        else if (which === 'sneak') this.touchSneak = on;
        else if (which === 'sprint') this.touchSprint = on;
        else if (which === 'interact') { if (on) this.interactQueued = true; }
        b.classList.toggle('on', on);
      };
      this.on(b, 'pointerdown', (e: PointerEvent) => { set(true); b.setPointerCapture(e.pointerId); e.preventDefault(); });
      this.on(b, 'pointerup', () => set(false));
      this.on(b, 'pointercancel', () => set(false));
    }

    // Pinball touch controls: hold buttons for the flippers and the plunger, a tap to leave.
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.ap-pinball-touch [data-pb]')) {
      const which = b.dataset['pb'];
      if (which === 'leave') {
        this.on(b, 'pointerdown', (e: PointerEvent) => { this.leavePinball(); b.setPointerCapture(e.pointerId); e.preventDefault(); });
        continue;
      }
      const set = (on: boolean): void => {
        if (which === 'left') this.touchPinball.left = on;
        else if (which === 'right') this.touchPinball.right = on;
        else if (which === 'launch') this.touchPinball.launch = on;
        b.classList.toggle('on', on);
      };
      this.on(b, 'pointerdown', (e: PointerEvent) => { set(true); b.setPointerCapture(e.pointerId); e.preventDefault(); });
      this.on(b, 'pointerup', () => set(false));
      this.on(b, 'pointercancel', () => set(false));
    }
  }

  private turn(dx: number, dy: number): void {
    this.yaw -= dx * 0.0025;
    this.pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, this.pitch - dy * 0.0025));
  }

  private toggleFly(): void {
    if (!this.world) { this.onStatus(this.reachSummary, 'info'); return; }
    this.noclip = !this.noclip;
    if (!this.noclip) this.state = { ...this.state, vx: 0, vy: 0, vz: 0 };
    this.renderHud();
  }

  private toggleHud(): void {
    this.hudVisible = !this.hudVisible;
    this.hud.style.display = this.hudVisible ? '' : 'none';
  }

  private renderHud(): void {
    const { model } = this;
    const counts = legendCounts(model, this.sizePct, this.rotation);
    const rec = recommendedSize(model);
    const prov = model.provenance;
    const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
    this.legendEl.innerHTML = `
      <div class="ap-title">${esc(model.label)}${prov?.display ? ` <span class="ap-dim">${esc(prov.display)}</span>` : ''}</div>
      ${prov?.source?.file ? `<div class="ap-dim">${esc(prov.source.file)}${prov.source.hash ? ` · ${esc(prov.source.hash)}` : ''}${model.pack?.cuboids ? ` · ${model.pack.cuboids.toLocaleString()} cuboids / ${model.pack.entities} entities` : ''}</div>` : ''}
      <table class="ap-table">
        <thead><tr><th></th><th>kind</th><th class="ap-num">n</th><th></th><th>show</th><th>hl</th></tr></thead>
        <tbody>${LEGEND_KINDS.map(k => `
          <tr>
            <td><span class="ap-swatch" style="background:${hex(LEGEND_COLOR[k])}"></span></td>
            <td>${LEGEND_LABELS[k]}</td>
            <td class="ap-num">${counts[k].toLocaleString()}</td>
            <td class="ap-dim">${esc(counts.detail[k] ?? '')}</td>
            <td><button type="button" class="ap-tog ${this.legend[k].show ? 'on' : ''}" data-act="show" data-kind="${k}" aria-pressed="${this.legend[k].show}" title="Show or hide ${LEGEND_LABELS[k]}">${this.legend[k].show ? 'on' : 'off'}</button></td>
            <td><button type="button" class="ap-tog ${this.legend[k].highlight ? 'on' : ''}" data-act="hl" data-kind="${k}" aria-pressed="${this.legend[k].highlight}" title="Location beams and a perimeter box for ${LEGEND_LABELS[k]}">${this.legend[k].highlight ? 'on' : 'off'}</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="ap-row"><span class="ap-swatch" style="background:${hex(COLOR_REACHED)}"></span> reached <span class="ap-swatch" style="background:${hex(COLOR_UNREACHED)}"></span> not reached
        <button type="button" class="ap-tog ${this.showReach ? 'on' : ''}" data-act="reach" aria-pressed="${this.showReach}" title="Standable surfaces the reach walk from outside gets to (green) or not (red)">${this.showReach ? 'on' : 'off'}</button></div>
      ${model.notes.length ? `<div class="ap-notes">${model.notes.map(n => `<div>${esc(n)}</div>`).join('')}</div>` : ''}`;

    this.sizeEl.innerHTML = `
      <div class="ap-row ap-sizes">${model.sizes.map(s => `<button type="button" class="ap-tog ${s === this.sizePct ? 'on' : ''} ${rec?.sizePct === s ? 'rec' : ''}" data-act="size" data-size="${s}" title="${rec?.sizePct === s ? 'Recommended by the walk-through measurement' : `Re-lay the colliders at ${s} percent`}">${s}${rec?.sizePct === s ? ' <small>rec</small>' : ''}</button>`).join('')}<span class="ap-dim">%</span></div>
      <div class="ap-row">turn ${QUARTER_TURNS.map(r => `<button type="button" class="ap-tog ${r === this.rotation ? 'on' : ''}" data-act="turn" data-turn="${r}" title="The wand's quarter turn; tread plans differ per turn">${r}°</button>`).join('')}
        <span class="ap-dim">${this.laidDims.width}×${this.laidDims.height}×${this.laidDims.length} blocks</span></div>
      ${rec ? `<div class="ap-dim ap-reason"><b>Walk-through size: ${rec.sizePct !== null ? `${rec.sizePct} %` : 'none'}.</b> ${esc(rec.reason)}</div>` : '<div class="ap-dim">This pack carries no walk-through measurement.</div>'}`;

    this.reachEl.innerHTML = `<div>${esc(this.reachSummary)}</div>
      <div class="ap-dim">${this.noclip ? 'Free-fly: no collision, no gravity — reach claims do not apply to where you are.' : 'Walking: the player is the 0.6 × 1.8 box with Minecraft\'s jump and step.'}${this.treadCount && this.sizePct > 100 ? ` The ${this.treadCount} amber blocks are the invisible steps the pack lays at this size.` : ''}</div>`;

    const verdict = (t: Target): string => {
      if (!this.world) return '<span class="ap-dim">no walk at this size</span>';
      if (!t.reach) return '<span class="ap-dim">checking…</span>';
      if (t.reach.bfs) return `<span style="color:${hex(COLOR_REACHED)}">reachable</span>`;
      return `<span style="color:${hex(COLOR_UNREACHED)}">NOT reachable</span>${t.reach.refusal ? ` <span class="ap-dim">— ${esc(t.reach.refusal.detail)}</span>` : ''}`;
    };
    const order = { station: 0, lift: 1, seat: 2, door: 3, figure: 4, vehicle: 5, track: 6, model: 7, collider: 8, tread: 9 } as const;
    const sorted = this.targets.map((t, i) => ({ t, i })).sort((a, b) => order[a.t.kind] - order[b.t.kind]);
    this.targetsEl.innerHTML = `<div class="ap-title">Can a player get there on foot?</div>
      ${sorted.length ? sorted.map(({ t, i }) => `<div class="ap-target"><button type="button" class="ap-tog" data-act="goto" data-i="${i}" title="Fly to it">go</button> ${esc(t.label)}: ${verdict(t)}</div>`).join('') : `<div class="ap-dim">${this.world ? 'Nothing to test at this size.' : 'No walk at this size, so no verdicts.'}</div>`}
      ${this.verdictNote ? `<div class="ap-dim">${esc(this.verdictNote)}</div>` : ''}`;
    this.root.querySelector<HTMLButtonElement>('[data-act="fly"]')?.classList.toggle('on', this.noclip);
  }
}

// ─── Styles (scoped, injected once, so the lazy chunk carries its own look) ──

function ensureStyles(): void {
  if (document.getElementById('ap-styles')) return;
  const style = document.createElement('style');
  style.id = 'ap-styles';
  style.textContent = `
.ap-root{position:absolute;inset:0;z-index:20;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;color:#e4e4ef;overflow:hidden;touch-action:none}
.ap-look{position:absolute;inset:0;cursor:crosshair;outline:none;touch-action:none}
.ap-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.ap-label{position:absolute;left:0;top:0;padding:1px 6px;border:1px solid;border-radius:4px;background:rgba(8,10,18,.78);white-space:nowrap;font-size:11px;will-change:transform}
.ap-crosshair{position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;pointer-events:none;border:1px solid rgba(255,255,255,.55);border-radius:50%}
.ap-crosshair::after{content:"";position:absolute;left:6px;top:6px;width:2px;height:2px;background:#fff}
.ap-banner{position:absolute;left:8px;right:8px;top:8px;padding:6px 10px;border-radius:6px;background:rgba(124,58,237,.18);border:1px solid rgba(167,139,250,.45);font-size:11px;pointer-events:none}
.ap-interact{position:absolute;left:50%;bottom:34%;transform:translateX(-50%);padding:6px 14px;border-radius:20px;background:rgba(10,12,22,.85);border:1px solid rgba(250,204,21,.6);color:#fde68a;font-weight:600;font-size:13px;pointer-events:none;display:none;text-shadow:0 1px 2px #000}
.ap-hud{position:absolute;left:8px;top:58px;bottom:48px;width:min(360px,calc(100% - 16px));display:flex;flex-direction:column;gap:6px;overflow:auto;pointer-events:none}
.ap-panel{pointer-events:auto;padding:8px 10px;border-radius:8px;background:rgba(10,12,22,.82);border:1px solid rgba(255,255,255,.1);backdrop-filter:blur(4px)}
.ap-title{font-weight:600;margin-bottom:4px}
.ap-dim{opacity:.7}
.ap-reason{margin-top:4px}
.ap-table{border-collapse:collapse;width:100%}
.ap-table th{font-weight:500;opacity:.6;text-align:left;padding:0 4px 2px}
.ap-table td{padding:2px 4px;vertical-align:middle}
.ap-num{text-align:right;font-variant-numeric:tabular-nums}
.ap-swatch{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:middle;margin:0 3px 0 0}
.ap-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px}
.ap-sizes .ap-tog.rec{border-color:#facc15}
.ap-tog{min-width:34px;min-height:26px;padding:2px 8px;border-radius:4px;border:1px solid rgba(255,255,255,.18);background:transparent;color:#cfd3e6;cursor:pointer;font:inherit}
.ap-tog.on{background:#7c3aed;border-color:transparent;color:#fff}
.ap-tog small{font-size:9px;opacity:.9}
.ap-top{position:absolute;right:8px;top:58px;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.ap-btn{min-height:30px;padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(10,12,22,.85);color:#e4e4ef;cursor:pointer;font:inherit}
.ap-btn.on{background:#7c3aed;border-color:transparent}
.ap-exit{border-color:#f04747;color:#fca5a5}
.ap-hint{position:absolute;left:8px;bottom:26px;font-size:11px;opacity:.8;pointer-events:none;text-shadow:0 1px 2px #000}
.ap-keys{position:absolute;left:8px;right:8px;bottom:8px;font-size:11px;opacity:.6;pointer-events:none;text-shadow:0 1px 2px #000}
.ap-notes{margin-top:6px;font-size:11px;color:#faa61a}
.ap-target{margin:2px 0}
.ap-touch{position:absolute;inset:0;pointer-events:none}
.ap-stick{position:absolute;left:18px;bottom:56px;width:120px;height:120px;border-radius:50%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.25);pointer-events:auto;touch-action:none}
.ap-knob{position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:rgba(167,139,250,.6)}
.ap-touch-btns{position:absolute;right:14px;bottom:56px;display:flex;flex-direction:column;gap:10px;pointer-events:auto}
.ap-tbtn{width:70px;height:48px;border-radius:24px;border:1px solid rgba(255,255,255,.3);background:rgba(10,12,22,.75);color:#fff;font:inherit;touch-action:none}
.ap-tbtn.on{background:#7c3aed}
.ap-tbtn-interact{border-color:rgba(250,204,21,.6);color:#fde68a}
.ap-tbtn-interact.on{background:#a16207}
.ap-pinball-touch{position:absolute;inset:0;pointer-events:none}
.ap-pinball-touch .ap-tbtn{position:absolute;pointer-events:auto}
.ap-pb-left{left:18px;bottom:56px}
.ap-pb-right{left:98px;bottom:56px}
.ap-pb-launch{right:98px;bottom:56px;width:80px}
.ap-pb-leave{right:14px;bottom:130px}
@media (max-width:700px){.ap-banner{font-size:10px;padding:4px 8px}.ap-top{top:auto;bottom:auto;left:8px;right:8px;top:calc(8px + 5.5em);justify-content:space-between;gap:4px;z-index:3}.ap-btn{padding:3px 7px;font-size:11px;min-height:28px}.ap-hud{width:calc(100% - 16px);top:calc(8px + 5.5em + 36px);bottom:190px;z-index:2}.ap-keys{display:none}.ap-hint{bottom:8px;font-size:10px}}
`;
  document.head.appendChild(style);
}
