if (typeof globalThis.ProgressEvent === 'undefined') {
  (globalThis as Record<string, unknown>).ProgressEvent = class ProgressEvent extends Event {
    readonly lengthComputable: boolean;
    readonly loaded: number;
    readonly total: number;
    constructor(type: string, init?: { lengthComputable?: boolean; loaded?: number; total?: number }) {
      super(type);
      this.lengthComputable = init?.lengthComputable ?? false;
      this.loaded = init?.loaded ?? 0;
      this.total = init?.total ?? 0;
    }
  };
}

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const bytes = await Bun.file(process.argv[2]).arrayBuffer();
const loader = new GLTFLoader();

const scene = await new Promise<THREE.Group>((resolve, reject) => {
  loader.parse(bytes, '', (gltf) => resolve(gltf.scene), (e) => reject(e));
});

const box = new THREE.Box3().setFromObject(scene);
const size = new THREE.Vector3();
box.getSize(size);
const center = new THREE.Vector3();
box.getCenter(center);

console.log(`Box min: (${box.min.x.toFixed(2)}, ${box.min.y.toFixed(2)}, ${box.min.z.toFixed(2)})`);
console.log(`Box max: (${box.max.x.toFixed(2)}, ${box.max.y.toFixed(2)}, ${box.max.z.toFixed(2)})`);
console.log(`Size: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`);
console.log(`Center: (${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)})`);

// Check per-mesh orientation: find the "ground" mesh with largest XZ extent
let meshCount = 0;
scene.traverse((child) => {
  if (child instanceof THREE.Mesh) {
    meshCount++;
    const mbox = new THREE.Box3().setFromObject(child);
    const ms = new THREE.Vector3();
    mbox.getSize(ms);
    const mc = new THREE.Vector3();
    mbox.getCenter(mc);
    console.log(`  Mesh ${meshCount}: center=(${mc.x.toFixed(1)}, ${mc.y.toFixed(1)}, ${mc.z.toFixed(1)}) size=(${ms.x.toFixed(1)}, ${ms.y.toFixed(1)}, ${ms.z.toFixed(1)})`);
  }
});

// Check if Y extent is disproportionate (sign of ECEF tilt)
const xyRatio = size.y / Math.max(size.x, size.z);
console.log(`\nY/XZ ratio: ${xyRatio.toFixed(2)} (should be ~0.2-0.5 for buildings, >0.8 suggests ECEF tilt)`);
