/**
 * `.mcpack` builder — a Bedrock behavior pack that makes the model PLACEABLE.
 *
 * A bare `.mcstructure` is not something a player can use: it has to be copied
 * into a world's `structures/` folder by hand, which is impossible on a phone or
 * a console. Wrapping it in a behavior pack changes that completely — a
 * `.mcpack` opens with one tap in Minecraft, and the structures inside become
 * loadable by name from a Structure Block or `/structure load`.
 *
 * Pack layout (wiki.bedrock.dev/nbt/mcstructure.html, Mojang's own sample pack):
 *
 *   manifest.json                              ← must be at the ROOT of the zip
 *   structures/<namespace>/<name>.mcstructure  ← loads as `<namespace>:<name>`
 *   functions/<namespace>/<stem>.mcfunction    ← `/function <namespace>/<stem>`
 *   README.txt
 *
 * The first folder under `structures/` IS the namespace (files placed directly
 * in `structures/` silently become `mystructure:<name>`), so ours always go in
 * an explicit one.
 *
 * The `.mcfunction` is what turns a tiled export back into one action: it holds
 * a `structure load` line per tile at that tile's offset in `~` coordinates, so
 * the player stands where they want the model's corner and runs ONE command.
 * Without it a 20-tile model would be 20 hand-typed placements at coordinates
 * the player has to compute.
 */

import type { BlockGrid } from '@craft/schem/types.js';
import { createZip } from './zip-utils.js';
import {
  planStructureTiles, encodeMcstructureTile, BEDROCK_MAX_TILE, BEDROCK_MIN_ENGINE,
  type StructureTile,
} from './mcstructure-encode.js';

/** Namespace all our structures and functions live under. */
export const PACK_NAMESPACE = 'craftmatic';

/**
 * Reduce a filename stem to a Bedrock identifier: lowercase, `[a-z0-9_]` only.
 * Bedrock identifiers are case-sensitive and `Colosseum-10276` would be a
 * different (and, with the dash, a fragile) name from what the pack declares.
 */
export function toBedrockIdentifier(stem: string): string {
  const id = stem.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return id || 'model';
}

export interface McpackTilePlacement {
  /** `<namespace>:<name>` — what to type into a Structure Block. */
  identifier: string;
  /** Offset from the model's corner, in blocks. */
  dx: number; dy: number; dz: number;
  width: number; height: number; length: number;
  nonAir: number;
}

export interface McpackResult {
  /** The finished `.mcpack` (a zip). */
  bytes: Uint8Array;
  /** Bedrock identifier of the whole model (the function name / single tile). */
  identifier: string;
  /** `/function` the player runs to place everything. */
  functionCommand: string;
  tiles: McpackTilePlacement[];
  /** Java palette entries with no Bedrock block, deduplicated. */
  unmapped: string[];
  /** Total bytes of `.mcstructure` payload before zipping. */
  rawStructureBytes: number;
}

export interface McpackOptions {
  /** Filename stem, e.g. `Colosseum-10276` — also the pack's display name. */
  stem: string;
  /** Human label for the pack description, e.g. `Colosseum (10276)`. */
  label?: string;
  /** Override the tile size (tests). Defaults to Bedrock's 64×384×64 limit. */
  maxTile?: { x: number; y: number; z: number };
  onProgress?: (phase: string, pct?: number) => void;
}

/**
 * 32-bit avalanche (murmur3 `fmix32`) — mixes a lane so a one-character change
 * in the stem changes the whole UUID rather than one nibble.
 */
function fmix32(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** One FNV-1a lane over `text`, seeded so the four lanes differ. */
function fnvLane(text: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h = (h ^ text.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return fmix32(h);
}

/**
 * A UUID derived from a string, not a random one.
 *
 * Deliberate: Minecraft identifies a pack by its manifest UUID, so re-exporting
 * the SAME set must produce the SAME uuid — then importing again UPDATES the
 * pack the player already has instead of leaving two packs with identical names
 * in their list. Two different sets hash differently and coexist. A random uuid
 * would also make the output non-reproducible, so no test could pin it.
 *
 * Not cryptographic and does not need to be: it only has to be stable and
 * collision-free across set names. Formatted as a well-formed v4-shaped UUID
 * (version nibble 4, variant bits 10) because Minecraft's manifest validator
 * checks the shape.
 */
export function deterministicUuid(text: string): string {
  const lanes = [fnvLane(text, 0), fnvLane(text, 0x9e3779b9), fnvLane(text, 0x7f4a7c15), fnvLane(text, 0x165667b1)];
  const hex = lanes.map(l => l.toString(16).padStart(8, '0')).join('');
  const chars = hex.split('');
  chars[12] = '4';                                        // version 4
  chars[16] = ((parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16); // variant 10xx
  const h = chars.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * A monotonically ordered manifest version for browser-generated pack updates.
 * UUIDs stay stable per export name, while a later export replaces the earlier
 * pack in Minecraft instead of appearing as a duplicate.
 */
export function exportVersion(now = Date.now()): [number, number, number] {
  const dayMs = 86_400_000;
  return [1, Math.floor(now / dayMs), Math.floor(now % dayMs)];
}

/** The behavior-pack manifest. `format_version` 2 is the modern pack format. */
function buildManifest(stem: string, label: string, tileCount: number, version: [number, number, number]): string {
  const manifest = {
    format_version: 2,
    header: {
      name: label,
      description:
        `${label} — ${tileCount} structure${tileCount === 1 ? '' : 's'} exported from Craftmatic. ` +
        `Run /function ${PACK_NAMESPACE}/${toBedrockIdentifier(stem)} to place it.`,
      // Header and module UUIDs must differ (manifest validation CHKMANIF110),
      // so the two are salted differently.
      uuid: deterministicUuid(`craftmatic.pack.header:${stem}`),
      version,
      min_engine_version: [...BEDROCK_MIN_ENGINE],
    },
    modules: [
      {
        // Structures and functions are behavior-pack data; `data` is the only
        // module type that carries them.
        type: 'data',
        uuid: deterministicUuid(`craftmatic.pack.module:${stem}`),
        version,
      },
    ],
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}

/** The one-command placement function: one `structure load` per tile. */
function buildFunction(tiles: McpackTilePlacement[]): string {
  const lines = [
    '# Placement function generated by Craftmatic.',
    '# Stand where you want the model\'s bottom north-west corner, then run this.',
    '# Coordinates are relative (~), so the whole model follows you.',
  ];
  for (const t of tiles) {
    lines.push(`structure load ${t.identifier} ~${t.dx} ~${t.dy} ~${t.dz}`);
  }
  return lines.join('\n') + '\n';
}

/** Plain-text instructions, shipped inside the pack so they cannot be lost. */
function buildReadme(
  stem: string, label: string, tiles: McpackTilePlacement[],
  dims: { width: number; height: number; length: number }, unmapped: string[],
): string {
  const id = toBedrockIdentifier(stem);
  const lines = [
    `${label}`,
    `${'='.repeat(label.length)}`,
    '',
    `Minecraft Bedrock structure pack exported from Craftmatic.`,
    `Model size: ${dims.width} x ${dims.height} x ${dims.length} blocks`,
    `Structures in this pack: ${tiles.length}`,
    '',
    'HOW TO PLACE IT',
    '---------------',
    '1. Open this .mcpack file with Minecraft. It imports as a behavior pack.',
    '2. In your world settings, activate the behavior pack, and turn on cheats.',
    '3. Join the world and stand where the model\'s bottom north-west corner',
    '   should go (the model extends east +X, south +Z and upward).',
    `4. Run:  /function ${PACK_NAMESPACE}/${id}`,
    '',
    tiles.length > 1
      ? `   That places all ${tiles.length} pieces in the right places at once.`
      : '   That places the model.',
    '',
    'OR PLACE PIECES BY HAND',
    '-----------------------',
    'A Structure Block in Load mode accepts these names, or use /structure load',
    '<name> <x y z>. Offsets are relative to the model corner:',
    '',
  ];
  for (const t of tiles) {
    lines.push(
      `  ${t.identifier}` +
      `   offset ~${t.dx} ~${t.dy} ~${t.dz}` +
      `   size ${t.width}x${t.height}x${t.length}`,
    );
  }
  lines.push(
    '',
    'NOTES',
    '-----',
    '* Empty space inside the model is placed as air, so the model CLEARS its own',
    '  box — dropping it into a hillside cuts the hill instead of leaving dirt',
    '  poking through the interior.',
    '* Bedrock caps one structure at 64 x 384 x 64 blocks, which is why a large',
    '  model is split into several. Each piece is trimmed to its own contents, so',
    '  the offsets above are exact.',
    '* Activating any external behavior pack permanently disables achievements in',
    '  that world. Use a creative world you do not mind that in.',
  );
  if (unmapped.length > 0) {
    lines.push(
      '',
      `* ${unmapped.length} block type(s) had no Bedrock equivalent and were left`,
      '  as air: ' + unmapped.join(', '),
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Build a `.mcpack` containing the grid as one or more `.mcstructure` files.
 *
 * Throws if the grid has no blocks — an empty pack imports fine and then does
 * nothing, which is worse than a clear failure.
 */
export async function buildMcpack(grid: BlockGrid, options: McpackOptions): Promise<McpackResult> {
  const { stem, onProgress } = options;
  const label = options.label ?? stem;
  const id = toBedrockIdentifier(stem);
  const maxTile = options.maxTile ?? BEDROCK_MAX_TILE;

  onProgress?.('planning Bedrock structures');
  const plan: StructureTile[] = planStructureTiles(grid, id, maxTile);
  if (plan.length === 0) throw new Error('Nothing to export — the model has no blocks.');

  const files: Array<{ name: string; data: Uint8Array }> = [];
  const tiles: McpackTilePlacement[] = [];
  const unmapped = new Set<string>();
  let rawStructureBytes = 0;

  for (let i = 0; i < plan.length; i++) {
    const tile = plan[i]!;
    onProgress?.(
      plan.length > 1 ? `encoding structure ${i + 1}/${plan.length}` : 'encoding structure',
      Math.round((i / plan.length) * 100),
    );
    const encoded = encodeMcstructureTile(grid, tile);
    for (const u of encoded.unmapped) unmapped.add(u);
    rawStructureBytes += encoded.bytes.length;
    files.push({ name: `structures/${PACK_NAMESPACE}/${tile.name}.mcstructure`, data: encoded.bytes });
    tiles.push({
      identifier: `${PACK_NAMESPACE}:${tile.name}`,
      dx: tile.x, dy: tile.y, dz: tile.z,
      width: tile.width, height: tile.height, length: tile.length,
      nonAir: tile.nonAir,
    });
  }

  const enc = new TextEncoder();
  const dims = { width: grid.width, height: grid.height, length: grid.length };
  files.unshift({ name: 'manifest.json', data: enc.encode(buildManifest(stem, label, tiles.length, exportVersion())) });
  files.push({ name: `functions/${PACK_NAMESPACE}/${id}.mcfunction`, data: enc.encode(buildFunction(tiles)) });
  files.push({
    name: 'README.txt',
    data: enc.encode(buildReadme(stem, label, tiles, dims, [...unmapped])),
  });

  onProgress?.('packaging .mcpack');
  const bytes = await createZip(files, { alwaysDeflate: true });

  return {
    bytes,
    identifier: `${PACK_NAMESPACE}:${id}`,
    functionCommand: `/function ${PACK_NAMESPACE}/${id}`,
    tiles,
    unmapped: [...unmapped],
    rawStructureBytes,
  };
}
