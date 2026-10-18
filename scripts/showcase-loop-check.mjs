#!/usr/bin/env node
/**
 * Stop hook for the showcase visual improvement loop.
 *
 * Reads .claude/showcase-loop-state.json and, when active, runs the
 * showcase grader to update scores, then either:
 *   - declares success if enough models pass the threshold, or
 *   - emits a prompt directing Claude to keep improving.
 *
 * Hook trigger:  PostToolUse (Edit, Write, MultiEdit)
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');
const STATE = join(ROOT, '.claude', 'showcase-loop-state.json');

let s;
try { s = JSON.parse(readFileSync(STATE, 'utf8')); }
catch { process.exit(0); }

if (!s.active) process.exit(0);

if (s.pass >= s.max_passes) {
  s.active = false;
  writeFileSync(STATE, JSON.stringify(s, null, 2));
  console.log(`\n⚠ Showcase loop: reached max passes (${s.max_passes}). Stopping.`);
  process.exit(0);
}

console.log(`\n🔍 Showcase loop pass ${s.pass + 1}/${s.max_passes} — running grader…`);

try {
  execSync(`bun scripts/showcase-grade.ts`, { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  console.error('Grader failed:', e.message);
  process.exit(0);
}

// Re-read updated state
s = JSON.parse(readFileSync(STATE, 'utf8'));

const threshold  = s.score_threshold ?? 8;
const needed     = s.pass_threshold  ?? 5;
const total      = Object.keys(s.scores).length;
const passing    = Object.entries(s.scores).filter(([,v]) => v >= threshold).length;

console.log(`\n📊 Showcase scores after pass ${s.pass}:`);
for (const [id, score] of Object.entries(s.scores)) {
  const ok = score >= threshold ? '✓' : '✗';
  console.log(`   ${ok} ${id}: ${score}/10`);
}
console.log(`   ${passing}/${total} passing (need ${needed})`);

if (passing >= needed) {
  s.active = false;
  writeFileSync(STATE, JSON.stringify(s, null, 2));
  console.log(`\n🎉 Showcase loop complete! ${passing}/${total} models score ≥${threshold}/10.`);
  process.exit(0);
}

// Still failing — print issues and directive for Claude to continue
const worst = Object.entries(s.scores)
  .sort(([,a],[,b]) => a - b)
  .slice(0, 3)
  .map(([id, score]) => `${id} (${score}/10)`);

const issues = (s.issues ?? []).slice(0, 12).join('\n');

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SHOWCASE IMPROVEMENT LOOP — Pass ${s.pass}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status: ${passing}/${total} models ≥${threshold}/10 (need ${needed})
Worst:  ${worst.join(', ')}

Known issues:
${issues}

Your task: Fix the issues above to make the showcase renders look more like
actual LEGO sets. Focus on the worst-scoring models first.

Improvement areas (in order of impact):
1. COLOR ACCURACY — grey blocks where there should be colour?
   → Check ldraw-colors.ts mapping, fix missing LDraw color IDs
   → Verify color-16 inheritance works for complex MPDs
2. SHAPE ACCURACY — parts wrong size or shape?
   → Check ldraw-part-dims.ts, add missing dims entries
   → Verify slope/round/frame shapes render correctly
3. VOXELIZER LOGIC — parts in wrong positions?
   → Review connected-component filter thresholds
   → Check rotation matrix application for angled parts
4. RENDERER QUALITY — still looks like Minecraft?
   → Improve lego-scene.ts materials/lighting
   → Adjust stud texture, roughness, specular

After making changes, the grader will re-run automatically.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
