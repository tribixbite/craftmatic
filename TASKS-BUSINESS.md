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
  - NEXT (wave 4, no user decision needed):
    - Massing quality on Notre-Dame (X-10 render `.worktrees/biz-x10/output/x10/notre-dame-plain-iso.png`): the two west
      towers merge into one block, east-end heights read far too tall, neighbouring buildings come along; roofs
      are stepped hips. Fix in A05/X-10, then A07/A08 grammars (roofs, windows, the A09 features).
    - Mesh -> bricks: `latticeFromBricks` fills ONE plate layer per brick (X-10 finding); leave studs out of the
      lattice; teach the vocabulary moved names (3023 -> 3023b etc.) and the common missing parts (2420, 4073).
    - C02 (coaster track + cars into a real pack; B03 merged), C04 (launches/brakes), then C05/C06 (clouds, mountain,
      dark zone); T02 sim `--scenario=marketplace`; D-08 finalize/verify; wire M03's flags into `prepare`.
    - A DEVICE CHECK is needed before any store pack: M03's compact collider encoding and brick blocks, and M07's
      placement prompts, on a phone (Pixel round via a Sonnet subagent, per the device rules).
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
  - Waiting on the user: U1 brand/namespace, U2 private designs repo, U3 lawyer batch, U4 figure, U5 landmarks +
    show-stoppers (README section 5); the live LEGO-named `craftmatic.click/downloads/Craftmatic-Lego-Pack.mcpack`
    (rename/take down?).

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
- Chosen scenario: A + B + D (2026-11-09).
- Channel:
- Price points:
- Launch checklist:
