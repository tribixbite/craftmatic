import { resolve, basename, extname, join, dirname } from 'node:path';
import type { VoxelizeMode } from '../convert/voxelizer.js';

export interface CLIArgs {
  inputPath: string;
  resolution: number;
  mode: VoxelizeMode;
  minHeight: number;
  trimThreshold: number;
  gamma: number;
  kernel: number;
  explicitKernel: boolean; // true if --kernel was explicitly passed
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
  batchPaths: string[];  // additional positional args for batch mode
  coords: { lat: number; lng: number } | null; // OSM footprint masking coordinates
  keepVegetation: boolean; // preserve green/brown vegetation blocks (for satellite comparison)
  noEnu: boolean;          // skip ENU reorientation (for pre-oriented headless GLBs)
  noEnuSnap: boolean;      // ENU tilt-only — skip 90° horizontal snap (preserves real-world orientation)
  noOsm: boolean;          // skip OSM footprint masking (for misaligned geocodes)
  noPostMask: boolean;     // skip post-processing OSM re-mask (v80)
  noIsolate: boolean;      // skip automatic building isolation
  maskDilate: number;      // OSM polygon dilation in blocks (default 3)
  osmId: { type: 'way' | 'relation'; id: number } | null; // explicit OSM element ID (bypass proximity search)
  enrich: boolean;         // run scene enrichment (trees, roads, ground) around building
  scene: boolean;          // unified scene pipeline: env extraction → strip → enrich
  plotRadius: number;      // plot context expansion radius in meters (0 = auto)
  zoneNormalize: boolean;  // apply 5-zone facade normalization (default: off, preserves raw photogrammetric colors)
  recolor: boolean;        // v314: SV/satellite-driven facade+roof recoloring (requires --coords)
  heightCorrect: boolean;  // extrude truncated tall buildings to match known height
  heightOverride: number;  // manual building height in meters (0 = auto from OSM/Mapbox)
  noCache: boolean;        // bypass GLB tile cache
  cacheInfo: boolean;      // show tile cache status and exit
}

export function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: bun scripts/voxelize-glb.ts <input.glb> [options]

Options:
  --resolution, -r   Blocks per meter (default: 1, max: 10 = 0.1m/block)
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
  --no-enu-snap      ENU tilt correction only — skip 90° horizontal snap (preserves real-world orientation)
  --no-osm           Skip OSM footprint masking (when geocode doesn't match building)
  --no-post-mask     Skip post-processing OSM re-mask (v80 edge re-sharpening)
  --osm-id TYPE/ID   Use specific OSM element (e.g. way/66418590) instead of proximity search
  --enrich           Run scene enrichment (trees, roads, ground fill) — requires --coords
  --scene            Unified scene pipeline: env extraction → strip → feature replacement →
                     plot expansion → enrichment — requires --coords
  --plot-radius N    Plot context radius in meters (default: auto = building + 15m per side)
  --recolor          SV/satellite-driven facade+roof recoloring — requires --coords
  --height-correct   Extrude truncated tall buildings to match known height (OSM/Mapbox)
  --height N         Manual building height override in meters (used with --height-correct)
  --no-cache         Bypass GLB tile cache (always re-process from source)
  --cache-info       Show tile cache status and exit`);
    process.exit(0);
  }

  // First non-flag arg is the input path
  let inputPath = '';
  let resolution = 1;
  let mode: VoxelizeMode = 'surface';
  let minHeight = 2;
  let trimThreshold = 0.05;
  let gamma = 0.5; // v300: aggressive gamma eliminates shadow-baked dark noise from photogrammetry textures
  let kernel = 12; // Moderate kernel — preserves window/trim features while smoothing noise
  let explicitKernel = false; // Track if --kernel was explicitly passed
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
  let noGlaze = true; // v300: glazing off by default — swiss-cheese on dark facades
  let peakedRoof = false;
  let cleanMinSize = 0;
  let cropRadius = 0;
  let auto = false;
  let autoInfo = false;
  let batch = false;
  let coords: { lat: number; lng: number } | null = null;
  let keepVegetation = false;
  let noEnu = false;
  let noEnuSnap = false;
  let noOsm = false;
  let noPostMask = false;
  let noIsolate = false;
  let maskDilate = 3;
  let osmId: { type: 'way' | 'relation'; id: number } | null = null;
  let enrich = false;
  let scene = false;
  let plotRadius = 0; // 0 = auto-compute when --scene
  let zoneNormalize = false; // v300: off by default — preserve raw photogrammetric CIELAB colors
  let recolor = false; // v314: SV/satellite facade+roof recoloring
  let heightCorrect = false; // extrude truncated buildings to known height
  let heightOverride = 0; // manual height override in meters (0 = auto)
  let noCache = false; // bypass GLB tile cache
  let cacheInfo = false; // show tile cache info and exit
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
      explicitKernel = true;
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
    } else if (arg === '--glaze') {
      noGlaze = false; // v300: re-enable glazing
    } else if (arg === '--no-glaze') {
      noGlaze = true;
    } else if (arg === '--peaked-roof') {
      peakedRoof = true;
    } else if (arg === '--keep-vegetation') {
      keepVegetation = true;
    } else if (arg === '--no-enu') {
      noEnu = true;
    } else if (arg === '--no-enu-snap') {
      noEnuSnap = true;
    } else if (arg === '--no-osm') {
      noOsm = true;
    } else if (arg === '--no-post-mask') {
      noPostMask = true;
    } else if (arg === '--no-isolate') {
      noIsolate = true;
    } else if (arg === '--osm-id') {
      const val = args[++i]; // e.g. "way/66418590" or "relation/6333150"
      const slashIdx = val.indexOf('/');
      if (slashIdx > 0) {
        const t = val.slice(0, slashIdx) as 'way' | 'relation';
        const id = parseInt(val.slice(slashIdx + 1), 10);
        if ((t === 'way' || t === 'relation') && !isNaN(id)) {
          osmId = { type: t, id };
        }
      }
    } else if (arg === '--enrich') {
      enrich = true;
    } else if (arg === '--scene') {
      scene = true;
      enrich = true; // --scene implies --enrich
    } else if (arg === '--plot-radius') {
      plotRadius = parseInt(args[++i], 10);
    } else if (arg === '--zone-normalize') {
      zoneNormalize = true;
    } else if (arg === '--recolor') {
      recolor = true;
    } else if (arg === '--height-correct') {
      heightCorrect = true;
    } else if (arg === '--height') {
      heightOverride = parseFloat(args[++i]);
    } else if (arg === '--no-cache') {
      noCache = true;
    } else if (arg === '--cache-info') {
      cacheInfo = true;
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

  return { inputPath, resolution, mode, minHeight, trimThreshold, gamma, kernel, explicitKernel, desaturate, outputPath, infoOnly, generic, explicitGeneric, explicitFill, explicitModePasses, explicitResolution, preview, smoothPct, modePasses, fill, noPalette, noCornice, noFireEscape, noGlaze, peakedRoof, cleanMinSize, cropRadius, remaps, auto, autoInfo, batch, batchPaths, coords, keepVegetation, noEnu, noEnuSnap, noOsm, noPostMask, noIsolate, maskDilate, osmId, enrich, scene, plotRadius, zoneNormalize, recolor, heightCorrect, heightOverride, noCache, cacheInfo };
}
