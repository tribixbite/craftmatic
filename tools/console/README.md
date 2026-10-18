# Operator console

`bun run console` → http://127.0.0.1:4600

One place to run any operation this toolchain performs, over a single model or
a filtered batch, without copying commands between a doc and a terminal.

**`inventory.ts` is the cheat sheet and the single source of truth.** Each
operation declares what it answers, its real argv template, its typed options
(read from that script's own argument parsing), how its output is parsed, where
its evidence lands and roughly how long it takes. `STALE` lists the script
families deliberately not wired, with reasons, so the omissions are legible.
**Add or change an operation there, never in the UI.**

Nothing here reimplements a script: the console spawns the real entry point and
shows the exact command line before running it, so it teaches the CLI rather
than hiding it. `inventory.test.ts` enforces that — every declared flag must
appear in the target script's source, and every entry point must exist on disk.

## Layout

| File | Role |
|---|---|
| `inventory.ts` | The operations, as data. Start here. |
| `types.ts`, `command.ts` | Inventory schema; pure argv builder and output parsers. |
| `index-store.ts`, `csv.ts` | Model-index rows and filtering; CSV parse and export. |
| `runner.ts` | Spawns operations, streams output, caps concurrency, persists runs. |
| `server.ts` | HTTP + SSE; transpiles the UI on request (no build step). |
| `ui/` | Single-page dark UI: Select · Operations · Runs. |

## Guards that must not be removed

- Batch dispatch **pauses above 85 % CPU**, sampled from `os.cpus()` because
  `loadavg` reads 0 on Windows. A stray load generator has cost this project a
  day; a batch console is exactly how that recurs.
- Publishing, index writes and device operations are separated, require typing
  the operation id to confirm, and default to `--dry-run`.

## Tests

`bunx vitest run --root tools/console` — 49 tests. `tools/` is outside both
`bun run typecheck` projects; it has its own `tsconfig.json`
(`bunx tsc --noEmit -p tools/console/tsconfig.json`).

Runs are persisted to `output/console-runs/<id>/` (gitignored).
