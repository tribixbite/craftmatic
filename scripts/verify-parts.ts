#!/usr/bin/env bun
import { getPartDims } from '../web/src/engine/ldraw-part-dims.js';

const parts = ['3024', '4592', '98138', '6141', '3024.dat', '4592.dat'];

console.log('Part lookup verification:\n');
parts.forEach(p => {
  const dims = getPartDims(p);
  console.log(`  getPartDims('${p}') → [${dims}]`);
});
