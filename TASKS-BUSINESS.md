# Business tracker - selling original brick-style packs, the converter, free releases

Open work only; history lives in `git log` (this file's long form is at `8937c74d`). Research here is desk
research, NOT legal advice: a lawyer reviews before anything is listed or sold, and nothing is posted, applied
for, submitted or signed up for without the user's per-instance approval.

## Start here (PAUSED 2026-11-15)
- The user (2026-11-15): "polish the functionality and appearance and performance of the lego replica sets for
  the moment before building our in house ones". Business work is PAUSED; replica-set work is in
  `TASKS-BEDROCK-ADDON.md`. Pick this file up only when the user resumes monetization / store listing.
- Read, in order: this file; `docs/plans/README.md` (master plan, work packages, the user's answers in section 5
  "ANSWERED by the user 2026-11-12", handoff in section 7, binding brief in appendix A); REQUIREMENTS.md section 17
  (`BIZ-01`..`BIZ-67`; `bun scripts/requirements-ledger.ts --open | grep BIZ-` lists what is left).
- Research reports (gitignored, on this machine only): `output/business-1106/{1-legality,2-competition,
  3-pricing-gtm,4-create-list-sell}.md`.
- Merged so far (waves 1-6, all on main, CI green at `4e5963dc`): see `git log --merges --grep=biz-`.

## Decisions (binding)
- Legal verdict (research; a lawyer confirms): selling packs of official LEGO sets is NOT safe - set design
  (derivative work), minifigure sculpture copyright and 3D marks (EU T-297/22, T-298/22), face/print art, LEGO and
  licensor names. LEGO forbids set recreations even in its licensed Fortnite programme. Mojang allows no sales
  outside the Marketplace without written permission. Free fan releases of official sets are lower-damages but
  not safe (the Bionicle takedown, May 2025).
- Chosen 2026-11-09: A (original brick-style packs on the Marketplace via a publisher) + B (bring-your-own-model
  converter on craftmatic.click) + D (free releases with tips). Not C (licensing).
- Brand Craftmatic, creator code `cmt`; publisher and seller "techneesh, llc", contact admin@techneesh.com;
  "tribixbite" only in the credits file. Sampler product id `cmt_sampler`. Private design repo
  `tribixbite/craftmatic-designs` (clone `C:/git/craftmatic-designs`).
- Content rules: our own figure (never the minifig), no LEGO marks/set names/numbers/licensed themes, landmarks
  designed from the real buildings, LDraw attribution shipped, Studio-only meshes resolved away.

## Store listing: where each Marketplace blocker stands
The BIZ-04 agent's seven blockers, read off a 10261 pack on 2026-11-06:
1. Per-pack namespace `<creator>_<pack>:` - rewriter merged (X-03 / BIZ-22 PARTIAL). BIZ-66: a release's nested
   structure id must be quoted (fixed `234deee3`), not yet device-proved.
2. Validator layout - `_mcaddon_check.py --release` + `bun scripts/release-mctools.ts` (X-06, RB): fixture and
   42639 release builds pass mct with 0 errors. Face-art sets (910004 ...) cannot be built as releases.
3. Vanilla concrete textures overwritten - release textures live under `textures/<creator>/<pack>/` (RB).
4. RP `pack_scope: world` + RP->BP dependency - `PackProfile` (BIZ-23 PARTIAL).
5. Size / entities / script cost / permutations - `bun scripts/_marketplace_budget.ts` (BIZ-25 PARTIAL); M03 cut
   permutations; Notre-Dame level 2 is 27.2 MB (> 25 MiB).
6. Air-only placement, prompt, Undo - done offline and on the Pixel 2026-11-13 (BIZ-26 PARTIAL).
7. Player-facing names - lint exists (T02); BIZ-27 / BIZ-55 still OPEN (string table, disclaimer, credits).

Release command: `bun scripts/release.ts prepare|finalize|verify|status <product>` (D-08b, BIZ-56).
Not started: store art and shot list (BIZ-28), the submission bundle, the publisher pitch (Waypoint, Pathway,
Blocklab - needs the user), CurseForge/MCPEDL/itch pages (BIZ-57/58, prepared drafts only), tips (BIZ-59),
the site gallery (BIZ-60), accounts/payments (BIZ-40..44, Stripe TEST mode only).

Unverified price ideas (BIZ-03 agent): free sampler; coaster park 1,340 Minecoins, vehicle garage 990, pinball
830, furniture & doors 660, bundle 1,990; converter $4.99 per model, $8/month, $49/month studios.

## Open items carried from the paused waves
- Content needed before any listing: the sampler (car, door kit, seat kit, small landmark; BIZ-50), and that
  waits on the figure pick.
- FIGURE (BIZ-21, BIZ-67): F01b (rex/rivet/pip) merged as extras. FIG3b on branch `biz-fig3b` (worktree
  `.worktrees/biz-fig3b`, NOT merged): Pim + Tavi, gate margins 0.021 / 0.027 under 0.6, sheet
  `.worktrees/biz-fig3b/output/fig3b/candidates.jpg`, packs `.worktrees/biz-fig3b/output/fig3b/gen3b/{60380,41732}-gen3.mcaddon`
  (sent to the user 2026-11-15). Awaiting the user's in-game pick. Open: boots vs gate, back gap, vehicles seat only
  the player, not in the LEGO tab, hip accessories and doll hair untested.
- RIDE2 (branch `biz-ride2`, worktree `.worktrees/biz-ride2`, 13 commits, last `dd717d7f` 2026-11-13, NOT merged;
  its agent is no longer running): water slides pass the sim 50-300 % (tower not rebuilt since the roof fix); the
  stunt arena FAILS the sim (loop entry blocked, car ~0.7 block high on the deck, nose-up over the loop top).
  Resume by briefing a new agent on that worktree; merge only after the sim passes and the full suite is green.
- MQ2: Brandenburg Gate 20 vs 26 m, Statue of Liberty 46.8 vs 93 m, St Basil's, St Paul's 68 vs 111 m. Its
  regenerated `run.json`/renders in `C:/git/craftmatic-designs` are UNCOMMITTED there.
- LSCALE: level 4 unmeasured; Cologne's tower roof breaks into fins at levels 2 and 4.
- Coaster (C04): device speed, frozen trains outside loaded chunks (ticking-area policy U17), view frames in loops.
  RIDE TODOs: `TODO(rides-merge)`, `TODO(swing-chairs)`, `TODO(funfair-speed)`.
- SV: 43114, 44014, 4997, 60266 have no cockpit spot clear to both sides.
- T02: Guide page 2 "Pack made with craftmatic.click" is flagged by the lint.
- Pixel round 2026-11-13 (`output/device-round-2026-11-13-pixel/`; world `cmt1113` + 5 pack folders left on the
  Pixel): coaster rider stuck "waiting for the other train"; Nimbus flyer missing under `explicitOnly`
  (`TODO(B03-flyer)`); tap-to-board untested in Survival; sim coaster `mp-two-players` leaves 322 entities after
  both players undo.
- L01: the winding field rings tall stacks (`src/convert`).
- Leftover worktree `.worktrees/biz-x02-base`: never remove it (no recursive deletes).

## Binding rules for any agent resuming this
No recursive deletes of any kind; merge never rebase; no bare `git stash`; no git reset/revert/force; fail-first
TDD with the failing run pasted; commit before building packs; full suite before a push, then `gh run list`;
nothing external (pitches, uploads, sign-ups, live keys) without the user's per-instance approval; never accept
the Minecraft EULA for the user; never touch the user's S25 Ultra or the Galaxy tablet.
