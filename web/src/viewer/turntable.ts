/**
 * Turntable video export — orbit the camera 360° around the loaded model while
 * recording the WebGL canvas via captureStream + MediaRecorder, yielding a
 * .webm blob.
 *
 * Drives the viewer entirely through its PUBLIC surface (camera, controls,
 * renderer.domElement): each animation frame rotates the camera around the
 * orbit target's world-Y axis by an elapsed-time-proportional step, then calls
 * controls.update() — OrbitControls detects the external camera move and emits
 * 'change', which flags the viewer's render loop to composite a fresh frame
 * (captureStream picks frames up on canvas paint). Angle is ACCUMULATED, so a
 * slow machine still records a full 360° (it just takes longer than nominal).
 */

import { Vector3 } from 'three';

/** Minimal structural slice of LDrawViewer the turntable needs. */
export interface TurntableViewer {
  renderer: { domElement: HTMLCanvasElement };
  camera: { position: Vector3; lookAt(target: Vector3): void };
  controls: { target: Vector3; autoRotate: boolean; update(): boolean | void };
}

export interface TurntableOptions {
  /** Nominal duration of the 360° orbit (default 6000 ms). */
  durationMs?: number;
  /** captureStream frame rate hint (default 30). */
  fps?: number;
  /** Progress callback, fraction 0..1 of the orbit completed. */
  onProgress?: (fraction: number) => void;
}

/** Feature-detect canvas recording (MediaRecorder + canvas.captureStream). */
export function turntableSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

/** Best available WebM mime type for MediaRecorder (vp9 → generic webm). */
export function pickWebmMimeType(): string {
  const preferred = 'video/webm;codecs=vp9';
  return MediaRecorder.isTypeSupported(preferred) ? preferred : 'video/webm';
}

const UP = new Vector3(0, 1, 0);

/**
 * Record one full 360° turntable orbit of the current view and resolve with
 * the encoded WebM blob. The camera ends where it started; controls.autoRotate
 * is suspended for the duration and restored after.
 */
export async function recordTurntable(viewer: TurntableViewer, opts: TurntableOptions = {}): Promise<Blob> {
  if (!turntableSupported()) throw new Error('MediaRecorder / canvas.captureStream not supported in this browser');
  const durationMs = opts.durationMs ?? 6000;
  const fps = opts.fps ?? 30;

  const { camera, controls } = viewer;
  const canvas = viewer.renderer.domElement;
  const prevAutoRotate = controls.autoRotate;
  controls.autoRotate = false;

  const mimeType = pickWebmMimeType();
  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('MediaRecorder error while encoding turntable'));
  });

  recorder.start(250); // timeslice → periodic dataavailable, nothing lost on stop

  try {
    await new Promise<void>(resolve => {
      const TWO_PI = Math.PI * 2;
      let rotated = 0;
      let last = performance.now();
      const tick = (now: number): void => {
        // Clamp dt so a background-tab stall doesn't teleport the camera —
        // the orbit stays smooth and rotation still totals exactly 360°.
        const dt = Math.min(now - last, 100);
        last = now;
        const step = Math.min(TWO_PI * dt / durationMs, TWO_PI - rotated);
        const offset = camera.position.clone().sub(controls.target);
        offset.applyAxisAngle(UP, step);
        camera.position.copy(controls.target).add(offset);
        camera.lookAt(controls.target);
        controls.update(); // detects the move → 'change' → viewer re-renders
        rotated += step;
        opts.onProgress?.(Math.min(1, rotated / TWO_PI));
        if (rotated >= TWO_PI - 1e-6) { resolve(); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    // Let the final frame(s) reach the encoder, then stop and restore state.
    recorder.stop();
    controls.autoRotate = prevAutoRotate;
  }
  await stopped;
  for (const track of stream.getTracks()) track.stop();

  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size === 0) throw new Error('turntable recording produced no data (encoder unavailable?)');
  return blob;
}
