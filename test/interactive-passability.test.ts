/**
 * PASSABILITY over real sets: build the pack exactly as the CLI does
 * (`scripts/_playable_ref.ts`: the auto minifig scale, the default
 * brick-accurate building), read it back as the walk preview does, and walk a
 * 0.6 x 1.8 player through every doorway over the collider blocks the pack
 * ships plus the closed leaves its runtime lays (engine/interactive-walk.ts).
 *
 * The contract, per doorway, size and quarter turn (`verdictOf` in
 * engine/interactive-walk.ts):
 *   - CLOSED, nobody gets through the doorway;
 *   - OPEN at a size where the opening clears the player's 1 x 2-block
 *     passage (`passSize`), a player walks through it;
 *   - OPEN below that size it stays blocked (the runtime keeps the leaf's
 *     colliders on purpose and says which size passes).
 * A doorway whose approach the MODEL closes (solid behind it, or a rise past
 * the jump: SEALED / STEP) is reported by the CLI, not failed here; each set
 * must still have at least `minOkAt100` doorways a player walks through at
 * 100 %.
 *
 * Sets: 31141 (a street of shops: a modular building with two 45-degree
 * corner doors), 10022 (a Santa Fe passenger car: a vehicle with four train
 * doors, exported static) and 76417 (Gringotts: the bank's double front doors
 * 8 degrees off the grid and two leaves at 45 degrees). Needs the clego corpus
 * and the Studio library; skips without them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { QuarterTurn } from '../web/src/engine/bedrock-collider-scale.js';

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const CORPUS = 'C:/git/clego/lego_sets';
const SETS: Array<{ set: string; file: string; minDoorways: number; minOkAt100: number }> = [
  { set: '31141', file: `${CORPUS}/IOModel2V2/31141.ldr`, minDoorways: 5, minOkAt100: 4 },
  { set: '10022', file: `${CORPUS}/IOModel2V2/10022.ldr`, minDoorways: 4, minOkAt100: 1 },
  { set: '76417', file: `${CORPUS}/DbixConvV3/76417.ldr`, minDoorways: 4, minOkAt100: 3 },
  // The device round's other two door packs (2026-09-24d): 76457's six doors, 41732's raised shop threshold.
  { set: '76457', file: `${CORPUS}/DbixConvV3/76457.ldr`, minDoorways: 6, minOkAt100: 6 },
  { set: '41732', file: `${CORPUS}/DbixConvV3/41732.ldr`, minDoorways: 6, minOkAt100: 5 },
];
const HAVE = existsSync(LDRAW_ROOT) && SETS.every(s => existsSync(s.file));

/** Build a pack in-process the way `_playable_ref.ts` does. */
async function buildPack(file: string, label: string): Promise<ArrayBuffer> {
  const { parseLDrawDocument, embeddedPartTexts } = await import('../web/src/engine/ldraw-parser.js');
  const { seedDatTexts, setLDrawRoot } = await import('../web/src/engine/ldraw-geometry.js');
  const { synthesizeLSynth } = await import('../web/src/engine/lsynth.js');
  const { runSchemPipeline } = await import('../web/src/engine/schem-pipeline.js');
  const { planResolutionAtCell, spanOfBricks, DEFAULT_SCHEM_SETTINGS } = await import('../web/src/engine/schem-settings.js');
  const { planAddonScale } = await import('../web/src/engine/addon-scale.js');
  const { LDU_PER_BLOCK } = await import('../web/src/engine/lego-scale.js');
  setLDrawRoot(LDRAW_ROOT);
  const doc = parseLDrawDocument(synthesizeLSynth(readFileSync(file, 'utf8')).text);
  seedDatTexts(embeddedPartTexts(doc));
  const scale = planAddonScale(doc.bricks, 'auto', label);
  const plan = planResolutionAtCell(spanOfBricks(doc.bricks), scale.lduPerBlock);
  const result = await runSchemPipeline({
    source: { kind: 'bricks', bricks: doc.bricks, colorSpace: 'ldraw', options: { cellLDU: plan.cellLDU, maxDim: 700 } },
    format: 'mcaddon', packStem: label, packLabel: label, profile: DEFAULT_SCHEM_SETTINGS.profile,
    lightFill: false, shapes: false, vehicleMode: 'auto', vehicleFacing: 'auto', entityQuality: 'balanced',
    buildingFidelity: 'bricks', modelScale: Math.round(LDU_PER_BLOCK / plan.cellLDU * 1000) / 1000, lod: 'hull',
  });
  const bytes = result.bytes!;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe.skipIf(!HAVE)('doorways of real sets are passable open and blocked closed', () => {
  for (const { set, file, minDoorways, minOkAt100 } of SETS) {
    it(`${set}: every doorway, at 100 and 200 percent, turned 0 and 90`, async () => {
      const { loadAddonPreviewModel, treadBlocksAt } = await import('../web/src/ui/addon-preview-data.js');
      const { verdictOf, walkThroughDoorway } = await import('../web/src/engine/interactive-walk.js');
      const bytes = await buildPack(file, set);
      const model = await loadAddonPreviewModel(bytes);
      // The tap boxes the pack ships keep to their own parts and off the seats.
      const { auditPackHitboxes } = await import('../web/src/engine/interactive-hitbox-audit.js');
      const audit = await auditPackHitboxes(bytes);
      expect([...audit.partOverlaps, ...audit.seatOverlaps, ...audit.missing], `${set} tap boxes`).toEqual([]);
      const cfg = model.interactives;
      expect(cfg, `${set} ships no scripts/interactives.js`).toBeTruthy();
      const doorways = cfg!.items.map((it, i) => ({ it, i })).filter(({ it }) => it.passSize !== undefined && it.blocking.length);
      expect(doorways.length, `${set} doorways`).toBeGreaterThanOrEqual(minDoorways);
      const pack = { cells: model.cells, dims: model.dims, interactives: cfg!, shippedTreads: (s: number, r: QuarterTurn) => treadBlocksAt(model, s, r) };
      const failures: string[] = [];
      let okAt100 = 0;
      for (const { it, i } of doorways) for (const size of [100, 200]) for (const rot of [0, 90] as QuarterTurn[]) {
        const open = walkThroughDoorway(pack, i, size, rot, true);
        const closed = walkThroughDoorway(pack, i, size, rot, false);
        const passed100 = size > 100 && walkThroughDoorway(pack, i, 100, rot, true).outcome === 'passed';
        const verdict = verdictOf(open, closed, passed100);
        if (verdict === 'FAIL') failures.push(`${set} ${it.label} (${it.kind}, opening ${JSON.stringify(it.opening)}, passable from ${it.passSize} %) at ${size} % turn ${rot}: open ${open.outcome}, closed ${closed.outcome} ${JSON.stringify(open.directions)}`);
        if (verdict === 'OK' && size === 100 && rot === 0) {
          okAt100++;
          // Walked, not jumped: a raised threshold gets a tread (device 2026-09-24d stopped short of 41732's).
          if (!open.directions.some(d => d.outcome === 'passed' && d.jumps === 0)) failures.push(`${where}: passes only with a jump`);
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
      expect(okAt100, `${set}: doorways walked through at 100 %`).toBeGreaterThanOrEqual(minOkAt100);
    }, 600_000);
  }
});
