import { BRICKLINK_LDRAW } from './bricklink-ldraw.js';
import { HEAD_PRINT_LDRAW } from './head-print-ldraw.js';
import { LSYNTH_PARTS } from './lsynth-parts.js';
import { partStem } from './part-id.js';

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
 * `6397 - ls60` (470 placements, a single set) IS LSynth's string segment under
 * OMR's embedded-section name; `synthesizedPartText` reads it through `partStem`
 * (2026-11-16), where the source does not embed it itself.
 */
export const LDRAW_PART_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // ── Clip / bar family: LEGO re-tooled these as "thick C-clip" versions and
  //    issued new design ids; LDraw kept the original part numbers.
  '67687': '4600',    // Plate 2x2 with Wheel Holders (2021 re-tool with cross slots on the pins; LDraw
                      // 4600 "Plate 2 x 2 with 2 Wheel Pins"). 76240 Tumbler: 2 placements were AABB boxes.
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

  // ── Technic/Bionicle tooth: LEGO's internal design id for a part LDraw
  //    catalogues under its BrickLink/first-release number instead. Verified
  //    2026-09-21 both ways: IOModel2V2's 10303.ldr embeds its own `x346.dat`
  //    (line ~11614, `IsSubModel False` / `IsAssembly False` — a terminal
  //    mesh, not a reference) and that embedded mesh is BYTE-IDENTICAL to
  //    `41669.dat` "Technic Tooth 1 x 3 with Axlehole" — same author (Guy
  //    Vivan), same primitive list and matrices, same tooth-curve vertices to
  //    three decimals (an official part, `!LDRAW_ORG Part UPDATE 2010-01`,
  //    also cross-listed as element 48267). ~450 placements across ~92
  //    corpus files carry `x346` with no embedded definition of their own and
  //    were falling back to an AABB or going missing; sources that DO embed
  //    it (10303) are unaffected because an embedded `0 FILE` definition is
  //    seeded into the text cache before this table is ever consulted (see
  //    `seedDatTexts`/the MPD inline parser) — the alias only fires on a
  //    definitive miss.
  'x346': '41669',

  // ── Generality census 2026-11-16: design ids whose source frame was MEASURED against the target. Mecabricks rows:
  //    the Mecabricks mesh (mecabricks_parts/geometries, mm x 2.5, the harvest's FRAME_SIGN (1, -1, -1)) bounds like
  //    the target, centres within a third of an LDU (`output/gen-mix3/frame_probe.ts` in the gen-mix3 worktree).
  '4973': '30602',    // Brick Curved 2 x 2 with Lip (Rebrickable elements.csv: design 4973 -> part 30602). MB centre
                      //   (0, -11.7, -3.7) vs LDraw (0, -12, -4), sizes 39.8 x 23.4 x 47.3 vs 40 x 24 x 48. 5524: 1 box.
  '52684': 'bl_52684pb05', // Hood over Cap (Rebrickable 52684pat*). Studio maps LEGO 52684 to its copy bl_52684pb05 with a
                      //   zero transform (ldraw_lxfv56.xml); MB centre (0, 9.4, -2.5) vs (0, 9.3, -2.5), sizes within
                      //   0.7. Studio's copy moulds the cap in Reddish Brown (70): a hood whose cap is another colour
                      //   (52684pat0002, white) draws the right shape with a brown cap. TODO(hood-cap-colour). 70420.
  // ── An LDD design id Studio's table maps to its own copy with a ZERO transform (so the LDD frame IS the copy's):
  //    `3566` (Plant, Banana Bunch) -> `bl_3566` (ldraw_lxfv56.xml). IOModel2V2 77072 wrote the bare LDD id; clego's
  //    DbixConvV3 conversion of the same set, which applies Studio's rows, writes `bl_3566` with the same rotation.
  '3566': 'bl_3566',
});

/**
 * Names whose LOCAL file is Studio's own `UnOfficial/parts/<name>.dat` in a
 * DIFFERENT origin frame from the one sources place that name in; resolved to
 * the official mould BEFORE any library probe, so the Studio mesh is never read.
 *
 * `LDRAW_PART_ALIASES` above only fires on a miss. These names never miss:
 * Studio's 2020 library ships a bare file for them, the official library only
 * the suffixed moulds, so the direct probe returns Studio's mesh and the
 * placement lands wherever that mesh's origin says.
 *
 * `60616` (Door 1 x 4 x 6): Studio's file ("GLASS DOOR FOR FRAME 1X4X6 (Needs
 * Work)") runs y -140..-8 - origin at the leaf's FOOT - while `60616a`/`60616b`
 * run y 4..136 from its HEAD, the frame 60596's convention (measured
 * 2026-09-30, centre shift 143.9 LDU, sizes within 1.7 LDU; the z difference
 * is the handle). Sources place it at the frame's origin: in IOModel2V2 186
 * of 197 plain `60616` leaves sit at dy 0 from their nearest 60596 and 10 at
 * +140/+141 (stacked frames); every indexed FIRST PICK placing it (15 sets)
 * is dy 0. Studio's own `.io` writes the same placement as `60616a.dat` in
 * `model.ldr` and `60616.dat` only in `model2.ldr` (LDD ids, what IOModel2V2
 * converts). Only the retired `_Mecabricks*_prev` classes place it at +144.
 * Read through Studio's file, every such door hung one door height ABOVE its
 * frame: 10326's three back doors floated 2.7 blocks over their own doorways
 * (Pixel/Saga round 2026-09-30g) and an access stair lifted the player past
 * the empty frame to reach one.
 *
 * Found by `output/museum-entrance-0930/studio-shadow-scan.ts`: of Studio's
 * 22,692 unofficial files only 5 bare numeric names shadow an official
 * suffixed sibling, and 60616 is the only same-size pure frame shift.
 * TODO(studio-shadow): `64567` ("LIGHT SWORD SHAFT" vs `64567a` hilt) is
 * shifted 35.5 LDU in y with a 8.9 LDU height difference; unmapped until a
 * placement census in a hand shows which frame sources use.
 */
export const STUDIO_FRAME_REDIRECTS: Readonly<Record<string, string>> = Object.freeze({
  '60616': '60616a',
});

/** The official mould a bare name must be read as, when Studio's local file for it is in another frame (`STUDIO_FRAME_REDIRECTS`). */
export function studioFrameRedirect(key: string): string | undefined {
  return key.includes('/') ? undefined : STUDIO_FRAME_REDIRECTS[key];
}

/**
 * The printed LDraw head a BrickLink-named head IS (`3626cpb2588` -> `3626cp0b`), from the libraries' own
 * `!KEYWORDS BrickLink` headers (`HEAD_PRINT_LDRAW`, generated by `scripts/gen-head-print-ldraw.py`). Studio's
 * `.io` exports and the IOModel2V2 conversions write a print as its BrickLink item number, which no library ships,
 * so without this rung the ladder stripped the print and drew the plain `3626c`: 10303's eleven printed heads all
 * shipped the default face (audit 2026-11-15 A-10). The same print on any head mould letter maps alike (BrickLink
 * numbers a print once across 3626b/3626c/28621). Mini-doll prints key on their Rebrickable id (`92198pr0050`).
 */
export function printedHeadFor(stem: string): string | undefined {
  const fig = /^(?:3626[bc]?|28621)pb(\d+[a-z]?)$/.exec(stem);
  // A Studio BrickLink copy (`bl_3626cpb3216`) has its own row, written only when the copy is framed like 3626c.
  const hit = stem.startsWith('bl_') ? HEAD_PRINT_LDRAW[stem]
    : fig ? HEAD_PRINT_LDRAW[`3626pb${fig[1]}`] : /^(92198|28649)pr\d+[a-z]?$/.test(stem) ? HEAD_PRINT_LDRAW[stem] : undefined;
  // A Studio BL copy can be the print itself (`3626cpb2004` IS the row's file): no other name to read it as.
  return hit === stem ? undefined : hit;
}

/**
 * The name LDraw files the SAME element under, from data (`LDRAW_PART_ALIASES`, then `printedHeadFor`, then the
 * BrickLink item numbers LDraw's own keywords name and Studio's exports draw alike, `BRICKLINK_LDRAW`, generated by
 * `scripts/gen-bricklink-ldraw.py`), or undefined. The ladder's first rung; unlike a stripped suffix it is not a near variant, so a CLI build asks the
 * mirror for it before any local near-variant rung (ldraw-geometry.ts).
 */
export function identityAliasFor(stem: string): string | undefined {
  return LDRAW_PART_ALIASES[stem] ?? printedHeadFor(stem) ?? BRICKLINK_LDRAW[stem];
}

/**
 * Alias ladder for part names that exist in NO LDraw library. Converted models
 * name pieces by mould/decoration variants LDraw either never adopted or names
 * differently: mecabricks writes `3626d1024` (head, decoration 1024) and
 * `30367v2` (mould version); BrickLink-lineage sources write `6538c`, `4085d`,
 * `4589b` (lettered mould revisions) and `98138pb042` / `60169p1` (prints).
 *
 * Each hop strips ONE trailing suffix group, most specific first, and the
 * result is only accepted if it really resolves — so a wrong guess costs a
 * cache lookup, never a wrong render. Substituting a sibling mould revision or
 * the undecorated base is a near-identical shape; the alternative is a hole.
 * Every substitution is recorded (`substitutedDatNames` in the viewer,
 * `datSubstitutions()` in the export resolver) and surfaced, so the swap is
 * visible rather than silent.
 *
 * Measured over the clego corpus (6,325 tier-1 .ldr files, 2026-09-02): the
 * ladder resolves 1,323 of 2,639 otherwise-unresolvable names = 20,289 of
 * 39,081 orphaned placements. Chained suffixes need the loop (`u9132v1d1` →
 * `u9132v1` → `u9132`).
 *
 * Deliberately NOT covered: names with no strippable suffix and no entry in
 * LDRAW_PART_ALIASES (`88355`), Studio custom-part hashes
 * (`m102bdfd2_…`, only ever inside a .io archive), `bl_*` Studio synthetics,
 * and genuinely unmodelled moulds (10316 Rivendell's `20926`/`20932`/`1000341`
 * — see the table above for why guessing those is worse than a hole).
 *
 * Lives here (engine, no THREE/DOM) so the viewer, the export/entity resolver
 * and the offline census all run ONE definition of "what may this name be".
 */
export function partAliasCandidates(stem: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([stem]);
  // Explicit design-id → LDraw-name map first: these numbers differ outright
  // (LEGO re-tooled the mould and issued a new design id, LDraw kept the old
  // part number), so no amount of suffix stripping finds them.
  const mapped = identityAliasFor(stem);
  if (mapped) { out.push(mapped); seen.add(mapped); }
  let s = stem;
  // Studio's `rename_<id>` marker (IOModel2V2's ~1,100 placements): the same .io's LDraw-space model.ldr places the
  // plain `<id>` at the identical matrix (910049-closed: `rename_4739a` / `4739a`), so the marked name IS the part.
  // The ladder then continues from it.
  const renamed = /^rename_(.+)$/.exec(s)?.[1];
  if (renamed && !seen.has(renamed)) { out.push(renamed); seen.add(renamed); s = renamed; }
  for (let hop = 0; hop < 4; hop++) {
    const m =
      // decoration / mould-version / print suffix: d1024, v2, p1, pb042, pr0011.
      // The base must END in a digit (optionally + one mould letter) — LDraw
      // part numbers do, and without that guard primitives get shredded
      // (`stud4` → `stu`, substituting nonsense inside every part using it).
      s.match(/^(.+?\d[a-z]?)(?:d\d+|v\d+|p[a-z]{0,2}\d+[a-z]?\d*)$/) ??
      // lettered mould revision: 6538c → 6538, 3626av → 3626a
      s.match(/^(.*\d[a-z]?)[a-z]$/);
    const next = m?.[1];
    if (!next || seen.has(next)) break;
    seen.add(next);
    out.push(next);
    // A hop that lands on a name with a data row reads that row too (`52684d1` -> `52684` -> Studio's `bl_52684pb05`;
    // `72154d13` -> `72154` -> `30292a`). The viewer reached these by re-entering its own ladder per hop; the export
    // resolver probes the candidates as listed, so the row has to be in the list (generality census 2026-11-16).
    const hopMapped = identityAliasFor(next);
    if (hopMapped && !seen.has(hopMapped)) { seen.add(hopMapped); out.push(hopMapped); }
    s = next;
  }
  return out;
}

/**
 * Part text GENERATED for a name no library ships but whose construction is a fixed rule over parts it does ship.
 * Consulted by both resolvers only after a definitive miss (the library and the alias ladder found nothing), so a
 * library or embedded definition always wins. Returns null for every other name.
 *
 * `75c<NN>` - BrickLink's "Hose, Rigid 3mm D. NN L", which Studio names but LDraw does not. Studio's own definition
 * (embedded in 910032's and 910049's model2.ldr for 75c08/10/16/20) is always the same three lines: the hose end
 * `u9053` at the origin, the unit segment `77` stretched (20 NN - 2) LDU from y 1, and the end turned over at
 * y 20 NN. A placement that names `75c<NN>` directly is that STRAIGHT hose; a bent one is a Studio sub-model
 * (`76307.dat Copy 3`, its control points) that the converter already expands. Audit 2026-11-15 A-07: 42172,
 * 910032 and 910049 drew these as bounding boxes.
 *
 * `ls<NN>` - LSynth's own parts (`LSYNTH_PARTS`, generated by `scripts/gen-lsynth-parts.py` from the LSynth 3.1
 * package): the segments and cross sections a synthesised hose, cable, string or band is written as, and the
 * constraint markers. The tool ships them, no library does (Studio has `ls10` alone), so 160,615 placements in 266
 * corpus sources (census 2026-11-16) drew a 4.5 LDU stand-in cylinder in the viewer and a bounding box in an export
 * (8097 Slave I: 40 `ls11` boxes, the generality census). The texts are the tool's, verbatim: each segment's
 * placement matrix stretches it along the path and sets its girth, as LSynth wrote it.
 */
export function synthesizedPartText(stem: string): string | null {
  // `partStem`: an OMR source embeds the segment as `<set> - LS60.DAT` (6397); a conversion that dropped the embedded
  // section (clego's Reconstructed 6397) still names it so.
  const lsynth = LSYNTH_PARTS[partStem(stem)];
  if (lsynth !== undefined) return lsynth;
  const hose = /^75c(\d{2})$/i.exec(stem);
  if (hose) {
    const length = Number(hose[1]) * 20;
    if (length < 20) return null;
    return [
      `0 ~Hose Rigid 3mm D. ${Number(hose[1])}L (generated from u9053 + 77, Studio's construction)`,
      `0 Name: ${stem.toLowerCase()}.dat`,
      '0 !LDRAW_ORG Unofficial_Part',
      '1 16 0 0 0 1 0 0 0 1 0 0 0 1 u9053.dat',
      `1 16 0 1 0 1 0 0 0 ${length - 2} 0 0 0 1 77.dat`,
      `1 16 0 ${length} 0 -1 0 0 0 -1 0 0 0 1 u9053.dat`,
    ].join('\n');
  }
  return null;
}
