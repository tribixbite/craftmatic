/**
 * Header-lineage classification — offline, deterministic.
 *
 * Header samples are verbatim from the clego corpus (2026-08-28 v2
 * reconversion wave). The load-bearing invariant: the canonical
 * `0 !LINEAGE <tool> <good|partial>` stamp takes precedence over legacy
 * sniffing — v2 DBIX files ALSO start with `0 LEGO DBIX v2`, which the
 * legacy regex alone would misclassify as the warn-class.
 */
import { describe, expect, it } from 'vitest';
import { reconstructionQuality, sourceCaveat, DBIX_WARNING } from '../web/src/engine/source-quality';

// Verbatim from lego_sets/DbixConvV2/21063.ldr
const DBIX_V2_GOOD = `0 LEGO DBIX v2 21063
0 !LINEAGE reconvert_dbix_v2 good
0 Name: 21063
0 Author: reconvert_dbix.py
0 !LICENSE Redistributable under CCAL version 2.0 : see CAreadme.txt
0 // parts emitted 3451/3459 structural (99.77%); 0 sticker/brief instances excluded
1 288 810 -48 -60.4 0.0548 0 -0.9985 -0.9985 0 -0.0548 0 1 0 19119.dat
`;

// Verbatim from lego_sets/DbixConvV2/60502.ldr — good lineage + authored floaters
const DBIX_V2_FLOATING = `0 LEGO DBIX v2 60502
0 !LINEAGE reconvert_dbix_v2 good
0 Name: 60502
0 Author: reconvert_dbix.py
0 !LICENSE Redistributable under CCAL version 2.0 : see CAreadme.txt
0 // parts emitted 937/941 structural (99.57%); 14 sticker/brief instances excluded
0 DBIX FLOATING CLUSTER n=31 gap_ldu=69.0
1 511 769.6 -41.28 -10 1 0 0 0 1 0 0 0 1 973.dat
`;

const DBIX_V2_PARTIAL = `0 LEGO DBIX v2 99999
0 !LINEAGE reconvert_dbix_v2 partial
0 Name: 99999
1 0 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
`;

const DBIX_V2_MULTIMODEL = `0 LEGO DBIX v2 88888
0 !LINEAGE reconvert_dbix_v2 good
0 DBIX MULTIMODEL UNPLACED
1 0 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
`;

// Verbatim shape of legacy v1 output (lego_sets/LDR/72153.ldr class)
const DBIX_V1_LEGACY = `0 LEGO DBIX 72153
0 Name: 72153
0 Author: download_dbix_lxfml.py
1 350 1283.64 -1.49 303.597 1 0 0 0 1 0 0 0 1 96874.dat
`;

// Verbatim from lego_sets/IOModel2V2/21063.ldr
const IO_MODEL2_V2 = `0 !LINEAGE io_model2_v2 good
0 Source: IO/21063.io model2.ldr
0 Name: 21063
0 Flattened by flatten_io_model2.py (MPD-aware recursive transform accumulation; colors BL->LDraw mapped)
1 0 80 -8 -180 1 0 0 0 1 0 0 0 1 2445.dat
`;

const CONVERT_LXF = `0 FILE model.ldr
0 Author: convert_lxf.py
1 21 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
`;

const RECON_V3 = `0 Model reconstructed by recon_v3 from instruction pages
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
`;

const PLAIN_OMR = `0 FILE main.ldr
0 Name: 8880 Super Car
0 Author: Somebody [handle]
1 0 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
`;

describe('reconstructionQuality', () => {
  it('trusts a good !LINEAGE stamp over the legacy DBIX header on the same file', () => {
    expect(reconstructionQuality(DBIX_V2_GOOD)).toBe('good');
    expect(reconstructionQuality(DBIX_V2_FLOATING)).toBe('good');
    expect(reconstructionQuality(IO_MODEL2_V2)).toBe('good');
  });

  it('maps partial lineage and unplaced multi-model to approximate', () => {
    expect(reconstructionQuality(DBIX_V2_PARTIAL)).toBe('approximate');
    expect(reconstructionQuality(DBIX_V2_MULTIMODEL)).toBe('approximate');
  });

  it('still flags legacy v1 DBIX (no lineage stamp) as the dbix warn-class', () => {
    expect(reconstructionQuality(DBIX_V1_LEGACY)).toBe('dbix');
  });

  it('keeps the legacy broken/approximate sniffs', () => {
    expect(reconstructionQuality(CONVERT_LXF)).toBe('broken');
    expect(reconstructionQuality(RECON_V3)).toBe('approximate');
  });

  it('classifies plain OMR/authored files as good', () => {
    expect(reconstructionQuality(PLAIN_OMR)).toBe('good');
  });
});

describe('sourceCaveat', () => {
  const q = reconstructionQuality;

  it('is silent for clean good sources', () => {
    expect(sourceCaveat(PLAIN_OMR, q(PLAIN_OMR))).toBeNull();
    expect(sourceCaveat(DBIX_V2_GOOD, q(DBIX_V2_GOOD))).toBeNull();
    expect(sourceCaveat(IO_MODEL2_V2, q(IO_MODEL2_V2))).toBeNull();
  });

  it('surfaces the authored floating cluster with its count', () => {
    expect(sourceCaveat(DBIX_V2_FLOATING, q(DBIX_V2_FLOATING))).toContain('31 parts');
  });

  it('names the synthetic layout for unplaced multi-model sets', () => {
    expect(sourceCaveat(DBIX_V2_MULTIMODEL, q(DBIX_V2_MULTIMODEL))).toContain('side-by-side');
  });

  it('distinguishes partial-lineage from vision reconstruction wording', () => {
    expect(sourceCaveat(DBIX_V2_PARTIAL, q(DBIX_V2_PARTIAL))).toContain('artially recovered');
    expect(sourceCaveat(RECON_V3, q(RECON_V3))).toContain('vision-based');
  });

  it('keeps the legacy DBIX warning', () => {
    expect(sourceCaveat(DBIX_V1_LEGACY, q(DBIX_V1_LEGACY))).toBe(DBIX_WARNING);
  });
});
