/**
 * USDA Plant Hardiness Zone lookup — returns the hardiness zone (e.g. "7b")
 * for a given US ZIP code. Determines which tree species grow at a location.
 *
 * Source: phzmapi.org — static JSON API, free, no auth.
 */

export interface HardinessResult {
  /** Hardiness zone string (e.g. "7b"), null if unavailable */
  zone: string | null;
  /** Minimum temperature for the zone (Fahrenheit) */
  tempMinF?: number;
  /** Maximum temperature for the zone (Fahrenheit) */
  tempMaxF?: number;
}

/**
 * Query USDA Plant Hardiness Zone for a ZIP code.
 * Returns zone string (e.g. "7b") or null if unavailable.
 */
export async function queryHardinessZone(
  zipCode: string,
): Promise<HardinessResult> {
  // Only 5-digit US ZIP codes are supported
  const zip5 = zipCode.replace(/\D/g, '').slice(0, 5);
  if (zip5.length !== 5) return { zone: null };

  try {
    const res = await fetch(`https://phzmapi.org/${zip5}.json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { zone: null };

    const data = await res.json() as {
      zone?: string;
      coordinates?: { lat: number; lng: number };
      temperature_range?: string;
    };

    if (!data.zone) return { zone: null };

    // Parse temperature range if available (e.g. "0 to 5")
    let tempMinF: number | undefined;
    let tempMaxF: number | undefined;
    if (data.temperature_range) {
      const match = data.temperature_range.match(/(-?\d+)\s+to\s+(-?\d+)/);
      if (match) {
        tempMinF = parseInt(match[1], 10);
        tempMaxF = parseInt(match[2], 10);
      }
    }

    return { zone: data.zone, tempMinF, tempMaxF };
  } catch {
    return { zone: null };
  }
}

/**
 * Map hardiness zone → Minecraft tree type palette.
 * Returns an array of tree types to randomly select from when placing trees.
 */
export type MinecraftTreeType = 'oak' | 'birch' | 'spruce' | 'jungle' | 'acacia' | 'dark_oak' | 'cherry' | 'mangrove';

export function hardinessToTreePalette(zone: string | null): MinecraftTreeType[] {
  if (!zone) return ['oak', 'birch']; // default temperate

  // Extract numeric zone (e.g. "7b" → 7)
  const num = parseInt(zone, 10);
  if (isNaN(num)) return ['oak', 'birch'];

  if (num <= 3) return ['spruce', 'birch'];                  // very cold: boreal
  if (num <= 5) return ['oak', 'birch', 'spruce'];           // cold: mixed
  if (num <= 7) return ['oak', 'birch', 'dark_oak'];         // moderate: deciduous
  if (num <= 9) return ['oak', 'dark_oak', 'jungle'];        // warm: subtropical
  return ['jungle', 'acacia'];                                // tropical: zone 10+
}
