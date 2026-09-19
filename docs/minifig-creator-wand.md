# Minifig creator wand — in-game UI/UX architecture (2026-09-19)

Design for a second hotbar wand that lets a player assemble, preview, place,
save and re-edit custom minifigs and mini-dolls **inside Minecraft Bedrock**,
using only the three `@minecraft/server-ui` form types. Companion to the
[Bedrock add-on guide](bedrock-addon-guide.md) and the tracker
`TASKS-BEDROCK-ADDON.md`; the browser-side builder it extends is
`web/src/ui/minifig-builder.ts` (`minifigFromSpec`, `engine/minifig-rig.ts`).
Status: **architecture only — nothing here is implemented.** A typed skeleton
of the shared contract compiles at `web/src/engine/minifig-creator-types.ts`.

Every claim below is tagged **[V]** (verified against code, the 2.9.0 / 2.1.0
typings, or Microsoft's docs — sources in §9) or **[A]** (assumed; needs a
device round or a measurement before it is relied on).

## 0. The one architectural fact everything follows from

**The game cannot compile geometry.** The script API has no mesh or model
construction; every shape an entity can show must be a `.geo.json` in the
resource pack when the world loads **[V]**. So an in-game creator cannot offer
"any LDraw part" — it offers the **part library the exporter compiled into the
pack**, and the in-game job is choosing among those parts and colours.

The mechanism that makes one entity type wear any combination is the one the
probe pack already ran on the Pixel: **client-synced entity properties read by
render controllers** (`q.property('craftmatic:…')` indexing
`arrays.geometries` / `arrays.textures`) **[V]** — Microsoft's own
"shapeshifter" example selects geometry AND texture from arrays by a property
(§9, entity-properties intro), and `scripts/_bedrock_probe_pack.py` drove a
bone rotation from a client-synced int on the device (§9).

Consequences that shape the rest:

- ONE entity type per pack, `craftmatic:<packid>_minifig`, with ≤ 32 properties
  (the per-type limit **[V]**). Changing a slot is `entity.setProperty()` **[V]**,
  applied next tick — no re-summon, no second entity.
- Colour is a **texture choice**, not geometry: the pack already ships one
  16×16 flat swatch per LDraw colour (`legoMaterialSwatchName`, box UV,
  shipped 2026-09-19) and every mesh is single-colour, so a slot's colour is
  `Array.swatch[q.property('craftmatic:c_<slot>')]`.
- A **printed** part is not one colour: its print survives the prototype as
  its own cuboids (`ldraw-part-prototype.ts:21`, measured below: 973 plain 23
  cuboids at 4 LDU, `973pbs` 53). So a library part is compiled as a *main*
  mesh (colour 16 → slot-tinted) plus up to `K` fixed-colour *print layers*,
  each its own render controller.
- The library is definition-side memory (§7): `739 MB + ~3.08 kB per cuboid`
  whether or not any figure stands in the world. Library size is therefore a
  cuboid budget the exporter shows, exactly like `packCuboidBudget()` today.

## 1. Interaction model

**Item.** `craftmatic:<packid>_minifig_wand`, a `minecraft:item` like the
brick wand (`bedrock-placement-pack.ts:915`, `menu_category: items`,
`max_stack_size 1`, icon `brick`; a distinct icon is optional polish). It ships
only in packs exported with a creator library; a set pack without one has no
second wand.

**Obtaining.** Creative inventory, or the pack's grant function: the existing
`/function <alias>` (`placementAlias`) gains a second `give @s <minifig wand>`
line, and a second short alias `mf_<6hex>` gives only the minifig wand. The
README paragraph names both.

**Opening.** Exactly the brick wand's two triggers, both **[V]** in
`placementRuntime`:
1. hotbar selection — the 5-tick `system.runInterval` that reads
   `p.getComponent('minecraft:inventory').container.getItem(p.selectedSlotIndex)`
   and opens once per activation transition;
2. `world.afterEvents.itemUse` (`ev.itemStack.typeId`, `ev.source`) → the main
   menu via `system.run`.

**Gestures** (all resolved inside the event handler from `Player` state — the
form API has no gesture of its own):

| gesture | event | condition | action |
|---|---|---|---|
| use in air | `afterEvents.itemUse` | `!source.isSneaking` **[V]** (`Entity.isSneaking: boolean`, typings 8600) | main menu (§2 F1) |
| sneak + use | `afterEvents.itemUse` | `source.isSneaking` | **quick place**: a copy of the current draft at the aim point (`getBlockFromViewDirection`, 96 blocks, same face rule as the brick wand's aim), no form. If there is no draft yet: opens F1. |
| use on a creator figure | `beforeEvents.playerInteractWithEntity` **[V]** (`cancel`, `itemStack`, `player`, `target`) | `itemStack?.typeId === wand && target.typeId === figType` | `cancel = true`; `system.run(() => editPlaced(player, target))` (§2 F10). Before-event callbacks are restricted-execution and `show()` "can't be called in restricted-execution mode" **[V]**, hence the `system.run` hop. |
| use on any other entity | same event | wand held | `cancel = true`, then F1 (so a wand tap on a villager never trades). |
| use on a block | `afterEvents.itemUse` | — | same as use in air. Whether `itemUse` fires for a non-placeable custom item used ON a block is **[A]**; the brick wand has only ever been opened from the hotbar poll and air use. If it does not, `afterEvents.playerInteractWithBlock` **[V]** (typings 22360) is the fallback and the plan includes it. |

**Draft.** Each player has at most one *draft* entity: a live figure of the
pack's type standing where it was summoned, with `craftmatic:draft = true`
(bool property) and the owner's `player.id` in an entity dynamic property
`craftmatic:owner` (`Entity.setDynamicProperty` **[V]**, typings 9523). It IS
the preview (§5). The runtime removes drafts it owns on `playerLeave` and
every draft of the type at script start, the way `placementRuntime` clears
ghosts by type.

**Events used, complete list**: `world.afterEvents.itemUse`,
`world.beforeEvents.playerInteractWithEntity`, `world.afterEvents.playerLeave`,
`system.runInterval`, `system.run`, `system.runTimeout`; optional fallback
`world.afterEvents.playerInteractWithBlock`. All **[V]** in the 2.9.0 typings.

## 2. Screen flow

Conventions that hold on every form:

- **Back is explicit.** Every `ActionFormData` ends with a `Back` button;
  every `ModalFormData` cancel (`canceled === true`) returns to its parent;
  `MessageFormData` uses `button2` as the negative/back choice. The X /
  Escape close of any form returns to the parent, never to nothing (the brick
  wand's `if (r.canceled) return menu(p)` pattern).
- **Busy guard.** One `showing` set per player (as today) plus: a response with
  `cancelationReason === FormCancelationReason.UserBusy` **[V]** is retried
  after 10 ticks, up to 3 times, then told "Close the chat/other screen and
  open the wand again." Today's wand drops such opens silently.
- **Title** = `<pack label> · Minifig · <screen>`; **body** = the draft summary
  line: `Knight · minifig · torso 973pbs Red · head 3626cp01 Yellow · …` and
  the world count `Figures placed: 12 of 200`.
- Button labels are ≤ 40 characters; a description is cut at a word boundary
  with `…` and the full description goes in the *body* of the next screen.

Numbered flow (F = form; the type is the exact `@minecraft/server-ui` class):

**F1 Main** — `ActionFormData`. Buttons, in order:
`Head` · `Hair / headwear` · `Torso` · `Arms & hands` · `Hips & legs` ·
`Held items` · `Back (cape, pack)` · `Name, family & behaviour…` ·
`Place…` · `My figures…` · `Discard draft` · `Close`.
`Discard draft` removes the draft entity and clears the player's state
(F1 reopens with the pack default). `Close` is the Back of the root.
When the player has no draft, F1's body says so and the first slot tap
summons one (§5).

**F2 Slot** — `ActionFormData`, one per slot, title `… · Torso`. Body: the
full description of the current part and its colour name. Buttons:
`Change part…` (→ F3) · `Change colour…` (→ F6) · per-slot extras · `Back`.
Extras: *Arms & hands* has `Arm colour…` and `Hand colour…` (two colour
properties); *Hips & legs* has `Hip colour…` and `Leg colour…`; *Hair* and
*Held items* and *Back* have `None` (sets the part index to 0, the empty
geometry); *Held items* opens as a two-button chooser `Right hand` / `Left
hand` then the normal slot screen.

**F3 Part groups** — `ActionFormData`. Title `… · Torso · choose a group`.
Buttons: one per group in the slot's library (`<group> (<n>)`), then
`Search…` (→ F5), `Back`. A slot with ≤ 8 parts skips F3 and opens F4
directly with all of them.

**F4 Part page** — `ActionFormData`. `header('<group> · page i of n')`
**[V]** (`ActionFormData.header`, 2.1.0). Up to `PAGE_SIZE = 8` part buttons,
label `<short description>` (the id is in the body of F2 afterwards, not on
the button), optional icon (§3.4), then `Next page ›` / `‹ Previous page`
(only when they exist), `Back`. Selecting a part: `draft.setProperty(slotProp,
index)`, message `Torso: <description>`, return to **F2** (not F4) so the
player sees the change and can pick the colour next.

**F5 Search** — `ModalFormData` **[V]** (`textField`, `dropdown`, `toggle`,
`submitButton`): `textField('Contains', 'e.g. jacket, police, striped')`,
`dropdown('Group', ['All groups', …groups], { defaultValueIndex: 0 })`,
`toggle('Printed parts only', { defaultValue: false })`,
`submitButton('Search')`. Submit → F4 over the filtered list, header
`Search "police" · 14 results · page 1 of 2`. No results → `MessageFormData`
"No part matches …" with `button1('Search again')` → F5, `button2('Back')` → F3.

**F6 Colour** — `ActionFormData`, title `… · Torso colour`. Page 1: the
**common 24** (§4) as buttons `<name>` with the swatch icon; `More colours ›`
→ pages of 12 over the rest of the exposed set; `Back`. Selecting →
`setProperty(colourProp, index)`, return to F2.

**F7 Name, family & behaviour** — `ModalFormData`:
`textField('Name', 'shown above the figure', { defaultValue })` (≤ 24 chars;
sets `nameTag` **[V]**), `dropdown('Family', ['Minifig', 'Mini-doll'])`,
`dropdown('When placed', ['Wanders like an NPC', 'Stands still (statue)'])`,
`toggle('Always show the name')`, `submitButton('Apply')`.
Changing the family → **F7a** `MessageFormData` "Switching to mini-doll
resets every part to the doll defaults. Colours are kept." `button1('Switch')`
/ `button2('Keep minifig')`.

**F8 Place** — `ActionFormData`. Body: where the draft stands, the world
count, and the cap warning when ≥ 180 of 200. Buttons:
`Place where the draft stands` · `Place at the block I look at` ·
`Place and keep this draft` · `Back`.
Placing = `draft.setProperty('craftmatic:draft', false)` +
`triggerEvent('craftmatic:release')` (adds the NPC group, §6) for the first
two (the draft BECOMES the figure and the player's draft slot empties); the
third spawns a new entity, copies the 21 property values and the name, and
releases that one. At the cap (§7) F8 shows only `Back` and says why.

**F9 My figures** — `ActionFormData`:
`Save the draft as…` (→ F9a `ModalFormData` textField name, submit) ·
`Load a saved figure…` (→ F9b list pages, `PAGE_SIZE` 8, select → confirm
`MessageFormData` "Replace the current draft?" → applies) ·
`Presets from the export…` (→ F9b over `CONFIG.presets`) ·
`Show the figure code in chat` (§6) · `Enter a figure code…` (→ F9c
`ModalFormData` textField, submit → decode → draft) ·
`Delete a saved figure…` (→ F9b → `MessageFormData` confirm) · `Back`.

**F10 Placed figure** — `ActionFormData`, reached by using the wand on a
placed figure. Body: its name and parts. Buttons: `Edit this figure` (it
becomes the player's draft *in place*: `craftmatic:draft = true`,
`craftmatic:npc_off` event; the previous draft, if any, is removed after a
`MessageFormData` confirm) · `Copy as a new draft` · `Remove this figure`
(→ `MessageFormData` confirm) · `Back`.

Depth from F1 to a chosen part is F1 → F2 → F3 → F4 (four taps plus paging);
to a colour F1 → F2 → F6.

## 3. The part-browsing problem

### 3.1 What there is to browse (measured over `C:/git/clego/ldraw_ref/official/parts`, 24,735 `.dat`)

| slot family | files by description | of which undecorated moulds |
|---|---|---|
| `Minifig Torso` | 1,655 (776 are `973p*`; 870 are other torso ids) | 59 |
| `Minifig Head` | 631 (401 are `3626*p*`) | 116 |
| `Minifig Hair` | 217 | 141 |
| `Minifig Hat/Helmet/Cap/Headdress/Hood/Crown/Visor/Beard/Mask/Bandana` | 375 | 233 |
| `Minifig Hips and Legs` / `Minifig Leg` | 210 / 323 | 35 |
| `Minifig Arm` / `Minifig Hand` | 93 / 12 | — |
| capes, backpacks, air tanks, epaulettes, armour, wings, jet packs | 64 | — |
| `Figure Friends` head / torso / hips+legs / hair / arm (mini-doll) | 26 / 153 / 111 / 28 / 51 | — |

So "thousands" is the decorated tail: **1,655 torsos are 59 moulds with
prints**. Two conclusions drive the design:

1. **Prints are worth shipping** — they are what makes a torso *that*
   torso, and they render (as fixed-colour cuboids). But each print is its own
   geometry, so the exporter, not the game, chooses how many.
2. **A flat list is never shown.** The library is chosen at export time
   (§3.2), grouped at export time (§3.3), and paged in-game with a text filter
   (§3.4). The in-game code never sees more than one slot's list.

### 3.2 The library is chosen at export, sized by cuboids

`MinifigLibrarySpec` (skeleton in `minifig-creator-types.ts`): per slot an
ordered list of `{ part, group, label }`, plus the exposed colour list. The
web builder offers three tiers and a custom list:

| tier | per slot (minifig) | mini-doll slots | ≈ cuboids at 4 LDU | ≈ at 2 LDU | ≈ MB at 3.08 kB |
|---|---|---|---|---|---|
| `starter` | 8 torsos, 8 heads, 12 hair/headwear, 2 leg pairs, 8 held, 3 back | 4 / 4 / 4 / 4 | ~1,000 | ~3,600 | 3 / 11 |
| `standard` (default) | 24 / 24 / 32 / 4 / 16 / 6 | 12 / 12 / 12 / 8 | ~2,900 | ~10,000 | 9 / 31 |
| `large` | 64 / 64 / 64 / 8 / 32 / 8 | 24 / 24 / 24 / 16 | ~7,800 | ~27,000 | 24 / 83 |

Per-part costs the sums are built from (`bun` scratch over
`compileLdrawEntityGeometry(...,'prop',…,{quality, wholeModel:true})`, Studio
library, 2026-09-19; identical on the official library except 3818 68 vs 66):

| part | what | 4 LDU (balanced) | 2 LDU (high) | 1 LDU (ultra) |
|---|---|---|---|---|
| 973 / 973p01 / 973pbs | torso plain / striped / complex print | 23 / 27 / 53 | 51 / 57 / 161 | 130 / 148 / 446 |
| 3626c / 3626cp01 | head plain / grin | 17 / 23 | 94 / 105 | 268 / 282 |
| 3901 / 3625 / 3624 / 2446 | hair m / hair f / police hat / helmet | 27 / 32 / 26 / 44 | 113 / 177 / 134 / 161 | 113 / 177 / 497 / 161 |
| 3815 / 3816 / 3817 | hips / leg R / leg L | 18 / 18 / 12 | 48 / 42 / 42 | 101 / 67 / 81 |
| 3818 / 3820 | arm / hand | 18 / 8 | 66 / 24 | 243 / 77 |
| 3847 / 3846 / 4524 / 3962 | sword / shield / cape / radio | 4 / 10 / 11 / 17 | 15 / 23 / 48 / 36 | 51 / 47 / 87 / 56 |
| 1006030 / 92198 / 101117 / 11605 / 92244 / 100937 | doll torso / head / hips+legs / hair / arm / legs | 14 / 17 / 41 / 49 / 17 / 43 | 44 / 68 / 168 / 253 / 44 / 139 | 158 / 223 / 168 / 253 / 127 / 139 |

A whole default figure is **136 cuboids** (9 parts) and **186** with hair,
sword, shield and cape (13 parts), both from `scripts/_minifig_ref.ts` at the
default `balanced` quality **[V]** — the clamp (`clampFigureQuality`) only
LOWERS a `high`/`ultra` request to 2 LDU; a default pack compiles figures at
4 LDU. The library follows the pack's `entityQuality` through the same clamp,
so the 4 LDU column is what a default export pays.

The exporter prints the library's cuboid total into
`craftmatic-diagnostics.json` (`pack.minifigLibraryCuboids`) and the export
warning, in the same sentence shape as `packCuboidBudget()`.

### 3.3 Grouping is done at export from the LDraw description

Groups are derived once, offline, from the description string (the thing the
in-game filter also searches), so the runtime ships them as data:

- **Torso**: the text after `Minifig Torso with Arms and Hands with ` (or the
  mould name when there is no print) is matched against an ordered keyword
  table: `Plain` (no print) · `Shirts & jackets` (`shirt|jacket|vest|hoodie|
  sweater|t-shirt`) · `Suits & uniforms` (`suit|tie|uniform|police|fire|
  medic|pilot|badge`) · `Armour & fantasy` (`armou?r|chain ?mail|knight|
  breastplate|robe`) · `Space & sci-fi` (`space|classic space|astronaut|
  robot|circuit`) · `Sports` (`soccer|team|stripes|jersey|number`) · `Dresses
  & costumes` (`dress|costume|gown|kimono`) · `Other prints`. Measured on the
  776 `973p*` descriptions the top themes are exactly these ("Female"
  38, "White" 27, "Jacket" 25, "Dark" 25, "Blue" 22, "Soccer" 19, "Black" 18,
  "Dual Mould" 16 …), so the table is data-driven, not guessed; any new
  keyword row is a one-line change in `MINIFIG_GROUP_RULES`.
- **Head**: `Plain` · `Smiles` · `Glasses & goggles` · `Beards & moustaches` ·
  `Female` · `Angry / battle` · `Special (alien, robot, animal)` · `Other`.
- **Hair / headwear**: `Hair · short` · `Hair · long` · `Hats & caps` ·
  `Helmets` · `Crowns, hoods & masks`.
- **Legs**: `Plain` · `Printed` · `Short legs` (`Minifig Legs Short`).
- **Held**: `Weapons` · `Tools` · `Food & drink` · `Gadgets` · `Other`.
- **Mini-doll** slots use `Plain` / `Printed` only; the doll library is small.

A part that matches no rule lands in `Other …`, never dropped. The exporter
lists group sizes in the diagnostics so a lopsided table shows up.

### 3.4 Paging and search in-game

- `PAGE_SIZE = 8` part buttons per F4 (a phone in landscape shows 8-9 buttons
  without scrolling next to the header and the 2-3 navigation buttons; the
  brick wand's 12-13-button menu already needs a swipe on the Pixel, §9).
- The filter is `ModalFormData.textField` **[V]**: lower-cased, split on
  whitespace, every token must be a substring of `label + ' ' + part + ' ' +
  group`. An id typed exactly (`973pbs`) therefore works as search.
- Worst case with `large`: 64 torsos = 8 pages, and any two-word filter
  (`blue jacket`) lands on one page. With `standard`, 24 = 3 pages.
- **Icons [A]**: `button(text, iconPath)` takes a resource-pack texture path
  **[V]**. Colour buttons use the swatch PNGs the pack already ships
  (`textures/entity/craftmatic_swatch_<id>`). Part icons need a 32×32
  orthographic front silhouette per library part, which
  `scripts/_entity_silhouette.ts`'s renderer can produce at export from the
  compiled cuboids; that is a polish phase (plan step 9), and whether a 16-colour
  silhouette reads on a phone is unmeasured.

## 4. Colour selection

There is no colour picker; colour is a **button list with swatch icons**
(F6), two tiers deep:

- **Exposed set**: `MINIFIG_CREATOR_COLOURS`, 48 LDraw colours — the 28 the
  web builder already puts first (`colorChoices` in `ui/minifig-builder.ts`:
  0 15 4 1 2 14 19 71 72 70 25 27 5 26 22 28 308 320 321 322 323 191 226 484
  85 84 378 379) plus 12 more solids (3 6 7 8 10 11 13 17 18 20 29 73 → the
  classics and the pastel/light tones), 3 opaque finishes (chrome silver 383,
  pearl gold 297, flat silver 179 — PBR maps only) and 5 translucent ones
  (trans clear 47, trans red 36, trans dark blue 33, trans yellow 46,
  glow-in-dark trans 294), in that order so the blend boundary is one index
  (`FIRST_TRANSLUCENT_COLOUR = 43`). Every one has an entry in
  `LDRAW_COLOR_RGB` (178 ids), a name in `ldraw-color-names.json` and a
  material class from `resolveLdrawEntityMaterial` (abs / transparent /
  chrome / pearl / glow) — checked by script 2026-09-19, 48 ids, 0 duplicates
  — so a swatch (+ MER/normal) exists for each.
- **Page 1 "common 24"** = the first 24 of that list; **"More colours"** pages
  the remaining 24 in 2 pages of 12. Names come from
  `web/public/ldraw-color-names.json` (148 names) at export and ship in CONFIG.
- **Render**: the colour list is ONE texture array on the client entity
  (`Texture.sw_<k>` → `textures/entity/craftmatic_swatch_<id>`), shared by
  every slot's render controller: `textures: ["Array.swatch[q.property('craftmatic:c_torso')]"]`.
  Translucent finishes use `Material.blend` (`entity_alphablend`, the
  existing translucent path): `materials: [{"*": "Array.mat[q.property('craftmatic:c_torso') >= FIRST_TRANSLUCENT]"}]`
  with the opaque colours ordered first — an array indexed by a boolean-valued
  expression is the documented `Array.materials[query.is_invisible]` form **[V]**.
- Ten colour properties (§6), so the same swatch array serves head, hair,
  torso, arms, hands, hips, legs, held-right, held-left, back.
- Skin default: hands = head colour on first summon (the web builder's rule),
  after which each is independent.

Why 48 and not 178: each colour costs one texture slot per client entity and
one button page; 178 would be 15 pages and nothing in a minifig's palette
needs the LDD-only ids. The number is a constant, not a limit (`Array` size
has no documented cap **[A]**).

## 5. Preview

**The draft IS the preview.** A creator figure is a live entity whose whole
look is 21 property values, so the preview is the entity standing in front of
the player and every change is `setProperty` — applied next tick **[V]**, no
re-summon, no second entity type. Cost per change: 0 actors, 0 cuboids; per
draft: one actor (~40 kB, §7) drawn at ~140-190 cuboids.

- **Summon**: on the first slot tap with no draft, `dimension.spawnEntity(figType,
  at, { initialRotation })` **[V]** (`SpawnEntityOptions.initialRotation`,
  typings 25079) 2 blocks ahead of the player on the ground block found by
  `getBlockFromViewDirection` (fallback: the player's own feet), facing the
  player (`setRotation` **[V]**); then `craftmatic:draft = true`, owner
  dynamic property, `nameTag = 'Draft'`.
- **Stands still**: the base entity has NO movement or AI components; the
  `craftmatic:npc` component group (navigation, stroll, home, look-at, from
  `figureBehavior`) is added by the `craftmatic:release` event at place time.
  Guide rule honoured: removing a group removes its components outright, so
  the base declares none of them and `craftmatic:npc_off` removes the group
  cleanly (bedrock-addon-guide, descend-group finding).
- **Turntable**: F1 body reminds "walk around it"; a `Turn draft 90°` button
  is deliberately not on F1 (button budget) — it is on F8's body as a hint
  and can be added if the device round asks for it.
- **Size**: the creator entity carries `withSizeGroups` like every actor, so
  the brick wand's size steps apply to placed figures; the draft is always
  100 %.
- **Doll vs minifig**: two skeletons cannot share one animation set, so the
  entity has TWO rigs in its geometries (minifig bones and doll bones, §8 step
  2) and a `craftmatic:family` property; the doll geometries are empty for a
  minifig draft and vice versa, and the animation controller gates the walk on
  the family (`q.property('craftmatic:family')`).

## 6. Persistence

Three stores, each with a measured limit:

1. **The placed entity itself.** Entity properties "are always persisted
   through saving and loading" **[V]**, so a placed figure needs nothing
   else: its 21 ints + `nameTag` survive a world reload; `withSizeGroups`'
   scale is a component group and persists too. `craftmatic:owner` (entity
   dynamic property, string) records who placed it.
2. **The player's saved figures** — `player.setDynamicProperty('craftmatic:<packid>:saved', json)`
   **[V]**: a JSON array of `{ n: name, c: code }`. A string dynamic property
   is capped at **32,767 characters** **[V]** (wiki.bedrock.dev; the typings
   throw `ArgumentOutOfBoundsError`). A figure code is ≤ 140 characters (below),
   so the runtime caps the list at **100 saved figures** (≤ ~16,000 chars,
   half the limit, leaving room for names). "Library full — delete one" at
   100. Per-player, not per-world, so it follows the player across worlds
   that have the same pack **[A: dynamic properties are keyed by BP header
   uuid, which `packIdentity` keeps stable across re-exports — verified for
   the uuid, assumed for the store's survival across a pack update]**.
3. **Presets from the export** ship in the script CONFIG (`presets: [{ n, c }]`),
   authored in the web builder; read-only in-game.

**Figure code** — the interchange form, self-describing so the web builder can
decode it without the pack's index tables:
`mf1|<family>|<slot>=<part>:<colour>|…|n=<name>` e.g.
`mf1|m|to=973pbs:4|he=3626cp01:14|ha=3901:0|ar=:4|hd=:14|hi=:1|le=3816:1|hr=3847:71|hl=|bk=4524:4|n=Knight`.
Part ids and LDraw colour ids, never indices. `Show the figure code in chat`
sends it with `sendMessage` (selectable text on every platform); `Enter a
figure code…` decodes it through the pack's library: a part the library
lacks is reported (`… not in this pack's library; kept <default>`), per hard
rule 4, never silently defaulted.

**Export to the web**: paste the code into the LEGO tab's Minifig popover
(plan step 8 adds the field), which sets the form values and can re-export a
one-figure pack or a new creator pack that includes that part.

**Structure files are not used.** `world.structureManager.createFromWorld`
**[V]** could snapshot an entity, but it stores the entity by type + NBT and
would not be readable by the web side; the 21-int code is smaller and portable.

## 7. Cost budget

Numbers from the guide's device rounds (2026-09-18/19) and the measurements
in §3.2:

- **Definition (paid once per active pack)**: ~3.08 kB/cuboid before box UV,
  2.0-2.8 after. `standard` library ≈ 2,900 cuboids at 4 LDU ≈ **9 MB / 1.1 %**
  of the 260,000-cuboid ceiling; `large` ≈ 7,800 ≈ **24 MB / 3 %**; at 2 LDU
  (a `high`/`ultra` pack) ×3.5. Plus the two rig geometries' bone headers
  (2.6 % of bytes today — negligible).
- **Per placed figure (instance)**: `40 kB fixed + 0.22 kB per DRAWN cuboid`
  (measured: 10-14 MB per extra 48k-cuboid instance; 31-48 kB per idle
  actor). A figure draws 136-190 cuboids → **~70-85 kB each**. Whether the
  UNSELECTED geometries of the property-driven entity cost per-instance vertex
  memory is **[A]** — the instancing round measured a single-geometry entity.
  Conservative bound if they do: 40 kB + 0.22 × library cuboids ≈ 680 kB per
  figure with `standard` at 4 LDU.
- **Frame time**: 500 idle actors +0 %, 2,000 actors +100 % (7.5 fps at
  6,000 even off-screen) — CPU-side, not overdraw. ~50-100k VISIBLE cuboids
  hold 60 fps.
- **Cap**: `MINIFIG_WORLD_CAP = 200` placed figures per world, counted by
  `dimension.getEntities({ type: figType })` at F8 time over the three
  dimensions. 200 × 85 kB = 17 MB (conservative 136 MB = 44k cuboid-
  equivalents = 17 % of the ceiling); 200 × ~160 drawn cuboids = 32k visible,
  under the 60 fps guard; 200 ≪ the 500-actor knee. The cap is a constant in
  the skeleton so a device round can move it.
- **How many figures a session can hold before the ceiling is threatened**:
  the ceiling is threatened by the LIBRARY and the OTHER packs, not by
  placing: with eight shipped packs active (~259k cuboids, the measured N=9
  crash edge), a `standard` creator pack's 2,900 cuboids is the difference
  between loading and `St9bad_alloc`. The export warning must say, as it does
  for sets, how many packs like it fit.
- Actor churn leaks (142 MB after killing 6,000): the wand REUSES the draft
  entity across edits and releases it in place rather than remove-and-respawn.

## 8. Implementation plan (ordered)

Every step names its files; tests are vitest under `test/` and run with
`bun run test`. Gates after each step: `bun run typecheck`, `bun run
typecheck:web`, `bun run test`; a device round after steps 4 and 6.

1. **Contract** — `web/src/engine/minifig-creator-types.ts` (skeleton
   committed with this doc): `CreatorSlot`, `CREATOR_SLOTS`, property names
   (`slotProperty`, `colourProperty`, `FAMILY_PROPERTY`, `DRAFT_PROPERTY`),
   `MinifigLibrarySpec`, `MinifigLibraryEntry`, `CompiledMinifigLibrary`,
   `MinifigCreatorConfig` (what the runtime's CONFIG carries),
   `MINIFIG_CREATOR_COLOURS`, `MINIFIG_WORLD_CAP`, `PAGE_SIZE`,
   `MAX_PRINT_LAYERS`, `FigureCode` encode/decode signatures.
   Test `test/minifig-creator-types.test.ts`: property count for both
   families ≤ 32; every exposed colour has an RGB and a material class; the
   code round-trips a full spec and a spec with empty optional slots.
2. **Mini-doll rig** — `engine/minifig-rig.ts`: `MINIDOLL_BONES`,
   `MINIDOLL_CANON`, `MINIDOLL_DEFAULT_PARTS`, `miniDollFromSpec()`. The
   joint DISTANCES are measured (head 33.20, arm 11.00, plain hips 29.42,
   hips→legs 47.48 LDU: `minifig-rig.ts:190`, `lxf-parser.ts:525`; the
   combined `Hips and Legs` mould sits at 29.42 + 47.48 = 76.90 below the
   torso by construction) but the canonical POSITION VECTORS (arm x offset,
   z offsets, the rotation of a doll arm) are not in the code — **[A] until
   measured**: add `scripts/gen-minidoll-canon.ts` reading the library's own
   composite doll shortcuts (`Figure Friends … Torso with Arms`, the `_prev`
   assemblies clego measured its rows from) and asserting the four distances
   to 0.05 LDU. Test in `test/minifig-rig.test.ts`: `miniDollFromSpec` places
   head/arms/hips/legs at the measured distances; a `doll_hips_legs` spec
   yields one placement at 76.90; `classifyMiniDollPart` still refuses minifig
   parts.
3. **Library compiler** — new `web/src/engine/minifig-library.ts`:
   `buildMinifigLibrary(spec, { partGeometry, quality })` → for each entry
   compile the single part at its canonical slot pose on the right rig
   through `compileLdrawEntityGeometry(cid, 'figure'|…, [brick], { rig,
   frame, wholeModel: true, quality, inheritMaterialId: true })`. Needs one
   compiler option: `CompileLdrawEntityOptions.inheritMaterialId` — keep
   colour-16 cuboids as material id 16 instead of resolving them to the
   placement colour (`ldraw-entity-compiler.ts` where meshes are grouped by
   `m.material`). Output per entry: `main` geometry id, `print[]` geometry
   ids with their fixed colour ids (≤ `MAX_PRINT_LAYERS` = 6; an entry with
   more is REJECTED with a diagnostic naming the count — hard rule 4), cuboid
   count, group, label. Plus one **empty geometry per rig** (`geometry.
   <pack>.mf_none`, all bones, no cubes) for index 0 of optional slots.
   Grouping: `MINIFIG_GROUP_RULES` applied to the description from
   `partGeometry` (the provider returns the `.dat` header; `mouldFamilyId`
   resolves `~Moved to` stubs first, as the guide's museum-arm lesson
   demands). Tests `test/minifig-library.test.ts` (skips without the clego
   corpus, like `bedrock-collider-scale.test.ts`): 973 → 1 main + 0 print
   layers; `973pbs` → 1 main + ≥ 2 layers, ≤ 6; every entry's geometry carries
   the full bone list of its rig; cuboid sums match the diagnostics; a
   description-less part lands in `Other`.
4. **Entity + pack emission** — `engine/playable-addon.ts`:
   `PlayableAddonOptions.minifigCreator?: MinifigLibrarySpec`. New
   `emitMinifigCreatorEntity(id, library)`:
   - BP `entities/<id>_minifig.json`: `figureBehavior` split into base (no AI)
     + `component_groups['craftmatic:npc']` with the AI components, events
     `craftmatic:release` (add) / `craftmatic:npc_off` (remove); `description.
     properties`: 10 slot ints (`range [0, n_slot − 1]`, `default` = the
     family default's index, `client_sync: true`), 10 colour ints (`[0, 47]`),
     `craftmatic:family` int `[0,1]`, `craftmatic:draft` bool — 22 ≤ 32;
     `withSizeGroups` as today.
   - RP `entity/<id>_minifig.entity.json`: `geometry` map over every
     library geometry + the two empties; `textures` map `sw_<k>` for the 48
     swatches (already generated per colour by `emitCompiledEntity`'s swatch
     loop — factor that loop into `ensureSwatch(colorId)`); `animations` =
     `MINIFIG_CLIENT_ANIMATIONS` plus the doll set; `render_controllers` =
     one per slot for the main layer + `MAX_PRINT_LAYERS` per slot for prints
     (10 × 7 = 70; 71043 ships 89 today).
   - RP `render_controllers/<id>_minifig.render_controllers.json`:
     `controller.render.craftmatic.<id>_mf_<slot>` with
     `arrays.geometries.Array.g = [Geometry.mf_none, Geometry.<slot>_1, …]`,
     `geometry: "Array.g[q.property('craftmatic:<slot>')]"`,
     `textures: ["Array.swatch[q.property('craftmatic:c_<slot>')]"]`,
     `materials: [{ "*": "Array.mat[q.property('craftmatic:c_<slot>') >= <firstTranslucent>]" }]`;
     print layer `k`: `Array.g_k[q.property(slot)]` (empty where the part has
     fewer layers) and `Array.t_k[q.property(slot)]` (that part's k-th print
     colour swatch).
   - BP `scripts/minifig-wand.js` from step 5; `items/<id>_minifig_wand.json`;
     the grant function lines; `craftmatic-diagnostics.json` gains
     `pack.minifigLibrary { cuboids, entries, rejected[] }`; the export warning
     sentence.
   Tests in `test/playable-addon.test.ts` (new `describe('minifig creator
   pack')`, using the existing `unzip`+JSON helpers there): exactly one
   creator entity; ≤ 32 properties with contiguous int ranges equal to the
   library sizes; every `Geometry.*` named by a render controller exists in
   the geometry map and on disk; every `Texture.sw_*` has a PNG; the pack's
   cuboid budget includes the library; a pack WITHOUT `minifigCreator` is
   byte-identical to today's (golden: `test/playable-golden-models.test.ts`).
5. **Runtime** — new `web/src/engine/bedrock-minifig-wand.ts`, structured
   exactly like `bedrock-placement-pack.ts`: a `minifigWandRuntime(config)`
   function serialised with `.toString()` into `scripts/minifig-wand.js`
   (imports `world, system` and `ActionFormData, ModalFormData,
   MessageFormData, FormCancelationReason`), `buildMinifigWandAssets(spec)`
   returning `{ itemId, shortAlias, script, files }`. State per player
   `{ draftId?, editingId?, page, filter }`. The F1-F10 flow of §2, the busy
   retry, the cap, the code encode/decode, the saved-figure store, the
   startup and leave cleanup. `main.js` imports it beside `placement.js`.
   Tests `test/bedrock-minifig-wand.test.ts` on a host derived from
   `test/_placement-host.ts` (extend it with `MessageFormData`, a
   `setProperty`/`getProperty`-recording entity, `isSneaking`,
   `beforeEvents.playerInteractWithEntity`, `setDynamicProperty` on player
   and world with the 32,767 cap enforced the way `fillBlocks` enforces
   `BlockVolume`): selecting a torso on page 2 sets `craftmatic:torso` to the
   right index and returns to F2; the text filter narrows to the expected
   ids and an empty result shows the message form; colour page 2 index
   arithmetic; sneak-use places a copy at the aim hit and the count goes up;
   the 201st place is refused with the cap message; save/load/delete round
   trips through the fake store and the 101st save is refused; the code
   decodes with an unknown part reported; using the wand on a figure cancels
   the interaction and opens F10; `UserBusy` retries three times.
6. **Web builder** — `web/src/ui/minifig-builder.ts`: a "Creator library"
   select (`none / starter / standard / large / custom…`) and a "Figure code"
   textarea (paste → form values; copy from form); `specFromForm` unchanged.
   `scripts/_minifig_ref.ts` gains `--creator=<tier>`. Test additions in
   `test/minifig-builder.test.ts`: code → form → code identity; tier → spec
   sizes.
7. **Device round** (Pixel, the guide's recipe): a `standard` pack; confirm
   (a) property-driven geometry/texture switching renders and switches within
   a tick, (b) translucent swatches through `Array.mat`, (c) swatch icons on
   form buttons, (d) `itemUse` on a block, (e) per-instance memory of the
   unselected geometries (`_pixel_perf.sh mem` at 0 / 50 / 200 figures), (f)
   the doll rig's proportions beside a minifig, (g) frame time at 200.
   Numbers go into `docs/bedrock-addon-guide.md`; `MINIFIG_WORLD_CAP` and the
   tiers move with them.
8. **Docs + tracker**: this file's [A] tags resolved to measurements; the
   guide's "Custom minifigs" paragraph points here; `TASKS-BEDROCK-ADDON.md`
   carries the open items only.
9. **Polish (optional)**: part silhouette icons from `_entity_silhouette.ts`
   at export; a `Turn draft` button; a `Pose` property (arms up/down) if the
   animation budget allows.

## 9. Open questions and risks — verified vs assumed

**Verified [V]** (source):
- Manifest declares `@minecraft/server` 2.9.0 and `@minecraft/server-ui`
  2.1.0, `min_engine_version 1.26.40` — `playable-addon.ts:1400`,
  `mcpack.ts:214`. `server-ui` IS already a dependency; nothing to add.
- `ActionFormData`: `title/body/button(text, iconPath?)/header/label/divider/show`;
  `ModalFormData`: `dropdown(label, items, {defaultValueIndex})`,
  `slider(label, min, max, {valueStep?, defaultValue?})`, `textField(label,
  placeholder, {defaultValue})`, `toggle(label, {defaultValue})`, `header/
  label/divider/submitButton`; `MessageFormData`: `title/body/button1/
  button2`; responses `canceled`, `cancelationReason` (`UserBusy`,
  `UserClosed`), `selection?: number`, `formValues?: (boolean|number|string|
  undefined)[]` — `@minecraft/server-ui@2.1.0/index.d.ts` fetched from unpkg
  2026-09-19, lines 235-257, 1021-1124, 659-666, 1172.
- `world.afterEvents.itemUse` (`source: Player`, `itemStack`),
  `world.beforeEvents.playerInteractWithEntity` (`cancel`, `itemStack?`,
  `player`, `target`), `afterEvents.playerInteractWithBlock`,
  `afterEvents.playerButtonInput` (`InputButton.Sneak`/`Jump`),
  `Entity.isSneaking`, `Entity.setProperty/getProperty/resetProperty`,
  `Entity.setDynamicProperty`, `getDynamicPropertyTotalByteCount`,
  `nameTag`, `triggerEvent`, `teleport`, `setRotation`, `remove`,
  `Player.getBlockFromViewDirection`, `Dimension.spawnEntity(type, at,
  { initialPersistence?, initialRotation? })` — `@minecraft/server@2.9.0/
  index.d.ts` lines 8600, 9216, 9473, 9523, 9595, 9610, 9669, 9713, 9048,
  15366, 17973-17992, 22267, 22360, 22368, 22588, 25072-25079.
- Entity properties: int/float/enum/bool, `range`, `default`, `client_sync`,
  persisted with the entity, **32 per entity type**; render controllers pick
  geometry and textures from arrays by `q.property()`; `set_property` in
  events — Microsoft "Introduction to Entity Properties" and
  `behaviorrendercontrollers.md` (context7 `/microsoftdocs/minecraft-creator`).
  Device-proven for a client-synced int driving an animation:
  `scripts/_bedrock_probe_pack.py:101-129`.
- String dynamic property limit 32,767 characters — wiki.bedrock.dev
  "Saving and Loading data" (context7 `/websites/wiki_bedrock_dev`).
- `form.show()` cannot run in restricted-execution mode (before-event
  callbacks) — server-ui docs; the existing wand's `system.run` hop.
- Cuboid costs per part and per figure: §3.2 tables, `_minifig_ref.ts`
  136 / 186. The per-part costs are reproducible with
  `bun scripts/part-library-cost.ts` (writes `output/master-addon-audit/`);
  the original run was scratch and is gone.
- Memory and frame numbers: bedrock-addon-guide 2026-09-18/19 sections.
- Corpus counts: §3.1, `grep` over the official library.
- Prints become cuboids: `ldraw-part-prototype.ts:21`, and 973 vs 973pbs.
- The retired-mould stub hazard (`~Moved to`) and `mouldFamilyId`: guide
  2026-09-17.

**Assumed [A]** (each is a step-7 device check or a measurement):
1. `itemUse` fires when the wand is used ON a block (fallback named).
2. Per-instance vertex memory of geometries a render controller does NOT
   select — bounds given both ways in §7.
3. `button(text, iconPath)` renders an entity swatch PNG at
   `textures/entity/craftmatic_swatch_<id>`; the docs say "an icon from a
   resource pack" without a path grammar.
4. No cap on render-controller array length or on client-entity geometry
   count beyond what 71043 (89 geometries) already exercises; `large` at 64
   entries per slot is within that, `custom` beyond it is untested.
5. Mini-doll canonical position VECTORS and arm rotation (distances are
   measured; vectors are step 2's script).
6. A doll and a minifig rig coexisting in one entity's geometry list with
   two animation sets gated by a property — the compiler emits shared bone
   names per rig today; two rigs in one entity is new.
7. Player dynamic properties surviving a pack re-export: the BP header uuid
   is stable by `packIdentity` **[V]**, the store's survival is inferred.
8. Phone ergonomics of 8 + 3 buttons per page and of a 12-button F1; the
   brick wand's 12-13 needs a swipe on the Pixel (guide, round 2).
9. Whether the museum-arm class of description stubs affects any curated
   library id — the exporter resolves stubs, but the curated lists are
   hand-picked and must be checked against `mouldFamilyId` in the test.

**Risks worth stating plainly**
- The property-driven entity is the whole design. If (2) measures badly
  (every instance paying for the full library), the fallback is a per-figure
  entity TYPE emitted at export from a fixed figure list — which is what
  `minifigFromSpec` packs are today — and the in-game creator degrades to a
  chooser among exported figures. Nothing else in §1-§6 changes.
- `MAX_PRINT_LAYERS` rejects busy prints; the diagnostics must say which and
  the web builder must show it before export, or a user's chosen torso
  vanishes with only a warning line.
- The world cap is a soft guard on an unmeasured curve between 200 and the
  500-actor knee; it must not be raised without step 7(g).
