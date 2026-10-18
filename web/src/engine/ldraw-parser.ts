/**
 * LDraw MPD/LDR file parser.
 *
 * Parses LDraw Multi-Part Document files and extracts brick placements
 * with their full 3D world-space positions and color IDs.
 *
 * LDraw format spec: https://www.ldraw.org/article/218.html
 * LDraw units (LDU): 1 stud pitch = 20 LDU, 1 plate height = 8 LDU
 *
 * Line type 1 (sub-file reference / brick placement):
 *   1 <colour> x y z a b c d e f g h i <filename>
 * where (a-i) is the 3×3 rotation matrix in row-major order.
 *
 * Line type 0 is a meta-command. Most are comments or view hints, but several
 * move parts in or out of the model — see `ldraw-directives.ts`, which lists
 * every directive the corpus contains and is checked against the whole corpus
 * by `scripts/_converter_coverage_audit.ts`.
 */
import { LDRAW_COLOR_RGB } from './ldraw-colors.js';
import { resolveLdrawEntityMaterial } from './ldraw-entity-materials.js';

export interface ParsedBrick {
  /** LDraw color ID */
  color: number;
  /** World-space X in LDU */
  x: number;
  /** World-space Y in LDU (LDraw uses inverted Y: -Y is "up") */
  y: number;
  /** World-space Z in LDU */
  z: number;
  /**
   * World-space 3×3 rotation matrix in row-major order (9 elements).
   * Transforms local part coordinates to world coordinates.
   * Omitted for bricks from non-LDraw parsers; voxelizer defaults to identity.
   */
  rot?: number[];
  /** Part filename, e.g. "3001.dat" */
  part: string;
  /**
   * The print a PLAIN head carries, from a `0 !CRAFTMATIC HEAD_PRINT <id>`
   * line immediately before it (the head's BrickLink print id, `3626pb3484`).
   * The converters write it for a decorated head no LDraw library prints: the
   * part stays the plain mould every reader can draw, and face art keys on
   * this id (`head-face.ts`).
   */
  headPrint?: string;
  /**
   * Assembly step number (1-based) from LDraw STEP meta-commands.
   * Step 1 = bricks before the first STEP marker.
   * Undefined for parsers that don't emit step info.
   */
  step?: number;
  /**
   * MPD submodel ancestry, outermost first.  This survives recursive expansion
   * so exporters can distinguish a removable car/aircraft from its containing
   * building (for example 76252's Batmobile from the Batcave shell).
   */
  sourcePath?: string[];
}

/**
 * A colour code a document defines for ITSELF, via `0 !COLOUR` or the LDLite
 * `0 COLOR`. These are not decoration: 85 codes across the corpus are
 * redefined away from the official palette and 26 more are codes the shared
 * table has never heard of, and the same code carries different RGB in
 * different files — so the palette genuinely belongs to the document.
 */
export interface LDrawLocalColour {
  code: number;
  /** `#RRGGBB`. */
  rgb: string;
  /** 0–255; below 255 the colour is transparent. */
  alpha: number;
  name: string;
}

/** One `0 FILE` section of an MPD (or the whole of a plain `.ldr`). */
export interface LDrawSection {
  /** Normalised name: lower-case, forward slashes, as referenced by type-1 lines. */
  name: string;
  /** Trimmed source lines, `0 FILE` header excluded. */
  lines: string[];
}

type Section = LDrawSection;

/**
 * A parsed document: the flattened placements PLUS every section the file
 * carried, so a consumer that needs the geometry of an embedded part (Studio
 * `.io` exports and OMR MPDs inline `.dat` definitions) can get at its text
 * instead of having to re-fetch a part that only exists inside this file.
 */
export interface LDrawDocument {
  bricks: ParsedBrick[];
  /** Keyed by normalised section name. A plain `.ldr` has one `__main__` entry. */
  sections: Map<string, LDrawSection>;
  /** Name of the section that was expanded as the model root. */
  rootSection: string;
  /** Colour codes this document defines for itself, keyed by code. */
  colours: Map<number, LDrawLocalColour>;
}

/**
 * Parse an LDraw MPD or LDR file string and return all brick placements.
 * Recursively resolves sub-model references with full transform accumulation.
 * Bricks include a `step` number (1-based) derived from `0 STEP` meta-commands.
 */
export function parseLDraw(content: string): ParsedBrick[] {
  return parseLDrawDocument(content).bricks;
}

/**
 * Parse an LDraw MPD or LDR file and keep the sections. Placement expansion is
 * exactly `parseLDraw()`'s (same transforms, colour-16 inheritance, steps,
 * `sourcePath`); the sections are copies, so callers cannot mutate parser
 * state through them.
 */
export function parseLDrawDocument(content: string): LDrawDocument {
  const sections = splitIntoSections(content);
  const sectionMap = new Map<string, LDrawSection>();
  for (const s of sections) {
    // The parser's own lookup finds the FIRST section of a name; keep that one.
    if (!sectionMap.has(s.name)) sectionMap.set(s.name, { name: s.name, lines: s.lines.slice() });
  }
  const colours = parseLocalColours(content);
  if (sections.length === 0) return { bricks: [], sections: sectionMap, rootSection: '__main__', colours };

  const bricks: ParsedBrick[] = [];
  const IDENTITY = [1, 0, 0,  0, 1, 0,  0, 0, 1];
  const stepRef = { step: 1 };
  const docState: DocumentState = { step: stepRef, buffers: new Map(), overrides: colourOverrides(colours) };
  expandSection(sections[0].lines, sections, IDENTITY, [0, 0, 0], bricks, 0, 16, stepRef, [sections[0].name], docState);
  return { bricks, sections: sectionMap, rootSection: sections[0].name, colours };
}

/**
 * Read every colour a document defines for itself.
 *
 * Two spellings occur in the corpus: the LDraw standard
 * `0 !COLOUR <name> CODE <n> VALUE #RRGGBB [ALPHA <a>]` and LDLite's
 * `0 COLOR <n> <name> <r> <g> <b> <a> …`. Both are read here so neither
 * dialect silently falls back to the shared palette.
 */
export function parseLocalColours(content: string): Map<number, LDrawLocalColour> {
  const out = new Map<number, LDrawLocalColour>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.charCodeAt(0) !== 48 /* '0' */) continue;
    const std = /^0\s+!?COLOUR\s+(\S+)\s+CODE\s+(\d+)\s+VALUE\s+(#[0-9A-Fa-f]{6})(?:.*?\bALPHA\s+(\d+))?/i.exec(line);
    if (std) {
      const code = Number(std[2]);
      if (!out.has(code)) {
        out.set(code, { code, rgb: std[3]!.toUpperCase(), alpha: std[4] ? Number(std[4]) : 255, name: std[1]! });
      }
      continue;
    }
    // LDLite: `0 COLOR <code> <name> <flags> <r> <g> <b> <a> <er> <eg> <eb> <ea>`
    //
    // The name may contain spaces ("Dark Bluish Gray") and a FLAGS field sits
    // between the name and the colour, so the fields are counted from the end:
    // all 3,819 corpus lines carry exactly nine numbers after the name. Taking
    // the first three numbers instead reads `<flags> <r> <g>` and paints every
    // such model with a channel-shifted palette at alpha 63.
    const lite = /^0\s+COLOR\s+(\d+)\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/i.exec(line);
    if (lite) {
      const code = Number(lite[1]);
      if (out.has(code)) continue;
      const hex = '#' + [lite[4], lite[5], lite[6]]
        .map(v => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase();
      out.set(code, { code, rgb: hex, alpha: Number(lite[7]), name: lite[2]!.trim() });
    }
  }
  return out;
}

/**
 * Flexible-part generators this reader can draw itself.
 *
 * Empty: we place the pre-expanded segments MLCad wrote instead. Adding a name
 * here makes the parser skip that generator's expanded block, which is only
 * correct once something actually synthesises the part from its spec.
 */
const IMPLEMENTED_GENERATORS: ReadonlySet<string> = new Set<string>();

/** LDraw direct-colour encodings: `0x2RRGGBB` opaque, `0x3RRGGBB` transparent. */
const DIRECT_OPAQUE = 0x2000000;
const DIRECT_TRANSPARENT = 0x3000000;

/**
 * Codes whose local definition DISAGREES with the shared palette, mapped to the
 * equivalent LDraw direct colour.
 *
 * Rewriting to a direct colour rather than mutating a shared table is what
 * makes a per-document palette safe: the exact RGB rides along on the brick
 * itself, so two models open at once cannot corrupt each other's colours, and
 * every consumer that already understands `0x2RRGGBB` needs no change at all.
 *
 * A definition that merely restates the official value is left alone, so named
 * colours keep their material class (chrome, pearl, rubber) instead of
 * flattening to a plain RGB.
 */
export function colourOverrides(colours: Map<number, LDrawLocalColour>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [code, def] of colours) {
    // 16 (main) and 24 (edge) are contextual — a file that "defines" them is
    // restating the convention, and overriding them would break inheritance.
    if (code === 16 || code === 24) continue;
    const official = LDRAW_COLOR_RGB[code];
    if (official && def.alpha >= 255 && channelDistance(official, def.rgb) <= keepThreshold(code)) continue;
    const value = parseInt(def.rgb.slice(1), 16);
    out.set(code, (def.alpha < 255 ? DIRECT_TRANSPARENT : DIRECT_OPAQUE) | value);
  }
  return out;
}

/**
 * How far a local definition may sit from the shared palette and still be
 * treated as the same colour, per channel out of 255.
 *
 * Measured over the corpus: 97.4 % of overrides move a colour by more than
 * this (code 67 is "rubber white" in the shared table and plain blue #0043DF
 * in the files that define it, across 264 bricks of 10131), so the threshold
 * changes almost nothing — but the handful it catches keep their material
 * class, and an 8/255 shift is far less visible than turning a chrome part
 * into a plastic one. Only 9 brick placements in the whole corpus were losing
 * a class over a difference this small.
 */
const COLOUR_KEEP_THRESHOLD = 8;

/**
 * The same, for a code the shared table gives a non-plastic FINISH.
 *
 * A direct colour carries RGB and nothing else, so overriding a chrome or
 * rubber code turns the part into plain ABS. Losing the finish is a bigger
 * visual error than a moderate RGB shift — 42097 defines code 496 as #969696
 * where the table says #A3A2A4, 14/255 apart, and taking the file's value
 * costs 160 bricks their rubber finish to gain a difference nobody can see.
 * The LDLite-era remappings this whole mechanism exists for are 200+ apart,
 * so a wider window here does not let any of them through.
 */
const COLOUR_KEEP_THRESHOLD_FINISHED = 32;

/** Codes whose material class is not plain plastic keep a wider window. */
function keepThreshold(code: number): number {
  const cls = resolveLdrawEntityMaterial(code).materialClass;
  return cls === 'abs' || cls === 'transparent' ? COLOUR_KEEP_THRESHOLD : COLOUR_KEEP_THRESHOLD_FINISHED;
}

/** Largest per-channel difference between two `#RRGGBB` strings. */
function channelDistance(a: string, b: string): number {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  return Math.max(
    Math.abs(((pa >> 16) & 0xff) - ((pb >> 16) & 0xff)),
    Math.abs(((pa >> 8) & 0xff) - ((pb >> 8) & 0xff)),
    Math.abs((pa & 0xff) - (pb & 0xff)),
  );
}

/**
 * The embedded PART definitions of a document (every `.dat` section), as
 * `[name, text]` pairs ready for a part-geometry resolver's seed. Sub-model
 * (`.ldr` / extension-less) sections are assemblies the placement parser has
 * already expanded and are not part definitions, so they are left out.
 */
export function embeddedPartTexts(doc: LDrawDocument): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const s of doc.sections.values()) {
    if (!s.name.endsWith('.dat')) continue;
    out.push([s.name, s.lines.join('\n')]);
  }
  return out;
}

/**
 * LDraw colour token → id. Direct colours are written as hex (`0x2RRGGBB`,
 * `0x3RRGGBB`); a decimal parse would turn those into 0 (black).
 */
export function parseLDrawColor(token: string): number {
  const value = /^0x/i.test(token) ? parseInt(token, 16) : parseInt(token, 10);
  // Studio embedded meshes spell the inherited main colour as -1.
  return value === -1 ? 16 : value;
}

/**
 * Returns the total number of STEP markers in the given ParsedBrick array.
 * Useful for setting up a step slider.
 */
export function countSteps(bricks: ParsedBrick[]): number {
  if (bricks.length === 0) return 0;
  const maxStep = bricks.reduce((m, b) => Math.max(m, b.step ?? 1), 1);
  return maxStep;
}

// ─── Section Splitting ───────────────────────────────────────────────────────

function splitIntoSections(content: string): Section[] {
  const lines = content.split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section | null = null;
  // Once a `0 FILE` has been seen, a line outside any section is orphaned
  // rather than the start of an implicit main model.
  let sawFile = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // MPD file boundary marker: "0 FILE <name>"
    const fileMatch = /^0\s+FILE\s+(.+)$/i.exec(line);
    if (fileMatch) {
      const rawName = fileMatch[1].trim().replace(/^"(.*)"$/, '$1').trim();
      current = { name: rawName.toLowerCase().replace(/\\/g, '/'), lines: [] };
      sections.push(current);
      sawFile = true;
      continue;
    }

    // `0 NOFILE` closes the current MPD section. Anything between it and the
    // next `0 FILE` belongs to no model — 8 corpus files carry 94 such lines,
    // and appending them to the section just closed would place their parts.
    if (/^0\s+NOFILE\s*$/i.test(line)) {
      current = null;
      continue;
    }

    if (!current) {
      if (sawFile) continue;  // orphaned: after a NOFILE, outside every section
      // LDR (single-file) — create implicit main section
      current = { name: '__main__', lines: [] };
      sections.push(current);
    }

    current.lines.push(line);
  }

  return sections;
}

// ─── Section Expansion ───────────────────────────────────────────────────────

/**
 * Document-wide state that survives recursion into sub-models: the step
 * counter, the buffer-exchange rollback points, and the local palette.
 */
interface DocumentState {
  step: { step: number };
  /**
   * `0 BUFEXCHG <name> STORE` → a SNAPSHOT of the output at that point.
   *
   * Not a length. RETRIEVE restores the saved state, which can be LONGER than
   * the current one: 358-1 stores B, places 30 parts, stores A, retrieves B to
   * set them aside, places 5 more, then retrieves A to bring the 30 back and
   * drop the 5. A rollback implemented as a truncation does the exact opposite
   * — it loses the 30 and keeps the 5.
   */
  buffers: Map<string, ParsedBrick[]>;
  /** Colour code → LDraw direct colour, for codes this document redefines. */
  overrides: Map<number, number>;
}

function expandSection(
  lines: string[],
  allSections: Section[],
  parentRot: number[],   // 3×3 rotation matrix, row-major (9 elements)
  parentPos: number[],   // [x, y, z] parent origin in LDU
  output: ParsedBrick[],
  depth: number,
  parentColor: number = 16, // inherited color context for color-16 resolution
  stepRef: { step: number } = { step: 1 }, // shared step counter (mutated at depth 0)
  sourcePath: string[] = [],
  doc: DocumentState = { step: stepRef, buffers: new Map(), overrides: new Map() },
): void {
  // Guard against runaway recursion (circular references or deep nesting)
  if (depth > 50) return;

  /**
   * Nesting level of `0 MLCAD SKIP_BEGIN` blocks we are choosing to skip.
   *
   * A skip block is NOT dead content. MLCad wraps it around geometry it can
   * regenerate from a preceding generator meta, and a corpus sweep found that
   * every one of the 231 blocks in 63 files sits directly under `MLCAD
   * FLEXHOSE` (215 blocks, 40,390 parts), `MLCAD RUBBER_BELT` (14) or `MLCAD
   * SPRING` (2) — there is not a single block used for anything else. So a
   * reader that implements the generator must skip the block or draw the hose
   * twice, and a reader that does not must KEEP it or the hose vanishes.
   * Skipping unconditionally deleted 40,862 parts' worth of flexible hoses.
   */
  let skipDepth = 0;
  /** The generator meta a SKIP block would be regenerated from, if any. */
  let lastGenerator: string | null = null;
  /**
   * Inside a `0 !TEXMAP` block, geometry is written twice: once prefixed
   * `0 !:` for readers that draw the texture, and once plainly after
   * `0 !TEXMAP FALLBACK` for readers that do not. Taking both DOUBLES every
   * textured part, so the prefixed lines are held here and used only if the
   * block ends without a fallback.
   */
  // Held in an object, not two `let`s: TypeScript does not narrow a `let`
  // that only a nested function assigns, so the flush below would be typed
  // against the initial `null`.
  const texmap: { pending: string[] | null; hasFallback: boolean } = { pending: null, hasFallback: false };
  /** A `0 !CRAFTMATIC HEAD_PRINT` id waiting for the next type-1 line. */
  let pendingHeadPrint: string | null = null;

  for (const line of lines) {
    if (!line) continue;

    if (line.charCodeAt(0) === 48 /* '0' */) {
      handleMeta(line);
      continue;
    }
    if (skipDepth > 0) continue;
    place(line);
  }

  // A file that ends mid-TEXMAP still owes us its geometry.
  if (texmap.pending && !texmap.hasFallback) for (const l of texmap.pending) place(l);

  /** Act on a line-type-0 meta command. */
  function handleMeta(line: string): void {
    // The block delimiters come FIRST, and everything else is gated behind
    // them: a directive inside skipped content must not act, including `STEP`,
    // which would otherwise number steps for a block that is not built.
    //
    // Skip a block only if we could draw its generator ourselves; see the note
    // on `skipDepth`. `IMPLEMENTED_GENERATORS` is empty today, so every block
    // is kept — and the day a generator lands, adding its name there is the
    // whole change.
    if (/^0\s+MLCAD\s+SKIP_BEGIN\b/i.test(line)) {
      if (lastGenerator === null || IMPLEMENTED_GENERATORS.has(lastGenerator)) skipDepth++;
      lastGenerator = null;
      return;
    }
    if (/^0\s+MLCAD\s+SKIP_END\b/i.test(line)) { skipDepth = Math.max(0, skipDepth - 1); return; }
    if (skipDepth > 0) return;

    // Track assembly step markers at any depth. Many OMR sets (e.g., 31084
    // Pirate Roller Coaster) keep all top-level brick references in one
    // block and put the STEP markers inside each sub-assembly file —
    // limiting step-counting to depth 0 would give those models step=1/1.
    // Counting at every depth produces finer building-manual-style steps
    // (sub-assemblies build themselves out, then the next sub-assembly).
    if (/^0\s+STEP\s*$/i.test(line)) { stepRef.step++; return; }

    // Remember which generator a following SKIP block belongs to.
    const gen = /^0\s+MLCAD\s+(FLEXHOSE|RUBBER_BELT|SPRING)\b/i.exec(line);
    if (gen) { lastGenerator = gen[1]!.toUpperCase(); return; }

    // `0 BUFEXCHG <buffer> STORE` saves the model so far and `RETRIEVE` puts
    // it back — an instruction-time "set this aside and pick it up later".
    // Ignoring it leaves parts in the model that the file took out again.
    const buf = /^0\s+BUFEXCHG\s+(\S+)\s+(STORE|RETRIEVE)\b/i.exec(line);
    if (buf) {
      const name = buf[1]!.toUpperCase();
      if (buf[2]!.toUpperCase() === 'STORE') {
        doc.buffers.set(name, output.slice());
      } else {
        const saved = doc.buffers.get(name);
        // A RETRIEVE with no STORE names a buffer this file never filled;
        // emptying the model on it would be worse than ignoring it.
        if (saved) {
          output.length = 0;
          for (const brick of saved) output.push(brick);
        }
      }
      return;
    }

    // `0 !CRAFTMATIC HEAD_PRINT <id>`: the print of the NEXT type-1 line (a plain head).
    const headPrint = /^0\s+!CRAFTMATIC\s+HEAD_PRINT\s+(\S+)/i.exec(line);
    if (headPrint) { pendingHeadPrint = headPrint[1]!.toLowerCase(); return; }

    // `0 GHOST <type-1 line>` is a part MLCad draws faded. It is in the model.
    const ghost = /^0\s+GHOST\s+(1\s+.*)$/i.exec(line);
    if (ghost) { place(ghost[1]!); return; }

    if (/^0\s+!TEXMAP\s+(START|NEXT)\b/i.test(line)) { texmap.pending = []; texmap.hasFallback = false; return; }
    if (/^0\s+!TEXMAP\s+FALLBACK\b/i.test(line)) { texmap.hasFallback = true; return; }
    if (/^0\s+!TEXMAP\s+END\b/i.test(line)) {
      if (texmap.pending && !texmap.hasFallback) for (const l of texmap.pending) place(l);
      texmap.pending = null;
      texmap.hasFallback = false;
      return;
    }
    // Geometry inside a TEXMAP block, hidden behind the `0 !:` prefix.
    const textured = /^0\s+!:\s+(.*)$/.exec(line);
    if (textured && texmap.pending) { texmap.pending.push(textured[1]!); return; }
  }

  /** Place one type-1 sub-file reference. */
  function place(line: string): void {
    const tokens = line.split(/\s+/);
    // A HEAD_PRINT belongs to the very next reference, whatever it turns out to be.
    const headPrint = pendingHeadPrint;
    pendingHeadPrint = null;
    if (tokens.length < 15 || tokens[0] !== '1') return;

    const rawColor = parseLDrawColor(tokens[1]);
    // LDraw color 16 = "Main Color" — inherit from parent reference context
    const inherited = rawColor === 16 ? parentColor : rawColor;
    // A code this document redefines becomes the equivalent direct colour, so
    // the file's own palette travels with the brick instead of being looked up
    // in a shared table that disagrees with it.
    const color = doc.overrides.get(inherited) ?? inherited;
    const lx = parseFloat(tokens[2]);
    const ly = parseFloat(tokens[3]);
    const lz = parseFloat(tokens[4]);

    // Local rotation matrix (tokens 5–13, row-major)
    const localRot = tokens.slice(5, 14).map(Number);

    // Filename may contain spaces (tokens 14+) and optional enclosing quotes
    const rawFilename = tokens.slice(14).join(' ').trim().replace(/^"(.*)"$/, '$1').trim();
    const filename = rawFilename.toLowerCase().replace(/\\/g, '/');
    // Strip any path prefix — sections are indexed by bare filename
    const basename = filename.includes('/') ? filename.slice(filename.lastIndexOf('/') + 1) : filename;

    // Apply parent transform: world = parentRot × local + parentPos
    const wx = parentRot[0]*lx + parentRot[1]*ly + parentRot[2]*lz + parentPos[0];
    const wy = parentRot[3]*lx + parentRot[4]*ly + parentRot[5]*lz + parentPos[1];
    const wz = parentRot[6]*lx + parentRot[7]*ly + parentRot[8]*lz + parentPos[2];

    // Compound rotation for children: worldRot = parentRot × localRot
    const childRot = mat3Mul(parentRot, localRot);

    // Find a named sub-model section (MPD embedded models end in .ldr or have no extension)
    const subSection = allSections.find(
      s => s.name === basename || s.name === filename,
    );

    // LDraw .dat sub-sections embedded in MPDs can be either:
    //   • Part / Subpart (official or unofficial) — geometry definitions that yield
    //     no meaningful terminal bricks when recursed. Treat as terminal so the dims
    //     table can assign the correct bounding box.
    //   • Unofficial_Shortcut — assemblies of multiple parts; MUST be recursed so each
    //     constituent part (e.g. propeller + axle) is individually voxelized.
    //
    // Detect via metadata in the section header, including Studio mesh flags.
    const definitionHeaders = subSection?.lines.slice(0, 30) ?? [];
    // Studio's embedded meshes have no !LDRAW_ORG header. Its explicit
    // non-submodel/non-assembly flags distinguish these from real assemblies.
    const isStudioPart = definitionHeaders.some(l => /^0\s+IsSubModel\s+False\s*$/i.test(l))
      && definitionHeaders.some(l => /^0\s+IsAssembly\s+False\s*$/i.test(l));
    const isEmbeddedPartDef = subSection != null
      && subSection.name.endsWith('.dat')
      && (isStudioPart || definitionHeaders.some(
        l => /^0\s+!LDRAW_ORG\s+(?:Unofficial_)?(?:Part|Subpart)\b/i.test(l),
      ));

    if (subSection && !isEmbeddedPartDef) {
      // Recurse into sub-model assembly, passing resolved color as the new parentColor.
      // Step tracking is only done at depth 0; sub-models don't have their own STEP markers.
      expandSection(
        subSection.lines, allSections, childRot, [wx, wy, wz], output,
        depth + 1, color, stepRef, [...sourcePath, subSection.name], doc,
      );
    } else if (!isLDrawPrimitive(basename)) {
      // Terminal part (.dat or unknown) — record brick placement with rotation.
      // Skip LDraw geometry primitives (fraction-named files, anti-stud shapes, etc.)
      // which are sub-part geometry files, not complete LEGO parts.
      output.push({
        color, x: wx, y: wy, z: wz, rot: childRot, part: basename,
        step: stepRef.step, sourcePath: [...sourcePath],
        ...(headPrint ? { headPrint } : {}),
      });
    }
  }
}

// ─── Primitive Detection ─────────────────────────────────────────────────────

/**
 * Returns true for LDraw geometry primitive files that should NOT be voxelized.
 *
 * Primitives are sub-part geometry files used to build up part shapes from
 * basic geometric shapes (cylinders, rings, edges, etc.). They are NOT complete
 * LEGO parts and should not appear in the brick list.
 *
 * Identification rules:
 *   1. Fraction-prefix names: "4-4cyli", "1-8edge", "2-4ndis", "3-8chrd", etc.
 *      Pattern: digit(s) + hyphen + digit(s) at the start of the name.
 *   2. Anti-stud shapes: "stug-*" (under-stud geometry)
 *   3. Known axle hole primitives: "axlhole", "axl2hole", "axlehole"
 */
function isLDrawPrimitive(basename: string): boolean {
  const name = basename.replace(/\.dat$/i, '').toLowerCase();
  // Fraction primitives (most common): 4-4cyli, 1-8edge, 2-4ndis, 3-8chrd, etc.
  if (/^\d+-\d+/.test(name)) return true;
  // Anti-stud shape primitives
  if (name.startsWith('stug')) return true;
  // Axle hole primitives
  if (name === 'axl2hole' || name === 'axlhole' || name === 'axlehole') return true;

  // ── p/ directory geometric primitives ─────────────────────────────────────
  // Rectangle primitives: rect, rect1, rect2, rect2p, rect2a, rect3, etc.
  if (/^rect[0-9a-z]*$/.test(name)) return true;
  // Stud primitives: stud, stud2, stud2a, stud2s, stud3, stud4, stud4a, etc.
  // (NOT "stug" — that's handled above. NOT "study" — not a real name.)
  if (/^stud[0-9a-z]*$/.test(name)) return true;
  // Box primitives: box, box2, box3, box4, box5, box2-5, box3u7a, box4-4a, etc.
  if (/^box[0-9a-z-]*$/.test(name)) return true;
  // Disc/ring primitives: disc, ndis, ring, etc. (non-fraction forms)
  if (/^(disc|ndis|ring)[0-9a-z]*$/.test(name)) return true;
  // Triangle primitives
  if (/^tri[0-9a-z]*$/.test(name)) return true;
  // Cylinder/cone primitives (non-fraction)
  if (/^(cyli|cone|cylc)[0-9a-z]*$/.test(name)) return true;
  // Edge-only primitives
  if (/^edge[0-9a-z]*$/.test(name)) return true;
  // Logo / text stamps embedded as geometry
  if (/^logo[0-9a-z]*$/.test(name)) return true;
  // Chord, bump, and other misc geometry primitives
  if (/^(chrd|bump|ldu)[0-9a-z]*$/.test(name)) return true;

  return false;
}

// ─── 3×3 Matrix Multiply ────────────────────────────────────────────────────

/** Multiply two 3×3 matrices stored as row-major flat arrays of length 9. */
function mat3Mul(a: number[], b: number[]): number[] {
  return [
    a[0]*b[0] + a[1]*b[3] + a[2]*b[6],
    a[0]*b[1] + a[1]*b[4] + a[2]*b[7],
    a[0]*b[2] + a[1]*b[5] + a[2]*b[8],
    a[3]*b[0] + a[4]*b[3] + a[5]*b[6],
    a[3]*b[1] + a[4]*b[4] + a[5]*b[7],
    a[3]*b[2] + a[4]*b[5] + a[5]*b[8],
    a[6]*b[0] + a[7]*b[3] + a[8]*b[6],
    a[6]*b[1] + a[7]*b[4] + a[8]*b[7],
    a[6]*b[2] + a[7]*b[5] + a[8]*b[8],
  ];
}
