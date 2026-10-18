#!/usr/bin/env bun
// Parts we need to understand:
// 60067-1: 3820 (×6), peghole (×3), 3626c (×3), 3024 (×2), 4592 (×2)
// 8855-1: 2701 (×4), r04o1000 (×4), 2702 (×2), 2740s01 (×1)
// 42049-1: connhol3 (×14), peghole (×8), 6141 (×7), npeghol2 (×2)

// These look like:
// - peghole*, npeghol* = peg holes (Technic connector holes, likely 1×1)
// - connhol3 = connector hole (Technic, likely 1×1)
// - 3820 = likely minifig hand
// - 3626c = likely minifig head variant
// - 2701, 2702 = aircraft parts (fuselage/cockpit, likely small)
// - r04o1000 = likely a rotor or roundel part
// - 2740s01 = likely a shell/fuselage piece

// Looking up from LDraw library would be best. Let's check what we have in generated dims.

import { GENERATED_DIMS } from '../web/src/engine/ldraw-part-dims-generated.js';

const unknownParts = [
  '3820', '3626c', '2701', 'r04o1000', '2702', '2740s01', 
  'peghole', 'npeghol2', 'npeghol3', 'npeghol7', 'connhol3',
  'connect', 'axl3hole', 'axlehol4'
];

console.log('Checking GENERATED_DIMS for unknown parts:\n');
unknownParts.forEach(part => {
  const key = part.toLowerCase().replace('.dat', '');
  const dims = GENERATED_DIMS[key];
  if (dims) {
    console.log(`  ${key.padEnd(16)} → [${dims}] ✓`);
  } else {
    console.log(`  ${key.padEnd(16)} → NOT FOUND (will fallback to [1,1,1])`);
  }
});
