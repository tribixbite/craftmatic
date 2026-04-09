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
 */

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
   * Assembly step number (1-based) from LDraw STEP meta-commands.
   * Step 1 = bricks before the first STEP marker.
   * Undefined for parsers that don't emit step info.
   */
  step?: number;
}

interface Section {
  name: string;
  lines: string[];
}

/**
 * Parse an LDraw MPD or LDR file string and return all brick placements.
 * Recursively resolves sub-model references with full transform accumulation.
 * Bricks include a `step` number (1-based) derived from `0 STEP` meta-commands.
 */
export function parseLDraw(content: string): ParsedBrick[] {
  const sections = splitIntoSections(content);
  if (sections.length === 0) return [];

  const bricks: ParsedBrick[] = [];
  const IDENTITY = [1, 0, 0,  0, 1, 0,  0, 0, 1];
  const stepRef = { step: 1 };
  expandSection(sections[0].lines, sections, IDENTITY, [0, 0, 0], bricks, 0, 16, stepRef);
  return bricks;
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

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // MPD file boundary marker: "0 FILE <name>"
    const fileMatch = /^0\s+FILE\s+(.+)$/i.exec(line);
    if (fileMatch) {
      current = { name: fileMatch[1].trim().toLowerCase().replace(/\\/g, '/'), lines: [] };
      sections.push(current);
      continue;
    }

    if (!current) {
      // LDR (single-file) — create implicit main section
      current = { name: '__main__', lines: [] };
      sections.push(current);
    }

    current.lines.push(line);
  }

  return sections;
}

// ─── Section Expansion ───────────────────────────────────────────────────────

function expandSection(
  lines: string[],
  allSections: Section[],
  parentRot: number[],   // 3×3 rotation matrix, row-major (9 elements)
  parentPos: number[],   // [x, y, z] parent origin in LDU
  output: ParsedBrick[],
  depth: number,
  parentColor: number = 16, // inherited color context for color-16 resolution
  stepRef: { step: number } = { step: 1 }, // shared step counter (mutated at depth 0)
): void {
  // Guard against runaway recursion (circular references or deep nesting)
  if (depth > 50) return;

  for (const line of lines) {
    if (!line) continue;

    // At top level only: track assembly step markers
    if (line.startsWith('0')) {
      if (depth === 0 && /^0\s+STEP\s*$/i.test(line)) {
        stepRef.step++;
      }
      continue;
    }

    const tokens = line.split(/\s+/);
    if (tokens.length < 15 || tokens[0] !== '1') continue;

    const rawColor = parseInt(tokens[1], 10);
    // LDraw color 16 = "Main Color" — inherit from parent reference context
    const color = rawColor === 16 ? parentColor : rawColor;
    const lx = parseFloat(tokens[2]);
    const ly = parseFloat(tokens[3]);
    const lz = parseFloat(tokens[4]);

    // Local rotation matrix (tokens 5–13, row-major)
    const localRot = tokens.slice(5, 14).map(Number);

    // Filename may contain spaces (tokens 14+)
    const rawFilename = tokens.slice(14).join(' ').trim();
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
    //   • Unofficial_Part / Unofficial_Subpart — geometry-only definitions that yield
    //     no meaningful terminal bricks when recursed. Treat as terminal so the dims
    //     table can assign the correct bounding box.
    //   • Unofficial_Shortcut — assemblies of multiple parts; MUST be recursed so each
    //     constituent part (e.g. propeller + axle) is individually voxelized.
    //
    // Detect via !LDRAW_ORG metadata in the first 15 lines of the section.
    const isEmbeddedPartDef = subSection != null
      && subSection.name.endsWith('.dat')
      && subSection.lines.slice(0, 15).some(
        l => /^0\s+!LDRAW_ORG\s+Unofficial_(?:Part|Subpart)/i.test(l),
      );

    if (subSection && !isEmbeddedPartDef) {
      // Recurse into sub-model assembly, passing resolved color as the new parentColor.
      // Step tracking is only done at depth 0; sub-models don't have their own STEP markers.
      expandSection(subSection.lines, allSections, childRot, [wx, wy, wz], output, depth + 1, color, stepRef);
    } else if (!isLDrawPrimitive(basename)) {
      // Terminal part (.dat or unknown) — record brick placement with rotation.
      // Skip LDraw geometry primitives (fraction-named files, anti-stud shapes, etc.)
      // which are sub-part geometry files, not complete LEGO parts.
      output.push({ color, x: wx, y: wy, z: wz, rot: childRot, part: basename, step: stepRef.step });
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
