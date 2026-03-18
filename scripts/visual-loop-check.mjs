#!/usr/bin/env node
/**
 * Visual quality grading loop — Stop hook.
 *
 * Phases:
 *   init  → randomly select 6 models from OMR, transition to "grade"
 *   grade → prompt Claude to visually grade all selected models in browser
 *   fix   → prompt Claude to fix issues found, re-grade changed models
 *
 * Termination: passing_count >= 5 (5/6 models score >= 9/10)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const STATE     = 'C:/git/craftmatic/.claude/visual-loop-state.json';
const LOG       = 'C:/git/craftmatic/.claude/visual-loop.log';
const OMR_IDX   = 'C:/git/craftmatic/web/public/omr-index.json';
const CATALOG   = 'C:/git/craftmatic/web/public/lego-catalog.json';
const MIN_PARTS = 200; // only grade sets with enough parts to be visually interesting

let inputData = '';
process.stdin.on('data', c => inputData += c);
process.stdin.on('end', () => {
  if (!existsSync(STATE)) process.exit(0);
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  if (!s.active) process.exit(0);

  // ── Termination checks ──────────────────────────────────────────────────────
  if (s.pass >= s.max_passes) {
    s.active = false;
    writeFileSync(STATE, JSON.stringify(s, null, 2));
    appendFileSync(LOG, `\n[${ts()}] LOOP ENDED — max passes reached (${s.pass})\n`);
    process.exit(0);
  }
  if (s.passing_count >= s.pass_threshold) {
    s.active = false;
    writeFileSync(STATE, JSON.stringify(s, null, 2));
    appendFileSync(LOG, `\n[${ts()}] LOOP COMPLETE — ${s.passing_count}/6 models scored >= ${s.score_threshold}\n`);
    process.exit(0);
  }

  // ── Phase: init — select 6 random models ────────────────────────────────────
  if (s.phase === 'init' || s.selected_models.length === 0) {
    const omrSet = new Set(JSON.parse(readFileSync(OMR_IDX, 'utf8')));
    const catalog = JSON.parse(readFileSync(CATALOG, 'utf8')).sets;
    // Filter: must be in OMR AND have >= MIN_PARTS parts
    const pool = catalog.filter(entry => omrSet.has(entry.set_num) && entry.num_parts >= MIN_PARTS);
    // Fisher-Yates shuffle with LCG seeded by time
    const seed = Date.now();
    const lcg = (n) => { let x = n; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 0xFFFFFFFF; }; };
    const rng = lcg(seed % 0xFFFFFFFF);
    const arr = [...pool];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    s.selected_models = arr.slice(0, 6).map(entry => entry.set_num);
    s.scores = {};
    s.issues = [];
    s.passing_count = 0;
    s.phase = 'grade';
    appendFileSync(LOG, `\n[${ts()}] Selected models: ${s.selected_models.join(', ')}\n`);
  }

  s.pass++;
  writeFileSync(STATE, JSON.stringify(s, null, 2));
  appendFileSync(LOG, `\n[${ts()}] Pass ${s.pass}/${s.max_passes} — phase: ${s.phase}\n`);

  const modelList = s.selected_models.map((m, i) => {
    const score = s.scores[m];
    const tag = score !== undefined ? ` (last score: ${score}/10)` : '';
    return `  ${i+1}. ${m}${tag}`;
  }).join('\n');

  const scoreTable = s.selected_models.map(m => {
    const score = s.scores[m];
    return `  ${m}: ${score !== undefined ? score+'/10' : 'not yet graded'}`;
  }).join('\n');

  const issues = s.issues.length > 0
    ? '\nKNOWN ISSUES FROM PREVIOUS GRADING:\n' + s.issues.map(i => `  - ${i}`).join('\n')
    : '';

  let reason;

  if (s.phase === 'grade') {
    reason = `\
VISUAL QUALITY LOOP — PASS ${s.pass}/${s.max_passes} — GRADING PHASE

OBJECTIVE: Visually inspect and honestly score the LEGO voxelization pipeline
output for each of the 6 randomly-selected test models. Stop when 5/6 score >= 9/10.

CURRENT SCORES (${s.passing_count}/${s.pass_threshold} passing):
${scoreTable}${issues}

MODELS TO GRADE THIS PASS:
${modelList}

GRADING WORKFLOW (follow exactly):
1. Start the dev server if not running: bun dev:web (port 4000)
2. Open the browser tab at http://localhost:4000 (LEGO tab)
3. For EACH of the 6 models above:
   a. Search for the set number in the LEGO tab
   b. Select it and click "Auto-Load LDraw from OMR"
   c. Wait for the 3D viewer to render
   d. Take a screenshot of the 3D viewer output
   e. Compare the voxelized result to the real LEGO set (use the set thumbnail visible in the UI)
   f. Score it HONESTLY 1-10 based on:
      - Shape accuracy (does it look like the real set? correct proportions?)
      - Color accuracy (are the colors recognizable/correct?)
      - Detail level (are key structural features present?)
      - Scale coherence (does it look like a LEGO model, not a blob?)
   g. Record specific issues (what's wrong, what's missing)

4. After grading all 6:
   a. Write scores to .claude/visual-loop-state.json:
      scores: { "set_num": N, ... }
      issues: ["specific issue 1", "specific issue 2", ...]
      passing_count: (count of scores >= ${s.score_threshold})
      phase: "fix"  (if any score < ${s.score_threshold}) or keep "grade"
   b. DO NOT CHANGE: active, pass, max_passes, selected_models, pass_threshold, score_threshold
   c. Commit nothing — just update the state file

HARD RULES:
- Be BRUTALLY HONEST. A 9/10 means it genuinely looks like the real set.
  A 5/10 means recognizable but significantly wrong. A 3/10 means barely passable.
- Do NOT touch: scripts/visual-loop-check.mjs
- Do NOT upgrade scores out of wishful thinking — grade what you SEE
- If a model fails to load, score it 0 and note "failed to load"`;

  } else {
    // fix phase
    const belowThreshold = s.selected_models
      .filter(m => (s.scores[m] ?? 0) < s.score_threshold)
      .map(m => `  ${m}: ${s.scores[m]}/10`).join('\n');

    reason = `\
VISUAL QUALITY LOOP — PASS ${s.pass}/${s.max_passes} — FIX PHASE

OBJECTIVE: Fix pipeline issues causing models to score below ${s.score_threshold}/10.
When fixes are complete, switch to grading to re-evaluate affected models.

CURRENT SCORES (${s.passing_count}/${s.pass_threshold} passing at >= ${s.score_threshold}/10):
${scoreTable}

MODELS NEEDING IMPROVEMENT (score < ${s.score_threshold}):
${belowThreshold}

KNOWN ISSUES:
${s.issues.map(i => '  - ' + i).join('\n')}

FIX WORKFLOW (follow exactly):
1. Analyze the specific issues listed above
2. Identify root causes in the pipeline:
   - ldraw-voxelizer.ts (shape/dims/scale issues)
   - ldraw-part-dims.ts (wrong part sizes)
   - ldraw-colors.ts (wrong color mappings)
   - scene.ts (rendering issues)
   - ldraw-parser.ts (parsing issues)
3. Implement fixes — be thorough, test edge cases
4. Run: bun run typecheck (must pass 0 errors)
5. After fixes:
   a. Update .claude/visual-loop-state.json:
      phase: "grade"
      issues: [updated list — remove fixed issues, add newly discovered ones]
   b. DO NOT CHANGE: active, pass, max_passes, selected_models, scores, passing_count, pass_threshold, score_threshold
   c. Commit the code changes with a clear message describing what was fixed
6. The next loop pass will re-grade the affected models

HARD RULES:
- Do NOT touch: scripts/visual-loop-check.mjs
- typecheck must pass 0 errors before finishing
- Fix the actual root cause, not just one model's symptoms
- If an issue requires investigation first, investigate AND fix in the same pass`;
  }

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
});

function ts() { return new Date().toISOString(); }
