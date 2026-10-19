/**
 * Tests for the pipeline-loop Stop hook (`.claude/hooks/check-pipeline-state.sh`).
 *
 * The hook is what drives the autonomous iteration loop, and it had been
 * dying on a `NameError` (an undefined `ESC_ATTEMPTS`) on its PRIMARY
 * blocking path — a Stop hook that exits non-zero is reported as a
 * non-blocking error and the stop proceeds, so the loop was silently dead
 * for every fail-objective build. Nothing caught it because the hook had no
 * tests. These run it as a subprocess against fixture state directories.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = resolve(import.meta.dirname, '../.claude/hooks/check-pipeline-state.sh');

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout JSON, or null when the hook emitted nothing. */
  decision: { decision?: string; reason?: string } | null;
}

let dir: string;

/** Minimal state record that passes every gate. */
function passingRecord(address = 'somewhere'): Record<string, unknown> {
  return {
    address,
    status: 'pass',
    lastRun: '2026-08-10T00:00:00.000Z',
    elapsedSec: 10,
    attempts: 0,
    recentFailureSignatures: [],
    objective: { pass: true, failures: [] },
    consensus: { pass: true, min: 8, median: 9, spread: 0, rounds: 1 },
  };
}

function writeFixture(
  addresses: Record<string, Record<string, unknown>>,
  slugs = Object.keys(addresses),
): void {
  mkdirSync(join(dir, 'output'), { recursive: true });
  writeFileSync(
    join(dir, 'output/goldens.json'),
    JSON.stringify({ goldens: slugs.map(s => ({ slug: s, address: s })) }),
  );
  writeFileSync(
    join(dir, 'output/pipeline-state.json'),
    JSON.stringify({ version: 'v400', addresses }, null, 2),
  );
}

function runHook(stdin = '{"stop_hook_active":false}'): HookResult {
  const r = spawnSync('bash', [HOOK], {
    input: stdin,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    encoding: 'utf8',
  });
  let decision: HookResult['decision'] = null;
  const out = (r.stdout ?? '').trim();
  if (out.length > 0) decision = JSON.parse(out) as HookResult['decision'];
  return { status: r.status ?? -1, stdout: out, stderr: r.stderr ?? '', decision };
}

function readState(): { addresses: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dir, 'output/pipeline-state.json'), 'utf8'));
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cm-hook-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('check-pipeline-state stop hook', () => {
  it('never crashes on the fail-objective path (the NameError regression)', () => {
    writeFixture({
      flatiron: {
        ...passingRecord('175 5th Ave'),
        status: 'fail-objective',
        attempts: 1,
        objective: { pass: false, failures: ['footprint IoU 0.58 < 0.85'], footprintIoU: 0.58, heightErr: 0 },
        consensus: null,
      },
    });
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('Traceback');
    expect(r.stderr).not.toContain('NameError');
    expect(r.decision?.decision).toBe('block');
    expect(r.decision?.reason).toContain('fail objective gates');
  });

  it('exits silently when stop_hook_active is true (harness loop guard)', () => {
    writeFixture({
      flatiron: {
        ...passingRecord(), status: 'fail-objective',
        objective: { pass: false, failures: ['footprint IoU 0.1 < 0.85'] }, consensus: null,
      },
    });
    const r = runHook('{"stop_hook_active":true}');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('allows stopping when every golden passes', () => {
    writeFixture({ flatiron: passingRecord(), pennzoil: passingRecord() });
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.decision).toBeNull();
    expect(r.stderr).toContain('all 2 goldens pass');
  });

  it('blocks with a bootstrap instruction when a golden has no state record', () => {
    writeFixture({ flatiron: passingRecord() }, ['flatiron', 'newbie']);
    const r = runHook();
    expect(r.decision?.decision).toBe('block');
    expect(r.decision?.reason).toContain('--bootstrap');
    expect(r.decision?.reason).toContain('newbie');
  });

  it('does NOT block when consensus never ran (credential-blocked)', () => {
    // Rebuilding reproduces the identical report — blocking here is the loop
    // that burned 282 rebuilds. Report on stderr, allow the stop.
    writeFixture({
      geisel: {
        ...passingRecord(), status: 'fail-consensus',
        objective: { pass: true, failures: [] }, consensus: null,
      },
      pennzoil: passingRecord(),
    });
    const r = runHook();
    expect(r.decision).toBeNull();
    expect(r.stderr).toContain('consensus=null');
    expect(r.stderr).toContain('GEMINI_API_KEY');
  });

  it('blocks with a dimension-targeted lever when consensus scored low', () => {
    writeFixture({
      geisel: {
        ...passingRecord(), status: 'fail-consensus', attempts: 2,
        objective: { pass: true, failures: [] },
        consensus: {
          pass: false, min: 0, median: 1, spread: 0, rounds: 1,
          gemini: { color: 5, features: 0, massing: 3, overall: 2 },
          claude: { color: 5, features: 0, massing: 3, overall: 2 },
          gpt5: { color: 5, features: 0, massing: 3, overall: 2 },
        },
      },
    });
    const r = runHook();
    expect(r.decision?.decision).toBe('block');
    expect(r.decision?.reason).toContain('worst dimension: features');
    expect(r.decision?.reason).toContain('applyMaterialOverlay');
  });

  it('escalates a slug stuck on identical signatures', () => {
    writeFixture({
      geisel: {
        ...passingRecord(), status: 'fail-consensus', attempts: 6,
        recentFailureSignatures: Array(3).fill('fail-consensus:median=0,min=0'),
        objective: { pass: true, failures: [] },
        consensus: { pass: false, min: 0, median: 0, spread: 0, rounds: 1, gemini: { color: 0, features: 0, massing: 0, overall: 0 } },
      },
    });
    const r = runHook();
    expect(r.stderr).toContain('ESCALATED');
    expect(readState().addresses.geisel.status).toBe('needs-human-review');
  });

  it('de-escalates a stale escalation and resets its attempt tally', () => {
    // The escalation names a commit that is not HEAD (the fixture dir is not
    // even a git repo), so the verdict is stale: restore the real status and
    // zero the counter. Without the reset, the stale tally re-trips the hard
    // ceiling on the same run and the record is silently re-escalated —
    // exactly the one-way ratchet that left every golden terminal.
    writeFixture({
      guggenheim: {
        ...passingRecord(), status: 'needs-human-review', attempts: 55,
        reason: 'escalated by stop hook: 55 attempts exceeded hard ceiling 10',
        escalatedAtCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        recentFailureSignatures: Array(3).fill('fail-consensus:median=0,min=0'),
        objective: { pass: true, failures: [] },
        consensus: { pass: false, min: 0, median: 1, spread: 0, rounds: 1, gemini: { color: 0, features: 0, massing: 2, overall: 0 } },
      },
    });
    const r = runHook();
    expect(r.stderr).toContain('de-escalated');
    const rec = readState().addresses.guggenheim;
    expect(rec.status).toBe('fail-consensus');
    expect(rec.attempts).toBe(0);
    expect(rec.escalatedAtCommit).toBeUndefined();
  });

  it('never auto-clears a human-set needs-human-review', () => {
    writeFixture({
      geisel: {
        ...passingRecord(), status: 'needs-human-review',
        reason: 'human: source data is unusable, stop trying',
        objective: { pass: true, failures: [] }, consensus: null,
      },
      pennzoil: passingRecord(),
    });
    const r = runHook();
    expect(r.stderr).not.toContain('de-escalated');
    expect(readState().addresses.geisel.status).toBe('needs-human-review');
  });

  it('leaves non-golden records untouched', () => {
    writeFixture(
      {
        pennzoil: passingRecord(),
        'flatiron-qa': {
          ...passingRecord(), status: 'fail-consensus', attempts: 99,
          recentFailureSignatures: Array(3).fill('fail-consensus'),
          consensus: null,
        },
      },
      ['pennzoil'], // only pennzoil is a golden
    );
    const r = runHook();
    expect(r.status).toBe(0);
    const qa = readState().addresses['flatiron-qa'];
    expect(qa.status).toBe('fail-consensus'); // not escalated
    expect(qa.attempts).toBe(99);
  });

  it('tolerates a corrupt state file without crashing', () => {
    mkdirSync(join(dir, 'output'), { recursive: true });
    writeFileSync(join(dir, 'output/goldens.json'), JSON.stringify({ goldens: [{ slug: 'x', address: 'x' }] }));
    writeFileSync(join(dir, 'output/pipeline-state.json'), '{ not json at all');
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('Traceback');
    // Unknown state → treated as ungraded → bootstrap instruction.
    expect(r.decision?.reason).toContain('--bootstrap');
  });

  it('exits silently when there is no goldens config', () => {
    mkdirSync(join(dir, 'output'), { recursive: true });
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
