#!/bin/bash
# check-category-state.sh — Cross-session automation hook for category grading.
#
# Reads output/category-state.json on Stop events to report progress and
# suggest next actions. Wired as a Claude Code Stop hook.

STATE_FILE="output/category-state.json"

if [ ! -f "$STATE_FILE" ]; then
  echo "No category state file found. Run: bun scripts/iterate-category-grade.ts"
  exit 0
fi

# Extract key metrics using bun for reliable JSON parsing
SUMMARY=$(bun -e "
const fs = require('fs');
const state = JSON.parse(fs.readFileSync('$STATE_FILE', 'utf8'));
const locs = Object.values(state.locations);
const passing = locs.filter(l => l.averageGrade && l.averageGrade.composite >= state.target).length;
const plateaued = locs.filter(l => l.plateaued).length;
const total = locs.length;
const graded = locs.filter(l => l.averageGrade).length;
const ungraded = total > 0 ? total - graded : 0;

console.log('=== Category Grade Status ===');
console.log('Passing: ' + passing + '/' + total + ' (target: ' + state.target + '/10)');
if (plateaued > 0) console.log('Plateaued: ' + plateaued);
if (ungraded > 0) console.log('Ungraded: ' + ungraded);

// Show failing locations with worst categories
const failing = locs.filter(l => l.averageGrade && l.averageGrade.composite < state.target && !l.plateaued);
if (failing.length > 0) {
  console.log('');
  console.log('Failing (actionable):');
  for (const l of failing.sort((a, b) => (a.averageGrade?.composite ?? 0) - (b.averageGrade?.composite ?? 0))) {
    const worst = l.worstCategories.slice(0, 3).join(', ');
    console.log('  ' + l.key + ': ' + (l.averageGrade?.composite?.toFixed(1) ?? '?') + '/10 — ' + worst);
  }
}

if (passing === total && total > 0) {
  console.log('');
  console.log('ALL LOCATIONS PASSING — target met!');
} else if (failing.length > 0) {
  console.log('');
  const next = failing[0];
  console.log('Suggested next: bun scripts/iterate-category-grade.ts --only ' + next.key);
}
" 2>/dev/null)

echo "$SUMMARY"
