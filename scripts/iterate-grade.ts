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
 *   bun scripts/iterate-grade.ts --model gemini-2.5-flash  # VLM model override
 *   bun scripts/iterate-grade.ts --deep-review          # run harsh critic pass with pro model
 *   bun scripts/iterate-grade.ts --deep-model gemini-2.5-pro  # deep review model (default)
 *   bun scripts/iterate-grade.ts --deep-runs 3          # deep review runs per building (default 3)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, basename } from 'path';
import { $ } from 'bun';
import sharp from 'sharp';

// ── Building configs ──
interface BuildingConfig {
  key: string;
  glb: string;
  coords: string;         // "lat,lng" for OSM mask
  satRef: string;
  satZoom: number;        // Google Static Maps satellite zoom (19=commercial, 20=residential, 21=tiny)
  resolution: number;     // 1 or 2
  maskDilate: number;     // 0-3
  extraFlags: string[];   // additional voxelize flags
  difficulty: 'easy' | 'medium' | 'hard';
  tileSize: number;       // iso render tile size
  topdownScale: number;   // topdown render scale
}

const DIR = 'output/tiles';

const BUILDINGS: BuildingConfig[] = [
  {
    // Iconic triangular wedge building — v80c: 10/10, proven winner
    key: 'flatiron',
    glb: `${DIR}/tiles-flatiron-building-new-york-ny.glb`,
    coords: '40.7411,-73.9897',
    satRef: `${DIR}/sat-ref-flatiron.jpg`,
    satZoom: 19,
    resolution: 2,
    maskDilate: 1,
    extraFlags: [],
    difficulty: 'easy',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    // Sentinel/Columbus Tower, SF — wedge-shaped copper building, 2.0MB browser capture
    key: 'sentinel',
    glb: `${DIR}/tiles-sentinel-building-san-francisco-ca.glb`,
    coords: '37.7858,-122.4063',
    satRef: `${DIR}/sat-ref-sentinel.jpg`,
    satZoom: 20,
    resolution: 2,
    maskDilate: 1,
    extraFlags: [],
    difficulty: 'medium',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    // Scottsdale Fashion Square area — 1.4MB headless, was 9.8 in v93
    key: 'scottsdale',
    glb: `${DIR}/tiles-scottsdale-headless.glb`,
    coords: '33.4877,-111.926',
    satRef: `${DIR}/sat-ref-scottsdale.jpg`,
    satZoom: 20,
    resolution: 1,
    maskDilate: 2,
    extraFlags: ['--no-osm', '--no-post-mask'],
    difficulty: 'medium',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    // Compound building — v80c: 6.3 (partial capture, only one edge)
    key: 'francisco',
    glb: `${DIR}/tiles-2340-francisco-st-san-francisco-ca-94123.glb`,
    coords: '37.8005,-122.4384',
    satRef: `${DIR}/sat-ref-francisco.jpg`,
    satZoom: 20,
    resolution: 2,
    maskDilate: 2,
    extraFlags: [],
    difficulty: 'hard',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    // Commercial flat-roof — Portland, OR, 4.5MB headless capture
    key: 'portland',
    glb: `${DIR}/flatroof-portland.glb`,
    coords: '45.5235,-122.6812',
    satRef: `${DIR}/sat-ref-portland.jpg`,
    satZoom: 20,
    resolution: 1,
    maskDilate: 2,
    extraFlags: [],
    difficulty: 'medium',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    // 2800 Post Oak Blvd, Houston TX — Galleria area commercial, 4.3MB headless
    key: 'houston',
    glb: `${DIR}/flatroof-houston.glb`,
    coords: '29.7378,-95.4608',
    satRef: `${DIR}/sat-ref-houston.jpg`,
    satZoom: 20,
    resolution: 1,
    maskDilate: 2,
    extraFlags: [],
    difficulty: 'medium',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    // 191 Peachtree St NE, Atlanta GA — commercial, 7.2MB headless
    key: 'atlanta',
    glb: `${DIR}/flatroof-atlanta.glb`,
    coords: '33.7590,-84.3869',
    satRef: `${DIR}/sat-ref-atlanta.jpg`,
    satZoom: 20,
    resolution: 1,
    maskDilate: 2,
    extraFlags: [],
    difficulty: 'medium',
    tileSize: 6,
    topdownScale: 8,
  },
  {
    // 402 W Broadway, San Diego CA — downtown commercial, 6.4MB headless
    key: 'sandiego',
    glb: `${DIR}/flatroof-sandiego.glb`,
    coords: '32.7157,-117.1611',
    satRef: `${DIR}/sat-ref-sandiego.jpg`,
    satZoom: 20,
    resolution: 1,
    maskDilate: 2,
    extraFlags: ['--no-osm', '--no-post-mask'],
    difficulty: 'medium',
    tileSize: 6,
    topdownScale: 8,
  },
  {
    // Arlington VA area — 2.5MB headless capture
    key: 'arlington',
    glb: `${DIR}/tiles-arlington-headless.glb`,
    coords: '38.8824,-77.1085',
    satRef: `${DIR}/sat-ref-arlington.jpg`,
    satZoom: 20,
    resolution: 1,
    maskDilate: 2,
    extraFlags: [],
    difficulty: 'medium',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    // Nashville TN — 3.1MB headless capture, commercial building
    key: 'nashville',
    glb: `${DIR}/flatroof-nashville.glb`,
    coords: '36.1656,-86.7770',
    satRef: `${DIR}/sat-ref-nashville.jpg`,
    satZoom: 20,
    resolution: 1,
    maskDilate: 2,
    extraFlags: [],
    difficulty: 'medium',
    tileSize: 4,
    topdownScale: 6,
  },
];

// ── VLM Grading ──
interface SubScore { A: number; B: number; C: number; total: number }
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

const STRUCTURED_PROMPT = `You are a STRICT grader of Minecraft voxel reconstructions of real buildings.

Each image has 3 panels: LEFT = satellite photo, CENTER = isometric 3D render, RIGHT = top-down footprint.

Score each building on this rubric:

A) Footprint accuracy (0-4):
- 4: Footprint has DISTINCTIVE features (non-rectangular angles, L-shapes, curves, setbacks) that are clearly preserved in the voxel AND match satellite. Would be recognized as this specific building.
- 3: Footprint shape is correct (right aspect ratio, correct corners) and clearly isolated from surrounding geometry. Rectangular buildings need accurate length:width ratio.
- 2: Generally correct shape but edges are rough/blobby, or includes significant surrounding geometry, or proportions are approximate.
- 1: Vaguely building-shaped but doesn't clearly match the satellite footprint.
- 0: Unrecognizable or amorphous blob.

B) Massing accuracy (0-3):
- 3: Height and volume clearly match what's visible in satellite (shadow length, relative scale to neighbors). Correct floor count.
- 2: Approximately correct proportions.
- 1: Wrong proportions or can't verify against satellite.
- 0: Completely wrong volume.

C) Surface quality (0-3):
- 3: 3+ distinct material zones visible (roof/wall/ground/windows). Clean edges. Glass window blocks (darker rectangles on facades) count as a valid zone.
- 2: Some material distinction, minor noise.
- 1: Mostly monochrome with no zone distinction.
- 0: Single material, messy, heavy artifacts.

Total = A + B + C (max 10).

IMPORTANT: Score what you actually SEE, not what might be there.
- If the satellite image is obscured (trees, shadows, low zoom), cap A at 2 and B at 1.
- If the voxel includes multiple buildings or large surrounding terrain, cap A at 3.
- If edges are blobby/amorphous (no straight lines or clear corners), cap A at 2.
- Dark/tinted glass blocks on facades are WINDOWS (intentional), not artifacts. Do NOT penalize window glass for C score.

Calibration anchors:
- 10/10: The voxel is immediately recognizable as THIS SPECIFIC building. Someone who knows the building would identify it from the voxel alone. Distinctive features perfectly preserved.
- 9/10: Footprint precisely matches satellite with all major features (corners, angles, setbacks). Massing is proportionate. 3+ clean material zones. A human would say "yes, that's the building."
- 7/10: Correct general shape with right proportions. Clean rectangular buildings with matching aspect ratio. Some material distinction.
- 5/10: Recognizable as A building but not clearly THIS building. Approximate shape, rough edges.
- 2/10: Blob, artifacts, or shape doesn't correspond to satellite.

For EACH building image, respond with EXACTLY this format (one line per building):
NAME: A=X B=X C=X Total=X.X
Brief 1-line explanation.

Be harsh and honest. Most voxel builds at 1 block/m deserve 5-7. Only exceptional builds with distinctive, recognizable features get 9-10.`;

// ── CLI parsing ──
const args = process.argv.slice(2);
function getFlag(name: string, def: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
}
function hasFlag(name: string): boolean { return args.includes(name); }

const version = getFlag('--version', 'v80');
const vlmModel = getFlag('--model', 'gemini-2.5-flash');
const vlmRuns = parseInt(getFlag('--runs', '11'), 10);
const gradeOnly = hasFlag('--grade-only');
const mergeScores = hasFlag('--merge-scores');
const deepReview = hasFlag('--deep-review');
const deepReviewModel = getFlag('--deep-model', 'gemini-2.5-pro');
const deepReviewRuns = parseInt(getFlag('--deep-runs', '3'), 10);
const sweepMode = hasFlag('--sweep');
const sweepRuns = parseInt(getFlag('--sweep-runs', '3'), 10); // quick-grade runs per variant
const onlyKeys = getFlag('--only', '').split(',').filter(Boolean);
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

/** Fetch satellite reference image for a building if missing or --refresh-sat flag */
async function ensureSatRef(b: BuildingConfig): Promise<void> {
  const refreshSat = hasFlag('--refresh-sat');
  if (!refreshSat && existsSync(b.satRef)) return;
  const [lat, lng] = b.coords.split(',');
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${b.satZoom}&size=640x640&maptype=satellite&key=${mapsKey}`;
  console.log(`  Fetching satellite ref for ${b.key} (z${b.satZoom})...`);
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`  Failed to fetch satellite for ${b.key}: ${resp.status}`);
    return;
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  await Bun.write(b.satRef, buf);
  console.log(`  Saved: ${b.satRef} (${(buf.length / 1024).toFixed(0)}KB)`);
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

/** Voxelize a building: glb → schem */
async function voxelize(b: BuildingConfig): Promise<string> {
  const schem = `${DIR}/${b.key}-${version}.schem`;
  const flagParts = [
    'bun scripts/voxelize-glb.ts', `"${b.glb}"`, '--auto',
    '--coords', `"${b.coords}"`,
    '--mask-dilate', String(b.maskDilate),
  ];
  // Only pass -r when explicitly set (resolution > 0); otherwise let auto-2x decide
  if (b.resolution > 0) flagParts.push('-r', String(b.resolution));
  flagParts.push('-o', `"${schem}"`, ...b.extraFlags);
  const flags = flagParts.join(' ');
  console.log(`  Voxelizing: ${b.key} (r=${b.resolution > 0 ? b.resolution : 'auto'}, dilate=${b.maskDilate})`);
  const out = await run(flags, 600_000);
  // Detect actual resolution used (for render tile size adjustment)
  let actualRes = b.resolution > 0 ? b.resolution : 1;
  for (const line of out.split('\n')) {
    if (/Grid:|mask|polygon|resolution|contrast|Roof darken|Wall|Zone |Auto 2x|isolation|isolat|Synthetic|glaz/i.test(line)) {
      console.log(`    ${line.trim()}`);
    }
    // Detect auto-2x resolution bump
    if (/Auto 2x resolution/.test(line)) actualRes = 2;
  }
  return { schem, actualRes };
}

/** Render iso + topdown JPEGs from schem */
async function render(b: BuildingConfig, schem: string, actualRes: number): Promise<{ iso: string; topdown: string }> {
  const iso = schem.replace('.schem', '-iso.jpg');
  const topdown = schem.replace('.schem', '-topdown.jpg');
  // At 1x resolution, bump tile to 6 for more texture detail; at 2x, keep configured
  // size since the grid is already 2x larger (forcing tile=6 makes small buildings tiny).
  const tile = actualRes >= 2 ? b.tileSize : Math.max(b.tileSize, 6);
  const scale = actualRes >= 2 ? b.topdownScale : Math.max(b.topdownScale, 8);
  console.log(`  Rendering: iso (tile=${tile}) + topdown (scale=${scale}) [res=${actualRes}x]`);
  await run(`bun scripts/_render-one.ts "${schem}" "${iso}" --tile ${tile}`);
  await run(`bun scripts/_render-topdown.ts "${schem}" "${topdown}" --scale ${scale}`);
  return { iso, topdown };
}

/** Create grade composite: satellite | iso | topdown */
async function composite(b: BuildingConfig, iso: string, topdown: string): Promise<string> {
  const PANEL = 500;
  const GAP = 20;
  const W = PANEL * 3 + GAP * 4;

  // Satellite ref (use black placeholder if missing)
  const hasSat = existsSync(b.satRef);
  const sat = hasSat
    ? await sharp(resolve(b.satRef)).resize(PANEL, PANEL, { fit: 'inside' }).toBuffer()
    : await sharp({ create: { width: PANEL, height: PANEL, channels: 3, background: { r: 30, g: 30, b: 30 } } }).jpeg().toBuffer();
  const isoImg = await sharp(resolve(iso)).resize(PANEL, PANEL, { fit: 'inside' }).toBuffer();
  const tdImg = await sharp(resolve(topdown)).resize(PANEL, PANEL, { fit: 'inside' }).toBuffer();

  const satMeta = await sharp(sat).metadata();
  const isoMeta = await sharp(isoImg).metadata();
  const tdMeta = await sharp(tdImg).metadata();
  const maxH = Math.max(satMeta.height!, isoMeta.height!, tdMeta.height!);

  const buf = await sharp({
    create: { width: W, height: maxH + GAP * 2, channels: 3, background: { r: 30, g: 30, b: 30 } },
  })
    .composite([
      { input: sat, left: GAP, top: GAP },
      { input: isoImg, left: GAP + PANEL + GAP, top: GAP },
      { input: tdImg, left: GAP + (PANEL + GAP) * 2, top: GAP },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();

  const outPath = `${DIR}/grade-${version}-${b.key}.jpg`;
  await Bun.write(outPath, buf);
  console.log(`  Composite: ${outPath} (${(buf.length / 1024).toFixed(0)}KB)`);
  return outPath;
}

/** Grade one building image with VLM, return parsed sub-scores */
async function gradeOne(imagePath: string, buildingKey: string): Promise<SubScore | null> {
  const data = readFileSync(imagePath);
  const parts = [
    { text: STRUCTURED_PROMPT },
    { text: `\n--- ${buildingKey} ---` },
    { inlineData: { mimeType: 'image/jpeg', data: data.toString('base64') } },
  ];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${vlmModel}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
      }),
    },
  );

  if (!res.ok) {
    console.error(`    VLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }

  const json = await res.json() as { candidates?: Array<{ content: { parts: Array<{ text?: string }> } }> };
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';

  // Parse "A=X B=X C=X Total=X.X" from response
  const match = text.match(/A\s*=\s*([\d.]+)\s*B\s*=\s*([\d.]+)\s*C\s*=\s*([\d.]+)\s*Total\s*=\s*([\d.]+)/i);
  if (match) {
    return {
      A: parseFloat(match[1]),
      B: parseFloat(match[2]),
      C: parseFloat(match[3]),
      total: parseFloat(match[4]),
    };
  }

  // Fallback: try to parse just "Total=X" or "Score=X"
  const totalMatch = text.match(/(?:Total|Score)\s*=\s*([\d.]+)/i);
  if (totalMatch) {
    const total = parseFloat(totalMatch[1]);
    return { A: 0, B: 0, C: 0, total };
  }

  console.error(`    VLM parse failed: ${text.slice(0, 200)}`);
  return null;
}

/** Run N VLM grades, compute trimmed mean (drop min+max, avg rest) */
async function gradeBuilding(imagePath: string, key: string, runs: number): Promise<{ scores: number[]; subscores: SubScore[]; trimmedMean: number }> {
  const scores: number[] = [];
  const subscores: SubScore[] = [];

  for (let i = 0; i < runs; i++) {
    const result = await gradeOne(imagePath, key);
    if (result) {
      scores.push(result.total);
      subscores.push(result);
      process.stdout.write(`    Run ${i + 1}/${runs}: ${result.total} (A=${result.A} B=${result.B} C=${result.C})\n`);
    } else {
      process.stdout.write(`    Run ${i + 1}/${runs}: FAILED\n`);
    }
    // Small delay between API calls to avoid rate limiting
    if (i < runs - 1) await Bun.sleep(1000);
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

  const issues: string[] = [];
  if (avgA < 3) issues.push(`footprint(${avgA.toFixed(1)}/4)`);
  if (avgB < 2) issues.push(`massing(${avgB.toFixed(1)}/3)`);
  if (avgC < 2) issues.push(`surface(${avgC.toFixed(1)}/3)`);

  // Check variance
  const totals = subscores.map(s => s.total);
  const range = Math.max(...totals) - Math.min(...totals);
  if (range > 3) issues.push(`high-variance(range=${range})`);

  return issues.length > 0 ? issues.join(', ') : 'passing';
}

const DEEP_REVIEW_PROMPT = `You are a HARSH CRITIC reviewing Minecraft voxel reconstructions.
Look at the 3 panels: satellite (left), isometric voxel (center), top-down footprint (right).

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
            generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
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

    // Ensure satellite reference exists (fetch if missing or --refresh-sat)
    await ensureSatRef(b);

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
    let gradePath = `${DIR}/grade-${version}-${b.key}.jpg`;

    try {
      if (!gradeOnly) {
        // Step 1: Voxelize
        const voxResult = await voxelize(b);
        schem = voxResult.schem;
        // Step 2: Render (pass actual resolution for tile size adjustment)
        const renders = await render(b, schem, voxResult.actualRes);
        iso = renders.iso;
        topdown = renders.topdown;
        // Step 3: Composite
        gradePath = await composite(b, iso, topdown);
      } else if (!existsSync(gradePath)) {
        // grade-only but no composite — try to build from existing renders
        if (existsSync(iso) && existsSync(topdown)) {
          gradePath = await composite(b, iso, topdown);
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
      console.log(`  Grading with ${vlmModel} (${vlmRuns} runs, temp=0.1)...`);
      const { scores, subscores, trimmedMean } = await gradeBuilding(gradePath, b.key, vlmRuns);

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
    `| Building | Difficulty | TrimmedMean |${deepHeader} SatRef | Runs | Avg A | Avg B | Avg C | Status | Diagnosis |`,
    `|---|---|---|${deepSep}---|---|---|---|---|---|`,
  );

  for (const b of BUILDINGS) {
    const r = state.buildings[b.key];
    if (!r) {
      lines.push(`| ${b.key} | ${b.difficulty} | — |${hasDeep ? ' — |' : ''} — | — | — | — | — | PENDING | — |`);
      continue;
    }
    const avgA = r.subscores.length > 0
      ? (r.subscores.reduce((s, x) => s + x.A, 0) / r.subscores.length).toFixed(1) : '—';
    const avgB = r.subscores.length > 0
      ? (r.subscores.reduce((s, x) => s + x.B, 0) / r.subscores.length).toFixed(1) : '—';
    const avgC = r.subscores.length > 0
      ? (r.subscores.reduce((s, x) => s + x.C, 0) / r.subscores.length).toFixed(1) : '—';
    const status = r.trimmedMean >= state.target ? 'PASS' : 'FAIL';
    const satQ = r.satRefQuality != null ? `${r.satRefQuality}/5` : '—';
    const deepCol = hasDeep ? ` ${r.deepReviewMean ?? '—'} |` : '';
    lines.push(`| ${r.key} | ${r.difficulty} | ${r.trimmedMean} |${deepCol} ${satQ} | ${r.scores.length} | ${avgA} | ${avgB} | ${avgC} | ${status} | ${r.diagnosis} |`);
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
      ];
      if (modConfig.resolution > 0) flagParts.push('-r', String(modConfig.resolution));
      flagParts.push('-o', `"${schem}"`, ...modConfig.extraFlags);

      await run(flagParts.join(' '), 600_000);

      // Render
      const iso = schem.replace('.schem', '-iso.jpg');
      const topdown = schem.replace('.schem', '-topdown.jpg');
      const actualRes = modConfig.resolution > 0 ? modConfig.resolution : 1;
      const tile = actualRes >= 2 ? modConfig.tileSize : Math.max(modConfig.tileSize, 6);
      const scale = actualRes >= 2 ? modConfig.topdownScale : Math.max(modConfig.topdownScale, 8);
      await run(`bun scripts/_render-one.ts "${schem}" "${iso}" --tile ${tile}`);
      await run(`bun scripts/_render-topdown.ts "${schem}" "${topdown}" --scale ${scale}`);

      // Composite
      const gradePath = await composite(modConfig, iso, topdown);

      // Quick grade (fewer runs for speed)
      const { trimmedMean } = await gradeBuilding(gradePath, b.key, sweepRuns);
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
      // Run full grading on best variant to confirm
      console.log(`  Confirming best variant with ${vlmRuns} full runs...`);
      const vSuffix = `${version}-sweep-${bestVariant.label}`;
      const gradePath = `${DIR}/grade-${vSuffix}-${b.key}.jpg`;
      if (existsSync(gradePath)) {
        const { scores, subscores, trimmedMean } = await gradeBuilding(gradePath, b.key, vlmRuns);
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
