# Business scenarios for review (BIZ-01..04)

Written 2026-11-09 for the user's decision. It summarises four desk-research reports by subagents. They are
gitignored on this PC, in `output/business-1106/`:
- `1-legality.md`, 50 sources;
- `2-competition.md`, 35;
- `3-pricing-gtm.md`, 37;
- `4-create-list-sell.md`.

**This is not legal advice.** A lawyer decides before anything is sold. Every figure marked *(est.)* is a research
agent's estimate, not a measurement. Mojang does not publish the creator's share of Marketplace revenue.

## The short version

| | What you sell | Legal exposure | Money, first year *(est.)* | Work before the first sale |
|---|---|---|---|---|
| **A** | Original brick-style packs (our own designs) on the Marketplace, through a publisher | Low | $1.5k-25k from month 4 | Large: new designs, our own figure, Marketplace fixes |
| **B** | The converter on craftmatic.click, for creators' OWN models | Low (for us) | $600-7k | Medium: accounts, payments, terms, packaging |
| **C** | A licence or partnership with LEGO or a theme owner | Low legally; unlikely to happen | $10k-50k a project, if it happens | Pitch material (A's packs) |
| **D** | Free releases, funded by tips and donations | Depends on content: Low if original, Medium-High if official sets | $250-3.5k | Small for original content |

**Recommended: A + D now, B as a funnel, C later.**
1. Release one free original pack (D) to build an audience and download numbers.
2. Use those numbers to sign with a Marketplace publisher and sell original packs (A).
3. Open the converter (B) as a beta that brings creators in.
4. Pitch the engine to a big partner (C) once A has shipped.

## Why the current packs cannot be sold, or even safely given away

Your hypothesis was: "none of the original source files are used in the distribution, so it is legally feasible,
especially for LEGO Icons like Notre-Dame and the Eiffel Tower". The research says the premise is true but the
conclusion does not follow.
- **The source file is not what is protected; the set's design is.** A pack re-expresses LEGO's choice and
  arrangement of parts as cuboids. That is a copy or a derivative work of LEGO's design (US 17 U.S.C. 101/106; EU
  InfoSoc art. 2).
- **Landmarks:** the real building is public domain; LEGO's brick version of it is LEGO's (17 U.S.C. 103(b)). A
  part-for-part 21061 Notre-Dame copies LEGO. A Notre-Dame we design ourselves from photographs and plans does not.
- **The minifigure** is protected twice over:
  - by copyright in its sculpture (Lego v Best-Lock 2019, Lego v ZURU);
  - by 3D trade marks, upheld by the EU General Court in Dec 2023 (T-297/22, T-298/22; I verified this one).
- **Face and print art** taken from LEGO renders is LEGO's artwork.
- **Names:** "LEGO", set names and numbers, and licensed themes (Harry Potter, Star Wars, Marvel, car brands) bring
  in trade-mark claims, and a second rights holder for each theme.
- **LEGO's own rules:** LEGO forbids recreating existing sets even for its PAYING partners. Its Fortnite creator
  rules say "No recreation of existing LEGO sets and LEGO toys (Rule #6)"; I verified this on fortnite.com.
- **Mojang** allows distributing add-ons but never says they may be sold outside the Marketplace. Its usage
  guidelines say anything not covered "probably means we don't want you to do it" (I verified this on
  minecraft.net). Gumroad, itch.io and paywalled Patreon sales are therefore out.
- **Free is not safe either:** LEGO shut down a free Bionicle fan game in May 2025. Giving packs away lowers the
  damages; it does not stop takedowns.

The legal report's risk scale, from worst to best:

| Option | Exposure |
|---|---|
| (a) sell official sets under LEGO names (the pipeline today) | Severe |
| (b) the same, unbranded | Severe to High (the set design is still copied) |
| (c) licensed themes, branded or not | Severe, the highest |
| (f) free fan releases of official sets | Medium to High (takedowns) |
| (d) landmarks designed independently from the real building | Low to Medium |
| (e) original designs with a generic brick look ("the Brick Rigs model") | Low |
| (g) a licence | Low legally; commercially uncertain |

The plain brick SHAPE is not protected (EU C-48/09 P, Lego Juris; the patents have expired). That is why
scenario A is open.

## Scenario A: original brick-style content, sold on the Marketplace

**What it is.** The engine we built — rideable coasters, drivable and flyable vehicles with cameras, hinged
doors, seats, pinball — applied to designs that are ours, not LEGO's.
- A generic studded-brick look is allowed.
- No LEGO name or logo, no set names or numbers, no licensed themes, no minifigure.

**Example products and prices** *(est., from a Feb 2026 catalogue scrape; 1,000 Minecoins is about $5.80)*:

| Product | Price | Gross per sale |
|---|---|---|
| Free sampler: one car plus a door and seat kit | free | none |
| Brick Coaster Park | 1,340 MC | ~$7.80 |
| Brick Garage (6-10 vehicles, with chase and cockpit cameras) | 990 MC | ~$5.75 |
| Brick Arcade: Pinball | 830 MC | ~$4.80 |
| Brick Furniture & Doors | 660 MC | ~$3.80 |
| Landmark worlds designed by us ("Brick Paris") | 830 MC | ~$4.80 |
| Bundle of three | 1,990 MC | ~$11.50 |

- **The creator's share.** Mojang said in 2017 that the store takes 30% and creators get "over half" of the rest,
  which is at least 35% of gross. Creators report up to 70%. A publisher takes its own cut on top (the model
  assumes 20%), so we would get roughly $1.60-4.35 per sale.
- **The market** *(not verified)*: over $500M paid to creators since launch, about 300 partner organisations, a
  median add-on price of 660 MC, and a long tail (56% of items have 50 or fewer ratings).
- **Competition:** none of the four reports found anyone else who makes brick models PLAYABLE in Minecraft. The
  nearest tool, ObjToSchematic, makes static blocks.

**How to get onto the Marketplace.** Through a listed publisher (Pathway, Waypoint, Blocklab). Mojang's Partner
page says direct applications may be closed, and the programme expects a registered business. Waypoint quotes
8-12 weeks from build to listing.

**Work on our side before a listing** (the BIZ-04 agent read these off a 10261 pack; I verified item 3):
1. **Designs:** the pipeline converts an LDraw/Studio model. Original designs mean someone builds them in Studio
   or LDCad: you, us, or a commissioned designer. Keep a log showing each was designed independently.
2. **Our own figure:** the walking and seated figures use the minifigure rig. Scenario A needs figures whose
   proportions are clearly not a minifigure's.
3. **Vanilla textures:** the resource pack overwrites vanilla `concrete_<colour>.png` with stud textures, which
   restyles all concrete in the world (`playable-addon.ts:2633`, `lego-resource-pack.ts:362`). This must stop.
4. **Namespace:** one fixed `<creator>_<pack>:` namespace per add-on instead of the shared `craftmatic:`.
5. **Validator:** the identifier and folder layout must pass Microsoft's add-on validator.
6. **Manifest:** the resource pack manifest needs `pack_scope: world` and a dependency on the behaviour pack.
7. **Device limits:** pack size against the 25 MB guideline, entity counts, script cost on low-end devices, and the
   number of collider-block permutations (unchecked).
8. **Placement:** place only into air, ask first, offer undo.
9. **Names:** no dev stamps or set numbers in player-facing names.
10. **Parts:**
    - LDraw parts are CC BY, so commercial use is allowed with attribution: ship the attribution;
    - Studio's EULA forbids redistributing its parts, so every Studio-only mesh must be resolved to an LDraw one.

**Timeline** *(est.)*: free pack and publisher pitch by day 30, first paid pack submitted by day 60. The first paid
release may not be live before day 90.

## Scenario B: the converter, sold as a tool

**What it is.** craftmatic.click turns a creator's OWN brick model (a MOC) into a playable add-on.
- We sell to creators, not to players.
- The terms of service forbid uploading official sets and licensed IP.
- Every output carries Mojang's disclaimer.
- A creator who wants to sell what they make must list it on the Marketplace themselves.

**Why it can work.** Free converters to STATIC blocks already exist. Charge only for what nobody else does: doors,
seats, rideables, coasters, cameras, packaging, and Bedrock validation.

**Tiers** *(est.)*:

| Tier | Price | Includes |
|---|---|---|
| Free | $0 | Viewer, static export, add-ons up to ~300 parts, personal use, watermark |
| Per model | $4.99 ($9.99 over 2,000 parts) | One full interactive export |
| Creator | $8 a month or $72 a year | 20 exports a month |
| Studio | $49 a month, or $500-2,000 per title | Commercial rights, batch export, support |

- **Benchmarks:** Rebrickable's average paid MOC sale is $9; Meshy Pro is $20 a month.
- **Payments:** Gumroad (10% + $0.50, tax handled) or Stripe.

**Risk.** It is low for us as long as the terms forbid official sets and we act on notices. If the tool is
marketed with LEGO set examples, the risk returns. Its showcase must use original models.

**Work on our side:**
- accounts, payments, quotas and a watermark;
- terms of service and a takedown process;
- the same Marketplace fixes as A for users who want to list their output (namespace, validator, textures);
- the export already runs in the LEGO tab.

## Scenario C: a licence or partnership

- **LEGO already licenses brick building digitally,** to Fortnite creators: LEGO takes 15% of the payout, bans set
  recreations, and requires genuine LEGO elements.
- **LEGO and Minecraft deals go through Mojang and big partners:** LEGO Minecraft sets, and the official free LEGO
  Chicken Mounts add-on by Noxcrew in May 2026.
- **A solo developer signing directly is unlikely.** The realistic path is to pitch the ENGINE (automatic
  interactive conversion) to a large Marketplace partner (Noxcrew, Gamemode One) or to LEGO's digital team, as
  work for hire or a royalty deal. *(est.)* $10k-50k per project, or a $2k-8k monthly retainer.
- **Even with a licence,** do not expect permission to reproduce the official set catalogue.
- **What it needs first:** shipped scenario-A packs to show what the engine does.

## Scenario D: free releases, funded by tips

- **Channels:** CurseForge (MCPEDL now uploads through it) and itch.io free downloads, plus Ko-fi tips, a Patreon
  dev log with NO paywalled packs, CurseForge rewards, and video ad revenue.
- **Expected** *(est.)*: $20-300 a month in tips at 10k-50k downloads a month, CurseForge rewards about $0.20 per
  1,000 downloads, and the Minecraft affiliate programme (5% of Marketplace referrals).
- **Risk depends on what is released:**
  - original content (A's designs): low, and it builds the audience A needs;
  - official sets: medium to high. Takedowns are likely, and the Bionicle game shows LEGO acts against free
    projects. It is not a business.

## What I need from you

1. **The scenario.** Recommended: A + D, with B as a funnel. Or pick any combination.
2. **Who makes the original designs:** you, us (from photographs and plans, with a provenance log), or a
   commissioned designer.
3. **A business entity:** the Partner programme and publishers expect one.
4. **Approval for each outward step.** Nothing is posted, applied for or submitted without it: publisher pitches,
   CurseForge uploads, Reddit showcases.
5. **A lawyer** for the 10 questions in `1-legality.md` section 6.2, before the first paid listing.

Once you choose, the matching engineering work (the Marketplace fixes, the non-minifig figure, the converter's
accounts and payments) goes into `TASKS-BUSINESS.md` as tracked items.
