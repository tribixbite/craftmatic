/**
 * LDrawViewer — class-based, multipass renderer with persistent state.
 *
 * Replaces the single-shot `createLDrawViewer` function. The architectural
 * win: brick meshes are organized into per-step Three.Group containers, so
 * step slider drags become an O(steps) visibility toggle instead of a full
 * scene rebuild + part refetch. Reloading the same model also re-uses the
 * module-level part geometry cache from parts.ts.
 *
 * Lifecycle:
 *   const v = await LDrawViewer.create(container, { background: 0x2d2d3d });
 *   await v.load(bricks, { mpdContent });
 *   v.setMaxStep(20);     // instant — just toggles group.visible
 *   v.setMaxStep(83);     // instant
 *   v.captureScreenshot();
 *   v.dispose();
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SAOPass } from 'three/examples/jsm/postprocessing/SAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

import type { ParsedBrick } from '@engine/ldraw-parser.js';
import type { Vec3, Triangle, LDrawViewerOptions } from './types.js';
import {
  resolvePartGeometry,
  getCachedPartGeom,
  preloadMpdInlines,
  clearMpdInlines,
  isLDrawPrimitive,
  normId,
  partTextureUrls,
  invalidatePartGeom,
} from './parts.js';
import {
  getThreeColor,
  isTransparentColor,
  makeMaterial,
} from './materials.js';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const LDU_TO_UNITS = 1 / 20; // 1 stud (20 LDU) = 1 scene unit

function applyMat(v: Vec3, R: readonly number[], T: Vec3): Vec3 {
  return [
    R[0]! * v[0] + R[1]! * v[1] + R[2]! * v[2] + T[0],
    R[3]! * v[0] + R[4]! * v[1] + R[5]! * v[2] + T[1],
    R[6]! * v[0] + R[7]! * v[1] + R[8]! * v[2] + T[2],
  ];
}

interface StepGroupState {
  /** Three.Group containing all meshes + edges for this step */
  group: THREE.Group;
  /** Edge LineMaterial instances in this group (need resolution updates) */
  edgeMaterials: LineMaterial[];
}

/**
 * Count of elements <= val in a step-ascending sorted array (binary search).
 * Used to prefix-count step-sorted instances for the step slider.
 */
function upperBoundCount(sorted: Int32Array, val: number): number {
  if (!Number.isFinite(val)) return sorted.length;
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= val) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export class LDrawViewer {
  // Three.js infrastructure
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  readonly controls: OrbitControls;
  readonly container: HTMLElement;

  // Lighting (kept as members so load() can reposition them per-model)
  private readonly ambient: THREE.AmbientLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly fillLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  private readonly bottomFill: THREE.DirectionalLight;

  // Post-processing passes (kept for resize updates)
  private readonly fxaaPass: ShaderPass;
  private saoPass: SAOPass | null = null;

  // Backdrop (rebuilt each load to scale with model)
  private backdropMeshes: THREE.Object3D[] = [];

  // On-demand rendering: only composite a frame when something changed
  // (camera move, animation, or an explicit state mutation). Starts true so
  // the first frame draws.
  private needsRender = true;

  // Model state — populated by load(), cleared on next load()
  private stepGroups: Map<number, StepGroupState> = new Map();
  private allMeshMaterials: THREE.Material[] = [];
  // Shared geometry cache keyed by `${partId}|main` or `${partId}|c${colorId}`.
  // Persists across load() calls — same part across two models reuses the
  // smoothed BufferGeometry. LRU-capped (see pruneGeomCache) so a long session
  // that loads many distinct sets doesn't grow this unbounded; entries used by
  // the CURRENT model are never evicted (live InstancedMeshes reference them).
  // Map insertion order = LRU order (hits re-insert to the end).
  private sharedPartGeoms: Map<string, THREE.BufferGeometry | null> = new Map();
  private static readonly GEOM_CACHE_CAP = 4000;
  /** Cache keys touched by the current model — protected from eviction. */
  private currentGeomKeys: Set<string> = new Set();

  // Maps each InstancedMesh + instanceId back to its source ParsedBrick for
  // click-to-inspect. Populated during buildStepGroup, cleared in unloadCurrent.
  private instanceBrickMap: Map<THREE.InstancedMesh, ParsedBrick[]> = new Map();
  /** User-supplied click handler. Called with the picked brick on canvas click. */
  onBrickClick: ((brick: ParsedBrick) => void) | null = null;
  /** User-supplied hover handler. Called on throttled mousemove with the brick under the cursor (or null when none). */
  onBrickHover: ((brick: ParsedBrick | null, screenX: number, screenY: number) => void) | null = null;
  private clickHandler: ((e: MouseEvent) => void) | null = null;
  private moveHandler: ((e: MouseEvent) => void) | null = null;
  private leaveHandler: (() => void) | null = null;
  private hoverPending = false;
  private lastHoveredBrick: ParsedBrick | null = null;
  // Perf overlay state — populated each frame when the user enables it
  private statsOverlay: HTMLDivElement | null = null;
  private frameTimes: number[] = [];
  private lastFrameTime = 0;
  private maxAvailableStep: number = 1;
  private currentMaxStep: number = Number.POSITIVE_INFINITY;
  // Stored bbox + size from last load(), used by setView() camera presets
  private lastBboxMin = new THREE.Vector3();
  private lastBboxMax = new THREE.Vector3();
  private lastVisualCenter = new THREE.Vector3();
  private lastSize = new THREE.Vector3();
  private lastMaxDim = 10;
  // Model-aware orientation, recomputed per load(). frontDir is the world
  // direction the model's "front face" points to; rightDir is the model's
  // right side. Both are unit horizontal vectors (Y=0). Defaults match the
  // pre-heuristic LDraw convention (front=+Z, right=+X).
  private frontDir = new THREE.Vector3(0, 0, 1);
  private rightDir = new THREE.Vector3(1, 0, 0);
  /** Parts that resolved with no geometry (missing from library / LSynth).
   *  Populated each load(); read by the UI to surface unrendered pieces. */
  missingParts: { part: string; count: number }[] = [];
  // Cinematic camera transition state (null when not animating).
  // Render loop interpolates position/target/near/far with ease-in-out quad
  // over `duration` ms. Set by fitCameraToDirection(..., animate=true).
  private cameraAnim: {
    fromPos: THREE.Vector3; toPos: THREE.Vector3;
    fromTarget: THREE.Vector3; toTarget: THREE.Vector3;
    fromNear: number; toNear: number;
    fromFar: number; toFar: number;
    startMs: number; duration: number;
  } | null = null;

  // Lifecycle
  private animId: number = 0;
  private resizeObs: ResizeObserver | null = null;
  private disposed: boolean = false;
  private loaded: boolean = false;

  private constructor(container: HTMLElement) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2d2d3d);

    const aspect = Math.max(0.01, container.clientWidth / Math.max(1, container.clientHeight));
    this.camera = new THREE.PerspectiveCamera(35, aspect, 0.1, 1000);
    this.camera.position.set(20, 15, 25);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      // NO logarithmicDepthBuffer: it forces per-fragment depth writes that
      // produce z-fighting artifacts with InstancedMesh (which this renderer
      // uses for every brick) and on near-coincident surfaces — exactly the
      // stud-in-tube and coplanar brick faces in a LEGO model. Standard 24-bit
      // depth with a well-tuned near/far (see fitCameraToDirection) gives far
      // better precision for a model-scale scene and eliminates the flicker.
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // captureScreenshot()
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // PERF: the model + key light are static — only the camera orbits — so the
    // shadow map never needs to change once built. Regenerating a 4096² shadow
    // map for thousands of bricks EVERY frame was the main source of orbit
    // stutter. Disable per-frame shadow updates and refresh once whenever the
    // scene actually changes (load / step / explode / wireframe).
    this.renderer.shadowMap.autoUpdate = false;
    // Khronos PBR Neutral tone mapping (r162+). Purpose-built for product
    // viz: tames highlights to white WITHOUT the saturation/hue shift that
    // ACES imposes on strong colors (reds→orange, blues→purple). This is
    // the single biggest lever for matching box-art color fidelity.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Lighting — neutral studio. Strategy after the color re-architecture:
    // generous NEUTRAL diffuse fill (ambient + hemi + fill) brightens every
    // face so the saturated base color reads at full strength (white diffuse
    // on a red surface lifts R toward target while G/B stay low — that's
    // GOOD, it restores saturation). The white *specular* wash that used to
    // desaturate comes from the environment + clearcoat, now controlled at
    // the env level (dark studio) and material level (no clearcoat on ABS).
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(this.ambient);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x6a5a4a, 0.45);
    this.scene.add(this.hemi);
    this.keyLight = new THREE.DirectionalLight(0xfff6ea, 2.6);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0005;
    this.keyLight.shadow.normalBias = 0.02;
    this.keyLight.shadow.radius = 3;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);
    this.fillLight = new THREE.DirectionalLight(0xffffff, 0.55);
    this.scene.add(this.fillLight);
    this.rimLight = new THREE.DirectionalLight(0xffffff, 0.45);
    this.scene.add(this.rimLight);
    this.bottomFill = new THREE.DirectionalLight(0xffffff, 0.2);
    this.scene.add(this.bottomFill);

    // Composer set up; passes added once container size is known
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.fxaaPass = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaaPass);
    const vignettePass = new ShaderPass(VignetteShader);
    vignettePass.uniforms['offset']!.value = 1.2;
    vignettePass.uniforms['darkness']!.value = 0.8;
    this.composer.addPass(vignettePass);
    this.composer.addPass(new OutputPass());

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotateSpeed = 1.5;
    // On-demand rendering: any camera move (drag/zoom/pan, and each damping
    // settle frame) flags a redraw. Idle scenes then cost ~0 GPU.
    this.controls.addEventListener('change', () => { this.needsRender = true; });
  }

  /** Construct + mount the renderer; sizes correctly even if container is 0 initially. */
  static async create(container: HTMLElement, opts?: LDrawViewerOptions): Promise<LDrawViewer> {
    const viewer = new LDrawViewer(container);

    if (opts?.background != null) {
      (viewer.scene.background as THREE.Color).setHex(opts.background);
    }

    // Wait for non-zero container size before mounting
    let cw = container.clientWidth;
    let ch = container.clientHeight;
    if (cw === 0 || ch === 0) {
      await new Promise<void>(resolve => {
        const obs = new ResizeObserver(() => {
          cw = container.clientWidth;
          ch = container.clientHeight;
          if (cw > 0 && ch > 0) { obs.disconnect(); resolve(); }
        });
        obs.observe(container);
        setTimeout(() => { obs.disconnect(); cw = cw || 800; ch = ch || 600; resolve(); }, 2000);
      });
    }

    viewer.renderer.setSize(cw, ch);
    viewer.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    viewer.composer.setSize(cw, ch);
    viewer.camera.aspect = cw / ch;
    viewer.camera.updateProjectionMatrix();
    const pr = viewer.renderer.getPixelRatio();
    viewer.fxaaPass.material.uniforms['resolution']!.value.set(1 / (cw * pr), 1 / (ch * pr));

    // Studio environment map (PMREM) — DARK surround with discrete bright
    // softbox panels. Critical fix: the old near-white (0xd0d0d8) env flooded
    // every surface with white diffuse+specular reflection, which dominated
    // dark base colors and washed them grey. A mostly-dark environment with
    // a few concentrated HDR panels gives crisp specular highlights (the
    // plastic "shine") WITHOUT the broad white wash — so dark colors keep
    // their saturation while chrome still has bright things to reflect.
    try {
      const pmremGen = new THREE.PMREMGenerator(viewer.renderer);
      pmremGen.compileEquirectangularShader();
      const envScene = new THREE.Scene();
      envScene.background = new THREE.Color(0x0a0a0e); // near-black surround
      // HDR-bright emissive panels (MeshStandardMaterial emissive renders
      // unlit when no lights are in the env scene; emissiveIntensity>1 gives
      // true HDR values the PMREM captures for punchy highlights).
      const panel = (x: number, y: number, z: number, w: number, h: number, intensity: number, warm = 1.0) => {
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(w, h),
          new THREE.MeshStandardMaterial({
            emissive: new THREE.Color(warm, warm * 0.985, warm * 0.96),
            emissiveIntensity: intensity,
            color: 0x000000,
            side: THREE.DoubleSide,
          }),
        );
        m.position.set(x, y, z);
        m.lookAt(0, 0, 0);
        envScene.add(m);
      };
      panel(35, 45, 30, 70, 70, 5.0);   // key softbox, upper front-right
      panel(-45, 15, 15, 55, 80, 1.6);  // fill, left side
      panel(-10, 25, -45, 50, 50, 2.4); // rim/back
      panel(0, -30, 10, 90, 90, 0.25);  // dim floor bounce
      viewer.scene.environment = pmremGen.fromScene(envScene, 0.08).texture;
      viewer.scene.environmentIntensity = 0.85;
      pmremGen.dispose();
    } catch (e) {
      console.warn('[LDrawViewer] Environment map failed (GPU limitation):', e);
    }

    // Mount canvas — clear any caller-provided spinner first
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(viewer.renderer.domElement);

    // Click-to-inspect handler — uses shared pickBrickAt
    viewer.clickHandler = (e: MouseEvent) => {
      if (!viewer.onBrickClick || !viewer.loaded) return;
      const brick = viewer.pickBrickAt(e.clientX, e.clientY);
      if (brick) viewer.onBrickClick(brick);
    };
    viewer.renderer.domElement.addEventListener('click', viewer.clickHandler);

    // Hover handler — throttled raycast, shared logic with click. Picks the
    // brick under the cursor on mousemove and emits onBrickHover, but at
    // most once per requestAnimationFrame to keep raycasts off the hot path.
    let pendingClientX = 0;
    let pendingClientY = 0;
    viewer.moveHandler = (e: MouseEvent) => {
      pendingClientX = e.clientX;
      pendingClientY = e.clientY;
      if (viewer.hoverPending || !viewer.onBrickHover || !viewer.loaded) return;
      viewer.hoverPending = true;
      requestAnimationFrame(() => {
        viewer.hoverPending = false;
        if (!viewer.onBrickHover || !viewer.loaded || viewer.disposed) return;
        const brick = viewer.pickBrickAt(pendingClientX, pendingClientY);
        if (brick !== viewer.lastHoveredBrick) {
          viewer.lastHoveredBrick = brick;
          viewer.onBrickHover(brick, pendingClientX, pendingClientY);
        } else if (brick) {
          // Same brick but moved — update position for tooltip placement
          viewer.onBrickHover(brick, pendingClientX, pendingClientY);
        }
      });
    };
    viewer.renderer.domElement.addEventListener('mousemove', viewer.moveHandler);

    viewer.leaveHandler = () => {
      if (viewer.lastHoveredBrick !== null) {
        viewer.lastHoveredBrick = null;
        viewer.onBrickHover?.(null, 0, 0);
      }
    };
    viewer.renderer.domElement.addEventListener('mouseleave', viewer.leaveHandler);

    // Resize observer
    viewer.resizeObs = new ResizeObserver(() => viewer.handleResize());
    viewer.resizeObs.observe(container);

    // Render loop
    viewer.startRenderLoop();

    viewer.renderer.domElement.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      cancelAnimationFrame(viewer.animId);
    });
    viewer.renderer.domElement.addEventListener('webglcontextrestored', () => {
      viewer.startRenderLoop();
    });

    return viewer;
  }

  /**
   * Load a model. Builds per-step Three.Group containers so subsequent
   * setMaxStep() calls are visibility toggles, not rebuilds.
   *
   * Can be called multiple times — disposes previous model's meshes first.
   */
  async load(bricks: ParsedBrick[], opts?: LDrawViewerOptions): Promise<void> {
    if (this.disposed) throw new Error('LDrawViewer is disposed');

    // Tear down previous model state
    this.unloadCurrent();

    // Inject MPD inlines into part cache (these are model-specific)
    clearMpdInlines();
    if (opts?.mpdContent) preloadMpdInlines(opts.mpdContent);

    // Filter out non-visual primitives (logo stamps, lsynth)
    const filteredBricks = bricks.filter(b => !isLDrawPrimitive(b.part));

    const instCount = new Map<string, number>();
    for (const b of filteredBricks) {
      const id = normId(b.part);
      instCount.set(id, (instCount.get(id) ?? 0) + 1);
    }
    const uniqueParts = [...new Set(filteredBricks.map(b => normId(b.part)))];

    // Prefetch part geometry concurrently (cache-warm reads thereafter).
    let done = 0;
    const CONCURRENCY = 20;
    for (let i = 0; i < uniqueParts.length; i += CONCURRENCY) {
      const batch = uniqueParts.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async partId => {
        await resolvePartGeometry(partId);
        done++;
        opts?.onProgress?.(done, uniqueParts.length);
      }));
    }

    // Repair pass (runs BEFORE meshes are built, so it fixes the render too):
    // concurrent resolution can leave a wrapper/sub-referenced part (e.g. the
    // minifig arm 3819 → 3818 → s/3818s01) with INCOMPLETE geometry if it read
    // a dependency's not-yet-populated placeholder. Re-resolve any empty part
    // SEQUENTIALLY (no race) so wrapper parts rebuild from now-complete deps.
    // Whatever is still empty after this is genuinely unrenderable (missing
    // from the library, or an LSynth flexible part needing curve synthesis).
    const triCount = (g?: { tris: unknown[]; colorTris: Map<number, unknown[]> }): number =>
      g ? g.tris.length + [...g.colorTris.values()].reduce((s, a) => s + a.length, 0) : 0;
    const empties = uniqueParts.filter(p => triCount(getCachedPartGeom(p)) === 0);
    for (const p of empties) invalidatePartGeom(p);
    for (const p of empties) await resolvePartGeometry(p);
    const missing = new Map<string, number>();
    for (const p of uniqueParts) {
      if (triCount(getCachedPartGeom(p)) === 0) missing.set(p, instCount.get(p) ?? 1);
    }
    this.missingParts = [...missing.entries()].map(([part, count]) => ({ part, count }));

    // Highest step number across the model (drives the slider range).
    let maxStep = 1;
    for (const brick of filteredBricks) maxStep = Math.max(maxStep, brick.step ?? 1);
    this.maxAvailableStep = maxStep;

    // Track scene bbox across ALL steps so framing stays stable when stepping
    const bboxMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    const bboxMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    // Build ONE global group: instances are bucketed by (part,color) across
    // the WHOLE model rather than per step, so a 1700-step set renders in a
    // few hundred draw calls instead of thousands (each step previously got
    // its own InstancedMeshes). Stepping is done by prefix-counting
    // step-sorted instances (see applyStepVisibility), not by toggling
    // per-step groups.
    const stepState = this.buildStepGroup(filteredBricks, bboxMin, bboxMax);
    stepState.group.name = 'model';
    this.stepGroups.set(0, stepState);
    this.scene.add(stepState.group);

    // Apply initial maxStep (default = show all)
    this.currentMaxStep = opts?.maxStep ?? Number.POSITIVE_INFINITY;
    this.applyStepVisibility();

    // Compute final bbox and set up camera + backdrop + SAO + edge widths.
    // Use a triangle-weighted centroid as the camera target so the visual
    // mass (large bodies) drives framing, not stray scattered figures /
    // accessories that drag the bbox center off the main subject. The
    // bbox itself is still used for fit-distance corner projection.
    if (Number.isFinite(bboxMin.x)) {
      const visualCenter = this.computeWeightedCentroid(bboxMin, bboxMax);
      const size = new THREE.Vector3().subVectors(bboxMax, bboxMin);
      const maxDim = Math.max(size.x, size.y, size.z) || 10;

      this.scene.fog = new THREE.FogExp2(
        (this.scene.background as THREE.Color).getHex(),
        0.15 / maxDim,
      );
      // Lights + backdrop still anchor on bbox geometric center so they
      // illuminate / receive shadows symmetrically across the model bounds.
      const bboxCenter = new THREE.Vector3().lerpVectors(bboxMin, bboxMax, 0.5);
      this.positionLights(bboxCenter, maxDim);
      this.buildBackdrop(bboxCenter, size, maxDim, bboxMin);
      // Detect F/B/L/R orientation BEFORE first frameCamera so the initial
      // iso pose uses the model-aware axes too.
      this.detectOrientation();
      this.frameCamera(visualCenter, size, bboxMin, bboxMax, maxDim);
      this.installSAO(maxDim);
      this.updateEdgeLineWidth(maxDim);
      this.adaptExposure();
      // Cache for setView() presets
      this.lastBboxMin.copy(bboxMin);
      this.lastBboxMax.copy(bboxMax);
      this.lastVisualCenter.copy(visualCenter);
      this.lastSize.copy(size);
      this.lastMaxDim = maxDim;
    }

    this.loaded = true;
    this.requestShadowUpdate(); // build the static shadow map once for this model
    this.container.dataset['brickCount'] = String(filteredBricks.length);
    this.container.dataset['stepMax'] = String(this.maxAvailableStep);

    // Dev-only debugging hook: expose the live viewer so renderer.info,
    // step-group structure, etc. can be inspected from the console / E2E.
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
      (globalThis as Record<string, unknown>)['__ldrawViewer'] = this;
    }
  }

  /**
   * Toggle visibility of step groups. O(steps), no rebuild.
   * The architectural win over the previous renderer.
   */
  setMaxStep(step: number): void {
    if (this.disposed || !this.loaded) return;
    this.currentMaxStep = step;
    this.applyStepVisibility();
    this.requestShadowUpdate(); // visible-brick set changed → refresh shadows
  }

  /** Returns the highest step number found in the loaded model. */
  getMaxAvailableStep(): number {
    return this.maxAvailableStep;
  }

  /** Tone-mapping exposure (1.0 default, ACES filmic). */
  setExposure(value: number): void {
    this.renderer.toneMappingExposure = value;
  }

  /**
   * Spread bricks outward from the visual centroid by `factor` × distance.
   * 0 = assembled, 1.0 ≈ double the distance from center. Rewrites every
   * InstancedMesh's per-instance matrices from their cached originals.
   *
   * Edge lines (LineSegments2) are world-space-baked per step and can't be
   * displaced, so we just hide them whenever factor > 0 to avoid a confusing
   * "ghost outline" sitting at the assembled positions.
   */
  setExplodeFactor(factor: number): void {
    if (!this.loaded) return;
    const center = this.lastVisualCenter;
    const tmpPos = new THREE.Vector3();
    const tmpRot = new THREE.Quaternion();
    const tmpScale = new THREE.Vector3();
    const tmpMat = new THREE.Matrix4();
    const hideEdges = factor > 0.001;

    for (const stepState of this.stepGroups.values()) {
      stepState.group.traverse(obj => {
        if (obj instanceof LineSegments2) {
          // Only the wireframe toggle should keep edges visible across an
          // explode; if wireframe is on, hideEdges should be false-overridden
          // upstream — but in practice wireframe + explode is incoherent so
          // we just hide edges here.
          obj.visible = !hideEdges;
          return;
        }
        if (!(obj instanceof THREE.InstancedMesh)) return;
        const originals = obj.userData['originalMatrices'] as THREE.Matrix4[] | undefined;
        if (!originals) return;
        for (let i = 0; i < originals.length; i++) {
          originals[i]!.decompose(tmpPos, tmpRot, tmpScale);
          tmpPos.set(
            tmpPos.x + (tmpPos.x - center.x) * factor,
            tmpPos.y + (tmpPos.y - center.y) * factor,
            tmpPos.z + (tmpPos.z - center.z) * factor,
          );
          tmpMat.compose(tmpPos, tmpRot, tmpScale);
          obj.setMatrixAt(i, tmpMat);
        }
        obj.instanceMatrix.needsUpdate = true;
        obj.computeBoundingBox();
        obj.computeBoundingSphere();
      });
    }
    this.requestShadowUpdate(); // bricks moved → refresh shadows
  }

  setAutoRotate(enabled: boolean): void {
    this.controls.autoRotate = enabled;
  }

  /**
   * Model bounding-box size in studs (scene units == studs, since
   * LDU_TO_UNITS = 1/20). null until a model is loaded. 1 stud = 0.8 cm.
   */
  getModelSizeStuds(): { x: number; y: number; z: number } | null {
    if (!this.loaded) return null;
    return { x: this.lastSize.x, y: this.lastSize.y, z: this.lastSize.z };
  }

  /**
   * Toggle a small perf overlay (FPS, draw calls, triangles) in the
   * top-right of the canvas container. Useful for evaluating the impact
   * of perf changes (InstancedMesh, color jitter, etc.).
   */
  setStatsOverlay(enabled: boolean): void {
    if (enabled && !this.statsOverlay) {
      const div = document.createElement('div');
      div.style.cssText = `
        position: absolute; top: 8px; right: 8px; z-index: 10;
        padding: 6px 10px; background: rgba(0,0,0,0.7); color: #fff;
        font: 11px/1.4 ui-monospace,monospace; border-radius: 4px;
        pointer-events: none; white-space: pre;`;
      this.container.style.position ||= 'relative';
      this.container.appendChild(div);
      this.statsOverlay = div;
    } else if (!enabled && this.statsOverlay) {
      this.statsOverlay.remove();
      this.statsOverlay = null;
      this.frameTimes = [];
    }
    this.invalidate(); // overlay toggled; render one frame to reflect it
  }

  /**
   * Wireframe mode: hide brick meshes, keep only edge LineSegments2.
   * Useful for inspecting brick connectivity without surface fills.
   */
  setWireframe(wireframe: boolean): void {
    for (const stepState of this.stepGroups.values()) {
      stepState.group.traverse(obj => {
        if (obj instanceof THREE.Mesh) obj.visible = !wireframe;
      });
    }
    this.requestShadowUpdate(); // mesh visibility changed → refresh shadows
  }

  /**
   * Set scene background + studio backdrop tint. Pass a hex int (e.g.
   * 0x2d2d3d) — backdrop and floor are tinted to a slightly lighter
   * shade for visual separation, keeping fog/lighting consistent.
   */
  setBackgroundColor(hex: number): void {
    (this.scene.background as THREE.Color).setHex(hex);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.setHex(hex);
    }
    // Update studio backdrop materials to a slightly lighter tint of bg
    const bgColor = new THREE.Color(hex);
    const backdropColor = bgColor.clone().lerp(new THREE.Color(0xffffff), 0.18);
    for (const obj of this.backdropMeshes) {
      if (obj instanceof THREE.Mesh) {
        const m = obj.material as THREE.MeshPhysicalMaterial;
        // Skip the contact-shadow basic material (no .color in this sense)
        if (m instanceof THREE.MeshPhysicalMaterial) m.color.copy(backdropColor);
      }
    }
    this.invalidate();
  }

  /** Capture a PNG screenshot of the current view at the live canvas size. */
  captureScreenshot(): string {
    this.composer.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  /**
   * Render and capture the current view at arbitrary dimensions, then restore
   * the live viewer's size. Useful for high-res exports (4K, 8K) regardless
   * of the on-screen canvas size. Blocks for one composer.render() — typical
   * cost on a modern GPU is <100ms even at 4K.
   */
  captureScreenshotAt(width: number, height: number): string {
    if (width <= 0 || height <= 0) throw new Error('Invalid export dimensions');

    // Save current state
    const liveW = this.container.clientWidth;
    const liveH = this.container.clientHeight;
    const liveAspect = this.camera.aspect;
    const livePR = this.renderer.getPixelRatio();

    try {
      // Resize at PR=1 so width/height map 1:1 to output pixels.
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      this.composer.setSize(width, height);
      this.fxaaPass.material.uniforms['resolution']!.value.set(1 / width, 1 / height);
      for (const stepState of this.stepGroups.values()) {
        for (const edgeMat of stepState.edgeMaterials) {
          edgeMat.resolution.set(width, height);
        }
      }
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();

      // Re-fit camera so the model frames correctly at the new aspect
      if (this.loaded) {
        this.fitCameraToCurrentView();
      }

      this.composer.render();
      return this.renderer.domElement.toDataURL('image/png');
    } finally {
      // Restore live state
      this.renderer.setPixelRatio(livePR);
      this.renderer.setSize(liveW, liveH, false);
      this.composer.setSize(liveW, liveH);
      this.fxaaPass.material.uniforms['resolution']!.value.set(
        1 / (liveW * livePR),
        1 / (liveH * livePR),
      );
      for (const stepState of this.stepGroups.values()) {
        for (const edgeMat of stepState.edgeMaterials) {
          edgeMat.resolution.set(liveW, liveH);
        }
      }
      this.camera.aspect = liveAspect;
      this.camera.updateProjectionMatrix();
      if (this.loaded) {
        this.fitCameraToCurrentView();
      }
    }
  }

  /**
   * Re-fit the camera using the current direction (preserving user's orbit
   * orientation) but adjusting distance for the current camera.aspect. Used
   * by captureScreenshotAt to handle the temporary aspect change.
   */
  private fitCameraToCurrentView(): void {
    if (!this.loaded) return;
    const dir = this.camera.position.clone().sub(this.lastVisualCenter).normalize();
    this.fitCameraToDirection(
      dir,
      this.lastVisualCenter,
      this.lastSize,
      this.lastBboxMin,
      this.lastBboxMax,
      this.lastMaxDim,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animId);
    this.resizeObs?.disconnect();
    if (this.clickHandler) {
      this.renderer.domElement.removeEventListener('click', this.clickHandler);
      this.clickHandler = null;
    }
    if (this.moveHandler) {
      this.renderer.domElement.removeEventListener('mousemove', this.moveHandler);
      this.moveHandler = null;
    }
    if (this.leaveHandler) {
      this.renderer.domElement.removeEventListener('mouseleave', this.leaveHandler);
      this.leaveHandler = null;
    }
    this.controls.dispose();
    this.unloadCurrent();
    for (const g of this.sharedPartGeoms.values()) g?.dispose();
    this.sharedPartGeoms.clear();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.scene.environment?.dispose?.();
    if (this.scene.background instanceof THREE.Texture) this.scene.background.dispose();
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /** Refresh the static shadow map on the next frame (scene changed). */
  private requestShadowUpdate(): void {
    this.renderer.shadowMap.needsUpdate = true;
    this.needsRender = true; // the new shadows must be composited at least once
  }

  /** Flag that the scene changed and a frame must be (re)composited. */
  private invalidate(): void {
    this.needsRender = true;
  }

  private startRenderLoop(): void {
    const loop = () => {
      if (this.disposed) return;
      if (!this.container.isConnected) return;
      this.animId = requestAnimationFrame(loop);

      // Continuous-render conditions: a camera interpolation is running, the
      // turntable is on, or the Stats overlay wants a live FPS read.
      const animating = this.cameraAnim != null || this.controls.autoRotate || this.statsOverlay != null;
      if (!animating && !this.needsRender) return; // idle → skip the frame entirely

      this.tickCameraAnimation();
      // Skip controls.update() while our interpolation owns the camera;
      // otherwise OrbitControls damping fights the lerp and causes jitter.
      // controls.update() emits 'change' while damping settles, which re-flags
      // needsRender so the settle animates smoothly then goes idle.
      if (!this.cameraAnim) this.controls.update();
      // Accumulate renderer.info across ALL of this frame's composer passes so
      // the Stats overlay reports real scene draw calls/triangles instead of
      // just the final OutputPass (which is 1 fullscreen triangle). Manual
      // reset per frame (autoReset off) keeps the dev __ldrawViewer probe valid.
      if (this.statsOverlay) { this.renderer.info.autoReset = false; this.renderer.info.reset(); }
      this.composer.render();
      this.needsRender = false;
      if (this.statsOverlay) this.updateStatsOverlay();
    };
    loop();
  }

  private updateStatsOverlay(): void {
    if (!this.statsOverlay) return;
    const now = performance.now();
    if (this.lastFrameTime > 0) {
      this.frameTimes.push(now - this.lastFrameTime);
      if (this.frameTimes.length > 30) this.frameTimes.shift();
    }
    this.lastFrameTime = now;
    // Update text only every ~10 frames to reduce DOM thrash
    if (this.frameTimes.length % 10 !== 0) return;
    const avgMs = this.frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, this.frameTimes.length);
    const fps = avgMs > 0 ? Math.round(1000 / avgMs) : 0;
    const info = this.renderer.info;
    this.statsOverlay.textContent =
      `FPS: ${fps}  (${avgMs.toFixed(1)}ms)\n` +
      `Calls: ${info.render.calls}\n` +
      `Tris:  ${info.render.triangles.toLocaleString()}\n` +
      `Inst:  ${[...this.stepGroups.values()].reduce((sum, s) => {
        let n = 0;
        s.group.traverse(o => { if (o instanceof THREE.InstancedMesh) n++; });
        return sum + n;
      }, 0)}`;
  }

  private handleResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.fxaaPass.material.uniforms['resolution']!.value.set(1 / (w * pr), 1 / (h * pr));
    for (const stepState of this.stepGroups.values()) {
      for (const edgeMat of stepState.edgeMaterials) {
        edgeMat.resolution.set(w, h);
      }
    }
    this.invalidate(); // viewport changed → recomposite
  }

  /**
   * Collect the model's InstancedMeshes (main + color sub-meshes + textured)
   * for export. Each carries userData.originalMatrices (assembled, pre-explode)
   * so exporter.ts (createExportGroup) can bake out one Mesh per instance for
   * GLB / OBJ / STL.
   */
  /**
   * Diagnostic: geometry-contact connectivity audit (are all pieces connected,
   * or do some float?). Uses real triangle-surface voxel contact, not bounding
   * boxes, so SNOT/clip/microscale joints are detected correctly. Lazy-loaded.
   */
  async auditConnectivity(resLDU = 4): Promise<unknown> {
    const seen = new Set<ParsedBrick>();
    const bricks: ParsedBrick[] = [];
    for (const arr of this.instanceBrickMap.values()) {
      for (const b of arr) if (!seen.has(b)) { seen.add(b); bricks.push(b); }
    }
    const { auditConnectivity } = await import('./connectivity-audit.js');
    return auditConnectivity(bricks, resLDU);
  }

  /**
   * Diagnostic: recolor pieces the connectivity audit marks as NOT in the main
   * component bright red (everything else grey), so detached/floating pieces
   * are visually obvious. Pass the same resLDU you'd give auditConnectivity.
   */
  async highlightDetached(resLDU = 6): Promise<unknown> {
    const seen = new Set<ParsedBrick>();
    const bricks: ParsedBrick[] = [];
    for (const arr of this.instanceBrickMap.values())
      for (const b of arr) if (!seen.has(b)) { seen.add(b); bricks.push(b); }
    const { auditConnectivity } = await import('./connectivity-audit.js');
    const rep = auditConnectivity(bricks, resLDU);
    const flag = new Map<ParsedBrick, boolean>();
    bricks.forEach((b, i) => flag.set(b, rep.isDetached[i]!));
    const red = new THREE.Color(0xff1133), grey = new THREE.Color(0x3a3a40);
    for (const [mesh, arr] of this.instanceBrickMap) {
      for (let i = 0; i < arr.length; i++) mesh.setColorAt(i, flag.get(arr[i]!) ? red : grey);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.invalidate();
    this.composer.render();
    return JSON.stringify({ detached: rep.detached, largestPct: rep.largestPct, components: rep.components });
  }

  exportMeshes(): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    for (const stepState of this.stepGroups.values()) {
      stepState.group.traverse(obj => {
        if (obj instanceof THREE.InstancedMesh && obj.userData['originalMatrices']) {
          out.push(obj);
        }
      });
    }
    return out;
  }

  private applyStepVisibility(): void {
    // Global instancing: instead of toggling per-step groups, prefix-count the
    // step-sorted instances of each mesh (and segments of the edge lines) so
    // only bricks built up to currentMaxStep render. O(meshes · log instances).
    const maxStep = this.currentMaxStep;
    for (const stepState of this.stepGroups.values()) {
      stepState.group.traverse(obj => {
        if (obj instanceof THREE.InstancedMesh) {
          const arr = obj.userData['stepArr'] as Int32Array | undefined;
          if (arr) obj.count = upperBoundCount(arr, maxStep);
        } else if (obj instanceof LineSegments2) {
          const arr = obj.userData['segStep'] as Int32Array | undefined;
          if (arr) (obj.geometry as LineSegmentsGeometry).instanceCount = upperBoundCount(arr, maxStep);
        }
      });
    }
  }

  private unloadCurrent(): void {
    for (const stepState of this.stepGroups.values()) {
      this.scene.remove(stepState.group);
      stepState.group.traverse(obj => {
        // InstancedMesh.geometry is SHARED across loads via sharedPartGeoms
        // cache — disposing it here would leave the cache holding a freed
        // geometry that the next load reuses, producing broken renders.
        // Only dispose non-instanced meshes (none in current paths but defensive).
        if (obj instanceof THREE.InstancedMesh) {
          // Dispose only the per-instance buffers, not the geometry
          obj.dispose();
        } else if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
        } else if (obj instanceof LineSegments2) {
          obj.geometry.dispose();
        }
      });
    }
    this.stepGroups.clear();
    this.instanceBrickMap.clear();
    for (const m of this.allMeshMaterials) {
      // TEXMAP decal materials own a loaded texture; dispose it too or the
      // GPU texture + its image leak on every model swap.
      const map = (m as THREE.MeshPhysicalMaterial).map;
      if (map) map.dispose();
      m.dispose();
    }
    this.allMeshMaterials = [];
    for (const obj of this.backdropMeshes) {
      this.scene.remove(obj);
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else (obj.material as THREE.Material).dispose();
      }
    }
    this.backdropMeshes = [];
    this.loaded = false;
    this.maxAvailableStep = 1;
    this.currentMaxStep = Number.POSITIVE_INFINITY;
  }

  /**
   * Build a single step's Three.Group: per-color merged meshes + fat-line
   * edges. Mutates bboxMin/bboxMax to expand the scene-wide bbox so framing
   * stays stable across step toggles.
   */
  private buildStepGroup(
    stepBricks: ParsedBrick[],
    bboxMin: THREE.Vector3,
    bboxMax: THREE.Vector3,
  ): StepGroupState {
    const group = new THREE.Group();
    const edgeMaterials: LineMaterial[] = [];
    this.currentGeomKeys.clear(); // repopulated as this model's geoms are touched

    // ── Bucket bricks by (partId, brickColor) for InstancedMesh ──────────
    // Same partId reused across many bricks → ONE shared geometry + ONE
    // draw call per (partId, color) pair, instead of merging triangles
    // for every brick instance. Also avoids the per-brick mergeVertices/
    // computeVertexNormals cost — we compute them once per unique partId.
    // Buckets are GLOBAL (all steps): each instance also carries its step so
    // they can be sorted step-ascending and the slider can show a prefix.
    interface InstanceBucket {
      partId: string;
      brickColor: number;
      matrices: THREE.Matrix4[];
      bricks: ParsedBrick[]; // parallel to matrices — for click-to-inspect
      steps: number[];       // parallel to matrices — for step prefixing
    }
    const buckets = new Map<string, InstanceBucket>();
    // Edges as a flat segment list tagged with step + color, sorted by step
    // later so the slider can prefix-count them like the instanced meshes.
    const segPos: number[] = [];   // 6 floats per segment
    const segColor: number[] = []; // 1 colour id per segment
    const segStepArr: number[] = []; // 1 step per segment
    let segCount = 0;

    const scale = LDU_TO_UNITS;

    for (const brick of stepBricks) {
      const partId = normId(brick.part);
      const geom = getCachedPartGeom(partId);
      if (!geom || (geom.tris.length === 0 && geom.colorTris.size === 0)) continue;

      const R = brick.rot ?? IDENTITY;
      const T: Vec3 = [brick.x, brick.y, brick.z];
      const cid = isNaN(brick.color) ? 71 : brick.color;
      const bStep = brick.step ?? 1;

      // Per-instance matrix: applies rotation+translation, then scale + Y-flip
      // (LDraw is Y-down, scene is Y-up). Pre-baked so the InstancedMesh
      // doesn't need its own Y-flip in shader.
      const m = new THREE.Matrix4().set(
        scale * R[0]!,  scale * R[1]!,  scale * R[2]!,  scale * T[0],
        -scale * R[3]!, -scale * R[4]!, -scale * R[5]!, -scale * T[1],
        scale * R[6]!,  scale * R[7]!,  scale * R[8]!,  scale * T[2],
        0, 0, 0, 1,
      );

      const bucketKey = `${partId}|${cid}`;
      let bucket = buckets.get(bucketKey);
      if (!bucket) {
        bucket = { partId, brickColor: cid, matrices: [], bricks: [], steps: [] };
        buckets.set(bucketKey, bucket);
      }
      bucket.matrices.push(m);
      bucket.bricks.push(brick);
      bucket.steps.push(bStep);

      // Edges (merged fat lines; not InstancedMesh). World-space positions;
      // cap total to bound memory.
      if (segCount < 2_000_000) {
        for (const [ev0, ev1] of geom.edges) {
          const we0 = applyMat(ev0, R, T);
          const we1 = applyMat(ev1, R, T);
          segPos.push(
            we0[0]! * scale, -we0[1]! * scale, we0[2]! * scale,
            we1[0]! * scale, -we1[1]! * scale, we1[2]! * scale,
          );
          segColor.push(cid); segStepArr.push(bStep); segCount++;
        }
        for (const [ccid, cedges] of geom.colorEdges) {
          for (const [ev0, ev1] of cedges) {
            const we0 = applyMat(ev0, R, T);
            const we1 = applyMat(ev1, R, T);
            segPos.push(
              we0[0]! * scale, -we0[1]! * scale, we0[2]! * scale,
              we1[0]! * scale, -we1[1]! * scale, we1[2]! * scale,
            );
            segColor.push(ccid); segStepArr.push(bStep); segCount++;
          }
        }
      }
    }

    // Sort each bucket's instances step-ascending so a maxStep prefix selects
    // exactly the built-so-far instances (applyStepVisibility sets .count).
    for (const bucket of buckets.values()) {
      const order = [...bucket.steps.keys()].sort((a, b) => bucket.steps[a]! - bucket.steps[b]!);
      bucket.matrices = order.map(i => bucket.matrices[i]!);
      bucket.bricks = order.map(i => bucket.bricks[i]!);
      bucket.steps = order.map(i => bucket.steps[i]!);
    }

    // Build InstancedMesh per (partId, brickColor) bucket. Sort so opaque
    // buckets render before transparent ones for correct blend order.
    const sortedBuckets = [...buckets.values()].sort((a, b) => {
      const aT = isTransparentColor(a.brickColor) ? 1 : 0;
      const bT = isTransparentColor(b.brickColor) ? 1 : 0;
      return aT - bT;
    });

    const partLocalBox = new THREE.Box3();
    for (const bucket of sortedBuckets) {
      const partGeom = getCachedPartGeom(bucket.partId);
      if (!partGeom) continue;

      // ── Main inherited-color (color-16) mesh ─────────────────────────
      const mainGeom = this.getOrBuildSharedGeometry(bucket.partId, 'main', partGeom.tris);
      if (mainGeom && bucket.matrices.length > 0) {
        const material = makeMaterial(bucket.brickColor);
        this.allMeshMaterials.push(material);
        const inst = new THREE.InstancedMesh(mainGeom, material, bucket.matrices.length);
        inst.frustumCulled = false; // matrices are world-space; default cull check uses geometry's local bbox which is wrong
        inst.castShadow = true;
        inst.receiveShadow = true;
        if (isTransparentColor(bucket.brickColor)) inst.renderOrder = 1;
        for (let i = 0; i < bucket.matrices.length; i++) {
          inst.setMatrixAt(i, bucket.matrices[i]!);
        }
        inst.instanceMatrix.needsUpdate = true;
        // Keep the assembled matrices alive for setExplodeFactor() to lerp
        // against. Clone so subsequent explode updates don't mutate the
        // bucket's working buffers.
        inst.userData['originalMatrices'] = bucket.matrices.map(m => m.clone());
        // Step-ascending array parallel to instances; applyStepVisibility sets
        // inst.count to the prefix where step <= maxStep.
        inst.userData['stepArr'] = Int32Array.from(bucket.steps);
        // Compute the InstancedMesh's true world-space bbox/sphere from
        // instance matrices — without this, frustum culling uses the
        // part-local bbox (small, around origin) and culls the entire mesh
        // even though the instances are scattered across world space.
        inst.computeBoundingBox();
        inst.computeBoundingSphere();
        // (Per-instance color jitter was disabled — initial implementation
        // multiplied with material.color in the shader, over-darkening
        // every instance. A correct implementation would use small
        // multipliers around 1.0; deferred until I can verify it
        // actually improves perceived realism without distorting hue.)
        // Track instance → brick for click-to-inspect
        this.instanceBrickMap.set(inst, bucket.bricks);
        // Expand scene bbox by transforming part-local bbox via each instance
        if (mainGeom.boundingBox) {
          for (const m of bucket.matrices) {
            partLocalBox.copy(mainGeom.boundingBox).applyMatrix4(m);
            bboxMin.min(partLocalBox.min);
            bboxMax.max(partLocalBox.max);
          }
        }
        group.add(inst);
      }

      // ── Explicit-color sub-meshes (printed tiles, multi-colored parts) ─
      // Same instance matrices for each explicit-color sub-geometry.
      for (const [ccid, ctris] of partGeom.colorTris) {
        const subGeom = this.getOrBuildSharedGeometry(bucket.partId, `c${ccid}`, ctris);
        if (!subGeom) continue;
        const cMat = makeMaterial(ccid);
        this.allMeshMaterials.push(cMat);
        const cInst = new THREE.InstancedMesh(subGeom, cMat, bucket.matrices.length);
        cInst.frustumCulled = false;
        cInst.castShadow = true;
        cInst.receiveShadow = true;
        if (isTransparentColor(ccid)) cInst.renderOrder = 1;
        for (let i = 0; i < bucket.matrices.length; i++) {
          cInst.setMatrixAt(i, bucket.matrices[i]!);
        }
        cInst.instanceMatrix.needsUpdate = true;
        cInst.userData['originalMatrices'] = bucket.matrices.map(m => m.clone());
        cInst.userData['stepArr'] = Int32Array.from(bucket.steps);
        cInst.computeBoundingBox();
        cInst.computeBoundingSphere();
        if (subGeom.boundingBox) {
          for (const m of bucket.matrices) {
            partLocalBox.copy(subGeom.boundingBox).applyMatrix4(m);
            bboxMin.min(partLocalBox.min);
            bboxMax.max(partLocalBox.max);
          }
        }
        group.add(cInst);
      }

      // ── Textured sub-meshes (!TEXMAP PLANAR with !DATA decals) ─────────
      if (partGeom.texTris) {
        for (const [image, texTris] of partGeom.texTris) {
          const url = partTextureUrls.get(image);
          if (!url || texTris.length === 0) continue;
          const positions = new Float32Array(texTris.length * 9);
          const uvs       = new Float32Array(texTris.length * 6);
          for (let i = 0; i < texTris.length; i++) {
            const t = texTris[i]!;
            const pi = i * 9, ui = i * 6;
            positions[pi+0] = t.v[0][0]; positions[pi+1] = t.v[0][1]; positions[pi+2] = t.v[0][2];
            positions[pi+3] = t.v[1][0]; positions[pi+4] = t.v[1][1]; positions[pi+5] = t.v[1][2];
            positions[pi+6] = t.v[2][0]; positions[pi+7] = t.v[2][1]; positions[pi+8] = t.v[2][2];
            uvs[ui+0] = t.uv[0][0]; uvs[ui+1] = 1 - t.uv[0][1];
            uvs[ui+2] = t.uv[1][0]; uvs[ui+3] = 1 - t.uv[1][1];
            uvs[ui+4] = t.uv[2][0]; uvs[ui+5] = 1 - t.uv[2][1];
          }
          const tGeo = new THREE.BufferGeometry();
          tGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          tGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
          tGeo.computeVertexNormals();
          tGeo.computeBoundingBox();
          tGeo.computeBoundingSphere();
          const tex = new THREE.TextureLoader().load(url);
          tex.colorSpace = THREE.SRGBColorSpace;
          // Tint white so the decal art shows through unmodified; honor the
          // brick's clearcoat/finish so stickers don't look flat against
          // glossy ABS around them.
          const tMat = new THREE.MeshPhysicalMaterial({
            map: tex, color: 0xffffff, roughness: 0.32, metalness: 0.0,
            clearcoat: 0.25, clearcoatRoughness: 0.35, side: THREE.DoubleSide,
            transparent: true, alphaTest: 0.04,
          });
          this.allMeshMaterials.push(tMat);
          const tInst = new THREE.InstancedMesh(tGeo, tMat, bucket.matrices.length);
          tInst.frustumCulled = false;
          tInst.castShadow = false;       // decals on top of the brick — no self-shadow
          tInst.receiveShadow = true;
          tInst.renderOrder = 2;          // draw after opaque body, after edges
          for (let i = 0; i < bucket.matrices.length; i++) {
            tInst.setMatrixAt(i, bucket.matrices[i]!);
          }
          tInst.instanceMatrix.needsUpdate = true;
          tInst.userData['originalMatrices'] = bucket.matrices.map(m => m.clone());
          tInst.userData['stepArr'] = Int32Array.from(bucket.steps);
          tInst.computeBoundingBox();
          tInst.computeBoundingSphere();
          group.add(tInst);
        }
      }
    }

    // ONE global LineSegments2 holding every brick's edges, with segments
    // sorted step-ascending so the slider prefixes them via instanceCount
    // (LineSegmentsGeometry is an InstancedBufferGeometry — one instance per
    // segment). Edge color: HSL-darken the brick's base color so saturated
    // dark bricks (dark teal, dark red, navy) keep their hue identity in the
    // separation lines; pure-luminance darkening flattened them to the same
    // near-black. Cache the per-color premultiplied edge tint.
    const hsl: { h: number; s: number; l: number } = { h: 0, s: 0, l: 0 };
    const edgeTint = new Map<number, [number, number, number]>();
    const tintFor = (colorId: number): [number, number, number] => {
      const cached = edgeTint.get(colorId);
      if (cached) return cached;
      getThreeColor(colorId).getHSL(hsl);
      // Darken toward a ~22% lightness floor; preserve hue + most saturation.
      const targetL = Math.min(hsl.l, 0.22);
      const ec = hsl.s > 0.08
        ? new THREE.Color().setHSL(hsl.h, hsl.s * 0.75, targetL)
        : new THREE.Color(0.12, 0.12, 0.14);
      const opacity = hsl.l > 0.4 ? 0.45 : 0.30;
      const t: [number, number, number] = [ec.r * opacity, ec.g * opacity, ec.b * opacity];
      edgeTint.set(colorId, t);
      return t;
    };

    if (segCount > 0) {
      // Sort segment indices step-ascending.
      const order = [...segStepArr.keys()].sort((a, b) => segStepArr[a]! - segStepArr[b]!);
      const allEdgePos = new Float32Array(segCount * 6);
      const allEdgeCol = new Float32Array(segCount * 6);
      const sortedSegStep = new Int32Array(segCount);
      for (let s = 0; s < order.length; s++) {
        const idx = order[s]!;
        const src = idx * 6;
        const dst = s * 6;
        for (let k = 0; k < 6; k++) allEdgePos[dst + k] = segPos[src + k]!;
        const [r, g, b] = tintFor(segColor[idx]!);
        allEdgeCol[dst]     = r; allEdgeCol[dst + 1] = g; allEdgeCol[dst + 2] = b;
        allEdgeCol[dst + 3] = r; allEdgeCol[dst + 4] = g; allEdgeCol[dst + 5] = b;
        sortedSegStep[s] = segStepArr[idx]!;
      }
      const edgeGeo = new LineSegmentsGeometry();
      edgeGeo.setPositions(allEdgePos);
      edgeGeo.setColors(allEdgeCol);
      const edgeMat = new LineMaterial({
        vertexColors: true,
        worldUnits: false,
        linewidth: 1.0, // refined by updateEdgeLineWidth() once bbox known
        transparent: true,
        depthWrite: false,
      });
      edgeMat.resolution.set(this.container.clientWidth, this.container.clientHeight);
      edgeMaterials.push(edgeMat);
      const edgeLines = new LineSegments2(edgeGeo, edgeMat);
      edgeLines.computeLineDistances();
      edgeLines.renderOrder = 2;
      // Step array parallel to segments; applyStepVisibility sets
      // geometry.instanceCount to the prefix where step <= maxStep.
      edgeLines.userData['segStep'] = sortedSegStep;
      group.add(edgeLines);
    }

    this.pruneGeomCache();
    return { group, edgeMaterials };
  }

  /**
   * Raycast the given client coordinates and return the picked brick (if any).
   * Walks all visible InstancedMeshes across visible step groups.
   */
  private pickBrickAt(clientX: number, clientY: number): ParsedBrick | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((clientY - rect.top) / rect.height) * 2 + 1;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(mx, my), this.camera);
    const meshes: THREE.InstancedMesh[] = [];
    for (const stepState of this.stepGroups.values()) {
      if (!stepState.group.visible) continue;
      stepState.group.traverse(o => {
        if (o instanceof THREE.InstancedMesh && o.visible) meshes.push(o);
      });
    }
    const hits = ray.intersectObjects(meshes, false);
    if (hits.length === 0 || hits[0]!.instanceId == null) return null;
    const inst = hits[0]!.object as THREE.InstancedMesh;
    const id = hits[0]!.instanceId;
    return this.instanceBrickMap.get(inst)?.[id] ?? null;
  }

  /**
   * Apply small per-instance brightness jitter so identical-color batches
   * have organic molding-batch variation. THREE.js multiplies instanceColor
   * with material.color in the shader, so the per-instance value should be
   * a SCALE (around 1.0), not a full color — passing the full base color
   * would square the value and over-darken every instance.
   *
   * Range: ±4% per channel, near-uniform so it reads as molding lightness
   * variation rather than hue shift. Deterministic mulberry32 PRNG seeded
   * by count so the pattern stays stable across reloads.
   */

  /**
   * Build (and cache) a shared BufferGeometry for a part's triangle group
   * in part-local LDU space. Smooth normals via mergeVertices for parts
   * with enough triangles to benefit; flat face normals otherwise.
   *
   * Returns null for empty geometries. Cached per (partId, key) so a part
   * used in many models / many step groups merges normals only once.
   */
  /**
   * Evict least-recently-used cached geometries once the cache exceeds the cap,
   * never touching geometry the current model uses (those back live meshes).
   * Map insertion order is LRU order (hits re-insert to the end).
   */
  private pruneGeomCache(): void {
    const cap = LDrawViewer.GEOM_CACHE_CAP;
    if (this.sharedPartGeoms.size <= cap) return;
    let evicted = 0;
    for (const key of [...this.sharedPartGeoms.keys()]) {
      if (this.sharedPartGeoms.size <= cap) break;
      if (this.currentGeomKeys.has(key)) continue; // in use by current model
      this.sharedPartGeoms.get(key)?.dispose();
      this.sharedPartGeoms.delete(key);
      evicted++;
    }
    if (evicted > 0) {
      console.debug(`[ldraw] pruned ${evicted} cached geometries (cap ${cap}, now ${this.sharedPartGeoms.size})`);
    }
  }

  private getOrBuildSharedGeometry(
    partId: string,
    key: string,
    tris: readonly Triangle[],
  ): THREE.BufferGeometry | null {
    const cacheKey = `${partId}|${key}`;
    this.currentGeomKeys.add(cacheKey);
    if (this.sharedPartGeoms.has(cacheKey)) {
      const cached = this.sharedPartGeoms.get(cacheKey) ?? null;
      // LRU touch: re-insert so this key moves to the end (most-recently-used).
      this.sharedPartGeoms.delete(cacheKey);
      this.sharedPartGeoms.set(cacheKey, cached);
      return cached;
    }
    if (tris.length === 0) {
      this.sharedPartGeoms.set(cacheKey, null);
      return null;
    }
    const positions: number[] = [];
    for (const [v0, v1, v2] of tris) {
      // Skip degenerate triangles (zero area)
      if (v0[0] === v1[0] && v0[1] === v1[1] && v0[2] === v1[2] &&
          v0[0] === v2[0] && v0[1] === v2[1] && v0[2] === v2[2]) continue;
      positions.push(v0[0], v0[1], v0[2], v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]);
    }
    if (positions.length === 0) {
      this.sharedPartGeoms.set(cacheKey, null);
      return null;
    }
    const triCount = positions.length / 9;
    let geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (triCount >= 20) {
      // Angle-thresholded creasing: smooth normals across SHALLOW edges
      // (cylinders, studs, curved slopes → round) but keep SHARP edges
      // faceted (90° brick corners → crisp). This is the LDraw convention
      // (~33-40° crease). Blanket mergeVertices+computeVertexNormals — what
      // we did before — averaged across hard corners too, melting brick
      // edges. mergeVertices first welds the triangle soup so coincident
      // verts are shared; toCreasedNormals then assigns per-edge normals.
      const merged = mergeVertices(geom, 1e-4);
      geom.dispose();
      geom = toCreasedNormals(merged, (38 * Math.PI) / 180);
      merged.dispose();
    } else {
      geom.computeVertexNormals();
    }
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    this.sharedPartGeoms.set(cacheKey, geom);
    return geom;
  }

  private updateEdgeLineWidth(maxDim: number): void {
    const lineWidth = Math.max(0.5, Math.min(1.5, 400 / Math.max(maxDim, 1)));
    for (const stepState of this.stepGroups.values()) {
      for (const mat of stepState.edgeMaterials) {
        mat.linewidth = lineWidth;
      }
    }
  }

  /**
   * Triangle-weighted centroid of all loaded meshes — used as the camera
   * target so the visual mass (a Ferrari body, a castle, a train
   * locomotive) anchors the frame rather than the geometric bbox center
   * which can drift toward stray accessories (a dolphin floating beside
   * a boat, minifigs sitting on a baseplate next to the train).
   *
   * Falls back to the geometric bbox center if no meshes have geometry.
   * If the weighted centroid is too close to the bbox center (< 5% of
   * maxDim away), we use the bbox center directly to avoid micro-jitter
   * for symmetric models.
   */
  private computeWeightedCentroid(
    bboxMin: THREE.Vector3,
    bboxMax: THREE.Vector3,
  ): THREE.Vector3 {
    const bboxCenter = new THREE.Vector3().lerpVectors(bboxMin, bboxMax, 0.5);
    let totalWeight = 0;
    const weighted = new THREE.Vector3();
    const tmpMat = new THREE.Matrix4();
    const tmpVec = new THREE.Vector3();

    for (const stepState of this.stepGroups.values()) {
      stepState.group.traverse(obj => {
        if (obj instanceof THREE.InstancedMesh) {
          // For InstancedMesh, the geometry's boundingSphere is in
          // part-local LDU space. Compute the world-space centroid by
          // averaging instance translations, weighted by per-instance
          // geometry-triangle count (so dense parts contribute more).
          const pos = obj.geometry.getAttribute('position');
          if (!pos) return;
          const trisPerInstance = pos.count / 3;
          // Soft cap so a single huge part doesn't dominate
          const weight = Math.min(trisPerInstance, 5000);
          for (let i = 0; i < obj.count; i++) {
            obj.getMatrixAt(i, tmpMat);
            tmpVec.setFromMatrixPosition(tmpMat);
            weighted.addScaledVector(tmpVec, weight);
            totalWeight += weight;
          }
        } else if (obj instanceof THREE.Mesh) {
          if (obj.geometry.boundingSphere == null) obj.geometry.computeBoundingSphere();
          const sphere = obj.geometry.boundingSphere;
          if (!sphere) return;
          const pos = obj.geometry.getAttribute('position');
          if (!pos) return;
          const tris = pos.count / 3;
          const weight = Math.min(tris, 50_000);
          weighted.addScaledVector(sphere.center, weight);
          totalWeight += weight;
        }
      });
    }

    if (totalWeight === 0) return bboxCenter;
    weighted.divideScalar(totalWeight);

    // If the weighted center is within 5% of the bbox center, just use bbox.
    const size = new THREE.Vector3().subVectors(bboxMax, bboxMin);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const drift = weighted.distanceTo(bboxCenter);
    if (drift < maxDim * 0.05) return bboxCenter;
    return weighted;
  }

  /**
   * Adjust tone-mapping exposure based on the loaded model's average
   * brick luminance, weighted by triangle count. Mostly-dark scenes
   * (TIE fighters, ISD hull) get a small exposure boost so detail
   * surfaces; mostly-light scenes (white boats, white architecture)
   * get a small reduction so highlights don't blow out.
   *
   * Range is intentionally narrow (0.85–1.20) — bigger swings would
   * fight the ACES filmic curve which already does its own dynamic-
   * range compression. Most mixed-color models stay near 1.0.
   */
  private adaptExposure(): void {
    let totalTris = 0;
    let weightedLum = 0;
    for (const stepState of this.stepGroups.values()) {
      stepState.group.traverse(obj => {
        if (!(obj instanceof THREE.Mesh)) return;
        const pos = obj.geometry.getAttribute('position');
        if (!pos) return;
        const tris = pos.count / 3;
        const mat = obj.material as THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
        const c = mat.color;
        const lum = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
        weightedLum += lum * tris;
        totalTris += tris;
      });
    }
    const avgLum = totalTris > 0 ? weightedLum / totalTris : 0.5;
    // Map: avgLum 0.1 (dark) → 1.20, 0.5 (medium) → 1.00, 0.9 (bright) → 0.85
    const exposure = THREE.MathUtils.clamp(1.0 + (0.5 - avgLum) * 0.4, 0.85, 1.20);
    this.renderer.toneMappingExposure = exposure;
  }

  private positionLights(center: THREE.Vector3, maxDim: number): void {
    const d = maxDim;
    this.keyLight.position.set(center.x + d * 0.6, center.y + d * 1.0, center.z + d * 0.5);
    this.fillLight.position.set(center.x - d * 0.5, center.y + d * 0.4, center.z - d * 0.4);
    this.rimLight.position.set(center.x, center.y + d * 0.3, center.z - d * 0.8);
    this.bottomFill.position.set(center.x, center.y - d * 0.3, center.z);
    const shadowRange = maxDim * 1.2;
    this.keyLight.shadow.camera.left = -shadowRange;
    this.keyLight.shadow.camera.right = shadowRange;
    this.keyLight.shadow.camera.top = shadowRange;
    this.keyLight.shadow.camera.bottom = -shadowRange;
    this.keyLight.shadow.camera.near = maxDim * 0.1;
    this.keyLight.shadow.camera.far = maxDim * 4;
    this.keyLight.shadow.camera.updateProjectionMatrix();
    this.keyLight.target.position.copy(center);
  }

  private buildBackdrop(
    center: THREE.Vector3,
    size: THREE.Vector3,
    maxDim: number,
    bboxMin: THREE.Vector3,
  ): void {
    const gs = maxDim * 5;
    const curveR = gs * 0.55;
    const floorY = bboxMin.y - 0.01;
    const groundColor = 0x4a4a5a;
    const backdropMat = new THREE.MeshPhysicalMaterial({
      color: groundColor, roughness: 0.7, metalness: 0.0,
      clearcoat: 0.1, clearcoatRoughness: 0.5,
      side: THREE.DoubleSide,
    });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(gs * 2, gs * 2), backdropMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(center.x, floorY, center.z);
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.backdropMeshes.push(floor);

    // Soft radial contact shadow under the model
    const csx = Math.max(size.x, 1) * 0.7;
    const csz = Math.max(size.z, 1) * 0.7;
    const shadowCanv = document.createElement('canvas');
    shadowCanv.width = 256; shadowCanv.height = 256;
    const sctx = shadowCanv.getContext('2d')!;
    const grad = sctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0.0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.45, 'rgba(0,0,0,0.32)');
    grad.addColorStop(0.85, 'rgba(0,0,0,0.05)');
    grad.addColorStop(1.0, 'rgba(0,0,0,0)');
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, 256, 256);
    const shadowTex = new THREE.CanvasTexture(shadowCanv);
    shadowTex.colorSpace = THREE.SRGBColorSpace;
    const contactMat = new THREE.MeshBasicMaterial({
      map: shadowTex, transparent: true, depthWrite: false,
    });
    const contactShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), contactMat);
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.scale.set(csx * 2, csz * 2, 1);
    contactShadow.position.set(center.x, floorY + 0.005, center.z);
    contactShadow.renderOrder = -1;
    this.scene.add(contactShadow);
    this.backdropMeshes.push(contactShadow);

    // Curved cyc-wall (quarter-cylinder)
    const curveSegs = 24;
    const verts: number[] = [], norms: number[] = [], uvs: number[] = [];
    for (let i = 0; i <= curveSegs; i++) {
      const t = i / curveSegs;
      const angle = t * Math.PI * 0.5;
      const y = floorY + curveR * Math.sin(angle);
      const z = center.z - gs + curveR * (1 - Math.cos(angle));
      for (const x of [center.x - gs, center.x + gs]) {
        verts.push(x, y, z);
        norms.push(0, Math.cos(angle), Math.sin(angle));
        uvs.push(x < center.x ? 0 : 1, t);
      }
    }
    const indices: number[] = [];
    for (let i = 0; i < curveSegs; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      indices.push(a, b, c, b, d, c);
    }
    const curveGeo = new THREE.BufferGeometry();
    curveGeo.setIndex(indices);
    curveGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    curveGeo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
    curveGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    const backWall = new THREE.Mesh(curveGeo, backdropMat);
    backWall.receiveShadow = true;
    this.scene.add(backWall);
    this.backdropMeshes.push(backWall);
  }

  private frameCamera(
    center: THREE.Vector3,
    size: THREE.Vector3,
    bboxMin: THREE.Vector3,
    bboxMax: THREE.Vector3,
    maxDim: number,
  ): void {
    const aspectRatio = size.y / Math.max(size.x, size.z, 1);
    const elevationFactor = Math.max(0.22, Math.min(0.55, 0.55 - aspectRatio * 0.7));
    // 3/4 iso: 0.85 toward detected front + 0.42 toward detected right + Y up.
    // Falls back to LDraw default if detectOrientation hasn't run yet.
    const ndir = this.frontDir.clone().multiplyScalar(0.85)
      .add(this.rightDir.clone().multiplyScalar(0.42))
      .add(new THREE.Vector3(0, elevationFactor, 0))
      .normalize();
    this.fitCameraToDirection(ndir, center, size, bboxMin, bboxMax, maxDim);
  }

  /**
   * Position camera along the unit direction `ndir` from `center`, with the
   * fit distance computed so all 8 bbox corners project inside the FoV.
   * Shared by frameCamera() (3/4 default) and setView() (canonical presets).
   */
  private fitCameraToDirection(
    ndir: THREE.Vector3,
    center: THREE.Vector3,
    size: THREE.Vector3,
    bboxMin: THREE.Vector3,
    bboxMax: THREE.Vector3,
    maxDim: number,
    animate = false,
  ): void {
    const aspect = this.camera.aspect;
    const fovV = (this.camera.fov * Math.PI) / 180;
    const tanV = Math.tan(fovV / 2);
    const tanH = tanV * aspect;

    const corners = [
      new THREE.Vector3(bboxMin.x, bboxMin.y, bboxMin.z),
      new THREE.Vector3(bboxMax.x, bboxMin.y, bboxMin.z),
      new THREE.Vector3(bboxMin.x, bboxMax.y, bboxMin.z),
      new THREE.Vector3(bboxMax.x, bboxMax.y, bboxMin.z),
      new THREE.Vector3(bboxMin.x, bboxMin.y, bboxMax.z),
      new THREE.Vector3(bboxMax.x, bboxMin.y, bboxMax.z),
      new THREE.Vector3(bboxMin.x, bboxMax.y, bboxMax.z),
      new THREE.Vector3(bboxMax.x, bboxMax.y, bboxMax.z),
    ];
    const forward = ndir.clone().negate();
    const worldUp = new THREE.Vector3(0, 1, 0);
    // Avoid degenerate cross when looking straight up/down — use Z as up
    const upRef = Math.abs(forward.dot(worldUp)) > 0.99
      ? new THREE.Vector3(0, 0, 1) : worldUp;
    const right = new THREE.Vector3().crossVectors(forward, upRef).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    let maxDist = 0;
    for (const c of corners) {
      const local = c.clone().sub(center);
      const lx = Math.abs(local.dot(right));
      const ly = Math.abs(local.dot(up));
      const lz = local.dot(ndir);
      maxDist = Math.max(maxDist, lx / tanH + lz, ly / tanV + lz);
    }
    // Margin is intentionally tight: 0.96 lets the model claim ~70-80% of the
    // viewport height instead of feeling lost in empty backdrop. The 0.30
    // floor on diagonal prevents the camera from clipping into the model
    // for short, wide objects whose corner-projection underestimates depth.
    const fitDist = Math.max(maxDist, size.length() * 0.30) * 0.96;

    const toPos = new THREE.Vector3(
      center.x + ndir.x * fitDist,
      center.y + ndir.y * fitDist,
      center.z + ndir.z * fitDist,
    );
    // Linear-depth precision: keep the near plane as FAR as possible without
    // clipping during close orbits (minDistance is maxDim*0.1, so the camera
    // target never gets closer than that). near=maxDim*0.01 keeps a healthy
    // far:near ratio (~hundreds:1) so 24-bit depth has no z-fighting, while
    // still allowing tight zoom-in. far covers the model + exploded spread.
    const toNear = Math.max(0.1, maxDim * 0.01);
    const toFar = (fitDist + maxDim) * 8;

    this.controls.maxDistance = maxDim * 5;
    this.controls.minDistance = maxDim * 0.1;

    if (animate) {
      this.cameraAnim = {
        fromPos: this.camera.position.clone(),
        toPos,
        fromTarget: this.controls.target.clone(),
        toTarget: center.clone(),
        fromNear: this.camera.near, toNear,
        fromFar: this.camera.far, toFar,
        startMs: performance.now(), duration: 600,
      };
    } else {
      this.cameraAnim = null;
      this.camera.position.copy(toPos);
      this.controls.target.copy(center);
      this.camera.lookAt(center);
      this.camera.near = toNear;
      this.camera.far = toFar;
      this.camera.updateProjectionMatrix();
      this.controls.update();
    }
  }

  /** Advance any in-flight camera animation. Called once per frame. */
  private tickCameraAnimation(): void {
    const a = this.cameraAnim;
    if (!a) return;
    const elapsed = performance.now() - a.startMs;
    const t = Math.min(1, elapsed / a.duration);
    // ease-in-out quad
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    this.camera.position.lerpVectors(a.fromPos, a.toPos, e);
    this.controls.target.lerpVectors(a.fromTarget, a.toTarget, e);
    this.camera.lookAt(this.controls.target);
    this.camera.near = a.fromNear + (a.toNear - a.fromNear) * e;
    this.camera.far  = a.fromFar  + (a.toFar  - a.fromFar)  * e;
    this.camera.updateProjectionMatrix();
    if (t >= 1) this.cameraAnim = null;
  }

  /**
   * Snap to a canonical view direction, preserving the visual centroid.
   * Names: 'iso' (default 3/4), 'front', 'back', 'left', 'right', 'top'.
   */
  setView(name: 'iso' | 'front' | 'back' | 'left' | 'right' | 'top'): void {
    if (!this.loaded) return;
    let ndir: THREE.Vector3;
    // Model-aware orientation: the longest horizontal axis (X vs Z) is the
    // "long" dimension; F/B align with whichever it is. A mass-distribution
    // check picks +/-: the half of the model with FEWER bricks is treated
    // as the "front" (most vehicles/figures are heavier toward the back).
    // L/R are the perpendicular horizontal axis; T is always world +Y.
    const front = this.frontDir;       // unit horiz vector, model's facing dir
    const right = this.rightDir;       // unit horiz vector, model's right side
    switch (name) {
      case 'front': ndir = front.clone(); break;
      case 'back':  ndir = front.clone().negate(); break;
      case 'left':  ndir = right.clone().negate(); break;
      case 'right': ndir = right.clone(); break;
      case 'top':   ndir = new THREE.Vector3(0, 1, 0); break;
      case 'iso':
      default: {
        const aspectRatio = this.lastSize.y / Math.max(this.lastSize.x, this.lastSize.z, 1);
        const elevationFactor = Math.max(0.22, Math.min(0.55, 0.55 - aspectRatio * 0.7));
        // Iso default uses detected front × right combination so the 3/4
        // pose lines up with the model's natural long axis.
        ndir = front.clone().multiplyScalar(0.85)
          .add(right.clone().multiplyScalar(0.42))
          .add(new THREE.Vector3(0, elevationFactor, 0))
          .normalize();
        break;
      }
    }
    this.fitCameraToDirection(
      ndir,
      this.lastVisualCenter,
      this.lastSize,
      this.lastBboxMin,
      this.lastBboxMax,
      this.lastMaxDim,
      true,
    );
  }

  /**
   * Recompute frontDir / rightDir from the current model's brick positions.
   * Uses bbox dimensions + half-mass heuristic — front = lighter half along
   * the longest horizontal axis. Y is always vertical.
   */
  private detectOrientation(): void {
    const positions: THREE.Vector3[] = [];
    const tmpMat = new THREE.Matrix4();
    for (const stepState of this.stepGroups.values()) {
      stepState.group.traverse(obj => {
        if (!(obj instanceof THREE.InstancedMesh)) return;
        const originals = obj.userData['originalMatrices'] as THREE.Matrix4[] | undefined;
        const matrices = originals ?? null;
        const count = matrices ? matrices.length : obj.count;
        for (let i = 0; i < count; i++) {
          if (matrices) {
            const p = new THREE.Vector3();
            matrices[i]!.decompose(p, new THREE.Quaternion(), new THREE.Vector3());
            positions.push(p);
          } else {
            obj.getMatrixAt(i, tmpMat);
            positions.push(new THREE.Vector3().setFromMatrixPosition(tmpMat));
          }
        }
      });
    }
    if (positions.length === 0) {
      this.frontDir.set(0, 0, 1);
      this.rightDir.set(1, 0, 0);
      return;
    }
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of positions) { min.min(p); max.max(p); }
    const sx = max.x - min.x;
    const sz = max.z - min.z;
    const useX = sx > sz * 1.1;        // 10% bias toward Z (LDraw default)
    const cx = (min.x + max.x) * 0.5;
    const cz = (min.z + max.z) * 0.5;
    let posCount = 0, negCount = 0;
    for (const p of positions) {
      if (useX) { (p.x > cx ? posCount++ : negCount++); }
      else      { (p.z > cz ? posCount++ : negCount++); }
    }
    const lighterSign = posCount < negCount ? 1 : -1;
    if (useX) {
      this.frontDir.set(lighterSign, 0, 0);
      this.rightDir.set(0, 0, lighterSign);
    } else {
      this.frontDir.set(0, 0, lighterSign);
      this.rightDir.set(-lighterSign, 0, 0);
    }
  }

  /** Manually flip front<->back if heuristic guessed wrong. */
  flipFront(): void {
    this.frontDir.negate();
    this.rightDir.negate();
    this.setView('front');
  }

  private installSAO(maxDim: number): void {
    if (this.saoPass) {
      const idx = this.composer.passes.indexOf(this.saoPass);
      if (idx >= 0) this.composer.passes.splice(idx, 1);
      this.saoPass = null;
    }
    let totalMeshes = 0;
    for (const stepState of this.stepGroups.values()) {
      stepState.group.traverse(o => { if (o instanceof THREE.Mesh) totalMeshes++; });
    }
    // SAO cost scales with mesh count — InstancedMesh refactor reduced mesh
    // count drastically (often <50 even for thousands of bricks), so we can
    // raise the cap. Intensity bumped (0.012→0.04) for visible crevice
    // darkening; tighter kernel for crisp brick-seam shadows.
    if (totalMeshes <= 80) {
      this.saoPass = new SAOPass(this.scene, this.camera);
      this.saoPass.params.saoBias = 0.4;
      this.saoPass.params.saoIntensity = 0.04;
      this.saoPass.params.saoScale = Math.max(4, maxDim * 0.4);
      this.saoPass.params.saoKernelRadius = Math.max(12, maxDim * 1.0);
      this.saoPass.params.saoBlurRadius = 5;
      // Insert after RenderPass (index 1), before fxaa/vignette/output
      this.composer.passes.splice(1, 0, this.saoPass);
    }
  }
}
