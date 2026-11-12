## How every Wave-1 implementer works (binding)

**ABSOLUTE RULE, checked after every package: NO recursive delete of ANY kind, not even of a scratch folder you
created a minute ago (`rm -r`, `rm -rf`, `Remove-Item -Recurse`, `rmdir /s`, `find -delete`, `shutil.rmtree`,
`fs.rmSync(..., {recursive})`, `git worktree remove`). A Wave-1 agent broke this on 2026-11-09. Leave scratch
folders in place and use a NEW name next time.**
Repo: C:\git\craftmatic (Windows; use Git Bash or PowerShell; bun/bunx only, never npm/npx/node package installs).

1. **Read first:**
   - `C:/git/craftmatic/docs/plans/README.md`: section 1.1 (the shared type contract), YOUR package's brief in
     section 3, section 7.5 and Appendix A (legal guard rails + process rules);
   - `C:/git/craftmatic/CLAUDE.md`;
   - the plan section your brief cites.
2. **Worktree:** `cd /c/git/craftmatic && git worktree add .worktrees/biz-<id> -b biz-<id> main`, then
   `cd .worktrees/biz-<id> && bun install`. Work ONLY inside that worktree. Never edit files in the main checkout or
   in another agent's worktree. Eight other agents work in parallel in their own worktrees.
3. **Fail-first TDD (a MERGE CONDITION since 2026-11-09: three Wave-1/2 agents skipped it):** paste the failing run's
   assertion output into your report, or the branch is not merged.
   **Fail-first TDD:** write the failing test first and run it (`bunx vitest run <file>`). Confirm it fails for the
   RIGHT reason (an assertion, not a missing file or import). Then implement until it passes. Add more tests as
   you go.
4. **Run only what is relevant:**
   - your test files;
   - `bun run typecheck` and `bun run typecheck:web`;
   - `bun scripts/_physics_spec_check.ts` if you touch physics-named modules; it HANGS on a TS syntax error, so
     typecheck first.

   Do NOT run the full `bun run test` suite: the machine is shared with 8 other agents, and the orchestrator runs it
   at merge time.
4b. **`.gitignore` hides EVERY folder named `data/`** (and `output/`): a file committed there is silently left
   out (A09's Notre-Dame sidecar was). Run `git check-ignore -v <file>` on every new non-code file before you report.
5. **Code quality:** typed, DRY, production-level TypeScript with JSDoc and explanatory comments; a `TODO` comment for
   anything unfinished. No stubs or placeholders presented as done. No `_fixed`/`_v2` copies.
6. **Commits:**
   - conventional commits that cite the BIZ id;
   - the message ends with a line naming YOUR OWN model: "— Sonnet 5.5", "— Fable 5.1" or "— Opus 5.5" (the user,
     2026-11-12);
   - NO Co-Authored-By line and never the word "Claude";
   - commit on your branch as you reach green steps;
   - do NOT merge into main and do NOT push; the orchestrator reviews and merges.
7. **NEVER:**
   - any recursive delete (rm -rf, rm -r, Remove-Item -Recurse, rmdir /s, find -delete, git worktree remove),
     including in temp dirs; use a NEW directory name instead;
   - git reset/revert/checkout -- files/restore/force/rebase, or bare git stash;
   - touching phones/adb or the Minecraft client;
   - posting, uploading or signing up anywhere;
   - network fetches beyond what your package requires (B29 only, politely).
8. **Report:** reply with at most 25 lines, covering:
   - the branch and commits;
   - the tests added, and the exact command showing them pass;
   - the typecheck results;
   - what was done versus your brief's acceptance criteria;
   - anything incomplete, compromised or uncertain, stated plainly;
   - files touched outside your brief's list (there should be none).
