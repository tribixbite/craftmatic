/**
 * The contact-check COPY is the deliverable of audit item P1 #5, so it is
 * tested like code: the old wording ("✓ Verified: all N pieces form one
 * connected structure") claimed a certificate a voxel proximity test cannot
 * issue. These assertions pin the claim boundary.
 */

import { describe, it, expect } from 'vitest';
import { contactCheckStatus } from '../web/src/ui/contact-check-status.js';
import type {
  ConnectivityReport, DetachedComponent,
} from '../web/src/viewer/ldraw/connectivity-audit.js';

const REP = (over: Partial<ConnectivityReport> = {}): ConnectivityReport => ({
  pieces: 100, components: 1, largest: 100, largestPct: 100, detached: 0,
  detachedComponents: [], resolutionLDU: 4, toleranceLDU: 4,
  piecesWithoutGeometry: 0, detachedWithoutGeometry: 0,
  piecesWithSnaps: 20, snapOnlyUnions: 3,
  snapTable: { parts: 413, connectors: 1116 },
  groundedDetached: 0, airborneDetached: 0,
  isDetached: [], ...over,
});

const COMP = (over: Partial<DetachedComponent> = {}): DetachedComponent => ({
  size: 1, part: '3901.dat', pos: [0, 0, 0], kind: 'airborne',
  supportGapLDU: Infinity, heightAboveFloorLDU: 200, ...over,
});

describe('contactCheckStatus — one component', () => {
  const msg = contactCheckStatus(REP());

  it('does not claim verification or correct assembly', () => {
    expect(msg).not.toMatch(/verified/i);
    expect(msg).toMatch(/not proof of correct assembly/i);
  });

  it('discloses the tolerance that produced the verdict', () => {
    expect(msg).toContain('tolerance 4 LDU');
    expect(msg).toMatch(/designed gaps read as contact/);
  });

  it('discloses attachment-point coverage as a fraction of the model', () => {
    expect(msg).toMatch(/covered 20 piece\(s\), 20%/);
    expect(msg).toMatch(/joining 3 pair\(s\) surfaces alone missed/);
  });

  it('says so plainly when the attachment table covers nothing', () => {
    const m = contactCheckStatus(REP({ piecesWithSnaps: 0, snapOnlyUnions: 0 }));
    expect(m).toMatch(/no piece in this model is covered/);
  });

  it('discloses placements the audit never saw because the part is missing', () => {
    // 258 parsed, 256 rendered: the audit's percentages are over 256.
    const m = contactCheckStatus(REP({ pieces: 256 }), 258);
    expect(m).toMatch(/256 rendered pieces/);
    expect(m).toMatch(/2 placement\(s\) of the model's 258 never rendered/);
    // No claim when everything rendered.
    expect(contactCheckStatus(REP({ pieces: 256 }), 256)).not.toMatch(/never rendered/);
  });
});

describe('contactCheckStatus — detached groups', () => {
  const rep = REP({
    components: 4, largest: 90, largestPct: 90, detached: 10,
    groundedDetached: 2, airborneDetached: 1,
    detachedComponents: [
      COMP({ size: 4, part: '3901.dat', kind: 'airborne', heightAboveFloorLDU: 240 }),
      COMP({ size: 3, part: '3626b.dat', kind: 'grounded', supportGapLDU: 4, heightAboveFloorLDU: 0 }),
      COMP({ size: 3, part: '3024.dat', kind: 'grounded', supportGapLDU: 0, heightAboveFloorLDU: 0 }),
    ],
  });
  const msg = contactCheckStatus(rep);

  it('separates mid-air groups from grounded sub-builds and calls it a guess', () => {
    expect(msg).toMatch(/1 group\(s\) hang in mid-air/);
    expect(msg).toMatch(/2 rest on something/);
    expect(msg).toMatch(/deliberately separate sub-build/);
    expect(msg).toMatch(/GUESS from geometry, not intent/);
  });

  it('leads with the airborne group, not merely the largest', () => {
    expect(msg).toMatch(/Largest airborne group: 4 piece\(s\) \(3901\)/);
    expect(msg).toMatch(/nothing beneath it and 240 LDU above the floor/);
  });

  it('says red means inspect, not proof', () => {
    expect(msg).toMatch(/Red means inspect, not proof of a floater/);
  });

  it('subtracts geometry-less pieces from the count it presents', () => {
    const m = contactCheckStatus(REP({
      components: 3, largestPct: 90, detached: 10, detachedWithoutGeometry: 4,
      piecesWithoutGeometry: 4, groundedDetached: 2, airborneDetached: 0,
      detachedComponents: [COMP({ kind: 'grounded', supportGapLDU: 0 })],
    }));
    expect(m).toMatch(/6 piece\(s\) in 2 group\(s\) highlighted red/);
    expect(m).toMatch(/4 of them only appear unattached because their part geometry never loaded/);
    expect(m).toMatch(/4 piece\(s\) have no resolved geometry and cannot be judged/);
  });

  it('reports a finite support gap for an airborne group when one exists', () => {
    const m = contactCheckStatus(REP({
      components: 2, largestPct: 99, detached: 1, airborneDetached: 1,
      detachedComponents: [COMP({ supportGapLDU: 36, heightAboveFloorLDU: 120 })],
    }));
    expect(m).toMatch(/36 LDU clear of anything below/);
  });
});

it('handles an empty model', () => {
  expect(contactCheckStatus(REP({ pieces: 0, components: 0, largestPct: 0 })))
    .toBe('Nothing loaded to check.');
});
