/**
 * LEGO design id → LDraw part name, for moulds LDraw files under a DIFFERENT
 * number than the one the source model uses.
 *
 * Why this exists: Mecabricks records `library.official[id].extra.reference`,
 * which is the current LEGO **design id**, and the harvested `.ldr` writes it
 * verbatim. LDraw instead names a mould by its FIRST/BrickLink-canonical
 * number and never renames it when LEGO re-tools the element. For most parts
 * the two agree, so `3001.dat` just works — but for re-tooled clip/bar/panel
 * families they diverge completely and the part resolves nowhere. 10316
 * Rivendell surfaced 14 such names at once ("152 piece(s) of 14 part type(s)
 * not in library"); the same ids orphan ~7k placements across the corpus.
 *
 * The suffix-stripping ladder in `parts.ts` cannot help here — there is no
 * suffix, the number is simply different — so the mapping has to be data.
 *
 * EVERY entry below was verified two ways (2026-09-02): the design id was
 * traced to its BrickLink/Rebrickable part via the "External Sites" mapping,
 * and the target `.dat` was read out of the LDraw library to confirm its
 * description names the same element. Nothing is here on inference alone.
 *
 * Deliberately NOT mapped — a wrong placement is worse than a visible hole:
 *   20926 / 20932  Dual-moulded ("2K") minifig leg halves, left/right. LDraw
 *                  models no separate 2K mould; the closest parts 3817/3816
 *                  are the obsolete single legs, and their headers carry
 *                  `!HELP Move down 12 units to align with hips` — i.e. a
 *                  different origin convention from the Mecabricks mesh, so
 *                  substituting them would misplace the legs rather than fix
 *                  them. 145 placements each corpus-wide, 1 each in 10316.
 *   1000341        A Mecabricks-INTERNAL id (not a LEGO design id): one sword
 *                  blade off the 37341 weapon sprue. LDraw models the sprue's
 *                  siblings individually but not this blade — a bbox sweep of
 *                  every "minifig"/"weapon" part found zero match within
 *                  ±2.5 LDU of the Mecabricks mesh (8.1 × 11.2 × 56.4 LDU).
 *                  Genuinely unmodelled.
 *
 * NEXT OFFENDERS, if this table is ever extended (measured 2026-09-02 over the
 * 6,325 tier-1 corpus .ldr files, AFTER this table + the suffix ladder, which
 * together took the corpus from 39,081 orphaned placements to 12,315):
 *   30241b  711 in  57 sets · 98560  579 in 111 · x346  342 in 69
 *   88355   133 in  16      · x187   115 in  34 · 78c02  97 in 17
 *   731c04   84 in  24      · 35293   76 in  26
 * Each needs the same two-way verification as the rows above — a design id
 * traced to its BrickLink/Rebrickable part, then the target .dat read to
 * confirm the description matches. Do NOT bulk-guess them.
 *
 * Three residual classes here are NOT ours to fix, so don't chase them:
 *   `rename_3023`/`rename_32123b`/… (1,088 placements, ~30 files) — an
 *      un-stripped marker in clego's IOModel2V2 extractor output.
 *   `m102bdfd2_…` (~900) — Studio CustomParts, which only exist INSIDE the
 *      .io archive; the extracted standalone .ldr references them without
 *      shipping them.
 *   `6397 - ls60` (470, one set) — an LSynth segment name with the parent part
 *      prefixed, which synthesizeLsSegment's /^ls\d{1,3}$/ doesn't match.
 */
export const LDRAW_PART_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // ── Clip / bar family: LEGO re-tooled these as "thick C-clip" versions and
  //    issued new design ids; LDraw kept the original part numbers.
  '42923': '63868',   // Plate 1x2 with Clip Horizontal on End (Thick C-Clip)
  '44860': '60897',   // Plate 1x1 with Clip Vertical (Thick C-Clip).
                      //   NOTE: BrickLink calls this 4085d, but LDraw has no
                      //   4085d.dat — the suffix ladder's 4085d→4085 hop lands
                      //   on the THIN-clip mould, so map it explicitly.
  '52738': '61252',   // Plate 1x1 with Clip Horizontal (Thick C-Clip)
  '49563': '60470b',  // Plate 1x2 with 2 Clips Horizontal (Thick C-Clips)
  '65458': '11476',   // Plate 1x2 with Clip Horizontal on Side (Thick C-Clip)
  '44873': '11090',   // Bar Tube with Clip
  '49755': '23443',   // Bar Tube with Handle

  // ── Panels / flags / minifig accessories
  '26169': '4865b',   // Panel 1x2x1 with Rounded Corners
  '49754': '30377',   // Minifig Mechanical Arm with Clips Parallel
  '72154': '30292a',  // Flag 8x3 with Rod (reinforced base). Mecabricks writes
                      //   72154d13 for the 10316-sticker variant; the suffix
                      //   ladder strips d13 first, landing here.

  // ── Minifig legs: 37679 is the dual-moulded short leg. LDraw's 16709
  //    "…Short with Horizontal Stripe" IS that two-tone mould (the stripe is
  //    the second-colour region), not a print — so this is the shape match,
  //    where the plain 41879a is the single-colour leg.
  '37679': '16709',
});
