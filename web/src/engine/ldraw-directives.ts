/**
 * What the LDraw reader understands, as data.
 *
 * The parser was grown from whatever the sets in front of it happened to use,
 * so a directive nobody had looked at yet was silently a no-op: a document's
 * own `0 !COLOUR` palette was ignored in favour of a shared table that
 * disagreed with it, and `0 NOFILE` did not close its section. Neither
 * produced an error — the model just came out wrong.
 *
 * It also cuts the other way, which is why the notes carry corpus counts: a
 * plausible reading of `0 MLCAD SKIP_BEGIN` as "content the file excludes"
 * would have deleted 40,862 parts, because every skip block in the corpus is
 * the expansion of a flexible hose.
 *
 * This table is the fix for the CLASS, not the instances: every line-type-0
 * directive the corpus contains is listed with what it does to the model and
 * whether the reader acts on it. `scripts/_converter_coverage_audit.ts` walks
 * every source file and fails on anything missing from here, so the next
 * unhandled directive shows up as a build-time gap instead of a wrong export.
 *
 * Counts in the notes are from the 2026-09-23 corpus sweep (31,002 LDraw files
 * under `C:/git/clego/lego_sets`); they say how much a gap is worth, so nobody
 * has to re-measure to decide whether to care.
 */

/** What acting on a directive would change. */
export type DirectiveEffect =
  /** Adds, removes or moves parts. Ignoring it makes the model WRONG. */
  | 'geometry'
  /** Changes a part's colour. */
  | 'colour'
  /** Groups or names parts; affects sub-build detection, not the shape. */
  | 'structure'
  /** Camera, step layout, instruction drawing — nothing the export renders. */
  | 'view'
  /** Author, licence, keywords, provenance. */
  | 'metadata';

export interface DirectiveSpec {
  readonly effect: DirectiveEffect;
  /** True when the reader acts on it; false when it is knowingly ignored. */
  readonly handled: boolean;
  /**
   * The directive DESCRIBES geometry that the file also writes out as ordinary
   * type-1 lines, which the parser reads. Ignoring the directive therefore
   * costs nothing: the hose is drawn from its expansion. This is a different
   * state from an unhandled gap and must not be counted as one.
   */
  readonly viaExpansion?: boolean;
  readonly note: string;
}

/**
 * Legacy metas that carry no `!` prefix. Everything else after `0 ` that is not
 * one of these is a COMMENT — LDraw has required the `!` prefix for official
 * metas since 2005, so `0 UCS Millennium Falcon` is a title, not a directive.
 * Without this closed set an audit reports every model title as an unknown
 * command and drowns the real gaps.
 */
export const UNPREFIXED_METAS: ReadonlySet<string> = new Set([
  'FILE', 'NOFILE', 'STEP', 'ROTSTEP', 'BFC', 'CLEAR', 'PAUSE', 'SAVE',
  'WRITE', 'PRINT', 'MLCAD', 'BUFEXCHG', 'GHOST', 'SYNTH', 'GROUP',
  'GROUPLIST', 'ENDGROUP', 'ROTATION', 'ROTANGLE', 'COLOR', 'COLOUR',
  'LPUB', 'CENTRE', 'CENTER', 'LOOKAT', 'ZOOM', 'WORLD', 'SPLINE',
  'ENDSPLINE', 'SPLROT', 'UNOFFICIAL', 'LDRAW_ORG', 'NAME', 'AUTHOR',
  'PLIST', 'PE_TEX_INFO', 'PE_TEX_PATH', 'STUDIOSTEPDESC',
]);

/**
 * Directives whose FIRST argument is part of their identity, because the verb
 * after the namespace is what decides whether parts move (`MLCAD SKIP_BEGIN`
 * excludes geometry; `MLCAD BTG` only names a group).
 */
export const NAMESPACED: ReadonlySet<string> = new Set([
  'MLCAD', '!LDCAD', '!LPUB', 'LPUB', 'SYNTH', '!TEXMAP', 'BFC', 'BUFEXCHG',
  '!DATA', 'PLIST', '!LEOCAD', '!BRICKSTORE',
]);

/** Shorthand for the table below. */
const d = (effect: DirectiveEffect, handled: boolean, note: string): DirectiveSpec =>
  ({ effect, handled, note });

/** As `d`, for a directive whose geometry is read from its written-out expansion. */
const viaExpansion = (note: string): DirectiveSpec =>
  ({ effect: 'geometry', handled: false, viaExpansion: true, note });

/**
 * Every directive the corpus contains, keyed exactly as `directiveKey()`
 * returns. A key absent from here is an UNKNOWN gap by definition.
 */
export const LDRAW_DIRECTIVES: Readonly<Record<string, DirectiveSpec>> = {
  // ── structure: which lines belong to which model ────────────────────────
  FILE: d('structure', true, 'opens an MPD section; the parser indexes sections by this name'),
  NOFILE: d('structure', true, 'closes an MPD section — content after it belongs to no model (94 orphan lines in 8 files)'),
  STEP: d('structure', true, 'assembly step boundary; counted at every depth'),
  ROTSTEP: d('view', false, 'rotates the instruction CAMERA, not the model (145 sets)'),
  ROTATION: d('view', false, 'Studio/MLCad rotation centre for the editor view (1,188 sets)'),
  ROTANGLE: d('view', false, 'MLCad view angle'),
  CENTRE: d('view', false, 'L3P/POV camera centre'),
  CENTER: d('view', false, 'L3P/POV camera centre'),
  LOOKAT: d('view', false, 'L3P/POV camera target'),
  ZOOM: d('view', false, 'L3P/POV camera zoom'),
  WORLD: d('view', false, 'L3P/POV world setup'),

  // ── geometry: lines that add or remove parts ────────────────────────────
  'MLCAD SKIP_BEGIN': d('geometry', true, 'opens a block MLCad can REGENERATE from the generator meta above it. Every one of the 231 blocks in the corpus (63 files) sits under MLCAD FLEXHOSE (215 blocks, 40,390 parts), RUBBER_BELT (14) or SPRING (2) — so skipping it without implementing that generator deletes the hose. Kept unless the generator is implemented.'),
  'MLCAD SKIP_END': d('geometry', true, 'closes a regenerable block'),
  'BUFEXCHG A': d('geometry', true, 'STORE marks a rollback point, RETRIEVE discards parts placed since (34 parts in 6 sets)'),
  'BUFEXCHG B': d('geometry', true, 'second buffer; same rollback semantics'),
  'BUFEXCHG C': d('geometry', true, 'third buffer; same rollback semantics'),
  'BUFEXCHG D': d('geometry', true, 'fourth buffer; same rollback semantics'),
  GHOST: d('geometry', true, 'carries a full type-1 line that MLCad draws faded; the part IS in the model (4 parts in 3 sets)'),
  'MLCAD HIDE': d('geometry', false, 'carries a type-1 line the author suppressed. MEASURED: 1,235 of 1,627 land on an origin a visible part already occupies (alternates/mirrors) and much of the rest is LSynth marker parts, so adding them stacks bricks. Deliberately skipped.'),
  'MLCAD BTG': d('structure', false, 'names the group a part belongs to (43,941 lines in 152 sets); no effect on placement'),
  'MLCAD FLEXHOSE': viaExpansion("MLCad flexible-hose spec (215 blocks, 56 files). Not synthesised — the SKIP block underneath already holds MLCad's own expansion of it (40,390 segment placements), which the parser keeps."),
  'MLCAD RUBBER_BELT': viaExpansion('MLCad belt spec (14 blocks, 8 files); its expanded 472 segments are kept the same way'),
  'MLCAD SPRING': viaExpansion('MLCad spring spec (2 blocks, 1 file); expansion kept'),
  'SYNTH BEGIN': viaExpansion('opens an LSynth constraint block; the constraints are real type-1 lines'),
  'SYNTH END': viaExpansion('closes an LSynth block'),
  'SYNTH SYNTHESIZED': viaExpansion('marks LSynth-generated segments, verified in 10247 to be ordinary type-1 LS70.dat lines the parser already reads'),
  'SYNTH SHOW': d('view', false, 'LSynth visibility toggle'),
  'SYNTH HIDE': d('view', false, 'LSynth visibility toggle'),
  '!TEXMAP START': d('geometry', true, 'opens a textured block; its `0 !:` geometry is used only when the block has NO FALLBACK'),
  '!TEXMAP NEXT': d('geometry', true, 'applies the texture to the next line only'),
  '!TEXMAP FALLBACK': d('geometry', true, 'untextured geometry for readers without texture support — this is what the parser uses'),
  '!TEXMAP END': d('geometry', true, 'closes a textured block'),
  '!:': d('geometry', true, 'prefixes geometry inside a TEXMAP block; honoured only when the block has no FALLBACK, otherwise it would DOUBLE every textured part (46 such lines in 15 sets, all with a fallback)'),
  PE_TEX_INFO: d('view', false, "Studio's embedded print texture (base64 PNG); the part's own geometry is unaffected (3 sets)"),
  PE_TEX_PATH: d('view', false, "Studio's print texture UV path (3 sets)"),

  // ── colour ──────────────────────────────────────────────────────────────
  '!COLOUR': d('colour', true, 'defines a colour code FOR THIS DOCUMENT; 85 codes are redefined away from the official value and 26 are codes our table does not know (104 sets)'),
  COLOUR: d('colour', true, 'unprefixed spelling of !COLOUR'),
  COLOR: d('colour', true, 'LDLite colour definition: `0 COLOR <code> <name> <r> <g> <b> <a> ...` (43 sets)'),

  // ── grouping ────────────────────────────────────────────────────────────
  GROUP: d('structure', false, 'MLCad/LeoCAD group marker (172 sets); grouping does not move parts'),
  GROUPLIST: d('structure', false, 'declares the group names used in the file'),
  ENDGROUP: d('structure', false, 'closes a group'),
  '!LDCAD GROUP_DEF': d('structure', false, 'LDCad group definition (126 sets)'),
  '!LDCAD GROUP_NXT': d('structure', false, 'assigns the next line to a group (7,306 lines in 127 sets)'),
  '!LDCAD GENERATED': viaExpansion(`opens LDCad's written-out flex content — the file itself calls it "the fallback LDraw content for above PATH configuration" and follows it with ordinary type-1 lines (359 sets)`),
  '!LDCAD CONTENT': d('metadata', false, 'LDCad content descriptor'),
  '!LDCAD PATH_POINT': viaExpansion('LDCad flex-path control point (345 sets); the skinned result is emitted under GENERATED'),
  '!LDCAD PATH_SKIN': viaExpansion('LDCad flex-path skin definition (345 sets)'),
  '!LDCAD PATH_CAP': viaExpansion('LDCad flex-path end cap (179 sets)'),
  '!LDCAD PATH_LENGTH': viaExpansion('LDCad flex-path length'),
  '!LDCAD SPRING_POINT': viaExpansion('LDCad spring control point'),
  '!LDCAD SPRING_SECTION': viaExpansion('LDCad spring section'),
  '!LDCAD SPRING_CAP': viaExpansion('LDCad spring end cap'),
  '!LDCAD SPRING_ANCHOR': viaExpansion('LDCad spring anchor'),
  '!LDCAD SNAP_INCL': d('metadata', false, 'LDCad connectivity metadata — a build aid, not geometry'),
  '!LDCAD SNAP_CYL': d('metadata', false, 'LDCad connectivity metadata'),
  '!LDCAD SNAP_CLEAR': d('metadata', false, 'LDCad connectivity metadata'),
  '!LDCAD SNAP_GEN': d('metadata', false, 'LDCad connectivity metadata'),
  '!LDCAD SNAP_FGR': d('metadata', false, 'LDCad connectivity metadata'),
  '!LDCAD SNAP_CLP': d('metadata', false, 'LDCad connectivity metadata'),
  '!LDCAD MIRROR_INFO': d('metadata', false, 'LDCad mirroring hint'),
  '!LEOCAD MODEL': d('metadata', false, 'LeoCAD model properties (176 sets)'),
  '!LEOCAD GROUP': d('structure', false, 'LeoCAD group begin/end'),
  '!LEOCAD PIECE': d('metadata', false, 'LeoCAD per-piece properties'),
  '!LEOCAD CAMERA': d('view', false, 'LeoCAD camera'),
  '!LEOCAD SYNTH': viaExpansion('LeoCAD flexible-part spec; the result is emitted as real lines'),
  '!LEOCAD BACKGROUND': d('view', false, 'LeoCAD scene background'),

  // ── instruction publishing (LPub) ───────────────────────────────────────
  'LPUB PLI': d('view', false, 'LPub parts-list image control'),
  '!LPUB PLI': d('view', false, 'LPub parts-list image control, `!`-prefixed spelling'),
  '!LPUB INSERT': d('view', false, 'LPub page insert'),
  '!LPUB CALLOUT': d('view', false, 'LPub callout — repeats parts in a side panel of the PRINTED page, not the model'),
  '!LPUB BOM': d('view', false, 'LPub bill of materials'),
  '!LPUB MULTI_STEP': d('view', false, 'LPub step grouping'),
  '!LPUB PAGE': d('view', false, 'LPub page break'),
  '!LPUB STEP_NUMBER': d('view', false, 'LPub step numbering'),
  '!LPUB PLI_BEGIN': d('view', false, 'LPub parts-list block'),
  '!LPUB PLI_END': d('view', false, 'LPub parts-list block'),
  '!LPUB ASSEM': d('view', false, 'LPub assembly image control'),
  '!LPUB PART': d('view', false, 'LPub per-part display control'),
  '!LPUB RESOLUTION': d('view', false, 'LPub render resolution'),
  '!LPUB SUBMODEL_DISPLAY': d('view', false, 'LPub submodel display control'),
  '!LPUB ROTATE_ICON': d('view', false, 'LPub rotate icon placement'),
  '!LPUB CONSOLIDATE_INSTANCE_COUNT': d('view', false, 'LPub instance counting'),
  'PLIST BEGIN': d('view', false, 'parts-list block'),
  'PLIST END': d('view', false, 'parts-list block'),

  // ── winding ─────────────────────────────────────────────────────────────
  'BFC CERTIFY': d('view', false, 'declares face winding (862 sets). The voxelizer decides inside/outside by ray parity, which winding does not affect.'),
  'BFC NOCERTIFY': d('view', false, 'declares the file is not BFC-certified'),
  'BFC INVERTNEXT': d('view', false, 'inverts the next line\'s winding (18,724 lines in 576 sets); parity voxelization is winding-independent'),
  'BFC CCW': d('view', false, 'counter-clockwise winding'),
  'BFC CW': d('view', false, 'clockwise winding'),
  'BFC CLIP': d('view', false, 'back-face culling hint'),
  'BFC NOCLIP': d('view', false, 'back-face culling hint'),

  // ── metadata ────────────────────────────────────────────────────────────
  '!LDRAW_ORG': d('metadata', true, 'part type — distinguishes an embedded PART definition from a sub-model assembly, which decides whether the parser recurses'),
  LDRAW_ORG: d('metadata', true, 'unprefixed spelling'),
  UNOFFICIAL: d('metadata', true, 'legacy part-type marker'),
  '!LICENSE': d('metadata', false, 'redistribution licence'),
  '!HISTORY': d('metadata', false, 'part edit history'),
  '!HELP': d('metadata', false, 'author notes'),
  '!KEYWORDS': d('metadata', false, 'search keywords'),
  '!KEYWORD': d('metadata', false, 'misspelling of !KEYWORDS present in the corpus'),
  '!HOSTORY': d('metadata', false, 'misspelling of !HISTORY present in the corpus'),
  '!CATEGORY': d('metadata', false, 'part category'),
  '!THEME': d('metadata', false, 'set theme'),
  '!CMDLINE': d('metadata', false, 'suggested renderer command line'),
  '!LPE': d('metadata', false, 'LDraw Part Editor marker'),
  '!DATA START': d('metadata', false, 'base64 payload block (textures)'),
  '!DATA END': d('metadata', false, 'base64 payload block'),
  NAME: d('metadata', false, 'part/model name'),
  AUTHOR: d('metadata', false, 'author'),
  WRITE: d('view', false, 'text drawn in instructions'),
  PRINT: d('view', false, 'text drawn in instructions'),
  CLEAR: d('view', false, 'clears the instruction canvas'),
  PAUSE: d('view', false, 'instruction playback pause'),
  SAVE: d('view', false, 'instruction snapshot'),
  SPLINE: d('view', false, 'LDraw Design Pad spline'),
  ENDSPLINE: d('view', false, 'LDraw Design Pad spline'),
  SPLROT: d('view', false, 'LDraw Design Pad spline rotation'),
  STUDIOSTEPDESC: d('view', false, 'Studio step description text'),

  // ── this project's own provenance stamps ────────────────────────────────
  DBIX: d('metadata', false, 'craftmatic/clego: DBIX source provenance'),
  LEGO: d('metadata', false, 'craftmatic/clego: source provenance'),
  '!LINEAGE': d('metadata', false, 'craftmatic/clego: which converter produced this file'),
  '!GEOGRADE': d('metadata', false, 'craftmatic/clego: measured geometry grade'),
  '!CLASS_B_REFRAME': d('metadata', false, 'craftmatic/clego: class-B reframe stamp'),
  '!FIGURE_ASSEMBLE': d('metadata', false, 'craftmatic/clego: figure assembly stamp'),
  '!WINDOW_ASSEMBLE': d('metadata', false, 'craftmatic/clego: window assembly stamp'),
  '!ORIGIN_FIX': d('metadata', false, 'craftmatic/clego: origin correction stamp'),
  '!EMBEDDED_PRESERVED': d('metadata', false, 'craftmatic/clego: embedded geometry preserved verbatim'),
};

/**
 * The directive key for a line-type-0 line, or `null` when the line is a
 * comment or a model title rather than a command.
 *
 * `0 UCS Millennium Falcon` is a title; `0 MLCAD SKIP_BEGIN` is a command. The
 * difference is not the shape of the text — it is whether the first token is a
 * `!`-prefixed meta or one of the closed set of legacy unprefixed ones.
 */
export function directiveKey(line: string): string | null {
  const m = /^0\s+(\S+)(?:\s+(\S+))?/.exec(line.trim());
  if (!m) return null;
  const first = m[1]!;
  // `0 !: <geometry>` is a directive whose "argument" is a whole line.
  if (first === '!:') return '!:';
  const upper = first.toUpperCase();
  const isMeta = first.startsWith('!') || UNPREFIXED_METAS.has(upper);
  if (!isMeta) return null;
  const key = first.startsWith('!') ? `!${upper.slice(1)}` : upper;
  if (NAMESPACED.has(key) && m[2]) return `${key} ${m[2]!.toUpperCase()}`;
  return key;
}

/** The spec for a line, or `'unknown'` when it is a directive we have never seen. */
export function classifyDirective(line: string): DirectiveSpec | 'unknown' | null {
  const key = directiveKey(line);
  if (key === null) return null;
  const spec = LDRAW_DIRECTIVES[key];
  if (spec) return spec;
  // A namespaced directive whose verb is new: fall back to the namespace so a
  // new `!LDCAD SNAP_*` is reported against its family rather than as a
  // mystery, but still counts as unknown.
  return 'unknown';
}

/** Directives that change the model and which the reader does NOT act on. */
export function unhandledGeometryDirectives(): string[] {
  return Object.entries(LDRAW_DIRECTIVES)
    .filter(([, s]) => !s.handled && (s.effect === 'geometry' || s.effect === 'colour'))
    .map(([k]) => k)
    .sort();
}
