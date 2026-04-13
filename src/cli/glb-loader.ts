/**
 * GLB loading utilities for headless (CLI) environments.
 * Extracts embedded textures and decodes them with sharp since Bun
 * has no DOM ImageLoader for the blob: URLs that GLTFLoader creates.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

// ─── GLB Loading ────────────────────────────────────────────────────────────

/** Load a GLB file from disk into a Three.js scene, decoding embedded textures. */
export async function loadGLB(filepath: string): Promise<THREE.Group> {
  if (!existsSync(filepath)) {
    console.error(`Error: file not found: ${filepath}`);
    process.exit(1);
  }

  const bytes = readFileSync(filepath).buffer as ArrayBuffer;

  // Pre-extract embedded images from the GLB binary so we can decode them
  // with sharp (Bun has no DOM ImageLoader for blob: URLs that GLTFLoader creates).
  const imageBuffers = extractGLBImages(new Uint8Array(bytes));

  const loader = new GLTFLoader();

  // Enable Draco decoding — some GLBs use Draco mesh compression.
  try {
    const dracoLoader = new DRACOLoader();
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const dracoPath = join(
      __dirname, '..', '..', 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf',
    );
    dracoLoader.setDecoderPath('file://' + dracoPath + '/');
    dracoLoader.setDecoderConfig({ type: 'js' });
    loader.setDRACOLoader(dracoLoader);
  } catch (err) {
    console.warn('Draco loader init failed:', (err as Error).message);
  }

  const scene = await new Promise<THREE.Group>((resolve, reject) => {
    loader.parse(bytes, '', (gltf) => {
      resolve(gltf.scene);
    }, (error) => {
      reject(new Error(`GLTF parse error: ${error}`));
    });
  });

  // Post-load: decode embedded textures with sharp and replace broken blob-based
  // textures with DataTexture containing raw RGBA pixels.
  if (imageBuffers.length > 0) {
    await decodeTexturesWithSharp(scene, imageBuffers, new Uint8Array(bytes));
  }

  return scene;
}

/**
 * Extract embedded image buffers from a GLB file's binary chunk.
 * Parses the glTF JSON to find image buffer views, then slices the binary data.
 */
export function extractGLBImages(glb: Uint8Array): Uint8Array[] {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);

  // GLB header: magic(4) + version(4) + length(4)
  if (view.getUint32(0, true) !== 0x46546C67) return []; // Not a GLB

  // Chunk 0: JSON
  const jsonLen = view.getUint32(12, true);
  const jsonBytes = glb.slice(20, 20 + jsonLen);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes));

  // Chunk 1: BIN
  const binOffset = 20 + jsonLen;
  if (binOffset + 8 > glb.byteLength) return [];
  const binLen = view.getUint32(binOffset, true);
  const binData = glb.slice(binOffset + 8, binOffset + 8 + binLen);

  // Extract image data from buffer views
  const images: Uint8Array[] = [];
  const gltfImages = json.images as Array<{ bufferView?: number; mimeType?: string }> | undefined;
  const bufferViews = json.bufferViews as Array<{ byteOffset?: number; byteLength: number }> | undefined;

  if (!gltfImages || !bufferViews) return [];

  for (const img of gltfImages) {
    if (img.bufferView === undefined) {
      images.push(new Uint8Array(0)); // External reference, can't decode
      continue;
    }
    const bv = bufferViews[img.bufferView];
    const offset = bv.byteOffset ?? 0;
    images.push(binData.slice(offset, offset + bv.byteLength));
  }

  return images;
}

/**
 * Decode image buffers with sharp and replace broken textures on meshes.
 * Matches textures to meshes by order of appearance in the glTF image array.
 */
export async function decodeTexturesWithSharp(
  scene: THREE.Group,
  imageBuffers: Uint8Array[],
  glb: Uint8Array,
): Promise<void> {
  let sharpMod: typeof import('sharp');
  try {
    sharpMod = (await import('sharp')).default;
  } catch (err) {
    console.warn('[voxelize] sharp not available — textures will use material.color fallback:', (err as Error).message);
    return;
  }

  // Decode all images to raw RGBA
  const decoded: Array<{ data: Uint8Array; width: number; height: number } | null> = [];
  for (let i = 0; i < imageBuffers.length; i++) {
    const buf = imageBuffers[i];
    if (buf.length === 0) { decoded.push(null); continue; }
    try {
      const img = sharpMod(Buffer.from(buf));
      const meta = await img.metadata();
      const raw = await img.ensureAlpha().raw().toBuffer();
      decoded.push({
        data: new Uint8Array(raw),
        width: meta.width ?? 0,
        height: meta.height ?? 0,
      });
    } catch (err) {
      console.warn(`[voxelize] texture decode failed for image ${i}:`, (err as Error).message);
      decoded.push(null);
    }
  }

  const validCount = decoded.filter(d => d !== null).length;
  if (validCount === 0) return;

  // Build a set of DataTextures from decoded images
  const dataTextures: THREE.DataTexture[] = decoded.map(d => {
    if (!d) return new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const tex = new THREE.DataTexture(d.data, d.width, d.height, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.flipY = false; // glTF textures are not flipped
    return tex;
  });

  // GLTFLoader in headless Bun sets mat.map = null because blob: URL textures
  // can't be decoded without a DOM. We match materials to textures using the
  // glTF JSON: material → baseColorTexture.index → textures[].source → images[].
  const glbView2 = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen2 = glbView2.getUint32(12, true);
  const jsonBytes2 = glb.slice(20, 20 + jsonLen2);
  const gltfJson = JSON.parse(new TextDecoder().decode(jsonBytes2));

  const gltfMaterials = gltfJson.materials as Array<{
    pbrMetallicRoughness?: { baseColorTexture?: { index: number } };
  }> | undefined;
  const gltfTextures = gltfJson.textures as Array<{ source?: number }> | undefined;

  // Map material index → decoded image DataTexture
  const matToTexture = new Map<number, THREE.DataTexture>();
  if (gltfMaterials && gltfTextures) {
    for (let mi = 0; mi < gltfMaterials.length; mi++) {
      const texRef = gltfMaterials[mi].pbrMetallicRoughness?.baseColorTexture;
      if (texRef !== undefined) {
        const texEntry = gltfTextures[texRef.index];
        if (texEntry?.source !== undefined && decoded[texEntry.source]) {
          matToTexture.set(mi, dataTextures[texEntry.source]);
        }
      }
    }
  }

  // Assign DataTextures to mesh materials (GLTFLoader creates materials in JSON order)
  let replaced = 0;
  const materialsSeen = new Map<THREE.Material, number>();
  let matIdx = 0;

  scene.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mat = child.material as THREE.MeshStandardMaterial;
    if (!mat) return;

    let mi = materialsSeen.get(mat);
    if (mi === undefined) {
      mi = matIdx++;
      materialsSeen.set(mat, mi);
    }

    const tex = matToTexture.get(mi);
    if (tex) {
      mat.map = tex;
      mat.needsUpdate = true;
      replaced++;
    }
  });

  console.log(`[voxelize] Decoded ${validCount}/${imageBuffers.length} textures, assigned to ${replaced} meshes`);
}
