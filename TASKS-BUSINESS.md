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
- NEXT: the legality report (BIZ-01). Then write the verdict and decisions below, and ask the user to choose a
  scenario. When the other reports land, verify the load-bearing claims against the cited pages (agent output is
  untrusted). Write the verdict and decisions below, then ask the user to decide on the scenario.

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

## Decisions (empty until the reports are verified)
- Legal verdict:
- Chosen scenario:
- Channel:
- Price points:
- Launch checklist:
