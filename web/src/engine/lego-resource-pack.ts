/**
 * Craftmatic LEGO Resource Pack Generator.
 *
 * Compiles a standalone Minecraft Bedrock resource pack (.mcpack) that replaces
 * the flat matte concrete textures with authentic glossy ABS plastic finishes,
 * embossed top-face LEGO studs, and beveled ambient-occlusion brick seams.
 */

import { createZip, type ZipInputFile } from './zip-utils.js';

const CONCRETE_COLORS: Record<string, [number, number, number]> = {
  white: [238, 238, 238],
  orange: [224, 97, 1],
  magenta: [169, 48, 159],
  light_blue: [36, 137, 199],
  yellow: [241, 175, 21],
  lime: [94, 169, 24],
  pink: [214, 101, 143],
  gray: [54, 57, 61],
  light_gray: [125, 125, 115],
  cyan: [21, 119, 136],
  purple: [100, 32, 156],
  blue: [44, 46, 143],
  brown: [96, 60, 32],
  green: [73, 91, 36],
  red: [142, 32, 32],
  black: [20, 20, 24],
};

const PNG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function pngCrc(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = PNG_CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    o.set(p, i);
    i += p.length;
  }
  return o;
}

const enc = new TextEncoder();
function pngChunk(name: string, data: Uint8Array): Uint8Array {
  const n = enc.encode(name);
  const body = concat(n, data);
  return concat(u32(data.length), body, u32(pngCrc(body)));
}

/**
 * Generate a 16x16 PNG with authentic embossed LEGO stud and beveled edges.
 */
export function generateStudBlockPng(r: number, g: number, b: number, isTop = true): Uint8Array {
  const size = 16;
  const raw = new Uint8Array(size * (1 + size * 4));

  for (let y = 0; y < size; y++) {
    const rowOffset = y * (1 + size * 4);
    raw[rowOffset] = 0; // Filter type None

    for (let x = 0; x < size; x++) {
      const idx = rowOffset + 1 + x * 4;
      let pr = r;
      let pg = g;
      let pb = b;
      const pa = 255;

      const isBorder = (x === 0 || x === size - 1 || y === 0 || y === size - 1);
      if (isBorder) {
        // Ambient occlusion brick seam
        pr = Math.floor(pr * 0.72);
        pg = Math.floor(pg * 0.72);
        pb = Math.floor(pb * 0.72);
      } else if (isTop) {
        // Embossed stud ring in center
        const dx = x - 7.5;
        const dy = y - 7.5;
        const dist = Math.hypot(dx, dy);

        if (dist >= 3.0 && dist <= 5.2) {
          const angle = Math.atan2(dy, dx);
          if (angle < -0.3 && angle > -2.8) {
            // Top-left highlight
            pr = Math.min(255, pr + 42);
            pg = Math.min(255, pg + 42);
            pb = Math.min(255, pb + 42);
          } else {
            // Bottom-right shadow
            pr = Math.floor(pr * 0.76);
            pg = Math.floor(pg * 0.76);
            pb = Math.floor(pb * 0.76);
          }
        } else if (dist < 3.0) {
          // Inside stud top
          pr = Math.min(255, pr + 16);
          pg = Math.min(255, pg + 16);
          pb = Math.min(255, pb + 16);
        }
      } else {
        // Side face subtle specular bevel at top edge
        if (y === 1) {
          pr = Math.min(255, pr + 24);
          pg = Math.min(255, pg + 24);
          pb = Math.min(255, pb + 24);
        }
      }

      raw[idx] = pr;
      raw[idx + 1] = pg;
      raw[idx + 2] = pb;
      raw[idx + 3] = pa;
    }
  }

  // Zlib deflate uncompressed blocks
  let a = 1;
  let bVal = 0;
  for (const v of raw) {
    a = (a + v) % 65521;
    bVal = (bVal + a) % 65521;
  }
  const blocks: Uint8Array[] = [];
  for (let p = 0; p < raw.length;) {
    const len = Math.min(65535, raw.length - p);
    const last = p + len === raw.length;
    blocks.push(
      Uint8Array.of(last ? 1 : 0, len & 255, len >>> 8, (~len) & 255, ((~len) >>> 8) & 255),
      raw.slice(p, p + len)
    );
    p += len;
  }
  const z = concat(Uint8Array.of(0x78, 0x01), ...blocks, u32((bVal << 16) | a));

  return concat(
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    pngChunk('IHDR', concat(u32(size), u32(size), Uint8Array.of(8, 6, 0, 0, 0))),
    pngChunk('IDAT', z),
    pngChunk('IEND', new Uint8Array())
  );
}

/**
 * Build the complete Craftmatic LEGO Resource Pack (.mcpack).
 */
export async function buildLegoResourcePack(): Promise<Uint8Array> {
  const entries: ZipInputFile[] = [];

  const manifest = {
    format_version: 2,
    header: {
      name: 'Craftmatic LEGO HD Textures',
      description: 'Authentic embossed LEGO studs and beveled plastic seams for Minecraft concrete blocks.',
      uuid: 'd8a39120-e2b4-4b5c-a294-b19736c92041',
      version: [1, 0, 0],
      min_engine_version: [1, 20, 0],
    },
    modules: [
      {
        type: 'resources',
        uuid: '419c8362-7210-4f59-b103-9e16cb57f49a',
        version: [1, 0, 0],
      },
    ],
  };

  entries.push({
    name: 'manifest.json',
    data: enc.encode(JSON.stringify(manifest, null, 2) + '\n'),
  });

  const terrainTextures: Record<string, { textures: string }> = {};

  for (const [colorName, [r, g, b]] of Object.entries(CONCRETE_COLORS)) {
    const texPath = `textures/blocks/concrete_${colorName}.png`;
    const pngBytes = generateStudBlockPng(r, g, b, true);
    entries.push({ name: texPath, data: pngBytes });
    terrainTextures[`concrete_${colorName}`] = { textures: `textures/blocks/concrete_${colorName}` };
  }

  const terrainJson = {
    resource_pack_name: 'craftmatic_lego',
    texture_name: 'atlas.terrain',
    texture_data: terrainTextures,
  };

  entries.push({
    name: 'textures/terrain_texture.json',
    data: enc.encode(JSON.stringify(terrainJson, null, 2) + '\n'),
  });

  // Pack icon (red stud tile)
  entries.push({
    name: 'pack_icon.png',
    data: generateStudBlockPng(220, 32, 32, true),
  });

  return createZip(entries);
}
