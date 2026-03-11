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
  /** Part filename, e.g. "3001.dat" */
  part: string;
}

interface Section {
  name: string;
  lines: string[];
}

/**
 * Parse an LDraw MPD or LDR file string and return all brick placements.
 * Recursively resolves sub-model references with full transform accumulation.
 */
export function parseLDraw(content: string): ParsedBrick[] {
  const sections = splitIntoSections(content);
  if (sections.length === 0) return [];

  const bricks: ParsedBrick[] = [];
  const IDENTITY = [1, 0, 0,  0, 1, 0,  0, 0, 1];
  expandSection(sections[0].lines, sections, IDENTITY, [0, 0, 0], bricks, 0);
  return bricks;
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
      current = { name: fileMatch[1].trim().toLowerCase(), lines: [] };
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
): void {
  // Guard against runaway recursion (circular references or deep nesting)
  if (depth > 20) return;

  for (const line of lines) {
    if (!line || line.startsWith('0')) continue;

    const tokens = line.split(/\s+/);
    if (tokens.length < 15 || tokens[0] !== '1') continue;

    const color = parseInt(tokens[1], 10);
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

    if (subSection) {
      // Recurse into sub-model
      expandSection(subSection.lines, allSections, childRot, [wx, wy, wz], output, depth + 1);
    } else {
      // Terminal part (.dat or unknown) — record brick placement
      output.push({ color, x: wx, y: wy, z: wz, part: basename });
    }
  }
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
