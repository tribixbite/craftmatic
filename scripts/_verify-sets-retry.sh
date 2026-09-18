#!/usr/bin/env bash
# Re-run only the sets of a round that produced no positions dump, up to N
# rounds. Production loads stall intermittently (measured 2026-09-18: ~45% of
# cold set loads on craftmatic.click never finish, and a second click on the
# same card always loads it), so a single pass under-reports what renders.
#   bash scripts/_verify-sets-retry.sh <outDir> <rounds> <set>...
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT=$1; ROUNDS=$2; shift 2
SETS="$*"
for r in $(seq 1 "$ROUNDS"); do
  todo=""
  for s in $SETS; do
    f="$ROOT/$s/$s-positions.json"
    if [ ! -s "$f" ] || [ "$(cat "$f")" = "[]" ]; then todo="$todo $s"; fi
  done
  [ -z "$todo" ] && { echo "all sets have a positions dump"; break; }
  echo "=== round $r: $todo"
  node scripts/_verify-sets-batch.mjs "$ROOT" $todo || true
done
for s in $SETS; do
  f="$ROOT/$s/$s-positions.json"
  if [ ! -s "$f" ] || [ "$(cat "$f")" = "[]" ]; then echo "STILL FAILING: $s"; fi
done
