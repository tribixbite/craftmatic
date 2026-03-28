#!/usr/bin/env bun
/**
 * iterate-grade.ts — Iterative pipeline improvement orchestrator.
 *
 * Voxelizes 10 diverse buildings, renders grade composites, grades via VLM,
 * parses A/B/C sub-scores, computes trimmed mean, and updates state files.
 *
 * Usage:
 *   bun scripts/iterate-grade.ts                       # run all buildings
 *   bun scripts/iterate-grade.ts --only flatiron,noe   # specific buildings
 *   bun scripts/iterate-grade.ts --grade-only           # skip voxelize/render
 *   bun scripts/iterate-grade.ts --version v80          # tag iteration
 *   bun scripts/iterate-grade.ts --runs 3               # VLM runs per building (default 11)
 *   bun scripts/iterate-grade.ts --model gemini-2.5-pro   # VLM model override (default: gemini-2.5-pro)
 *   bun scripts/iterate-grade.ts --deep-review          # run harsh critic pass with pro model
 *   bun scripts/iterate-grade.ts --deep-model gemini-2.5-pro  # deep review model (default)
 *   bun scripts/iterate-grade.ts --deep-runs 3          # deep review runs per building (default 3)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, basename } from 'path';
import { $ } from 'bun';
import sharp from 'sharp';
import { computeBuildingAlignment, type BuildingAlignment } from '../src/convert/building-alignment.js';
import { searchOSMBuilding } from '../src/gen/api/osm.js';
import { scoreFromDefects, type DefectChecklist } from '../src/grade/defect-score.js';

// ── Building configs ──
interface BuildingConfig {
  key: string;
  glb: string;
  coords: string;         // "lat,lng" for OSM mask
  satRef: string;
  satZoom?: number;       // Google Static Maps satellite zoom (computed from MBR width when absent)
  resolution: number;     // 1 or 2 (0 = auto)
  maskDilate: number;     // 0-3
  extraFlags: string[];   // additional voxelize flags
  difficulty: 'easy' | 'medium' | 'hard';
  tileSize: number;       // iso render tile size
  topdownScale: number;   // topdown render scale
}

/** Compute satellite zoom from MBR width. Smaller buildings get higher zoom. */
function computeSatZoom(mbrWidth: number): number {
  return Math.min(20, Math.floor(22 - Math.log2(mbrWidth / 10)));
}

const DIR = 'output/tiles';

// v300: 10 angular buildings — all have distinctive non-rectangular forms.
// Methodology: 11 VLM runs, 20% trimmed mean, gemini-2.5-pro, temp=0.0, binary defect checklist.
// Satellite zoom computed dynamically from MBR width via computeSatZoom().
const BUILDINGS: BuildingConfig[] = [
  // ── Tier 1: proven or high-confidence ──
  {
    // Triangular wedge — proven 10/10 in v200, tests wedge preservation
    key: 'flatiron',
    glb: `${DIR}/tiles-flatiron-building-new-york-ny.glb`,
    coords: '40.7411,-73.9897',
    satRef: `${DIR}/sat-ref-flatiron.jpg`,
    resolution: 2, // small footprint needs 2x for detail
    maskDilate: 1,
    extraFlags: ['--no-enu'], // pre-oriented headless GLB — ENU rotation breaks OSM mask alignment
    difficulty: 'easy',
    tileSize: 6,
    topdownScale: 6,
  },
  {
    // Twin trapezoidal towers with 45° angled tops — proven 8.0 in v200
    // Pennzoil Place, Houston, 151m, ~90×50m total with 3m gap between towers
    key: 'pennzoil',
    glb: `${DIR}/pennzoil-v200.glb`,
    coords: '29.7601,-95.3698',
    satRef: `${DIR}/sat-ref-pennzoil.jpg`,
    resolution: 1,
    maskDilate: 2,
    extraFlags: ['--no-enu'], // pre-oriented headless GLB
    difficulty: 'hard',
    tileSize: 6,
    topdownScale: 8,
  },
  {
    // Trapezoidal footprint with angular walls — National Gallery of Art East Building
    // I.M. Pei, Washington DC, 39m, distinctive triangular plan
    key: 'nga-east',
    glb: `${DIR}/national-gallery-east.glb`,
    coords: '38.8913,-77.0199',
    satRef: `${DIR}/sat-ref-nga-east.jpg`,
    resolution: 1, // r=2 bloats grid (OSM polygon = entire National Gallery complex)
    maskDilate: 2,
    extraFlags: ['--no-enu'],
    difficulty: 'medium',
    tileSize: 6,
    topdownScale: 8,
  },
  // ── Tier 2: medium confidence ──
  {
    // Inverted pyramid city hall — Dallas City Hall, I.M. Pei
    // 37m, cantilevered inverted pyramid form
    key: 'dallas-cityhall',
    glb: `${DIR}/dallas-cityhall.glb`,
    coords: '32.7763,-96.7968',
    satRef: `${DIR}/sat-ref-dallas-cityhall.jpg`,
    resolution: 1,
    maskDilate: 2,
    extraFlags: ['--no-enu'],
    difficulty: 'hard',
    tileSize: 6,
    topdownScale: 8,
  },
  {
    // Faceted glass diamond — Seattle Central Library, Rem Koolhaas
    // 56m, angular faceted form with distinct diamond cross-section
    key: 'seattle-library',
    glb: `${DIR}/seattle-library.glb`,
    coords: '47.6067,-122.3326',
    satRef: `${DIR}/sat-ref-seattle-library.jpg`,
    resolution: 1,
    maskDilate: 2,
    extraFlags: ['--no-enu'],
    difficulty: 'hard',
    tileSize: 6,
    topdownScale: 8,
  },
  {
    // Brutalist inverted ziggurat — Boston City Hall, Kallmann McKinnell & Knowles
    // 60m, stepped cantilevered form
    key: 'boston-cityhall',
    glb: `${DIR}/boston-cityhall.glb`,
    coords: '42.3605,-71.0580',
    satRef: `${DIR}/sat-ref-boston-cityhall.jpg`,
    resolution: 1,
    maskDilate: 2,
    extraFlags: ['--no-enu'],
    difficulty: 'hard',
    tileSize: 6,
    topdownScale: 8,
  },
  {
    // 45° sloped roof crown — proven 8.7 in v200, angular crown is voxel-friendly
    // Citigroup Center, 279m, 49m square footprint
    key: 'citigroup',
    glb: `${DIR}/citigroup-v200.glb`,
    coords: '40.7585,-73.9703',
    satRef: `${DIR}/sat-ref-citigroup.jpg`,
    resolution: 1,
    maskDilate: 1,
    extraFlags: ['--no-enu'], // pre-oriented headless GLB
    difficulty: 'hard',
    tileSize: 6,
    topdownScale: 8,
  },
  // ── Tier 3: proven GLBs ──
  {
    // Brutalist inverted pyramid — Geisel Library, UCSD, William Pereira
    // 39m, mushroom-cap form on narrow stem, angular cantilevers
    key: 'geisel',
    glb: `${DIR}/geisel-v200.glb`,
    coords: '32.8811,-117.2376',
    satRef: `${DIR}/sat-ref-geisel.jpg`,
    resolution: 2,
    maskDilate: 2,
    extraFlags: ['--no-enu'],
    difficulty: 'hard',
    tileSize: 6,
    topdownScale: 8,
  },
  {
    // Pyramidal taper — Transamerica Pyramid, William Pereira
    // 260m, tapered to point, distinctive triangular silhouette
    key: 'transamerica',
    glb: `${DIR}/transamerica-v200b.glb`,
    coords: '37.7952,-122.4028',
    satRef: `${DIR}/sat-ref-transamerica.jpg`,
    resolution: 1,
    maskDilate: 2,
    extraFlags: ['--no-enu'],
    difficulty: 'hard',
    tileSize: 6,
    topdownScale: 8,
  },
  {
    // Art deco tower with pyramid crown — LA City Hall
    // 138m, stepped setbacks with beacon tower
    key: 'la-cityhall',
    glb: `${DIR}/la-cityhall.glb`,
    coords: '34.0537,-118.2430',
    satRef: `${DIR}/sat-ref-la-cityhall.jpg`,
    resolution: 1,
    maskDilate: 2,
    extraFlags: ['--no-enu'],
    difficulty: 'hard',
    tileSize: 6,
    topdownScale: 8,
  },
];

// ── VLM Grading ──
interface SubScore { A: number; B: number; C: number; D: number; total: number }

interface BuildingResult {
  key: string;
  version: string;
  difficulty: string;
  scores: number[];
  subscores: SubScore[];
  trimmedMean: number;
  diagnosis: string;
  timestamp: string;
  satRefQuality?: number;        // 1-5 sat ref clarity rating
  deepReviewScores?: number[];   // scores from gemini-2.5-pro critic
  deepReviewMean?: number;       // trimmed mean of deep review scores
}

interface IterateState {
  version: string;
  timestamp: string;
  target: number;
  passing: number;
  total: number;
  model: string;
  buildings: Record<string, BuildingResult>;
  lastDeepReview?: string;       // ISO timestamp of last deep review run
  deepReviewModel?: string;      // model used for deep review
}

const DEFECT_PROMPT = `You are evaluating a Minecraft voxel recreation of a real building.

You will see 5 images:
1. Satellite reference (rotated to match voxel orientation, building outlined in cyan)
2. Top-down view of the voxel model
3. Front elevation of the voxel model
4. Isometric front-right view of the voxel model
5. Isometric back-left view of the voxel model

Answer each question with true or false. Be VERY conservative — only flag defects you are CERTAIN about. This is a Minecraft voxel model, so expect blocky approximations, not pixel-perfect reproduction. When in doubt, answer false for defect questions and true for quality questions.

{
  "height_truncated": [true ONLY if ≥30% of the building height is clearly missing — the top is sliced off at an unnatural flat line. False for buildings that are simply short or have flat roofs.],
  "facade_holes_visible": [true ONLY if large wall sections (5+ blocks) are completely missing, revealing hollow interior or sky behind. NOT dark texture patches, color variation, or window recesses.],
  "floating_artifacts": [true ONLY if clearly separate structures are floating in mid-air, disconnected from the building by visible air gaps. NOT minor surface bumps or ground-level debris.],
  "neighbor_buildings_merged": [true ONLY if a second clearly distinct building is attached to or fused with the target building — not interior courtyards or wings of the same building],
  "footprint_wrong_shape": [true ONLY if the overall footprint CATEGORY is wrong — e.g., voxel is a circle but satellite shows a rectangle, or voxel is an L-shape but satellite shows a triangle. False if the shapes are the same category (both rectangles, both L-shapes) even if proportions differ slightly. Irregular edges from voxelization are expected and NOT a shape error.],
  "false_positives_merged": [true ONLY if large non-building structures (bridges, walls, roads) are visibly merged into the building],
  "building_recognizable": [true if the overall 3D form — footprint shape, height profile, massing — is a reasonable voxel approximation of what you see in the satellite. Perfect reproduction is NOT required.],
  "proportions_correct": [true if the building's width-to-height-to-depth ratios are within ~30% of the satellite reference. Voxel quantization creates minor proportion shifts — only flag MAJOR distortions like 2:1 becoming 1:1.],
  "surface_detail_visible": [true if the facade shows multiple distinct Minecraft block types with visible color or texture variation]
}

Respond with ONLY the JSON object, no explanation.`;

// scoreFromDefects and DefectChecklist are imported from src/grade/defect-score.ts

// ── CLI parsing ──
const args = process.argv.slice(2);
function getFlag(name: string, def: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
}
function hasFlag(name: string): boolean { return args.includes(name); }

const version = getFlag('--version', 'v80');
const vlmModel = getFlag('--model', 'gemini-2.5-pro');
const vlmRuns = parseInt(getFlag('--runs', '11'), 10);
const gradeOnly = hasFlag('--grade-only');
const mergeScores = hasFlag('--merge-scores');
const deepReview = hasFlag('--deep-review');
const deepReviewModel = getFlag('--deep-model', 'gemini-2.5-pro');
const deepReviewRuns = parseInt(getFlag('--deep-runs', '3'), 10);
const sweepMode = hasFlag('--sweep');
const sweepRuns = parseInt(getFlag('--sweep-runs', '3'), 10); // quick-grade runs per variant
const onlyKeys = getFlag('--only', '').split(',').filter(Boolean);
const sceneMode = hasFlag('--scene');
const targetScore = 9;

// Filter buildings
const selectedBuildings = onlyKeys.length > 0
  ? BUILDINGS.filter(b => onlyKeys.includes(b.key))
  : BUILDINGS;

if (selectedBuildings.length === 0) {
  console.error(`No buildings matched --only ${onlyKeys.join(',')}`);
  process.exit(1);
}

// ── API keys ──
const apiKey = process.env.GOOGLE_API_KEY
  || (existsSync('.env') ? readFileSync('.env', 'utf8').match(/GOOGLE_API_KEY=(.+)/)?.[1]?.trim() : undefined);
if (!apiKey) { console.error('No GOOGLE_API_KEY'); process.exit(1); }

const mapsKey = process.env.GOOGLE_MAPS_API_KEY || apiKey;

/** High-res satellite path — scale=2 gives 1280×1280 pixels */
function hiResSatPath(b: BuildingConfig): string {
  return b.satRef.replace('.jpg', '-hires.jpg');
}

/** Fetch high-resolution satellite reference (scale=2 for 1280×1280) at configured zoom.
 *  Zoom is computed dynamically from alignment MBR width when no explicit satZoom is set. */
async function ensureSatRef(b: BuildingConfig, alignment?: BuildingAlignment): Promise<void> {
  const refreshSat = hasFlag('--refresh-sat');
  const hiResPath = hiResSatPath(b);
  // Fetch both standard and hi-res versions
  if (!refreshSat && existsSync(b.satRef) && existsSync(hiResPath)) return;
  const [lat, lng] = b.coords.split(',');
  const zoom = b.satZoom ?? (alignment ? computeSatZoom(alignment.mbrWidth) : 19);

  // Standard res (640×640) — backward compat
  if (refreshSat || !existsSync(b.satRef)) {
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=640x640&maptype=satellite&key=${mapsKey}`;
    console.log(`  Fetching satellite ref for ${b.key} (z${zoom})...`);
    const resp = await fetch(url);
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      await Bun.write(b.satRef, buf);
      console.log(`  Saved: ${b.satRef} (${(buf.length / 1024).toFixed(0)}KB)`);
    }
  }

  // High-res (scale=2 → 1280×1280 pixels, same geographic extent)
  if (refreshSat || !existsSync(hiResPath)) {
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=640x640&scale=2&maptype=satellite&key=${mapsKey}`;
    console.log(`  Fetching hi-res satellite for ${b.key} (z${zoom}, scale=2, 1280px)...`);
    const resp = await fetch(url);
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      await Bun.write(hiResPath, buf);
      console.log(`  Saved hi-res: ${hiResPath} (${(buf.length / 1024).toFixed(0)}KB)`);
    }
  }
}

/** Compute BuildingAlignment from OSM polygon for a building config */
async function computeAlignment(b: BuildingConfig): Promise<BuildingAlignment | undefined> {
  try {
    const [latStr, lngStr] = b.coords.split(',');
    const lat = parseFloat(latStr), lng = parseFloat(lngStr);
    const osmData = await searchOSMBuilding(lat, lng, 150);
    if (osmData?.polygon?.length >= 3) {
      const polygon = osmData.polygon.map((p: { lat: number; lng: number }) => ({ lat: p.lat, lon: p.lng }));
      return computeBuildingAlignment(polygon, lat, lng);
    }
  } catch {
    // OSM query may fail for some buildings — non-fatal
  }
  return undefined;
}

/** Generate rotated satellite image aligned to building MBR orientation.
 *  Rotates by -rotationDeg so the primary facade faces south (matching voxel grid).
 *  Saves to a separate *-rotated.jpg path to preserve the original cache. */
async function ensureRotatedSatRef(b: BuildingConfig, alignment: BuildingAlignment): Promise<string> {
  const rotatedPath = b.satRef.replace('.jpg', '-rotated.jpg');
  const refreshSat = hasFlag('--refresh-sat');
  if (!refreshSat && existsSync(rotatedPath)) return rotatedPath;

  const srcPath = existsSync(hiResSatPath(b)) ? hiResSatPath(b) : b.satRef;
  if (!existsSync(srcPath)) return b.satRef; // no satellite to rotate

  const rotated = await sharp(srcPath)
    .rotate(-alignment.rotationDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .jpeg({ quality: 90 })
    .toBuffer();
  await Bun.write(rotatedPath, rotated);
  console.log(`  Rotated satellite: ${rotatedPath} (${alignment.rotationDeg.toFixed(1)}°)`);
  return rotatedPath;
}

/** Rate how clearly the building is visible in a satellite reference image (1-5) */
async function validateSatRef(b: BuildingConfig): Promise<number> {
  if (!existsSync(b.satRef)) return 1;
  const data = readFileSync(b.satRef);
  const parts = [
    { text: 'Rate 1-5 how clearly the main building is visible in this satellite image. 1=obscured by trees/shadows/low resolution. 5=fully visible with clear outline and edges. Respond with ONLY a single number.' },
    { inlineData: { mimeType: 'image/jpeg', data: data.toString('base64') } },
  ];

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${vlmModel}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 16 },
        }),
      },
    );
    if (!res.ok) return 3; // assume mid-quality on API failure
    const json = await res.json() as { candidates?: Array<{ content: { parts: Array<{ text?: string }> } }> };
    const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
    const num = parseInt(text.trim(), 10);
    if (num >= 1 && num <= 5) return num;
    return 3;
  } catch {
    return 3;
  }
}

// ── Helpers ──

/** Run a shell command, return stdout. Throws on non-zero exit. */
async function run(cmd: string, timeoutMs = 300_000): Promise<string> {
  const proc = Bun.spawn(['bash', '-c', cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timer);
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`  CMD FAILED (${code}): ${cmd}\n  ${stderr.slice(0, 500)}`);
    throw new Error(`Command failed: ${cmd}`);
  }
  return stdout + stderr;
}

/** Voxelize result with grid metadata for scale matching */
interface VoxelizeResult {
  schem: string;
  actualRes: number;
  gridWidth: number;   // X dimension in blocks
  gridHeight: number;  // Y dimension in blocks
  gridLength: number;  // Z dimension in blocks
  blockCount: number;
}

/** Voxelize a building: glb → schem, returns grid dimensions for composite scale matching */
async function voxelize(b: BuildingConfig): Promise<VoxelizeResult> {
  const schem = `${DIR}/${b.key}-${version}.schem`;
  const flagParts = [
    'bun scripts/voxelize-glb.ts', `"${b.glb}"`, '--auto',
    '--coords', `"${b.coords}"`,
    '--mask-dilate', String(b.maskDilate),
    // v300: allow reorientToENU to fire — uses BuildingAlignment for precise rotation
    // when OSM polygon is available, falls back to PCA sweep otherwise
    '--gamma', '0.4', // stronger gamma compensates for raw CIELAB baked-lighting darkness
  ];
  // --scene flag: adds environment extraction, feature replacement, plot expansion, enrichment
  if (sceneMode) flagParts.push('--scene');
  // Only pass -r when explicitly set (resolution > 0); otherwise let auto-2x decide
  if (b.resolution > 0) flagParts.push('-r', String(b.resolution));
  flagParts.push('-o', `"${schem}"`, ...b.extraFlags);
  const flags = flagParts.join(' ');
  console.log(`  Voxelizing: ${b.key} (r=${b.resolution > 0 ? b.resolution : 'auto'}, dilate=${b.maskDilate})`);
  const out = await run(flags, 2_400_000); // 40min — ESB v200b takes ~20min on ARM
  // Parse grid dimensions and actual resolution from output
  let actualRes = b.resolution > 0 ? b.resolution : 1;
  let gridWidth = 0, gridHeight = 0, gridLength = 0, blockCount = 0;
  for (const line of out.split('\n')) {
    if (/Grid:|mask|polygon|resolution|contrast|Roof darken|Wall|Zone |Auto 2x|isolation|isolat|Synthetic|glaz/i.test(line)) {
      console.log(`    ${line.trim()}`);
    }
    // Detect auto-2x resolution bump
    if (/Auto 2x resolution/.test(line)) actualRes = 2;
    // Parse "Grid: 111x63x111 | Blocks: 178,872 | Palette: 23"
    const gridMatch = line.match(/Grid:\s*(\d+)x(\d+)x(\d+)\s*\|\s*Blocks:\s*([\d,]+)/);
    if (gridMatch) {
      gridWidth = parseInt(gridMatch[1], 10);
      gridHeight = parseInt(gridMatch[2], 10);
      gridLength = parseInt(gridMatch[3], 10);
      blockCount = parseInt(gridMatch[4].replace(/,/g, ''), 10);
    }
  }
  console.log(`  Grid: ${gridWidth}×${gridHeight}×${gridLength} (${blockCount} blocks, ${actualRes}x res)`);
  return { schem, actualRes, gridWidth, gridHeight, gridLength, blockCount };
}

/** Render iso + topdown + front elevation + back-left iso JPEGs from schem at high quality */
async function render(b: BuildingConfig, schem: string, actualRes: number): Promise<{ iso: string; topdown: string; front: string; isoBackLeft: string }> {
  const iso = schem.replace('.schem', '-iso.jpg');
  const topdown = schem.replace('.schem', '-topdown.jpg');
  const front = schem.replace('.schem', '-front.jpg');
  const isoBackLeft = schem.replace('.schem', '-iso-bl.jpg');
  // Higher tile/scale for grade composites — quality matters for VLM comparison.
  // At 2x resolution the grid is already large so moderate tile (8) suffices.
  // At 1x resolution, bump higher (10) for sharper texture detail.
  const tile = actualRes >= 2 ? Math.max(b.tileSize, 8) : Math.max(b.tileSize, 10);
  const scale = actualRes >= 2 ? Math.max(b.topdownScale, 10) : Math.max(b.topdownScale, 12);
  console.log(`  Rendering: iso (tile=${tile}) + topdown (scale=${scale}) + front + iso-bl [res=${actualRes}x]`);
  await run(`bun scripts/_render-one.ts "${schem}" "${iso}" --tile ${tile}`);
  await run(`bun scripts/_render-topdown.ts "${schem}" "${topdown}" --scale ${scale}`);
  await run(`bun scripts/_render-front.ts "${schem}" "${front}" --scale ${scale}`);
  await run(`bun scripts/_render-backleft.ts "${schem}" "${isoBackLeft}" --tile ${tile}`);
  return { iso, topdown, front, isoBackLeft };
}

/** Create grade composite: 2×2 grid for identity-aware grading.
 *  TL=satellite, TR=isometric 3D, BL=front elevation, BR=top-down footprint.
 *  Each panel ~480px in a ~990×990 image (fits 1950px constraint). */
async function composite(
  b: BuildingConfig, iso: string, topdown: string, front?: string,
  gridInfo?: { gridWidth: number; gridLength: number; actualRes: number },
  satOverride?: string, // v300: rotated satellite path (default: b.satRef)
): Promise<string> {
  const PANEL = 480;
  const GAP = 15;
  const W = PANEL * 2 + GAP * 3; // ~975px
  const H = PANEL * 2 + GAP * 3;

  // Satellite reference image — use rotated version when available
  const satPath = satOverride && existsSync(satOverride) ? satOverride : b.satRef;
  const hasSat = existsSync(satPath);
  const sat = hasSat
    ? await sharp(resolve(satPath)).resize(PANEL, PANEL, { fit: 'inside' }).toBuffer()
    : await sharp({ create: { width: PANEL, height: PANEL, channels: 3, background: { r: 30, g: 30, b: 30 } } }).jpeg().toBuffer();

  const isoImg = await sharp(resolve(iso)).resize(PANEL, PANEL, { fit: 'inside' }).toBuffer();
  const tdImg = await sharp(resolve(topdown)).resize(PANEL, PANEL, { fit: 'inside' }).toBuffer();

  // Front elevation — use placeholder if not available
  let frontImg: Buffer;
  if (front && existsSync(front)) {
    frontImg = await sharp(resolve(front)).resize(PANEL, PANEL, { fit: 'inside' }).toBuffer();
  } else {
    frontImg = await sharp({ create: { width: PANEL, height: PANEL, channels: 3, background: { r: 30, g: 30, b: 30 } } }).jpeg().toBuffer();
  }

  // 2×2 layout: satellite (TL) | iso (TR) | front (BL) | topdown (BR)
  const buf = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 30, g: 30, b: 30 } },
  })
    .composite([
      { input: sat, left: GAP, top: GAP },
      { input: isoImg, left: GAP + PANEL + GAP, top: GAP },
      { input: frontImg, left: GAP, top: GAP + PANEL + GAP },
      { input: tdImg, left: GAP + PANEL + GAP, top: GAP + PANEL + GAP },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();

  const outPath = `${DIR}/grade-${version}-${b.key}.jpg`;
  await Bun.write(outPath, buf);
  console.log(`  Composite: ${outPath} (${(buf.length / 1024).toFixed(0)}KB, 2x2, panel=${PANEL}px)`);
  return outPath;
}

/**
 * Grade one building using 5 separate images and the binary defect checklist.
 *
 * Images (in order):
 *   1. Satellite reference (rotated, cyan outline)
 *   2. Top-down view
 *   3. Front elevation
 *   4. Isometric front-right
 *   5. Isometric back-left
 *
 * Returns a SubScore computed deterministically from the DefectChecklist,
 * preserving backward compatibility with BuildingResult.subscores storage.
 * A/B/C/D fields are mapped from defect categories for diagnosis().
 */
async function gradeOne(
  images: { satRef: string; topdown: string; front: string; iso: string; isoBackLeft: string },
  buildingKey: string,
): Promise<SubScore | null> {
  // Load all 5 images — missing files fall back gracefully
  function loadImg(p: string): { inlineData: { mimeType: 'image/jpeg'; data: string } } | null {
    if (!existsSync(p)) return null;
    return { inlineData: { mimeType: 'image/jpeg', data: readFileSync(p).toString('base64') } };
  }

  const satPart   = loadImg(images.satRef);
  const tdPart    = loadImg(images.topdown);
  const frontPart = loadImg(images.front);
  const isoPart   = loadImg(images.iso);
  const blPart    = loadImg(images.isoBackLeft);

  // Build parts array: prompt text, then labeled images so VLM knows which is which
  type Part = { text: string } | { inlineData: { mimeType: string; data: string } };
  const parts: Part[] = [{ text: DEFECT_PROMPT }];
  if (satPart)   { parts.push({ text: 'Image 1 — Satellite reference:' }); parts.push(satPart); }
  if (tdPart)    { parts.push({ text: 'Image 2 — Top-down voxel:' }); parts.push(tdPart); }
  if (frontPart) { parts.push({ text: 'Image 3 — Front elevation:' }); parts.push(frontPart); }
  if (isoPart)   { parts.push({ text: 'Image 4 — Isometric front-right:' }); parts.push(isoPart); }
  if (blPart)    { parts.push({ text: 'Image 5 — Isometric back-left:' }); parts.push(blPart); }

  // Retry with exponential backoff for transient errors
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${vlmModel}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            // temp=0.0 for deterministic binary answers; Pro requires ≥16384 output tokens
            generationConfig: { temperature: 0.0, maxOutputTokens: 16384 },
          }),
        },
      );

      if (res.status === 429 || res.status === 503) {
        const wait = (attempt + 1) * 10_000; // 10s, 20s, 30s
        console.error(`    VLM HTTP ${res.status} — retrying in ${wait / 1000}s...`);
        await Bun.sleep(wait);
        continue;
      }

      if (!res.ok) {
        console.error(`    VLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return null;
      }

      const json = await res.json() as { candidates?: Array<{ content: { parts: Array<{ text?: string }> } }> };
      const text = (json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '').trim();

      // Extract JSON object from response — model may wrap it in markdown fences
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error(`    VLM parse failed (no JSON): ${text.slice(0, 300)}`);
        return null;
      }

      let defects: Partial<DefectChecklist>;
      try {
        defects = JSON.parse(jsonMatch[0]) as Partial<DefectChecklist>;
      } catch {
        console.error(`    VLM JSON.parse failed: ${jsonMatch[0].slice(0, 200)}`);
        return null;
      }

      // Normalise: handle string "true"/"false" from some models (Boolean("false")===true, so check explicitly)
      const toBool = (v: unknown): boolean => v === true || v === 'true';
      const checklist: DefectChecklist = {
        height_truncated:          toBool(defects.height_truncated),
        facade_holes_visible:      toBool(defects.facade_holes_visible),
        floating_artifacts:        toBool(defects.floating_artifacts),
        neighbor_buildings_merged: toBool(defects.neighbor_buildings_merged),
        footprint_wrong_shape:     toBool(defects.footprint_wrong_shape),
        false_positives_merged:    toBool(defects.false_positives_merged),
        building_recognizable:     toBool(defects.building_recognizable),
        proportions_correct:       toBool(defects.proportions_correct),
        surface_detail_visible:    toBool(defects.surface_detail_visible),
      };

      const total = scoreFromDefects(checklist);

      // Debug: log which defects were flagged for diagnostic visibility
      const flagged = Object.entries(checklist).filter(([, v]) => {
        // For negative-sense booleans (recognizable/proportions/surface), flag when false
        return v === true;
      }).map(([k]) => k);
      const missing = ['building_recognizable', 'proportions_correct', 'surface_detail_visible']
        .filter(k => !(checklist as Record<string, boolean>)[k]);
      if (flagged.length > 0 || missing.length > 0) {
        console.error(`      Defects: ${[...flagged, ...missing.map(k => `!${k}`)].join(', ')} → ${total}/10`);
      }

      // Map defect fields to legacy A/B/C/D sub-scores for diagnose() and markdown table.
      // NOTE: These are diagnostic-only approximations. `total` from scoreFromDefects() is the authoritative score.
      // A (footprint, 0-3): penalise footprint_wrong_shape + false_positives_merged + neighbor_buildings_merged
      // B (massing, 0-3):   penalise height_truncated + !proportions_correct
      // C (surface, 0-3):   penalise !surface_detail_visible + facade_holes_visible + floating_artifacts
      // D (identity, 0-2):  bonus when building_recognizable
      const scoreA = 3
        - (checklist.footprint_wrong_shape     ? 1 : 0)
        - (checklist.false_positives_merged    ? 1 : 0)
        - (checklist.neighbor_buildings_merged ? 1 : 0);
      const scoreB = 3
        - (checklist.height_truncated      ? 2 : 0)
        - (!checklist.proportions_correct  ? 1 : 0);
      const scoreC = 3
        - (!checklist.surface_detail_visible ? 1 : 0)
        - (checklist.facade_holes_visible    ? 1 : 0)
        - (checklist.floating_artifacts      ? 1 : 0);
      const scoreD = checklist.building_recognizable ? 2 : 0;

      return {
        A: Math.max(0, scoreA),
        B: Math.max(0, scoreB),
        C: Math.max(0, scoreC),
        D: scoreD,
        total,
      };
    } catch (err) {
      const wait = (attempt + 1) * 10_000;
      console.error(`    VLM fetch error (attempt ${attempt + 1}/3): ${err} — retrying in ${wait / 1000}s...`);
      await Bun.sleep(wait);
    }
  }
  console.error(`    VLM: all 3 attempts failed`);
  return null;
}

/** Run N VLM grades, compute trimmed mean (drop min+max, avg rest) */
async function gradeBuilding(
  images: { satRef: string; topdown: string; front: string; iso: string; isoBackLeft: string },
  key: string,
  runs: number,
): Promise<{ scores: number[]; subscores: SubScore[]; trimmedMean: number }> {
  const scores: number[] = [];
  const subscores: SubScore[] = [];

  for (let i = 0; i < runs; i++) {
    const result = await gradeOne(images, key);
    if (result) {
      scores.push(result.total);
      subscores.push(result);
      process.stdout.write(`    Run ${i + 1}/${runs}: ${result.total} (A=${result.A} B=${result.B} C=${result.C} D=${result.D})\n`);
    } else {
      process.stdout.write(`    Run ${i + 1}/${runs}: FAILED\n`);
    }
    // Delay between API calls to avoid rate limiting (Pro model needs more time)
    if (i < runs - 1) await Bun.sleep(5000);
  }

  // Trimmed mean: drop min + max if >= 3 scores, average the rest
  let trimmedMean = 0;
  if (scores.length >= 3) {
    const sorted = [...scores].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1); // drop min and max
    trimmedMean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  } else if (scores.length > 0) {
    trimmedMean = scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  return { scores, subscores, trimmedMean: Math.round(trimmedMean * 10) / 10 };
}

/** Diagnose failure mode from sub-scores */
function diagnose(subscores: SubScore[]): string {
  if (subscores.length === 0) return 'no data';
  // Average each sub-score
  const avgA = subscores.reduce((s, x) => s + x.A, 0) / subscores.length;
  const avgB = subscores.reduce((s, x) => s + x.B, 0) / subscores.length;
  const avgC = subscores.reduce((s, x) => s + x.C, 0) / subscores.length;
  const avgD = subscores.reduce((s, x) => s + x.D, 0) / subscores.length;

  const issues: string[] = [];
  if (avgA < 3) issues.push(`footprint(${avgA.toFixed(1)}/4)`);
  if (avgB < 2) issues.push(`massing(${avgB.toFixed(1)}/3)`);
  if (avgC < 2) issues.push(`surface(${avgC.toFixed(1)}/3)`);
  if (avgD > 0) issues.push(`identity(${avgD.toFixed(1)}/2)`); // Show when identity bonus awarded

  // Check variance
  const totals = subscores.map(s => s.total);
  const range = Math.max(...totals) - Math.min(...totals);
  if (range > 3) issues.push(`high-variance(range=${range})`);

  return issues.length > 0 ? issues.join(', ') : 'passing';
}

const DEEP_REVIEW_PROMPT = `You are a HARSH CRITIC reviewing Minecraft voxel reconstructions.
Look at the 4 panels: satellite (TL), isometric (TR), front elevation (BL), top-down (BR).

Be SKEPTICAL. Score ONLY what you can verify.
- Does the footprint ACTUALLY match the satellite, or is it just "a rectangle like the satellite"?
- Can you identify distinguishing features in BOTH images?
- Are there artifacts, extra geometry, or blobby edges?
- Is the massing (height/width ratio) actually correct, or just plausible?

Score 1-10. Most voxel builds at 1 block/m deserve 5-7. Only exceptional builds get 9-10.

Respond with EXACTLY: Score=X
Then a 1-2 sentence harsh critique.`;

/** Run deep review grading with gemini-2.5-pro (or configured model), return scores */
async function deepReviewBuilding(imagePath: string, key: string, runs: number): Promise<{ scores: number[]; mean: number }> {
  const scores: number[] = [];
  const data = readFileSync(imagePath);

  for (let i = 0; i < runs; i++) {
    try {
      const parts = [
        { text: DEEP_REVIEW_PROMPT },
        { text: `\n--- ${key} ---` },
        { inlineData: { mimeType: 'image/jpeg', data: data.toString('base64') } },
      ];
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${deepReviewModel}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 16384 },
          }),
        },
      );
      if (!res.ok) {
        console.error(`    Deep review HTTP ${res.status}`);
        continue;
      }
      const json = await res.json() as { candidates?: Array<{ content: { parts: Array<{ text?: string }> } }> };
      const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
      const match = text.match(/Score\s*=\s*([\d.]+)/i);
      if (match) {
        const score = parseFloat(match[1]);
        scores.push(score);
        // Extract critique text (everything after "Score=X")
        const critique = text.replace(/Score\s*=\s*[\d.]+/i, '').trim().split('\n')[0];
        process.stdout.write(`    Deep ${i + 1}/${runs}: ${score}/10 — ${critique}\n`);
      } else {
        process.stdout.write(`    Deep ${i + 1}/${runs}: PARSE FAILED — ${text.slice(0, 150)}\n`);
      }
    } catch (err) {
      process.stdout.write(`    Deep ${i + 1}/${runs}: ERROR\n`);
    }
    if (i < runs - 1) await Bun.sleep(1500);
  }

  // Trimmed mean
  let mean = 0;
  if (scores.length >= 3) {
    const sorted = [...scores].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1);
    mean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  } else if (scores.length > 0) {
    mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  return { scores, mean: Math.round(mean * 10) / 10 };
}

// ── Main ──
async function main(): Promise<void> {
  console.log(`\n=== iterate-grade ${version} | ${selectedBuildings.length} buildings | ${vlmRuns} VLM runs | model: ${vlmModel} ===\n`);

  // Load existing state or create new — always preserve existing buildings
  // when doing --only subset or --runs 0 (deep-review-only)
  const statePath = `${DIR}/iterate-state.json`;
  let state: IterateState;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.version = version;
    state.timestamp = new Date().toISOString();
    state.model = vlmModel;
  } else {
    state = {
      version,
      timestamp: new Date().toISOString(),
      target: targetScore,
      passing: 0,
      total: selectedBuildings.length,
      model: vlmModel,
      buildings: {},
    };
  }

  for (const b of selectedBuildings) {
    console.log(`\n── ${b.key.toUpperCase()} (${b.difficulty}) ──`);

    // v300: Compute building alignment first — needed for dynamic satellite zoom + rotation
    const alignment = await computeAlignment(b);
    if (alignment) {
      console.log(`  Alignment: ${alignment.rotationDeg.toFixed(1)}° MBR ${alignment.mbrWidth.toFixed(0)}×${alignment.mbrDepth.toFixed(0)}m`);
    }

    // Ensure satellite references exist (uses alignment for dynamic zoom when satZoom not set)
    await ensureSatRef(b, alignment);

    // Generate rotated satellite for VLM grading (matches voxel orientation)
    let gradeSatPath = b.satRef;
    if (alignment && Math.abs(alignment.rotationDeg) > 2) {
      gradeSatPath = await ensureRotatedSatRef(b, alignment);
    }

    // Validate satellite reference clarity
    const satQuality = await validateSatRef(b);
    if (satQuality < 3) {
      console.log(`  WARNING: Sat ref unclear for ${b.key} (${satQuality}/5) — grades may be unreliable`);
    } else {
      console.log(`  Sat ref quality: ${satQuality}/5`);
    }

    let schem = `${DIR}/${b.key}-${version}.schem`;
    let iso = schem.replace('.schem', '-iso.jpg');
    let topdown = schem.replace('.schem', '-topdown.jpg');
    let front = schem.replace('.schem', '-front.jpg');
    let isoBackLeft = schem.replace('.schem', '-iso-bl.jpg');
    let gradePath = `${DIR}/grade-${version}-${b.key}.jpg`;
    let gridInfo: { gridWidth: number; gridLength: number; actualRes: number } | undefined;

    try {
      if (!gradeOnly) {
        // Step 1: Voxelize — returns grid dimensions for composite scale matching
        const voxResult = await voxelize(b);
        schem = voxResult.schem;
        gridInfo = { gridWidth: voxResult.gridWidth, gridLength: voxResult.gridLength, actualRes: voxResult.actualRes };
        // Step 2: Render at high quality (iso + topdown + front elevation + back-left iso)
        const renders = await render(b, schem, voxResult.actualRes);
        iso = renders.iso;
        topdown = renders.topdown;
        front = renders.front;
        isoBackLeft = renders.isoBackLeft;
        // Step 3: 2×2 composite (satellite, iso, front, topdown) — kept for deep review
        gradePath = await composite(b, iso, topdown, front, gridInfo, gradeSatPath);
      } else if (!existsSync(gradePath)) {
        // grade-only but no composite — try to build from existing renders
        if (existsSync(iso) && existsSync(topdown)) {
          gradePath = await composite(b, iso, topdown, existsSync(front) ? front : undefined, undefined, gradeSatPath);
        } else {
          console.log(`  SKIP: no grade image and no renders found`);
          continue;
        }
      }

      // Step 4: VLM grade (skip if --runs 0 for deep-review-only mode)
      if (vlmRuns === 0 && state.buildings[b.key]) {
        console.log(`  Skipping VLM grading (--runs 0), keeping existing scores`);
        continue;
      }
      console.log(`  Grading with ${vlmModel} (${vlmRuns} runs, temp=0.0)...`);
      // Primary grading uses 5 separate images (defect checklist pipeline)
      const gradeImages = { satRef: gradeSatPath, topdown, front, iso, isoBackLeft };
      const { scores, subscores, trimmedMean } = await gradeBuilding(gradeImages, b.key, vlmRuns);

      // Merge with existing scores if --merge-scores and building already graded
      let allScores = scores;
      let allSubscores = subscores;
      const existing = state.buildings[b.key];
      if (mergeScores && existing && existing.scores.length > 0) {
        allScores = [...existing.scores, ...scores];
        allSubscores = [...existing.subscores, ...subscores];
        console.log(`  Merged: ${existing.scores.length} old + ${scores.length} new = ${allScores.length} total`);
      }

      // Recompute trimmed mean with 20% trim from each end (more robust to outliers)
      let mergedTrimmedMean = 0;
      if (allScores.length >= 5) {
        const sorted = [...allScores].sort((a, b) => a - b);
        const trimCount = Math.max(1, Math.floor(allScores.length * 0.2));
        const trimmed = sorted.slice(trimCount, -trimCount);
        mergedTrimmedMean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
      } else if (allScores.length >= 3) {
        const sorted = [...allScores].sort((a, b) => a - b);
        const trimmed = sorted.slice(1, -1);
        mergedTrimmedMean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
      } else if (allScores.length > 0) {
        mergedTrimmedMean = allScores.reduce((a, b) => a + b, 0) / allScores.length;
      }
      mergedTrimmedMean = Math.round(mergedTrimmedMean * 10) / 10;

      const result: BuildingResult = {
        key: b.key,
        version,
        difficulty: b.difficulty,
        scores: allScores,
        subscores: allSubscores,
        trimmedMean: mergedTrimmedMean,
        diagnosis: diagnose(allSubscores),
        timestamp: new Date().toISOString(),
        satRefQuality: satQuality,
      };

      state.buildings[b.key] = result;

      const status = mergedTrimmedMean >= targetScore ? 'PASS' : 'FAIL';
      const scoreStr = mergeScores && existing?.scores.length ? `[...${existing.scores.length} prev, ${scores.join(', ')}]` : `[${scores.join(', ')}]`;
      console.log(`  → ${b.key}: trimmedMean=${mergedTrimmedMean} (${allScores.length} runs) ${scoreStr} ${status}`);
      if (status === 'FAIL') console.log(`    Diagnosis: ${result.diagnosis}`);

    } catch (err) {
      console.error(`  ERROR: ${b.key}: ${err}`);
      state.buildings[b.key] = {
        key: b.key, version, difficulty: b.difficulty,
        scores: [], subscores: [], trimmedMean: 0,
        diagnosis: `error: ${err}`, timestamp: new Date().toISOString(),
      };
    }
  }

  // Clean up stale state entries for buildings no longer in BUILDINGS config
  const validKeys = new Set(BUILDINGS.map(b => b.key));
  for (const key of Object.keys(state.buildings)) {
    if (!validKeys.has(key)) {
      console.log(`  Removing stale state entry: ${key}`);
      delete state.buildings[key];
    }
  }

  // Deep review pass (if --deep-review flag)
  if (deepReview) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`DEEP REVIEW with ${deepReviewModel} (${deepReviewRuns} runs, temp=0.3)\n`);

    for (const b of selectedBuildings) {
      const gradePath = `${DIR}/grade-${version}-${b.key}.jpg`;
      if (!existsSync(gradePath)) {
        console.log(`  ${b.key}: no grade image, skipping deep review`);
        continue;
      }

      console.log(`  Deep reviewing: ${b.key}...`);
      const { scores: drScores, mean: drMean } = await deepReviewBuilding(gradePath, b.key, deepReviewRuns);

      const entry = state.buildings[b.key];
      if (entry) {
        entry.deepReviewScores = drScores;
        entry.deepReviewMean = drMean;

        // Compare VLM vs deep review
        const gap = Math.abs(entry.trimmedMean - drMean);
        const gapStr = gap > 2 ? ` *** GAP: ${gap.toFixed(1)} ***` : '';
        console.log(`  → ${b.key}: VLM=${entry.trimmedMean} Deep=${drMean}${gapStr}`);
      }
    }

    state.lastDeepReview = new Date().toISOString();
    state.deepReviewModel = deepReviewModel;
  }

  // Sweep mode — auto-try variants for failing buildings
  if (sweepMode) {
    await runSweep(state);
  }

  // Compute passing count
  const allResults = Object.values(state.buildings);
  state.passing = allResults.filter(r => r.trimmedMean >= targetScore).length;
  state.total = BUILDINGS.length; // Always count full set

  // Write JSON state
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`\nState: ${statePath}`);

  // Write markdown summary
  writeMarkdownState(state);

  // Final summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${state.passing}/${state.total} buildings at ${targetScore}+`);
  console.log(`Target: ${targetScore}/10 on 9/${state.total} buildings`);
  const failing = allResults
    .filter(r => r.trimmedMean < targetScore)
    .sort((a, b) => a.trimmedMean - b.trimmedMean);
  if (failing.length > 0) {
    console.log(`\nFailing (${failing.length}):`);
    for (const f of failing) {
      console.log(`  ${f.key}: ${f.trimmedMean} — ${f.diagnosis}`);
    }
  }

  // Deep review summary
  if (deepReview) {
    const reviewed = allResults.filter(r => r.deepReviewMean != null);
    if (reviewed.length > 0) {
      const avgVlm = reviewed.reduce((s, r) => s + r.trimmedMean, 0) / reviewed.length;
      const avgDeep = reviewed.reduce((s, r) => s + (r.deepReviewMean ?? 0), 0) / reviewed.length;
      const gap = Math.abs(avgVlm - avgDeep);
      console.log(`\nDeep review: avg VLM=${avgVlm.toFixed(1)} vs avg Deep=${avgDeep.toFixed(1)} (gap=${gap.toFixed(1)})`);
      if (gap > 2) console.log(`WARNING: VLM scores may be inflated by ~${gap.toFixed(1)} points`);
      const deepPassing = reviewed.filter(r => (r.deepReviewMean ?? 0) >= 8).length;
      console.log(`Deep review passing (>=8): ${deepPassing}/${reviewed.length}`);
    }
  }

  console.log('='.repeat(50));
}

/** Write human-readable markdown state file */
function writeMarkdownState(state: IterateState): void {
  const hasDeep = Object.values(state.buildings).some(r => r.deepReviewMean != null);
  const deepHeader = hasDeep ? ' DeepMean |' : '';
  const deepSep = hasDeep ? '---|' : '';

  const lines: string[] = [
    `# Iterate State — ${state.version}`,
    ``,
    `**Target**: 9/${state.total} buildings at ${state.target}+`,
    `**Current**: ${state.passing}/${state.total} passing`,
    `**Model**: ${state.model} | **Runs/batch**: ${vlmRuns} | **Mode**: ${mergeScores ? 'accumulate' : 'fresh'} (20% trimmed mean)`,
    `**Updated**: ${state.timestamp}`,
  ];

  if (state.lastDeepReview) {
    lines.push(`**Last deep review**: ${state.lastDeepReview} (${state.deepReviewModel ?? 'unknown'})`);
  }

  lines.push(
    ``,
    `| Building | Difficulty | TrimmedMean |${deepHeader} SatRef | Runs | Avg A | Avg B | Avg C | Avg D | Status | Diagnosis |`,
    `|---|---|---|${deepSep}---|---|---|---|---|---|---|`,
  );

  for (const b of BUILDINGS) {
    const r = state.buildings[b.key];
    if (!r) {
      lines.push(`| ${b.key} | ${b.difficulty} | — |${hasDeep ? ' — |' : ''} — | — | — | — | — | — | PENDING | — |`);
      continue;
    }
    const avgA = r.subscores.length > 0
      ? (r.subscores.reduce((s, x) => s + x.A, 0) / r.subscores.length).toFixed(1) : '—';
    const avgB = r.subscores.length > 0
      ? (r.subscores.reduce((s, x) => s + x.B, 0) / r.subscores.length).toFixed(1) : '—';
    const avgC = r.subscores.length > 0
      ? (r.subscores.reduce((s, x) => s + x.C, 0) / r.subscores.length).toFixed(1) : '—';
    const avgD = r.subscores.length > 0
      ? (r.subscores.reduce((s, x) => s + x.D, 0) / r.subscores.length).toFixed(1) : '—';
    const status = r.trimmedMean >= state.target ? 'PASS' : 'FAIL';
    const satQ = r.satRefQuality != null ? `${r.satRefQuality}/5` : '—';
    const deepCol = hasDeep ? ` ${r.deepReviewMean ?? '—'} |` : '';
    lines.push(`| ${r.key} | ${r.difficulty} | ${r.trimmedMean} |${deepCol} ${satQ} | ${r.scores.length} | ${avgA} | ${avgB} | ${avgC} | ${avgD} | ${status} | ${r.diagnosis} |`);
  }

  // VLM vs deep review gap warning
  if (hasDeep) {
    const reviewed = Object.values(state.buildings).filter(r => r.deepReviewMean != null);
    if (reviewed.length > 0) {
      const avgVlm = reviewed.reduce((s, r) => s + r.trimmedMean, 0) / reviewed.length;
      const avgDeep = reviewed.reduce((s, r) => s + (r.deepReviewMean ?? 0), 0) / reviewed.length;
      const gap = Math.abs(avgVlm - avgDeep);
      if (gap > 2) {
        lines.push('', `> **WARNING**: VLM avg ${avgVlm.toFixed(1)} vs deep review avg ${avgDeep.toFixed(1)} (gap: ${gap.toFixed(1)}). Scores may be inflated.`);
      }
    }
  }

  // Action items for failing buildings
  const failing = Object.values(state.buildings).filter(r => r.trimmedMean < state.target);
  if (failing.length > 0) {
    lines.push('', '## Action Items', '');
    for (const f of failing.sort((a, b) => a.trimmedMean - b.trimmedMean)) {
      const avgA = f.subscores.length > 0
        ? f.subscores.reduce((s, x) => s + x.A, 0) / f.subscores.length : 0;
      const avgB = f.subscores.length > 0
        ? f.subscores.reduce((s, x) => s + x.B, 0) / f.subscores.length : 0;
      let action = '';
      if (avgA < 3) action += 'Improve footprint (post-mask, 2x res, tighter dilate). ';
      if (avgB < 2) action += 'Fix massing (check capture height, mode-passes). ';
      if (f.diagnosis.includes('high-variance')) action += 'Stabilize grading (more runs, check sat-ref quality). ';
      if ((f.satRefQuality ?? 5) < 3) action += 'Replace/improve sat ref (obscured). ';
      if (!action) action = 'Fine-tune pipeline params. ';
      lines.push(`- [ ] **${f.key}** (${f.trimmedMean}): ${action.trim()}`);
    }
  }

  writeFileSync('output/iterate-state.md', lines.join('\n') + '\n');
  console.log(`Summary: output/iterate-state.md`);
}

// ── Sweep Mode ──
// When a building fails, automatically try parameter variants, grade each,
// and pick the best configuration.

interface SweepVariant {
  label: string;
  maskDilate?: number;
  resolution?: number;
  extraFlags?: string[];
  tileSize?: number;
}

/** Generate parameter variants for a failing building based on weakest dimension */
function generateSweepVariants(b: BuildingConfig, subscores: SubScore[]): SweepVariant[] {
  const avgA = subscores.length > 0
    ? subscores.reduce((s, x) => s + x.A, 0) / subscores.length : 0;
  const avgC = subscores.length > 0
    ? subscores.reduce((s, x) => s + x.C, 0) / subscores.length : 0;

  const variants: SweepVariant[] = [];

  // Footprint variants (when A < 3)
  if (avgA < 3) {
    // Try different mask dilation values
    for (const d of [0, 1, 2, 3, 4]) {
      if (d !== b.maskDilate) {
        variants.push({ label: `dilate-${d}`, maskDilate: d });
      }
    }
    // Try without OSM mask
    if (!b.extraFlags.includes('--no-osm')) {
      variants.push({ label: 'no-osm', extraFlags: ['--no-osm', '--no-post-mask'] });
    }
    // Try with OSM mask if currently disabled
    if (b.extraFlags.includes('--no-osm')) {
      variants.push({ label: 'with-osm', extraFlags: b.extraFlags.filter(f => f !== '--no-osm' && f !== '--no-post-mask') });
    }
    // Try resolution toggle
    if (b.resolution === 1) {
      variants.push({ label: 'res-2', resolution: 2 });
    } else if (b.resolution === 2) {
      variants.push({ label: 'res-1', resolution: 1 });
    }
  }

  // Surface variants (when C < 2)
  if (avgC < 2) {
    if (!b.extraFlags.includes('--no-glaze')) {
      variants.push({ label: 'no-glaze', extraFlags: [...b.extraFlags, '--no-glaze'] });
    } else {
      variants.push({ label: 'with-glaze', extraFlags: b.extraFlags.filter(f => f !== '--no-glaze') });
    }
  }

  return variants;
}

/** Run sweep mode for failing buildings — try variants, grade, pick best */
async function sweepBuilding(
  b: BuildingConfig,
  existingResult: BuildingResult,
): Promise<{ bestVariant: SweepVariant | null; bestScore: number }> {
  const variants = generateSweepVariants(b, existingResult.subscores);
  if (variants.length === 0) {
    console.log(`  No sweep variants to try for ${b.key}`);
    return { bestVariant: null, bestScore: existingResult.trimmedMean };
  }

  console.log(`  Sweeping ${variants.length} variants for ${b.key} (baseline: ${existingResult.trimmedMean})...`);

  let bestVariant: SweepVariant | null = null;
  let bestScore = existingResult.trimmedMean;

  for (const variant of variants) {
    console.log(`    Variant: ${variant.label}`);

    // Build modified config
    const modConfig: BuildingConfig = {
      ...b,
      maskDilate: variant.maskDilate ?? b.maskDilate,
      resolution: variant.resolution ?? b.resolution,
      extraFlags: variant.extraFlags ?? b.extraFlags,
      tileSize: variant.tileSize ?? b.tileSize,
    };

    try {
      // Voxelize with variant params
      const vSuffix = `${version}-sweep-${variant.label}`;
      const schem = `${DIR}/${b.key}-${vSuffix}.schem`;
      const flagParts = [
        'bun scripts/voxelize-glb.ts', `"${modConfig.glb}"`, '--auto',
        '--coords', `"${modConfig.coords}"`,
        '--mask-dilate', String(modConfig.maskDilate),
        '--gamma', '0.4', // v300: stronger gamma for raw CIELAB
      ];
      if (sceneMode) flagParts.push('--scene');
      if (modConfig.resolution > 0) flagParts.push('-r', String(modConfig.resolution));
      flagParts.push('-o', `"${schem}"`, ...modConfig.extraFlags);

      await run(flagParts.join(' '), 600_000);

      // Render
      const iso = schem.replace('.schem', '-iso.jpg');
      const topdown = schem.replace('.schem', '-topdown.jpg');
      const frontElev = schem.replace('.schem', '-front.jpg');
      const isoBlSweep = schem.replace('.schem', '-iso-bl.jpg');
      const actualRes = modConfig.resolution > 0 ? modConfig.resolution : 1;
      const tile = actualRes >= 2 ? modConfig.tileSize : Math.max(modConfig.tileSize, 6);
      const scale = actualRes >= 2 ? modConfig.topdownScale : Math.max(modConfig.topdownScale, 8);
      await run(`bun scripts/_render-one.ts "${schem}" "${iso}" --tile ${tile}`);
      await run(`bun scripts/_render-topdown.ts "${schem}" "${topdown}" --scale ${scale}`);
      await run(`bun scripts/_render-front.ts "${schem}" "${frontElev}" --scale ${scale}`);
      await run(`bun scripts/_render-backleft.ts "${schem}" "${isoBlSweep}" --tile ${tile}`);

      // Composite (2×2: satellite, iso, front, topdown) — kept for deep review
      await composite(modConfig, iso, topdown, frontElev);

      // Quick grade with 5 separate images (defect checklist pipeline)
      const sweepGradeImages = { satRef: modConfig.satRef, topdown, front: frontElev, iso, isoBackLeft: isoBlSweep };
      const { trimmedMean } = await gradeBuilding(sweepGradeImages, b.key, sweepRuns);
      console.log(`    → ${variant.label}: ${trimmedMean} (${sweepRuns} quick runs)`);

      if (trimmedMean > bestScore) {
        bestScore = trimmedMean;
        bestVariant = variant;
      }
    } catch (err) {
      console.log(`    → ${variant.label}: ERROR — ${err}`);
    }
  }

  if (bestVariant) {
    console.log(`  Best variant: ${bestVariant.label} (${bestScore} vs baseline ${existingResult.trimmedMean})`);
    // Report winning config changes
    if (bestVariant.maskDilate != null) console.log(`    → maskDilate: ${b.maskDilate} → ${bestVariant.maskDilate}`);
    if (bestVariant.resolution != null) console.log(`    → resolution: ${b.resolution} → ${bestVariant.resolution}`);
    if (bestVariant.extraFlags != null) console.log(`    → extraFlags: [${bestVariant.extraFlags.join(', ')}]`);
  } else {
    console.log(`  No variant beat baseline (${existingResult.trimmedMean})`);
  }

  return { bestVariant, bestScore };
}

// ── Sweep after main grading ──
async function runSweep(state: IterateState): Promise<void> {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`SWEEP MODE: auto-trying parameter variants for failing buildings\n`);

  const failing = selectedBuildings.filter(b => {
    const r = state.buildings[b.key];
    return r && r.trimmedMean < targetScore;
  });

  if (failing.length === 0) {
    console.log('  No failing buildings to sweep!');
    return;
  }

  for (const b of failing) {
    const result = state.buildings[b.key];
    if (!result) continue;

    console.log(`\n── SWEEP: ${b.key.toUpperCase()} (current: ${result.trimmedMean}) ──`);
    const { bestVariant, bestScore } = await sweepBuilding(b, result);

    if (bestVariant && bestScore > result.trimmedMean) {
      // Run full grading on best variant to confirm (using 5 separate images)
      console.log(`  Confirming best variant with ${vlmRuns} full runs...`);
      const vSuffix = `${version}-sweep-${bestVariant.label}`;
      const confirmSchem = `${DIR}/${b.key}-${vSuffix}.schem`;
      const confirmImages = {
        satRef: b.satRef,
        topdown: confirmSchem.replace('.schem', '-topdown.jpg'),
        front:   confirmSchem.replace('.schem', '-front.jpg'),
        iso:     confirmSchem.replace('.schem', '-iso.jpg'),
        isoBackLeft: confirmSchem.replace('.schem', '-iso-bl.jpg'),
      };
      if (existsSync(confirmImages.iso)) {
        const { scores, subscores, trimmedMean } = await gradeBuilding(confirmImages, b.key, vlmRuns);
        console.log(`  Confirmed: ${trimmedMean} (was ${result.trimmedMean})`);

        // Update state with confirmed result
        state.buildings[b.key] = {
          ...result,
          scores,
          subscores,
          trimmedMean,
          diagnosis: diagnose(subscores),
          timestamp: new Date().toISOString(),
        };
      }
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
