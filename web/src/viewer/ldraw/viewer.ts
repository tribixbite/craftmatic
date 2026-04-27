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
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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

  // Model state — populated by load(), cleared on next load()
  private stepGroups: Map<number, StepGroupState> = new Map();
  private allMeshMaterials: THREE.Material[] = [];
  // Shared geometry cache keyed by `${partId}|main` or `${partId}|c${colorId}`.
  // Persists across load() calls — same part across two models reuses the
  // smoothed BufferGeometry. Disposed only on viewer.dispose().
  private sharedPartGeoms: Map<string, THREE.BufferGeometry | null> = new Map();

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
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // captureScreenshot()
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Lighting — positions set per-load relative to model bbox in positionLights()
    this.ambient = new THREE.AmbientLight(0xffffff, 0.25);
    this.scene.add(this.ambient);
    this.hemi = new THREE.HemisphereLight(0xc8e0ff, 0x443322, 0.3);
    this.scene.add(this.hemi);
    this.keyLight = new THREE.DirectionalLight(0xfff5e6, 3.5);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(4096, 4096);
    this.keyLight.shadow.bias = -0.0005;
    this.keyLight.shadow.normalBias = 0.02;
    this.keyLight.shadow.radius = 3;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);
    this.fillLight = new THREE.DirectionalLight(0xd0e0ff, 0.8);
    this.scene.add(this.fillLight);
    this.rimLight = new THREE.DirectionalLight(0xffffff, 0.5);
    this.scene.add(this.rimLight);
    this.bottomFill = new THREE.DirectionalLight(0xe0e0ff, 0.15);
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

    // Studio environment map (PMREM)
    try {
      const pmremGen = new THREE.PMREMGenerator(viewer.renderer);
      pmremGen.compileEquirectangularShader();
      const envScene = new THREE.Scene();
      envScene.background = new THREE.Color(0xd0d0d8);
      envScene.add(new THREE.HemisphereLight(0xfff8f0, 0x8090a0, 1.2));
      const ceilingLight = new THREE.RectAreaLight(0xffffff, 3.0, 50, 50);
      ceilingLight.position.set(0, 30, 0);
      ceilingLight.lookAt(0, 0, 0);
      envScene.add(ceilingLight);
      viewer.scene.environment = pmremGen.fromScene(envScene, 0.04).texture;
      viewer.scene.environmentIntensity = 0.6;
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

    // Prefetch part geometry with concurrency (cache-warm reads thereafter)
    const uniqueParts = [...new Set(filteredBricks.map(b => normId(b.part)))];
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

    // Group bricks by step number
    const bricksByStep = new Map<number, ParsedBrick[]>();
    let maxStep = 1;
    for (const brick of filteredBricks) {
      const step = brick.step ?? 1;
      maxStep = Math.max(maxStep, step);
      let arr = bricksByStep.get(step);
      if (!arr) { arr = []; bricksByStep.set(step, arr); }
      arr.push(brick);
    }
    this.maxAvailableStep = maxStep;

    // Track scene bbox across ALL steps so framing stays stable when stepping
    const bboxMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    const bboxMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    // Build a Three.Group per step
    const sortedSteps = [...bricksByStep.keys()].sort((a, b) => a - b);
    for (const step of sortedSteps) {
      const stepState = this.buildStepGroup(bricksByStep.get(step)!, bboxMin, bboxMax);
      stepState.group.name = `step-${step}`;
      this.stepGroups.set(step, stepState);
      this.scene.add(stepState.group);
    }

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
    this.container.dataset['brickCount'] = String(filteredBricks.length);
    this.container.dataset['stepMax'] = String(this.maxAvailableStep);
  }

  /**
   * Toggle visibility of step groups. O(steps), no rebuild.
   * The architectural win over the previous renderer.
   */
  setMaxStep(step: number): void {
    if (this.disposed || !this.loaded) return;
    this.currentMaxStep = step;
    this.applyStepVisibility();
  }

  /** Returns the highest step number found in the loaded model. */
  getMaxAvailableStep(): number {
    return this.maxAvailableStep;
  }

  /** Tone-mapping exposure (1.0 default, ACES filmic). */
  setExposure(value: number): void {
    this.renderer.toneMappingExposure = value;
  }

  setAutoRotate(enabled: boolean): void {
    this.controls.autoRotate = enabled;
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

  private startRenderLoop(): void {
    const loop = () => {
      if (this.disposed) return;
      if (!this.container.isConnected) return;
      this.animId = requestAnimationFrame(loop);
      this.controls.update();
      this.composer.render();
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
  }

  private applyStepVisibility(): void {
    for (const [step, stepState] of this.stepGroups) {
      stepState.group.visible = step <= this.currentMaxStep;
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
    for (const m of this.allMeshMaterials) m.dispose();
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

    // ── Bucket bricks by (partId, brickColor) for InstancedMesh ──────────
    // Same partId reused across many bricks → ONE shared geometry + ONE
    // draw call per (partId, color) pair, instead of merging triangles
    // for every brick instance. Also avoids the per-brick mergeVertices/
    // computeVertexNormals cost — we compute them once per unique partId.
    interface InstanceBucket {
      partId: string;
      brickColor: number;
      matrices: THREE.Matrix4[];
      bricks: ParsedBrick[]; // parallel to matrices — for click-to-inspect
    }
    const buckets = new Map<string, InstanceBucket>();
    const edgeGroups = new Map<number, { positions: number[] }>();
    let totalEdgeFloats = 0;

    const scale = LDU_TO_UNITS;

    for (const brick of stepBricks) {
      const partId = normId(brick.part);
      const geom = getCachedPartGeom(partId);
      if (!geom || (geom.tris.length === 0 && geom.colorTris.size === 0)) continue;

      const R = brick.rot ?? IDENTITY;
      const T: Vec3 = [brick.x, brick.y, brick.z];
      const cid = isNaN(brick.color) ? 71 : brick.color;

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
        bucket = { partId, brickColor: cid, matrices: [], bricks: [] };
        buckets.set(bucketKey, bucket);
      }
      bucket.matrices.push(m);
      bucket.bricks.push(brick);

      // Edges (kept as merged-batched per-step — fat lines aren't easily
      // instanced). World-space positions; cap total to bound memory.
      if (totalEdgeFloats < 12_000_000) {
        let eg = edgeGroups.get(cid);
        if (!eg) { eg = { positions: [] }; edgeGroups.set(cid, eg); }
        for (const [ev0, ev1] of geom.edges) {
          const we0 = applyMat(ev0, R, T);
          const we1 = applyMat(ev1, R, T);
          eg.positions.push(
            we0[0]! * scale, -we0[1]! * scale, we0[2]! * scale,
            we1[0]! * scale, -we1[1]! * scale, we1[2]! * scale,
          );
          totalEdgeFloats += 6;
        }
        for (const [ccid, cedges] of geom.colorEdges) {
          let ceg = edgeGroups.get(ccid);
          if (!ceg) { ceg = { positions: [] }; edgeGroups.set(ccid, ceg); }
          for (const [ev0, ev1] of cedges) {
            const we0 = applyMat(ev0, R, T);
            const we1 = applyMat(ev1, R, T);
            ceg.positions.push(
              we0[0]! * scale, -we0[1]! * scale, we0[2]! * scale,
              we1[0]! * scale, -we1[1]! * scale, we1[2]! * scale,
            );
            totalEdgeFloats += 6;
          }
        }
      }
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
    }

    // One LineSegments2 per step containing all that step's brick edges.
    // Edge color: HSL-darken the brick's base color so saturated dark bricks
    // (dark teal, dark red, navy) keep their hue identity in the separation
    // lines. Pure-luminance darkening flattened all dark bricks to the same
    // near-black, losing color signal at the brick boundaries.
    const allEdgePos: number[] = [];
    const allEdgeCol: number[] = [];
    const hsl: { h: number; s: number; l: number } = { h: 0, s: 0, l: 0 };
    for (const [colorId, eg] of edgeGroups) {
      if (eg.positions.length === 0) continue;
      const baseColor = getThreeColor(colorId);
      baseColor.getHSL(hsl);
      // Darken toward 25% lightness floor; preserve hue + most of saturation.
      // For very desaturated grays, fall through to a slightly cool near-black
      // (matches what the prior luminance branch produced).
      const targetL = Math.min(hsl.l, 0.18);
      const ec = hsl.s > 0.08
        ? new THREE.Color().setHSL(hsl.h, hsl.s * 0.85, targetL)
        : new THREE.Color(0.10, 0.10, 0.12);
      const opacity = hsl.l > 0.4 ? 0.7 : 0.5;
      for (let i = 0; i < eg.positions.length; i += 3) {
        allEdgePos.push(eg.positions[i]!, eg.positions[i + 1]!, eg.positions[i + 2]!);
        allEdgeCol.push(ec.r * opacity, ec.g * opacity, ec.b * opacity);
      }
    }
    if (allEdgePos.length > 0) {
      const edgeGeo = new LineSegmentsGeometry();
      edgeGeo.setPositions(new Float32Array(allEdgePos));
      edgeGeo.setColors(new Float32Array(allEdgeCol));
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
      group.add(edgeLines);
    }

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
  private getOrBuildSharedGeometry(
    partId: string,
    key: string,
    tris: readonly Triangle[],
  ): THREE.BufferGeometry | null {
    const cacheKey = `${partId}|${key}`;
    if (this.sharedPartGeoms.has(cacheKey)) {
      return this.sharedPartGeoms.get(cacheKey) ?? null;
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
      const merged = mergeVertices(geom, 1e-4);
      merged.computeVertexNormals();
      geom.dispose();
      geom = merged;
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
    const dirX = 0.42, dirY = elevationFactor, dirZ = 0.85;
    const dirLen = Math.hypot(dirX, dirY, dirZ) || 1;
    const ndir = new THREE.Vector3(dirX / dirLen, dirY / dirLen, dirZ / dirLen);
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
    const fitDist = Math.max(maxDist, size.length() * 0.5) * 1.08;

    this.camera.position.set(
      center.x + ndir.x * fitDist,
      center.y + ndir.y * fitDist,
      center.z + ndir.z * fitDist,
    );
    this.camera.lookAt(center);
    this.camera.near = Math.max(0.01, fitDist * 0.001);
    this.camera.far = fitDist * 10;
    this.camera.updateProjectionMatrix();

    this.controls.target.copy(center);
    this.controls.maxDistance = maxDim * 5;
    this.controls.minDistance = maxDim * 0.1;
    this.controls.update();
  }

  /**
   * Snap to a canonical view direction, preserving the visual centroid.
   * Names: 'iso' (default 3/4), 'front', 'back', 'left', 'right', 'top'.
   */
  setView(name: 'iso' | 'front' | 'back' | 'left' | 'right' | 'top'): void {
    if (!this.loaded) return;
    let ndir: THREE.Vector3;
    switch (name) {
      case 'front': ndir = new THREE.Vector3(0, 0, 1); break;
      case 'back':  ndir = new THREE.Vector3(0, 0, -1); break;
      case 'left':  ndir = new THREE.Vector3(-1, 0, 0); break;
      case 'right': ndir = new THREE.Vector3(1, 0, 0); break;
      case 'top':   ndir = new THREE.Vector3(0, 1, 0); break;
      case 'iso':
      default: {
        const aspectRatio = this.lastSize.y / Math.max(this.lastSize.x, this.lastSize.z, 1);
        const elevationFactor = Math.max(0.22, Math.min(0.55, 0.55 - aspectRatio * 0.7));
        ndir = new THREE.Vector3(0.42, elevationFactor, 0.85).normalize();
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
    );
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
    // SAO is expensive — skip for very large models
    if (totalMeshes <= 30) {
      this.saoPass = new SAOPass(this.scene, this.camera);
      this.saoPass.params.saoBias = 0.5;
      this.saoPass.params.saoIntensity = 0.012;
      this.saoPass.params.saoScale = Math.max(5, maxDim * 0.5);
      this.saoPass.params.saoKernelRadius = Math.max(15, maxDim * 1.5);
      this.saoPass.params.saoBlurRadius = 6;
      // Insert after RenderPass (index 1), before fxaa/vignette/output
      this.composer.passes.splice(1, 0, this.saoPass);
    }
  }
}
