#!/usr/bin/env bun
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin, ReorientationPlugin, GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { resolve } from 'path';

const dotenv = await Bun.file(resolve(import.meta.dir, '../.env')).text();
const apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
const dracoDir = resolve(import.meta.dir, '..', 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf');
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('file://' + dracoDir + '/');
dracoLoader.setDecoderConfig({ type: 'js' });
if (typeof globalThis.require === 'undefined') {
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  (globalThis as any).require = (id: string) => {
    if (id === 'fs') return nodeFs;
    if (id === 'path') return nodePath;
    throw new Error(`require('${id}') not polyfilled`);
  };
}
if (typeof (globalThis as any).__dirname === 'undefined') (globalThis as any).__dirname = dracoDir;
const decoderJS = await Bun.file(resolve(dracoDir, 'draco_decoder.js')).text();
const decoderFactory = new Function(decoderJS + '\nreturn DracoDecoderModule;')();
await new Promise<any>((res) => { decoderFactory({ onModuleLoaded: (draco: any) => res(draco) }); });

const lat = 40.7484, lng = -73.9857, radius = 50;
const camera = new THREE.PerspectiveCamera(60, 1, 1, 4000);
camera.position.set(0, 8, 8);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld(true);

const tiles = new TilesRenderer();
tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, useRecommendedSettings: false }));
tiles.registerPlugin(new ReorientationPlugin({ lat: lat * THREE.MathUtils.DEG2RAD, lon: lng * THREE.MathUtils.DEG2RAD, height: 0, recenter: true }));
tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }));
tiles.errorTarget = 4.0;
tiles.setCamera(camera);
tiles.setResolution(camera, 512, 512);

await new Promise<void>((resolve) => {
  let stable = 0;
  const check = () => {
    camera.updateMatrixWorld(true);
    tiles.update();
    const stats = tiles.stats as Record<string, number>;
    const d = stats.downloading ?? 0, p = stats.parsing ?? 0, ok = stats.loaded ?? 0;
    if (d === 0 && p === 0 && ok >= 3) { stable++; if (stable >= 50) { console.log(`Loaded: ${ok}`); resolve(); return; } } else stable = 0;
    setTimeout(check, 50);
  };
  setTimeout(check, 100);
});

// Debug scene graph
console.log('\n--- Scene graph debug ---');
console.log('tiles.group type:', tiles.group?.constructor?.name);
console.log('tiles.group children:', tiles.group?.children?.length);

let meshCount = 0, otherCount = 0;
const types = new Set<string>();
tiles.group.traverse((child: any) => {
  types.add(child.constructor.name);
  if (child instanceof THREE.Mesh) meshCount++;
  else otherCount++;
});
console.log('Types found:', [...types].join(', '));
console.log(`Mesh: ${meshCount}, Other: ${otherCount}`);

// Check if meshes are deeper — print first few levels
const checkDeep = (obj: any, depth: number) => {
  if (depth > 6) return;
  const kids = obj.children || [];
  for (let i = 0; i < Math.min(kids.length, 3); i++) {
    const k = kids[i];
    const hasMesh = k instanceof THREE.Mesh;
    const hasGeo = hasMesh && k.geometry;
    console.log(`${'  '.repeat(depth)}[${i}/${kids.length}] ${k.constructor.name} mesh=${hasMesh} geo=${!!hasGeo} children=${k.children?.length || 0}`);
    if (k.children?.length) checkDeep(k, depth + 1);
  }
};
checkDeep(tiles.group, 0);

// Also check tiles.scene and tiles.root
console.log('\ntiles.scene?', !!(tiles as any).scene);
console.log('tiles.root?', !!(tiles as any).root);

// Try to find meshes via different traversal
let deepMeshes = 0;
const findMeshes = (obj: any) => {
  if (obj.isMesh || (obj.geometry && obj.geometry.isBufferGeometry)) deepMeshes++;
  if (obj.children) for (const c of obj.children) findMeshes(c);
};
findMeshes(tiles.group);
console.log('Deep mesh count (isMesh):', deepMeshes);

process.exit(0);
