/**
 * Cross-check of the lattice verifier against the viewer's `auditConnectivity`.
 *
 * The two answer the same question by different means: the verifier reads
 * stud / anti-stud cells off the vocabulary, the audit voxelises the written
 * `.ldr`'s real surfaces and unions anything touching within ~4 LDU. The audit
 * OVER-connects (a designed gap under 0.2 stud reads as contact), so on the
 * same model it may report the same or FEWER components than the lattice, never
 * more. More components in the audit than in the lattice means the written file
 * does not match the plan (an emit bug), or the lattice invented a joint.
 */
import { parseLDraw } from '../../engine/ldraw-parser.js';
import { auditConnectivity, type ConnectivityReport } from '../../viewer/ldraw/connectivity-audit.js';
import { resolvePartGeometry } from '../../viewer/ldraw/parts.js';
import { writeLdraw, PLACEHOLDER_IDENTITY, type WriterIdentity } from '../emit/ldraw-writer.js';
import type { BrickPlan } from '../types.js';
import { connectivity } from './connect.js';
import { placeAll, VOCABULARY_LOOKUP } from './world.js';

export interface CrossCheck {
  latticeComponents: number;
  auditComponents: number;
  /** True when the audit reports no MORE components than the lattice (the over-connecting direction). */
  consistent: boolean;
  audit: ConnectivityReport;
}

/**
 * Write the plan, parse it back and audit it. The audit reads part geometry
 * from the viewer's part cache, so every part the plan uses is resolved first
 * (served by the `/ldraw-parts` mirror in the app, or a mocked `fetch` in tests).
 */
export async function crossCheckConnectivity(plan: BrickPlan, identity: WriterIdentity = PLACEHOLDER_IDENTITY): Promise<CrossCheck> {
  const parts = [...new Set(plan.elements.map(e => e.part))];
  await Promise.all(parts.map(p => resolvePartGeometry(p.replace(/\.dat$/i, ''))));
  const audit = auditConnectivity(parseLDraw(writeLdraw(plan, identity)));
  const latticeComponents = connectivity(placeAll(plan.elements, VOCABULARY_LOOKUP).world).sizes.length;
  return { latticeComponents, auditComponents: audit.components, consistent: audit.components <= latticeComponents, audit };
}
