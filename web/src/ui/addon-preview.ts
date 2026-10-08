/**
 * The add-on WALK: a first-person, in-browser preview of a generated Bedrock
 * add-on, mounted over the LEGO tab's own Three.js renderer. It exists to
 * answer the questions that otherwise cost a 20-90 minute device round ("can
 * a player get to the station?", "does the door open and can I walk
 * through?", "what does the cockpit view look like at speed?") in seconds.
 *
 * ONE ENGINE. The world under the player is the headless simulator
 * (`web/src/sim`, docs/sim-engine.md) running in a module Worker over the
 * SAME `.mcaddon` bytes - the pack's own `placement.js` lays the blocks with
 * its wand, its `figures.js` walks the figures, its `coaster.js`, `rides.js`,
 * `interactives.js`, `vehicles.js` and `pinball.js` run unmodified, and the
 * core invariants are checked every tick (`addon-sim-worker.ts`). This module
 * is a RENDERER and an INPUT DEVICE over it: it draws every entity at the
 * simulator's pose through the pack's own client animations (gait, track
 * pitch, a door's swing, read from the RP's Molang: `addon-preview-data.ts`),
 * draws the blocks the runtime laid, sends the stick, Jump, the sneak toggle,
 * taps and holds, the hotbar slot and the look, and shows what the scripts
 * say (action bar, chat, titles, forms) and what the invariants raise. What
 * `scripts/sim.ts` reports and what this shows are the same tick
 * (`test/addon-walk.test.ts`, "the walker's tick equals scripts/sim.ts's").
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT. Everything the simulator models
 * (CLAUDE.md, the quirk registry): the integrator over the shipped blocks,
 * the scripts' behaviour, seats, dismounts, the camera the scripts ASK for.
 * It does not prove Bedrock's rendering, its entity culling, form text, the
 * client's camera easing and draw lag (package B of the engine plan draws
 * those; until then the camera is drawn RAW and the HUD says so), nor the
 * phone's own touch pick (package C; until then a tap is the crosshair and a
 * drag turns the look directly).
 *
 * The reach BFS (`engine/addon-walk.ts`) stays what it was: the pure
 * question "can a player on foot reach this surface?", computed off-thread
 * (`addon-reach-worker.ts`) over the shipped collider grid and drawn as the
 * green/red plates and the per-target verdicts.
 *
 * Division of labour: ui/addon-preview-data.ts owns reading the pack, the
 * legend arithmetic and the Molang (pure, unit-tested); ui/addon-sim-client.ts
 * the protocol; ui/addon-sim-worker.ts the simulator session; this module
 * owns everything visual - the scene, the holders, the markers and overlays,
 * the HUD, pointer lock, keys and the touch controls.
 *
 * Rendering reuses the viewer's WebGLRenderer with a scene of its own (the
 * pin frame: blocks from the placement's anchor), drawn by this module's own
 * frame loop while the viewer's OrbitControls are disabled. Loaded lazily
 * from lego.ts so the QA surface never grows the main chunk.
 */

import * as THREE from 'three';
import type { LDrawViewer } from '@viewer/ldraw/index.js';
import { BEDROCK_FACE_CORNERS, IDENTITY, bedrockFaceUv, cubeCorners, pivotRotation } from '@engine/bedrock-geometry-faces.js';
import { QUARTER_TURNS, type QuarterTurn, type ReachTarget } from '@engine/bedrock-collider-scale.js';
import type { PlacementRotation } from '@engine/bedrock-placement-pack.js';
import { ixWorldBlocks } from '@engine/bedrock-interactives.js';
import { COLLIDER_KIT } from '@engine/collider-form.js';
import { MINIFIG_GAIT } from '@engine/minifig-rig.js';
import type { AppearanceBone, AppearanceCube, AppearanceGroup } from './addon-appearance.js';
import type { ReachWorkerRequest, ReachWorkerResponse } from './addon-reach-worker.js';
import {
  classifyAddonEntity, defaultLegendState, entitySpawnsAt, evaluateClientAnimations, initializeClientAnimations, LEGEND_KINDS, LEGEND_LABELS, legendCounts, legendKindOf,
  placedPoint, recommendedSize, toggleLegend, treadBlocksAt,
  type AddonEntity, type AddonEntityKind, type AddonPreviewModel, type AddonRoute, type ClientAnimationSet, type LegendKind, type LegendState, type MolangEnv, type ReachSurface,
} from './addon-preview-data.js';
import {
  AddonSimClient, interpolatePose, SIM_TICK_MS, wrapDeg,
  type BlockChange, type EntityPose, type FormEvent, type ReadyInfo, type SimFrame, type SimLine, type WalkerInput,
} from './addon-sim-client.js';
import type { Violation } from '../sim/scenario/invariants.js';
import { quirkValue } from '../sim/quirks/registry.js';

/**
 * A geometry rotation (JSON degrees) about `pivot` as a three.js matrix: the
 * shared `pivotRotation` (bedrock-geometry-faces.ts), which accounts for the X
 * mirror the compiler writes the angles under. The preview used
 * `Euler(rx, -ry, -rz, 'ZYX')` until 2026-09-25 and drew every part turned
 * about X or Y at the wrong angle (76417's roof tiles stood out of the walls).
 */
function bedrockTurn(rx: number, ry: number, rz: number, px: number, py: number, pz: number): THREE.Matrix4 {
  const a = pivotRotation([rx, ry, rz], [px, py, pz]);
  return new THREE.Matrix4().set(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!, a[6]!, a[7]!, a[8]!, a[9]!, a[10]!, a[11]!, 0, 0, 0, 1);
}

// ─── Public surface ──────────────────────────────────────────────────────────

export interface AddonPreviewOptions {
  /** The LEGO tab's viewer: its renderer, container and controls are borrowed while the walk is open. */
  viewer: LDrawViewer;
  model: AddonPreviewModel;
  /** The `.mcaddon` itself: the simulator runs the pack from these bytes, exactly as shipped. */
  bytes: ArrayBuffer;
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
const COLOR_REACHED = 0x22c55e, COLOR_UNREACHED = 0xef4444, COLOR_STATION = 0xfde047, COLOR_CHAIN = 0xf97316, COLOR_BLOCK = 0x8b7f6a;
const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

/** Three.js material backed only by material evidence the loaded pack carries. */
export function addonAppearanceMaterial(chunk: Pick<AppearanceGroup, 'colorHex' | 'alpha' | 'surface'>, texture?: THREE.Texture): THREE.Material {
  const common = {
    // A texture supplies its own RGB; multiplying it by the parser's neutral
    // fallback grey would darken face artwork and alter its intended colour.
    color: texture ? 0xffffff : chunk.colorHex,
    flatShading: true,
    ...(texture ? { map: texture, alphaTest: 0.5, side: THREE.DoubleSide } : {}),
    ...(chunk.alpha < 1 ? { transparent: true, opacity: Math.max(0, Math.min(1, chunk.alpha)) } : {}),
  };
  if (!chunk.surface) return new THREE.MeshLambertMaterial(common);
  return new THREE.MeshStandardMaterial({
    ...common,
    metalness: chunk.surface.metalness,
    roughness: chunk.surface.roughness,
    ...(chunk.surface.emissive > 0 ? {
      emissive: texture ? 0xffffff : chunk.colorHex,
      emissiveIntensity: chunk.surface.emissive,
      ...(texture ? { emissiveMap: texture } : {}),
    } : {}),
  });
}

/** Build the one-face quads used by a face-atlas group in geometry-JSON space. */
export function faceDecalGeometry(
  tex: { width: number; height: number },
  cubes: ReadonlyArray<AppearanceCube>,
  bones: ReadonlyMap<string, THREE.Matrix4>,
): THREE.BufferGeometry | null {
  const positions: number[] = [], uvs: number[] = [];
  const v = new THREE.Vector3();
  for (const c of cubes) {
    const f = c.faceUv;
    if (!f || f.face === 'up' || f.face === 'down') continue;
    // The shared corner order (bit 0 = +x, bit 1 = +y, bit 2 = +z), with the
    // cube's own pivot rotation already applied (`cubeCorners`, the same call
    // the offline renderer and audits make): a per-face cube carries its own
    // pose like a box-UV cube, turned about its pivot BEFORE the bone.
    const corners = cubeCorners(c, IDENTITY);
    const faceCorners = BEDROCK_FACE_CORNERS[f.face];
    const bone = bones.get(c.bone) ?? new THREE.Matrix4();
    // Shared geometry-JSON order is CCW from outside the cube: north -Z,
    // south +Z, east -X and west +X. The holder's Z mirror has a negative
    // determinant; Three.js accounts for that when choosing WebGL winding and
    // transforming normals.
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const corner = faceCorners[k]!;
      v.set(...corners[corner]!).applyMatrix4(bone);
      positions.push(v.x, v.y, v.z);
      const uv = bedrockFaceUv(f, corner);
      uvs.push(uv[0] / tex.width, uv[1] / tex.height);
    }
  }
  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

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

/**
 * `query.modified_move_speed` per block per tick, measured on the Pixel 8 Pro
 * (minifig-rig.ts: 3.9 x blocks/tick, GameTest `gait_<id>`, 2026-09-25); the
 * gait's distance units are `MINIFIG_GAIT.unitsPerBlock` (3.88) from the same
 * probe. The walker feeds the pack's gait expressions these so its figures'
 * legs swing as the phone draws them.
 */
const MODIFIED_MOVE_SPEED_PER_BLOCK_TICK = 3.9;
/** How many chat lines the HUD log keeps. */
const LOG_LINES = 8;
/** How long an action-bar line stays on screen (the game's own fade), ms. */
const ACTIONBAR_MS = 3000;
/** Look sensitivity of a MOUSE: degrees per pixel of movement (a finger's pixels go to the simulator as they are). */
const MOUSE_DEG_PER_PX = 0.14;

interface Marker {
  entity: AddonEntity;
  legend: LegendKind | null;
  mesh: THREE.Mesh;
  beam: THREE.Mesh;
  label: HTMLDivElement;
  /** Pin-frame position of the marker's base (follows the simulator's entity once matched). */
  at: THREE.Vector3;
  height: number;
  /** `buildHolder` draws this entity's real geometry: keep the beam/label, hide the placeholder box/capsule. */
  hasRealGeometry: boolean;
  /** The simulator entity this placement actor became, once matched by type and placed point. */
  simId?: string;
}

interface Target {
  label: string;
  kind: LegendKind | 'station' | 'lift';
  /** Model blocks at 100 % (the frame `reachPoint` takes). */
  point: { x: number; y: number; z: number };
  /** Null until the verdict arrives from the reach worker. */
  reach: import('@engine/addon-walk.js').PointReach | null;
  world: THREE.Vector3;
  labelEl: HTMLDivElement;
  labelText: string;
}

/** A simulator entity drawn: its root (pin frame, yaw, scale, Z mirror), its bone groups and its animation state. */
interface EntityHolder {
  id: string;
  typeId: string;
  kind: AddonEntityKind;
  legend: LegendKind | null;
  root: THREE.Group;
  bones: Map<string, { group: THREE.Group; bone: AppearanceBone }>;
  anim: ClientAnimationSet | null;
  vars: Map<string, number>;
  /** Molang's view of the entity: when it was first seen, its last pose, the distance it walked, its speed. */
  molang: { firstMs: number; lastEvalMs: number; prev: { x: number; y: number; z: number; tick: number } | null; distance: number; speed: number; vy: number; dir: [number, number, number]; unknown: Set<string> };
}

/**
 * The blocks the runtime laid, as the boxes the player collides with: full
 * cubes stacked in a column arrive merged (`addon-sim-worker.ts`), a later
 * change inside a run splits it.
 */
class ColliderStore {
  readonly entries = new Map<string, BlockChange>();
  dirty = false;
  apply(changes: readonly BlockChange[]): void {
    for (const c of changes) {
      // A change at a block inside a merged run splits the run around it.
      for (const [key, run] of this.entries) {
        const box = run.boxes[0];
        if (!box || run.boxes.length !== 1 || box[4] <= 1 || run.x !== c.x || run.z !== c.z) continue;
        const top = run.y + box[4];
        if (c.y < run.y || c.y >= top) continue;
        this.entries.delete(key);
        if (c.y > run.y) this.entries.set(`${run.x},${run.y},${run.z}`, { ...run, boxes: [[0, 0, 0, 1, c.y - run.y, 1]] });
        if (c.y + 1 < top) this.entries.set(`${run.x},${c.y + 1},${run.z}`, { ...run, y: c.y + 1, boxes: [[0, 0, 0, 1, top - c.y - 1, 1]] });
      }
      const key = `${c.x},${c.y},${c.z}`;
      if (c.boxes.length) this.entries.set(key, c); else this.entries.delete(key);
    }
    this.dirty = true;
  }
  clear(): void { this.entries.clear(); this.dirty = true; }
}

class AddonWalk implements AddonPreviewHandle {
  open = false;
  private readonly viewer: LDrawViewer;
  private readonly model: AddonPreviewModel;
  private readonly bytes: ArrayBuffer;
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
  private readonly modelGroup = new THREE.Group();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly unitBox = new THREE.BoxGeometry(1, 1, 1);
  private readonly plateGeom = new THREE.BoxGeometry(0.92, 0.04, 0.92);

  // View state
  private sizePct: number;
  private rotation: QuarterTurn = 0;
  private legend: LegendState = defaultLegendState();
  private showReach = true;
  private hudVisible = !(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  private laidDims = { width: 1, height: 1, length: 1 };
  private markers: Marker[] = [];
  private targets: Target[] = [];
  private reachSummary = '';
  private treadCount = 0;
  /** Reach verdicts and the overlay run off-thread (addon-reach-worker.ts); null when a Worker cannot be made and the inline fallback runs instead. */
  private reachWorker: Worker | null | undefined;
  private reachJob = 0;
  private verdictNote = '';

  // The simulator
  private readonly client: AddonSimClient;
  private ready: ReadyInfo | null = null;
  /** The pin frame: world minus the placement's anchor. Until the pack is placed, the flat world's ground height. */
  private anchor = { x: 0, y: -60, z: 0 };
  private readonly holders = new Map<string, EntityHolder>();
  private prevPoses = new Map<string, EntityPose>();
  private readonly colliders = new ColliderStore();
  private colliderMeshes: THREE.InstancedMesh[] = [];
  /** Pin-frame keys of the shipped tread blocks and of the doorways' closed cells, for their colours. */
  private treadKeys = new Set<string>();
  private doorwayKeys = new Set<string>();
  private readonly log: SimLine[] = [];
  private actionbar: { text: string; at: number } | null = null;
  private title: { text: string; at: number } | null = null;
  private readonly violations: Violation[] = [];
  private readonly violationCounts = new Map<string, number>();
  private unmodelled: string[] = [];
  private form: FormEvent | null = null;
  private simState: 'loading' | 'placing' | 'live' | 'error' = 'loading';
  private simError = '';
  private stepLabel: string | undefined;
  private tickMs = 0;
  /** Look turns sent and not yet seen in a frame: the drawn look runs ahead of the simulator by them. */
  private pendingLook: Array<{ seq: number; dyaw: number; dpitch: number }> = [];

  // Input
  private readonly keys = new Set<string>();
  private touchMove = { x: 0, y: 0 };
  private touchJump = false;
  private touchSprint = false;
  private touchHold = false;
  /**
   * The sneak control's mode (`ControlState.setSneakMode`): the phone's button is a TOGGLE (each press flips it;
   * the simulator latches it, quirk `touch-sneak-toggle`), a keyboard's Shift a hold. C on a keyboard switches to
   * the toggle and presses it. `sneakPress` is one press, sent once.
   */
  private sneakToggleMode = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  private sneakPress = false;
  /** A mouse's turn, degrees; a finger's drag, pixels (the simulator turns those at the phone's measured sensitivity). */
  private lookDelta = { yaw: 0, pitch: 0 };
  private dragPx = { dx: 0, dy: 0 };
  private tapQueued = false;
  private tapAt: { x: number; y: number } | undefined;
  private holdQueued = false;
  private slotQueued: number | undefined;
  private fly = false;
  private autoJump = true;
  private lastFrame = 0;
  private animId = 0;
  private lastInputMs = 0;

  // DOM
  private root!: HTMLDivElement;
  private lookLayer!: HTMLDivElement;
  private labelLayer!: HTMLDivElement;
  private hud!: HTMLDivElement;
  private legendEl!: HTMLDivElement;
  private sizeEl!: HTMLDivElement;
  private reachEl!: HTMLDivElement;
  private targetsEl!: HTMLDivElement;
  private simEl!: HTMLDivElement;
  private hintEl!: HTMLDivElement;
  private interactEl!: HTMLDivElement;
  private actionbarEl!: HTMLDivElement;
  private titleEl!: HTMLDivElement;
  private logEl!: HTMLDivElement;
  private violationsEl!: HTMLDivElement;
  private formEl!: HTMLDivElement;
  private bannerEl!: HTMLDivElement;
  private resizeObs: ResizeObserver | null = null;
  private readonly listeners: Array<() => void> = [];
  private savedHover: LDrawViewer['onBrickHover'] = null;
  private savedClick: LDrawViewer['onBrickClick'] = null;
  private readonly isTouch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  constructor(opts: AddonPreviewOptions) {
    this.viewer = opts.viewer;
    this.model = opts.model;
    this.bytes = opts.bytes;
    this.onStatus = opts.onStatus ?? (() => {});
    this.onClose = opts.onClose;
    const rec = recommendedSize(this.model);
    const initial = opts.sizePct ?? rec?.sizePct ?? 100;
    this.sizePct = this.model.sizes.includes(initial) ? initial : 100;
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 800);
    this.client = new AddonSimClient({
      onReady: info => this.onReady(info),
      onFrame: (f, prev) => this.onFrame(f, prev),
      onForm: form => { this.form = form; if (document.pointerLockElement) document.exitPointerLock?.(); this.renderForm(); },
      onStatus: (text, kind) => this.note(text, kind === 'error' ? 'script-error' : 'console'),
      onStepDone: () => { this.stepLabel = undefined; },
      onError: message => { this.simState = 'error'; this.simError = message; this.note(`simulator: ${message}`, 'script-error'); this.renderHud(); },
    });
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
    // Share the viewer's studio reflections. Without an environment, chrome
    // has almost nothing to reflect and reads black despite correct MER data.
    this.scene.environment = viewer.scene.environment;
    this.scene.environmentIntensity = viewer.scene.environmentIntensity;
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1a1d2b, 1.1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.6, 1, 0.35);
    this.modelGroup.name = 'model';
    this.scene.add(hemi, sun, this.worldGroup, this.modelGroup, this.entityGroup, this.routeGroup, this.reachGroup, this.highlightGroup);

    this.buildDom(container);
    this.hud.style.display = this.hudVisible ? '' : 'none';
    this.rebuild();
    this.open = true;
    // On a phone the viewer panel sits under the tab's controls: bring the walk into sight.
    container.scrollIntoView({ block: 'nearest' });
    this.lastFrame = performance.now();
    this.animId = requestAnimationFrame(this.frame);
    // Dev-only debugging hook, same convention as viewer.ts's __ldrawViewer:
    // expose the simulator client, the holders and the input for the console
    // and `scripts/_shoot_addon_walk.mjs`.
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
      (globalThis as Record<string, unknown>)['__addonWalk'] = this;
    }
    this.onStatus(`Add-on walk: ${this.model.label} at ${this.sizePct} % — the pack's own scripts run in the simulator. Click the view to look, WASD to walk, Space to jump, Shift to sneak (C toggles), left click taps, E holds, 1-9 hotbar, F free-fly, Esc releases the mouse.`, 'info');
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
    this.client.close();
    for (const g of [this.worldGroup, this.modelGroup, this.entityGroup, this.routeGroup, this.reachGroup, this.highlightGroup]) this.clearGroup(g);
    this.holders.clear();
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
    if (changed) this.rebuild();
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

  /**
   * Start the simulator at the size and turn (a fresh world, the pack placed
   * by its own wand), and lay out what is known before the first frame: the
   * ground, the track, the markers at their placed points, the highlights,
   * and the reach overlay and verdicts from the shipped collider grid.
   */
  private rebuild(): void {
    const { model, sizePct, rotation } = this;
    const treads = treadBlocksAt(model, sizePct, rotation);
    this.treadCount = treads.length;
    this.treadKeys = new Set(treads.map(t => `${t.x},${t.y},${t.z}`));
    const f = sizePct / 100;
    const turned = rotation % 180 ? { width: model.dims.length, length: model.dims.width } : { width: model.dims.width, length: model.dims.length };
    this.laidDims = { width: Math.ceil(turned.width * f), height: Math.ceil(model.dims.height * f), length: Math.ceil(turned.length * f) };
    this.doorwayKeys = new Set(model.interactives ? [...ixWorldBlocks(model.interactives.items.flatMap(it => it.blocking), model.dims, f, rotation, COLLIDER_KIT).keys()] : []);

    for (const g of [this.worldGroup, this.modelGroup, this.reachGroup]) this.clearGroup(g);
    this.holders.clear();
    this.prevPoses = new Map();
    this.colliders.clear();
    this.colliderMeshes = [];
    this.ready = null;
    this.simState = 'placing';
    this.simError = '';
    this.log.length = 0;
    this.violations.length = 0;
    this.violationCounts.clear();
    this.unmodelled = [];
    this.form = null;
    this.pendingLook = [];
    this.fly = false;
    this.sneakPress = false;
    this.reachSummary = sizePct >= 100 && model.cells.length ? 'Reach on foot: checking…' : model.cells.length
      ? 'No reach walk below 100 %: the wand merges several cells into a block there and the reach module declines to guess. The simulator still lays and walks the real blocks.'
      : 'This pack ships no collider grid: nothing for the reach walk to grade. The simulator still places it.';

    this.buildGround(this.laidDims);
    this.buildEntities(f);
    this.buildRoutes();
    this.buildHighlights();
    this.applyLegendVisibility();
    this.requestVerdicts();
    this.renderHud();
    this.renderForm();
    void this.client.start(this.bytes, sizePct, rotation as PlacementRotation).catch((e: unknown) => {
      this.simState = 'error'; this.simError = e instanceof Error ? e.message : String(e); this.renderHud();
    });
  }

  private buildGround(dims: { width: number; length: number }): void {
    const pad = 24;
    const w = dims.width + 2 * pad, l = dims.length + 2 * pad;
    // The simulator's superflat ground runs on: a vehicle course lane is laid hundreds of blocks from the model.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), new THREE.MeshStandardMaterial({ color: 0x141827, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(dims.width / 2, -0.002, dims.length / 2);
    this.worldGroup.add(ground);
    const grid = new THREE.GridHelper(Math.max(w, l), Math.max(w, l), 0x3a4160, 0x232a42);
    grid.position.set(dims.width / 2, 0.001, dims.length / 2);
    this.worldGroup.add(grid);
    // The footprint's outline on the ground: where the placement ends and the player's own world begins.
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(dims.width, dims.length)), new THREE.LineBasicMaterial({ color: 0x7c8aa5 }));
    outline.rotation.x = -Math.PI / 2;
    outline.position.set(dims.width / 2, 0.01, dims.length / 2);
    this.worldGroup.add(outline);
  }

  /**
   * The blocks the runtime laid (every write since the placement began),
   * drawn as the boxes the player collides with: the collider kit's forms in
   * a height ramp, the shipped tread plan's blocks amber, a doorway's closed
   * cells door-blue, vanilla blocks (a course lane's stone, a hung door) in
   * their own colour. Rebuilt whenever the store changed (a door toggled).
   */
  private rebuildColliderMeshes(): void {
    for (const m of this.colliderMeshes) { this.worldGroup.remove(m); (m.material as THREE.Material).dispose(); }
    this.colliderMeshes = [];
    this.colliders.dirty = false;
    const a = this.anchor, top = this.laidDims.height || 1;
    const solids: Array<{ b: BlockChange; box: [number, number, number, number, number, number] }> = [], treads: typeof solids = [], doors: typeof solids = [], blocks: typeof solids = [];
    for (const b of this.colliders.entries.values()) {
      const key = `${b.x - a.x},${b.y - a.y},${b.z - a.z}`;
      const list = !b.typeId.startsWith('craftmatic:collider') ? blocks : this.treadKeys.has(key) ? treads : this.doorwayKeys.has(key) ? doors : solids;
      for (const box of b.boxes) list.push({ b, box });
    }
    const make = (list: typeof solids, color: THREE.Color | null, name: string, opacity = 1): void => {
      if (!list.length) return;
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.05, flatShading: true, ...(color ? { emissive: color, emissiveIntensity: 0.25 } : {}), ...(opacity < 1 ? { transparent: true, opacity } : {}) });
      const mesh = new THREE.InstancedMesh(this.unitBox, mat, list.length);
      const m = new THREE.Matrix4(), c = new THREE.Color();
      list.forEach(({ b, box }, i) => {
        const [x0, y0, z0, x1, y1, z1] = box;
        m.makeScale(x1 - x0, y1 - y0, z1 - z0);
        m.setPosition(b.x - a.x + (x0 + x1) / 2, b.y - a.y + (y0 + y1) / 2, b.z - a.z + (z0 + z1) / 2);
        mesh.setMatrixAt(i, m);
        if (color) c.copy(color);
        else {
          // A gentle height ramp so floors and roofs read apart from ten blocks away.
          const t = Math.min(1, (b.y - a.y + y1) / top);
          c.setRGB(0.36 + 0.22 * t, 0.40 + 0.22 * t, 0.50 + 0.18 * t);
        }
        mesh.setColorAt(i, c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.name = name;
      mesh.visible = name === 'treads' ? this.legend.tread.show : this.legend.collider.show;
      this.worldGroup.add(mesh);
      this.colliderMeshes.push(mesh);
    };
    make(solids, null, 'colliders');
    make(treads, new THREE.Color(LEGEND_COLOR.tread), 'treads');
    make(doors, new THREE.Color(LEGEND_COLOR.door), 'colliders-doors', 0.75);
    make(blocks, new THREE.Color(COLOR_BLOCK), 'blocks');
    this.buildHighlights();
  }

  // ── Entities: holders at the simulator's poses ──────────────────────────

  /**
   * What the pack DRAWS for one simulator entity, from its own geometry: a
   * root at the entity's pose (the pin frame, Bedrock's yaw negated, the
   * engine's `minecraft:scale` over 16, and the Z mirror of `worldFaces`),
   * one Group per bone composed up the parent chain (a bone turns about its
   * pivot, so a child's local matrix is in model space and the parent's
   * multiplies it), and the cubes instanced per colour chunk INSIDE their
   * bone with their own facet rotation - so an animation moves a bone's
   * Group and never a cube. A face atlas draws one textured face per cube.
   */
  private buildHolder(pose: EntityPose, kind: AddonEntityKind): EntityHolder | null {
    const entry = this.model.appearance?.byType.get(pose.typeId);
    if (!entry) return null;
    const root = new THREE.Group();
    root.name = pose.typeId;
    const bones = new Map<string, { group: THREE.Group; bone: AppearanceBone }>();
    const byName = new Map(entry.bones.map(b => [b.name, b]));
    const groupOf = (name: string, seen: Set<string>): THREE.Group => {
      const hit = bones.get(name);
      if (hit) return hit.group;
      const bone = byName.get(name);
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      g.name = name;
      if (!bone || seen.has(name)) { root.add(g); bones.set(name, { group: g, bone: bone ?? { name, pivot: [0, 0, 0] } }); return g; }
      seen.add(name);
      const parent = bone.parent ? groupOf(bone.parent, seen) : root;
      parent.add(g);
      bones.set(name, { group: g, bone });
      return g;
    };
    for (const b of entry.bones) groupOf(b.name, new Set());
    const m = new THREE.Matrix4(), cube = new THREE.Matrix4(), spin = new THREE.Matrix4();
    const identityBones = new Map<string, THREE.Matrix4>();
    for (const chunk of entry.groups) {
      // The LOD hull draws only past its switch distance; the walk shows the close-up model.
      if (chunk.far) continue;
      const byBone = new Map<string, AppearanceCube[]>();
      for (const c of chunk.cubes) { const l = byBone.get(c.bone); if (l) l.push(c); else byBone.set(c.bone, [c]); }
      for (const [boneName, cubes] of byBone) {
        const holder = groupOf(boneName, new Set());
        if (chunk.texture) {
          // A face atlas: each decal cube draws ONE textured face, nothing else, in the bone's own frame.
          const texture = this.faceTexture(chunk.texture.path);
          const geometry = texture ? faceDecalGeometry(chunk.texture, cubes, identityBones) : null;
          if (texture && geometry) {
            const material = addonAppearanceMaterial(chunk, texture);
            this.disposables.push(material);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.frustumCulled = false;
            holder.add(mesh);
          }
          continue;
        }
        const material = addonAppearanceMaterial(chunk);
        this.disposables.push(material);
        const mesh = new THREE.InstancedMesh(this.unitBox, material, cubes.length);
        cubes.forEach((c, i) => {
          const [ox, oy, oz] = c.origin, [sx, sy, sz] = c.size;
          // A zero-thickness cube would vanish; give it a hair so it still reads.
          cube.makeScale(sx || 0.01, sy || 0.01, sz || 0.01);
          cube.setPosition(ox + sx / 2, oy + sy / 2, oz + sz / 2);
          if (c.rotation && c.pivot) {
            const [rx, ry, rz] = c.rotation, [px, py, pz] = c.pivot;
            spin.copy(bedrockTurn(rx, ry, rz, px, py, pz));
            cube.premultiply(spin);
          }
          m.copy(cube);
          mesh.setMatrixAt(i, m);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.frustumCulled = false;
        holder.add(mesh);
      }
    }
    const anim = this.model.animations.get(pose.typeId) ?? null;
    const holder: EntityHolder = {
      id: pose.id, typeId: pose.typeId, kind, legend: legendKindOf(kind), root, bones, anim, vars: new Map(),
      molang: { firstMs: performance.now(), lastEvalMs: performance.now(), prev: null, distance: 0, speed: 0, vy: 0, dir: [0, 0, 0], unknown: new Set() },
    };
    if (anim) initializeClientAnimations(anim, this.molangEnv(holder, pose));
    this.poseBones(holder, new Map());
    this.modelGroup.add(root);
    return holder;
  }

  /** Every bone's local matrix from its bind pose and this frame's animated pose. */
  private poseBones(holder: EntityHolder, poses: ReadonlyMap<string, { rotation: [number, number, number]; position: [number, number, number]; scale: [number, number, number] }>): void {
    const t = new THREE.Matrix4(), s = new THREE.Matrix4(), p = new THREE.Matrix4(), pm = new THREE.Matrix4();
    for (const [name, { group, bone }] of holder.bones) {
      const a = poses.get(name);
      const [px, py, pz] = bone.pivot;
      const [brx, bry, brz] = bone.rotation ?? [0, 0, 0];
      const rx = brx + (a?.rotation[0] ?? 0), ry = bry + (a?.rotation[1] ?? 0), rz = brz + (a?.rotation[2] ?? 0);
      // T(animated position) · T(pivot) · R(bind + animated) · S(animated) · T(-pivot): Bedrock adds a playing
      // animation's rotation to the bind pose component-wise, scales about the pivot, and moves the bone by an
      // animated position in the geometry's own frame (measured on the Pixel for the pinball ball, 2026-09-25).
      const local = bedrockTurn(rx, ry, rz, 0, 0, 0);
      if (a && (a.scale[0] !== 1 || a.scale[1] !== 1 || a.scale[2] !== 1)) local.multiply(s.makeScale(a.scale[0], a.scale[1], a.scale[2]));
      local.premultiply(p.makeTranslation(px, py, pz)).multiply(pm.makeTranslation(-px, -py, -pz));
      if (a && (a.position[0] || a.position[1] || a.position[2])) local.premultiply(t.makeTranslation(a.position[0], a.position[1], a.position[2]));
      group.matrix.copy(local);
      group.matrixWorldNeedsUpdate = true;
    }
  }

  /** Molang's view of one entity this frame (the queries the packs' animations read; the rest is `unknown`, reported once). */
  private molangEnv(holder: EntityHolder, pose: EntityPose): MolangEnv {
    const st = holder.molang, props = this.client.propsOf(pose.id) ?? pose.props ?? {};
    const nowMs = performance.now();
    const dt = Math.max(0.001, (nowMs - st.lastEvalMs) / 1000);
    st.lastEvalMs = nowMs;
    const dist = this.camera.position.distanceTo(new THREE.Vector3(pose.x - this.anchor.x, pose.y - this.anchor.y, pose.z - this.anchor.z));
    return {
      property: name => props[name],
      vars: holder.vars,
      unknown: name => { st.unknown.add(name); },
      query: (name, args) => {
        switch (name) {
          case 'is_riding': return pose.riding ? 1 : 0;
          case 'is_moving': return st.speed > 1e-4 ? 1 : 0;
          case 'is_on_ground': return 1;
          case 'modified_distance_moved': return st.distance * MINIFIG_GAIT.unitsPerBlock;
          case 'modified_move_speed': return st.speed * MODIFIED_MOVE_SPEED_PER_BLOCK_TICK;
          case 'ground_speed': return st.speed * (1000 / SIM_TICK_MS);
          case 'vertical_speed': return st.vy * (1000 / SIM_TICK_MS);
          case 'movement_direction': return st.dir[Math.max(0, Math.min(2, Math.round(args[0] ?? 0)))]!;
          case 'body_y_rotation': case 'head_y_rotation': return pose.yaw;
          case 'body_x_rotation': case 'head_x_rotation': return pose.pitch;
          case 'target_x_rotation': case 'target_y_rotation': return 0;
          case 'life_time': case 'anim_time': return (nowMs - st.firstMs) / 1000;
          case 'delta_time': return dt;
          case 'distance_from_camera': return dist;
          case 'all_animations_finished': case 'any_animation_finished': return 1;
          case 'scale': return pose.scale;
          default: return undefined;
        }
      },
    };
  }

  /** The placement actor a simulator entity stands for: the same type, nearest its placed point, claimed once. */
  private matchMarker(pose: EntityPose): Marker | undefined {
    let best: Marker | undefined, bestD = Infinity;
    const p = { x: pose.x - this.anchor.x, y: pose.y - this.anchor.y, z: pose.z - this.anchor.z };
    for (const mk of this.markers) {
      if (mk.simId !== undefined || mk.entity.typeId !== pose.typeId) continue;
      const at = placedPoint(mk.entity, this.model.dims, this.sizePct, this.rotation);
      const d = Math.hypot(at.x - p.x, at.y - p.y, at.z - p.z);
      if (d < bestD) { bestD = d; best = mk; }
    }
    if (best) best.simId = pose.id;
    return best;
  }

  private kindOf(pose: EntityPose): AddonEntityKind {
    const actor = this.model.entities.find(e => e.typeId === pose.typeId);
    if (actor) return actor.kind;
    const roles = Object.fromEntries(Object.entries(this.model.coasterTypes).map(([t, v]) => [t, v.role]));
    return classifyAddonEntity(pose.typeId, {}, roles, this.model.pinball?.consoleType);
  }

  // ── Simulator events ────────────────────────────────────────────────────

  private onReady(info: ReadyInfo): void {
    this.ready = info;
    this.anchor = { ...info.anchor };
    this.simState = 'live';
    this.rebuildColliderMeshes();
    this.renderHud();
    this.note(`Placed at ${info.sizePct} % turn ${info.rotation} (anchor ${info.anchor.x}, ${info.anchor.y}, ${info.anchor.z}); simulator ${info.inline ? 'inline on the page' : 'in a Worker'}.`, 'console');
  }

  private onFrame(f: SimFrame, prev: SimFrame | undefined): void {
    this.prevPoses = new Map((prev?.entities ?? []).map(e => [e.id, e]));
    this.tickMs = f.ms;
    this.stepLabel = f.step;
    if (f.blocks?.length) this.colliders.apply(f.blocks);
    for (const id of f.removed) {
      const h = this.holders.get(id);
      if (h) { this.modelGroup.remove(h.root); this.holders.delete(id); }
      for (const mk of this.markers) if (mk.simId === id) delete mk.simId;
    }
    for (const line of f.lines) this.pushLine(line);
    for (const v of f.violations) {
      this.violations.push(v);
      if (this.violations.length > 60) this.violations.shift();
      this.violationCounts.set(v.invariant, (this.violationCounts.get(v.invariant) ?? 0) + 1);
    }
    this.unmodelled = f.unmodelled;
    // The look the frame carries has seen every input up to `seq`: those predictions are spent.
    this.pendingLook = this.pendingLook.filter(l => l.seq > f.seq);
    // Molang's motion state is per TICK: distance walked and speed from the pose deltas.
    for (const e of f.entities) {
      const h = this.holders.get(e.id);
      if (!h) continue;
      const st = h.molang;
      if (st.prev && f.tick > st.prev.tick) {
        const dx = e.x - st.prev.x, dy = e.y - st.prev.y, dz = e.z - st.prev.z, n = f.tick - st.prev.tick;
        const horizontal = Math.hypot(dx, dz);
        st.distance += horizontal;
        st.speed = horizontal / n;
        st.vy = dy / n;
        const len = Math.hypot(dx, dy, dz);
        st.dir = len > 1e-9 ? [dx / len, dy / len, dz / len] : [0, 0, 0];
      }
      st.prev = { x: e.x, y: e.y, z: e.z, tick: f.tick };
    }
    if (f.player.sneaking !== (prev?.player.sneaking ?? false)) this.root.querySelector('.ap-tbtn[data-t="sneak"]')?.classList.toggle('on', f.player.sneaking);
    if (f.lines.length || f.violations.length || f.player.riding !== (prev?.player.riding ?? null)) this.renderSimPanel();
  }

  /** Every line of every kind, the last `LOG_LINES * 5`, for a shot's JSON (the action bar fades off the HUD). */
  private readonly recentLines: SimLine[] = [];

  private pushLine(line: SimLine): void {
    this.recentLines.push(line);
    if (this.recentLines.length > LOG_LINES * 5) this.recentLines.shift();
    if (line.kind === 'actionbar') { this.actionbar = { text: line.text, at: performance.now() }; return; }
    if (line.kind === 'title') { this.title = { text: line.text, at: performance.now() }; return; }
    this.log.push(line);
    if (this.log.length > LOG_LINES) this.log.shift();
    this.renderLog();
  }

  private note(text: string, kind: SimLine['kind']): void { this.pushLine({ tick: this.client.frame?.tick ?? 0, kind, text }); }

  // ── Per-frame drawing ───────────────────────────────────────────────────

  private readonly frame = (now: number): void => {
    if (!this.open) return;
    this.animId = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.sendInput(now);
    const f = this.client.frame;
    if (f) {
      const alpha = this.client.alpha(now);
      this.drawEntities(f, alpha);
      this.placeCamera(f, alpha);
    }
    if (this.colliders.dirty && this.ready) this.rebuildColliderMeshes();
    this.updateInteract(f);
    const { renderer } = this.viewer;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
    this.placeLabels();
    this.updatePositionReadout(f, dt);
    this.fadeLines(now);
  };

  /** Every simulator entity at its interpolated pose, its bones by the pack's own animations. */
  private drawEntities(f: SimFrame, alpha: number): void {
    const a = this.anchor;
    for (const e of f.entities) {
      let h = this.holders.get(e.id);
      if (!h) {
        const kind = this.kindOf(e);
        const built = this.buildHolder(e, kind);
        const mk = this.matchMarker(e);
        if (mk && built) mk.hasRealGeometry = true;
        if (!built) continue;
        h = built;
        this.holders.set(e.id, h);
        this.applyHolderVisibility(h);
      }
      const p = interpolatePose(this.prevPoses.get(e.id), e, alpha);
      h.root.position.set(p.x - a.x, p.y - a.y, p.z - a.z);
      // A Bedrock yaw is three.js `rotation.y` by the negated angle (`worldFaces`, bedrock-geometry-faces.ts).
      h.root.rotation.y = -p.yaw * Math.PI / 180;
      const s = e.scale / 16;
      h.root.scale.set(s, s, -s);
      if (h.anim) this.poseBones(h, evaluateClientAnimations(h.anim, this.molangEnv(h, e)));
    }
    // Markers follow the entities they stand for.
    for (const mk of this.markers) {
      if (!mk.simId) continue;
      const e = f.entities.find(x => x.id === mk.simId);
      if (!e) continue;
      const p = interpolatePose(this.prevPoses.get(e.id), e, alpha);
      const w = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
      mk.mesh.position.set(w.x, w.y + mk.height / 2, w.z);
      mk.mesh.rotation.y = -p.yaw * Math.PI / 180;
      const beamTop = mk.beam.scale.y;
      mk.beam.position.set(w.x, beamTop / 2, w.z);
      mk.at.set(w.x, w.y, w.z);
    }
  }

  /**
   * The camera: the SCRIPT's request when one is in force (`setCamera`
   * minecraft:free at a location looking at a point or along a rotation -
   * the chase and cockpit cameras, the coaster's rider view), drawn RAW: no
   * easing, no draw lag, no spline (package B's client model draws those; the
   * HUD's "camera: raw" says so). Otherwise the player's own first person at
   * the simulator's eye, the look predicted ahead by the turns not yet seen.
   */
  private placeCamera(f: SimFrame, alpha: number): void {
    const a = this.anchor, cam = f.camera;
    const prevP = this.client.prevFrame?.player;
    const p = interpolatePose(prevP, f.player, alpha);
    const look = this.predictedLook(f);
    if (cam?.preset === 'minecraft:free' && (cam.location || cam.rotation)) {
      const eye = cam.location ? { x: cam.location.x - a.x, y: cam.location.y - a.y, z: cam.location.z - a.z } : { x: p.x - a.x, y: p.y - a.y + 1.62, z: p.z - a.z };
      this.camera.position.set(eye.x, eye.y, eye.z);
      this.camera.up.set(0, 1, 0);
      if (cam.facing) this.camera.lookAt(cam.facing.x - a.x, cam.facing.y - a.y, cam.facing.z - a.z);
      else this.setLook(cam.rotation?.y ?? look.yaw, cam.rotation?.x ?? look.pitch);
      return;
    }
    const eye = f.player.sneaking && !f.player.flying && !f.player.riding ? 1.27 : 1.62;
    if (cam?.preset && cam.preset !== 'minecraft:first_person') {
      // A third-person preset: the walker's own chase boom, 4 blocks behind the look (not the client's own camera).
      const yaw = look.yaw * Math.PI / 180, pitch = look.pitch * Math.PI / 180;
      const d = { x: -Math.sin(yaw) * Math.cos(pitch), y: -Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
      this.camera.position.set(p.x - a.x - d.x * 4, p.y - a.y + eye - d.y * 4 + 0.5, p.z - a.z - d.z * 4);
      this.setLook(look.yaw, look.pitch);
      return;
    }
    this.camera.position.set(p.x - a.x, p.y - a.y + eye, p.z - a.z);
    this.setLook(look.yaw, look.pitch);
  }

  /**
   * The simulator's look plus the turns sent since the frame it reports (so the mouse feels immediate). A
   * prediction only: the simulator routes a drag by the control scheme and the seat, and a riding player on a
   * lock-181 seat may see its drag go to the camera orbit instead; the next frame corrects the picture.
   */
  private predictedLook(f: SimFrame): { yaw: number; pitch: number } {
    let yaw = f.player.yaw, pitch = f.player.pitch;
    for (const l of this.pendingLook) { yaw += l.dyaw; pitch += l.dpitch; }
    const k = quirkValue('touch-drag-degrees-per-pixel', 'degreesPerPixel');
    yaw += this.lookDelta.yaw + this.dragPx.dx * k; pitch += this.lookDelta.pitch + this.dragPx.dy * k;
    return { yaw: wrapDeg(yaw), pitch: Math.max(-89.9, Math.min(89.9, pitch)) };
  }

  /** Point the camera along a Bedrock look (yaw 0 = +Z, +yaw right; +pitch down): three.js looks down -Z, so yaw maps to π − yaw. */
  private setLook(yawDeg: number, pitchDeg: number): void {
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = Math.PI - yawDeg * Math.PI / 180;
    this.camera.rotation.x = -pitchDeg * Math.PI / 180;
  }

  // ── Input to the simulator ──────────────────────────────────────────────

  private inputForTick(): Omit<WalkerInput, 'seq'> {
    const k = this.keys;
    let fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) + this.touchMove.y;
    // The stick's strafe is +LEFT in the simulator's controls (`stickToWorld`); D is right.
    let side = (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) - (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - this.touchMove.x;
    const mag = Math.hypot(fwd, side);
    if (mag > 1) { fwd /= mag; side /= mag; }
    // Shift on a keyboard is a HOLD: pressing it leaves the toggle mode; a sneak press (the button, C) is one press.
    const shift = k.has('ShiftLeft') || k.has('ShiftRight');
    if (shift) this.sneakToggleMode = false;
    const input: Omit<WalkerInput, 'seq'> = {
      forward: fwd, strafe: side,
      jump: k.has('Space') || this.touchJump,
      sneak: this.sneakPress || (!this.sneakToggleMode && shift),
      sneakMode: this.sneakToggleMode ? 'toggle' : 'hold',
      sprint: k.has('ControlLeft') || k.has('ControlRight') || this.touchSprint,
      autoJump: this.autoJump,
      dyaw: this.lookDelta.yaw, dpitch: this.lookDelta.pitch,
      ...(this.dragPx.dx || this.dragPx.dy ? { dragPx: { ...this.dragPx } } : {}),
      viewport: { width: this.viewer.container.clientWidth || 1, height: this.viewer.container.clientHeight || 1, fovDeg: this.camera.fov },
      fly: this.fly,
    };
    this.sneakPress = false;
    if (this.slotQueued !== undefined) { input.slot = this.slotQueued; this.slotQueued = undefined; }
    if (this.tapQueued) { input.tap = true; this.tapQueued = false; if (this.tapAt) { input.tapAt = this.tapAt; this.tapAt = undefined; } }
    if (this.holdQueued || this.touchHold) { input.hold = true; this.holdQueued = false; this.touchHold = false; }
    return input;
  }

  /** Post the input to the simulator at most once per tick, and whenever something was pressed. */
  private sendInput(now: number): void {
    if (this.simState !== 'live' || this.form) return;
    const due = now - this.lastInputMs >= SIM_TICK_MS;
    const pressed = this.tapQueued || this.holdQueued || this.touchHold || this.sneakPress || this.slotQueued !== undefined;
    if (!due && !pressed) return;
    this.lastInputMs = now;
    const input = this.inputForTick();
    const seq = this.client.sendInput(input);
    const k = quirkValue('touch-drag-degrees-per-pixel', 'degreesPerPixel');
    const dyaw = input.dyaw + (input.dragPx?.dx ?? 0) * k, dpitch = input.dpitch + (input.dragPx?.dy ?? 0) * k;
    // The drag is applied at the start of the NEXT tick, so it is spent one frame after the one that carries `seq`.
    if (dyaw || dpitch) this.pendingLook.push({ seq: seq + 1, dyaw, dpitch });
    this.lookDelta = { yaw: 0, pitch: 0 };
    this.dragPx = { dx: 0, dy: 0 };
  }

  /** The prompt over the crosshair: what a tap or a hold acts on, as the simulator's pick reports it. */
  private updateInteract(f: SimFrame | undefined): void {
    if (!this.interactEl) return;
    const aim = f?.aim;
    const text = f?.player.riding ? 'Sneak to get off' : aim ? `${this.labelOf(aim.typeId)} · tap (click) / hold (E)` : '';
    if (this.interactEl.textContent !== text) this.interactEl.textContent = text;
    this.interactEl.style.display = text ? '' : 'none';
  }

  private labelOf(typeId: string): string { return this.model.entities.find(e => e.typeId === typeId)?.label ?? typeId.replace(/^[^:]*:/, ''); }

  // ── Reach overlay, markers, routes, highlights ─────────────────────────

  private buildReach(surfaces: ReachSurface[]): void {
    this.clearGroup(this.reachGroup);
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
    this.reachGroup.visible = this.showReach;
  }

  private buildEntities(f: number): void {
    this.clearGroup(this.entityGroup);
    this.labelLayer.replaceChildren();
    this.markers = [];
    this.targets = [];
    const { model } = this;
    const laidHeight = this.laidDims.height;
    const beamGeom = new THREE.CylinderGeometry(0.06, 0.06, 1, 6, 1, true);
    this.disposables.push(beamGeom);
    const addMarker = (entity: AddonEntity): void => {
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
      // Real geometry (the holders) draws this entity once the simulator spawns it: the solid marker would just be
      // a translucent box floating over it. Keep the beam and label (still useful for finding it, and clicking
      // "go" on a NOT-reachable verdict) but hide the placeholder shape.
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
      const marker: Marker = { entity, legend, mesh, beam, label, at: new THREE.Vector3(at.x, at.y, at.z), height, hasRealGeometry };
      this.markers.push(marker);
      // Reach verdict per entity (asked of the worker): can a player on foot stand within a block of where this actor's feet are?
      if (legend && (kind === 'figure' || kind === 'seat' || kind === 'door' || kind === 'vehicle')) {
        this.targets.push({ label: entity.label, kind: legend, point: { x: entity.x, y: entity.y, z: entity.z }, reach: null, world: new THREE.Vector3(at.x, at.y, at.z), labelEl: label, labelText: entity.label });
      }
    };
    for (const e of model.entities) if (e.kind !== 'shell' && entitySpawnsAt(e, this.sizePct)) addMarker(e);
    // Runtime door candidates: vanilla doors the wand hangs once the opening is big enough.
    model.doorCandidates.forEach((d, i) => {
      if (this.sizePct < d.requiredSize) return;
      addMarker({ typeId: `door-candidate-${i}`, label: `Vanilla door ${i + 1} (from ${d.requiredSize} %)`, kind: 'door', x: d.x + 0.5, y: d.y, z: d.z + 0.5, yaw: 0 });
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
    this.markers.push({ entity: { typeId: '', label: text, kind: 'other', x: 0, y: 0, z: 0, yaw: 0 }, legend: 'track', mesh: new THREE.Mesh(), beam: new THREE.Mesh(), label, at: at.clone(), height: 0.5, hasRealGeometry: false });
    return label;
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

  // ── Reach verdicts and the overlay, off the main thread ────────────────

  /**
   * Ask the worker whether a player on foot reaches each target at this size
   * and turn, and for the overlay of every standable surface. The HUD says
   * the verdicts are pending until they arrive, and a stale job (the size
   * changed meanwhile) is ignored by its id. Without a Worker the same code
   * runs inline, deferred a frame so the size change still paints first.
   */
  private requestVerdicts(): void {
    const id = ++this.reachJob;
    if (this.sizePct < 100 || !this.model.cells.length) { this.verdictNote = ''; return; }
    const req: ReachWorkerRequest = {
      id, cells: this.model.cells, dims: this.model.dims, sizePct: this.sizePct, rotation: this.rotation,
      treads: treadBlocksAt(this.model, this.sizePct, this.rotation),
      targets: this.targets.map((t): ReachTarget => ({ label: t.label, x: t.point.x, y: t.point.y, z: t.point.z })),
      overlay: true,
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
    if (res.surfaces && res.overlay) {
      this.buildReach(res.surfaces);
      const o = res.overlay, f = this.sizePct / 100;
      this.reachSummary = `Reach on foot at ${this.sizePct} % (turn ${this.rotation}): ${o.reached.toLocaleString()} of ${o.total.toLocaleString()} standable surfaces over ${o.columns.toLocaleString()} columns; highest ${o.highestBlocks.toFixed(2)} blocks (${(o.highestBlocks / f).toFixed(2)} at 100 %). Treads laid: ${this.treadCount}.`;
    }
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
    this.applyLegendVisibility();
  }

  private applyHolderVisibility(h: EntityHolder): void {
    const { legend } = this;
    h.root.visible = legend.model.show && (h.legend ? legend[h.legend].show : true);
  }

  private applyLegendVisibility(): void {
    const { legend } = this;
    for (const h of this.holders.values()) this.applyHolderVisibility(h);
    for (const m of this.colliderMeshes) m.visible = m.name === 'treads' ? legend.tread.show : legend.collider.show;
    this.routeGroup.visible = legend.track.show;
    this.reachGroup.visible = this.showReach;
    for (const mk of this.markers) {
      const row = mk.legend;
      const show = row ? legend[row].show : true;
      // A row's "show" toggle still hides everything about that kind, real
      // geometry included (it is how a user isolates one legend row); the
      // placeholder shape ALSO stays hidden the rest of the time, since the
      // holder already draws the real thing.
      mk.mesh.visible = show && !mk.hasRealGeometry;
      mk.beam.visible = show && !!row && legend[row].highlight;
      mk.label.style.display = show ? '' : 'none';
    }
    for (const kind of LEGEND_KINDS) {
      const h = this.highlightGroup.getObjectByName(`hl-${kind}`);
      if (h) h.visible = legend[kind].show && legend[kind].highlight;
    }
  }

  // ── Player commands ─────────────────────────────────────────────────────

  private respawn(): void {
    this.fly = false;
    this.client.respawn();
    this.renderHud();
  }

  /** Put the player beside a target, in free-fly, so a NOT-reachable verdict can be inspected up close. */
  private goTo(t: Target): void {
    this.fly = true;
    const a = this.anchor;
    this.client.teleport({ x: t.world.x - 2 + a.x, y: t.world.y + 1.2 + a.y, z: t.world.z + a.z, yaw: -90, pitch: 20, fly: true });
    this.pendingLook = [];
    this.renderHud();
  }

  private toggleFly(): void {
    this.fly = !this.fly;
    this.renderHud();
  }

  private toggleHud(): void {
    this.hudVisible = !this.hudVisible;
    this.hud.style.display = this.hudVisible ? '' : 'none';
  }

  // ── Labels and the readout ──────────────────────────────────────────────

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

  private updatePositionReadout(f: SimFrame | undefined, _dt: number): void {
    const el = this.hintEl;
    if (this.simState === 'placing') { el.textContent = 'placing with the pack\'s own wand…'; return; }
    if (this.simState === 'error') { el.textContent = `simulator error: ${this.simError}`; return; }
    if (!f) return;
    const a = this.anchor, p = f.player, fs = this.sizePct / 100;
    const where = `x ${(p.x - a.x).toFixed(1)} y ${(p.y - a.y).toFixed(2)} z ${(p.z - a.z).toFixed(1)} (blocks from the pin at ${this.sizePct} %; ${((p.y - a.y) / fs).toFixed(2)} up at 100 %)`;
    const state = p.riding ? `riding ${this.labelOf(this.holders.get(p.riding)?.typeId ?? '')}` : p.flying ? 'free-fly' : p.onGround ? 'on ground' : 'airborne';
    el.textContent = `tick ${f.tick} · ${state}${p.sneaking ? ' · sneaking' : ''} · slot ${p.slot + 1} · ${where}${this.stepLabel ? ` · step: ${this.stepLabel}` : ''}`;
  }

  /** The action bar and the title fade as the game's do. */
  private fadeLines(now: number): void {
    const ab = this.actionbar && now - this.actionbar.at < ACTIONBAR_MS ? this.actionbar.text : '';
    if (this.actionbarEl.textContent !== ab) { this.actionbarEl.textContent = ab; this.actionbarEl.style.display = ab ? '' : 'none'; }
    const t = this.title && now - this.title.at < ACTIONBAR_MS ? this.title.text : '';
    if (this.titleEl.textContent !== t) { this.titleEl.textContent = t; this.titleEl.style.display = t ? '' : 'none'; }
  }

  // ── DOM ─────────────────────────────────────────────────────────────────

  private buildDom(container: HTMLElement): void {
    ensureStyles();
    const root = document.createElement('div');
    root.className = 'ap-root';
    const materialEvidence = this.model.appearance?.materialMode === 'pbr-assets'
      ? 'Preview uses the pack\'s material values; lighting differs from Minecraft.'
      : 'Preview uses classic diffuse shading because the pack has no enabled, supported uniform PBR assets.';
    root.innerHTML = `
      <div class="ap-look" tabindex="0" aria-label="Add-on walk view"></div>
      <div class="ap-labels"></div>
      <div class="ap-crosshair"></div>
      <div class="ap-banner">The <b>simulator</b> runs this pack's own scripts over the blocks its wand lays; the walker draws it. ${materialEvidence} It does <b>not</b> prove Bedrock's rendering, culling, form text, camera easing or the phone's touch pick — a device round still decides those.</div>
      <div class="ap-title-line" style="display:none"></div>
      <div class="ap-interact"></div>
      <div class="ap-actionbar" style="display:none"></div>
      <div class="ap-log"></div>
      <div class="ap-hud">
        <div class="ap-panel ap-legend"></div>
        <div class="ap-panel ap-size"></div>
        <div class="ap-panel ap-reach"></div>
        <div class="ap-panel ap-targets"></div>
      </div>
      <div class="ap-side">
        <div class="ap-panel ap-sim"></div>
        <div class="ap-panel ap-violations"></div>
      </div>
      <div class="ap-top">
        <button type="button" class="ap-btn" data-act="hud" title="Hide or show the panels (H)">Panels</button>
        <button type="button" class="ap-btn" data-act="respawn" title="Back to where the child placed from (R)">Respawn</button>
        <button type="button" class="ap-btn" data-act="fly" title="Free-fly: the walker's own inspection mode, no collision (F)">Free-fly</button>
        <button type="button" class="ap-btn ap-exit" data-act="exit" title="Leave the walk and return to the model">Exit walk</button>
      </div>
      <div class="ap-hint"></div>
      <div class="ap-keys">${this.isTouch ? 'Left pad: move · drag right side: look · tap the view: tap · buttons: jump / sneak (toggle) / hold / sprint · hotbar: wand, chase, cockpit' : 'Click to look · WASD move · Space jump · Shift sneak · C sneak toggle · click tap · E / right click hold · 1-9 hotbar (9 cockpit) · Ctrl sprint · F fly · R respawn · [ ] size · H panels · Esc release'}</div>
      <div class="ap-touch" ${this.isTouch ? '' : 'hidden'}>
        <div class="ap-stick"><div class="ap-knob"></div></div>
        <div class="ap-touch-btns">
          <button type="button" class="ap-tbtn ap-tbtn-interact" data-t="hold">Hold</button>
          <button type="button" class="ap-tbtn" data-t="jump">Jump</button>
          <button type="button" class="ap-tbtn" data-t="sneak">Sneak</button>
          <button type="button" class="ap-tbtn" data-t="sprint">Sprint</button>
        </div>
        <div class="ap-slots">
          <button type="button" class="ap-tbtn ap-slot" data-slot="0" title="Hotbar 1: the Brick Wand">Wand</button>
          <button type="button" class="ap-tbtn ap-slot" data-slot="1" title="Hotbar 2: chase camera while riding">Chase</button>
          <button type="button" class="ap-tbtn ap-slot" data-slot="8" title="Hotbar 9: cockpit view while riding">Cockpit</button>
        </div>
      </div>
      <div class="ap-form" style="display:none"></div>`;
    container.appendChild(root);
    this.root = root;
    this.lookLayer = root.querySelector('.ap-look')!;
    this.labelLayer = root.querySelector('.ap-labels')!;
    this.interactEl = root.querySelector('.ap-interact')!;
    this.actionbarEl = root.querySelector('.ap-actionbar')!;
    this.titleEl = root.querySelector('.ap-title-line')!;
    this.logEl = root.querySelector('.ap-log')!;
    this.hud = root.querySelector('.ap-hud')!;
    this.legendEl = root.querySelector('.ap-legend')!;
    this.sizeEl = root.querySelector('.ap-size')!;
    this.reachEl = root.querySelector('.ap-reach')!;
    this.targetsEl = root.querySelector('.ap-targets')!;
    this.simEl = root.querySelector('.ap-sim')!;
    this.violationsEl = root.querySelector('.ap-violations')!;
    this.formEl = root.querySelector('.ap-form')!;
    this.bannerEl = root.querySelector('.ap-banner')!;
    this.hintEl = root.querySelector('.ap-hint')!;
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
    // Mouse: pointer lock on the first click (fine pointers); once locked, a left click TAPS and a right click HOLDS
    // at the crosshair (the phone's tap and press). A plain drag looks around when the lock is refused or on touch.
    this.on(look, 'click', () => { if (!this.isTouch && !this.form && document.pointerLockElement !== look) look.requestPointerLock?.(); });
    this.on(look, 'mousedown', (e: MouseEvent) => {
      if (document.pointerLockElement !== look || this.form) return;
      if (e.button === 0) this.tapQueued = true;
      else if (e.button === 2) this.holdQueued = true;
    });
    this.on(look, 'contextmenu', (e: MouseEvent) => { e.preventDefault(); });
    this.on(document, 'mousemove', (e: MouseEvent) => {
      if (document.pointerLockElement !== look) return;
      this.turn(e.movementX * MOUSE_DEG_PER_PX, e.movementY * MOUSE_DEG_PER_PX);
    });
    let drag: { id: number; x: number; y: number; startX: number; startY: number; at: number; moved: boolean } | null = null;
    this.on(look, 'pointerdown', (e: PointerEvent) => {
      if (document.pointerLockElement === look || this.form) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, at: performance.now(), moved: false };
      look.setPointerCapture(e.pointerId);
    });
    this.on(look, 'pointermove', (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 8) drag.moved = true;
      // A finger's drag goes to the simulator in PIXELS (it turns them at the phone's measured sensitivity); a
      // mouse drag without the lock in degrees.
      if (e.pointerType === 'touch') { if (!this.form) this.dragPx = { dx: this.dragPx.dx + (e.clientX - drag.x), dy: this.dragPx.dy + (e.clientY - drag.y) }; }
      else this.turn((e.clientX - drag.x) * MOUSE_DEG_PER_PX, (e.clientY - drag.y) * MOUSE_DEG_PER_PX);
      drag = { ...drag, x: e.clientX, y: e.clientY };
    });
    const endDrag = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      // A short touch that did not move is a TAP where the finger landed: the simulator's screen pick decides what it
      // hits (with Split Controls, the QA phones' setting, the crosshair; without, the touched point).
      if (e.pointerType === 'touch' && !drag.moved && performance.now() - drag.at < 300) {
        const r = look.getBoundingClientRect();
        this.tapAt = { x: e.clientX - r.left, y: e.clientY - r.top };
        this.tapQueued = true;
      }
      drag = null;
    };
    this.on(look, 'pointerup', endDrag);
    this.on(look, 'pointercancel', endDrag);

    // Keys: only while the walk is open and focus is not in a field; Escape closes when the pointer is free.
    this.on(window, 'keydown', (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.code === 'Escape') { if (this.form) { this.answerForm({ cancel: true }); e.preventDefault(); return; } if (!document.pointerLockElement) { this.close(); e.preventDefault(); } return; }
      if (e.code === 'KeyF') { this.toggleFly(); e.preventDefault(); return; }
      if (e.code === 'KeyR') { this.respawn(); e.preventDefault(); return; }
      if (e.code === 'KeyH') { this.toggleHud(); e.preventDefault(); return; }
      if (e.code === 'KeyC' && !e.repeat) { this.pressSneakToggle(); e.preventDefault(); return; }
      if (e.code === 'KeyE' && !e.repeat) { this.holdQueued = true; e.preventDefault(); return; }
      if (e.code === 'KeyT' && !e.repeat) { this.tapQueued = true; e.preventDefault(); return; }
      if (/^Digit[1-9]$/.test(e.code)) { this.slotQueued = Number(e.code.slice(5)) - 1; e.preventDefault(); return; }
      if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        const i = this.model.sizes.indexOf(this.sizePct) + (e.code === 'BracketRight' ? 1 : -1);
        const next = this.model.sizes[i];
        if (next !== undefined) this.setSize(next);
        e.preventDefault(); return;
      }
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
      else if (act === 'autojump') { this.autoJump = !this.autoJump; this.renderSimPanel(); }
      else if (act === 'form') { const i = Number(btn.dataset['i']); this.answerForm(i < 0 ? { cancel: true } : { button: i }); }
      else if (act === 'clear-violations') { this.violations.length = 0; this.violationCounts.clear(); this.renderSimPanel(); }
    });

    // Touch: a virtual stick and hold buttons; Sneak is a TOGGLE (the phone's default).
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
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.ap-tbtn[data-t]')) {
      const which = b.dataset['t'];
      const set = (on: boolean): void => {
        if (which === 'jump') this.touchJump = on;
        else if (which === 'sprint') this.touchSprint = on;
        else if (which === 'hold') { if (on) this.touchHold = true; }
        if (which !== 'sneak') b.classList.toggle('on', on);
      };
      if (which === 'sneak') { this.on(b, 'pointerdown', (e: PointerEvent) => { this.pressSneakToggle(); e.preventDefault(); }); continue; }
      this.on(b, 'pointerdown', (e: PointerEvent) => { set(true); b.setPointerCapture(e.pointerId); e.preventDefault(); });
      this.on(b, 'pointerup', () => set(false));
      this.on(b, 'pointercancel', () => set(false));
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.ap-slot')) {
      this.on(b, 'pointerdown', (e: PointerEvent) => { this.slotQueued = Number(b.dataset['slot']); e.preventDefault(); });
    }
  }

  /** One press of the sneak TOGGLE (the phone's button, C on a keyboard): the simulator flips and latches it. */
  private pressSneakToggle(): void {
    this.sneakToggleMode = true;
    this.sneakPress = true;
  }

  private turn(dxDeg: number, dyDeg: number): void {
    if (this.form) return;
    this.lookDelta = { yaw: this.lookDelta.yaw + dxDeg, pitch: this.lookDelta.pitch + dyDeg };
  }

  private answerForm(answer: { cancel: true } | { button: number }): void {
    if (!this.form) return;
    const id = this.form.id;
    this.form = null;
    this.client.answerForm(id, answer);
    this.renderForm();
  }

  // ── HUD ─────────────────────────────────────────────────────────────────

  private esc(s: string): string { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c)); }

  private renderHud(): void {
    const { model } = this;
    const counts = legendCounts(model, this.sizePct, this.rotation);
    const rec = recommendedSize(model);
    const prov = model.provenance;
    const esc = (s: string): string => this.esc(s);
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
      <div class="ap-row ap-sizes">${model.sizes.map(s => `<button type="button" class="ap-tog ${s === this.sizePct ? 'on' : ''} ${rec?.sizePct === s ? 'rec' : ''}" data-act="size" data-size="${s}" title="${rec?.sizePct === s ? 'Recommended by the walk-through measurement' : `Place again at ${s} percent`}">${s}${rec?.sizePct === s ? ' <small>rec</small>' : ''}</button>`).join('')}<span class="ap-dim">%</span></div>
      <div class="ap-row">turn ${QUARTER_TURNS.map(r => `<button type="button" class="ap-tog ${r === this.rotation ? 'on' : ''}" data-act="turn" data-turn="${r}" title="The wand's quarter turn; tread plans differ per turn">${r}°</button>`).join('')}
        <span class="ap-dim">${this.laidDims.width}×${this.laidDims.height}×${this.laidDims.length} blocks</span></div>
      ${rec ? `<div class="ap-dim ap-reason"><b>Walk-through size: ${rec.sizePct !== null ? `${rec.sizePct} %` : 'none'}.</b> ${esc(rec.reason)}</div>` : '<div class="ap-dim">This pack carries no walk-through measurement.</div>'}`;

    this.reachEl.innerHTML = `<div>${esc(this.reachSummary)}</div>
      <div class="ap-dim">${this.fly ? 'Free-fly: the walker\'s own inspection mode, no collision — reach claims do not apply to where you are.' : 'Walking: the simulator\'s 0.6 × 1.8 player with Minecraft\'s jump and step over the blocks the wand laid.'}${this.treadCount && this.sizePct > 100 ? ` The ${this.treadCount} amber blocks are the invisible steps the pack lays at this size.` : ''}</div>`;

    const verdict = (t: Target): string => {
      if (this.sizePct < 100 || !model.cells.length) return '<span class="ap-dim">no reach walk at this size</span>';
      if (!t.reach) return '<span class="ap-dim">checking…</span>';
      if (t.reach.bfs) return `<span style="color:${hex(COLOR_REACHED)}">reachable</span>`;
      return `<span style="color:${hex(COLOR_UNREACHED)}">NOT reachable</span>${t.reach.refusal ? ` <span class="ap-dim">— ${esc(t.reach.refusal.detail)}</span>` : ''}`;
    };
    const order = { station: 0, lift: 1, seat: 2, door: 3, figure: 4, vehicle: 5, track: 6, model: 7, collider: 8, tread: 9 } as const;
    const sorted = this.targets.map((t, i) => ({ t, i })).sort((a, b) => order[a.t.kind] - order[b.t.kind]);
    this.targetsEl.innerHTML = `<div class="ap-title">Can a player get there on foot?</div>
      ${sorted.length ? sorted.map(({ t, i }) => `<div class="ap-target"><button type="button" class="ap-tog" data-act="goto" data-i="${i}" title="Fly to it">go</button> ${esc(t.label)}: ${verdict(t)}</div>`).join('') : `<div class="ap-dim">${model.cells.length ? 'Nothing to test at this size.' : 'No collider grid, so no verdicts.'}</div>`}
      ${this.verdictNote ? `<div class="ap-dim">${esc(this.verdictNote)}</div>` : ''}`;
    this.root.querySelector<HTMLButtonElement>('[data-act="fly"]')?.classList.toggle('on', this.fly);
    this.renderSimPanel();
    this.renderLog();
  }

  /** The simulator's own panel: its state, the client-side hooks present or standing in, the live violations. */
  private renderSimPanel(): void {
    const esc = (s: string): string => this.esc(s);
    const info = this.ready, hooks = info?.hooks;
    const ind = (on: boolean | undefined, yes: string, no: string): string => `<span class="ap-ind ${on ? 'ok' : 'raw'}">${on ? yes : no}</span>`;
    const f = this.client.frame;
    const state = this.simState === 'live' ? `live · tick ${f?.tick ?? 0} · ${this.tickMs.toFixed(1)} ms/tick${info?.inline ? ' · inline' : ' · Worker'}` : this.simState;
    this.simEl.innerHTML = `<div class="ap-title">Simulator <span class="ap-dim">${esc(state)}</span></div>
      <div class="ap-row ap-inds">
        ${ind(hooks?.clientCamera, 'camera: client model', 'camera: raw')}
        ${ind(hooks?.drag, 'drag: scheme-routed', 'drag: direct')}
        ${ind(hooks?.tapScreen, 'tap: screen pick', 'tap: crosshair')}
        ${ind(hooks?.sneakToggle, `sneak: sim ${this.sneakToggleMode ? 'toggle' : 'hold'}${f?.player.sneaking ? ' (ON)' : ''}`, 'sneak: walker toggle')}
        <button type="button" class="ap-tog ${this.autoJump ? 'on' : ''}" data-act="autojump" title="Auto-jump (Bedrock's touch default, quirk auto-jump)">auto-jump ${this.autoJump ? 'on' : 'off'}</button>
      </div>
      ${this.unmodelled.length ? `<div class="ap-notes">UNKNOWN, never pass: the scripts reached API members the simulator does not model: ${esc(this.unmodelled.slice(0, 4).join(', '))}${this.unmodelled.length > 4 ? '…' : ''}</div>` : ''}
      ${this.simError ? `<div class="ap-notes">${esc(this.simError)}</div>` : ''}`;
    const counts = [...this.violationCounts].map(([id, n]) => `<span class="ap-vcount">${esc(id)} ×${n}</span>`).join(' ');
    this.violationsEl.innerHTML = `<div class="ap-title">Invariants <span class="ap-dim">${this.violations.length ? `${this.violations.length} violation${this.violations.length === 1 ? '' : 's'}` : 'nothing raised'}</span>
      ${this.violations.length ? '<button type="button" class="ap-tog" data-act="clear-violations" title="Forget the violations seen so far">clear</button>' : ''}</div>
      ${counts ? `<div class="ap-row">${counts}</div>` : ''}
      ${this.violations.slice(-6).reverse().map(v => `<div class="ap-violation"><b>${esc(v.invariant)}</b> <span class="ap-dim">tick ${v.tick}${v.step ? ` · ${esc(v.step)}` : ''}</span><br>${esc(v.message.slice(0, 220))}</div>`).join('')}`;
    this.bannerEl.classList.toggle('ap-banner-warn', this.unmodelled.length > 0);
  }

  private renderLog(): void {
    if (!this.logEl) return;
    this.logEl.innerHTML = this.log.map(l => `<div class="ap-line ap-line-${l.kind}"><span class="ap-dim">${l.tick}${l.source ? ` ${this.esc(l.source.replace(/^scripts\//, ''))}` : ''}</span> ${this.esc(l.text.slice(0, 200))}</div>`).join('');
  }

  private renderForm(): void {
    const form = this.form;
    this.formEl.style.display = form ? '' : 'none';
    if (!form) return;
    const esc = (s: string): string => this.esc(s);
    this.formEl.innerHTML = `<div class="ap-form-box">
      <div class="ap-title">${esc(form.title)}</div>
      ${form.body ? `<div class="ap-form-body">${esc(form.body).replace(/\n/g, '<br>')}</div>` : ''}
      <div class="ap-form-btns">${form.buttons.map((b, i) => `<button type="button" class="ap-btn" data-act="form" data-i="${i}">${esc(b)}</button>`).join('')}
        <button type="button" class="ap-btn ap-exit" data-act="form" data-i="-1">Close</button></div>
      <div class="ap-dim">A form the pack's script showed (${form.kind}); answered through the simulator's chooser.</div>
    </div>`;
  }

  // ── Dev hook surface (scripts/_shoot_addon_walk.mjs) ───────────────────

  /** Where the camera stands and looks, world blocks and Bedrock angles (for a shot's JSON). */
  get cameraState(): { x: number; y: number; z: number } { const p = this.camera.position; return { x: p.x + this.anchor.x, y: p.y + this.anchor.y, z: p.z + this.anchor.z }; }
  get anchorPoint(): { x: number; y: number; z: number } { return { ...this.anchor }; }
  get simClient(): AddonSimClient { return this.client; }
  get entityHolders(): ReadonlyMap<string, EntityHolder> { return this.holders; }
  get markerList(): readonly Marker[] { return this.markers; }
  get legendState(): LegendState { return this.legend; }
  get view(): WalkView { return { sizePct: this.sizePct, rotation: this.rotation }; }
  get previewModel(): AddonPreviewModel { return this.model; }
  get violationList(): readonly Violation[] { return this.violations; }
  get logLines(): readonly SimLine[] { return this.log; }
  get allLines(): readonly SimLine[] { return this.recentLines; }
  /** What the block store holds: entries and a count per block type (a shot's JSON says what was drawn). */
  get colliderStats(): { entries: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {};
    for (const b of this.colliders.entries.values()) byType[b.typeId] = (byType[b.typeId] ?? 0) + 1;
    return { entries: this.colliders.entries.size, byType };
  }
  /** The walk's own box on the page, for a shot clipped to the view. */
  get viewRect(): { x: number; y: number; width: number; height: number } { const r = this.root.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }
  /** Pin-frame bounds of a holder's drawn cubes (a shot frames a figure or a car by them). */
  holderBounds(id: string): { min: THREE.Vector3; max: THREE.Vector3 } | null {
    const h = this.holders.get(id);
    if (!h) return null;
    h.root.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    const m = new THREE.Matrix4(), corner = new THREE.Vector3();
    h.root.traverse(o => {
      const mesh = o as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh) return;
      mesh.geometry.computeBoundingBox();
      const b = mesh.geometry.boundingBox;
      if (!b) return;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) box.expandByPoint(corner.set(x, y, z).applyMatrix4(m).applyMatrix4(mesh.matrixWorld));
      }
    });
    return box.isEmpty() ? null : { min: box.min, max: box.max };
  }
  /** Free-fly the camera to a pin-frame point looking along a Bedrock yaw/pitch (a shot's framing). */
  flyTo(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.fly = true;
    this.client.teleport({ x: x + this.anchor.x, y: y + this.anchor.y - 1.62, z: z + this.anchor.z, yaw, pitch, fly: true });
    this.pendingLook = [];
    this.lookDelta = { yaw: 0, pitch: 0 };
  }
  setFly(on: boolean): void { this.fly = on; }
  queueTap(): void { this.tapQueued = true; }
  queueHold(): void { this.holdQueued = true; }
  selectSlot(i: number): void { this.slotQueued = i; }
  /** Press the sneak toggle until the simulator reports the asked state (a harness's "Sneak on"). */
  sneakToggle(on: boolean): void { if ((this.client.frame?.player.sneaking ?? false) !== on) this.pressSneakToggle(); }
  pressKey(code: string, on: boolean): void { if (on) this.keys.add(code); else this.keys.delete(code); }
  hidePanels(): void { this.hudVisible = false; this.hud.style.display = 'none'; this.root.querySelector<HTMLElement>('.ap-side')!.style.display = 'none'; }
  /** Hide every holder but the named ids (a part seen through the building it stands in). */
  isolate(ids: readonly string[] | null): void { for (const h of this.holders.values()) h.root.visible = ids === null ? true : ids.includes(h.id); }
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
.ap-banner-warn{background:rgba(234,88,12,.22);border-color:rgba(251,146,60,.6)}
.ap-interact{position:absolute;left:50%;bottom:34%;transform:translateX(-50%);padding:6px 14px;border-radius:20px;background:rgba(10,12,22,.85);border:1px solid rgba(250,204,21,.6);color:#fde68a;font-weight:600;font-size:13px;pointer-events:none;display:none;text-shadow:0 1px 2px #000;max-width:70%;text-align:center}
.ap-actionbar{position:absolute;left:50%;bottom:22%;transform:translateX(-50%);padding:5px 14px;border-radius:6px;background:rgba(10,12,22,.72);color:#fff;font-size:14px;pointer-events:none;text-shadow:0 1px 2px #000;max-width:80%;text-align:center}
.ap-title-line{position:absolute;left:50%;top:38%;transform:translateX(-50%);font-size:28px;font-weight:700;color:#fff;pointer-events:none;text-shadow:0 2px 4px #000;text-align:center}
.ap-log{position:absolute;left:8px;bottom:44px;width:min(440px,60%);pointer-events:none;display:flex;flex-direction:column;gap:2px}
.ap-line{padding:2px 8px;border-radius:4px;background:rgba(8,10,18,.62);font-size:11px;text-shadow:0 1px 2px #000;white-space:pre-wrap;word-break:break-word}
.ap-line-script-error,.ap-line-content-log{background:rgba(220,38,38,.35)}
.ap-line-form{background:rgba(124,58,237,.3)}
.ap-hud{position:absolute;left:8px;top:58px;bottom:190px;width:min(360px,calc(100% - 16px));display:flex;flex-direction:column;gap:6px;overflow:auto;pointer-events:none}
.ap-side{position:absolute;right:8px;top:96px;bottom:48px;width:min(320px,calc(100% - 16px));display:flex;flex-direction:column;gap:6px;overflow:auto;pointer-events:none}
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
.ap-ind{padding:2px 7px;border-radius:10px;font-size:10px;border:1px solid}
.ap-ind.ok{border-color:rgba(34,197,94,.6);color:#86efac}
.ap-ind.raw{border-color:rgba(251,146,60,.6);color:#fdba74}
.ap-vcount{padding:1px 6px;border-radius:10px;background:rgba(220,38,38,.3);font-size:10px}
.ap-violation{margin:3px 0;padding:4px 6px;border-radius:4px;background:rgba(220,38,38,.18);font-size:11px}
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
.ap-slots{position:absolute;right:96px;bottom:56px;display:flex;flex-direction:column;gap:10px;pointer-events:auto}
.ap-tbtn{width:70px;height:48px;border-radius:24px;border:1px solid rgba(255,255,255,.3);background:rgba(10,12,22,.75);color:#fff;font:inherit;touch-action:none}
.ap-tbtn.on{background:#7c3aed}
.ap-tbtn-interact{border-color:rgba(250,204,21,.6);color:#fde68a}
.ap-tbtn-interact.on{background:#a16207}
.ap-slot{width:64px;height:40px;font-size:11px}
.ap-form{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);z-index:5}
.ap-form-box{min-width:min(360px,90%);max-width:90%;padding:12px 14px;border-radius:10px;background:rgba(14,16,28,.96);border:1px solid rgba(167,139,250,.5)}
.ap-form-body{margin:6px 0 10px;white-space:pre-wrap}
.ap-form-btns{display:flex;flex-wrap:wrap;gap:6px}
@media (max-width:700px){.ap-banner{font-size:10px;padding:4px 8px}.ap-top{top:auto;bottom:auto;left:8px;right:8px;top:calc(8px + 5.5em);justify-content:space-between;gap:4px;z-index:3}.ap-btn{padding:3px 7px;font-size:11px;min-height:28px}.ap-hud{width:calc(100% - 16px);top:calc(8px + 5.5em + 36px);bottom:190px;z-index:2}.ap-side{display:none}.ap-keys{display:none}.ap-hint{bottom:8px;font-size:10px}.ap-log{bottom:200px;width:50%}.ap-actionbar{bottom:30%}}
`;
  document.head.appendChild(style);
}
