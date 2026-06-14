#!/usr/bin/env bun
/**
 * VLM grading script: sends grade composite images to Gemini for scoring.
 * Usage: bun scripts/vlm-grade.ts output/tiles/grade-v79-*.jpg
 */
import { readFileSync } from 'fs';
import { basename } from 'path';

const apiKey = process.env.GOOGLE_API_KEY
  || readFileSync('.env', 'utf8').match(/GOOGLE_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) { console.error('No GOOGLE_API_KEY'); process.exit(1); }

const files = process.argv.slice(2).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
if (files.length === 0) { console.error('Usage: bun scripts/vlm-grade.ts <grade-image.jpg> ...'); process.exit(1); }

// Rubric selection: --rubric holistic|structured (default structured)
const rubricIdx = process.argv.indexOf('--rubric');
const rubric = rubricIdx >= 0 ? process.argv[rubricIdx + 1] : 'structured';

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

For EACH building image, respond with EXACTLY this format:
NAME: A=X B=X C=X Total=X.X
Brief 1-line explanation.

Be strict but fair. A perfect Minecraft build at 1 block/meter cannot have pixel-level detail. Score the quality relative to what's achievable in Minecraft at this resolution.`;

const HOLISTIC_PROMPT = `You are evaluating Minecraft voxel reconstructions of real buildings at 1 block per meter resolution (each block = ~1 cubic meter).

Each image has 3 panels: LEFT = satellite photo, CENTER = isometric 3D render, RIGHT = top-down footprint view.

At this resolution, individual windows are 1 block, walls are 1 block thick, and fine details cannot exist. This is a fundamental constraint of the medium. Score relative to what is physically achievable at 1m resolution.

Rate each building 1-10:
- 5 = The building is recognizable as a structure but shape/proportions are wrong
- 6 = Correct basic shape but notable issues (wrong proportions, missing wings, truncated)
- 7 = Good shape and proportions, basic material distinction
- 8 = Accurate shape, correct massing, clear roof/wall/ground material zones
- 9 = Excellent reconstruction: accurate footprint, good proportions, distinct materials, clean edges
- 10 = Best possible at 1m resolution: perfect footprint match, correct height, multiple material zones, architectural details like windows/trim visible

For EACH building, respond with:
NAME: Score=X
1-line explanation.`;

const PROMPT = rubric === 'holistic' ? HOLISTIC_PROMPT : STRUCTURED_PROMPT;

// Process all images in one batch request
const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
  { text: PROMPT },
];

for (const file of files) {
  const name = basename(file).replace(/^grade-v\d+[a-z]*-/, '').replace('.jpg', '');
  parts.push({ text: `\n--- ${name} ---` });
  const data = readFileSync(file);
  parts.push({ inlineData: { mimeType: 'image/jpeg', data: data.toString('base64') } });
}

console.log(`Sending ${files.length} grade images to Gemini...`);

// Model selection: --model flag or default to gemini-2.0-flash-001 (most stable for grading)
const modelIdx = process.argv.indexOf('--model');
const model = modelIdx >= 0 ? process.argv[modelIdx + 1] : 'gemini-2.0-flash-001';

// Number of runs for averaging: --runs N (default 3)
const runsIdx = process.argv.indexOf('--runs');
const runs = runsIdx >= 0 ? parseInt(process.argv[runsIdx + 1], 10) : 1;

for (let run = 0; run < runs; run++) {
  if (runs > 1) console.log(`\n=== Run ${run + 1}/${runs} ===`);

const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
    }),
  },
);

if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const json = await res.json() as { candidates?: Array<{ content: { parts: Array<{ text?: string }> } }> };
const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? 'No response';
console.log('\n' + text);
} // end runs loop
