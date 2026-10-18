/**
 * WarpLoader — full-panel "LEGO hyperspace" loading experience.
 *
 * While a model's parts stream in, the viewer renders THIS scene instead of
 * the (still-empty) model scene: a warp-drive starfield of streaking stars
 * rushing past the camera, with REAL loaded part geometries tumbling by as
 * hyperspace debris, plus an HTML overlay showing the big load percentage
 * and status. Replaces the old tiny progress bar (which could sit outside
 * the scroll view) as the primary load indicator.
 *
 * Self-contained: owns its scene/camera/overlay; the host viewer drives it
 *   begin(container) → setProgress(done,total[,label]) / addPartGeometry(...)
 *   → render(renderer, dt) each frame → end() (fades + cleans up).
 */

import * as THREE from 'three';
import type { PartGeom } from './types.js';

const STAR_COUNT = 420;
const TUNNEL_RADIUS = 70;
const TUNNEL_DEPTH = 500;
const MAX_DEBRIS = 22;
/** Bright LEGO palette for stars/debris accents. */
const LEGO_COLORS = [0xd01012, 0x0055bf, 0xf5cd2f, 0x237841, 0xff8c00, 0xffffff, 0x6bc4ff];

interface Debris {
  mesh: THREE.Mesh;
  spin: THREE.Vector3;
  speed: number;
}

export class WarpLoader {
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private stars: THREE.LineSegments;
  private starPos: Float32Array;
  private starSpeed: Float32Array;
  private debris: Debris[] = [];
  private debrisMats: THREE.Material[] = [];
  private debrisGeoms: THREE.BufferGeometry[] = [];
  private overlay: HTMLDivElement | null = null;
  private pctEl: HTMLElement | null = null;
  private subEl: HTMLElement | null = null;
  private active = false;
  private fadeStart = 0;
  /** Public: true while the warp should be rendered (including fade-out). */
  get running(): boolean { return this.active || this.fadeStart > 0; }

  constructor() {
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, TUNNEL_DEPTH * 1.2);
    this.camera.position.set(0, 0, 0);
    this.scene.background = new THREE.Color(0x04040a);
    this.scene.fog = new THREE.Fog(0x04040a, TUNNEL_DEPTH * 0.55, TUNNEL_DEPTH);

    // Starfield: line segments from p to p+streak (streak grows with speed).
    this.starPos = new Float32Array(STAR_COUNT * 6);
    this.starSpeed = new Float32Array(STAR_COUNT);
    const colors = new Float32Array(STAR_COUNT * 6);
    for (let i = 0; i < STAR_COUNT; i++) {
      this.resetStar(i, true);
      const c = new THREE.Color(Math.random() < 0.82 ? 0xcfd8ff : LEGO_COLORS[(Math.random() * LEGO_COLORS.length) | 0]!);
      colors[i * 6] = c.r; colors[i * 6 + 1] = c.g; colors[i * 6 + 2] = c.b;
      colors[i * 6 + 3] = c.r * 0.25; colors[i * 6 + 4] = c.g * 0.25; colors[i * 6 + 5] = c.b * 0.25;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.starPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.stars = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // Debris lighting — simple key + ambient (no env needed at these speeds).
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
    key.position.set(1, 1.4, 0.6);
    this.scene.add(key);
  }

  private resetStar(i: number, scatterDepth = false): void {
    const ang = Math.random() * Math.PI * 2;
    // Bias radius outward so the center stays clear for the percent readout.
    const r = TUNNEL_RADIUS * (0.25 + 0.75 * Math.sqrt(Math.random()));
    const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
    const z = scatterDepth ? -Math.random() * TUNNEL_DEPTH : -TUNNEL_DEPTH;
    const speed = 90 + Math.random() * 260;
    this.starSpeed[i] = speed;
    const streak = speed * 0.055;
    this.starPos[i * 6] = x; this.starPos[i * 6 + 1] = y; this.starPos[i * 6 + 2] = z;
    this.starPos[i * 6 + 3] = x; this.starPos[i * 6 + 4] = y; this.starPos[i * 6 + 5] = z - streak;
  }

  /** Mount the HTML overlay and start animating. */
  begin(container: HTMLElement, label: string): void {
    this.end(true); // dispose any previous run instantly
    this.active = true;
    this.fadeStart = 0;
    // The overlay is absolutely positioned — the container must establish a
    // containing block (inline-viewer already does; be safe elsewhere).
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const ov = document.createElement('div');
    ov.className = 'warp-loader-overlay';
    ov.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;z-index:6;font-family:inherit;transition:opacity 450ms ease-out';
    ov.innerHTML = `
      <div style="font-size:11px;letter-spacing:0.35em;text-transform:uppercase;color:#8f9bff;opacity:0.85;margin-bottom:6px">Entering hyperspace</div>
      <div data-warp-pct style="font-size:64px;font-weight:700;color:#fff;line-height:1;text-shadow:0 0 24px rgba(124,58,237,0.8),0 0 60px rgba(80,120,255,0.5);font-variant-numeric:tabular-nums">0%</div>
      <div data-warp-sub style="margin-top:10px;font-size:12.5px;color:#aeb6d8;text-shadow:0 1px 8px rgba(0,0,0,0.8);max-width:80%;text-align:center">${label.replace(/</g, '&lt;')}</div>
    `;
    container.appendChild(ov);
    this.overlay = ov;
    this.pctEl = ov.querySelector('[data-warp-pct]');
    this.subEl = ov.querySelector('[data-warp-sub]');
  }

  setProgress(done: number, total: number, sub?: string): void {
    if (!this.pctEl) return;
    const pct = total > 0 ? Math.round(100 * done / total) : 0;
    this.pctEl.textContent = `${pct}%`;
    if (this.subEl && sub) this.subEl.textContent = sub;
  }

  /**
   * Add a freshly-resolved part's real geometry as hyperspace debris.
   * Cheap flat-shaded mesh; capped, oldest recycled.
   */
  addPartGeometry(geom: PartGeom | undefined): void {
    if (!this.active || !geom || geom.tris.length === 0 || geom.tris.length > 4000) return;
    const tris = geom.tris;
    const pos = new Float32Array(tris.length * 9);
    let o = 0;
    for (const t of tris) for (const v of t) { pos[o++] = v[0]; pos[o++] = v[1]; pos[o++] = v[2]; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.computeVertexNormals();
    g.center();
    g.scale(0.08, -0.08, 0.08); // LDU → warp units, LDraw Y-down flip
    const mat = new THREE.MeshStandardMaterial({
      color: LEGO_COLORS[(Math.random() * LEGO_COLORS.length) | 0],
      roughness: 0.4, metalness: 0.0, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, mat);
    const ang = Math.random() * Math.PI * 2;
    const r = TUNNEL_RADIUS * (0.3 + 0.5 * Math.random());
    mesh.position.set(Math.cos(ang) * r, Math.sin(ang) * r, -TUNNEL_DEPTH * (0.5 + Math.random() * 0.5));
    mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, 0);
    this.scene.add(mesh);
    this.debris.push({
      mesh,
      spin: new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1),
      speed: 60 + Math.random() * 120,
    });
    this.debrisMats.push(mat);
    this.debrisGeoms.push(g);
    if (this.debris.length > MAX_DEBRIS) {
      const old = this.debris.shift()!;
      this.scene.remove(old.mesh);
      this.debrisGeoms.shift()!.dispose();
      (this.debrisMats.shift() as THREE.Material).dispose();
    }
  }

  /** Advance + render one frame. Returns false once fully finished. */
  render(renderer: THREE.WebGLRenderer, dt: number, aspect: number): boolean {
    if (!this.running) return false;
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    // Stars rush toward +z (camera at 0 looking down -z: stars move from
    // -depth toward 0 and past).
    for (let i = 0; i < STAR_COUNT; i++) {
      const dz = this.starSpeed[i]! * dt;
      this.starPos[i * 6 + 2] += dz;
      this.starPos[i * 6 + 5] += dz;
      if (this.starPos[i * 6 + 2] > 6) this.resetStar(i);
    }
    (this.stars.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    for (const d of this.debris) {
      d.mesh.position.z += d.speed * dt;
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      if (d.mesh.position.z > 8) d.mesh.position.z = -TUNNEL_DEPTH;
    }
    renderer.render(this.scene, this.camera);
    // Fade-out bookkeeping: end() sets fadeStart; overlay CSS fades itself.
    if (!this.active && this.fadeStart > 0 && performance.now() - this.fadeStart > 470) {
      this.cleanup();
      return false;
    }
    return true;
  }

  /** Stop — fades the overlay, then disposes. immediate=true skips the fade. */
  end(immediate = false): void {
    if (!this.active && !this.overlay) return;
    this.active = false;
    if (immediate) { this.cleanup(); return; }
    this.fadeStart = performance.now();
    if (this.overlay) this.overlay.style.opacity = '0';
  }

  private cleanup(): void {
    this.fadeStart = 0;
    this.overlay?.remove();
    this.overlay = null; this.pctEl = null; this.subEl = null;
    for (const d of this.debris) this.scene.remove(d.mesh);
    for (const g of this.debrisGeoms) g.dispose();
    for (const m of this.debrisMats) m.dispose();
    this.debris = []; this.debrisGeoms = []; this.debrisMats = [];
  }

  dispose(): void {
    this.cleanup();
    this.stars.geometry.dispose();
    (this.stars.material as THREE.Material).dispose();
  }
}
