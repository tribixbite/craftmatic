/**
 * Direct LDraw-to-Bedrock Entity Geometry Compiler.
 *
 * Implements Pillar 1 & Pillar 2 of the 4-Pillar Render-to-Voxel Architecture:
 * Bypasses the coarse 1m voxel grid completely for playable vehicles.
 * Translates parsed LDraw bricks directly into Bedrock .geo.json cuboids at true
 * player proportions (1 stud = 3.2 units = 0.2m), emitting rotated bones for
 * angled slopes/wings, transparent meshes for cockpit canopies, and exact
 * cockpit seating coordinates for authentic in-cockpit first-person driving/flight.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import type { PlayableKind, VehicleFacing } from './playable-components.js';
import { getPartDims } from './ldraw-part-dims.js';
import { ldrawColorToBlock } from './ldraw-colors.js';

const PACK_NAMESPACE = 'craftmatic';

/** Scale: 3.2 Bedrock units per stud (20 LDU). 1 block = 16 units = 5 studs. */
export const BEDROCK_UNITS_PER_LDU = 3.2 / 20; // 0.16

/** Known transparent canopy and windshield LDraw part IDs */
const CANOPY_PARTS = new Set([
  '35654', '65633', '4594', '2483', '2437', '3823', '4872', '57783',
  '62360', '84954', '92579', '98834', '4474', '2447', '50747', '62576',
  '23447', '30372', '58181', '48288', '60581', '60803', '59349', '87544',
  '3065', '3066', '3067'
]);

/** Known steering wheel and seat part IDs */
const SEAT_PARTS = new Set([
  '4079', '4079b', '3829', '3829c01', '73081', '2432'
]);

/** Technic internal pins and axles that add geometry weight without visual silhouette */
const TECHNIC_INTERNAL = new Set([
  '2780', '3673', '3749', '6558', '32054', '4274', '43093', '3705', '3706', '3707', '3708', '6587'
]);

function isTransparentBrick(b: ParsedBrick): boolean {
  const p = b.part.replace(/^.*[/\\]/, '').replace(/\.dat$/i, '').toLowerCase();
  if (CANOPY_PARTS.has(p)) return true;
  // LDraw transparent color IDs (33..47, 52, 54, 57, 111)
  const c = b.color;
  return (c >= 33 && c <= 47) || c === 52 || c === 54 || c === 57 || c === 111 || c === 114;
}

function cleanPartId(part: string): string {
  return part.replace(/^.*[/\\]/, '').replace(/\.dat$/i, '').toLowerCase();
}

/** Convert row-major 3x3 rotation matrix to Euler angles (in degrees, XYZ order) */
function matrixToEulerXYZ(r: number[]): [number, number, number] {
  // Negate Y row and Y column because in LDraw +Y is down, whereas in Minecraft +Y is up
  const r00 = r[0], r01 = -r[1], r02 = r[2];
  const r11 = r[4], r12 = -r[5];
  const r21 = -r[7], r22 = r[8];

  let x = 0, y = 0, z = 0;
  const sy = Math.max(-1, Math.min(1, r02));

  if (Math.abs(r02) < 0.9999) {
    y = Math.asin(sy);
    x = Math.atan2(-r12, r22);
    z = Math.atan2(-r01, r00);
  } else {
    y = r02 < 0 ? -Math.PI / 2 : Math.PI / 2;
    x = Math.atan2(r21, r11);
    z = 0;
  }

  return [
    Math.round(x * 180 / Math.PI * 10) / 10,
    Math.round(y * 180 / Math.PI * 10) / 10,
    Math.round(z * 180 / Math.PI * 10) / 10,
  ];
}

export interface CompiledLdrawGeometry {
  value: unknown;
  palette: string[];
  canopyPalette: string[];
  meshIds: string[];
  canopyMeshId?: string;
  seatPosition: [number, number, number];
  collisionBox: { width: number; height: number };
}

/**
 * Compiles parsed LDraw bricks directly into Bedrock entity geometry without voxelization.
 */
export function compileLdrawEntityGeometry(
  cid: string,
  kind: PlayableKind,
  bricks: ParsedBrick[],
  options: {
    scale?: number;
    facing?: VehicleFacing;
    userSeatAnchor?: { x: number; y: number; z: number };
  } = {}
): CompiledLdrawGeometry {
  const scale = options.scale ?? BEDROCK_UNITS_PER_LDU;

  // 0. Filter out non-vehicle display stands, pedestals, and side plaques if present
  let activeBricks = bricks;

  const WHEEL_PARTS = new Set(['56908', '44771', '44772', '87697', '92912', '15413', '41897', '23798', '23799']);
  const wheels = bricks.filter(b => {
    const p = cleanPartId(b.part);
    return WHEEL_PARTS.has(p) || p.includes('wheel') || p.includes('tire');
  });

  if (kind === 'car' && wheels.length >= 4) {
    const wheelYs = wheels.map(b => b.y);
    const maxWheelY = Math.max(...wheelYs);
    const groundY = maxWheelY + 60;
    const wheelXs = wheels.map(b => b.x);
    const minWheelX = Math.min(...wheelXs) - 120;
    const maxWheelX = Math.max(...wheelXs) + 120;
    const wheelZs = wheels.map(b => b.z);
    const minWheelZ = Math.min(...wheelZs) - 120;
    const maxWheelZ = Math.max(...wheelZs) + 120;

    const filtered = bricks.filter(b =>
      b.y <= groundY + 40 &&
      b.x >= minWheelX && b.x <= maxWheelX &&
      b.z >= minWheelZ && b.z <= maxWheelZ
    );
    if (filtered.length >= bricks.length * 0.6) activeBricks = filtered;

    // Auto-align yaw if wheels indicate an angled car on a display turntable (like 76240)
    const midZ = (Math.min(...wheelZs) + Math.max(...wheelZs)) / 2;
    const frontWheels = wheels.filter(b => b.z < midZ);
    const rearWheels = wheels.filter(b => b.z >= midZ);
    if (frontWheels.length >= 2 && rearWheels.length >= 2) {
      const fX = frontWheels.reduce((a, b) => a + b.x, 0) / frontWheels.length;
      const fZ = frontWheels.reduce((a, b) => a + b.z, 0) / frontWheels.length;
      const rX = rearWheels.reduce((a, b) => a + b.x, 0) / rearWheels.length;
      const rZ = rearWheels.reduce((a, b) => a + b.z, 0) / rearWheels.length;
      const dx = fX - rX;
      const dz = fZ - rZ;
      const yawRad = Math.atan2(dx, dz);
      if (Math.abs(yawRad) > 0.05 && Math.abs(yawRad) < Math.PI * 0.45) {
        const cosT = Math.cos(-yawRad), sinT = Math.sin(-yawRad);
        const pivotX = (fX + rX) / 2, pivotZ = (fZ + rZ) / 2;
        activeBricks = activeBricks.map(b => {
          const relX = b.x - pivotX, relZ = b.z - pivotZ;
          return {
            ...b,
            x: relX * cosT - relZ * sinT + pivotX,
            z: relX * sinT + relZ * cosT + pivotZ,
          };
        });
      }
    }
  } else if (kind === 'plane') {
    const canopyParts = bricks.filter(b => CANOPY_PARTS.has(cleanPartId(b.part)));
    if (canopyParts.length) {
      const canopyY = canopyParts.reduce((a, b) => a + b.y, 0) / canopyParts.length;
      const standBricks = bricks.filter(b => b.y > canopyY + 250);
      if (standBricks.length > 0 && standBricks.length < bricks.length * 0.2) {
        activeBricks = bricks.filter(b => b.y <= canopyY + 250);
      }
    }
  }

  // 1. Calculate bounding box in LDU from active vehicle bricks
  const xs = activeBricks.map(b => b.x), ys = activeBricks.map(b => b.y), zs = activeBricks.map(b => b.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);

  const midX = (minX + maxX) / 2;
  const floorY = maxY; // in LDraw, +Y is down, so maxY is the bottom/ground
  const midZ = (minZ + maxZ) / 2;

  // Determine forward heading and axis:
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const isXLongitudinal = options.facing?.endsWith('x') ?? (kind === 'car' && spanX > spanZ * 1.1);

  // 2. Identify Cockpit / Canopy / Driver Seat
  const canopyBricks: ParsedBrick[] = [];
  const solidBricks: ParsedBrick[] = [];
  const seatBricks: ParsedBrick[] = [];

  for (const b of activeBricks) {
    const p = cleanPartId(b.part);
    if (TECHNIC_INTERNAL.has(p)) continue;
    if (SEAT_PARTS.has(p)) seatBricks.push(b);
    if (isTransparentBrick(b)) canopyBricks.push(b);
    else solidBricks.push(b);
  }

  // Calculate cockpit center in LDU (prioritizing dedicated canopy parts over wing lights)
  let cockpitLdu: { x: number; y: number; z: number };
  const dedicatedCanopies = canopyBricks.filter(b => CANOPY_PARTS.has(cleanPartId(b.part)));

  if (seatBricks.length) {
    cockpitLdu = {
      x: seatBricks.reduce((a, b) => a + b.x, 0) / seatBricks.length,
      y: seatBricks.reduce((a, b) => a + b.y, 0) / seatBricks.length,
      z: seatBricks.reduce((a, b) => a + b.z, 0) / seatBricks.length,
    };
  } else if (dedicatedCanopies.length) {
    cockpitLdu = {
      x: dedicatedCanopies.reduce((a, b) => a + b.x, 0) / dedicatedCanopies.length,
      y: dedicatedCanopies.reduce((a, b) => a + b.y, 0) / dedicatedCanopies.length,
      z: dedicatedCanopies.reduce((a, b) => a + b.z, 0) / dedicatedCanopies.length,
    };
  } else if (canopyBricks.length) {
    cockpitLdu = {
      x: canopyBricks.reduce((a, b) => a + b.x, 0) / canopyBricks.length,
      y: canopyBricks.reduce((a, b) => a + b.y, 0) / canopyBricks.length,
      z: canopyBricks.reduce((a, b) => a + b.z, 0) / canopyBricks.length,
    };
  } else {
    // Default forward cabin: forward 25%, raised 60%
    const forwardSign = options.facing?.startsWith('-') ? -1 : 1;
    cockpitLdu = {
      x: midX,
      y: minY + (maxY - minY) * 0.35, // remember -Y is up
      z: midZ + forwardSign * spanZ * 0.2,
    };
  }

  // 3. Palettes
  const paletteSet = new Set<string>();
  for (const b of solidBricks) paletteSet.add(ldrawColorToBlock(b.color));
  const palette = [...paletteSet];
  if (!palette.length) palette.push('minecraft:gray_concrete');

  const canopyPaletteSet = new Set<string>();
  for (const b of canopyBricks) canopyPaletteSet.add(ldrawColorToBlock(b.color));
  const canopyPalette = [...canopyPaletteSet];
  if (!canopyPalette.length) canopyPalette.push('minecraft:glass');

  // 4. Transform bricks to Bedrock Bone Cubes
  // In Bedrock:
  // - 1 block = 16 units
  // - Vanilla riding convention is that -Z is model forward.
  // We align longitudinal axis to Z, pointing nose to -Z.
  const transformPoint = (x: number, y: number, z: number): [number, number, number] => {
    const cx = x - midX;
    const cy = floorY - y; // vertical height above ground
    const cz = z - midZ;

    if (isXLongitudinal) {
      // Rotate 90 degrees so X aligns with Z
      const forwardSign = options.facing?.startsWith('-') ? -1 : 1;
      return [
        cz * scale,
        cy * scale,
        -forwardSign * cx * scale,
      ];
    } else {
      // Z is longitudinal
      const forwardSign = options.facing?.startsWith('-') ? -1 : 1;
      return [
        -cx * scale,
        cy * scale,
        -forwardSign * cz * scale,
      ];
    }
  };

  // Convert cockpit location to Bedrock blocks (meters) for seats.position
  const cockpitBedrockUnits = transformPoint(cockpitLdu.x, cockpitLdu.y, cockpitLdu.z);
  // Seat sits inside the cockpit:
  // Player eyes are at Y + 1.62. To align eye level with the canopy windshield,
  // place the seat ~1.1 blocks below the canopy center, slightly set back.
  const seatX = Math.round((cockpitBedrockUnits[0] / 16) * 100) / 100;
  const seatY = Math.max(0.4, Math.round(((cockpitBedrockUnits[1] / 16) - 1.05) * 100) / 100);
  const seatZ = Math.round(((cockpitBedrockUnits[2] / 16) + 0.4) * 100) / 100;

  // Collision box in meters (blocks)
  const totalWidth = (isXLongitudinal ? spanZ : spanX) * scale / 16;
  const totalHeight = (maxY - minY) * scale / 16;
  const totalLength = (isXLongitudinal ? spanX : spanZ) * scale / 16;
  const collisionBox = {
    width: Math.min(3.5, Math.max(0.8, Math.round(totalWidth * 0.85 * 10) / 10)),
    height: Math.min(2.5, Math.max(0.8, Math.round(totalHeight * 0.8 * 10) / 10)),
  };

  interface BedrockCube {
    origin: [number, number, number];
    size: [number, number, number];
    uv: Record<string, { uv: [number, number]; uv_size: [number, number] }>;
  }

  interface BedrockBone {
    name: string;
    pivot: [number, number, number];
    rotation?: [number, number, number];
    cubes: BedrockCube[];
  }

  const buildCubesFromBricks = (
    brickList: ParsedBrick[],
    colorList: string[],
    isCanopy = false
  ): BedrockBone[] => {
    // Group bricks into bones by rotation matrix
    const rotGroups = new Map<string, { rot: number[]; bricks: ParsedBrick[] }>();

    for (const b of brickList) {
      const r = b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const key = r.map(v => Math.round(v * 100) / 100).join(',');
      let group = rotGroups.get(key);
      if (!group) {
        group = { rot: r, bricks: [] };
        rotGroups.set(key, group);
      }
      group.bricks.push(b);
    }

    const bones: BedrockBone[] = [];
    let boneIndex = 0;

    for (const group of rotGroups.values()) {
      const euler = matrixToEulerXYZ(group.rot);
      const isIdentity = euler.every(v => Math.abs(v) < 0.1);

      const boneName = isCanopy
        ? `canopy_bone_${boneIndex++}`
        : (isIdentity && boneIndex === 0 ? 'body' : `bone_${boneIndex++}`);

      // Bone pivot at center of group
      const avgLdu = {
        x: group.bricks.reduce((a, b) => a + b.x, 0) / group.bricks.length,
        y: group.bricks.reduce((a, b) => a + b.y, 0) / group.bricks.length,
        z: group.bricks.reduce((a, b) => a + b.z, 0) / group.bricks.length,
      };
      const pivot = transformPoint(avgLdu.x, avgLdu.y, avgLdu.z);

      const cubes: BedrockCube[] = [];

      for (const b of group.bricks) {
        const [sW, sH, sL] = getPartDims(b.part);
        const wUnits = Math.max(1, sW * 20 * scale);
        const hUnits = Math.max(1, sH * 8 * scale);
        const lUnits = Math.max(1, sL * 20 * scale);

        const blockState = ldrawColorToBlock(b.color);
        const colorIdx = Math.max(0, colorList.indexOf(blockState));

        // UV mapping
        const topFace = { uv: [0, 1 + colorIdx * 16] as [number, number], uv_size: [16, 16] as [number, number] };
        const sideFace = { uv: [16, 1 + colorIdx * 16] as [number, number], uv_size: [16, 16] as [number, number] };

        // Position relative to bone pivot
        const bPos = transformPoint(b.x, b.y, b.z);
        const origin: [number, number, number] = isIdentity
          ? [
              Math.round((bPos[0] - wUnits / 2) * 10) / 10,
              Math.round((bPos[1] - hUnits) * 10) / 10,
              Math.round((bPos[2] - lUnits / 2) * 10) / 10,
            ]
          : [
              Math.round((bPos[0] - pivot[0] - wUnits / 2) * 10) / 10,
              Math.round((bPos[1] - pivot[1] - hUnits) * 10) / 10,
              Math.round((bPos[2] - pivot[2] - lUnits / 2) * 10) / 10,
            ];

        cubes.push({
          origin,
          size: [Math.round(wUnits * 10) / 10, Math.round(hUnits * 10) / 10, Math.round(lUnits * 10) / 10],
          uv: {
            north: sideFace,
            south: sideFace,
            east: sideFace,
            west: sideFace,
            up: topFace,
            down: sideFace,
          },
        });
      }

      bones.push({
        name: boneName,
        pivot: isIdentity ? [0, 0, 0] : pivot,
        ...(isIdentity ? {} : { rotation: euler }),
        cubes,
      });
    }

    return bones;
  };

  // Build solid and canopy bones
  const solidBones = buildCubesFromBricks(solidBricks, palette, false);
  const canopyBones = canopyBricks.length ? buildCubesFromBricks(canopyBricks, canopyPalette, true) : [];

  // Partition meshes into <= 1024 cubes per Bedrock mesh
  const meshes: unknown[] = [];
  const meshIds: string[] = [];

  // Solid meshes
  const allSolidCubes: Array<{ boneName: string; pivot: [number, number, number]; rotation?: [number, number, number]; cube: BedrockCube }> = [];
  for (const b of solidBones) {
    for (const c of b.cubes) {
      allSolidCubes.push({ boneName: b.name, pivot: b.pivot, rotation: b.rotation, cube: c });
    }
  }

  const atlasW = 32;
  const atlasH = 1 + palette.length * 16;

  for (let offset = 0; offset < allSolidCubes.length; offset += 1024) {
    const meshIndex = meshIds.length;
    const meshId = `geometry.${PACK_NAMESPACE}.${cid}_mesh_${meshIndex}`;
    meshIds.push(meshId);

    const slice = allSolidCubes.slice(offset, offset + 1024);
    // Regroup by bone
    const boneMap = new Map<string, BedrockBone>();
    for (const item of slice) {
      let b = boneMap.get(item.boneName);
      if (!b) {
        b = { name: item.boneName, pivot: item.pivot, ...(item.rotation ? { rotation: item.rotation } : {}), cubes: [] };
        boneMap.set(item.boneName, b);
      }
      b.cubes.push(item.cube);
    }

    meshes.push({
      description: {
        identifier: meshId,
        texture_width: atlasW,
        texture_height: atlasH,
        visible_bounds_width: Math.max(2, Math.round(totalWidth), Math.round(totalLength)),
        visible_bounds_height: Math.max(2, Math.round(totalHeight)),
        visible_bounds_offset: [0, Math.round(totalHeight / 2), 0],
      },
      bones: [...boneMap.values()],
    });
  }

  // Canopy mesh (transparent)
  let canopyMeshId: string | undefined;
  if (canopyBones.length) {
    canopyMeshId = `geometry.${PACK_NAMESPACE}.${cid}_canopy`;
    meshIds.push(canopyMeshId);

    meshes.push({
      description: {
        identifier: canopyMeshId,
        texture_width: atlasW,
        texture_height: 1 + canopyPalette.length * 16,
        visible_bounds_width: Math.max(2, Math.round(totalWidth), Math.round(totalLength)),
        visible_bounds_height: Math.max(2, Math.round(totalHeight)),
        visible_bounds_offset: [0, Math.round(totalHeight / 2), 0],
      },
      bones: canopyBones,
    });
  }

  return {
    value: {
      format_version: '1.12.0',
      'minecraft:geometry': meshes,
    },
    palette,
    canopyPalette,
    meshIds,
    canopyMeshId,
    seatPosition: [seatX, seatY, seatZ],
    collisionBox,
  };
}
