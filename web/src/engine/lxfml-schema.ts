/**
 * What the LXFML reader understands, as data.
 *
 * LEGO's own instruction format carries far more than brick placements: which
 * bricks enter at which step, which belong to which sub-build, which are
 * decorated, which are flexible, and which are swapped out in an alternate
 * build. The reader takes four attributes out of it — `Brick@designID`,
 * `Part@designID`, `Part@materials` and `Bone@transformation` — so everything
 * else is dropped silently and looks like a model that simply lacks the detail.
 *
 * Every element and attribute in the corpus is listed here with what it does
 * and whether we act on it, so the difference between "LXFML does not say" and
 * "we never read it" is written down instead of rediscovered. The counts are
 * from the 2026-09-23 sweep of 4,881 LXFML files covering 4,044 sets.
 *
 * `scripts/_converter_coverage_audit.ts` checks this against the whole corpus
 * and fails on any element it has never seen.
 */

export type LxfmlEffect =
  /** Decides where a part is, or whether it is in the model at all. */
  | 'geometry'
  /** Decides a part's colour or decoration. */
  | 'appearance'
  /** Step order, sub-build membership, grouping. */
  | 'structure'
  /** Instruction drawing: cameras, arrows, page layout, bag splits. */
  | 'view'
  /** Provenance and identifiers. */
  | 'metadata';

export interface LxfmlSpec {
  readonly effect: LxfmlEffect;
  readonly handled: boolean;
  /** Geometry described here is also written out as ordinary placements. */
  readonly viaExpansion?: boolean;
  readonly note: string;
}

/**
 * Element-name FAMILIES. LEGO's instruction authoring tool writes one element
 * per preference (`EBT_SCENE_PREFS_LEGO_BMImageFormat`, ...), so listing them
 * individually would mean editing this file every time a new preference ships
 * while telling us nothing. Matched only when no exact entry exists.
 */
export const LXFML_ELEMENT_PREFIXES: ReadonlyArray<{ prefix: string; spec: LxfmlSpec }> = [
  {
    prefix: 'EBT_SCENE_PREFS_',
    spec: { effect: 'view', handled: false, note: 'LEGO instruction-authoring preference (layout template, render path, image format, LOD); nothing about the model' },
  },
];

/** The spec for an element, consulting the prefix families. */
export function lxfmlElementSpec(name: string): LxfmlSpec | undefined {
  const exact = LXFML_ELEMENTS[name];
  if (exact) return exact;
  return LXFML_ELEMENT_PREFIXES.find(p => name.startsWith(p.prefix))?.spec;
}

const e = (effect: LxfmlEffect, handled: boolean, note: string): LxfmlSpec => ({ effect, handled, note });

/** Geometry that is also written out as ordinary placements; ignoring it costs nothing. */
const x = (note: string): LxfmlSpec => ({ effect: 'geometry', handled: false, viaExpansion: true, note });

/** Every element name the corpus contains. */
export const LXFML_ELEMENTS: Readonly<Record<string, LxfmlSpec>> = {
  // ── the model itself ────────────────────────────────────────────────────
  LXFML: e('metadata', true, 'document root'),
  Bricks: e('geometry', true, 'the brick list'),
  Brick: e('geometry', true, 'one brick; `designID` is the fallback mould when the Part omits it'),
  Part: e('geometry', true, 'one moulded part of a brick; every Part is read, not just the first'),
  Bone: e('geometry', true, 'the placement transform. Only the FIRST bone is used — see `PartDeformation`'),
  RigidSystems: x('rigid-body grouping used by the connectivity solver'),
  RigidSystem: x('one rigid assembly'),
  Rigid: x('a rigid body whose `transformation` RESTATES the transform its bones already carry, which is the one the reader uses'),
  RigidRef: x('a joint endpoint on a rigid body; articulation, not placement'),
  Joint: x('hinge/slider between two rigid bodies (2,440 sets); it says how a part COULD move, not where it is'),
  PartDeformation: e('geometry', false, 'marks a FLEXIBLE part (847 sets, type="flex"). Its `Bone` children carry one `index`/`position`/`rotation` per segment, and taking only the first collapses a hose or string to a single stub at its root.'),
  FlexAnchors: e('geometry', false, 'flex manipulator anchors (368 sets)'),

  // ── appearance ──────────────────────────────────────────────────────────
  Sticker: e('appearance', false, 'a sticker placed on a part (1,757 sets); LDraw has no sticker layer'),
  StickerAttributes: e('appearance', false, 'sticker anchor offsets (283 sets)'),
  PartVariant: e('appearance', false, 'per-part mould variant override (506 sets); `normalizeDesignId` strips the variant suffix, so the base mould is used'),
  Ghosted: e('view', false, 'bricks drawn semi-transparent in the instruction (84 sets); they are in the model'),

  // ── structure ───────────────────────────────────────────────────────────
  GroupSystems: e('structure', false, 'container for the grouping systems'),
  BrickGroupSystem: e('structure', false, 'a named grouping of bricks, e.g. BOMBags'),
  PartGroupSystem: e('structure', false, 'a named grouping of parts (40 sets)'),
  Group: e('structure', false, 'a named set of bricks (3,796 sets, 143,322 rows). 35 sets also give the group its own `transformation`/`pivot`.'),
  DefaultGroup: e('structure', false, 'the ungrouped remainder'),
  BuildingInstructions: e('structure', false, 'container'),
  BuildingInstruction: e('structure', false, 'one instruction booklet'),
  Steps: e('structure', false, 'a step sequence'),
  Step: e('structure', false, 'one build step (1,493,695 rows in 4,044 sets). Its `In` children name the bricks that enter here — a true step order the LDraw `0 STEP` count only approximates.'),
  In: e('structure', false, 'one brick entering at this step, by `brickRef` (3,604,193 rows in 4,044 sets)'),
  SubBuild: e('structure', false, 'a named sub-assembly (309,557 rows in 4,044 sets) — this is what says a model is built in pieces. 955 sets also give it a `position`.'),
  MultiBuild: e('structure', false, 'an alternate build (1,785 sets)'),
  MultiBuildBrick: e('geometry', false, 'a brick SWAPPED in the alternate build: `originalBrickRef` → `actualBrickRef` (164,112 rows in 1,785 sets)'),
  Dependency: e('structure', false, 'ordering constraint between instruction nodes'),
  BIGraph: e('structure', false, 'instruction dependency graph'),
  GraphNode: e('structure', false, 'a node in that graph'),
  BINode: e('structure', false, 'a booklet in that graph'),
  ChoiceNode: e('structure', false, 'a branch in that graph (29 sets)'),
  LinkedBuilds: e('structure', false, 'links to other models'),
  MergeCopy: e('structure', false, 'a merged copy of another model (10 sets)'),
  MergedBI: e('structure', false, 'a merged instruction booklet (10 sets)'),
  Build: e('metadata', false, 'build identity'),
  ExternalReferences: e('metadata', false, 'references to other documents'),

  // ── explode / instruction motion ────────────────────────────────────────
  Explode: e('geometry', true, 'a rigid frame pair (`position`/`rotation` → `explosionPosition`/`explosionRotation`) carrying the parts listed under it. Read by `lxfml-assembly.ts`, which applies one when the group it carries comes to rest ON the model.'),
  Parts: e('geometry', true, 'the `partRefs` an Explode carries'),
  ExplodeRanges: e('view', false, 'container'),
  ExplodeRange: e('view', false, 'a range of explode steps with its own transformation (1,474 sets)'),
  Arrow: e('view', false, 'instruction arrow'),
  StraightArrow: e('view', false, 'instruction arrow'),
  ArcArrow: e('view', false, 'instruction arrow'),
  BarrelArrow: e('view', false, 'instruction arrow'),
  FunctionArrows: e('view', false, 'container for function arrows'),

  // ── visibility ──────────────────────────────────────────────────────────
  VisibilityRanges: e('view', false, 'container'),
  VisibilityRange: e('view', false, 'bricks hidden between two steps (2,362 sets); a step-time effect, not a model one'),
  Added: e('view', false, 'bricks added in a behaviour range'),
  Removed: e('view', false, 'bricks removed in a behaviour range'),
  Behaviors: e('view', false, 'instruction behaviour container'),
  CollisionDisabled: e('view', false, 'collision suppressed for the step animation'),
  ConnectivityDisabled: e('view', false, 'connectivity suppressed for the step animation'),

  // ── cameras and views ───────────────────────────────────────────────────
  Cameras: e('view', false, 'container'),
  Camera: e('view', false, 'a saved camera (8 sets)'),
  View: e('view', false, 'a saved view (7 sets)'),
  ExtraView: e('view', false, 'an inset view in the instruction'),
  StartImageView: e('view', false, 'the step\'s opening image'),
  EndOnHighView: e('view', false, 'the step\'s closing image'),
  RealSizeView: e('view', false, 'the 1:1 scale inset'),
  CameraFittingRange: e('view', false, 'camera framing range'),

  // ── packaging and publishing ────────────────────────────────────────────
  UseBags: e('view', false, 'whether the instruction splits by bag'),
  Bags: e('view', false, 'container'),
  NumberedBag: e('view', false, 'a numbered bag'),
  LooseBag: e('view', false, 'unbagged remainder'),
  ExcludedBag: e('view', false, 'bag excluded from the split'),
  ColorSortedBag: e('view', false, 'bag split by colour'),
  ExcludeFromBOM: e('view', false, 'excluded from the bill of materials'),
  DWFBom: e('metadata', false, 'bill-of-materials identifier'),
  DWFBI: e('metadata', false, 'instruction identifier'),
  DWFModel: e('metadata', false, 'model identifier'),
  Configurations: e('metadata', false, 'container'),
  Configuration: e('metadata', false, 'a named configuration'),
  Meta: e('metadata', false, 'document metadata'),
  Application: e('metadata', false, 'authoring application and version'),
  Brand: e('metadata', false, 'brand'),
  LDDPro: e('metadata', false, 'LDD Pro settings'),
  PhysicsAttribute: e('view', false, 'physics hint for the step animation (136 sets)'),
  Anchor: e('view', false, 'physics anchor (136 sets)'),
  Gear: e('view', false, 'gear ratio for the step animation (136 sets)'),

  // ── instruction authoring toggles (lower-case in the schema) ────────────
  customEOP: e('view', false, 'custom end-of-page handling'),
  noEOP: e('view', false, 'suppress end-of-page'),
  skipSubBuildTransition: e('view', false, 'skip the sub-build transition animation'),
  skipCameraTransition: e('view', false, 'skip the camera transition'),
  dontShootInTheEye: e('view', false, 'camera framing rule'),
  basicCustomization: e('view', false, 'instruction customisation flag'),
  showMiniBuild: e('view', false, 'show the mini build inset'),
  rightVsWrong: e('view', false, 'right-vs-wrong callout'),
  focusInBricks: e('view', false, 'framing rule'),
  callout: e('view', false, 'instruction callout'),
  click: e('view', false, 'click indicator'),
  hoym: e('view', false, 'LEGO-internal instruction flag'),
  assembly: e('view', false, 'LEGO-internal instruction flag'),
};

/**
 * Attributes on the elements that decide what the model looks like. Attributes
 * of purely `view` elements are not tracked individually — the element's own
 * entry covers them.
 */
export const LXFML_ATTRIBUTES: Readonly<Record<string, LxfmlSpec>> = {
  'LXFML@versionMajor': e('metadata', true, 'schema version'),
  'LXFML@versionMinor': e('metadata', true, 'schema version'),
  'LXFML@versionPatch': e('metadata', false, 'schema version'),
  'LXFML@name': e('metadata', false, 'model name (14 sets)'),

  'Brick@designID': e('geometry', true, 'the mould, used when the Part omits its own'),
  'Brick@refID': e('geometry', true, 'the id `Group`, `In` and `MultiBuildBrick` refer to'),
  'Brick@uuid': e('metadata', false, 'stable identity across edits'),
  'Brick@brickRef': e('metadata', false, 'uuid of the brick this one came from'),
  'Brick@itemNos': e('metadata', false, 'LEGO element numbers'),
  'Brick@version': e('metadata', false, 'mould version'),
  'Brick@decorationBriefId': e('appearance', false, 'decoration brief for the whole brick (3,751 sets)'),
  'Brick@decorationBriefVersion': e('appearance', false, 'decoration brief version'),
  'Brick@familyMoldId': e('metadata', false, 'mould family (62 sets)'),

  'Part@designID': e('geometry', true, 'the mould; the `;C` variant suffix is stripped by `normalizeDesignId`'),
  'Part@refID': e('geometry', true, 'the id `Parts@partRefs` and `PartDeformation@partRef` refer to'),
  'Part@materials': e('appearance', true, 'colour. Two shapes occur: `28:0` (material:shell, 2,989,494 rows) and a comma list for a MULTI-MOULD part (54,620 rows) of which only the first is used, because an LDraw part is a single colour.'),
  'Part@partType': e('geometry', false, '"rigid" or "flexible"'),
  'Part@decoration': e('appearance', false, 'the print on this part (3,874 sets) — prints are not carried into the LDraw pipeline'),
  'Part@stickerSheetId': e('appearance', false, 'sticker sheet the part\'s sticker comes from (2,021 sets)'),
  'Part@stickerSheetVersion': e('appearance', false, 'sticker sheet version'),
  'Part@variantID': e('appearance', false, 'mould variant (746 sets)'),
  'Part@uuid': e('metadata', false, 'stable identity'),
  'Part@partRef': e('metadata', false, 'uuid of the source part'),
  'Part@version': e('metadata', false, 'mould version'),

  'Bone@transformation': e('geometry', true, 'row-major 3×3 plus translation; the placement the reader uses'),
  'Bone@refID': e('geometry', true, 'bone id'),
  'Bone@index': e('geometry', false, 'segment index of a FLEX bone (847 sets) — the reader takes index 0 only'),
  'Bone@position': e('geometry', false, 'flex segment position (847 sets)'),
  'Bone@rotation': e('geometry', false, 'flex segment rotation quaternion (847 sets)'),
  'Bone@uuid': e('metadata', false, 'stable identity'),
  'Bone@boneRef': e('metadata', false, 'uuid of the source bone'),

  'Explode@position': e('geometry', true, 'the frame the carried parts are stored in'),
  'Explode@rotation': e('geometry', true, 'that frame\'s rotation quaternion'),
  'Explode@explosionPosition': e('geometry', true, 'the frame they move to'),
  'Explode@explosionRotation': e('geometry', true, 'that frame\'s rotation quaternion'),
  'Explode@refID': e('geometry', true, 'explode id'),
  'Explode@name': e('metadata', false, 'author-facing name'),
  'Explode@uuid': e('metadata', false, 'stable identity'),
  'Explode@explodeRef': e('metadata', false, 'uuid of the source explode'),
  'Parts@partRefs': e('geometry', true, 'the parts an Explode carries'),

  'PartDeformation@type': e('geometry', false, '"flex" (847 sets)'),
  'PartDeformation@partRef': e('geometry', false, 'the part being deformed'),

  'SubBuild@refID': e('structure', false, 'sub-build id'),
  'SubBuild@name': e('structure', false, 'sub-build name, e.g. "Figure1"'),
  'SubBuild@position': e('geometry', false, 'where the sub-build sits (955 sets)'),
  'In@brickRef': e('structure', false, 'a brick entering at this step'),
  'In@name': e('structure', false, 'that brick\'s description'),
  'Step@refID': e('structure', false, 'step id'),
  'Group@refID': e('structure', false, 'group id'),
  'Group@name': e('structure', false, 'group name'),
  'Group@brickRefs': e('structure', false, 'the bricks in the group (1,916 sets)'),
  'Group@transformation': e('geometry', false, 'a transform on the GROUP itself (35 sets)'),
  'Group@pivot': e('geometry', false, 'that transform\'s pivot (35 sets)'),
  'Group@uuid': e('metadata', false, 'stable identity'),

  'MultiBuildBrick@originalBrickRef': e('geometry', false, 'the brick replaced in the alternate build'),
  'MultiBuildBrick@actualBrickRef': e('geometry', false, 'the brick that replaces it'),
  'MultiBuildBrick@name': e('metadata', false, 'its description'),
  'MultiBuild@masterSubBuildRef': e('structure', false, 'the sub-build the alternate belongs to'),
  'MultiBuild@name': e('metadata', false, 'alternate build name'),

  'PartVariant@partRef': e('appearance', false, 'the part whose variant is overridden'),
  'PartVariant@variantID': e('appearance', false, 'the variant'),
  'Sticker@stuckToPartRef': e('appearance', false, 'the part the sticker is on'),
  'Sticker@anchor': e('appearance', false, 'where on the part'),
  'Ghosted@opacity': e('view', false, 'ghost opacity'),
  'Ghosted@brickRefs': e('view', false, 'the ghosted bricks'),

  'Rigid@refID': x('rigid body id'),
  'Rigid@transformation': x('restates the transform its bones already carry'),
  'Rigid@boneRefs': x('the bones in the body'),
  'Rigid@uuid': e('metadata', false, 'stable identity'),
  'Joint@type': x('hinge, slider, …'),
  'RigidRef@rigidRef': x('the body this joint end attaches to'),
  'RigidRef@side': x('which end'),
  'RigidRef@a': x('joint axis'),
  'RigidRef@z': x('joint axis'),
  'RigidRef@t': x('joint anchor'),

  // Instruction framing on the two elements whose ids we do track.
  'Step@name': e('view', false, 'step label'),
  'Step@uuid': e('metadata', false, 'stable identity'),
  'Step@position': e('view', false, 'step camera position'),
  'Step@rotation': e('view', false, 'step camera rotation'),
  'Step@pivot': e('view', false, 'step camera pivot'),
  'Step@cameraType': e('view', false, 'which stock camera the step uses'),
  'Step@cameraRef': e('view', false, 'a saved camera'),
  'Step@cameraFocusPoint': e('view', false, 'camera target'),
  'Step@cameraDistance': e('view', false, 'camera distance'),
  'Step@cameraScaleFactor': e('view', false, 'camera scale'),
  'Step@visibleFitting': e('view', false, 'framing box for the visible bricks'),
  'Step@subBuildFitting': e('view', false, 'framing box for the sub-build'),
  'Step@inBricksFitting': e('view', false, 'framing box for the entering bricks'),
  'Step@rangeFitting': e('view', false, 'framing box for the step range'),
  'Step@preferredFitting': e('view', false, 'which framing box to use'),
  'Step@originRef': e('view', false, 'framing origin'),
  'Step@explosionArrowColor': e('view', false, 'arrow colour'),
  'Step@functionArrowColor': e('view', false, 'arrow colour'),
  'SubBuild@uuid': e('metadata', false, 'stable identity'),
  'SubBuild@cameraType': e('view', false, 'which stock camera the sub-build uses'),
  'SubBuild@cameraFocusPoint': e('view', false, 'camera target'),
  'SubBuild@cameraDistance': e('view', false, 'camera distance'),
  'SubBuild@visibleFitting': e('view', false, 'framing box'),
  'SubBuild@preferredFitting': e('view', false, 'which framing box to use'),
  'SubBuild@explosionArrowColor': e('view', false, 'arrow colour'),
  'SubBuild@explosionArrowStyle': e('view', false, 'arrow style'),
  'SubBuild@functionArrowColor': e('view', false, 'arrow colour'),
};

/** Elements and attributes that change the model and which we do NOT read. */
export function unhandledModelFeatures(): string[] {
  const out: string[] = [];
  const gap = (v: LxfmlSpec): boolean =>
    !v.handled && !v.viaExpansion && (v.effect === 'geometry' || v.effect === 'appearance');
  for (const [k, v] of Object.entries(LXFML_ELEMENTS)) if (gap(v)) out.push(k);
  for (const [k, v] of Object.entries(LXFML_ATTRIBUTES)) if (gap(v)) out.push(k);
  return out.sort();
}
