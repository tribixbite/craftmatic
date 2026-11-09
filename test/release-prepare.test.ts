/** Pure parts of `release.ts prepare` (D-08): checksums, waivers, preconditions, approval sheet, channel stubs. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSha256sums, sha256Hex, sha256sumsText, verifySums } from '../web/src/release/checksums.js';
import {
  applyWaivers, approvalItems, channelStub, CHANNELS, openGates, pendingGates, preconditionProblems, renderApproval, resolveVersion,
  type Gate,
} from '../web/src/release/prepare.js';
import type { ProductRecord } from '../web/src/release/types.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const actions = JSON.parse(readFileSync(join(__dirname, '..', 'release', 'approval-actions.json'), 'utf8'));
const product = (JSON.parse(readFileSync(join(__dirname, '..', 'release', 'products', 'sampler.json'), 'utf8')) as ProductRecord);

describe('release-prepare: checksums', () => {
  it('writes GNU format, sorted, two spaces, and round trips', () => {
    const text = sha256sumsText([{ name: 'b.txt', data: enc('b') }, { name: 'a/x.bin', data: enc('a') }]);
    expect(text).toBe(`${sha256Hex('a')}  a/x.bin\n${sha256Hex('b')}  b.txt\n`);
    const entries = parseSha256sums(text);
    expect(verifySums(entries, n => (n === 'b.txt' ? enc('b') : n === 'a/x.bin' ? enc('a') : undefined))).toEqual([]);
  });

  it('reports a byte that differs and a file that is missing', () => {
    const entries = parseSha256sums(sha256sumsText([{ name: 'a', data: enc('a') }, { name: 'b', data: enc('b') }]));
    expect(verifySums(entries, n => (n === 'a' ? enc('A') : undefined))).toEqual(['a: sha256 differs', 'b: missing']);
  });

  it('refuses names sha256sum cannot read back', () => {
    expect(() => sha256sumsText([{ name: 'a\\b', data: enc('') }])).toThrow(/cannot list/);
    expect(() => sha256sumsText([{ name: '*star', data: enc('') }])).toThrow(/cannot list/);
    expect(() => sha256sumsText([{ name: 'a', data: enc('') }, { name: 'a', data: enc('') }])).toThrow(/duplicate/);
    expect(() => parseSha256sums('nonsense\n')).toThrow(/not a SHA256SUMS line/);
  });
});

describe('release-prepare: preconditions', () => {
  const facts = { product, ledger: [], version: { major: 1, minor: 0, patch: 0 }, dirtyFiles: [], bunVersion: product.toolchain.bun, lockfileSha256: product.toolchain.lockfileSha256, ldrawArchiveSha256: null };

  it('the sampler is refused for its null namespace, its placeholders and its null publisher', () => {
    const problems = preconditionProblems(facts).join('\n');
    expect(problems).toMatch(/namespace is null/);
    expect(problems).toMatch(/placeholders \(namespace/);
    expect(problems).toMatch(/no publisher/);
    expect(problems).toMatch(/not pinned/);
  });

  it('a dirty tree, a stale pin and a version that does not rise are each named', () => {
    const ready: ProductRecord = { ...product, identity: { ...product.identity, namespace: 'tst_sampler' }, placeholders: [], publisher: { name: 'n', contactEmail: 'c@example.invalid' }, toolchain: { ...product.toolchain, ldrawLibrary: { ...product.toolchain.ldrawLibrary, sha256: 'a'.repeat(64) } } };
    expect(preconditionProblems({ ...facts, product: ready, ldrawArchiveSha256: 'a'.repeat(64) })).toEqual([]);
    const ledger = [{ product: 'sampler', version: '1.0.0', namespace: 'tst_sampler', uuids: ready.identity.uuids, entityIds: [], blockIds: [], itemIds: [], sha256: {} }];
    const bad = preconditionProblems({ ...facts, product: ready, ledger, dirtyFiles: ['x.ts'], bunVersion: '0.0.1', lockfileSha256: 'b'.repeat(64), ldrawArchiveSha256: 'c'.repeat(64) }).join('\n');
    expect(bad).toMatch(/not clean/);
    expect(bad).toMatch(/must rise above the released 1\.0\.0/);
    expect(bad).toMatch(/bun is 0\.0\.1/);
    expect(bad).toMatch(/bun\.lock sha256/);
    expect(bad).toMatch(/LDraw complete\.zip sha256/);
  });

  it('chooses 1.0.0 first, then the next patch', () => {
    expect(resolveVersion('p', [])).toEqual({ major: 1, minor: 0, patch: 0 });
    const entry = { product: 'p', version: '1.2.3', namespace: 'a_b', uuids: product.identity.uuids, entityIds: [], blockIds: [], itemIds: [], sha256: {} };
    expect(resolveVersion('p', [entry])).toEqual({ major: 1, minor: 2, patch: 4 });
    expect(resolveVersion('p', [entry], '2.0.0')).toEqual({ major: 2, minor: 0, patch: 0 });
  });
});

describe('release-prepare: waivers and open gates', () => {
  it('a waiver covers only the problem it names and needs a reason', () => {
    const w = [{ gate: 'g', pattern: 'permutations', reason: 'M03' }];
    const r = applyWaivers('g', ['11008 permutations', 'a texture at a vanilla path'], w);
    expect(r.waived.map(x => x.problem)).toEqual(['11008 permutations']);
    expect(r.uncovered).toEqual(['a texture at a vanilla path']);
    expect(applyWaivers('other', ['11008 permutations'], w).uncovered).toHaveLength(1);
    expect(() => applyWaivers('g', ['x'], [{ gate: 'g', pattern: 'x', reason: ' ' }])).toThrow(/needs a pattern and a reason/);
  });

  it('skipped, not-run and waived gates are open; pending stages are skipped with a dependency named', () => {
    const gates: Gate[] = [
      { id: 'a', title: '', status: 'pass', detail: '' }, { id: 'b', title: '', status: 'waived', detail: 'x' },
      { id: 'c', title: '', status: 'not-run', detail: 'x' }, ...pendingGates(),
    ];
    expect(openGates(gates).map(g => g.id)).toEqual(['b', 'c', 'brick-blocks', 'placement', 'sim']);
    for (const g of pendingGates()) expect(g.detail).toMatch(/M03|M07|M14/);
  });
});

describe('release-prepare: approval sheet', () => {
  const items = approvalItems(actions, { product: 'p', version: '1.0.0', commit: 'abc' });

  it('every outward action is listed unchecked in order, with the tag command printed and not run', () => {
    expect(items.every(i => i.approved === false && i.approver === 'user')).toBe(true);
    const text = renderApproval({ product: 'p', version: '1.0.0', commit: 'abc', fixture: true, gates: pendingGates(), items, artifacts: [] });
    const boxes = text.split('\n').filter(l => /^- \[.\] /.test(l));
    expect(boxes).toHaveLength(items.length);
    expect(boxes.every(l => l.startsWith('- [ ] '))).toBe(true);
    expect(text).toContain('git tag -a p-v1.0.0 abc');
    expect(text).toMatch(/TEST FIXTURE/);
    expect(text).toMatch(/Open gates \(3\)/);
  });

  it('has a stub for every channel naming D-09', () => {
    for (const c of CHANNELS) {
      const stub = channelStub(c, items);
      expect(JSON.parse(stub['fields.json']).status).toBe('stub');
      expect(stub['CHECKLIST.md']).toContain('- [ ]');
    }
  });
});
