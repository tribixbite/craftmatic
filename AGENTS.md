# Agents working on craftmatic

Read **[CLAUDE.md](CLAUDE.md)** first. It is the project guide for every agent
(Claude Code, Codex, Gemini and others), not only Claude.

## Rules that are easy to miss

1. **Requirements ledger.** Every user request is a row in
   **[REQUIREMENTS.md](REQUIREMENTS.md)**, explained in
   [docs/product-spec.md](docs/product-spec.md).
   - **New requests:** add a row the same turn.
   - **Fixes:** a fix cites the row's id and adds a guard test.
     `test/requirements-ledger.test.ts` fails when a `DONE-*` row's guard
     disappears.
   - **Repeats:** a repeated or regressed ask updates the row's dates and
     status.
   - **Rows are permanent:** never delete one.
2. **Handoff.** The current state is in the "Start here" section of
   [TASKS-BEDROCK-ADDON.md](TASKS-BEDROCK-ADDON.md). Prune trackers; don't
   append. History lives in `git log`.
3. **Commands.** Use bun and bunx, never npm or npx. Run tests with
   `bun run test`, never bare `bun test`. Run both typechecks:
   `bun run typecheck` and `bun run typecheck:web`.
4. **Dangerous operations.**
   - Never run a recursive delete.
   - Never use git reset, revert or force without the user's explicit
     permission.
5. **Devices.** Leave a test phone as you found it. If you cannot restore it,
   say so in the tracker. Never restart the framework on the Saga.
