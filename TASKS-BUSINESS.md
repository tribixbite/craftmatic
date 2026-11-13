# Business tracker - can craftmatic content be sold, and how

Opened 2026-11-06 at the user's request (REQUIREMENTS.md section 17, `BIZ-01`..`BIZ-04`). Open work only;
history lives in `git log`. Research is desk research by subagents, NOT legal advice: a lawyer decides BIZ-01
before anything is listed or sold, and nothing is posted, applied for or submitted without the user.

## Start here
- STATE 2026-11-06: four research agents running. Each writes its full report (gitignored):
  1. `output/business-1106/1-legality.md` (BIZ-01). Model fable. Covers: copyright in LEGO set designs;
     the LEGO word mark and the minifigure and brick shape marks; licensed themes; LDraw / Studio part-library
     licences; face prints taken from LEGO renders; Mojang usage rules and Marketplace rules; precedents; a risk
     matrix from "official sets with names" down to "original brick-style designs".
  2. `output/business-1106/2-competition.md` (BIZ-02): the Marketplace's size and what sells, converters and
     vehicle/furniture add-ons, brick games (LEGO Fortnite, Brick Rigs, Roblox), positioning, threats.
  3. `output/business-1106/3-pricing-gtm.md` (BIZ-03): Marketplace economics (revenue share, Minecoins,
     Partner programme, Marketplace Pass), other channels, prices for scenarios A-D (below), a 90-day plan.
  4. `output/business-1106/4-create-list-sell.md` (BIZ-04): Partner application, submission and
     certification, technical blockers for our packs, a numbered launch checklist per channel.
- BIZ-02 report LANDED (`2-competition.md`, 35 sources). Load-bearing claim VERIFIED 2026-11-06 on fortnite.com
  ("Introducing the LEGO Brick Editor..."): LEGO's creator rules for its LICENSED Fortnite channel say "No
  recreation of existing LEGO sets and LEGO toys (Rule #6)", plus genuine LEGO elements only (Rule #7), and LEGO
  takes 15% of the payout. So LEGO forbids set recreations even for paying licensees. Not yet verified:
  - MCPEDL rejecting packs named LEGO;
  - the Marketplace figures: over $500M gross since launch (GDC 2024), about 40.2k items from 326 creators, add-on
    median price 660 Minecoins, top furniture packs at 15-24k ratings;
  - the official free LEGO Chicken Mounts add-on (Noxcrew, May 2026) at 34k ratings.

  The agent's positioning: sell the CONVERTER as a tool for creators' own designs (MOCs) and an unbranded
  toy-brick line; keep official-set conversion private until BIZ-01 says otherwise. No competitor found that
  makes LEGO models PLAYABLE in Minecraft; the nearest is ObjToSchematic (static blocks).
- BIZ-03 (`3-pricing-gtm.md`, 37 sources) and BIZ-04 (`4-create-list-sell.md`) LANDED. VERIFIED 2026-11-06 on
  minecraft.net/en-us/usage-guidelines: "You may create, use, or distribute a mod if ..." (never sell), and "If
  something isn't covered by these guidelines ... that probably means we don't want you to do it ... don't do it
  without getting written permission from us". So paid sales OUTSIDE the Marketplace (Gumroad, itch.io, Patreon
  paywalls) need Mojang's written permission.
  The agents' route:
  - **Marketplace through a listed publisher** (Waypoint, Pathway, Blocklab; Mojang's Partner page says it may not
    be accepting applications). Waypoint quotes 8-12 weeks from build to listing.
  - **Free releases with tips** (CurseForge rewards; MCPEDL now uploads via CurseForge).
  - **The converter on craftmatic.click** sold as a tool.

  Price ideas (UNVERIFIED):
  - free sampler;
  - Coaster Park 1,340 Minecoins, vehicle garage 990, pinball 830, furniture & doors 660, a three-pack bundle 1,990.
  - Converter: $4.99 per model, $8 a month, $49 a month for studios.

  Revenue guess (agent's, wide): $0-1.5k in the first 90 days, $2.5-35k over months 4-12. The creator share is
  unpublished: 35-70% modelled.
- Marketplace technical blockers in OUR packs (BIZ-04 agent, read off a 10261 pack; one verified):
  1. one shared `craftmatic:` namespace; Mojang wants a fixed `<creator>_<pack>:` namespace per add-on;
  2. identifier and folder layout that fails Microsoft's add-on validator;
  3. VERIFIED: the RP overwrites vanilla `textures/blocks/concrete_<colour>.png` with stud textures
     (`playable-addon.ts:2633`, `lego-resource-pack.ts:362`), so binding the pack restyles all of the world's
     concrete;
  4. RP manifest lacks `pack_scope: world` and a dependency on the BP;
  5. pack size against a 25 MB guideline, entity counts and script cost on low-end devices, and the collider
     block permutation count (unchecked);
  6. placement must only go into air, ask first, and offer undo;
  7. dev stamps and set numbers in player-facing names.

  None of this blocks free play; all of it blocks a listing.
- BIZ-01 (`1-legality.md`, 50 sources, fable) LANDED. VERIFIED 2026-11-06: EU General Court T-297/22 and
  T-298/22 (6 Dec 2023) upheld LEGO's minifigure 3D trade marks (chaillot.com, ipkitten). Agent's other key cites
  (not re-opened by me):
  - Lego Juris C-48/09 P: the plain brick SHAPE is not a valid trade mark;
  - minifig sculpture copyright upheld in Lego v Best-Lock (2019) and Lego v ZURU;
  - LDraw parts CC BY 2.0/4.0, commercial use allowed with attribution;
  - the Studio EULA forbids redistributing parts of it;
  - LEGO shut down a free Bionicle fan game (May 2025);
  - Mojang's guidelines cite branded cars and movie characters as disallowed.
- DECIDED 2026-11-09: the user chose A, B and D (BIZ-65) and asked for each to be FULLY built. The request:
  >= 20 landmark designs and >= 5 other pack types, incl. a coaster >= 3x Loop with a cloud-top descent and a dark
  in-mountain segment; a part mapper from image + footprint; and bring-your-own-model tested on real user photos and
  files. Process:
  START HERE: `docs/plans/README.md` (the master plan: merged packages, waves, the user's ranked questions U1..,
  handoff in its section 7); review in `docs/plans/business-review.md`; source plans `business-{A,B,D}-*.md`.
  REQUIREMENTS rows BIZ-05..BIZ-64 added 2026-11-09.
  - WAVE 1 ALL MERGED into main 2026-11-09 (suite 3,766 passed): D-03, X-01, X-06, X-08, X-11, B29, B01, X-04, C01.
    Ledger rows set PARTIAL with guards; their gap cells name what is left. Follow-ups found in review:
    - X-11: voxel IoU >= 0.85 on only 3/5 models (wall 0.75, batcave car 0.57); the voxeliser's surface mode
      returns 0 cells under a scaled node (worked around in lattice.ts, not fixed at the source).
    - X-04: official mode does not hard-fail a CLI export (schem-pipeline catches the error into a warning, exit
      0); a release build must call `assertOfficialLibrary()`. LEGO face art is not refused yet; no pack writes
      CREDITS.txt yet.
    - X-06: `bunx @minecraft/creator-tools@0.21.0` crashes at start (ink/react peer mismatch); parser unconfirmed.
    - X-08: its colour/writer tests were written after the code; no bars, round bricks or 4032a in the vocabulary;
      the quarter-turn convention (turn 1 = `0 0 1 0 1 0 -1 0 0`) must be confirmed by X-10.
    - C01: cobra roll stalls (left out of the sketch); handedness vs Bedrock's Z mirror unconfirmed (C02).
    - B29: 34 corpus items need the user's logins; the fetch ran in the b29 worktree, so `data/byom-corpus/` is at
      `.worktrees/biz-b29/data/byom-corpus/` (re-run `bun scripts/byom-corpus-fetch.ts` in main to get it there).
    - Pre-existing (not B01): after an upload the LEGO tab's source badge stays "loading... (no progress)".
    - The X-11 agent ran `rm -r` on its own new scratch folder (rule breach; brief now leads with the rule).
  - WAVE 2a 2026-11-09: MERGED + pushed (suite 3,932 passed, CI green): X-03, X-05, X-09, A05, B09, B15, F01, C03.
    Done, held for checks: X-02->X-17 (`biz-x02`; default-profile builds must match main file for file: 4 favourites
    building into `output/x02-compare/{main,x02}`), X-12 (`biz-x12`; stud-rim cap: wall/plate/tower 1.00, nimbus 0.99,
    batcave car 0.66 because 17 moulds have non-planar open shells -> a winding-number inside test in the shared
    voxeliser is a separate package).
    Review notes:
    - F01's three figures pass the minifig-overlap gate (<0.6) but are crude (floating arms, no face); recommended a
      second design pass (Fable designer) before the user picks (U4). Sheet: `.worktrees/biz-f01/output/f01/candidates.jpg`.
    - B15 ran for real: 3 photos of a Bag End build -> 4.8 MB mesh in 279 s (`.worktrees/biz-b15/output/photo3d-b15/`),
      not yet viewed or graded. DINOv3 encoder licence is unread: blocks any public photo route (lawyer batch U3).
    - X-03: the sim hard-codes `craftmatic:` ids (IX_KEYS etc.), so a rewritten pack's turnable is not tapped (M14).
    - B09: Draco decoding never executed (needs a browser); the corpus has no STL/3MF/PLY/GLB files.
    - C03: the full rail profile is 11,276 cubes for the 3x sketch (lean 4,702); resident memory unmeasured.
    - X-09: side connections (clips, bars, SNOT) are not modelled: 7 of ~27 on-lattice OMR models read as 1 component.
    - Rule breaches: X-12 ran `git checkout <file>` on its own experiment. Fail-first was skipped by B09, A05, X-03,
      X-08 (colour/writer) and F01: the brief now makes the failing run a merge condition.
    - Leftover worktree `.worktrees/biz-x02-base` (X-02's scratch, detached): never remove it (recursive delete).
  - WAVE 2 MERGED 2026-11-09 (suite 4,030 passed): X-02->X-17 (4 favourites byte-identical but the stamp,
    `output/x02-compare/`), X-12, D-06+D-16, M06, X-13, M15, X-14, V-01. Ledger rows set PARTIAL with guards.
    Notes: X-14 proved `_pack_render.ts` is NOT mirrored (offline); M15 found no beta API in any shipped script, and a
    likely bug `GameMode.survival` in the GameTest script; M06: 3 of 4 favourites fail only on 11,008 permutations
    (M03); X-13 thresholds review 0.2 / block 0.5 (recall 94 %); V-01's 1.000 IoU is self-consistency only -> NEXT
    a truth from each brick's footprint cells (winding fills a brick's cavity, which is right for bricks).
  - WAVE 3 MERGED 2026-11-09: D-09, V-02, X-07, A09, D-08, M14, M07, B03, X-10, M03 (+ fixes: Notre-Dame sidecar moved
    out of the ignored `data/` folder to `features/sidecars/`; the placement text's two LEGO mentions reworded and the
    D-08 fixture waiver removed; M03 x M14 conflict in sim `play.ts` and M03 x M07 in `pack-profile.ts` resolved).
    Checks done: M07 favourites differ only in placement.js + stamp, sim 24 scenarios identical, 7 regression cases
    identical (`output/m07-compare/`); M03 dev packs identical but five scripts embedding the kit, passability and
    regressions identical; B03 two favourites byte-identical but the stamp (`output/b03-compare/`).
  - WAVE 4 MERGED 2026-11-12 (after the machine reboot; all six agents resumed from their commits): MQ, A07+A08, L01,
    D-08b, T02 (C02 merges after the suite). Results:
    - MQ: no neighbour buildings (parts < 50 % inside the outline dropped), skillion rise read along the slope (east
      end 96.4 m -> 45.2 m), towers were already separate (the X-10 render's camera hid the gap). Notre-Dame 1 component.
    - A07+A08: real slope roofs (gabled/hipped/shed/spire/conical/pyramidal), openings, relief, flying buttresses.
      Merged with MQ: 22,457 parts, 1 component, 360 slope parts / 7,722 slope cells (floor re-measured; renders
      `output/a07-merged/compare-nw.jpg`). STILL WRONG: the spire is a square stick, not a taper (SPIRE in wave 5).
    - L01: underside cavities filled, studs culled, 27 moved-name aliases + 38 parts. Truth IoU wall/tower 1.000,
      nimbus 0.898 parity / 0.849 winding (winding rings tall stacks: cause in `src/convert` winding field, open).
    - D-08b: `release.ts finalize|verify|status`, M03/M07 flags in release profiles, gate waivers empty, `.io`/`.lxf`
      inputs; `terrain_texture.json` was a checker false positive (now judged by content).
    - T02 `--scenario=marketplace` findings (T02-fix in wave 5): "minifig" in wand/confirm forms and a sentence
      starting "Minecraft only takes a tap"; M03's brick blocks unused (placement writes vanilla concrete); "Find a
      clear spot" can land on the player (`player-not-in-solid`); batcave Undo leaves two `batcave_board_100`.
    - C02: generated coaster plays the full 1,872-block circuit in the sim; 10261/10303 byte-identical but the stamp,
      their regressions identical; 76417/42703 NOT yet compared (orchestrator runs them); camera-continuous flags
      49-59 degree frames (cap 40) on the generated track; launch/brake zones not acted on (C04).
  - DONE by the orchestrator 2026-11-12 (the user's answers): `Craftmatic-Lego-Pack.mcpack` renamed to
    `Craftmatic-Brick-Textures.mcpack` with no LEGO text (deploys on push); private repo `tribixbite/craftmatic-designs`
    created (clone `C:/git/craftmatic-designs`); sampler product = `cmt_sampler`, publisher Techneesh, LLC (display
    name stays a placeholder until the trade-mark search).
  - WAVE 4 PUSHED 2026-11-12 (suite 4,355 passed, CI + deploy green; `Craftmatic-Brick-Textures.mcpack` live, old URL 404).
    Post-merge fixes: TS pack-check ports D-08b's atlas-by-content rule; prepare tests and the sim stage's reason updated.
    C02 pack contract for 76417/42703 RUNNING: `output/c02-coaster-compare.sh` (worktrees `cmp-prec02` at 90aed2e2,
    `cmp-postc02` at 370aa7cd) into `output/c02-compare/{before,after}`; compare with the zip diff (only stamp files
    may differ).
  - WAVE 5 MERGED 2026-11-13 (suite running at merge time; push after green): T02-fix, SV (+ side rule, the user's
    choice), RIDE, C04, MCT, SPIRE, L00. C02 contract finished: 76417/42703 identical but the stamp
    (`output/c02-compare/`). Private repo `craftmatic-designs` main has the 22 landmarks' inputs (pushed, private).
    Results and open items:
    - T02-fix: marketplace scenario clean on nimbus (0/7) and batcave except driver-sees-ahead; regressions 36 OK, 2
      known-unreproduced, 0 failed. Left: Guide page 2 "Pack made with craftmatic.click" flagged by the lint.
    - SV: 8153 out of the body; seeing out 54 -> 58 of 62 with the side rule; 43114, 44014, 4997, 60266 have no spot
      clear to both sides. `--scenario=regressions` not run by SV.
    - RIDE: drop tower (97.5-block rise, 0.9 g fall, 3 g brake) + sky swing (1 g lateral), sim full cycles 25-300 %;
      runs in its own `rides-funfair.js` (`TODO(rides-merge)`); swing chairs rigid (`TODO(swing-chairs)`); 300 %
      drop reaches 108 blocks/s, unmeasured on a device (`TODO(funfair-speed)`).
    - C04: launches, lifts, block brakes (two trains never share a block), trims, per-route cap 52; camera-continuous
      cleared (roll planner + a 28 deg/tick frame-rate limit; the 3x sketch is now 2,111 blocks). Open: device speed,
      trains frozen outside loaded chunks need the ticking-area policy (U17), `coaster-view-clear` frames in loops.
    - MCT: Microsoft's validator runs (`tools/mct/`, react 18 pinned), no EULA asked. Real findings to act on in
      release builds: no `pack_icon.png`, file paths > 100 chars (28 on 910004), an extra README, a terrain atlas
      shape warning; dev packs fail the cooperative-add-on naming rules by design (the rewriter fixes them).
    - SPIRE: staged tapers + cone tips; still stick-like at 1 stud/m (6-stud base) -> LSCALE. Cologne: the outline
      as tall as its parts drops every part in massing (render uses `--building=parts`) -> MQ2.
    - L00: 22 landmarks fetched and run, all 1 component; Eiffel loses 57k cells (disconnected leg volumes, only the
      legs render), Elizabeth Tower top missing (63.5 vs 96.3 m), 4 sites are outline-only boxes (Himeji, Washington
      Monument, Hall of Prayer, Kinderdijk), multi-building sites lose parts (Tower Bridge, Neuschwanstein); real
      heights for Independence Hall, Neuschwanstein, Kinderdijk not recorded; St Basil's 67 vs 47.5 m unresolved.
  - F01c REJECTED by the user (2026-11-13); branch `biz-f01c` kept, not merged. FIG3 (custom-sculpted gen-3 figure,
    Fable) RUNNING in `.worktrees/biz-fig3`.
  - WAVE 5 PUSHED 2026-11-13 (CI green). Post-merge fix: release-script tests set CRAFTMATIC_RELEASE_MCT=skip-for-test
    (the validator now runs; the fixture release has 10 real mct errors -> RB).
  - WAVE 6 IN FLIGHT 2026-11-13 (brief `docs/plans/wave6-brief.md`): FIG3 (Fable, custom-sculpted figure), RB (release
    build passes mct), LSCALE (landmark detail levels + size suggestion), MQ2 (multi-outline sites, outline-vs-parts,
    Eiffel, Elizabeth Tower), RIDE2 (water-slide tower, stunt arena), DEV (Pixel round on release-profile packs,
    evidence `output/device-round-2026-11-13-pixel/`).
  - (Wave 6 plan as written:) LSCALE (landmark detail levels by size + a suggested size), MQ2 (multi-outline sites, outline-vs-parts,
    Eiffel lattice, Elizabeth Tower top), RIDE2 (water-slide tower, stunt arena), the Pixel round (approved; packs
    built from the pushed wave-5 commit with the release profile), release-build fixes from MCT (pack icon, path
    length, README), sampler designs (car, door kit, seat kit, small landmark) once FIG3 is picked.
  - F01b MERGED 2026-11-09 (`biz-f01b`): rex (dinosaur), rivet (robot), pip (bobblehead kid); all pass the gate
    with attached limbs and faces; sheet `.worktrees/biz-f01b/output/f01b/candidates.jpg`; designer recommends rex.
    The user picks (U4).
    (Superseded list:) Wave 2b, still to start: M15, X-14, D-06, D-16, M06 (default: one budget tier), X-13 (the clean-room half
    only); X-15 (its merge needs the user's approval, because every push to main deploys).
  - WAVE 1 (original list) 2026-11-09 (one agent each, worktree `.worktrees/biz-<id>`, branch `biz-<id>`, not merged until
    reviewed + full suite green): X-08 brick core, X-01 identity registry, X-04 part-source ledger + credits, X-06
    release validator, D-03 deterministic zip, C01 coaster design -> path, X-11 mesh -> stud lattice, B29 corpus
    fetcher, B01 model-import service. Agents are Sonnet, briefed with `docs/plans/implementer-brief.md` + their README
    section 3 brief; each reports, then the orchestrator reviews the diff, merges into main (merge commit), runs
    `bun run test`, pushes and checks CI. To see state: `git branch --list 'biz-*'` and `git log main..biz-<id>`.
  - The user answered every open question on 2026-11-12: see `docs/plans/README.md` section 5,
    "ANSWERED by the user 2026-11-12". Still open: the lawyer review (before the first paid listing).

## The user's hypothesis (to test, not assume)
"None of the original source files are used in the resulting distribution, so it is legally feasible,
especially for LEGO Icons structures like Notre-Dame and the Eiffel Tower."

Points the research must settle:
- Not shipping the source FILE does not by itself avoid a derivative-work claim on the set's DESIGN, which LEGO
  designed. This holds for an Architecture or Icons set too: the building is public domain, LEGO's
  interpretation of it is not.
- Pack names carry LEGO set names and numbers, and many sets are licensed themes (Harry Potter, Star Wars,
  Disney, Marvel, car brands).
- Part meshes come from the LDraw library (licence terms to confirm) and from Studio's library.
- Some minifig faces are derived from LEGO's own renders.
- The Marketplace has its own third-party-IP rules on top of the law.

## Scenarios the pricing work compares
- A: unbranded brick-style ORIGINAL content: our own designs, landmarks re-designed, generic vehicles, rides
  and furniture.
- B: a tool or service that converts a creator's OWN brick designs (MOCs) into add-ons.
- C: a licence or partnership (LEGO, or a theme licensor).
- D: free fan releases funded by donations, Patreon or ads, if commercial sale is barred.

## Decisions
- Legal verdict (research, not legal advice; a lawyer confirms before any sale): the user's hypothesis FAILS.
  - A pack ships LEGO's protected expression itself: the set's selection and arrangement of parts re-expressed as
    cuboids (a derivative work); minifigure sculpture and 3D marks; print and face art; LEGO and licensor names.
  - Not shipping the source FILE removes only the fan authors' thin copyright and the library-redistribution
    question.
  - Landmarks: the building is public domain, LEGO's brick interpretation is not (17 U.S.C. 103(b)). So a
    part-for-part 21061 copies LEGO; an INDEPENDENT design from the real Notre-Dame is fine.
  - LEGO also forbids set recreations in its own licensed Fortnite programme, and Mojang does not sanction sales
    outside the Marketplace.

  Safest commercial route:
  - original brick-style designs with a generic studded-brick look (the Brick Rigs model);
  - our own figure proportions, never the minifig;
  - no LEGO marks, no set names or numbers, no licensed themes;
  - landmarks designed from the real buildings;
  - LDraw attribution shipped, and every Studio-only mesh resolved away;
  - sold on the Marketplace via a publisher;
  - plus the converter sold as a tool for creators' OWN designs.

  Free fan releases of official sets are lower-damages but NOT safe (the Bionicle precedent).
- Chosen scenario: A + B + D (2026-11-09). Brand Craftmatic (`cmt`), publisher Techneesh, LLC (2026-11-12).
- Channel:
- Price points:
- Launch checklist:
