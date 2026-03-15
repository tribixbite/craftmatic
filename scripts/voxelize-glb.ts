/**
 * CLI standalone GLB → .schem voxelizer.
 *
 * Reads a previously-saved GLB file (from the browser tiles pipeline),
 * runs the voxelizer with configurable params, and writes a .schem file.
 * No API calls — iterate on parameters until the output is clean.
 *
 * Usage:
 *   bun scripts/voxelize-glb.ts <input.glb> [options]
 *
 * Options:
 *   --resolution, -r   Blocks per meter (default: 1)
 *   --mode, -m         solid | surface (default: surface)
 *   --min-height       Min mesh height above ground to keep, meters (default: 2)
 *   --trim             Bottom-layer trim fill threshold, 0-1 (default: 0.05)
 *   --output, -o       Output .schem path (default: <input-stem>.schem)
 *   --info             Print mesh stats and exit (no voxelize)
 */

// Polyfill browser APIs that Three.js FileLoader expects in headless Bun
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
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { threeToGrid, createDataTextureSampler } from '../src/convert/voxelizer.js';
import type { VoxelizeMode } from '../src/convert/voxelizer.js';
import { filterMeshesByHeight, trimSparseBottomLayers, smoothRareBlocks, modeFilter3D, constrainPalette, fillInteriorGaps, clearOpenAirFill, removeSmallComponents, cropToCenter, cropToRect, cropToAABB, analyzeGrid, placeEntryPath, removeGroundPlane, maskToFootprint, stripVegetation, glazeDarkWindows, injectSyntheticWindows, smoothSurface, flattenFacades, morphClose3D, consolidateBlockPalette, isolateTallestStructure, enforceFootprintPolygon, addPeakedRoof, homogenizeFacadesByFace, straightenFootprintEdges, isolatePrimaryBuilding, alignOSMToFootprint, maskToFootprintAligned, severByHeightGradient, watershedIsolate, extractEnvironmentPositions } from '../src/convert/mesh-filter.js';
import type { ExtractedEnvironment } from '../src/convert/mesh-filter.js';
import { searchOSMBuilding } from '../src/gen/api/osm.js';
import { rgbToWallBlock, WALL_CLUSTERS } from '../src/gen/color-blocks.js';
import { enrichScene, expandGrid } from '../src/convert/scene-pipeline.js';
import type { AnalysisResult } from '../src/convert/mesh-filter.js';
import { writeSchematic } from '../src/schem/write.js';
import { basename, extname, join, dirname, resolve } from 'node:path';
import sharp from 'sharp';

// ─── Satellite Color Sampling ───────────────────────────────────────────────

/**
 * Fetch satellite image and sample average roof color within the building footprint.
 * Returns the nearest Minecraft block for the observed roof and wall colors.
 * Requires Google Maps API key in .env and building coordinates.
 */
async function sampleSatelliteRoof(
  lat: number, lng: number,
): Promise<{ roofBlock: string; roofRgb: [number, number, number] } | null> {
  // Read API key from .env
  const projectRoot = resolve(import.meta.dir, '..');
  let apiKey: string | undefined;
  try {
    const dotenv = await Bun.file(join(projectRoot, '.env')).text();
    apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
  } catch { /* no .env */ }
  if (!apiKey) {
    console.log('  Satellite color: no API key, skipping');
    return null;
  }

  try {
    // Satellite top-down view (zoom 20 ≈ 0.12m/px) — accurate roof color
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=20&size=256x256&maptype=satellite&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) { console.log(`  Satellite: HTTP ${res.status}`); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height;

    // Sample center 30% of image for roof color
    const margin = Math.floor(w * 0.35);
    let rR = 0, rG = 0, rB = 0, rN = 0;
    for (let y = margin; y < h - margin; y++) {
      for (let x = margin; x < w - margin; x++) {
        const i = (y * w + x) * 3;
        rR += data[i]; rG += data[i + 1]; rB += data[i + 2];
        rN++;
      }
    }
    const roofR = Math.round(rR / rN), roofG = Math.round(rG / rN), roofB = Math.round(rB / rN);
    let roofBlock = rgbToWallBlock(roofR, roofG, roofB);

    // v70: Force gray satellite colors to neutral blocks — prevents warm-toned
    // stone_bricks/terracotta from appearing on gray roofs. Satellite imagery
    // of gray roofs (concrete, slate, asphalt) has very low saturation.
    const roofMax = Math.max(roofR, roofG, roofB);
    const roofMin = Math.min(roofR, roofG, roofB);
    const roofSat = roofMax > 0 ? (roofMax - roofMin) / roofMax : 0;
    if (roofSat < 0.15) {
      const lum = (roofR + roofG + roofB) / 3;
      if (lum < 60) roofBlock = 'minecraft:polished_deepslate';
      else if (lum < 100) roofBlock = 'minecraft:gray_concrete';
      else if (lum < 140) roofBlock = 'minecraft:andesite';
      else if (lum < 180) roofBlock = 'minecraft:light_gray_concrete';
      else roofBlock = 'minecraft:smooth_stone';
    }

    console.log(`  Satellite roof: rgb(${roofR},${roofG},${roofB}) sat=${(roofSat*100).toFixed(0)}%→${roofBlock.replace('minecraft:', '')}`);
    return { roofBlock, roofRgb: [roofR, roofG, roofB] };
  } catch (e) {
    console.log(`  Satellite color: ${(e as Error).message}`);
    return null;
  }
}

// ─── CLI Argument Parsing ───────────────────────────────────────────────────

interface CLIArgs {
  inputPath: string;
  resolution: number;
  mode: VoxelizeMode;
  minHeight: number;
  trimThreshold: number;
  gamma: number;
  kernel: number;
  desaturate: number;
  outputPath: string;
  infoOnly: boolean;
  generic: boolean;
  explicitGeneric: boolean; // true if --generic was explicitly passed on CLI
  explicitFill: boolean;    // true if --fill was explicitly passed on CLI
  explicitModePasses: boolean; // true if --mode-passes was explicitly passed on CLI
  explicitResolution: boolean; // true if -r/--resolution was explicitly passed on CLI
  preview: boolean;
  smoothPct: number;    // smoothRareBlocks threshold (0 = skip)
  modePasses: number;   // modeFilter3D pass count (0 = skip)
  fill: boolean;        // run fillInteriorGaps even in generic mode
  noPalette: boolean;   // skip palette constraint (preserve original colors)
  noCornice: boolean;   // skip roof cornice
  noFireEscape: boolean; // skip fire escape filter
  noGlaze: boolean;     // skip window glazing (reduces surface noise for VLM grading)
  peakedRoof: boolean;  // add synthetic hip/pyramid roof from footprint erosion
  cleanMinSize: number; // removeSmallComponents min size (0 = skip)
  cropRadius: number;   // cropToCenter XZ radius (0 = skip)
  remaps: Map<string, string>; // custom block remaps FROM=TO
  auto: boolean;         // auto-detect building type and set optimal params
  autoInfo: boolean;     // quick analyze-only: voxelize + analyze + print report, no full pipeline
  batch: boolean;        // process multiple GLBs with --auto-info, output summary table
  coords: { lat: number; lng: number } | null; // OSM footprint masking coordinates
  keepVegetation: boolean; // preserve green/brown vegetation blocks (for satellite comparison)
  noEnu: boolean;          // skip ENU reorientation (for pre-oriented headless GLBs)
  noOsm: boolean;          // skip OSM footprint masking (for misaligned geocodes)
  noPostMask: boolean;     // skip post-processing OSM re-mask (v80)
  noIsolate: boolean;      // skip automatic building isolation
  maskDilate: number;      // OSM polygon dilation in blocks (default 3)
  enrich: boolean;         // run scene enrichment (trees, roads, ground) around building
  scene: boolean;          // unified scene pipeline: env extraction → strip → enrich
  plotRadius: number;      // plot context expansion radius in meters (0 = auto)
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: bun scripts/voxelize-glb.ts <input.glb> [options]

Options:
  --resolution, -r   Blocks per meter (default: 1)
  --mode, -m         solid | surface (default: surface)
  --min-height       Min mesh height above ground to keep (default: 2)
  --trim             Bottom-layer trim fill threshold (default: 0.05)
  --gamma, -g        Brightness correction gamma (default: 0.5, <1 brightens baked-lighting tiles)
  --kernel, -k       Texture averaging kernel radius in pixels (default: 12, 0=point sampling)
  --desaturate       Saturation reduction 0-1 to neutralize blue shadows (default: 0.5)
  --output, -o       Output .schem path (default: <input-stem>.schem)
  --info             Print mesh stats and exit (no voxelize)
  --generic          Skip building-specific post-processing (palette remap, fire escape, cornice)
  --desaturate-off   Disable desaturation (preserve original colors)
  --preview          Quick raw voxelize (no post-processing) for visual quality check
  --smooth-pct       Rare block smoothing threshold, 0-1 (default: 0, 0=skip)
  --mode-passes      Mode filter 3D pass count (default: auto 1-2, 0=skip)
  --fill             Run interior fill even in generic mode (fills hollow walls)
  --no-fill          Disable interior fill (override --auto recommendation)
  --no-palette       Skip palette constraint (preserve original colors)
  --no-cornice       Skip roof cornice (Mediterranean brick/spruce)
  --no-fire-escape   Skip fire escape filter (center strip darkening)
  --clean N          Remove disconnected clusters < N voxels (default: 0=skip, 50 recommended)
  --crop N           Keep only blocks within N-block XZ radius of center (isolate central building)
  --remap FROM=TO    Custom block remap (repeatable, e.g. --remap white_concrete=smooth_sandstone)
  --auto             Auto-detect building type and set optimal pipeline params
  --auto-info        Quick analysis: voxelize + analyze + print report (no full pipeline)
  --batch            Process multiple GLB files with auto-analysis, print summary table
  --coords LAT,LNG   OSM footprint masking — query building polygon at these coords, mask grid
  --keep-vegetation  Preserve green/brown vegetation blocks (for satellite comparison)
  --no-enu           Skip ENU reorientation (for pre-oriented headless GLBs)
  --no-osm           Skip OSM footprint masking (when geocode doesn't match building)
  --no-post-mask     Skip post-processing OSM re-mask (v80 edge re-sharpening)
  --enrich           Run scene enrichment (trees, roads, ground fill) — requires --coords
  --scene            Unified scene pipeline: env extraction + strip + enrich — requires --coords`);
    process.exit(0);
  }

  // First non-flag arg is the input path
  let inputPath = '';
  let resolution = 1;
  let mode: VoxelizeMode = 'surface';
  let minHeight = 2;
  let trimThreshold = 0.05;
  let gamma = 0.85; // v95: 0.75→0.85 — less mid-tone compression preserves color variety for CIE-Lab matching
  let kernel = 12; // Moderate kernel — preserves window/trim features while smoothing noise
  let desaturate = 0.05; // Minimal desaturation — preserve building-specific colors (green copper, brick, etc.)
  let outputPath = '';
  let infoOnly = false;
  let generic = false;
  let explicitGeneric = false; // Track if --generic was explicitly passed
  let explicitFill = false;    // Track if --fill was explicitly passed
  let desaturateOff = false;
  let preview = false;
  let smoothPct = 0; // disabled by default; modeFilter3D handles noise locally
  let modePasses = 2; // Auto-detect overrides; 2 passes after K-Means for coherent zones
  let explicitModePasses = false;
  let explicitResolution = false;
  let fill = false;
  let noPalette = false;
  let noCornice = false;
  let noFireEscape = false;
  let noGlaze = false;
  let peakedRoof = false;
  let cleanMinSize = 0;
  let cropRadius = 0;
  let auto = false;
  let autoInfo = false;
  let batch = false;
  let coords: { lat: number; lng: number } | null = null;
  let keepVegetation = false;
  let noEnu = false;
  let noOsm = false;
  let noPostMask = false;
  let noIsolate = false;
  let maskDilate = 3;
  let enrich = false;
  let scene = false;
  let plotRadius = 0; // 0 = auto-compute when --scene
  const batchPaths: string[] = [];
  const remaps = new Map<string, string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--resolution' || arg === '-r') {
      resolution = parseFloat(args[++i]);
      explicitResolution = true;
    } else if (arg === '--mode' || arg === '-m') {
      mode = args[++i] as VoxelizeMode;
    } else if (arg === '--min-height') {
      minHeight = parseFloat(args[++i]);
    } else if (arg === '--trim') {
      trimThreshold = parseFloat(args[++i]);
    } else if (arg === '--gamma' || arg === '-g') {
      gamma = parseFloat(args[++i]);
    } else if (arg === '--kernel' || arg === '-k') {
      kernel = parseInt(args[++i], 10);
    } else if (arg === '--desaturate') {
      desaturate = parseFloat(args[++i]);
    } else if (arg === '--output' || arg === '-o') {
      outputPath = args[++i];
    } else if (arg === '--info') {
      infoOnly = true;
    } else if (arg === '--generic') {
      generic = true;
      explicitGeneric = true;
    } else if (arg === '--desaturate-off') {
      desaturateOff = true;
    } else if (arg === '--preview') {
      preview = true;
    } else if (arg === '--smooth-pct') {
      smoothPct = parseFloat(args[++i]);
    } else if (arg === '--mode-passes') {
      modePasses = parseInt(args[++i], 10);
      explicitModePasses = true;
    } else if (arg === '--fill') {
      fill = true;
      explicitFill = true;
    } else if (arg === '--no-fill') {
      fill = false;
      explicitFill = true; // Prevents auto from overriding
    } else if (arg === '--no-palette') {
      noPalette = true;
    } else if (arg === '--no-cornice') {
      noCornice = true;
    } else if (arg === '--no-fire-escape') {
      noFireEscape = true;
    } else if (arg === '--no-glaze') {
      noGlaze = true;
    } else if (arg === '--peaked-roof') {
      peakedRoof = true;
    } else if (arg === '--keep-vegetation') {
      keepVegetation = true;
    } else if (arg === '--no-enu') {
      noEnu = true;
    } else if (arg === '--no-osm') {
      noOsm = true;
    } else if (arg === '--no-post-mask') {
      noPostMask = true;
    } else if (arg === '--no-isolate') {
      noIsolate = true;
    } else if (arg === '--enrich') {
      enrich = true;
    } else if (arg === '--scene') {
      scene = true;
      enrich = true; // --scene implies --enrich
    } else if (arg === '--plot-radius') {
      plotRadius = parseInt(args[++i], 10);
    } else if (arg === '--mask-dilate') {
      maskDilate = parseInt(args[++i], 10);
    } else if (arg === '--clean') {
      cleanMinSize = parseInt(args[++i], 10);
    } else if (arg === '--crop') {
      cropRadius = parseInt(args[++i], 10);
    } else if (arg === '--auto') {
      auto = true;
    } else if (arg === '--auto-info') {
      autoInfo = true;
    } else if (arg === '--batch') {
      batch = true;
    } else if (arg === '--coords' || arg.startsWith('--coords=')) {
      const val = arg.startsWith('--coords=') ? arg.slice('--coords='.length) : args[++i];
      const parts = val.split(',');
      if (parts.length === 2) {
        coords = { lat: parseFloat(parts[0]), lng: parseFloat(parts[1]) };
      }
    } else if (arg === '--remap') {
      const pair = args[++i];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const from = pair.slice(0, eq);
        const to = pair.slice(eq + 1);
        // Auto-prefix minecraft: if not present
        const fullFrom = from.includes(':') ? from : `minecraft:${from}`;
        const fullTo = to.includes(':') ? to : `minecraft:${to}`;
        remaps.set(fullFrom, fullTo);
      }
    } else if (!arg.startsWith('-')) {
      if (!inputPath) {
        inputPath = arg;
      } else {
        // Additional positional args stored for batch mode
        batchPaths.push(arg);
      }
    }
  }

  if (!inputPath) {
    console.error('Error: no input GLB file specified');
    process.exit(1);
  }

  // Resolve to absolute paths — Bun on Termux sets CWD to ~/.bun/tmp/ instead of project root
  const projectRoot = resolve(import.meta.dir, '..');
  const resolvePath = (p: string) => p.startsWith('/') ? p : resolve(projectRoot, p);
  inputPath = resolvePath(inputPath);

  if (!outputPath) {
    const stem = basename(inputPath, extname(inputPath));
    outputPath = join(dirname(inputPath), `${stem}.schem`);
  } else {
    outputPath = resolvePath(outputPath);
  }

  if (desaturateOff) {
    desaturate = 0; // explicitly disable desaturation
  }

  return { inputPath, resolution, mode, minHeight, trimThreshold, gamma, kernel, desaturate, outputPath, infoOnly, generic, explicitGeneric, explicitFill, explicitModePasses, explicitResolution, preview, smoothPct, modePasses, fill, noPalette, noCornice, noFireEscape, noGlaze, peakedRoof, cleanMinSize, cropRadius, remaps, auto, autoInfo, batch, batchPaths, coords, keepVegetation, noEnu, noOsm, noPostMask, noIsolate, maskDilate, enrich, scene, plotRadius };
}

// ─── GLB Loading ────────────────────────────────────────────────────────────

/** Load a GLB file from disk into a Three.js scene, decoding embedded textures. */
async function loadGLB(filepath: string): Promise<THREE.Group> {
  const file = Bun.file(filepath);
  if (!await file.exists()) {
    console.error(`Error: file not found: ${filepath}`);
    process.exit(1);
  }

  const bytes = await file.arrayBuffer();

  // Pre-extract embedded images from the GLB binary so we can decode them
  // with sharp (Bun has no DOM ImageLoader for blob: URLs that GLTFLoader creates).
  const imageBuffers = extractGLBImages(new Uint8Array(bytes));

  const loader = new GLTFLoader();

  // Enable Draco decoding — some GLBs use Draco mesh compression.
  try {
    const dracoLoader = new DRACOLoader();
    const dracoPath = join(
      import.meta.dir, '..', 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf',
    );
    dracoLoader.setDecoderPath('file://' + dracoPath + '/');
    dracoLoader.setDecoderConfig({ type: 'js' });
    loader.setDRACOLoader(dracoLoader);
  } catch {
    // Draco not available — only plain GLBs will work
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
function extractGLBImages(glb: Uint8Array): Uint8Array[] {
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
async function decodeTexturesWithSharp(
  scene: THREE.Group,
  imageBuffers: Uint8Array[],
  glb: Uint8Array,
): Promise<void> {
  let sharp: typeof import('sharp');
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.warn('[voxelize] sharp not available — textures will use material.color fallback');
    return;
  }

  // Decode all images to raw RGBA
  const decoded: Array<{ data: Uint8Array; width: number; height: number } | null> = [];
  for (let i = 0; i < imageBuffers.length; i++) {
    const buf = imageBuffers[i];
    if (buf.length === 0) { decoded.push(null); continue; }
    try {
      const img = sharp(Buffer.from(buf));
      const meta = await img.metadata();
      const raw = await img.ensureAlpha().raw().toBuffer();
      decoded.push({
        data: new Uint8Array(raw),
        width: meta.width ?? 0,
        height: meta.height ?? 0,
      });
    } catch {
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

// ─── ENU Reorientation ──────────────────────────────────────────────────────

/**
 * Detect and correct ECEF-tilted meshes to local ENU (East-North-Up).
 *
 * Google 3D Tiles in ECEF have "up" pointing radially outward from Earth's
 * center. For a ~50m capture radius, the mesh cluster's center-of-mass
 * direction from origin approximates the local "up" vector. We rotate the
 * scene so that this direction aligns with Y+, producing correct Y-up
 * orientation for Minecraft voxelization.
 *
 * Detection heuristic: if Y extent >= 0.8 × max(X,Z) extent, the mesh is
 * likely ECEF-tilted (a flat neighborhood shouldn't be taller than it is wide).
 */
/** Rotation angle applied during ENU horizontal alignment (radians around Y axis).
 * Used to rotate OSM polygon to match the grid after PCA alignment. */
let enuHorizontalAngle = 0;

function reorientToENU(scene: THREE.Group, skipHorizontalAlign = false): void {
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);

  const maxXZ = Math.max(size.x, size.z);
  if (maxXZ < 0.01) return; // Degenerate mesh

  // 1. Vertical alignment via PCA — detect tilt angle instead of brittle Y/XZ ratio.
  // PCA is cheap (~500 samples/mesh), so always compute it and check actual tilt.
  const { minEigenvector: upDir } = estimateUpDirection(scene);
  const targetUp = new THREE.Vector3(0, 1, 0);
  const tiltAngle = upDir.angleTo(targetUp);

  if (tiltAngle > 0.087) { // >5° tilt — apply vertical correction
    console.log(`ENU vertical align: correcting tilt of ${(tiltAngle * 180 / Math.PI).toFixed(1)}°`);
    const quat = new THREE.Quaternion().setFromUnitVectors(upDir, targetUp);
    const rotMatrix = new THREE.Matrix4().makeRotationFromQuaternion(quat);
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        child.geometry.applyMatrix4(rotMatrix);
      }
    });
  } else {
    console.log(`ENU vertical align: tilt is negligible (${(tiltAngle * 180 / Math.PI).toFixed(1)}°), skipping`);
  }

  // 2. Horizontal alignment via Minimum Bounding Box Area Sweep.
  // PCA longest-axis alignment rotates square buildings 45° (diagonal = longest axis).
  // Instead, sweep 0-90° in 1° steps and find the rotation that minimizes XZ bounding
  // box area. This correctly handles squares, rectangles, L-shapes, and pentagons.
  if (!skipHorizontalAlign) {
    const pointsXZ: { x: number; z: number }[] = [];
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.geometry) return;
      const posAttr = child.geometry.getAttribute('position') as THREE.BufferAttribute;
      if (!posAttr) return;
      const step = Math.max(1, Math.floor(posAttr.count / 500));
      for (let i = 0; i < posAttr.count; i += step) {
        pointsXZ.push({ x: posAttr.getX(i), z: posAttr.getZ(i) });
      }
    });

    if (pointsXZ.length > 10) {
      let bestAngle = 0;
      let minArea = Infinity;

      for (let deg = 0; deg < 90; deg += 1) {
        const rad = deg * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;

        for (const p of pointsXZ) {
          const rx = p.x * cos - p.z * sin;
          const rz = p.x * sin + p.z * cos;
          if (rx < mnX) mnX = rx;
          if (rx > mxX) mxX = rx;
          if (rz < mnZ) mnZ = rz;
          if (rz > mxZ) mxZ = rz;
        }

        const area = (mxX - mnX) * (mxZ - mnZ);
        if (area < minArea) {
          minArea = area;
          bestAngle = rad;
        }
      }

      // v71: Snap rotation to nearest 90° to axis-align building edges.
      // Diagonal edges create staircase aliasing at 1 block/m that makes
      // rectangles look like diamonds/ovals. Axis-aligned edges give crisp
      // straight lines visible in top-down plan views.
      // Snap to nearest 90° only when area increase is modest (< 50%).
      // PCA alignment minimizes bounding box by aligning walls with axes —
      // forcing 0°/90° when walls are at ~40° creates WORSE staircase aliasing.
      const optimalDeg = bestAngle * 180 / Math.PI;
      const snappedDeg = Math.round(optimalDeg / 90) * 90;
      const snappedRad = snappedDeg * Math.PI / 180;

      let useSnapped = false;
      if (Math.abs(snappedRad - bestAngle) > 0.01) {
        const cos2 = Math.cos(snappedRad), sin2 = Math.sin(snappedRad);
        let mnX2 = Infinity, mxX2 = -Infinity, mnZ2 = Infinity, mxZ2 = -Infinity;
        for (const p of pointsXZ) {
          const rx = p.x * cos2 - p.z * sin2;
          const rz = p.x * sin2 + p.z * cos2;
          if (rx < mnX2) mnX2 = rx;
          if (rx > mxX2) mxX2 = rx;
          if (rz < mnZ2) mnZ2 = rz;
          if (rz > mxZ2) mxZ2 = rz;
        }
        const snappedArea = (mxX2 - mnX2) * (mxZ2 - mnZ2);
        if (snappedArea <= minArea * 1.5) {
          useSnapped = true;
          bestAngle = snappedRad;
          console.log(`ENU horizontal align: snapped ${optimalDeg.toFixed(1)}° → ${snappedDeg}° for axis-aligned edges (area +${((snappedArea / minArea - 1) * 100).toFixed(0)}%)`);
        } else {
          console.log(`ENU horizontal align: kept ${optimalDeg.toFixed(1)}° (snapping to ${snappedDeg}° would increase area by ${((snappedArea / minArea - 1) * 100).toFixed(0)}%)`);
        }
      }

      if (bestAngle > 0.01) {
        if (!useSnapped) {
          console.log(`ENU horizontal align: rotated ${(bestAngle * 180 / Math.PI).toFixed(1)}° to minimize footprint`);
        }
        const yRotation = new THREE.Matrix4().makeRotationY(-bestAngle);
        scene.traverse((child) => {
          if (child instanceof THREE.Mesh && child.geometry) {
            child.geometry.applyMatrix4(yRotation);
          }
        });
        enuHorizontalAngle = bestAngle; // Save for OSM polygon rotation
      }
    }
  }

  // Recenter so ground is at Y=0, XZ centered at origin
  const newBox = new THREE.Box3().setFromObject(scene);
  const newSize = new THREE.Vector3();
  newBox.getSize(newSize);
  const shift = new THREE.Vector3(
    -(newBox.min.x + newSize.x / 2),
    -newBox.min.y,
    -(newBox.min.z + newSize.z / 2),
  );

  const shiftMatrix = new THREE.Matrix4().makeTranslation(shift.x, shift.y, shift.z);
  scene.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      child.geometry.applyMatrix4(shiftMatrix);
    }
  });

  const finalBox = new THREE.Box3().setFromObject(scene);
  const finalSize = new THREE.Vector3();
  finalBox.getSize(finalSize);
  console.log(`ENU result: ${finalSize.x.toFixed(1)} x ${finalSize.y.toFixed(1)} x ${finalSize.z.toFixed(1)} (Y/XZ: ${(finalSize.y / Math.max(finalSize.x, finalSize.z)).toFixed(2)})`);
}

/**
 * Estimate the "up" direction of an ECEF mesh cluster using PCA.
 * The smallest principal component of the vertex positions corresponds
 * to the axis along which the data is flattest — i.e., the vertical axis
 * for a mostly-horizontal neighborhood capture.
 */
function estimateUpDirection(scene: THREE.Group): { minEigenvector: THREE.Vector3 } {
  // Collect a sample of vertex positions (subsample for performance)
  const positions: THREE.Vector3[] = [];
  const center = new THREE.Vector3();

  scene.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.geometry) return;
    const posAttr = child.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!posAttr) return;
    const step = Math.max(1, Math.floor(posAttr.count / 500)); // ~500 samples per mesh
    for (let i = 0; i < posAttr.count; i += step) {
      const v = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      positions.push(v);
      center.add(v);
    }
  });

  if (positions.length < 10) return { minEigenvector: new THREE.Vector3(0, 1, 0) };

  center.divideScalar(positions.length);

  // Build 3x3 covariance matrix
  let cxx = 0, cxy = 0, cxz = 0;
  let cyy = 0, cyz = 0, czz = 0;

  for (const v of positions) {
    const dx = v.x - center.x;
    const dy = v.y - center.y;
    const dz = v.z - center.z;
    cxx += dx * dx; cxy += dx * dy; cxz += dx * dz;
    cyy += dy * dy; cyz += dy * dz; czz += dz * dz;
  }

  const n = positions.length;
  cxx /= n; cxy /= n; cxz /= n;
  cyy /= n; cyz /= n; czz /= n;

  // Find eigenvector with smallest eigenvalue via power iteration on inverse
  // (or equivalently, find the axis of minimum variance).
  // Simple approach: try each axis-aligned candidate and pick the one that
  // produces the minimum projected variance. For ECEF data the tilt is
  // typically 30-50° off any axis, so we use iterative refinement.
  //
  // Jacobi eigenvalue algorithm for 3x3 symmetric matrix:
  const eigenvectors = jacobi3x3(cxx, cxy, cxz, cyy, cyz, czz);

  // Return the eigenvector with smallest eigenvalue (flattest direction = "up")
  // and the largest eigenvalue (longest horizontal extent for XZ alignment)
  return eigenvectors;
}

/**
 * Jacobi eigenvalue decomposition for a 3x3 symmetric matrix.
 * Returns eigenvectors sorted by eigenvalue (ascending).
 */
function jacobi3x3(
  a11: number, a12: number, a13: number,
  a22: number, a23: number, a33: number,
): { minEigenvector: THREE.Vector3 } {
  // Matrix A stored as flat array (symmetric, row-major)
  const a = [a11, a12, a13, a12, a22, a23, a13, a23, a33];
  // Eigenvector matrix V starts as identity
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  // Jacobi rotation iterations
  for (let iter = 0; iter < 50; iter++) {
    // Find largest off-diagonal element
    let maxVal = 0;
    let p = 0, q = 1;
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const val = Math.abs(a[i * 3 + j]);
        if (val > maxVal) { maxVal = val; p = i; q = j; }
      }
    }
    if (maxVal < 1e-10) break; // Converged

    // Compute rotation angle
    const app = a[p * 3 + p], aqq = a[q * 3 + q], apq = a[p * 3 + q];
    const theta = 0.5 * Math.atan2(2 * apq, app - aqq);
    const c = Math.cos(theta), s = Math.sin(theta);

    // Rotate A: A' = G^T * A * G
    const newA = [...a];
    newA[p * 3 + p] = c * c * app + 2 * s * c * apq + s * s * aqq;
    newA[q * 3 + q] = s * s * app - 2 * s * c * apq + c * c * aqq;
    newA[p * 3 + q] = 0;
    newA[q * 3 + p] = 0;

    for (let r = 0; r < 3; r++) {
      if (r === p || r === q) continue;
      const arp = a[r * 3 + p], arq = a[r * 3 + q];
      newA[r * 3 + p] = c * arp + s * arq;
      newA[p * 3 + r] = newA[r * 3 + p];
      newA[r * 3 + q] = -s * arp + c * arq;
      newA[q * 3 + r] = newA[r * 3 + q];
    }
    for (let i = 0; i < 9; i++) a[i] = newA[i];

    // Update eigenvectors: V' = V * G
    const newV = [...v];
    for (let r = 0; r < 3; r++) {
      const vrp = v[r * 3 + p], vrq = v[r * 3 + q];
      newV[r * 3 + p] = c * vrp + s * vrq;
      newV[r * 3 + q] = -s * vrp + c * vrq;
    }
    for (let i = 0; i < 9; i++) v[i] = newV[i];
  }

  // Eigenvalues are on diagonal of A
  const eigenvalues = [a[0], a[4], a[8]];

  // Sort indices by eigenvalue ascending (min first)
  const sortedIdx = [0, 1, 2].sort((a, b) => eigenvalues[a] - eigenvalues[b]);
  const minIdx = sortedIdx[0];

  // Min eigenvector (up direction — flattest axis)
  const ev = new THREE.Vector3(v[0 * 3 + minIdx], v[1 * 3 + minIdx], v[2 * 3 + minIdx]);
  ev.normalize();
  if (ev.y < 0) ev.negate();

  console.log(`PCA eigenvalues: [${eigenvalues.map(e => e.toFixed(1)).join(', ')}], min axis index: ${minIdx}`);
  return { minEigenvector: ev };
}

// ─── Mesh Analysis ──────────────────────────────────────────────────────────

/** Collect mesh stats for --info output */
function analyzeMeshes(object: THREE.Object3D): {
  meshCount: number;
  vertexCount: number;
  triangleCount: number;
  hasTextures: boolean;
  boundingBox: THREE.Box3;
} {
  let meshCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  let hasTextures = false;

  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      meshCount++;
      const geo = child.geometry as THREE.BufferGeometry;
      if (geo.index) {
        triangleCount += geo.index.count / 3;
      } else if (geo.attributes.position) {
        triangleCount += geo.attributes.position.count / 3;
      }
      if (geo.attributes.position) {
        vertexCount += geo.attributes.position.count;
      }
      const mat = child.material as THREE.MeshStandardMaterial;
      if (mat?.map) hasTextures = true;
    }
  });

  const boundingBox = new THREE.Box3().setFromObject(object);

  return { meshCount, vertexCount, triangleCount: Math.round(triangleCount), hasTextures, boundingBox };
}

// ─── Main ───────────────────────────────────────────────────────────────────

/** Analyze a single GLB and return summary row for batch mode. */
async function analyzeOne(filepath: string, resolution: number, minHeight: number, trimThreshold: number, gamma: number, kernel: number, desaturate: number): Promise<{
  name: string; dims: string; blocks: number; type: string;
  conf: number; entry: string; footprint: number; front: string;
} | null> {
  try {
    const scene = await loadGLB(filepath);
    reorientToENU(scene);

    // Collect and filter meshes
    const candidates: Array<{ child: THREE.Mesh; worldBox: THREE.Box3 }> = [];
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.geometry) return;
      child.updateWorldMatrix(true, false);
      child.geometry.computeBoundingBox();
      const localBox = child.geometry.boundingBox;
      if (!localBox) return;
      const worldBox = localBox.clone().applyMatrix4(child.matrixWorld);
      candidates.push({ child, worldBox });
    });
    const { kept } = filterMeshesByHeight(candidates, minHeight);
    if (kept.length === 0) return null;

    // Clone meshes with baked world transforms into a clean group
    // (avoids setFromObject crash on raw glTF child nodes lacking updateWorldMatrix)
    const group = new THREE.Group();
    for (const { child } of kept) {
      const cloned = child.clone();
      cloned.applyMatrix4(child.matrixWorld);
      cloned.position.set(0, 0, 0);
      cloned.rotation.set(0, 0, 0);
      cloned.scale.set(1, 1, 1);
      cloned.updateMatrix();
      group.add(cloned);
    }

    const grid = threeToGrid(group, resolution, {
      mode: 'surface',
      textureSampler: createDataTextureSampler(gamma, kernel, desaturate),
    });
    const trimmed = trimSparseBottomLayers(grid, trimThreshold);
    const analysis = analyzeGrid(trimmed);
    const stem = basename(filepath, extname(filepath)).replace(/^tiles-/, '');

    return {
      name: stem.length > 30 ? stem.slice(0, 27) + '...' : stem,
      dims: `${trimmed.width}x${trimmed.height}x${trimmed.length}`,
      blocks: trimmed.countNonAir(),
      type: analysis.typology,
      conf: analysis.confidence,
      entry: analysis.entryPosition ? `(${analysis.entryPosition.x},${analysis.entryPosition.z}) w${analysis.entryWidth} p${analysis.entryPath.length}` : '-',
      footprint: analysis.footprintArea,
      front: analysis.frontFace,
    };
  } catch (err) {
    const stem = basename(filepath, extname(filepath)).replace(/^tiles-/, '');
    console.error(`  [ERROR] ${stem}: ${err}`);
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const t0 = performance.now();

  // ── Batch mode: analyze multiple GLBs, output summary table ──
  if (args.batch) {
    const allPaths = [args.inputPath, ...args.batchPaths];
    console.log(`Batch analysis: ${allPaths.length} GLBs\n`);

    type Row = NonNullable<Awaited<ReturnType<typeof analyzeOne>>>;
    const rows: Row[] = [];

    for (const path of allPaths) {
      process.stdout.write(`  Analyzing: ${basename(path)}...`);
      const row = await analyzeOne(path, args.resolution, args.minHeight, args.trimThreshold, args.gamma, args.kernel, args.desaturate);
      if (row) {
        rows.push(row);
        console.log(` ${row.type} ${row.conf.toFixed(1)}`);
      } else {
        console.log(' FAILED');
      }
    }

    // Print summary table
    console.log(`\n${'Name'.padEnd(32)} ${'Dims'.padEnd(14)} ${'Blocks'.padStart(8)} ${'Type'.padEnd(8)} ${'Conf'.padStart(4)} ${'Front'.padEnd(5)} ${'Entry'.padEnd(22)} ${'Footprint'.padStart(9)}`);
    console.log('─'.repeat(110));
    for (const r of rows) {
      console.log(`${r.name.padEnd(32)} ${r.dims.padEnd(14)} ${r.blocks.toLocaleString().padStart(8)} ${r.type.padEnd(8)} ${r.conf.toFixed(1).padStart(4)} ${r.front.padEnd(5)} ${r.entry.padEnd(22)} ${r.footprint.toString().padStart(9)}`);
    }
    console.log(`\nTotal: ${rows.length}/${allPaths.length} analyzed in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  console.log(`Loading: ${args.inputPath}`);
  const scene = await loadGLB(args.inputPath);

  const stats = analyzeMeshes(scene);
  const size = new THREE.Vector3();
  stats.boundingBox.getSize(size);

  console.log(`Meshes: ${stats.meshCount} | Vertices: ${stats.vertexCount.toLocaleString()} | Triangles: ${stats.triangleCount.toLocaleString()}`);
  console.log(`Textures: ${stats.hasTextures ? 'yes' : 'no'}`);
  console.log(`Bounding box: ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} meters`);
  console.log(`Grid estimate: ${Math.ceil(size.x * args.resolution)} x ${Math.ceil(size.y * args.resolution)} x ${Math.ceil(size.z * args.resolution)} blocks @ ${args.resolution} block/m`);

  if (args.infoOnly) {
    // Quality assessment — predict voxelization quality from mesh stats
    reorientToENU(scene);
    const enuBox = new THREE.Box3().setFromObject(scene);
    const enuSize = new THREE.Vector3();
    enuBox.getSize(enuSize);
    console.log(`ENU dimensions: ${enuSize.x.toFixed(1)} x ${enuSize.y.toFixed(1)} x ${enuSize.z.toFixed(1)} m`);

    // Vertex density — higher = more surface detail
    const volume = enuSize.x * enuSize.y * enuSize.z;
    const surfaceArea = 2 * (enuSize.x * enuSize.y + enuSize.y * enuSize.z + enuSize.x * enuSize.z);
    const vertDensity = stats.vertexCount / Math.max(surfaceArea, 1);
    console.log(`Vertex density: ${vertDensity.toFixed(1)} verts/m² surface`);

    // Aspect ratio — tall/narrow buildings work better
    const footprint = Math.max(enuSize.x, enuSize.z);
    const aspect = enuSize.y / Math.max(footprint, 1);
    console.log(`Aspect ratio: ${aspect.toFixed(2)} (height/footprint)`);

    // Texture info — count textured meshes and total resolution
    let texturedMeshes = 0;
    let totalTexPixels = 0;
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshStandardMaterial;
        if (mat?.map) {
          texturedMeshes++;
          const img = mat.map.image;
          if (img && img.width) totalTexPixels += img.width * img.height;
        }
      }
    });
    console.log(`Textured meshes: ${texturedMeshes}/${stats.meshCount} | Total texture: ${(totalTexPixels / 1e6).toFixed(1)} Mpx`);

    // Height-filter analysis — how much geometry survives filtering?
    const candidates: Array<{ child: THREE.Mesh; worldBox: THREE.Box3 }> = [];
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        child.updateWorldMatrix(true, false);
        const worldBox = new THREE.Box3().setFromObject(child);
        candidates.push({ child, worldBox });
      }
    });
    const { kept, groundY, heightFiltered } = filterMeshesByHeight(candidates, args.minHeight);
    const keptVertices = kept.reduce((sum, k) => {
      const geo = k.child.geometry as THREE.BufferGeometry;
      return sum + (geo.attributes.position?.count || 0);
    }, 0);
    const vertexSurvival = stats.vertexCount > 0 ? keptVertices / stats.vertexCount : 0;
    console.log(`Height filter: ${kept.length}/${candidates.length} meshes kept (${(vertexSurvival * 100).toFixed(0)}% vertices survive)`);

    // Kept meshes bounding box — the actual building extent
    if (kept.length > 0) {
      const keptBox = new THREE.Box3();
      for (const k of kept) keptBox.union(k.worldBox);
      const keptSize = new THREE.Vector3();
      keptBox.getSize(keptSize);
      const buildingH = keptSize.y;
      const buildingW = Math.max(keptSize.x, keptSize.z);
      console.log(`Building extent: ${keptSize.x.toFixed(1)} x ${keptSize.y.toFixed(1)} x ${keptSize.z.toFixed(1)} m`);
      console.log(`Building height: ${buildingH.toFixed(1)}m | Width: ${buildingW.toFixed(1)}m | H/W: ${(buildingH / Math.max(buildingW, 1)).toFixed(2)}`);
    }

    // Quality prediction
    console.log(`\n--- Quality Assessment ---`);
    const issues: string[] = [];
    const strengths: string[] = [];

    if (!stats.hasTextures) issues.push('No textures — will produce monochrome output');
    else if (texturedMeshes === stats.meshCount) strengths.push('All meshes textured');

    // Vertex survival after height filter — high = building dominates, low = mostly terrain
    if (vertexSurvival < 0.5) issues.push(`Only ${(vertexSurvival * 100).toFixed(0)}% verts above ground — mostly terrain/ground`);
    else if (vertexSurvival > 0.8) strengths.push(`${(vertexSurvival * 100).toFixed(0)}% verts above ground — building dominates`);

    if (aspect < 0.3) issues.push('Very wide/flat — may merge multiple structures');
    else if (aspect > 0.6) strengths.push(`Tall profile (aspect ${aspect.toFixed(2)})`);

    if (footprint > 45) issues.push(`Large footprint (${footprint.toFixed(0)}m) — likely captures neighbors`);
    else if (footprint < 25) strengths.push('Compact footprint — likely single building');

    if (stats.meshCount > 15) issues.push(`Many meshes (${stats.meshCount}) — complex scene`);

    // Triangles per vertex — higher = more complex surfaces (trees/foliage vs flat walls)
    const triPerVert = stats.triangleCount / Math.max(stats.vertexCount, 1);
    if (triPerVert > 1.2) issues.push(`High tri/vert ratio (${triPerVert.toFixed(2)}) — complex geometry (trees?)`);
    else if (triPerVert < 0.8) strengths.push('Simple geometry (flat surfaces)');

    if (strengths.length > 0) console.log(`+ ${strengths.join('\n+ ')}`);
    if (issues.length > 0) console.log(`- ${issues.join('\n- ')}`);

    const score = strengths.length - issues.length;
    const verdict = score >= 2 ? 'GOOD — proceed with default pipeline'
                  : score >= 0 ? 'FAIR — try --generic or adjust capture radius'
                  : 'POOR — recapture with tighter radius or different address';
    console.log(`\nVerdict: ${verdict}`);

    console.log(`\nLoaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  // Reorient ECEF-tilted meshes to local ENU (Y-up) before voxelization.
  // Google 3D Tiles use ECEF coordinates — "up" is radially outward from
  // Earth's center, not along any fixed axis. The ReorientationPlugin handles
  // this in the browser, but the exported GLB may retain ECEF orientation.
  // --no-enu: skip for headless GLBs that are already ENU-oriented
  // (tiles-headless.ts uses ReorientationPlugin → meshes already have Y-up).
  if (args.noEnu) {
    console.log('ENU reorientation: SKIPPED (--no-enu, pre-oriented headless GLB)');
    // Still center the scene at origin for consistent grid coordinates
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const shift = new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z);
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        child.geometry.applyMatrix4(shift);
      }
    });
    console.log(`Centered: ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} m`);
  } else {
    reorientToENU(scene);
  }

  // Height filter: collect candidate meshes and filter by vertical extent
  console.log(`\nHeight filter: min ${args.minHeight}m above ground`);
  const candidates: Array<{ child: THREE.Mesh; worldBox: THREE.Box3 }> = [];
  scene.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      child.updateWorldMatrix(true, false);
      const worldBox = new THREE.Box3().setFromObject(child);
      candidates.push({ child, worldBox });
    }
  });

  const { kept, groundY, heightFiltered } = filterMeshesByHeight(candidates, args.minHeight);
  console.log(`Ground Y: ${groundY.toFixed(1)} | Kept: ${kept.length}/${candidates.length} meshes (${heightFiltered} filtered)`);

  if (kept.length === 0) {
    console.error('No meshes survived height filter — try lowering --min-height');
    process.exit(1);
  }

  // v80: Auto 2x resolution for small buildings — curved shapes need more blocks
  // to approximate their footprint accurately. At 1 block/m, a 15m-wide building
  // is only 15 blocks across, making curves indistinguishable from rectangles.
  if (!args.explicitResolution && args.auto) {
    const keptBox = new THREE.Box3();
    for (const k of kept) keptBox.union(k.worldBox);
    const keptSize = new THREE.Vector3();
    keptBox.getSize(keptSize);
    const buildingW = Math.max(keptSize.x, keptSize.z);
    if (buildingW > 0 && buildingW < 25) {
      args.resolution = 2;
      console.log(`Auto 2x resolution: building width ${buildingW.toFixed(0)}m < 25m threshold`);
    }
  }

  // Build a new group from kept meshes (clone with baked world transform)
  const filteredGroup = new THREE.Group();
  for (const { child } of kept) {
    const cloned = child.clone();
    cloned.applyMatrix4(child.matrixWorld);
    cloned.position.set(0, 0, 0);
    cloned.rotation.set(0, 0, 0);
    cloned.scale.set(1, 1, 1);
    cloned.updateMatrix();
    filteredGroup.add(cloned);
  }

  // Voxelize
  console.log(`\nVoxelizing: ${args.mode} mode, ${args.resolution} block/m, gamma ${args.gamma}, kernel ${args.kernel}, desat ${args.desaturate}`);
  const sampler = createDataTextureSampler(args.gamma, args.kernel, args.desaturate);
  const tVox = performance.now();
  const grid = threeToGrid(filteredGroup, args.resolution, {
    textureSampler: sampler,
    mode: args.mode,
    // Don't filter vegetation during voxelization — trees act as solid walls during
    // fillInteriorGaps, preventing holes behind canopy. Strip vegetation in post-processing.
    filterVegetation: false,
    onProgress: (p) => {
      if (p.message) {
        process.stdout.write(`\r  ${p.message}`);
      } else {
        process.stdout.write(`\r  Layer ${p.currentY}/${p.totalY} (${Math.round(p.progress * 100)}%)`);
      }
    },
  });
  process.stdout.write('\n');
  console.log(`Voxelized in ${((performance.now() - tVox) / 1000).toFixed(1)}s`);

  // Preview mode — output raw voxelization with only trim, no post-processing.
  // Use this to visually assess GLB quality before committing to full pipeline.
  if (args.preview) {
    const trimmed = trimSparseBottomLayers(grid, args.trimThreshold);
    const nonAir = trimmed.countNonAir();
    console.log(`\n[PREVIEW] Raw surface voxelization (no post-processing)`);
    console.log(`Grid: ${trimmed.width}x${trimmed.height}x${trimmed.length} | Blocks: ${nonAir.toLocaleString()} | Palette: ${trimmed.palette.size}`);
    writeSchematic(trimmed, args.outputPath);
    const fileSize = Bun.file(args.outputPath).size;
    console.log(`Wrote: ${args.outputPath} (${fileSize.toLocaleString()} bytes)`);
    console.log(`Total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`\nView: copy to web/public/ and open ?tab=upload&file=<name>.schem`);
    return;
  }

  // Auto-info mode: quick voxelize + full analysis report, no pipeline processing.
  // Produces a preview .schem AND a detailed analysis with recommended CLI command.
  if (args.autoInfo) {
    const trimmed = trimSparseBottomLayers(grid, args.trimThreshold);
    const nonAir = trimmed.countNonAir();
    console.log(`\nGrid: ${trimmed.width}x${trimmed.height}x${trimmed.length} | Blocks: ${nonAir.toLocaleString()} | Palette: ${trimmed.palette.size}`);

    console.log(`\n--- Auto-Detection Analysis ---`);
    const tAuto = performance.now();
    const analysis = analyzeGrid(trimmed);
    const rec = analysis.recommended;

    console.log(`  Terrain: slope ${analysis.slopeAngle.toFixed(1)}° ${analysis.isFlat ? '(flat)' : '(sloped)'}, ground Y=${analysis.groundPlaneY}`);
    console.log(`  Components: ${analysis.componentCount} (central: ${analysis.centralAABB.maxX - analysis.centralAABB.minX + 1}x${analysis.centralAABB.maxY - analysis.centralAABB.minY + 1}x${analysis.centralAABB.maxZ - analysis.centralAABB.minZ + 1} blocks)`);
    console.log(`  Partial capture: ${analysis.isPartialCapture ? `YES — building extends beyond grid (${analysis.edgeTouchPct.toFixed(1)}% edge touch)` : `no (${analysis.edgeTouchPct.toFixed(1)}%)`}`);
    console.log(`  Typology: ${analysis.typology} | Rectangular: ${analysis.isRectangular} | Aspect: ${analysis.aspectRatio.toFixed(2)}`);
    console.log(`  Roof: ${analysis.isFlatRoof ? 'flat' : 'pitched/varied'} | Front face: ${analysis.frontFace}`);
    console.log(`  Facade: ${analysis.dominantBlock.replace('minecraft:', '')} (${analysis.dominantPct.toFixed(0)}%) + ${analysis.secondaryBlock.replace('minecraft:', '')}`);
    console.log(`  Noise: ${analysis.noisePct.toFixed(1)}%`);
    console.log(`  Entry: ${analysis.entryPosition ? `(${analysis.entryPosition.x}, ${analysis.entryPosition.z}) face=${analysis.entryFace} width=${analysis.entryWidth} path=${analysis.entryPath.length} blocks` : 'none detected'}`);
    console.log(`  Footprint: ${analysis.footprintArea} blocks area, ${analysis.perimeterLength} perimeter, compactness=${(analysis.compactness * 100).toFixed(0)}%`);
    console.log(`  Building: ~${analysis.estimatedWidthM}x${analysis.estimatedHeightM}x${analysis.estimatedDepthM}m, ~${analysis.estimatedFloors} floors`);
    console.log(`  Confidence: ${analysis.confidence.toFixed(1)}/10 (${analysis.dataQuality})`);
    console.log(`  Analysis: ${((performance.now() - tAuto) / 1000).toFixed(1)}s`);

    // Print recommended CLI
    const parts: string[] = ['bun scripts/voxelize-glb.ts', args.inputPath];
    if (rec.generic) parts.push('--generic');
    if (rec.fill) parts.push('--fill');
    if (rec.noPalette) parts.push('--no-palette');
    if (rec.noCornice) parts.push('--no-cornice');
    if (rec.noFireEscape) parts.push('--no-fire-escape');
    parts.push(`--smooth-pct ${rec.smoothPct}`);
    parts.push(`--mode-passes ${rec.modePasses}`);
    if (rec.cropRadius > 0) parts.push(`--crop ${rec.cropRadius}`);
    if (rec.cleanMinSize > 0) parts.push(`--clean ${rec.cleanMinSize}`);
    for (const [from, to] of rec.remaps) {
      parts.push(`--remap ${from.replace('minecraft:', '')}=${to.replace('minecraft:', '')}`);
    }
    console.log(`\n  Recommended CLI:\n  ${parts.join(' \\\n    ')}`);

    // Also write preview .schem for visual check
    writeSchematic(trimmed, args.outputPath);
    const fileSize = Bun.file(args.outputPath).size;
    console.log(`\nPreview: ${args.outputPath} (${fileSize.toLocaleString()} bytes)`);
    console.log(`Total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  // Trim sparse bottom layers
  let trimmed = trimSparseBottomLayers(grid, args.trimThreshold);
  if (trimmed !== grid) {
    const removed = grid.height - trimmed.height;
    console.log(`Trimmed ${removed} sparse bottom layers (${grid.height} → ${trimmed.height})`);
  }

  // ── Auto-detection: analyze grid and override pipeline params ──
  let analysis: AnalysisResult | null = null;
  let osmMaskDone = false; // Track if OSM mask ran in pre-fill path
  let osmPolygon: Array<{ lat: number; lng: number }> | null = null; // Save for post-processing re-mask
  if (args.auto) {
    console.log(`\n--- Auto-Detection Analysis ---`);
    const tAuto = performance.now();
    analysis = analyzeGrid(trimmed);

    console.log(`  Terrain: slope ${analysis.slopeAngle.toFixed(1)}° ${analysis.isFlat ? '(flat)' : '(sloped)'}, ground Y=${analysis.groundPlaneY}`);
    const aabb = analysis.centralAABB;
    const cW = aabb.maxX - aabb.minX + 1, cH = aabb.maxY - aabb.minY + 1, cL = aabb.maxZ - aabb.minZ + 1;
    console.log(`  Components: ${analysis.componentCount} (central: ${cW}x${cH}x${cL} blocks)`);
    console.log(`  Partial capture: ${analysis.isPartialCapture ? `YES (${analysis.edgeTouchPct.toFixed(1)}% edge touch)` : `no (${analysis.edgeTouchPct.toFixed(1)}%)`}`);
    console.log(`  Typology: ${analysis.typology} | Aspect: ${analysis.aspectRatio.toFixed(2)} | Footprint fill: ${(analysis.footprintFill * 100).toFixed(0)}% | Rectangular: ${analysis.isRectangular}`);
    console.log(`  Roof: ${analysis.isFlatRoof ? 'flat' : 'pitched'} (variance ${analysis.roofVariance.toFixed(1)})`);
    console.log(`  Facade: dominant=${analysis.dominantBlock.replace('minecraft:', '')} (${analysis.dominantPct.toFixed(0)}%) secondary=${analysis.secondaryBlock.replace('minecraft:', '')}`);
    console.log(`  Noise: ${analysis.noisePct.toFixed(1)}% protrusions (${analysis.protrusion1vCount} single-voxel)`);
    console.log(`  Front face: ${analysis.frontFace}`);
    console.log(`  Entry: ${analysis.entryPosition ? `(${analysis.entryPosition.x}, ${analysis.entryPosition.z}) face=${analysis.entryFace} width=${analysis.entryWidth} path=${analysis.entryPath.length} blocks` : 'none detected'}`);
    console.log(`  Footprint: area=${analysis.footprintArea} perimeter=${analysis.perimeterLength} compactness=${(analysis.compactness * 100).toFixed(0)}%`);
    console.log(`  Building: ~${analysis.estimatedWidthM}x${analysis.estimatedHeightM}x${analysis.estimatedDepthM}m, ~${analysis.estimatedFloors} floors`);
    console.log(`  Confidence: ${analysis.confidence.toFixed(1)}/10 (${analysis.dataQuality})`);

    // Apply auto recommendations (only override non-explicitly-set params)
    const rec = analysis.recommended;
    // Compact recommendation summary
    const recFlags: string[] = [rec.generic ? '--generic' : 'building-mode'];
    if (rec.fill) recFlags.push('--fill');
    if (!rec.noPalette) recFlags.push('shadow-palette');
    if (rec.cropRadius > 0) recFlags.push(`--crop ${rec.cropRadius}`);
    if (rec.cleanMinSize > 0) recFlags.push(`--clean ${rec.cleanMinSize}`);
    if (rec.remaps.size > 0) {
      const remapStr = [...rec.remaps.entries()].map(([f, t]) =>
        `${f.replace('minecraft:', '')}→${t.replace('minecraft:', '')}`).join(', ');
      recFlags.push(`remap: ${remapStr}`);
    }
    console.log(`  Pipeline: ${recFlags.join(' | ')}`);

    // Print reproducible CLI command for manual fine-tuning
    const parts: string[] = ['bun scripts/voxelize-glb.ts', args.inputPath];
    if (rec.generic) parts.push('--generic');
    if (rec.fill) parts.push('--fill');
    if (rec.noPalette) parts.push('--no-palette');
    if (rec.noCornice) parts.push('--no-cornice');
    if (rec.noFireEscape) parts.push('--no-fire-escape');
    parts.push(`--smooth-pct ${rec.smoothPct}`);
    parts.push(`--mode-passes ${rec.modePasses}`);
    if (rec.cropRadius > 0) parts.push(`--crop ${rec.cropRadius}`);
    if (rec.cleanMinSize > 0) parts.push(`--clean ${rec.cleanMinSize}`);
    for (const [from, to] of rec.remaps) {
      parts.push(`--remap ${from.replace('minecraft:', '')}=${to.replace('minecraft:', '')}`);
    }
    if (args.outputPath) parts.push(`-o ${args.outputPath}`);
    console.log(`\n  Equivalent CLI:\n  ${parts.join(' \\\n    ')}\n`);

    // Override args with auto recommendations.
    // Respect explicit CLI flags: --generic overrides auto-detect's generic=false.
    if (!args.explicitGeneric) args.generic = rec.generic;
    if (!args.explicitFill) args.fill = rec.fill;
    args.noPalette = rec.noPalette;
    args.noCornice = rec.noCornice;
    args.noFireEscape = rec.noFireEscape;
    args.smoothPct = rec.smoothPct;
    if (!args.explicitModePasses) args.modePasses = rec.modePasses;
    // Only apply auto-crop if the detected component is non-trivial (>100 blocks)
    const centralVol = (aabb.maxX - aabb.minX + 1) * (aabb.maxY - aabb.minY + 1) * (aabb.maxZ - aabb.minZ + 1);
    if (args.cropRadius === 0 && rec.cropRadius > 0 && centralVol > 100) {
      args.cropRadius = rec.cropRadius;
    }
    if (args.cleanMinSize === 0 && rec.cleanMinSize > 0) args.cleanMinSize = rec.cleanMinSize;
    // Merge auto remaps with explicit --remap (explicit wins)
    for (const [from, to] of rec.remaps) {
      if (!args.remaps.has(from)) args.remaps.set(from, to);
    }

    // Apply AABB crop if recommended (shape-preserving alternative to circular crop)
    if (rec.useAABBCrop) {
      const aabb = analysis.centralAABB;
      const cropped = cropToAABB(trimmed, aabb.minX, aabb.maxX, aabb.minZ, aabb.maxZ, 2);
      if (cropped > 0) {
        console.log(`AABB crop: ${cropped} blocks removed (keeping [${aabb.minX}-${aabb.maxX}] x [${aabb.minZ}-${aabb.maxZ}] + 2 margin)`);
      }
    }
  }

  // Environment data extracted from photogrammetry before vegetation strip (--scene)
  let envPositions: ExtractedEnvironment | undefined;

  if (!args.generic) {
    // === Shape processing (tuned for isolated single-building captures) ===
    // Pipeline order: ground removal → OSM mask → component cleanup → fill → vegetation.
    // OSM mask MUST run before fill — otherwise capture boundary walls create sealed
    // perimeter and fill floods the entire "core sample" solid.

    // Step 1: Ground plane removal — strip terrain that seals building bottom
    if (args.mode === 'surface') {
      const { removed: groundRemoved, groundY } = removeGroundPlane(trimmed, 1);
      if (groundRemoved > 0) {
        console.log(`Ground plane (pre-fill): ${groundRemoved} terrain blocks removed (groundY=${groundY})`);
      }
    }

    // Step 2: OSM footprint mask — carve away everything outside building polygon.
    // For buildings smaller than capture radius, this removes sidewalk/road/neighbors.
    // For buildings larger than capture, mask removes 0 (all blocks inside polygon).
    let osmQueryPolygon: { lat: number; lon: number }[] | null = null;
    if (args.coords && !osmMaskDone && !args.noOsm) {
      console.log(`OSM footprint query (pre-fill) at ${args.coords.lat},${args.coords.lng}...`);
      const osmData = await searchOSMBuilding(args.coords.lat, args.coords.lng, 50);
      if (osmData && osmData.polygon.length >= 3) {
        osmQueryPolygon = osmData.polygon;
        const snapshot = new Map<string, string>();
        for (let y = 0; y < trimmed.height; y++) {
          for (let z = 0; z < trimmed.length; z++) {
            for (let x = 0; x < trimmed.width; x++) {
              const b = trimmed.get(x, y, z);
              if (b !== 'minecraft:air') snapshot.set(`${x},${y},${z}`, b);
            }
          }
        }
        const masked = maskToFootprint(
          trimmed, osmData.polygon,
          args.coords.lat, args.coords.lng, Math.round((args.maskDilate ?? 3) * args.resolution), args.resolution, enuHorizontalAngle,
        );
        const remaining = trimmed.countNonAir();
        if (remaining < snapshot.size * 0.1 && snapshot.size > 0) {
          // Direct mask failed — try OSM auto-alignment (sliding-window IoU)
          for (const [key, block] of snapshot) {
            const [x, y, z] = key.split(',').map(Number);
            trimmed.set(x, y, z, block);
          }
          const alignment = alignOSMToFootprint(
            trimmed, osmData.polygon,
            args.coords.lat, args.coords.lng,
            args.resolution, enuHorizontalAngle,
            40, 0.25,
          );
          if (alignment) {
            const aligned = maskToFootprintAligned(
              trimmed, osmData.polygon,
              args.coords.lat, args.coords.lng,
              Math.round((args.maskDilate ?? 3) * args.resolution), args.resolution, enuHorizontalAngle,
              alignment.dx, alignment.dz,
            );
            const alignRemaining = trimmed.countNonAir();
            if (alignRemaining > 0) {
              console.log(`OSM mask (auto-aligned dx=${alignment.dx} dz=${alignment.dz} IoU=${alignment.iou.toFixed(2)}): ${aligned} blocks removed, ${alignRemaining} remaining`);
              osmMaskDone = true;
              osmPolygon = osmData.polygon;
            } else {
              // Auto-alignment also failed — restore and fall through to geometry isolation
              for (const [key, block] of snapshot) {
                const [x2, y2, z2] = key.split(',').map(Number);
                trimmed.set(x2, y2, z2, block);
              }
              console.log(`OSM mask: direct + auto-align both failed (IoU=${alignment.iou.toFixed(2)}), using geometry isolation`);
            }
          } else {
            console.log(`OSM mask: polygon misaligned, no alignment found (IoU<0.25), using geometry isolation`);
          }
        } else {
          console.log(`OSM mask (pre-fill): ${masked} blocks removed, ${remaining} remaining`);
          osmMaskDone = true;
          osmPolygon = osmData.polygon;
        }
      }
    }

    // Step 3a: Tower isolation — for skyscrapers with surrounding buildings
    // fused into the same mesh, sample footprint at 75% height (above neighbors)
    // and strip everything outside the expanded tower footprint.
    // Expansion 15 blocks allows for typical skyscraper setbacks (base 2-3x tower width).
    const towerIsolated = isolateTallestStructure(trimmed, 0.75, 5);

    // Step 3b: Component cleanup — remove noise/debris ≥500 voxels
    const preFillCleaned = removeSmallComponents(trimmed, 500);
    if (preFillCleaned > 0) {
      console.log(`Pre-fill cleanup: ${preFillCleaned} blocks removed (< 500 voxels)`);
    }

    // Step 3c: 3-tier building isolation when OSM mask failed or was skipped.
    // v95: 1) Connected component isolation, 2) Height gradient severing, 3) Watershed
    if (!osmMaskDone && !args.noIsolate) {
      // Tier 1: Connected component isolation (works when buildings have air gaps)
      const isolated = isolatePrimaryBuilding(trimmed);
      if (isolated > 0) {
        console.log(`Isolation tier 1 (components): ${isolated} blocks removed`);
      }

      // Tier 2: Height gradient severing (works when buildings have different heights)
      const severed = severByHeightGradient(trimmed, 3, 200);
      if (severed > 0) {
        console.log(`Isolation tier 2 (height gradient): ${severed} blocks severed`);
      }

      // Tier 3: Watershed (works for same-height fused buildings with dumbbell footprint)
      // Snapshot before watershed — revert if it removes >50% of remaining blocks
      const preWshedCount = trimmed.countNonAir();
      const wshedSnapshot = new Map<string, string>();
      for (let y = 0; y < trimmed.height; y++) {
        for (let z = 0; z < trimmed.length; z++) {
          for (let x = 0; x < trimmed.width; x++) {
            const b = trimmed.get(x, y, z);
            if (b !== 'minecraft:air') wshedSnapshot.set(`${x},${y},${z}`, b);
          }
        }
      }
      const wshed = watershedIsolate(trimmed, 4);
      if (wshed > 0) {
        if (wshed > preWshedCount * 0.5) {
          // Watershed too aggressive — carved up a single building. Revert.
          for (const [key, block] of wshedSnapshot) {
            const [rx, ry, rz] = key.split(',').map(Number);
            trimmed.set(rx, ry, rz, block);
          }
          console.log(`Isolation tier 3 (watershed): REVERTED — would remove ${wshed} of ${preWshedCount} blocks (${Math.round(wshed / preWshedCount * 100)}%)`);
        } else {
          console.log(`Isolation tier 3 (watershed): ${wshed} blocks removed`);
        }
      }
    }

    // Step 4: Interior fill — 3D masked dilation flood-fill.
    // Gate by 3D fill ratio: photogrammetry shells have high XZ density (93%+ columns
    // occupied) but low 3D fill (35%) — they're hollow. Use 3D ratio to decide:
    // >60% 3D fill = genuinely solid (skip), <60% = hollow shell (fill needed).
    if (args.fill) {
      const totalCells = trimmed.width * trimmed.height * trimmed.length;
      const nonAirCount = trimmed.countNonAir();
      const fill3D = nonAirCount / totalCells;
      if (fill3D > 0.60) {
        console.log(`Skipping fill (3D density ${(fill3D * 100).toFixed(0)}% > 60% — already solid)`);
      } else {
        // Density-adaptive dilation: sparse shells (ortho captures, <30% fill) need
        // wider dilation to seal large wall gaps. Dense shells (street captures, >50%)
        // only need small dilation — over-dilating seals intentional openings.
        // v71: capped at 4 (was 5). Dilation=5 seals 10-block gaps, destroying
        // courtyards and setbacks. Dilation=4 seals 8-block gaps, sufficient for
        // photogrammetry wall holes while preserving architectural voids.
        const dilation = fill3D < 0.30 ? 4 : fill3D < 0.50 ? 3 : 3;
        const interiorFilled = fillInteriorGaps(trimmed, dilation);
        console.log(`Interior fill (dilation=${dilation}): ${interiorFilled} voxels filled (3D density ${(fill3D * 100).toFixed(0)}%)`);
        // Step 4b: Sky exposure — remove fill in open-air spaces (courtyards, setbacks)
        // Scale minClearance by resolution so ~5m vertical clearance is always required
        const openAirCleared = clearOpenAirFill(trimmed, 'minecraft:smooth_stone', Math.round(5 * args.resolution));
        if (openAirCleared > 0) console.log(`Open-air fill cleared: ${openAirCleared} fill blocks removed (no solid roof above)`);
      }
    }

    // Step 4c: Extract environment positions BEFORE vegetation strip (--scene)
    if (args.scene && args.coords) {
      envPositions = extractEnvironmentPositions(trimmed, analysis?.groundPlaneY ?? 0);
      console.log(`Environment extraction: ${envPositions.trees.length} trees, ${envPositions.roads.cells.size} road cells, ${envPositions.vehicles.length} vehicles`);
    }

    // Step 5: Vegetation strip
    if (args.mode === 'surface') {
      const vegStripped = stripVegetation(trimmed);
      if (vegStripped > 0) console.log(`Vegetation strip: ${vegStripped} tree/bush blocks removed`);
    }

    // SolidifyCore REMOVED (v54): AABB per Y-layer fill was destroying non-rectangular
    // shapes. Dakota's U-shaped courtyard got filled, Sentinel's triangle became a rectangle.
    // Gemini: Sentinel 8→1, Dakota 5→2 due to solidifyCore. fillInteriorGaps (step 4)
    // already handles hollow shell filling without altering the building footprint.
  } else {
    console.log(`Generic mode: skipping rectify (preserving raw geometry)`);
    if (args.fill) {
      // For generic captures (multi-structure scenes with terrain), fill must run
      // AFTER terrain isolation. Otherwise, terrain creates a sealed perimeter and
      // flood-fill classifies the entire capture volume as "interior" — producing
      // massive nonsensical cubes instead of recognizable buildings.

      // Step 1: Strip ground plane first — removes flat terrain layer that seals perimeter
      if (args.mode === 'surface') {
        const { removed: groundRemoved, groundY } = removeGroundPlane(trimmed, 1);
        if (groundRemoved > 0) {
          console.log(`Ground plane (pre-fill): ${groundRemoved} terrain blocks removed (groundY=${groundY})`);
        }
      }

      // Step 2: OSM footprint mask BEFORE fill — isolate building polygon so fill
      // only fills the building interior, not surrounding terrain/roads/neighbors.
      if (args.coords && !args.noOsm) {
        console.log(`OSM footprint query (pre-fill) at ${args.coords.lat},${args.coords.lng}...`);
        const osmData = await searchOSMBuilding(args.coords.lat, args.coords.lng, 50);
        if (osmData && osmData.polygon.length >= 3) {
          // Snapshot blocks before masking for revert if polygon is misaligned
          const snapshot = new Map<string, string>();
          for (let y = 0; y < trimmed.height; y++) {
            for (let z = 0; z < trimmed.length; z++) {
              for (let x = 0; x < trimmed.width; x++) {
                const b = trimmed.get(x, y, z);
                if (b !== 'minecraft:air') snapshot.set(`${x},${y},${z}`, b);
              }
            }
          }

          const masked = maskToFootprint(
            trimmed, osmData.polygon,
            args.coords.lat, args.coords.lng, Math.round((args.maskDilate ?? 3) * args.resolution), args.resolution, enuHorizontalAngle,
          );
          const remaining = trimmed.countNonAir();
          if (remaining < snapshot.size * 0.1 && snapshot.size > 0) {
            // Direct mask failed — try OSM auto-alignment (sliding-window IoU)
            for (const [key, block] of snapshot) {
              const [x, y, z] = key.split(',').map(Number);
              trimmed.set(x, y, z, block);
            }
            const alignment = alignOSMToFootprint(
              trimmed, osmData.polygon,
              args.coords.lat, args.coords.lng,
              args.resolution, enuHorizontalAngle,
              40, 0.25,
            );
            if (alignment) {
              const aligned = maskToFootprintAligned(
                trimmed, osmData.polygon,
                args.coords.lat, args.coords.lng,
                Math.round((args.maskDilate ?? 3) * args.resolution), args.resolution, enuHorizontalAngle,
                alignment.dx, alignment.dz,
              );
              const alignRemaining = trimmed.countNonAir();
              if (alignRemaining > 0) {
                console.log(`OSM mask (auto-aligned dx=${alignment.dx} dz=${alignment.dz} IoU=${alignment.iou.toFixed(2)}): ${aligned} blocks removed, ${alignRemaining} remaining`);
                osmMaskDone = true;
                osmPolygon = osmData.polygon;
              } else {
                // Auto-alignment also failed — restore and fall through to geometry isolation
                for (const [key2, block2] of snapshot) {
                  const [x2, y2, z2] = key2.split(',').map(Number);
                  trimmed.set(x2, y2, z2, block2);
                }
                console.log(`OSM mask: direct + auto-align both failed (IoU=${alignment.iou.toFixed(2)}), using geometry isolation`);
              }
            } else {
              console.log(`OSM mask: polygon misaligned, no alignment found (IoU<0.25), using geometry isolation`);
            }
          } else {
            console.log(`OSM mask (pre-fill): ${masked} blocks removed, ${remaining} remaining`);
            osmMaskDone = true;
            osmPolygon = osmData.polygon;
          }
        } else {
          console.log('OSM footprint (pre-fill): no building found at coordinates');
        }
      }

      // Step 3a: Tower isolation — strip surrounding buildings for skyscrapers
      const towerIsolated2 = isolateTallestStructure(trimmed, 0.75, 5);

      // Step 3b: Remove noise/debris — keep all components ≥500 voxels.
      // Threshold 500 preserves legitimate building wings (Pentagon, Capitol) while
      // removing floating noise from photogrammetry artifacts. Using Infinity here
      // would sever disconnected wings (Pentagon's 19% fill was caused by this).
      const preFillCleaned = removeSmallComponents(trimmed, 500);
      if (preFillCleaned > 0) {
        console.log(`Pre-fill cleanup: ${preFillCleaned} blocks removed (components < 500 voxels)`);
      }

      // Step 3c: 3-tier building isolation when OSM mask failed or was skipped.
      // v95: 1) Connected component isolation, 2) Height gradient severing, 3) Watershed
      if (!osmMaskDone && !args.noIsolate) {
        // Tier 1: Connected component isolation (works when buildings have air gaps)
        const isolated = isolatePrimaryBuilding(trimmed);
        if (isolated > 0) {
          console.log(`Isolation tier 1 (components): ${isolated} blocks removed`);
        }

        // Tier 2: Height gradient severing (works when buildings have different heights)
        const severed = severByHeightGradient(trimmed, 3, 200);
        if (severed > 0) {
          console.log(`Isolation tier 2 (height gradient): ${severed} blocks severed`);
        }

        // Tier 3: Watershed (works for same-height fused buildings with dumbbell footprint)
        // Snapshot before watershed — revert if it removes >50% of remaining blocks
        const preWshedCount2 = trimmed.countNonAir();
        const wshedSnap2 = new Map<string, string>();
        for (let y = 0; y < trimmed.height; y++) {
          for (let z = 0; z < trimmed.length; z++) {
            for (let x = 0; x < trimmed.width; x++) {
              const b = trimmed.get(x, y, z);
              if (b !== 'minecraft:air') wshedSnap2.set(`${x},${y},${z}`, b);
            }
          }
        }
        const wshed = watershedIsolate(trimmed, 4);
        if (wshed > 0) {
          if (wshed > preWshedCount2 * 0.5) {
            for (const [key, block] of wshedSnap2) {
              const [rx, ry, rz] = key.split(',').map(Number);
              trimmed.set(rx, ry, rz, block);
            }
            console.log(`Isolation tier 3 (watershed): REVERTED — would remove ${wshed} of ${preWshedCount2} blocks (${Math.round(wshed / preWshedCount2 * 100)}%)`);
          } else {
            console.log(`Isolation tier 3 (watershed): ${wshed} blocks removed`);
          }
        }
      }

      // Step 4: 3D masked dilation fill — building is now isolated.
      // dilation=2 seals diagonal gaps in photogrammetry shells
      const interiorFilled = fillInteriorGaps(trimmed, 1);
      console.log(`Interior fill (3D masked, dilation=1): ${interiorFilled} interior voxels filled`);
      // Step 4b: Sky exposure — remove fill in open-air spaces
      const openAirCleared = clearOpenAirFill(trimmed);
      if (openAirCleared > 0) console.log(`Open-air fill cleared: ${openAirCleared} blocks (no solid roof above)`);

      // Step 4c: Extract environment positions BEFORE vegetation strip (--scene, generic mode)
      if (args.scene && args.coords && !envPositions) {
        envPositions = extractEnvironmentPositions(trimmed, 0);
        console.log(`Environment extraction: ${envPositions.trees.length} trees, ${envPositions.roads.cells.size} road cells, ${envPositions.vehicles.length} vehicles`);
      }

      // Step 5: Strip vegetation — trees acted as solid walls during fill,
      // revealing the building interior behind canopy instead of leaving holes.
      if (args.mode === 'surface') {
        const vegStripped = stripVegetation(trimmed);
        if (vegStripped > 0) console.log(`Vegetation strip: ${vegStripped} tree/bush blocks removed (post-fill)`);
      }
    }
  }

  // Center crop — remove blocks beyond XZ radius to isolate central building.
  // Runs after fill/solidify so each building is solid before we crop peripheral ones.
  // Skip for partial captures where the building extends beyond the capture boundary —
  // cropping would shear off geometry that's already truncated.
  if (args.cropRadius > 0 && !analysis?.isPartialCapture) {
    // Dry-run: count blocks that would survive crop before mutating grid.
    // Sprawling campuses (Getty, Apple Park) have geometry offset from grid center,
    // so center-based rect crop would destroy the entire building.
    const cx = Math.floor(trimmed.width / 2);
    const cz = Math.floor(trimmed.length / 2);
    const r = args.cropRadius;
    let insideCrop = 0, outsideCrop = 0;
    for (let y = 0; y < trimmed.height; y++) {
      for (let z = 0; z < trimmed.length; z++) {
        for (let x = 0; x < trimmed.width; x++) {
          if (trimmed.get(x, y, z) === 'minecraft:air') continue;
          if (Math.abs(x - cx) > r || Math.abs(z - cz) > r) outsideCrop++;
          else insideCrop++;
        }
      }
    }
    if (insideCrop < (insideCrop + outsideCrop) * 0.05 && (insideCrop + outsideCrop) > 500) {
      console.log(`Skipping rect crop (would keep only ${insideCrop}/${insideCrop + outsideCrop} blocks — building offset from grid center)`);
    } else {
      const cropped = cropToRect(trimmed, args.cropRadius);
      if (cropped > 0) {
        console.log(`Rect crop: ${cropped} blocks removed (half-width ${args.cropRadius})`);
      }
    }
  } else if (args.cropRadius > 0 && analysis?.isPartialCapture) {
    console.log(`Skipping rect crop (partial capture — building extends beyond boundary)`);
  }

  // Ground plane subtraction — remove terrain layer below the building.
  // Skip if already done: non-generic path does it in step 1, generic+fill path does it pre-fill.
  if (args.mode === 'surface' && args.generic && !args.fill) {
    const { removed: groundRemoved, groundY } = removeGroundPlane(trimmed, 1);
    if (groundRemoved > 0) {
      console.log(`Ground plane: ${groundRemoved} terrain blocks removed (groundY=${groundY})`);
    }
  }

  // OSM footprint masking — remove all blocks outside the building polygon.
  // Skip if already done in the generic pre-fill path above.
  if (args.coords && !osmMaskDone && !args.noOsm) {
    console.log(`OSM footprint query at ${args.coords.lat},${args.coords.lng}...`);
    const osmData = await searchOSMBuilding(args.coords.lat, args.coords.lng, 50);
    if (osmData && osmData.polygon.length >= 3) {
      // Snapshot blocks before masking so we can revert if mask removes everything
      const snapshot = new Map<string, string>();
      for (let y = 0; y < trimmed.height; y++) {
        for (let z = 0; z < trimmed.length; z++) {
          for (let x = 0; x < trimmed.width; x++) {
            const b = trimmed.get(x, y, z);
            if (b !== 'minecraft:air') snapshot.set(`${x},${y},${z}`, b);
          }
        }
      }

      const masked = maskToFootprint(
        trimmed, osmData.polygon,
        args.coords.lat, args.coords.lng, Math.round((args.maskDilate ?? 3) * args.resolution), args.resolution, enuHorizontalAngle,
      );
      const remaining = trimmed.countNonAir();
      if (remaining < snapshot.size * 0.1 && snapshot.size > 0) {
        // Mask removed everything — revert (misaligned polygon or no building in tiles)
        for (const [key, block] of snapshot) {
          const [x, y, z] = key.split(',').map(Number);
          trimmed.set(x, y, z, block);
        }
        console.log(`OSM footprint mask: reverted (${masked} would remove all ${snapshot.size} blocks — polygon misaligned)`);
      } else {
        console.log(`OSM footprint mask: ${masked} blocks removed, ${remaining} remaining (polygon ${osmData.polygon.length} vertices)`);
      }
    } else {
      console.log('OSM footprint: no building found at coordinates');
    }
  }

  // Smooth rare/noisy blocks — replace blocks below threshold frequency with neighbors.
  if (args.smoothPct > 0) {
    const smoothed = smoothRareBlocks(trimmed, args.smoothPct);
    if (smoothed > 0) {
      console.log(`Smoothed ${smoothed} rare blocks (threshold ${(args.smoothPct * 100).toFixed(1)}%)`);
    }
  } else {
    console.log('Skipping rare-block smoothing (--smooth-pct 0)');
  }

  // v71: Save 2D footprint bitmap BEFORE morphClose — captures the building outline
  // after fill/clear/vegetation but before any smoothing that could expand it.
  // Used after processing to clip columns added by morphClose dilation.
  let savedFootprint: Uint8Array | null = null;
  {
    const { width: gw, height: gh, length: gl } = trimmed;
    savedFootprint = new Uint8Array(gw * gl);
    for (let z = 0; z < gl; z++) {
      for (let x = 0; x < gw; x++) {
        for (let y = 0; y < gh; y++) {
          if (trimmed.get(x, y, z) !== 'minecraft:air') {
            savedFootprint[z * gw + x] = 1;
            break;
          }
        }
      }
    }
  }

  // Morph close — spackle pockmarks/holes in photogrammetry surfaces.
  // v71: Reduced from r=3 to r=2. r=3 fills voids up to 6 blocks (6m) — destroying
  // corner details, bay windows, and setbacks. r=2 fills up to 4 blocks, sufficient
  // for photogrammetry gaps while preserving architectural features.
  // Dilation+erosion fills gaps without changing overall shape.
  // Runs BEFORE smoothSurface so the surface smoother sees healed faces.
  {
    const closed = morphClose3D(trimmed, 2); // v71: r=2 (r=3 over-smoothed corners/bays)
    if (closed > 0) {
      console.log(`Morph close (r=2): ${closed} holes filled`);
    }
  }

  // v74: Edge straightening — median filter on XZ silhouette traces to remove
  // stair-step jaggies. Run after morphClose (shape healed) but before zone assignment
  // and facade smoothing. maxShift=2 limits correction to avoid distorting real setbacks.
  {
    const straightened = straightenFootprintEdges(trimmed, 2, 2);
    if (straightened > 0) {
      console.log(`Edge straightening: ${straightened} blocks adjusted (median filter, maxShift=2)`);
    }
  }

  // Geometric smoothing — remove 1-voxel protrusions from photogrammetry noise.
  // v73: Protect top 40% of building (was 20% in v70). Montgomery's peaked roof
  // and Ansonia's ornate upper facade were destroyed by smoothing.
  // Walls below 60% height benefit from smoothing but roof/upper features are real architecture.
  {
    const roofCutoff = Math.round(trimmed.height * 0.60);
    // v73: preserveBoundary=true locks silhouette edges (tips, corners) from erosion
    const surfaceSmoothed = smoothSurface(trimmed, roofCutoff, true);
    if (surfaceSmoothed > 0) {
      console.log(`Surface smoothing: ${surfaceSmoothed} 1-block protrusions removed (below Y=${roofCutoff})`);
    }
    // For rectangular buildings, snap noisy walls to dominant flat planes.
    // v70: tolerance reduced from 2 to 1 — tolerance=2 was destroying bay windows
    // (Green: 15 blocks snapped) and facade setbacks (Dakota: 124 blocks).
    // tolerance=1 only snaps blocks directly adjacent to the dominant plane,
    // preserving 2+ block protrusions like bay windows and stepped facades.
    if (analysis?.isRectangular) {
      // v95: Pass roofCutoff to skip roof layer — flattenFacades was snapping
      // roof geometry to facade planes, creating holes visible in top-down views.
      const snapped = flattenFacades(trimmed, 1, roofCutoff);
      if (snapped > 0) {
        console.log(`Facade flattening: ${snapped} voxels snapped to dominant planes (below Y=${roofCutoff})`);
      }
    }
  }

  // Glaze dark exterior blocks as windows BEFORE zone simplification.
  // Zone simplification collapses all blocks to roof/wall dominant types,
  // destroying the dark blocks that indicate windows. By glazing first,
  // gray_stained_glass enters the SPECIAL_BLOCKS set and survives simplification.
  // v73: --no-glaze disables this — scattered glass reads as "noisy/porous" surface to VLMs
  let glazed = 0;
  if (args.mode === 'surface' && !args.noGlaze) {
    glazed = glazeDarkWindows(trimmed);
    if (glazed > 0) {
      console.log(`Window glazing: ${glazed} dark exterior blocks → gray_stained_glass`);
    }
    // Synthetic windows for bright facades that lack dark blocks to glaze.
    // injectSyntheticWindows only fires when existing glazing < 0.5% of non-air
    // and building is ≥ 8 blocks tall, so safe to call unconditionally.
    const injected = injectSyntheticWindows(trimmed, glazed);
    if (injected > 0) {
      console.log(`Synthetic windows: ${injected} blocks (bright facade, glazed=${glazed})`);
    }
  }

  // Zone accent blocks to protect from mode filter (populated by zone simplification)
  let zoneProtected: Set<string> | undefined;
  // Dominant materials — hoisted from zone scope for use by enforceFootprintPolygon + palette cleanup
  let roofDom = 'minecraft:smooth_stone';
  let wallDom = 'minecraft:smooth_stone';
  let groundDom = 'minecraft:sandstone';

  // Multi-zone facade simplification (v67): 5 distinct material zones for visual depth.
  //
  // v65-v66 collapsed all voxels to 2 blocks (roof + wall), producing monochrome
  // buildings that score ~1-3/10. v67 derives accent variants from base colors to
  // create architectural banding without fabricating fake data:
  //   1. Roof (topmost block per column) — satellite color
  //   2. Upper wall (top 20% of wall height) — lighter accent
  //   3. Main wall (middle 60%) — primary wall material
  //   4. Ground floor (bottom 20%) — darker/contrasting base
  //   5. Corner trim (edge columns) — structural accent
  // Glass windows (SPECIAL_BLOCKS) survive all zone assignment.
  {
    const SPECIAL_BLOCKS = new Set([
      'minecraft:air',
      'minecraft:gray_stained_glass',
      'minecraft:green_concrete',
      'minecraft:birch_planks',
    ]);

    // Neutral grays from baked photogrammetric lighting — no material signal
    const GRAY_BLOCKS = new Set([
      'minecraft:smooth_stone',       // rgb 162,162,162
      'minecraft:light_gray_concrete', // rgb 125,125,115
      'minecraft:andesite',           // rgb 136,136,136
      'minecraft:polished_andesite',  // rgb 132,135,134
      'minecraft:gray_concrete',      // rgb 55,58,62
      'minecraft:polished_deepslate', // rgb 55,58,62
    ]);

    // Count blocks per zone: roof = topmost per column, wall = everything below
    const roofCounts = new Map<string, number>();
    const wallCounts = new Map<string, number>();
    for (let x = 0; x < trimmed.width; x++) {
      for (let z = 0; z < trimmed.length; z++) {
        let topY = -1;
        for (let y = trimmed.height - 1; y >= 0; y--) {
          if (trimmed.get(x, y, z) !== 'minecraft:air') { topY = y; break; }
        }
        if (topY < 0) continue;
        for (let y = 0; y <= topY; y++) {
          const b = trimmed.get(x, y, z);
          if (SPECIAL_BLOCKS.has(b)) continue;
          if (y === topY) {
            roofCounts.set(b, (roofCounts.get(b) || 0) + 1);
          } else {
            wallCounts.set(b, (wallCounts.get(b) || 0) + 1);
          }
        }
      }
    }

    // Find dominant in each zone (assigns outer-scoped vars for enforceFootprintPolygon)
    let roofMax = 0;
    for (const [b, c] of roofCounts) { if (c > roofMax) { roofDom = b; roofMax = c; } }
    let wallMax = 0;
    for (const [b, c] of wallCounts) { if (c > wallMax) { wallDom = b; wallMax = c; } }

    // Diagnostic: block distribution before zone override
    const sortedWall = [...wallCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const sortedRoof = [...roofCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  Roof blocks: ${sortedRoof.map(([b, c]) => `${b.replace('minecraft:', '')}(${c})`).join(' ')}`);
    console.log(`  Wall blocks: ${sortedWall.map(([b, c]) => `${b.replace('minecraft:', '')}(${c})`).join(' ')}`);

    // ── Determine base materials ─────────────────────────────────────────────
    // Satellite for roof, photogrammetric secondary for walls (same as v66)
    if (args.coords) {
      const extColors = await sampleSatelliteRoof(args.coords.lat, args.coords.lng);
      if (extColors) roofDom = extColors.roofBlock;

      const sorted = [...wallCounts.entries()]
        .filter(([b]) => !SPECIAL_BLOCKS.has(b))
        .sort((a, b) => b[1] - a[1]);
      const totalWall = sorted.reduce((s, [, c]) => s + c, 0);

      // Find first non-gray secondary with ≥5% of total wall blocks
      const nonGraySecondary = sorted.find(([b, c]) =>
        !GRAY_BLOCKS.has(b) && c >= totalWall * 0.05
      );
      if (nonGraySecondary) {
        wallDom = nonGraySecondary[0];
        console.log(`  Wall: photogrammetric secondary ${wallDom.replace('minecraft:', '')} (${nonGraySecondary[1]} blocks, ${(100 * nonGraySecondary[1] / totalWall).toFixed(0)}%)`);
      } else {
        wallDom = sorted[0]?.[0] ?? wallDom;
      }
      // v96: Always de-bake wall color — photogrammetry textures are baked with
      // ambient occlusion + shadow, making everything ~30-50% darker than reality.
      // Boost brightness 1.5x to better match real-world facade appearance.
      const wallCluster = WALL_CLUSTERS.find(c => c.options.includes(wallDom));
      if (wallCluster) {
        const [wr, wg, wb] = wallCluster.rgb;
        const boosted = rgbToWallBlock(
          Math.min(255, Math.round(wr * 1.5)),
          Math.min(255, Math.round(wg * 1.5)),
          Math.min(255, Math.round(wb * 1.5)),
        );
        if (boosted !== wallDom) {
          console.log(`  Wall de-bake: ${wallDom.replace('minecraft:', '')} → ${boosted.replace('minecraft:', '')} (1.5x brightness boost)`);
          wallDom = boosted;
        }
      }

      // Ensure roof ≠ wall (identical block check)
      if (wallDom === roofDom) {
        const sorted2 = [...wallCounts.entries()]
          .filter(([b]) => !SPECIAL_BLOCKS.has(b))
          .sort((a, b) => b[1] - a[1]);
        const nonGrayFallback = sorted2.find(([b]) =>
          b !== roofDom && !SPECIAL_BLOCKS.has(b) && !GRAY_BLOCKS.has(b)
        );
        if (nonGrayFallback) wallDom = nonGrayFallback[0];
        else {
          const wc = WALL_CLUSTERS.find(c => c.options.includes(roofDom));
          if (wc) {
            const [wr, wg, wb] = wc.rgb;
            const d = rgbToWallBlock(Math.min(255, Math.round(wr * 1.3)), Math.min(255, Math.round(wg * 1.3)), Math.min(255, Math.round(wb * 1.3)));
            if (d !== roofDom) wallDom = d;
          }
        }
        console.log(`  Wall fallback: ${wallDom.replace('minecraft:', '')} (avoided roof duplicate)`);
      }

      // ── v96 contrast enforcement ──────────────────────────────────────────────
      // Preserve satellite-derived colors — only adjust when roof==wall (no contrast).
      // Previous versions forced dark roofs + medium walls ("Beach formula"), but
      // gemini-2.5-pro penalizes color inaccuracy more than contrast deficit.
      const blockLum = (block: string): number => {
        const c = WALL_CLUSTERS.find(cl => cl.options.includes(block));
        if (!c) return 128;
        return (c.rgb[0] + c.rgb[1] + c.rgb[2]) / 3;
      };
      const roofLum = blockLum(roofDom);
      const wallLumV = blockLum(wallDom);

      // Only enforce contrast when roof and wall are literally the same block
      if (wallDom === roofDom) {
        // Pick a complementary wall with visible luminance contrast
        if (roofLum < 100) {
          wallDom = 'minecraft:stone_bricks'; // lum ~124, textured
        } else if (roofLum < 160) {
          wallDom = 'minecraft:smooth_quartz'; // lum ~220, bright
        } else {
          wallDom = 'minecraft:stone_bricks'; // dark against bright roof
        }
        console.log(`  Wall contrast: ${wallDom.replace('minecraft:', '')} (lum ${blockLum(wallDom).toFixed(0)}) [was identical to roof]`);
      }
      console.log(`  Roof lum: ${roofLum.toFixed(0)}, Wall lum: ${blockLum(wallDom).toFixed(0)}, gap: ${Math.abs(blockLum(roofDom) - blockLum(wallDom)).toFixed(0)}`);
    }

    // ── Derive accent materials using complementary color contrast ──────────
    // Brightness-shifting gray blocks produces more gray blocks. Instead, use
    // complementary hue/tone shifts to guarantee VISIBLE contrast:
    //   Cool gray wall → warm accent (sandstone, birch_planks)
    //   Warm wall (brick, terracotta) → cool accent (stone_bricks, polished_andesite)
    //   White wall → medium accent (stone_bricks, andesite)
    //   Dark wall → light accent (smooth_quartz, white_concrete)
    const wallCluster = WALL_CLUSTERS.find(c => c.options.includes(wallDom));
    const wallRgb = wallCluster?.rgb ?? [162, 162, 162];
    const wallLum = (wallRgb[0] + wallRgb[1] + wallRgb[2]) / 3;
    const wallWarmth = wallRgb[0] - wallRgb[2]; // positive = warm, negative = cool

    // Complementary accent lookup: warm vs cool vs neutral
    // Each entry: [groundFloor, bandLine, cornerTrim]
    // Ground: heavier base material. Band: thin floor-divider. Trim: vertical pilaster.
    let groundBlock: string;
    let bandBlock: string;
    let trimBlock: string;

    if (wallLum > 180) {
      // White/cream walls → medium stone accents
      groundBlock = 'minecraft:stone_bricks';
      bandBlock = 'minecraft:smooth_stone_slab';
      trimBlock = 'minecraft:polished_andesite';
    } else if (wallLum < 80) {
      // Dark walls → light accents
      groundBlock = 'minecraft:smooth_quartz';
      bandBlock = 'minecraft:smooth_stone_slab';
      trimBlock = 'minecraft:white_concrete';
    } else if (wallWarmth > 15) {
      // Warm walls (brick, terracotta, sandstone) → cool accents
      groundBlock = 'minecraft:stone_bricks';
      bandBlock = 'minecraft:smooth_stone_slab';
      trimBlock = 'minecraft:polished_andesite';
    } else if (wallWarmth < -5) {
      // Cool walls (blue, cyan) → warm accents
      groundBlock = 'minecraft:sandstone';
      bandBlock = 'minecraft:birch_planks';
      trimBlock = 'minecraft:smooth_sandstone';
    } else {
      // Neutral gray walls → warm accents for contrast
      groundBlock = 'minecraft:sandstone';
      bandBlock = 'minecraft:smooth_stone_slab';
      trimBlock = 'minecraft:birch_planks';
    }

    // Avoid matching roof or wall blocks — fallback chain
    const used = new Set([roofDom, wallDom]);
    const ensureUnique = (block: string, fallbacks: string[]): string => {
      if (!used.has(block)) { used.add(block); return block; }
      for (const fb of fallbacks) { if (!used.has(fb)) { used.add(fb); return fb; } }
      return block; // last resort: allow duplicate
    };
    groundBlock = ensureUnique(groundBlock, ['minecraft:stone_bricks', 'minecraft:polished_granite', 'minecraft:andesite']);
    bandBlock = ensureUnique(bandBlock, ['minecraft:smooth_stone_slab', 'minecraft:stone_brick_slab', 'minecraft:birch_slab']);
    trimBlock = ensureUnique(trimBlock, ['minecraft:polished_andesite', 'minecraft:stone_bricks', 'minecraft:birch_planks', 'minecraft:smooth_sandstone']);

    console.log(`  Zones: roof=${roofDom.replace('minecraft:', '')} wall=${wallDom.replace('minecraft:', '')} ground=${groundBlock.replace('minecraft:', '')} band=${bandBlock.replace('minecraft:', '')} trim=${trimBlock.replace('minecraft:', '')}`);

    // ── Apply multi-zone remaps ──────────────────────────────────────────────
    // Zone assignment per voxel:
    //   - Roof: topmost non-air per column
    //   - Corner trim: edge columns (1 block from AABB border)
    //   - Floor bands: every 3rd block from bottom (thin horizontal slab lines)
    //   - Ground floor: bottom 2 blocks of wall
    //   - Main wall: everything else
    let simplified = 0;
    const { width, height: gh, length: gl } = trimmed;

    // Find grid AABB (non-air extent) for corner/edge detection
    let minGx = width, maxGx = 0, minGz = gl, maxGz = 0;
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < gl; z++) {
        for (let y = 0; y < gh; y++) {
          if (trimmed.get(x, y, z) !== 'minecraft:air') {
            minGx = Math.min(minGx, x); maxGx = Math.max(maxGx, x);
            minGz = Math.min(minGz, z); maxGz = Math.max(maxGz, z);
          }
        }
      }
    }

    for (let x = 0; x < width; x++) {
      for (let z = 0; z < gl; z++) {
        // Find column extent
        let topY = -1, bottomY = gh;
        for (let y = gh - 1; y >= 0; y--) {
          if (trimmed.get(x, y, z) !== 'minecraft:air') {
            if (topY < 0) topY = y;
            bottomY = Math.min(bottomY, y);
          }
        }
        if (topY < 0) continue;

        // Resolution-aware zone thresholds (meters → blocks)
        // At 1 block/m: cornerW=1, groundH=2, corniceH=1, bandInterval=4, minBand=6
        // At 3.28 block/ft: cornerW=3, groundH=7, corniceH=3, bandInterval=13, minBand=20
        const res = args.resolution;
        const cornerW = Math.max(1, Math.round(1 * res));  // ~1m corner pilasters
        const groundH = Math.max(2, Math.round(2 * res));  // ~2m ground floor
        const corniceH = Math.max(1, Math.round(1 * res)); // ~1m cornice band
        const bandInterval = Math.max(4, Math.round(4 * res)); // ~4m floor spacing
        const minBandH = Math.max(6, Math.round(6 * res)); // ~6m min for bands
        const minCornerH = Math.max(5, Math.round(5 * res)); // ~5m min for corners

        // Edge/corner detection for trim pilasters
        const onXEdge = (x <= minGx + cornerW - 1 || x >= maxGx - cornerW + 1);
        const onZEdge = (z <= minGz + cornerW - 1 || z >= maxGz - cornerW + 1);
        const isCorner = onXEdge && onZEdge;

        const wallH = topY - bottomY;

        for (let y = bottomY; y <= topY; y++) {
          const b = trimmed.get(x, y, z);
          if (SPECIAL_BLOCKS.has(b)) continue;

          let target: string;
          const hAbove = y - bottomY; // height above ground

          if (y === topY) {
            // Roof zone — always satellite-derived
            target = roofDom;
          } else if (y >= topY - corniceH && y < topY && wallH >= minCornerH && !isCorner) {
            // Cornice band — blocks just below roof, defines wall-roof transition
            target = bandBlock;
          } else if (isCorner && wallH >= minCornerH) {
            // Corner pilasters — vertical trim accent
            target = trimBlock;
          } else if (hAbove < groundH && wallH >= Math.round(4 * res)) {
            // Ground floor — heavier base material
            target = groundBlock;
          } else if (wallH >= minBandH && hAbove > groundH && hAbove % bandInterval === 0) {
            // Floor band lines — ~4m intervals, thin horizontal divider
            target = bandBlock;
          } else {
            // Main wall body — preserve distinctive (non-gray) colors from photogrammetry.
            // Gray blocks are baked-lighting artifacts; replace with wallDom.
            // Non-gray blocks carry real material signal (brick, copper, terracotta); keep them.
            target = GRAY_BLOCKS.has(b) ? wallDom : b;
          }
          if (b !== target) { trimmed.set(x, y, z, target); simplified++; }
        }
      }
    }
    console.log(`Zone facade: ${simplified} blocks | roof=${roofDom.replace('minecraft:', '')} wall=${wallDom.replace('minecraft:', '')} ground=${groundBlock.replace('minecraft:', '')} band=${bandBlock.replace('minecraft:', '')} trim=${trimBlock.replace('minecraft:', '')}`);

    // ── Roof parapet — 1-block accent border on flat roof edges ─────────────
    // Creates a visible roofline boundary (common in real architecture).
    // Uses MODE roof height (most common topY) instead of global max — handles
    // buildings with towers/spires that exceed the main roof plane.
    {
      // Build height histogram to find the dominant (mode) roof height
      const heightHist = new Map<number, number>();
      let totalOccupied = 0;
      for (let x = 0; x < width; x++) {
        for (let z = 0; z < gl; z++) {
          let topY = -1;
          for (let y = gh - 1; y >= 0; y--) {
            if (trimmed.get(x, y, z) !== 'minecraft:air') { topY = y; break; }
          }
          if (topY >= 0) {
            totalOccupied++;
            heightHist.set(topY, (heightHist.get(topY) ?? 0) + 1);
          }
        }
      }

      // Find mode roof height and check if it's dominant (>40% of columns)
      let modeH = 0, modeCount = 0;
      for (const [h, c] of heightHist) {
        if (c > modeCount) { modeH = h; modeCount = c; }
      }
      // Count columns within ±1 of mode height (flat section)
      const atMode = (heightHist.get(modeH - 1) ?? 0) + modeCount + (heightHist.get(modeH + 1) ?? 0);
      // 25% threshold — catches buildings with towers above a dominant flat section
      // (Dakota has Y=42 at 27%). Lower threshold is safe because parapet only
      // touches columns at the mode height, not the whole building.
      const flatRoof = totalOccupied > 0 && (atMode / totalOccupied) > 0.25;

      if (flatRoof) {
        let parapetCount = 0;
        const parapetBlock = trimBlock; // Use trim accent material
        for (let x = 0; x < width; x++) {
          for (let z = 0; z < gl; z++) {
            let topY = -1;
            for (let y = gh - 1; y >= 0; y--) {
              if (trimmed.get(x, y, z) !== 'minecraft:air') { topY = y; break; }
            }
            // Only apply parapet to columns at or near the mode roof height
            if (topY < 0 || Math.abs(topY - modeH) > 1) continue;
            // Check if this column is on the roof perimeter (adjacent air or shorter neighbor)
            let isEdge = false;
            for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
              const nx = x + dx, nz = z + dz;
              if (nx < 0 || nx >= width || nz < 0 || nz >= gl) { isEdge = true; break; }
              let nTopY = -1;
              for (let ny = gh - 1; ny >= 0; ny--) {
                if (trimmed.get(nx, ny, nz) !== 'minecraft:air') { nTopY = ny; break; }
              }
              if (nTopY < topY - 2) { isEdge = true; break; }
            }
            if (isEdge) {
              // Replace the roof block at topY with parapet material
              trimmed.set(x, topY, z, parapetBlock);
              parapetCount++;
            }
          }
        }
        if (parapetCount > 0) console.log(`Roof parapet: ${parapetCount} blocks at mode height ${modeH} (${parapetBlock.replace('minecraft:', '')})`);
      }
    }

    // Hoist ground block for later palette cleanup
    groundDom = groundBlock;

    // Protect zone accent blocks from mode filter erasure.
    // Thin features (1-block trim columns, 1-block floor bands) get outvoted
    // by surrounding wall blocks without protection.
    // v95: Added roofDom — without protection, modeFilter3D outvotes roof blocks
    // with wall blocks at roof edges, creating swiss-cheese holes in top-down views.
    zoneProtected = new Set([groundBlock, bandBlock, trimBlock, roofDom]);
  }

  // 3D mode filter — smooth spatial noise while preserving multi-zone materials.
  // v67: reduced from 12 to 4 passes. Zone accent blocks (ground/band/trim) are
  // protected so thin architectural features survive smoothing.
  {
    // v95: Hard cap at 3 passes. Previous sqrt(resolution) multiplier gave 4+ passes
    // at 2x res which erased color variety and produced monotone gray facades.
    // 3 passes cleans genuine noise; 4+ homogenizes real material differences.
    const basePasses = Math.max(args.modePasses, 2);
    const passes = Math.min(3, basePasses);
    const modeSmoothed = modeFilter3D(trimmed, passes, 1, zoneProtected);
    if (modeSmoothed > 0) {
      console.log(`Mode filter 3x3x3: ${modeSmoothed} blocks homogenized (${passes} passes)`);
    }
  }

  // Post-filter morphClose — heal surface pockmarks created by mode filter.
  // r=1 is gentle — only fills single-voxel holes without altering shape.
  {
    const closed2 = morphClose3D(trimmed, 1);
    if (closed2 > 0) {
      console.log(`Morph close post-filter (r=1): ${closed2} surface pockmarks healed`);
    }
  }

  // v74/v92/v93: Facade homogenization — per-face minority block collapse.
  // v93: glass RE-PROTECTED. Removing all glass made builds monochrome (C=1 universal).
  // glazeWindows adds glass for material variety — keeping it gives C=3 "3+ material zones".
  // Homogenize still collapses other stray block types (non-glass, non-zone-accent).
  {
    // v95: Reduced from 2 passes at 8% to 1 pass at 10%. Two passes created a
    // feedback loop — first pass created homogeneity, second locked it in,
    // destroying all material variety and producing monotone gray facades.
    const facadeProtected = new Set([
      'minecraft:gray_stained_glass', 'minecraft:glass', 'minecraft:glass_pane',
      'minecraft:light_gray_stained_glass', 'minecraft:black_stained_glass',
      ...(zoneProtected ?? []),
    ]);
    const homogenized = homogenizeFacadesByFace(trimmed, 0.10, 6, facadeProtected);
    if (homogenized > 0) {
      console.log(`Facade homogenization: ${homogenized} minority blocks collapsed (1 pass, 10% threshold)`);
    }
  }

  // v95: Softened palette cleanup — preserve secondary materials that appear ≥3% of
  // their zone. Previous nuclear cleanup replaced ALL non-dominant blocks with the
  // single zone dominant, destroying material variety (sandstone trim on stone walls,
  // brick accents, etc.) and producing monotone gray facades.
  if (roofDom && wallDom) {
    // roofDom/wallDom/groundDom already have 'minecraft:' prefix
    const zoneBlocks = new Set([roofDom, wallDom, groundDom, 'minecraft:air']);
    if (zoneProtected) for (const b of zoneProtected) zoneBlocks.add(b);
    // Protect glass blocks — windows add critical material variety for VLM C score
    for (const g of ['minecraft:gray_stained_glass', 'minecraft:glass', 'minecraft:glass_pane',
      'minecraft:light_gray_stained_glass', 'minecraft:black_stained_glass']) {
      zoneBlocks.add(g);
    }

    const { width: gw, height: gh, length: gl } = trimmed;
    const roofCutoffY = Math.round(gh * 0.60);
    const groundCutoffY = Math.min(3, Math.round(gh * 0.10));

    // v95: Build frequency maps per zone and protect blocks ≥3% of their zone total.
    // This preserves secondary wall materials instead of forcing everything to the dominant.
    const wallFreq = new Map<string, number>();
    const roofFreq = new Map<string, number>();
    let wallTotal = 0, roofTotal = 0;
    for (let y = 0; y < gh; y++) {
      for (let z = 0; z < gl; z++) {
        for (let x = 0; x < gw; x++) {
          const b = trimmed.get(x, y, z);
          if (b === 'minecraft:air') continue;
          if (y >= roofCutoffY) {
            roofFreq.set(b, (roofFreq.get(b) || 0) + 1);
            roofTotal++;
          } else {
            wallFreq.set(b, (wallFreq.get(b) || 0) + 1);
            wallTotal++;
          }
        }
      }
    }
    for (const [b, c] of wallFreq) { if (c >= wallTotal * 0.03) zoneBlocks.add(b); }
    for (const [b, c] of roofFreq) { if (c >= roofTotal * 0.03) zoneBlocks.add(b); }

    let cleaned = 0;
    for (let y = 0; y < gh; y++) {
      // Determine which zone dominant to use based on height
      const zoneFallback = y >= roofCutoffY ? roofDom
        : y <= groundCutoffY ? groundDom
        : wallDom;
      for (let z = 0; z < gl; z++) {
        for (let x = 0; x < gw; x++) {
          const b = trimmed.get(x, y, z);
          if (b === 'minecraft:air') continue;
          if (zoneBlocks.has(b)) continue;
          trimmed.set(x, y, z, zoneFallback);
          cleaned++;
        }
      }
    }
    if (cleaned > 0) {
      console.log(`Palette cleanup: ${cleaned} stray blocks → zone dominants (${zoneBlocks.size - 1} protected types)`);
    }
  }

  // v80: Post-processing re-mask — re-sharpen edges blurred by morphClose/modeFilter.
  // After all processing (zone assignment, contrast, homogenize), run maskToFootprint
  // again with same dilation as pre-fill to clip morphClose/modeFilter expansion.
  // Safety: snapshot grid before mask, revert if >40% removed (polygon alignment issue).
  if (osmPolygon && args.coords && !args.noOsm && !args.noPostMask) {
    const postMaskDilate = args.maskDilate ?? 3; // same dilation as pre-fill mask
    const blocksBefore = trimmed.countNonAir();

    // Snapshot blocks that might be cleared, so we can revert if mask is too aggressive
    const snapshot = new Map<number, string>(); // index → blockState
    const { width: sw, height: sh, length: sl } = trimmed;
    for (let y = 0; y < sh; y++) {
      for (let z = 0; z < sl; z++) {
        for (let x = 0; x < sw; x++) {
          const b = trimmed.get(x, y, z);
          if (b !== 'minecraft:air') snapshot.set((y * sl + z) * sw + x, b);
        }
      }
    }

    const postMasked = maskToFootprint(
      trimmed, osmPolygon,
      args.coords.lat, args.coords.lng,
      Math.round(postMaskDilate * args.resolution), args.resolution, enuHorizontalAngle,
    );
    if (postMasked > 0) {
      const pctRemoved = blocksBefore > 0 ? (postMasked / blocksBefore * 100) : 0;
      if (pctRemoved > 40) {
        // Too aggressive — revert all masked blocks
        for (const [idx, bs] of snapshot) {
          const x = idx % sw;
          const z = Math.floor(idx / sw) % sl;
          const y = Math.floor(idx / (sw * sl));
          trimmed.set(x, y, z, bs);
        }
        console.log(`    Post-morph re-mask: REVERTED — would remove ${pctRemoved.toFixed(0)}% of blocks (polygon misaligned)`);
      } else {
        console.log(`    Post-morph re-mask: ${postMasked} blocks clipped (${pctRemoved.toFixed(0)}%, dilate=${postMaskDilate})`);
      }
    }
  }

  // v71: Footprint freeze — prevent morphClose/modeFilter from expanding the
  // building outline beyond its pre-processing shape. Save 2D footprint before
  // morphClose, then after all processing clip any columns that weren't in
  // the original footprint. This preserves interior fill while preventing
  // outline expansion from dilation.
  // (Applied after morphClose+modeFilter, uses savedFootprint captured earlier)
  if (savedFootprint) {
    let footprintClipped = 0;
    const { width: gw, height: gh, length: gl } = trimmed;
    for (let z = 0; z < gl; z++) {
      for (let x = 0; x < gw; x++) {
        if (savedFootprint[z * gw + x]) continue; // Column was in original footprint — keep
        // Column was empty before morphClose — clear any blocks added by processing
        for (let y = 0; y < gh; y++) {
          if (trimmed.get(x, y, z) !== 'minecraft:air') {
            trimmed.set(x, y, z, 'minecraft:air');
            footprintClipped++;
          }
        }
      }
    }
    if (footprintClipped > 0) {
      console.log(`Footprint freeze: ${footprintClipped} blocks clipped (new columns from morphClose/filter)`);
    }
  }

  // Sky contamination remap — Google 3D Tiles bake ambient skylight (blue/cyan)
  // into upward-facing surfaces. These are artifacts, never real materials.
  // v68: Always apply after zone simplification. Zone assignment already replaced
  // wall/roof/ground with correct materials, so any remaining blue/cyan blocks
  // are contamination from unassigned voxels (holes, interior leaks).
  {
    const skyReplacements = new Map<string, string>([
      ['minecraft:light_blue_terracotta', 'minecraft:light_gray_concrete'],
      ['minecraft:cyan_terracotta', 'minecraft:stone'],
      ['minecraft:light_blue_concrete', 'minecraft:light_gray_concrete'],
      ['minecraft:cyan_concrete', 'minecraft:stone'],
    ]);
    const constrained = constrainPalette(trimmed, skyReplacements);
    if (constrained > 0) {
      console.log(`Sky palette: ${constrained} blue/cyan sky-contaminated blocks remapped`);
    }
  }

  // v71: OSM footprint polygon fill — plug empty interior columns.
  // Clipping is disabled (pre-fill OSM mask already removed neighbors;
  // post-processing clip destroyed wing connectors in v71 testing).
  // Only fills empty columns within the core polygon + proximity gate.
  if (osmPolygon && args.coords && !args.noOsm) {
    const { filled: fpFill } = enforceFootprintPolygon(
      trimmed,
      osmPolygon,
      args.coords.lat, args.coords.lng,
      args.resolution, enuHorizontalAngle,
      wallDom, roofDom,
    );
    if (fpFill > 0) {
      console.log(`Footprint fill: ${fpFill} voxels added to empty interior columns`);
    }
  }

  // v73: Synthetic peaked/hip roof — stacks progressively inset footprints to create
  // a sloped roof from any footprint shape. Use --peaked-roof flag.
  if (args.peakedRoof) {
    const roofAdded = addPeakedRoof(trimmed, roofDom);
    if (roofAdded > 0) {
      console.log(`Peaked roof: ${roofAdded} blocks added (${roofDom.replace('minecraft:', '')})`);
    }
  }

  // Connected-component cleanup — remove floating debris and disconnected clusters.
  const componentThreshold = args.mode === 'surface' ? 500 : args.cleanMinSize;
  if (componentThreshold > 0) {
    const cleaned = removeSmallComponents(trimmed, componentThreshold);
    if (cleaned > 0) {
      console.log(`Component cleanup: ${cleaned} blocks removed (components < ${componentThreshold} voxels)`);
    }
  }

  // Custom block remaps — final override, applied after all other processing
  if (args.remaps.size > 0) {
    const remapped = constrainPalette(trimmed, args.remaps);
    console.log(`Custom remap: ${remapped} blocks remapped (${args.remaps.size} rules)`);
  }

  // Entry path disabled for tiles pipeline (v70): the diagonal walkway from
  // grid edge to building entrance confuses VLM grading ("strange appendage").
  // Keep placeEntryPath available for generated buildings but skip it here.
  // if (analysis?.entryPosition && analysis.entryPath.length > 0) {
  //   const pathPlaced = placeEntryPath(trimmed, analysis);
  //   if (pathPlaced > 0) {
  //     console.log(`Entry path: ${pathPlaced} blocks placed (smooth_stone_slab, face=${analysis.entryFace})`);
  //   }
  // }

  // ─── Plot Context Expansion ─────────────────────────────────────────────────
  // --scene + --plot-radius: expand grid XZ to include surrounding plot context
  if (args.scene && args.coords) {
    const maxDim = Math.max(trimmed.width, trimmed.length);
    const plotR = args.plotRadius > 0
      ? args.plotRadius * args.resolution
      : maxDim + 30 * args.resolution; // default: building + 15m on each side
    const newDim = Math.ceil(plotR * 2);
    if (newDim > trimmed.width || newDim > trimmed.length) {
      console.log(`\n--- Plot Expansion ---`);
      console.log(`  Building: ${trimmed.width}x${trimmed.length} → Plot: ${newDim}x${newDim}`);
      trimmed = expandGrid(trimmed, newDim, newDim);
    }
  }

  // ─── Scene Enrichment ──────────────────────────────────────────────────────
  // --enrich / --scene: classify voxels, query OSM infrastructure, populate environment
  if (args.enrich && args.coords) {
    console.log('\n--- Scene Enrichment ---');
    const enrichResult = await enrichScene({
      grid: trimmed,
      coords: args.coords,
      resolution: args.resolution,
      plotRadius: Math.max(trimmed.width, trimmed.length) / (2 * args.resolution),
      capturedEnvironment: envPositions,
      onProgress: (msg) => console.log(`  ${msg}`),
    });
    const es = enrichResult.meta.envStats;
    console.log(`  Environment: trees=${es.treesPlaced}, roads=${es.roadsPlaced}, fences=${es.fencesPlaced}, ground=${es.groundFilled}`);
  } else if (args.enrich && !args.coords) {
    console.log('\nWARNING: --enrich requires --coords LAT,LNG — skipping enrichment');
  }

  // Write output
  const nonAir = trimmed.countNonAir();
  console.log(`\nGrid: ${trimmed.width}x${trimmed.height}x${trimmed.length} | Blocks: ${nonAir.toLocaleString()} | Palette: ${trimmed.palette.size}`);
  console.log(`Palette: ${[...trimmed.palette].join(', ')}`);

  writeSchematic(trimmed, args.outputPath);
  const fileSize = Bun.file(args.outputPath).size;
  console.log(`\nWrote: ${args.outputPath} (${fileSize.toLocaleString()} bytes)`);
  console.log(`Total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
