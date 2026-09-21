import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  coercePipelineStamp, currentPipelineStamp, describePackVersion, packDisplayName, packProvenance, packVersionAt,
  pipelineStampText, provenanceSentence, sha256Hex, sourceHash12, unstampedPipeline, type PipelineStamp,
} from '../web/src/engine/pipeline-version.js';
import { exportVersion, packIdentity, deterministicUuid } from '../web/src/engine/mcpack.js';

const stamped = (over: Partial<PipelineStamp> = {}): PipelineStamp => ({
  kind: 'stamped', hash: '49fae8fe5a75', files: 66, commit: '7d6da6cf', date: '2026-09-21', head: 'b94a985f', headDate: '2026-09-21',
  dirty: false, dirtyFiles: [], treeDirty: false, shallow: false, computedAt: '2026-09-23T10:11:12.000Z', ...over,
});

describe('pipeline stamp text (the pack NAME)', () => {
  it('reads date first, then the commit, for a clean tree', () => {
    expect(pipelineStampText(stamped())).toBe('2026-09-21 7d6da6cf');
  });
  it('says +dirty and dates the stamp itself when the closure has uncommitted edits', () => {
    const text = pipelineStampText(stamped({ dirty: true, dirtyFiles: ['web/src/engine/mcpack.ts'] }));
    expect(text).toBe('2026-09-23 7d6da6cf+dirty');
    expect(text).not.toBe(pipelineStampText(stamped())); // a dirty build can never read as the clean commit
  });
  it('falls back to the content hash without git, and to "unstamped" with nothing', () => {
    expect(pipelineStampText(stamped({ commit: null, date: null, head: null, headDate: null }))).toBe('hash 49fae8fe5a75');
    expect(pipelineStampText(unstampedPipeline())).toBe('unstamped');
  });
  it('composes the display name with the stamp LAST and the role preserved', () => {
    expect(packDisplayName('Hogwarts Castle (71043)', 'Playable', stamped())).toBe('Hogwarts Castle (71043) — Playable (2026-09-21 7d6da6cf)');
    expect(packDisplayName('Hogwarts Castle (71043)', 'Playable Resources', stamped())).toBe('Hogwarts Castle (71043) — Playable Resources (2026-09-21 7d6da6cf)');
    expect(packDisplayName('Colosseum (10276)', null, unstampedPipeline())).toBe('Colosseum (10276) (unstamped)');
  });
  it('never enters the manifest UUID derivation: identity is the raw stem/label', () => {
    // The uuid is keyed on packIdentity(stem, label); the display name is a separate
    // composition. Two builds with different stamps must share every uuid.
    const identity = packIdentity('Hogwarts-Castle-71043', 'Hogwarts Castle (71043)');
    const uuid = deterministicUuid(`craftmatic.addon.bp.header:${identity}`);
    const a = packDisplayName('Hogwarts Castle (71043)', 'Playable', stamped());
    const b = packDisplayName('Hogwarts Castle (71043)', 'Playable', stamped({ commit: 'deadbeef', dirty: true }));
    expect(a).not.toBe(b);
    expect(deterministicUuid(`craftmatic.addon.bp.header:${packIdentity('Hogwarts-Castle-71043', 'Hogwarts Castle (71043)')}`)).toBe(uuid);
    expect(packIdentity('Hogwarts-Castle-71043', a)).not.toBe(identity); // what feeding the name in WOULD do — the guard the patch must keep
  });
});

describe('injected stamp coercion', () => {
  it('reports unstamped under vitest, where nothing was injected', () => {
    const s = currentPipelineStamp();
    expect(s.kind).toBe('unstamped');
    expect(s.hash).toBeNull();
    expect(s.reason).toContain('not injected');
  });
  it('rejects junk and hand-edited values instead of trusting them', () => {
    expect(coercePipelineStamp(undefined).kind).toBe('unstamped');
    expect(coercePipelineStamp('2026-09-21').kind).toBe('unstamped');
    expect(coercePipelineStamp({ kind: 'stamped', hash: 'not-hex' }).kind).toBe('unstamped');
    expect(coercePipelineStamp({ kind: 'stamped', hash: '49fae8fe5a75', commit: 'zz' }).commit).toBeNull();
  });
  it('keeps a dirty stamp dirty, even when only the file list says so', () => {
    const s = coercePipelineStamp({ ...stamped({ dirty: false, dirtyFiles: ['web/src/engine/mcpack.ts'] }) });
    expect(s.dirty).toBe(true);
    expect(pipelineStampText(s)).toContain('+dirty');
  });
  it('round-trips a clean stamp unchanged', () => {
    const s = stamped();
    expect(coercePipelineStamp(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('pack version [YYMM, DDHH, MMSS]', () => {
  it('encodes a UTC instant readably and decodes back', () => {
    const v = packVersionAt(Date.UTC(2026, 8, 21, 14, 30, 59));
    expect(v).toEqual([2609, 2114, 3059]);
    expect(describePackVersion(v)).toBe('2026-09-21T14:30:59Z');
  });
  it('is monotonic across second, minute, hour, day, month and year boundaries and stays under 32767', () => {
    const instants = [
      Date.UTC(2026, 0, 1, 0, 0, 0), Date.UTC(2026, 0, 1, 0, 0, 1), Date.UTC(2026, 0, 1, 0, 0, 59), Date.UTC(2026, 0, 1, 0, 1, 0),
      Date.UTC(2026, 0, 1, 0, 59, 59), Date.UTC(2026, 0, 1, 1, 0, 0), Date.UTC(2026, 0, 1, 23, 59, 59), Date.UTC(2026, 0, 2, 0, 0, 0),
      Date.UTC(2026, 0, 31, 23, 59, 59), Date.UTC(2026, 1, 1, 0, 0, 0), Date.UTC(2026, 11, 31, 23, 59, 59), Date.UTC(2027, 0, 1, 0, 0, 0),
      Date.UTC(2099, 11, 31, 23, 59, 59),
    ];
    const versions = instants.map(t => packVersionAt(t));
    const key = (v: [number, number, number]) => v[0] * 1e8 + v[1] * 1e4 + v[2];
    const keys = versions.map(key);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    expect(new Set(keys).size).toBe(keys.length);
    expect(versions.every(v => v.every(part => Number.isInteger(part) && part >= 0 && part <= 32_767))).toBe(true);
  });
  it('ranks NEWER than every version the previous time-derived encoding produced', () => {
    // The old scheme's first component is 2 until 2060; the new one starts at 2601.
    const legacy = exportVersion(Date.UTC(2059, 11, 31));
    expect(packVersionAt(Date.UTC(2026, 0, 1))[0]).toBeGreaterThan(legacy[0]);
  });
  it('refuses a non-finite or out-of-range instant', () => {
    expect(() => packVersionAt(Number.NaN)).toThrow('finite');
    expect(() => packVersionAt(Date.UTC(2025, 11, 31))).toThrow('2026-2099');
    expect(() => packVersionAt(Date.UTC(2100, 0, 1))).toThrow('2026-2099');
  });
});

describe('provenance record', () => {
  it('names the source file, its hash and the pipeline in the description sentence', () => {
    const src = { file: '10303 Loop Coaster.io', hash: '86be53059ff4', origin: 'index' as const, path: 'IO/10303 Loop Coaster.io' };
    expect(provenanceSentence(stamped(), src)).toBe('Built from 10303 Loop Coaster.io (86be53059ff4) by pipeline 49fae8fe5a75 @ 7d6da6cf.');
    expect(provenanceSentence(stamped({ dirty: true }), { ...src, hash: null })).toBe('Built from 10303 Loop Coaster.io (unhashed) by pipeline 49fae8fe5a75 @ 7d6da6cf+dirty.');
    expect(provenanceSentence(unstampedPipeline(), null)).toBe('Built from an unrecorded source by pipeline unstamped.');
  });
  it('assembles the same record for the same inputs', () => {
    const args = { stamp: stamped(), source: { file: 'a.ldr', hash: 'abcdefabcdef', origin: 'cli' as const }, version: [2609, 2114, 3059] as [number, number, number], builtAt: '2026-09-21T14:30:59.000Z' };
    expect(packProvenance(args)).toEqual(packProvenance(args));
    const rec = packProvenance(args);
    expect(rec.packVersion.encodes).toBe('2026-09-21T14:30:59Z');
    expect(rec.display).toBe('2026-09-21 7d6da6cf');
    expect(rec.pipeline).toBe(args.stamp);
  });
});

describe('pure sha256', () => {
  const node = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  it('matches the published vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('agrees with node crypto across the padding boundaries and a multi-MB buffer', () => {
    for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 65_537]) {
      const b = new Uint8Array(n).map((_, i) => (i * 131 + 7) & 0xff);
      expect(sha256Hex(b), `length ${n}`).toBe(node(b));
    }
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i ^ (i >> 8)) & 0xff);
    expect(sourceHash12(big)).toBe(node(big).slice(0, 12));
    expect(sourceHash12(big.buffer)).toBe(node(big).slice(0, 12));
  });
});
