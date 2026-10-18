/**
 * The walker's side of the simulator: the message protocol between the page
 * and the module Worker that runs the headless simulator over the pack's own
 * bytes (`addon-sim-worker.ts`), and the page's view of what comes back - the
 * last two ticks for pose interpolation, the lines the scripts said, the
 * violations the invariants raised, pending forms, and which client-side
 * hooks (packages B and C of the engine plan) the simulator offers.
 *
 * Nothing here touches the DOM or three.js; the preview (`addon-preview.ts`)
 * draws from `AddonSimClient` and `interpolatePose`, and a test can drive
 * the same protocol inline (`AddonSimSession` runs on any thread).
 *
 * Frame: every position in a frame is the SIMULATOR's world (blocks, Y up,
 * the superflat ground at `FLAT_GROUND_Y`); the page subtracts the
 * placement's anchor (`ReadyInfo.anchor`) to draw in the walker's pin frame.
 */

import type { Violation } from '../sim/scenario/invariants.js';
import type { TimelineKind } from '../sim/core/timeline.js';
import type { PlacementRotation } from '@engine/bedrock-placement-pack.js';
import type { ClientProfile, ClientProfileName, DrawnMode } from '../sim/client/camera.js';

// ─── Page → worker ───────────────────────────────────────────────────────────

/** What the player's hands are doing, as the walker reads its keys, stick and buttons. */
export interface WalkerInput {
  /** Monotonic, so a frame can say which input it has seen (`SimFrame.seq`). */
  seq: number;
  forward: number;
  strafe: number;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
  /** Auto-jump on (Bedrock's touch default, quirk `auto-jump`). */
  autoJump: boolean;
  /**
   * The look turn since the last input, degrees in Bedrock's sense (+yaw turns right, +pitch looks down): a mouse's
   * movement. Queued as a drag and routed by the player's control scheme (`sim/input/drag.ts`).
   */
  dyaw: number;
  dpitch: number;
  /** A finger's drag in screen PIXELS (+x right, +y down), turned at the phone's measured sensitivity (`dragPixels`). */
  dragPx?: { dx: number; dy: number };
  /** How the sneak control behaves: `hold` (a keyboard's Shift) or `toggle` (the phone's button: each press flips it). */
  sneakMode: 'hold' | 'toggle';
  /** Hotbar slot to select (0-8); omitted = unchanged. Slot 8 (hotbar 9) is a vehicle's cockpit view. */
  slot?: number;
  /** A TAP (hit, `entityHitEntity`) this input, through the screen pick (`sim/input/screen.ts`) at `tapAt` or the crosshair. */
  tap?: boolean;
  /** Where the finger landed, raw pixels of `viewport`; absent = the crosshair. */
  tapAt?: { x: number; y: number };
  /** The walk's canvas and its vertical field of view, the screen the pick projects through. */
  viewport?: { width: number; height: number; fovDeg: number };
  /** A HOLD (interact: mounts a rideable, opens a screen) at the crosshair this input. */
  hold?: boolean;
  /** Free-fly (the WALKER's own inspection mode, not Bedrock flight): the player hangs and the stick moves it. */
  fly?: boolean;
}

export interface LoadMessage {
  type: 'load';
  bytes: ArrayBuffer;
  sizePct: number;
  rotation: PlacementRotation;
  /** The scripts' `Math.random` seed (default 1, as the CLI runs). */
  seed?: number;
  /** Which phone's client the frames are drawn as (`sim/client/camera.ts` `clientProfile`; default the Pixel, the measured one). */
  client?: ClientProfileName;
}

export interface TeleportMessage {
  type: 'teleport';
  /** World blocks (the frame's own frame). */
  x: number; y: number; z: number;
  yaw?: number; pitch?: number;
  /** Hang there in free-fly. */
  fly?: boolean;
}

/** Answer a form the scripts showed (`FormEvent`). */
export interface FormAnswerMessage { type: 'formAnswer'; id: number; answer: { cancel: true } | { button: number } }

/**
 * Run a scenario step by its registered kind (the core steps and the
 * craftmatic adapter's: `tap`, `hold`, `stuckCourse`, `shipControls`,
 * `driveVehicle`, `figuresLive`, ...) while the page keeps drawing every tick
 * it runs. The step's selectors cannot cross a message, so a target is named
 * by `typeId` (nearest first) through `target`.
 */
export interface RunStepMessage { type: 'runStep'; id: number; step: Record<string, unknown> & { kind: string }; target?: { typeId: string } }

/** Advance `ticks` as fast as the thread allows, posting a frame every `every` ticks (figures living five minutes). */
export interface FastForwardMessage { type: 'fastForward'; ticks: number; every: number }

export type PageToWorker =
  | LoadMessage
  | { type: 'input'; input: WalkerInput }
  | TeleportMessage
  | { type: 'respawn' }
  | FormAnswerMessage
  | RunStepMessage
  | FastForwardMessage
  | { type: 'pause'; on: boolean };

// ─── Worker → page ───────────────────────────────────────────────────────────

/** One drawn entity's pose this tick. */
export interface EntityPose {
  id: string;
  typeId: string;
  x: number; y: number; z: number;
  /** Bedrock yaw and pitch, degrees. */
  yaw: number;
  pitch: number;
  /** `minecraft:scale` as the engine realises it. */
  scale: number;
  /** The entity it rides, or null. */
  riding: string | null;
  /** Actor properties, sent only on the tick they changed (the page keeps the last). */
  props?: Record<string, number | boolean | string>;
  /**
   * Where the phone's client DRAWS it this tick (`ClientView.drawnPose`): the server pose `entityLagTicks`
   * behind (quirk `client-entity-lag`), a rider on its drawn mount's seat. Absent when equal to the server pose.
   */
  drawn?: { x: number; y: number; z: number; yaw: number; pitch: number };
}

/**
 * The camera the phone's client draws this tick (`ClientView.drawn`, package B): the player's own view, or a
 * script camera EASED from where it was drawn (quirk `camera-ease-lag`), or a camera animation's sample with its
 * roll (quirks `camera-roll-animation-only`, `camera-animation-cut`). World blocks; `dir`/`up` are unit vectors.
 */
export interface DrawnView {
  mode: DrawnMode;
  eye: { x: number; y: number; z: number };
  yaw: number; pitch: number; roll: number;
  dir: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  preset?: string;
}

/** The camera the scripts asked for (`player.camera.setCamera` / `playAnimation`), as the host records it. */
export interface ScriptCamera {
  preset?: string;
  rotation?: { x: number; y: number };
  location?: { x: number; y: number; z: number };
  facing?: { x: number; y: number; z: number };
  animation?: string;
  tick: number;
}

export interface PlayerPose {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  onGround: boolean;
  sneaking: boolean;
  flying: boolean;
  riding: string | null;
  slot: number;
}

/** A line the game said this tick, colour codes stripped. */
export interface SimLine { tick: number; kind: TimelineKind; text: string; source?: string }

/** A world block whose collision changed: its boxes (block-local sixteenths as fractions) and type. */
export interface BlockChange { x: number; y: number; z: number; typeId: string; boxes: Array<[number, number, number, number, number, number]> }

export interface SimFrame {
  tick: number;
  /** The last `WalkerInput.seq` this tick saw. */
  seq: number;
  /** Wall time the tick took in the worker, ms. */
  ms: number;
  player: PlayerPose;
  /** The script's last camera REQUEST, as the host records it (what was asked, not what is drawn: see `drawn`). */
  camera: ScriptCamera | null;
  /** What the phone's client draws (package B's model); absent only from a frame built without a client. */
  drawn?: DrawnView;
  /** What the crosshair's pick ray meets within reach (quirk `tap-is-hit`): the entity a tap or hold would act on. */
  aim: { id: string; typeId: string; distance: number } | null;
  entities: EntityPose[];
  /** Entity ids that left the loaded world this tick. */
  removed: string[];
  lines: SimLine[];
  violations: Violation[];
  /** Unmodelled API members reached so far (a non-empty list means UNKNOWN, never pass). */
  unmodelled: string[];
  blocks?: BlockChange[];
  /** A scenario step is running (`runStep`): its label. */
  step?: string;
}

/** What the worker knows once the pack is placed. */
export interface ReadyInfo {
  /** The placement's pinned corner, world blocks: the walker's pin frame is `world - anchor`. */
  anchor: { x: number; y: number; z: number };
  /** The placed box, world blocks, inclusive. */
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  sizePct: number;
  rotation: PlacementRotation;
  playerId: string;
  /** Scripted vehicle types, flyer mounts and ride seats the pack declares (for the HUD's hints). */
  vehicleTypes: string[];
  nativeMountTypes: string[];
  /** The hooks the simulator offers this build (packages B and C); absent ones are drawn/routed by the walker itself. */
  hooks: SimHooks;
  /** The phone client the frames are drawn as (its entity lag and whether it plays a camera ease). */
  client: ClientProfile;
  /** Which thread runs the simulator. */
  inline: boolean;
}

/** Which client-side sim modules the session consumes; the HUD shows what is standing in. */
export interface SimHooks {
  /** `web/src/sim/client/camera.ts` (package B): the camera and entities as the phone's client draws them (eased, lagged, animated). */
  clientCamera: boolean;
  /** `web/src/sim/input/drag.ts` (package C): a drag queued on the controls and routed by control scheme and seat. */
  drag: boolean;
  /** `web/src/sim/input/screen.ts` (package C): a tap picks along the ray from the camera the player SEES. */
  tapScreen: boolean;
  /** `ControlState.setSneakMode` (package C): the phone's sneak toggle latched by the simulator itself. */
  sneakToggle: boolean;
}

/** A form the scripts showed and wait on; the page answers with `FormAnswerMessage`. */
export interface FormEvent { type: 'form'; id: number; kind: 'action' | 'modal' | 'message'; title: string; body: string; buttons: string[] }

export type WorkerToPage =
  | { type: 'ready'; info: ReadyInfo }
  | { type: 'frame'; frame: SimFrame }
  | FormEvent
  | { type: 'status'; text: string; kind: 'info' | 'error' | 'success' }
  | { type: 'stepDone'; id: number; ok: boolean; error?: string; notes: string[]; state: Record<string, unknown> }
  | { type: 'error'; message: string };

// ─── The client ──────────────────────────────────────────────────────────────

/** Ticks per second of the simulated game, and the frame interval the page interpolates over. */
export const SIM_TICKS_PER_SECOND = 20;
export const SIM_TICK_MS = 1000 / SIM_TICKS_PER_SECOND;

/** A yaw into (-180, 180]. */
export const wrapDeg = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;

/** Linear interpolation of a pose between two ticks (yaw along the short way round). */
export function interpolatePose<T extends { x: number; y: number; z: number; yaw: number; pitch: number }>(a: T | undefined, b: T, alpha: number): { x: number; y: number; z: number; yaw: number; pitch: number } {
  if (!a) return { x: b.x, y: b.y, z: b.z, yaw: b.yaw, pitch: b.pitch };
  const t = Math.max(0, Math.min(1, alpha));
  // A teleport (more than 8 blocks in a tick) is drawn as a cut, never a slide across the world.
  if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 8) return { x: b.x, y: b.y, z: b.z, yaw: b.yaw, pitch: b.pitch };
  return {
    x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
    yaw: a.yaw + wrapDeg(b.yaw - a.yaw) * t, pitch: a.pitch + (b.pitch - a.pitch) * t,
  };
}

/** What the page listens for. */
export interface AddonSimClientEvents {
  onReady(info: ReadyInfo): void;
  onFrame(frame: SimFrame, prev: SimFrame | undefined): void;
  onForm(form: FormEvent): void;
  onStatus(text: string, kind: 'info' | 'error' | 'success'): void;
  onStepDone(id: number, ok: boolean, error: string | undefined, notes: string[], state: Record<string, unknown>): void;
  onError(message: string): void;
}

/** The worker's port, or an inline session standing in for it. */
interface Port { post(m: PageToWorker, transfer?: Transferable[]): void; close(): void }

/**
 * Spawns the simulator Worker (or runs the session inline when a Worker
 * cannot be made - a test page, an old WebView), keeps the last two frames
 * and the entity props they carry, and forwards everything else.
 */
export class AddonSimClient {
  /** The latest and the previous frame, for interpolation. */
  frame: SimFrame | undefined;
  prevFrame: SimFrame | undefined;
  /** Wall time the latest frame arrived (`performance.now()`), for the interpolation alpha. */
  frameAt = 0;
  /** The interval between the last two frames, ms (a fast-forward's frames come closer together). */
  frameGapMs = SIM_TICK_MS;
  info: ReadyInfo | undefined;
  /** Every entity's last-known props (frames carry them only when they change). */
  readonly props = new Map<string, Record<string, number | boolean | string>>();
  private port: Port | null = null;
  private seq = 0;
  private stepId = 0;
  private readonly stepWaiters = new Map<number, (r: { ok: boolean; error?: string; notes: string[]; state: Record<string, unknown> }) => void>();
  private disposed = false;

  constructor(private readonly events: AddonSimClientEvents) {}

  /** Load a pack: a fresh simulator in the worker (or inline), placed at the size and turn. */
  async start(bytes: ArrayBuffer, sizePct: number, rotation: PlacementRotation, client: ClientProfileName = 'pixel'): Promise<void> {
    this.close();
    this.disposed = false;
    this.frame = this.prevFrame = undefined;
    this.props.clear();
    this.info = undefined;
    this.port = await this.openPort();
    // The bytes are copied, not transferred: a size change reloads the same pack.
    this.port.post({ type: 'load', bytes: bytes.slice(0), sizePct, rotation, client });
  }

  private handle(m: WorkerToPage): void {
    if (this.disposed) return;
    switch (m.type) {
      case 'ready': this.info = m.info; this.events.onReady(m.info); break;
      case 'frame': {
        const now = performance.now();
        if (this.frame) this.frameGapMs = Math.max(SIM_TICK_MS / 4, Math.min(SIM_TICK_MS * 2, now - this.frameAt));
        this.frameAt = now;
        this.prevFrame = this.frame;
        this.frame = m.frame;
        for (const e of m.frame.entities) if (e.props) this.props.set(e.id, e.props);
        for (const id of m.frame.removed) this.props.delete(id);
        this.events.onFrame(m.frame, this.prevFrame);
        break;
      }
      case 'form': this.events.onForm(m); break;
      case 'status': this.events.onStatus(m.text, m.kind); break;
      case 'stepDone': { const w = this.stepWaiters.get(m.id); this.stepWaiters.delete(m.id); w?.({ ok: m.ok, ...(m.error ? { error: m.error } : {}), notes: m.notes, state: m.state }); this.events.onStepDone(m.id, m.ok, m.error, m.notes, m.state); break; }
      case 'error': this.events.onError(m.message); break;
      default: break;
    }
  }

  /** A Worker when the page can make one, else the session itself on this thread. */
  private async openPort(): Promise<Port> {
    try {
      const worker = new Worker(new URL('./addon-sim-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<WorkerToPage>) => this.handle(e.data);
      worker.onerror = (e: ErrorEvent) => this.events.onError(`simulator worker: ${e.message}`);
      return { post: (m, transfer) => worker.postMessage(m, transfer ?? []), close: () => worker.terminate() };
    } catch {
      const { AddonSimSession } = await import('./addon-sim-worker.js');
      const session = new AddonSimSession(m => this.handle(m), { inline: true });
      return { post: m => { void session.receive(m); }, close: () => session.dispose() };
    }
  }

  /** Send this frame's controls and look turn. Returns the input's sequence number. */
  sendInput(input: Omit<WalkerInput, 'seq'>): number {
    const seq = ++this.seq;
    this.port?.post({ type: 'input', input: { ...input, seq } });
    return seq;
  }

  teleport(to: Omit<TeleportMessage, 'type'>): void { this.port?.post({ type: 'teleport', ...to }); }
  respawn(): void { this.port?.post({ type: 'respawn' }); }
  pause(on: boolean): void { this.port?.post({ type: 'pause', on }); }
  answerForm(id: number, answer: FormAnswerMessage['answer']): void { this.port?.post({ type: 'formAnswer', id, answer }); }
  fastForward(ticks: number, every = 20): void { this.port?.post({ type: 'fastForward', ticks, every }); }

  /** Run a scenario step in the simulator while the page keeps drawing; resolves with the step's outcome. */
  runStep(step: RunStepMessage['step'], target?: { typeId: string }): Promise<{ ok: boolean; error?: string; notes: string[]; state: Record<string, unknown> }> {
    const id = ++this.stepId;
    return new Promise(resolve => {
      this.stepWaiters.set(id, resolve);
      this.port?.post({ type: 'runStep', id, step, ...(target ? { target } : {}) });
    });
  }

  /** The props last seen for an entity. */
  propsOf(id: string): Record<string, number | boolean | string> | undefined { return this.props.get(id); }

  /** The interpolation alpha for now: how far between the previous and the latest frame the clock is. */
  alpha(now = performance.now()): number { return Math.min(1, (now - this.frameAt) / this.frameGapMs); }

  close(): void {
    this.disposed = true;
    this.port?.close();
    this.port = null;
    for (const w of this.stepWaiters.values()) w({ ok: false, error: 'closed', notes: [], state: {} });
    this.stepWaiters.clear();
  }
}
