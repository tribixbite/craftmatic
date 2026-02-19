# Import Pipeline — Address-to-Structure Generation

Technical specification for the address → property data → Minecraft structure pipeline.

## Overview

```
  Address string
       ↓
  ┌─────────────┐
  │  Geocoder    │  Census Bureau (primary) → Nominatim OSM (fallback)
  │  → lat, lng  │
  └──────┬───────┘
         ↓
  ┌──────┴───────┐──────────────┐
  │  Parcl Labs  │  OSM Overpass │  (parallel)
  │  → property  │  → footprint  │
  └──────┬───────┘──────┬───────┘
         ↓              ↓
  ┌──────────────────────────────┐
  │       PropertyData           │  Central data model
  └──────────┬───────────────────┘
             ↓
  ┌──────────────────────────────┐
  │  convertToGenerationOptions  │  Inference + mapping
  └──────────┬───────────────────┘
             ↓
  ┌──────────────────────────────┐
  │  generateStructure → .schem  │
  └──────────────────────────────┘
```

## Data Sources

| Source | Auth | Free Tier | Data |
|--------|------|-----------|------|
| US Census Geocoder | None | Unlimited | lat/lng from US addresses |
| Nominatim OSM | None | 1 req/sec | lat/lng fallback (global) |
| Parcl Labs | API key | 1000/month | beds, baths, sqft, year, property type, county, city, ZIP |
| OSM Overpass | None | Rate-limited | Building polygon, levels, material, roof, architecture |
| RentCast | API key | 100/month | Floor count, lot size, exterior type, roof, architecture |
| ESRI Satellite | None | Tile-based | Satellite imagery for color extraction |

## PropertyData Interface

Source: `src/gen/address-pipeline.ts`

```typescript
interface PropertyData {
  // Core property fields (from Parcl/RentCast)
  address: string;
  stories: number;
  sqft: number;
  bedrooms: number;
  bathrooms: number;
  yearBuilt: number;
  propertyType: string;         // 'house' | 'condo' | 'townhouse'
  style: StyleName | 'auto';

  // Location (from Parcl)
  city?: string;
  stateAbbreviation?: string;
  zipCode?: string;
  county?: string;

  // Geocoding result
  geocoding?: { lat: number; lng: number; matchedAddress: string; source: string };

  // OSM building footprint
  osmWidth?: number;            // blocks (clamped 6-60)
  osmLength?: number;
  osmLevels?: number;           // building:levels tag
  osmMaterial?: string;         // building:material tag
  osmRoofShape?: string;        // Normalized roof label
  osmRoofMaterial?: string;
  osmRoofColour?: string;       // #RRGGBB hex
  osmBuildingColour?: string;
  osmArchitecture?: string;     // building:architecture tag

  // RentCast enrichment
  architectureType?: string;
  exteriorType?: string;
  wallOverride?: BlockState;    // Priority chain result
  roofType?: string;

  // Analysis results
  floorPlan?: FloorPlanHint;    // Room detection from uploaded image
  floorPlanShape?: FloorPlanShape; // Polygon shape (rect, L, T, U)
  detectedColor?: { r: number; g: number; b: number };
  season?: SeasonalWeather;

  // Flags
  newConstruction: boolean;
  ownerOccupied?: boolean;
  onMarket?: boolean;
  hasGarage?: boolean;
  hasPool?: boolean;
  yearUncertain?: boolean;      // Parcl returned yearBuilt=0
  bedroomsUncertain?: boolean;  // Parcl returned bedrooms=0 (not studio)
}
```

## Priority Chains

### Style Resolution

```
resolveStyle(prop):
  1. User selection (prop.style !== 'auto')     → return directly
  2. OSM building:architecture tag               → mapArchitectureToStyle()
  3. RentCast architectureType                    → mapArchitectureToStyle()
  4. City name + year                             → inferStyleFromCity()
  5. County name + year                           → inferStyleFromCounty()
  6. Year built (with yearUncertain handling)     → inferStyle()
```

When `yearUncertain` is true, year defaults to 1970 → 'modern' as neutral fallback.

### Dimensions

```
Width/Length:
  1. CLI --width / --length overrides
  2. OSM footprint (widthBlocks, lengthBlocks)    — 1 block ≈ 1 meter
  3. sqft-based estimate: sqrt(sqft/10.76), clamped 10-60 blocks
```

### Stories

```
Stories:
  1. RentCast floorCount (county assessor — most reliable)
  2. OSM building:levels tag
  3. estimateStoriesFromFootprint(sqft, widthM, lengthM)  — sqft / footprint area
  4. Parcl heuristic: townhouse/large single-family → 2-3
  5. Default: 2
```

### Wall Material

```
Wall Override:
  1. RentCast exterior type → mapExteriorToWall()
  2. OSM building:material  → mapOSMMaterialToWall()
  3. Satellite dominant color → mapColorToWall()
  4. Style palette default (from getStyle())
```

## Key Functions

### estimateStoriesFromFootprint

```typescript
function estimateStoriesFromFootprint(
  sqft: number, footprintWidthM: number, footprintLengthM: number,
): number {
  const footprintSqm = footprintWidthM * footprintLengthM;
  if (footprintSqm <= 0) return 2;
  const totalSqm = sqft / 10.76;
  return Math.max(1, Math.min(8, Math.round(totalSqm / footprintSqm)));
}
```

Example: 13,905 sqft on 10.5 × 20.7m footprint → 13905/10.76 / (10.5*20.7) ≈ 5.9 → 6 floors.

### convertToGenerationOptions

Maps PropertyData → GenerationOptions consumed by `generateStructure()`.

Key conversions:
- **Type**: sqft > 8000 or bedrooms > 8 → 'castle', else from propertyType
- **Rooms**: allocates bedroom/bathroom/kitchen/dining/study from bed/bath count
- **Seed**: `fnv1aHash(address)` for deterministic generation
- **Features**: inferFeatures() with style-aware porch override

### inferFeatures

Computes FeatureFlags (chimney, porch, backyard, driveway, fence, trees, garden, pool) from:
- ownerOccupied, lotSize, yearBuilt, sqft
- density (ZIP → urban/suburban/rural)
- climate (state → cold/hot/temperate)
- Effective style (gothic/rustic always get porch, fantasy pre-1950 gets porch)

## CLI Usage

```bash
# Generate from address (requires PARCL_API_KEY environment variable)
export PARCL_API_KEY=your_key
craftmatic gen -a "2340 Francisco St, San Francisco, CA 94123"

# Override style and seed
craftmatic gen -a "123 Main St, Springfield, IL 62701" -s modern --seed 42

# Override dimensions
craftmatic gen -a "456 Oak Ave, Portland, OR 97201" -w 30 -l 40

# Custom output path
craftmatic gen -a "789 Pine St, Austin, TX 78701" -o my_house.schem
```

## Web App Usage

The Import tab in the web app provides the full pipeline with additional features:
- Satellite imagery with seasonal weather overlay
- Floor plan image upload (drag-and-drop or paste)
- RentCast enrichment (exterior type, lot size, floor count)
- Interactive property form with auto-fill highlights
- Style chips with "Auto" inference
- Visual uncertain field indicators (dashed orange border)

## Known Limitations

1. **yearBuilt=0**: Parcl sometimes returns 0 for missing data. Marked as uncertain,
   falls back to OSM `start_date` tag, then defaults to 2000.
2. **bedrooms=0**: Ambiguous — could be actual studio or missing data. Disambiguation
   uses sqft (<800) and property type (CONDO/STUDIO) to decide.
3. **OSM coverage**: Not all buildings have footprint data. Rural areas have worse coverage.
4. **Urban/style conflict**: Dense urban ZIPs suppress porch, but style override re-enables
   for gothic/rustic/fantasy homes (owner-occupied only).
5. **Footprint accuracy**: OSM bounding box dimensions may not match actual building footprint
   for complex shapes (L, T, U). The stories estimate may be off for irregular buildings.
6. **Rate limits**: OSM Overpass is rate-limited (429 responses). Built-in retry with
   exponential backoff (2s, 4s, 6s).
