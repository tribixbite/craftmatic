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
import type { Vec3, LDrawViewerOptions } from './types.js';
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

interface ColorAccumulator {
  positions: number[];
  normals: number[];
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
  private maxAvailableStep: number = 1;
  private currentMaxStep: number = Number.POSITIVE_INFINITY;

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

    // Compute final bbox and set up camera + backdrop + SAO + edge widths
    if (Number.isFinite(bboxMin.x)) {
      const center = new THREE.Vector3().lerpVectors(bboxMin, bboxMax, 0.5);
      const size = new THREE.Vector3().subVectors(bboxMax, bboxMin);
      const maxDim = Math.max(size.x, size.y, size.z) || 10;

      this.scene.fog = new THREE.FogExp2(
        (this.scene.background as THREE.Color).getHex(),
        0.15 / maxDim,
      );
      this.positionLights(center, maxDim);
      this.buildBackdrop(center, size, maxDim, bboxMin);
      this.frameCamera(center, size, bboxMin, bboxMax, maxDim);
      this.installSAO(maxDim);
      this.updateEdgeLineWidth(maxDim);
      this.adaptExposure();
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

  /** Capture a PNG screenshot of the current view. */
  captureScreenshot(): string {
    this.composer.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animId);
    this.resizeObs?.disconnect();
    this.controls.dispose();
    this.unloadCurrent();
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
    };
    loop();
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
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
        else if (obj instanceof LineSegments2) obj.geometry.dispose();
      });
    }
    this.stepGroups.clear();
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

    const colorGroups = new Map<number, ColorAccumulator>();
    const edgeGroups = new Map<number, { positions: number[] }>();
    let totalEdgeFloats = 0;

    const getCG = (cid: number): ColorAccumulator => {
      let g = colorGroups.get(cid);
      if (!g) { g = { positions: [], normals: [] }; colorGroups.set(cid, g); }
      return g;
    };

    const scale = LDU_TO_UNITS;

    for (const brick of stepBricks) {
      const geom = getCachedPartGeom(brick.part);
      if (!geom || (geom.tris.length === 0 && geom.colorTris.size === 0)) continue;

      const R = brick.rot ?? IDENTITY;
      const T: Vec3 = [brick.x, brick.y, brick.z];
      const cid = isNaN(brick.color) ? 71 : brick.color;
      const acc = getCG(cid);

      // Inherited (color-16) tris in part-local → world-flipped Y space
      const brickPos: number[] = [];
      for (const [lv0, lv1, lv2] of geom.tris) {
        const wv0 = applyMat(lv0, R, T);
        const wv1 = applyMat(lv1, R, T);
        const wv2 = applyMat(lv2, R, T);
        const x0 = wv0[0]! * scale, y0 = -wv0[1]! * scale, z0 = wv0[2]! * scale;
        const x1 = wv1[0]! * scale, y1 = -wv1[1]! * scale, z1 = wv1[2]! * scale;
        const x2 = wv2[0]! * scale, y2 = -wv2[1]! * scale, z2 = wv2[2]! * scale;
        if (x0 === x1 && y0 === y1 && z0 === z1 &&
            x0 === x2 && y0 === y2 && z0 === z2) continue;
        brickPos.push(x0, y0, z0, x1, y1, z1, x2, y2, z2);
      }

      // Per-brick smooth normals via mergeVertices for smooth cylinders
      const triCount = brickPos.length / 9;
      if (brickPos.length >= 9 && triCount >= 20) {
        const brickGeo = new THREE.BufferGeometry();
        brickGeo.setAttribute('position', new THREE.Float32BufferAttribute(brickPos, 3));
        const merged = mergeVertices(brickGeo, 1e-4);
        merged.computeVertexNormals();
        const idx = merged.index;
        const pos = merged.getAttribute('position');
        const norm = merged.getAttribute('normal');
        if (idx && pos && norm) {
          for (let i = 0; i < idx.count; i++) {
            const vi = idx.getX(i);
            acc.positions.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
            acc.normals.push(norm.getX(vi), norm.getY(vi), norm.getZ(vi));
          }
        } else {
          acc.positions.push(...brickPos);
          this.appendFaceNormals(brickPos, acc.normals);
        }
        merged.dispose();
        brickGeo.dispose();
      } else if (brickPos.length >= 9) {
        acc.positions.push(...brickPos);
        this.appendFaceNormals(brickPos, acc.normals);
      }

      // Explicit-color triangles (multi-colored sub-parts: printed tiles, etc.)
      for (const [ccid, ctris] of geom.colorTris) {
        const cAcc = getCG(ccid);
        const cPos: number[] = [];
        for (const [lv0, lv1, lv2] of ctris) {
          const wv0 = applyMat(lv0, R, T);
          const wv1 = applyMat(lv1, R, T);
          const wv2 = applyMat(lv2, R, T);
          cPos.push(
            wv0[0]! * scale, -wv0[1]! * scale, wv0[2]! * scale,
            wv1[0]! * scale, -wv1[1]! * scale, wv1[2]! * scale,
            wv2[0]! * scale, -wv2[1]! * scale, wv2[2]! * scale,
          );
        }
        if (cPos.length > 0) {
          cAcc.positions.push(...cPos);
          this.appendFaceNormals(cPos, cAcc.normals);
        }
      }

      // Edges (cap total to bound memory on dense models)
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

    // Build meshes, opaque first then transparent (correct blending order)
    const sortedEntries = [...colorGroups.entries()].sort((a, b) => {
      const aT = isTransparentColor(a[0]) ? 1 : 0;
      const bT = isTransparentColor(b[0]) ? 1 : 0;
      return aT - bT;
    });

    for (const [colorId, accum] of sortedEntries) {
      if (accum.positions.length === 0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(accum.positions, 3));
      if (accum.normals.length === accum.positions.length) {
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(accum.normals, 3));
      } else {
        geometry.computeVertexNormals();
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      if (geometry.boundingBox) {
        bboxMin.min(geometry.boundingBox.min);
        bboxMax.max(geometry.boundingBox.max);
      }
      const material = makeMaterial(colorId);
      this.allMeshMaterials.push(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (isTransparentColor(colorId)) mesh.renderOrder = 1;
      group.add(mesh);
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

  private appendFaceNormals(positions: number[], out: number[]): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    const n = geo.getAttribute('normal')!;
    for (let i = 0; i < n.count; i++) out.push(n.getX(i), n.getY(i), n.getZ(i));
    geo.dispose();
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
    const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
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
