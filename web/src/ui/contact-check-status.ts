/**
 * User-facing copy for the contact-candidate check.
 *
 * Split out of lego.ts because the WORDING is the deliverable here: the audit's
 * finding (docs/lego-3d-generation-audit-2026-09-08.md P1 #5) was not that the
 * measurement is wrong but that the old copy — "✓ Verified: all N pieces form
 * one connected structure" — claimed far more than a voxel proximity test can
 * support. A pure string function can be tested against that claim.
 *
 * Every message states, in order: what was measured, the tolerance that
 * produced it, what the evidence does NOT cover, and what the user should do.
 */

import type { ConnectivityReport } from '@viewer/ldraw/connectivity-audit.js';

/**
 * Coverage/limit clause appended to every verdict.
 *
 * `modelPieces` is the parsed placement count. It can EXCEED `rep.pieces`:
 * a piece whose part never resolved is not instanced, so it never reaches the
 * audit at all. Saying "96% of 256 pieces" about a 258-piece model without
 * mentioning the two that were dropped is exactly the kind of quiet overclaim
 * this rewrite exists to remove.
 */
function limits(rep: ConnectivityReport, modelPieces?: number): string {
  const parts: string[] = [
    `contact tolerance ${rep.toleranceLDU} LDU (${(rep.toleranceLDU / 20).toFixed(2)} stud) — small designed gaps read as contact`,
  ];
  if (modelPieces != null && modelPieces > rep.pieces) {
    parts.push(`${(modelPieces - rep.pieces).toLocaleString()} placement(s) of the model's `
      + `${modelPieces.toLocaleString()} never rendered (part not in the library) and were not checked at all`);
  }
  if (rep.piecesWithSnaps > 0) {
    const pct = rep.pieces ? Math.round(100 * rep.piecesWithSnaps / rep.pieces) : 0;
    parts.push(`attachment points (clips/bars/pins/headgear) covered ${rep.piecesWithSnaps.toLocaleString()} piece(s), ${pct}%`
      + (rep.snapOnlyUnions > 0 ? `, joining ${rep.snapOnlyUnions.toLocaleString()} pair(s) surfaces alone missed` : ''));
  } else {
    parts.push('no piece in this model is covered by the attachment-point table, so clip/bar/pin joints rest on surface contact alone');
  }
  if (rep.piecesWithoutGeometry > 0) {
    parts.push(`${rep.piecesWithoutGeometry.toLocaleString()} piece(s) have no resolved geometry and cannot be judged`);
  }
  return parts.join('; ');
}

/**
 * The status line for a finished audit.
 *
 * Deliberately never says "verified" or "no floating pieces" — the strongest
 * honest claim for one component is "no piece was left unattached", and the
 * tolerance makes that the WEAKER direction of error (it over-connects).
 */
export function contactCheckStatus(rep: ConnectivityReport, modelPieces?: number): string {
  if (rep.pieces === 0) return 'Nothing loaded to check.';
  if (rep.components <= 1) {
    return `Contact check: every one of ${rep.pieces.toLocaleString()} rendered pieces has a detected attachment `
      + `to the main structure — no unattached piece found. This is not proof of correct assembly `
      + `(${limits(rep, modelPieces)}).`;
  }
  const real = rep.detached - rep.detachedWithoutGeometry;
  const groups = rep.components - 1;
  const air = rep.detachedComponents.filter(d => d.kind === 'airborne');
  const biggest = air[0] ?? rep.detachedComponents[0];
  const focus = biggest
    ? ` Largest ${biggest.kind} group: ${biggest.size} piece(s) (${biggest.part.replace(/\.dat$/i, '')})`
      + (biggest.kind === 'airborne' && Number.isFinite(biggest.supportGapLDU)
        ? `, ${Math.round(biggest.supportGapLDU)} LDU clear of anything below`
        : biggest.kind === 'airborne'
          ? `, nothing beneath it and ${Math.round(biggest.heightAboveFloorLDU)} LDU above the floor`
          : '')
      + '.'
    : '';
  const split = `${rep.airborneDetached} group(s) hang in mid-air (the suspicious class); `
    + `${rep.groundedDetached} rest on something — usually a deliberately separate sub-build `
    + `(minifigure, accessory, stand, second model), which is a GUESS from geometry, not intent.`;
  const geomNote = rep.detachedWithoutGeometry > 0
    ? ` ${rep.detachedWithoutGeometry.toLocaleString()} of them only appear unattached because their part geometry never loaded.`
    : '';
  return `Contact check: ${rep.largestPct}% of ${rep.pieces.toLocaleString()} rendered pieces attach to the main structure; `
    + `${real.toLocaleString()} piece(s) in ${groups} group(s) highlighted red.${geomNote} ${split}${focus} `
    + `Red means inspect, not proof of a floater (${limits(rep, modelPieces)}). Uncheck to restore colors.`;
}
