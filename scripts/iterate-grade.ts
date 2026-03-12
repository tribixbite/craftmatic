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
 *   bun scripts/iterate-grade.ts --runs 3               # VLM runs per building (default 5)
 *   bun scripts/iterate-grade.ts --model gemini-2.5-flash  # VLM model override
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
    key: 'flatiron',
    glb: `${DIR}/tiles-flatiron-building-new-york-ny.glb`,
    coords: '40.7411,-73.9897',
    satRef: `${DIR}/sat-ref-flatiron.jpg`,
    resolution: 2,
    maskDilate: 1,
    extraFlags: [],
    difficulty: 'easy',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    key: 'beach',
    glb: `${DIR}/tiles-2130-beach-st-san-francisco-ca.glb`,
    coords: '37.8004,-122.4365', // v70/v71 verified coords (v77/v78 coords were wrong)
    satRef: `${DIR}/sat-ref-beach.jpg`,
    resolution: 2, // force 2x for better footprint accuracy
    maskDilate: 2,
    extraFlags: [],
    difficulty: 'easy',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    key: 'chestnut',
    glb: `${DIR}/tiles-2001-chestnut-st-san-francisco-ca.glb`,
    coords: '37.8003,-122.4337',
    satRef: `${DIR}/sat-ref-chestnut.jpg`,
    resolution: 2, // force 2x for better footprint accuracy
    maskDilate: 2,
    extraFlags: [],
    difficulty: 'medium',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    key: 'francisco',
    glb: `${DIR}/tiles-2340-francisco-st-san-francisco-ca.glb`,
    coords: '37.8005,-122.4384',
    satRef: `${DIR}/sat-ref-francisco.jpg`,
    resolution: 2, // force 2x for better footprint accuracy
    maskDilate: 2,
    extraFlags: [],
    difficulty: 'hard',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    key: 'baker',
    glb: `${DIR}/tiles-3170-baker-st-san-francisco-ca.glb`,
    coords: '37.7930,-122.4430',
    satRef: `${DIR}/sat-ref-baker.jpg`,
    resolution: 2, // force 2x for better footprint accuracy
    maskDilate: 2,
    extraFlags: [],
    difficulty: 'medium',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    key: 'noe',
    glb: `${DIR}/tiles-450-noe-st-san-francisco-ca.glb`,
    coords: '37.7604,-122.4314',
    satRef: `${DIR}/sat-ref-noe.jpg`,
    resolution: 1, // iterate-grade will auto-bump to 2x if mesh < 25m
    maskDilate: 1,
    extraFlags: [],
    difficulty: 'hard',
    tileSize: 8,
    topdownScale: 12,
  },
  {
    key: 'green',
    glb: `${DIR}/tiles-2390-green-st-san-francisco-ca.glb`,
    coords: '37.7972,-122.4378',
    satRef: `${DIR}/sat-ref-green.jpg`,
    resolution: 2, // force 2x for better footprint accuracy
    maskDilate: 2,
    extraFlags: [],
    difficulty: 'hard',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    key: 'charleston',
    glb: `${DIR}/tiles-41-legare-st-charleston-sc-29401.glb`,
    coords: '32.7714,-79.9326',
    satRef: `${DIR}/sat-ref-charleston.jpg`,
    resolution: 2, // force 2x for better footprint accuracy
    maskDilate: 2,
    extraFlags: [],
    difficulty: 'hard',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    key: 'seattle',
    glb: `${DIR}/tiles-4810-sw-ledroit-pl-seattle-wa-98136.glb`,
    coords: '47.5415,-122.3850',
    satRef: `${DIR}/sat-ref-seattle.jpg`,
    resolution: 2, // force 2x for better footprint accuracy
    maskDilate: 2,
    extraFlags: [],
    difficulty: 'medium',
    tileSize: 4,
    topdownScale: 6,
  },
  {
    key: 'sanjose',
    glb: `${DIR}/tiles-525-s-winchester-blvd-san-jose-ca-95128.glb`,
    coords: '37.3122,-121.9452',
    satRef: `${DIR}/sat-ref-sanjose.jpg`,
    resolution: 2, // force 2x for better footprint accuracy
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
}

interface IterateState {
  version: string;
  timestamp: string;
  target: number;
  passing: number;
  total: number;
  model: string;
  buildings: Record<string, BuildingResult>;
}

const STRUCTURED_PROMPT = `You are grading Minecraft voxel reconstructions of real buildings.

Each image has 3 panels: LEFT = satellite photo, CENTER = isometric 3D render, RIGHT = top-down footprint.

Score each building on this rubric:
A) Footprint accuracy (0-4): Does the top-down footprint match the satellite building shape? Sharp edges, correct proportions, identifiable outline.
B) Massing accuracy (0-3): Do proportions/height/volume look correct? Right number of floors, correct width-to-height ratio.
C) Surface quality (0-3): Are there distinct material zones (roof/wall/ground)? Clean edges? Visible texture contrast?

Total = A + B + C (max 10).

Calibration anchors:
- A perfect 10/10: footprint exactly matches satellite (triangle/L/rectangle clearly visible), correct height and proportions, 3+ distinct material zones with clean separation.
- A mediocre 5/10: vaguely correct shape but wrong proportions or rounded where should be angular, 1-2 materials only, ragged or blobby edges.
- A poor 2/10: shape unrecognizable, wrong proportions entirely, single material, messy.

For EACH building image, respond with EXACTLY this format (one line per building):
NAME: A=X B=X C=X Total=X.X
Brief 1-line explanation.

Be strict but fair. A perfect Minecraft build at 1 block/meter cannot have pixel-level detail. Score the quality relative to what's achievable in Minecraft at this resolution.`;

// ── CLI parsing ──
const args = process.argv.slice(2);
function getFlag(name: string, def: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
}
function hasFlag(name: string): boolean { return args.includes(name); }

const version = getFlag('--version', 'v80');
const vlmModel = getFlag('--model', 'gemini-2.5-flash');
const vlmRuns = parseInt(getFlag('--runs', '5'), 10);
const gradeOnly = hasFlag('--grade-only');
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

// ── API key ──
const apiKey = process.env.GOOGLE_API_KEY
  || (existsSync('.env') ? readFileSync('.env', 'utf8').match(/GOOGLE_API_KEY=(.+)/)?.[1]?.trim() : undefined);
if (!apiKey) { console.error('No GOOGLE_API_KEY'); process.exit(1); }

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
    if (/Grid:|mask|polygon|resolution|contrast|Roof darken|Wall|Zone |Auto 2x/i.test(line)) {
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
  // At 2x resolution, use smaller tile size (more blocks per pixel) to fit in frame
  const tile = actualRes >= 2 ? Math.max(2, Math.floor(b.tileSize / 2)) : b.tileSize;
  const scale = actualRes >= 2 ? Math.max(4, Math.floor(b.topdownScale / 2)) : b.topdownScale;
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

// ── Main ──
async function main(): Promise<void> {
  console.log(`\n=== iterate-grade ${version} | ${selectedBuildings.length} buildings | ${vlmRuns} VLM runs | model: ${vlmModel} ===\n`);

  // Load existing state or create new
  const statePath = `${DIR}/iterate-state.json`;
  let state: IterateState;
  if (existsSync(statePath) && onlyKeys.length > 0) {
    // Merge into existing state when running --only subset
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

      // Step 4: VLM grade
      console.log(`  Grading with ${vlmModel} (${vlmRuns} runs, temp=0.1)...`);
      const { scores, subscores, trimmedMean } = await gradeBuilding(gradePath, b.key, vlmRuns);

      const result: BuildingResult = {
        key: b.key,
        version,
        difficulty: b.difficulty,
        scores,
        subscores,
        trimmedMean,
        diagnosis: diagnose(subscores),
        timestamp: new Date().toISOString(),
      };

      state.buildings[b.key] = result;

      const status = trimmedMean >= targetScore ? 'PASS' : 'FAIL';
      console.log(`  → ${b.key}: trimmedMean=${trimmedMean} [${scores.join(', ')}] ${status}`);
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
  console.log('='.repeat(50));
}

/** Write human-readable markdown state file */
function writeMarkdownState(state: IterateState): void {
  const lines: string[] = [
    `# Iterate State — ${state.version}`,
    ``,
    `**Target**: 9/${state.total} buildings at ${state.target}+`,
    `**Current**: ${state.passing}/${state.total} passing`,
    `**Model**: ${state.model} | **Runs**: ${vlmRuns} (trimmed mean)`,
    `**Updated**: ${state.timestamp}`,
    ``,
    `| Building | Difficulty | TrimmedMean | Scores | Avg A | Avg B | Avg C | Status | Diagnosis |`,
    `|---|---|---|---|---|---|---|---|---|`,
  ];

  for (const b of BUILDINGS) {
    const r = state.buildings[b.key];
    if (!r) {
      lines.push(`| ${b.key} | ${b.difficulty} | — | — | — | — | — | PENDING | — |`);
      continue;
    }
    const avgA = r.subscores.length > 0
      ? (r.subscores.reduce((s, x) => s + x.A, 0) / r.subscores.length).toFixed(1) : '—';
    const avgB = r.subscores.length > 0
      ? (r.subscores.reduce((s, x) => s + x.B, 0) / r.subscores.length).toFixed(1) : '—';
    const avgC = r.subscores.length > 0
      ? (r.subscores.reduce((s, x) => s + x.C, 0) / r.subscores.length).toFixed(1) : '—';
    const status = r.trimmedMean >= state.target ? 'PASS' : 'FAIL';
    lines.push(`| ${r.key} | ${r.difficulty} | ${r.trimmedMean} | [${r.scores.join(',')}] | ${avgA} | ${avgB} | ${avgC} | ${status} | ${r.diagnosis} |`);
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
      if (!action) action = 'Fine-tune pipeline params. ';
      lines.push(`- [ ] **${f.key}** (${f.trimmedMean}): ${action.trim()}`);
    }
  }

  writeFileSync('output/iterate-state.md', lines.join('\n') + '\n');
  console.log(`Summary: output/iterate-state.md`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
