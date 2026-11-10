/**
 * The grammar's rule tables (A07/A08, BIZ-05): DATA, keyed by style and feature kind, so a new architectural idiom is
 * a new row, not new code. Nothing here names a building.
 *
 * A style is chosen from `StyleProfile.era` (`gothic`, `classical`, anything else is `default`).
 */
import type { FeatureKind } from '../types.js';

export type StyleKey = 'gothic' | 'classical' | 'default';

/** How the head (top) of an opening is shaped. */
export type Head = 'flat' | 'round' | 'pointed';

/** What a style does with one feature kind that makes an opening in a wall. */
export interface OpeningRule {
  head: Head;
  /** Plates of trim sill under the opening (0 = none). */
  sill: number;
  /** Plates of the head above the springing that the arch occupies, as a fraction of the opening height. */
  headFraction: number;
}

export interface StyleRule {
  /** Opening kinds this style shapes; a kind not listed is a flat-headed window. */
  openings: Partial<Record<FeatureKind, OpeningRule>>;
  /** Spacing in metres of string courses on `tower` volumes (0 = none). */
  towerCourseM: number;
  /** Merlons along the top of a `battlement` feature: stud pitch of the merlon / gap pattern. */
  merlonStuds: number;
  /** Minimum plate height of a pinnacle's cap cone. */
  pinnacleCapPlates: number;
}

const FLAT: OpeningRule = { head: 'flat', sill: 0, headFraction: 0 };

export const STYLE_RULES: Readonly<Record<StyleKey, StyleRule>> = {
  gothic: {
    openings: {
      window: { head: 'pointed', sill: 1, headFraction: 0.4 },
      lancet: { head: 'pointed', sill: 0, headFraction: 0.35 },
      portal: { head: 'pointed', sill: 0, headFraction: 0.35 },
      door: { head: 'pointed', sill: 0, headFraction: 0.25 },
      arcade: { head: 'pointed', sill: 0, headFraction: 0.35 },
      rose: { head: 'round', sill: 0, headFraction: 1 },
    },
    towerCourseM: 12,
    merlonStuds: 1,
    pinnacleCapPlates: 3,
  },
  classical: {
    openings: {
      window: { head: 'round', sill: 1, headFraction: 0.25 },
      lancet: { head: 'round', sill: 0, headFraction: 0.3 },
      portal: { head: 'round', sill: 0, headFraction: 0.3 },
      door: { head: 'round', sill: 0, headFraction: 0.25 },
      arcade: { head: 'round', sill: 0, headFraction: 0.3 },
      rose: { head: 'round', sill: 0, headFraction: 1 },
    },
    towerCourseM: 8,
    merlonStuds: 1,
    pinnacleCapPlates: 3,
  },
  default: {
    openings: { lancet: { head: 'pointed', sill: 0, headFraction: 0.3 }, rose: { head: 'round', sill: 0, headFraction: 1 } },
    towerCourseM: 0,
    merlonStuds: 1,
    pinnacleCapPlates: 3,
  },
};

/** The style key for an `era` string. */
export function styleKeyOf(era: string | undefined): StyleKey {
  const e = (era ?? '').toLowerCase();
  if (e.includes('gothic')) return 'gothic';
  if (e.includes('classic') || e.includes('baroque') || e.includes('renaissance')) return 'classical';
  return 'default';
}

/** The opening rule a style gives a feature kind. */
export function openingRule(style: StyleKey, kind: FeatureKind): OpeningRule {
  return STYLE_RULES[style].openings[kind] ?? FLAT;
}
