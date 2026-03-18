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

  const reason = `\
AUTOMATED GAP-FIX PASS ${s.pass}/${s.max_passes}

WORKFLOW (follow exactly):
1. Read spec/lego-gaps-roadmap.md   (master gap list — find first OPEN item)
2. Read spec/improvement-log.md     (history — verify item not already done)
3. Read spec/lego-pipeline.md       (architecture reference)
4. Pick the first OPEN gap and implement it completely and thoroughly
5. Run: bun run typecheck           (must pass 0 errors)
6. Run: bun scripts/visual-grade.ts if voxelizer changed (record scores)
7. Mark the gap [DONE — Pass ${s.pass}] in spec/lego-gaps-roadmap.md
8. Append a detailed "## Pass ${s.pass}" section to spec/improvement-log.md
9. Update spec/lego-pipeline.md if architecture changed

HARD RULES:
- Do NOT touch: .claude/loop-state.json, scripts/loop-check.mjs
- typecheck must pass clean before finishing
- One gap per pass (except trivially small gaps — combine at most 2)
- Be thorough: implement the complete fix, not just a stub
- If a gap requires investigation first, do the investigation AND implement the fix in the same pass`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
});
