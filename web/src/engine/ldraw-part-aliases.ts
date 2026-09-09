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
 * A ROW IS A FILENAME SUBSTITUTION ONLY — there is no transform slot, so the
 * LDraw part renders at whatever matrix the harvested `.ldr` already wrote.
 * That makes IDENTITY only half the test; the other half is the FRAME.
 *
 * For Mecabricks-lineage sources the frame is decided upstream, in clego's
 * `mecabricks_align.json`: `harvest_mecabricks_sets.py` pre-subtracts a
 * per-part origin `delta` (and post-multiplies a rotation) for every design id
 * `mb_align` could RESOLVE, and writes `method: "unresolved", delta: [0,0,0]`
 * for the rest — leaving those in the Mecabricks part frame (origin at the
 * footprint centre) instead of the LDraw one (origin on the stud plane).
 * Checked 2026-09-09: all 11 rows below are `resolved` there with `ldraw`
 * exactly equal to the alias target, which is WHY they land correctly — the
 * offset is already baked into the corpus. Every remaining census offender is
 * `unresolved`, so a new row is safe only if the two frames happen to coincide
 * anyway. Test it: compare the Mecabricks mesh bbox (mm × 2.5, F = diag(1,−1,1))
 * against the LDraw part's own bbox and require the CENTRES to agree. A size
 * difference is tolerable (different tessellation/detail); a centre shift is
 * the piece landing in the wrong place.
 *
 * Deliberately NOT mapped — a wrong placement is worse than a visible hole.
 * Each of these has a CONFIRMED identity and fails only on the frame, with the
 * measured centre shift given so nobody re-derives it:
 *   98560     → 3684c    70.0 LDU (Slope 2x2x3; ldraw.xml + the target's own
 *                        `!KEYWORDS Rebrickable 98560`). The single biggest
 *                        offender in the corpus and still not mappable here.
 *   20926/932 → 20460b/  10.0 LDU LATERAL each. Supersedes the old note in this
 *               20461b   file, which was wrong twice over: LDraw DOES model the
 *                        dual mould (`~Minifig Leg Left/Right Dual Mould`, sizes
 *                        match to 0.2 LDU), and the `!HELP Move down 12 units`
 *                        those parts carry is NOT the discriminator — the whole
 *                        leg family carries it. The real blocker is that
 *                        Mecabricks emits the two legs 20 LDU apart while LDraw
 *                        parts each carry their own ±10 LDU offset internally,
 *                        so substituting splays them to ~40 LDU.
 *   65460     → 60475b   22.0 LDU  ·  65514 → 30000  24.0  ·  35293 → 4865b 24.0
 *   84411     → 25269     8.0 LDU — exactly one plate; identical size (0.1 LDU).
 *                        The textbook case: right mould, wrong origin.
 *   65570     → 30261     5.3 LDU  ·  53968 → 92582  8.0  ·  59121 → 35700  8.0
 *   1000337-41 → 37341a-e The 37341 sprue IS modelled now (a–e, added 2022-2024),
 *                        which retires this file's old "genuinely unmodelled"
 *                        note — but the five Mecabricks ids do NOT map onto it
 *                        consistently (measured centre shifts 0.55, 2.16, 5.5,
 *                        10.7, 14.7 LDU). One sprue in one frame should give one
 *                        offset; it doesn't, so the assignment is unestablished.
 *   11402pN              Not a part — the nine-tool sprue. LDraw models the
 *                        members separately (`604547`… `604615`); a bare-stem
 *                        row would render 8 of 9 as the wrong tool.
 *   60797, 74340, 98782  Colour-baked shortcuts (`60797c01/c02/c03` differ only
 *                        by glass colour) — any single target forces one colour.
 *
 * WHERE THE REAL FIX LIVES: every "confirmed identity, wrong frame" row above
 * would land correctly the moment clego's `mb_partmap.resolve()` learns the
 * design→LDraw mapping, because `mb_align` would then bake the delta at harvest
 * time exactly as it did for the 11 rows here. That is a corpus regeneration,
 * not a table edit. The alternative on our side is giving this table a
 * transform column, which is an architecture decision, not an evidence one.
 *
 * SCALE, so this is not over-invested in: a 214-set census on 2026-09-09
 * (`scripts/missing-geometry-census.ts`, 564k placements) found the corpus hole
 * rate is 0.067% — 379 pieces / 111 names, of which mecabricks-lineage sources
 * carry 369. omr/io/dbix/recon/pdf_recon/lxf are all at zero, and there are no
 * unresolved sub-file refs inside resolved parts at all.
 *
 * Two residual classes are upstream data defects, not resolution failures —
 * don't chase them here:
 *   `rename_3023`/`rename_32123b`/… (1,088 placements, ~30 files) — an
 *      un-stripped marker in clego's IOModel2V2 extractor output.
 *   `m102bdfd2_…` (~900) — Studio CustomParts, which only exist INSIDE the
 *      .io archive; the extracted standalone .ldr references them without
 *      shipping them.
 * And one open candidate on OUR side: `6397 - ls60` (470 placements, a single
 * set) looks like an LSynth segment carrying its parent part's name, which
 * synthesizeLsSegment's /^ls\d{1,3}$/ misses. Confirm the block really is a
 * flex run before widening that regex — one set is thin evidence.
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

  // ── Window glass. Verified 2026-09-09 both ways, and it is the only one of
  //    111 census offenders that passed the frame test as well as the identity
  //    test. Identity: Rebrickable `elements.csv` design_id 35318 → part_num
  //    60603; LDraw's `60603.dat` is `// Alias of 86210`, and `86210.dat`'s own
  //    header carries `!KEYWORDS … BrickLink 60603, Rebrickable 60603`.
  //    Frame: Mecabricks mesh vs 86210 bbox centres agree to 0.83 LDU (a tenth
  //    of a plate), with no rotation implied by the per-axis extents.
  '35318': '86210',   // Glass for Window 1 x 4 x 3 Opening

  // ── Minifig legs: 37679 is the dual-moulded short leg. LDraw's 16709
  //    "…Short with Horizontal Stripe" IS that two-tone mould (the stripe is
  //    the second-colour region), not a print — so this is the shape match,
  //    where the plain 41879a is the single-colour leg.
  '37679': '16709',
});
