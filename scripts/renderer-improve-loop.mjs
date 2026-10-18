#!/usr/bin/env node
/**
 * Stop hook: autonomous LEGO-renderer improvement loop.
 *
 * When active, this blocks the agent from stopping and re-injects a directive
 * to find + implement + validate + commit the next improvement, so it keeps
 * working without pausing to ask. The user asked for this explicitly.
 *
 * State: .claude/improve-loop-state.json  { active, pass, max_passes }
 *   • active=false  → allow stop (the escape hatch). The agent may set this
 *                     when it hits a blocker that genuinely needs the user.
 *   • pass>=max     → safety cap; stop and report so it can't run forever.
 *
 * To pause: set "active": false in that file (or delete it).
 * To re-arm: set "active": true and "pass": 0.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const STATE = join(ROOT, '.claude', 'improve-loop-state.json');

// Drain stdin (Stop-hook payload: {stop_hook_active, ...}) but don't require it.
let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* ignore */ }

let s;
try { s = JSON.parse(readFileSync(STATE, 'utf8')); }
catch { process.exit(0); } // no state file → loop disabled, allow stop

if (!s.active) process.exit(0);

const max = s.max_passes ?? 50;
if ((s.pass ?? 0) >= max) {
  s.active = false;
  writeFileSync(STATE, JSON.stringify(s, null, 2));
  // exit 0 = allow stop; message shown to user
  console.log(`\n⚠ Renderer improvement loop hit its ${max}-pass safety cap. Stopping. Re-arm by setting pass:0, active:true in ${STATE}.`);
  process.exit(0);
}

s.pass = (s.pass ?? 0) + 1;
writeFileSync(STATE, JSON.stringify(s, null, 2));

const reason = [
  `AUTONOMOUS RENDERER-IMPROVEMENT LOOP — pass ${s.pass}/${max}. Do NOT stop to ask whether to pause; just continue.`,
  ``,
  `Pick the next highest-impact improvement to the LEGO/LDraw 3D renderer, implement it, validate it, and COMMIT it (one focused commit). Then this hook fires again for the next one.`,
  ``,
  `Candidate work (choose what's most impactful; add your own findings):`,
  `  • Open tasks: #81 floor/contact-shadow polish, #82 first-load progress feedback, #96 engine-bay clutter culling.`,
  `  • OBJ/STL export size: merge instances into one geometry per color (instead of one Mesh per brick) to shrink files.`,
  `  • Hunt visual gaps: load diverse OMR sets (via the LEGO tab) and look for missing parts, wrong colors, float/overlap.`,
  `  • Further perf: triangle reduction / LOD for studs on huge sets; cap or LRU the sharedPartGeoms cache.`,
  ``,
  `Process each pass:`,
  `  1. Make the change. 2. Typecheck: bunx tsc --noEmit -p web/tsconfig.json (your files must be clean; pre-existing errors in web/src/ui/* are OK).`,
  `  3. Validate in-browser: dev server (bun dev:web on :4000), load a model in the LEGO tab, use window.__ldrawViewer for renderer.info metrics + a screenshot.`,
  `  4. git commit with a clear message (Co-Authored-By trailer). Keep CLAUDE.md current for durable changes.`,
  ``,
  `Escape hatch: if you hit something that genuinely needs the user (an ambiguous product decision, or a prohibited/irreversible action), set "active": false in .claude/improve-loop-state.json, then stop and surface it. Otherwise keep going.`,
].join('\n');

process.stdout.write(JSON.stringify({ decision: 'block', reason }));
process.exit(0);
