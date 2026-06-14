#!/usr/bin/env bun
/**
 * Generate comparison image sets for tiles pipeline evaluation:
 * 1. Satellite image (Google Static Maps)
 * 2. Raw 3D tiles mesh render (GLB → Three.js → PNG)
 * 3. Voxelized .schem render (already generated)
 *
 * Usage: bun scripts/tiles-comparison-images.ts
 */
import { resolve, join } from 'path';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import sharp from 'sharp';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const TILES_DIR = join(PROJECT_ROOT, 'output/tiles');
const API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';

if (!API_KEY) {
  console.error('GOOGLE_MAPS_API_KEY not set');
  process.exit(1);
}

// Address → lat/lng mapping + GLB filename + schem name
interface BuildingEntry {
  name: string;
  address: string;
  glb: string;
  lat?: number;
  lng?: number;
}

const BUILDINGS: BuildingEntry[] = [
  { name: 'noe-450', address: '450 Noe St, San Francisco, CA', glb: 'tiles-450-noe-st-san-francisco-ca-94114.glb' },
  { name: 'francisco-2340', address: '2340 Francisco St, San Francisco, CA', glb: 'tiles-2340-francisco-st-san-francisco-ca-94123.glb' },
  { name: 'green-2390', address: '2390 Green St, San Francisco, CA', glb: 'tiles-2390-green-st-san-francisco-ca.glb' },
  { name: 'chestnut-2001', address: '2001 Chestnut St, San Francisco, CA', glb: 'tiles-2001-chestnut-st-san-francisco-ca.glb' },
  { name: 'beach-2130', address: '2130 Beach St, San Francisco, CA', glb: 'tiles-2130-beach-st-san-francisco-ca.glb' },
  { name: 'baker-3170', address: '3170 Baker St, San Francisco, CA', glb: 'tiles-3170-baker-st-san-francisco-ca.glb' },
  { name: 'lyon-3601', address: '3601 Lyon St, San Francisco, CA', glb: 'tiles-3601-lyon-st-san-francisco-ca.glb' },
  { name: 'montgomery-600', address: '600 Montgomery St, San Francisco, CA', glb: 'tiles-600-montgomery-st-san-francisco-ca.glb' },
  { name: 'sentinel', address: 'Sentinel Building, San Francisco, CA', glb: 'tiles-sentinel-building-san-francisco-ca.glb' },
  { name: 'esb', address: 'Empire State Building, New York, NY', glb: 'tiles-empire-state-building-new-york-ny.glb' },
  { name: 'flatiron', address: 'Flatiron Building, New York, NY', glb: 'tiles-flatiron-building-new-york-ny.glb' },
  { name: 'chrysler', address: 'Chrysler Building, New York, NY', glb: 'tiles-chrysler-building-new-york-ny.glb' },
  { name: 'st-patricks', address: "St Patrick's Cathedral, New York, NY", glb: 'tiles-st-patrick-s-cathedral-new-york-ny.glb' },
  { name: 'dakota', address: 'The Dakota, New York, NY', glb: 'tiles-the-dakota-new-york-ny.glb' },
];

// ─── Geocode ─────────────────────────────────────────────────────────────────

async function geocode(address: string): Promise<{ lat: number; lng: number }> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${API_KEY}`;
  const resp = await fetch(url);
  const data = await resp.json() as { results: Array<{ geometry: { location: { lat: number; lng: number } } }> };
  if (!data.results?.length) throw new Error(`No geocode result for ${address}`);
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}

// ─── Satellite image ─────────────────────────────────────────────────────────

async function downloadSatellite(lat: number, lng: number, name: string, zoom: number = 20): Promise<string> {
  const outPath = join(TILES_DIR, `${name}-satellite.jpg`);
  if (existsSync(outPath)) {
    console.log(`  Satellite: cached`);
    return outPath;
  }

  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=640x640&maptype=satellite&key=${API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Static maps: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  // Convert to JPEG via sharp
  const jpg = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
  await writeFile(outPath, jpg);
  console.log(`  Satellite: ${(jpg.length / 1024).toFixed(0)}KB (z${zoom})`);
  return outPath;
}

// ─── GLB mesh render (Three.js headless) ─────────────────────────────────────

async function renderGLBMesh(glbPath: string, name: string): Promise<string> {
  const outPath = join(TILES_DIR, `${name}-3dtiles.jpg`);
  if (existsSync(outPath)) {
    console.log(`  3D tiles: cached`);
    return outPath;
  }

  // Import Three.js and GLTFLoader
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

  // Create scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  // Load GLB
  const loader = new GLTFLoader();
  const glbData = await readFile(glbPath);
  const arrayBuf = glbData.buffer.slice(glbData.byteOffset, glbData.byteOffset + glbData.byteLength);

  const gltf = await new Promise<any>((resolve, reject) => {
    loader.parse(arrayBuf, '', resolve, reject);
  });

  // Add all meshes to scene
  const group = gltf.scene;
  scene.add(group);

  // Compute bounding box for camera positioning
  const box = new THREE.Box3().setFromObject(group);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  // Set up isometric-ish camera
  const aspect = 1;
  const fov = 45;
  const dist = maxDim * 1.5;
  const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, dist * 4);
  // Position camera at 45° azimuth, 30° elevation
  const azimuth = Math.PI / 4;
  const elevation = Math.PI / 6;
  camera.position.set(
    center.x + dist * Math.cos(elevation) * Math.sin(azimuth),
    center.y + dist * Math.sin(elevation),
    center.z + dist * Math.cos(elevation) * Math.cos(azimuth),
  );
  camera.lookAt(center);

  // Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(1, 2, 1).normalize();
  scene.add(dir);

  // Render with WebGLRenderer (headless via sharp for output)
  // Since we can't use WebGL in headless Bun, render using software rasterizer approach
  // Instead, capture mesh statistics as a text-based visualization
  // Actually, we need a different approach for headless...

  // Count meshes and extract visual info
  let meshCount = 0;
  let vertCount = 0;
  let triCount = 0;
  group.traverse((child: any) => {
    if (child.isMesh) {
      meshCount++;
      const geo = child.geometry;
      vertCount += geo.attributes?.position?.count ?? 0;
      triCount += (geo.index?.count ?? 0) / 3;
    }
  });

  // For headless, we can't do WebGL rendering - just note this
  // We'll use a placeholder approach: render mesh wireframe stats
  console.log(`  3D tiles: ${meshCount} meshes, ${vertCount} verts, ${Math.round(triCount)} tris — SKIP (no headless WebGL)`);
  return '';
}

// ─── Main ────────────────────────────────────────────────────────────────────

await mkdir(TILES_DIR, { recursive: true });

for (const b of BUILDINGS) {
  console.log(`\n=== ${b.name}: ${b.address} ===`);

  try {
    // Geocode
    const geo = await geocode(b.address);
    b.lat = geo.lat;
    b.lng = geo.lng;
    console.log(`  Location: ${geo.lat.toFixed(6)}, ${geo.lng.toFixed(6)}`);

    // Satellite at zoom 20 for residential, 19 for landmarks/skyscrapers
    const isLarge = ['esb', 'flatiron', 'chrysler', 'st-patricks', 'dakota', 'montgomery-600', 'sentinel'].includes(b.name);
    const zoom = isLarge ? 19 : 20;
    await downloadSatellite(geo.lat, geo.lng, b.name, zoom);

    // GLB mesh render
    const glbPath = join(TILES_DIR, b.glb);
    if (existsSync(glbPath)) {
      await renderGLBMesh(glbPath, b.name);
    } else {
      console.log(`  3D tiles: GLB not found`);
    }

    // Schem render already exists
    const schemJpg = join(TILES_DIR, `${b.name}.jpg`);
    console.log(`  Schem: ${existsSync(schemJpg) ? 'OK' : 'MISSING'}`);

  } catch (err) {
    console.error(`  ERROR: ${(err as Error).message}`);
  }
}

console.log('\nDone. Satellite images saved to output/tiles/*-satellite.jpg');
