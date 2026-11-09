import type { SemVer } from './types.js';

/** Strict `major.minor.patch`: no leading zeros, no pre-release or build tag (a manifest cannot carry one). */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Parse `1.2.3`; throws RangeError on anything else (so a typo can never become a version). */
export function parseSemVer(text: string): SemVer {
  const m = SEMVER.exec(text);
  if (!m) throw new RangeError(`not a semantic version (major.minor.patch): ${JSON.stringify(text)}`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (const n of [major, minor, patch]) {
    if (!Number.isSafeInteger(n)) throw new RangeError(`semantic version part out of range: ${JSON.stringify(text)}`);
  }
  return { major, minor, patch };
}

/** `major.minor.patch`. */
export function formatSemVer(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** Numeric three-way compare (1.10.0 > 1.9.9): negative, zero or positive. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** The next version of a kind; a bump resets the lower parts. */
export function bumpSemVer(v: SemVer, kind: 'major' | 'minor' | 'patch'): SemVer {
  if (kind === 'major') return { major: v.major + 1, minor: 0, patch: 0 };
  if (kind === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

/** The `[major, minor, patch]` a Bedrock manifest `version` takes. Parts must be non-negative integers. */
export function toManifestTriple(v: SemVer): [number, number, number] {
  for (const n of [v.major, v.minor, v.patch]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`version part is not a non-negative integer: ${n}`);
  }
  return [v.major, v.minor, v.patch];
}
