#!/usr/bin/env node
/**
 * Claude Code Stop hook — autonomous improvement loop.
 *
 * When active, outputs {"decision":"block","reason":"..."} so Claude
 * continues in the SAME session doing the next improvement pass.
 * When done (pass >= max_passes or active=false), exits 0 to allow stop.
 *
 * Reads hook input JSON from stdin (contains session context).
 * To stop the loop: set "active": false in .claude/loop-state.json
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const STATE = 'C:/git/craftmatic/.claude/loop-state.json';
const LOG   = 'C:/git/craftmatic/.claude/loop-output.log';

let inputData = '';
process.stdin.on('data', chunk => inputData += chunk);
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(inputData); } catch {}

  // Load loop state
  if (!existsSync(STATE)) process.exit(0);
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  if (!s.active) process.exit(0);

  // Termination check
  if (s.pass >= s.max_passes) {
    s.active = false;
    writeFileSync(STATE, JSON.stringify(s, null, 2));
    appendFileSync(LOG, `\n[loop ${new Date().toISOString()}] Complete — reached ${s.max_passes} passes.\n`);
    process.exit(0);
  }

  // Advance counter
  s.pass++;
  writeFileSync(STATE, JSON.stringify(s, null, 2));

  const isArchReview = s.pass % 3 === 0;
  const mode = isArchReview ? 'ARCHITECTURE REVIEW' : 'IMPROVEMENT';

  appendFileSync(LOG, `\n[loop ${new Date().toISOString()}] Pass ${s.pass}/${s.max_passes} — ${mode}\n`);

  const taskDetail = isArchReview
    ? `ARCHITECTURE REVIEW (every 3rd pass):
  - Read improvement-log.md — what has worked, what hasn't
  - Step back and assess the overall approach
  - Identify any structural weaknesses or dead-ends
  - Consider alternative algorithms (e.g. vertex sampling vs AABB, different masking)
  - Refactor or restructure if it would unlock better future improvements
  - Also implement at least one concrete improvement this pass`
    : `IMPROVEMENT PASS:
  - Check the priority list in spec/lego-pipeline.md
  - Check improvement-log.md to avoid repeating work already done
  - Implement the single highest-impact improvement
  - Keep it focused: one targeted change per pass`;

  const reason = `\
AUTOMATED IMPROVEMENT PASS ${s.pass}/${s.max_passes} — ${mode}

${taskDetail}

WORKFLOW (follow exactly):
1. Read spec/lego-pipeline.md      (architecture, priorities, known issues)
2. Read spec/improvement-log.md    (history — do not repeat past work)
3. Plan the improvement (think before editing)
4. Implement it
5. Run: bun run typecheck           (must pass 0 errors)
6. Run: bun scripts/visual-grade.ts (record block counts + scores)
7. Append a new "## Pass ${s.pass}" section to spec/improvement-log.md
8. Update spec/lego-pipeline.md if architecture changed

HARD RULES:
- Do NOT touch: scripts/visual-grade.ts, .claude/loop-state.json, scripts/loop-check.mjs
- typecheck must pass before finishing`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
});
