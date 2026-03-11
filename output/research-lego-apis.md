# LEGO Set Data: API & Source Research

> Research conducted 2026-03-08 for the LEGO Set tab feature (feat/lego-set-tab)

## Summary of Best Sources

| Source | 3D Position Data | Set Search | Parts List | Auth | Rate Limit | Cost |
|--------|----------------|------------|------------|------|------------|------|
| **Rebrickable API** | No | ✅ Best | ✅ Flat | Free API key | ~1 req/s | Free |
| **Rebrickable CSV dumps** | No | Offline | ✅ Flat | None | None | Free |
| **LDraw OMR** | **✅ MPD files** | Manual/web | Via MPD | None | None | Free (CC BY 4.0) |
| **BrickSet API** | No | ✅ Good metadata | No | Free key | 100/day | Free |
| **BrickLink Catalog API** | No | Limited | ✅ Flat | OAuth (seller req'd) | 5,000/day | Free |
| **BrickLink Studio** | ✅ Export to LDraw | Desktop only | Via export | Desktop app | N/A | Free |

---

## Selected Architecture

### Phase 1: Set Search — Rebrickable API
`GET https://rebrickable.com/api/v3/lego/sets/?search=millennium+falcon`
- Headers: `Authorization: key YOUR_KEY`
- Free API key at rebrickable.com/users/create/ → Settings → API Key
- Returns: `set_num`, `name`, `year`, `theme_id`, `num_parts`, `set_img_url`, `set_url`
- Search endpoint: name/number full-text search + `theme_id` + `min_year`/`max_year` filters
- Rate limit: ~1 req/s (burst allowed)
- CORS: Supported from browser

### Phase 2: 3D Model — LDraw MPD files
- Standard: LDraw format (ldraw.org) — open, text-based, CC BY 4.0
- Repository: LDraw OMR at library.ldraw.org/omr — ~1,470 official sets
- Format: `.mpd` (Multi-Part Document) or `.ldr` (single model)
- Key data: Line type 1 records: `1 <color> x y z a b c d e f g h i <filename>`
  - `x y z` = brick origin in LDraw Units (LDU)
  - `a-i` = 3×3 rotation matrix (row-major)
  - 1 stud pitch = 20 LDU, 1 plate height = 8 LDU, 1 brick height = 24 LDU
- Also available via BrickLink Studio → File → Export → LDraw

---

## LDraw Format Details

### Coordinate Mapping → Minecraft Grid
```
Grid X = round(brick.x / 20)     // 20 LDU per stud pitch
Grid Y = round(-brick.y / 8)     // 8 LDU per plate; LDraw Y is inverted
Grid Z = round(brick.z / 20)
```

Using plate-height (8 LDU) as Y resolution:
- 1 plate = 1 block tall
- 1 standard brick = 3 blocks tall (24 LDU / 8 = 3)

### Sub-model References (MPD)
MPD files embed multiple named models via `0 FILE <name>` sections.
Line type 1 records reference either:
- Terminal `.dat` parts (brick geometry) → create voxel at world position
- Sub-models (other `0 FILE` blocks) → recurse, applying accumulated transform

Transform accumulation:
```
world_pos = parentRot × local_pos + parentPos
child_rot = parentRot × localRot   (3×3 matrix multiply)
```

---

## Implementation Files Created

| File | Purpose |
|------|---------|
| `web/src/engine/ldraw-colors.ts` | LDraw color ID → Minecraft block mapping (~100+ colors) |
| `web/src/engine/ldraw-parser.ts` | MPD/LDR text parser → `ParsedBrick[]` with world positions |
| `web/src/engine/ldraw-voxelizer.ts` | `ParsedBrick[]` → `BlockGrid` (snaps LDU coords to grid) |
| `web/src/ui/lego.ts` | LEGO tab UI: Rebrickable search, set selection, MPD upload |

---

## Key Constraints & Solutions

### CORS
- Rebrickable API: supports browser CORS ✅
- LDraw OMR: no predictable direct-download URL → user downloads & uploads

### OMR Coverage
- Only ~1,470 of ~18,000+ LEGO sets have LDraw files in the OMR
- Popular sets (Millennium Falcon, Technic, Creator Expert) are well covered
- Show OMR link + BrickLink Studio link for every selected set
- Also accept user-uploaded `.mpd`/`.ldr` files from any source

### Large Sets
- Millennium Falcon (75192) has 7,541 pieces → ~7,541 voxels, fine for browser
- Voxelizer caps max dimension at 256, scales down if needed
- Deduplication: same grid cell occupied by multiple bricks → last write wins

### Themes
- Load dynamically from Rebrickable `/lego/themes/` on first key entry
- Fall back to 17 popular themes if API unavailable
- Show only top-level themes in filter dropdown

---

## Rebrickable CSV Downloads (offline/bulk alternative)

All files updated daily at `https://cdn.rebrickable.com/media/downloads/`:

| File | Contents |
|------|---------|
| `sets.csv.gz` | All sets: set_num, name, year, theme_id, num_parts |
| `themes.csv.gz` | All themes: id, name, parent_id |
| `colors.csv.gz` | All colors: id, name, rgb, is_trans |
| `parts.csv.gz` | All parts: part_num, name, part_cat_id |
| `inventory_parts.csv.gz` | inventory_id, part_num, color_id, quantity |
| `inventories.csv.gz` | id, version, set_num |

No authentication required for CSV downloads.

---

## Future Improvements

1. **Bundle sets.csv** as a compressed local index for offline set search
2. **OMR auto-fetch** — try direct OMR file URL patterns (fragile, CORS unlikely)
3. **Part geometry detail** — currently uses 1 voxel/brick; could resolve `.dat` geometry for non-cuboid parts (slopes, curves, etc.)
4. **Stud resolution** — render individual studs on top of bricks for more LEGO-like look
5. **BrickLink Studio bridge** — parse `.io` format (password-protected zip, proprietary XML inside)
6. **LDraw parts library** — bundle subset of common `.dat` files for client-side part lookup
