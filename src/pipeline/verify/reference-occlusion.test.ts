import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureOcclusionManifest, classifyReferenceBytes, VEG_OCCLUSION_MIN } from './reference-occlusion.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cm-refocc-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const PANES = ['sv-front.jpg', 'sv-right.jpg', 'sv-rear.jpg', 'sv-left.jpg'];

describe('classifyReferenceBytes', () => {
  it('treats an undecodable file as clear, not as occluded', async () => {
    // An unreadable reference must not become a silent reason to stop
    // scoring an address.
    expect(await classifyReferenceBytes(new Uint8Array([0, 1, 2, 3]))).toBe('none');
  });
  it('exposes the same threshold the live capture path uses', () => {
    expect(VEG_OCCLUSION_MIN).toBe(0.30);
  });
});

describe('ensureOcclusionManifest', () => {
  it('returns {} for a directory that does not exist', async () => {
    expect(await ensureOcclusionManifest(join(dir, 'nope'), PANES)).toEqual({});
  });

  it('never overwrites an existing verdict (capture- or human-set)', async () => {
    // A human corrected sv-right after seeing it; re-running must preserve it.
    writeFileSync(join(dir, 'sv-right.jpg'), Buffer.from([0, 1, 2]));
    writeFileSync(join(dir, 'references.json'),
      JSON.stringify({ occlusion: { 'sv-right.jpg': 'trees' } }));
    const out = await ensureOcclusionManifest(dir, PANES);
    expect(out['sv-right.jpg']).toBe('trees');
    const onDisk = JSON.parse(readFileSync(join(dir, 'references.json'), 'utf8')) as
      { occlusion: Record<string, string> };
    expect(onDisk.occlusion['sv-right.jpg']).toBe('trees');
  });

  it('judges panes present on disk that carry no verdict', async () => {
    // The stale-orphan case: a capture returned 2 facades, so the other 2
    // panes linger from an older run with no verdict and would otherwise
    // default to usable.
    writeFileSync(join(dir, 'sv-front.jpg'), Buffer.from([9, 9, 9]));
    writeFileSync(join(dir, 'sv-rear.jpg'), Buffer.from([9, 9, 9]));
    writeFileSync(join(dir, 'references.json'),
      JSON.stringify({ occlusion: { 'sv-front.jpg': 'trees' } }));
    const out = await ensureOcclusionManifest(dir, PANES);
    expect(out['sv-front.jpg']).toBe('trees');   // preserved
    expect(out['sv-rear.jpg']).toBeDefined();    // newly judged (undecodable → none)
  });

  it('does not invent verdicts for panes that are absent', async () => {
    writeFileSync(join(dir, 'sv-front.jpg'), Buffer.from([9, 9, 9]));
    const out = await ensureOcclusionManifest(dir, PANES);
    expect(Object.keys(out)).toEqual(['sv-front.jpg']);
  });

  it('writes no manifest when there was nothing new to judge', async () => {
    const out = await ensureOcclusionManifest(dir, PANES);
    expect(out).toEqual({});
    expect(existsSync(join(dir, 'references.json'))).toBe(false);
  });
});
