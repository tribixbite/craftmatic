# Tiles Voxelization Grading — Post-Fix v2 (2026-03-09)

## Pipeline Changes Applied
1. tile-capture.ts: sphere → XZ-cylinder filter (allows tall buildings)
2. tiles.ts: PerspectiveCamera(0,8,8) → OrthographicCamera(0,500,0)
3. voxelizer.ts: removed warm bias, MIN_BRIGHT 180→140, kernel 16→24, desat 0.65→0.5, threshold 0.55→0.65
4. CLI+browser: removed solidifyCore, carveFacadeShadows, fireEscapeFilter, addRoofCornice
5. CLI+browser: reduced palette remaps from 22 aggressive rules to 7 shadow-only rules

## Gemini 3 Pro Grading Results

| Building | Score | Key Issue |
|----------|-------|-----------|
| 450 Noe St | 1.5/10 | Noisy facade, wrong colors, no Victorian features |
| 2340 Francisco St | 1.5/10 | Red roof wrong, grey walls instead of cream |
| 2390 Green St | 1.5/10 | Privacy blur in SV, hollow mesh |
| 2001 Chestnut St | 1/10 | Generic tall cube vs real low-rise commercial |
| 2130 Beach St | 2/10 | Noisy facade, wrong roof color |
| 3170 Baker St | 1.5/10 | Missing bay windows, wrong colors |
| 3601 Lyon St | 1/10 | Wrong building captured entirely |
| 600 Montgomery St | 1/10 | Generic rectangle, no triangular footprint |
| Sentinel Building | 1/10 | No green copper, no flatiron shape |
| Empire State Building | 1/10 | 58x40x53 squat box vs 443m tower |
| Flatiron Building | 1/10 | Rectangular box, no wedge shape |
| Chrysler Building | 1/10 | Flat bunker, no verticality |
| St. Patrick's Cathedral | 1/10 | No cruciform, no spires |
| The Dakota | 1/10 | No courtyard, wrong colors |

**Average: 1.2/10** (prev: 1.1/10)

## Root Cause Analysis

The scores are essentially unchanged because **the GLBs were captured with the old broken pipeline**. The code fixes (OrthographicCamera, cylinder filter) only affect future browser captures. The CLI just re-voxelizes the same pre-captured GLB files.

### What the GLBs contain
- PerspectiveCamera at (0,8,8) looking at origin → TilesRenderer only loaded tiles within ~50m of ground level
- Sphere capture filter → clipped meshes above the radius height
- Result: GLBs contain only ground-level geometry (rooftops + partial facades)
- Skyscrapers (ESB 443m, Chrysler 319m) captured as 40-block-tall stumps

### What changed (better)
- **Color variety**: 22-27 palette materials per building (was 3-block monochrome pre-color-fix)
- **No artificial materials**: removed bricks+spruce cornice, fire escape darkening
- **Shadow-only palette**: real colors (terracotta, sandstone, brick) survive remapping

### What changed (worse)
- **Hollow interiors**: removing solidifyCore halved block count (67K→35K for francisco-2340)
- **More porous facades**: thin photogrammetry surfaces now have visible gaps
- fillInteriorGaps only partially compensates for the missing core fill

## Next Steps Required

1. **Re-capture all 14 buildings from browser** with the new OrthographicCamera + cylinder filter
   - This is the critical fix — the GLBs must be regenerated
   - Use `batchVoxelize()` in browser console
   - Need schem-receiver running on :3456

2. **Consider restoring solidifyCore as optional**
   - For thin photogrammetry shells, interior fill is needed
   - Maybe gate on analysis: use for high-confidence rectangular buildings, skip for complex footprints

3. **Fix reference image quality**
   - Several street view images are interior shots (Chrysler, Chestnut)
   - Some capture wrong panoramas (ESB shows tour bus, not building)
   - Need heading-based SV API calls pointing AT the building
