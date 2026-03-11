/**
 * Parse a LEGO Digital Designer .lxf file → ParsedBrick[].
 *
 * LXF is a plain ZIP archive containing IMAGE100.LXFML (XML).
 * LXFML structure:
 *   <LXFML>
 *     <Bricks>
 *       <Brick designID="3001">
 *         <Part materials="21,...">
 *           <Bone transformation="r00,r01,...,tx,ty,tz"/>
 *         </Part>
 *       </Brick>
 *     </Bricks>
 *   </LXFML>
 *
 * Coordinate system: LDD uses cm units, Y-up.
 * Conversion: multiply by 25 to get LDU (1cm = 25 LDU), negate Y (LDraw is Y-down).
 */

import { extractFile } from './zip-utils';
import { lddToLDraw } from './ldd-colors';
import type { ParsedBrick } from './ldraw-parser';

/** 1 cm = 25 LDraw units (1 stud = 0.8cm = 20 LDU → 1cm = 25 LDU) */
const CM_TO_LDU = 25;

export async function parseLxf(buffer: ArrayBuffer): Promise<ParsedBrick[]> {
  const xmlBytes = await extractFile(buffer, 'IMAGE100.LXFML');
  const xmlText = new TextDecoder('utf-8').decode(xmlBytes);

  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) throw new Error(`LXFML parse error: ${parserError.textContent?.slice(0, 120)}`);

  const bricks: ParsedBrick[] = [];

  for (const brick of doc.querySelectorAll('Brick')) {
    const designID = brick.getAttribute('designID') ?? '3001';
    const part = `${designID}.dat`;

    const partEl = brick.querySelector('Part');
    const materialsAttr = partEl?.getAttribute('materials') ?? '';
    const materialId = parseInt(materialsAttr.split(',')[0], 10) || 194;
    const color = lddToLDraw(materialId);

    const bone = brick.querySelector('Bone');
    if (!bone) continue;

    const tf = bone.getAttribute('transformation');
    if (!tf) continue;

    const vals = tf.split(',').map(Number);
    if (vals.length < 12) continue;

    // vals[0..8]: row-major rotation matrix (LDD Y-up convention)
    // vals[9..11]: translation in cm
    const tx = vals[9];
    const ty = vals[10];
    const tz = vals[11];

    // Convert LDD rotation to LDraw: flip Y axis via R_ldraw = C × R_ldd × C
    // where C = diag(1,-1,1). Result: negate elements at row=1 XOR col=1.
    const rot: number[] = [
       vals[0], -vals[1],  vals[2],
      -vals[3],  vals[4], -vals[5],
       vals[6], -vals[7],  vals[8],
    ];

    bricks.push({
      color,
      x:  tx * CM_TO_LDU,
      y: -ty * CM_TO_LDU, // LDD Y-up → LDraw Y-down
      z:  tz * CM_TO_LDU,
      rot,
      part,
    });
  }

  if (bricks.length === 0) throw new Error('No brick placements found in LXFML');
  return bricks;
}
