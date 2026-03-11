/**
 * BrickLink Studio BFF API — fetch set part inventory.
 *
 * API base: https://api.prod.studio.bricklink.info/api/v1/
 * Proxied through our CF Worker / Vite dev proxy at /bff/*.
 *
 * The CF Worker handles the anonymous token exchange server-side
 * so the browser only needs one GET call per inventory fetch.
 *
 * Color IDs returned by the API are BrickLink/Studio color IDs,
 * matching the STUDIO_COLOR_TO_BLOCK table in studio-colors.ts.
 */

/** Route prefix for BFF proxy (CF Worker in prod, Vite dev proxy). */
const BFF_BASE = '/bff';

/** Grid layout for flat inventory → LDraw conversion. */
const PER_ROW = 20;
const SPACING = 40; // LDraw units between part centres

export interface BffPart {
  itemNumber: string;
  colorId: number;   // Studio/BrickLink color ID
  quantity: number;
}

/**
 * Fetch part inventory for a set from the BrickLink BFF API.
 * Returns an empty array when the set is not found (404).
 * Throws on network errors.
 */
export async function fetchBffInventory(setNum: string): Promise<BffPart[]> {
  const resp = await fetch(`${BFF_BASE}/inventory/${encodeURIComponent(setNum)}`);

  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`BFF inventory HTTP ${resp.status}`);

  const data = await resp.json() as {
    items?: Array<{
      entries?: Array<{
        item?: { itemNumber?: string; colorId?: number; quantity?: number };
      }>;
    }>;
  };

  const parts: BffPart[] = [];
  for (const group of data.items ?? []) {
    for (const entry of group.entries ?? []) {
      const it = entry.item;
      if (!it?.itemNumber || !it.quantity || it.quantity <= 0) continue;
      parts.push({
        itemNumber: it.itemNumber,
        colorId:    it.colorId ?? 0,
        quantity:   it.quantity,
      });
    }
  }
  return parts;
}

/**
 * Convert a BFF inventory to a flat-grid LDraw model string.
 *
 * Each part becomes one 1×1 plate (3024.dat) placed at grid (col, 0, row).
 * Color IDs are Studio/BL IDs — the voxelizer resolves them via studioColorToBlock.
 * The resulting model is a 2D colour-mosaic of the set's parts, NOT a 3D assembly.
 */
export function bffInventoryToLDraw(setNum: string, parts: BffPart[]): string {
  const lines: string[] = [
    `\ufeff0 ${setNum}`,
    `0 Name:  ${setNum}`,
    '0 Author: BrickLink Studio BFF',
    '0 STEP',
  ];

  let col = 0, row = 0;
  for (const { colorId, quantity } of parts) {
    for (let i = 0; i < quantity; i++) {
      const x = col * SPACING;
      const z = row * SPACING;
      lines.push(`1 ${colorId} ${x} 0 ${z} 1 0 0 0 1 0 0 0 1 3024.dat`);
      col++;
      if (col >= PER_ROW) { col = 0; row++; }
    }
  }

  return lines.join('\r\n') + '\r\n';
}
