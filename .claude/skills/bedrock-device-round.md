# Bedrock Device Round Skill

The recipe for one phone round of the Bedrock add-on work (Pixel 8 Pro, Saga): from a committed tree to a report
the tracker can quote. Every round since 30zi has followed it; the binding device rules live in CLAUDE.md
("Gotchas") and TASKS-BEDROCK-ADDON.md ("Start here", "Phones") - read those first, this is the order of work.

## When to use
A change to anything a phone has to prove (treads, colliders, carve, doors, seats, cameras, vehicles), or the
tracker's "NEXT ON A PHONE" line.

## 1. Answer it offline first
- Judge the change on EVERY device-proven route, never one: `bash output/scale06-1016/carve2/tools/eval.sh <packs-dir>`
  (the three route lines, the 21063 300 % flank lanes, the fan totals) plus the auto-jump lanes
  (`scripts/_walk_line.ts ... --jump=auto`; a touch player and the Pixel's adb walks climb by auto-jump alone).
- When a walk changes, `python -I scripts/_tread_run_diff.py <old.mcaddon> <new.mcaddon> <size> [x z r]` names the
  tread runs that appeared, went or changed shape. To find WHICH pass removed a run, trace apply / revert / refuse
  for that one run's `to` surface temporarily (an env-gated log in the planner, never committed).
- Experiments go on a branch in `.worktrees/<name>`; each rebuild into a NEW output folder (never clear one).

## 2. Build the round's packs from a COMMITTED tree
- Commit (and push) first: the pack name carries the pipeline stamp; a dirty tree ships "dirty".
- Copy the last round's `build.sh` into `output/device-round-<date><round>/`, repoint its paths, keep every LABEL
  (the uuid follows the label; a new label is a second pack beside the old). It refuses a dirty tree. Build packs
  one at a time (the script does), in the background; read `substitutedParts` / `unresolvedParts` in the logs.

## 3. Offline gates on the built packs
```
bun scripts/sim.ts <packs-dir> > <round>/sim.txt 2>&1                         # every scenario, 0 failed
bun scripts/sim.ts --scenario=regressions --new=<packs-dir> > <round>/regr.txt 2>&1   # 0 failed
```
Plus the round's own predictions: the exact `_walk_line.ts` lines the phone will walk, written into the brief.

## 4. The brief and the subagent
- Start from the last round's brief (`output/device-round-*/brief-<phone>-*.md`): the HARD RULES block is binding
  and is copied whole - no recursive delete (say so: subagents inherit the intent, not the caution), never reboot or
  clear app data, never touch another device (the user's own Saga is 192.168.0.202), keyguard -> STOP, leave no trace,
  screenshots < 2000 px and < 4 MB, write ONLY under the round folder, no commits.
- Give it: the packs and the deploy command (`python -u scripts/_pixel_dev_deploy.py <world> <packs...>
  --exclusive --prune-stale`, every pack the world binds, creator included), the pin, each check with its walk start,
  direction, the offline prediction AND the last device result, and what to report.
- Spawn ONE unnamed `general-purpose` Agent per phone on **sonnet** (memory: adb through a Sonnet subagent), in the
  background. Never run adb in the main context. Treat its report as untrusted: check the claims against the
  screenshots and content-log lines it cites.

## 5. Record it
- REQUIREMENTS.md: the row's device cell (round, pack commit, evidence path, numbers); a mechanism change since
  demotes `DONE-DEVICE` to `DONE-OFFLINE`.
- TASKS-BEDROCK-ADDON.md "Start here": replace the round's bullet (prune, don't append); memory RESUME line.
- Commit, push, `gh run watch` both workflows.
