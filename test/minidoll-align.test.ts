/**
 * The mini-doll (LEGO Friends) slot correction — clego `dbix_figure_align.py`,
 * `DBIX_SOLVER.md` §11, ported in `lxf-parser.ts`.
 *
 * What these pin, in order of what would hurt most if it broke:
 *   1. the four AUTHENTIC joint distances a corrected doll must reproduce
 *      (33.20 head, 11.00 arm, 29.42 hips, 47.48 hips→legs). They are measured
 *      values, not free parameters: a change to the table that moves them is a
 *      regression whatever else it improves;
 *   2. that the MINIFIG rig is untouched — an arm still 17–18 LDU from its
 *      torso, a head still −24 — because the two skeletons share nothing and a
 *      classifier that leaked doll rows into minifig parts would break both;
 *   3. that a part with a REAL `ldraw.xml` or measured row keeps it, so the
 *      third case can only ever fill a hole the two tables leave.
 */

import { describe, it, expect } from 'vitest';
import {
  buildLxfPlacements, composeLxfMiniDoll, miniDollSlotOf, miniDollCorrectionFor,
  isIdentityPartAlign, isIdentityMeasuredAlign, validateTable, validatePartAlign, validateMeasuredAlign,
  normalizeDesignId,
  MINIDOLL_SLOT_CORRECTION,
  type LxfPartRecord, type PartAlign, type MeasuredAlign,
} from '../web/src/engine/lxf-parser.js';
import { classifyMiniDollPart, classifyMinifigPart, MINIFIG_CANON } from '../web/src/engine/minifig-rig.js';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** An unposed LDD bone at `t` (LDD cm) — the shape every figure placement has. */
const boneAt = (t: [number, number, number]): string => `1,0,0,0,1,0,0,0,1,${t[0]},${t[1]},${t[2]}`;

const table = (rows: Record<string, PartAlign>) =>
  validateTable(rows, 'test:part-map', validatePartAlign);
const measuredTable = (rows: Record<string, MeasuredAlign>) =>
  Object.keys(rows).length === 0
    ? { state: 'ok' as const, source: 'test:measured', entries: {}, rejected: 0 }
    : validateTable(rows, 'test:measured', validateMeasuredAlign);

/** Place a doll's parts from bare LDD bones and return them by design id. */
function placeDoll(bones: Record<string, [number, number, number]>, opts?: { miniDoll?: boolean }) {
  const records: LxfPartRecord[] = Object.entries(bones).map(([designID, t]) => ({
    designID, materialId: 1, transformation: boneAt(t), boneCount: 1,
  }));
  const out = buildLxfPlacements(records, table({}), measuredTable({}), opts ?? {});
  const by: Record<string, { x: number; y: number; z: number }> = {};
  records.forEach((r, i) => { by[r.designID] = out.bricks[i]!; });
  return { by, diagnostics: out.diagnostics };
}
const apart = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('classifyMiniDollPart — the slot is the LDraw description', () => {
  it('names each mini-doll family', () => {
    expect(classifyMiniDollPart('92198', 'Figure Friends Head without Pattern')).toBe('doll_head');
    expect(classifyMiniDollPart('92241', 'Figure Friends Girl Torso without Pattern')).toBe('doll_torso');
    expect(classifyMiniDollPart('92244', 'Figure Friends Female Left Arm')).toBe('doll_arm');
    expect(classifyMiniDollPart('92248', 'Figure Friends Hips')).toBe('doll_hips');
    expect(classifyMiniDollPart('59595', 'Figure Friends Legs with Skirt with Ankles')).toBe('doll_leg');
    expect(classifyMiniDollPart('92255', 'Figure Friends Hair Long Straight')).toBe('doll_hair');
    expect(classifyMiniDollPart('87990', 'Mini Doll, Hair Long Wavy')).toBe('doll_hair');
  });

  it('separates the moulds that have NO measured correction', () => {
    // A torso that carries its arms sits 12.8 LDU below the plain torso, and
    // LDD emits a plain torso plus two arms — so it must not inherit the plain
    // torso's row.
    expect(classifyMiniDollPart('92456p03', 'Figure Friends Girl Torso with Arms with Halter Neck Top'))
      .toBe('doll_torso_arms');
    expect(classifyMiniDollPart('92253p02c01', 'Figure Friends Hips and Legs with Trousers')).toBe('doll_hips_legs');
    expect(classifyMiniDollPart('111388', 'Figure Friends Baby Body')).toBe('doll_body');
    for (const slot of ['doll_torso_arms', 'doll_hips_legs', 'doll_body'] as const) {
      expect(MINIDOLL_SLOT_CORRECTION[slot]).toBeUndefined();
    }
  });

  it('keeps the accessories that are NOT the hair out of the hair slot', () => {
    // Measured over the library composites that place both, a decoration sits
    // 11.65 LDU above the hair while LDD puts it at the hair's own height — its
    // origin difference is its own and is not the hair's 2.29 LDU.
    expect(classifyMiniDollPart('96479', 'Figure Friends Hair Decoration Bow with Pin')).toBeNull();
    expect(classifyMiniDollPart('96484', 'Figure Friends Hair Dryer')).toBeNull();
    expect(classifyMiniDollPart('96480', 'Figure Friends Hair Brush with Heart on Reverse')).toBeNull();
    expect(classifyMiniDollPart('93092', 'Figure Friends Basket')).toBeNull();
    expect(classifyMiniDollPart('18854', 'Figure Friends Sunglasses with Pin')).toBeNull();
  });

  it('claims nothing that belongs to a minifig', () => {
    for (const [part, desc] of [
      ['973', 'Minifig Torso'], ['3626c', 'Minifig Head'], ['3818', 'Minifig Arm Right'],
      ['3815', 'Minifig Hips'], ['3816', 'Minifig Leg Right'], ['3901', 'Minifig Hair Male'],
      ['3001', 'Brick  2 x  4'],
    ] as const) {
      expect(classifyMiniDollPart(part, desc)).toBeNull();
    }
  });

  it('a `~Moved to` stub carries no name, so it classifies as nothing', () => {
    expect(classifyMiniDollPart('92241p03c01', '~Moved to 92456p03')).toBeNull();
  });
});

describe('the generated slot table', () => {
  it('names the moulds the LDD corpus actually places', () => {
    const want: Record<string, string> = {
      '92198.dat': 'doll_head', '1006030.dat': 'doll_torso', '1011297.dat': 'doll_torso',
      '92244.dat': 'doll_arm', '92245.dat': 'doll_arm', '2758.dat': 'doll_arm',
      '92248.dat': 'doll_hips', '1015152.dat': 'doll_hips',
      '59595.dat': 'doll_leg', '100937.dat': 'doll_leg', '1023000.dat': 'doll_leg',
      '92250.dat': 'doll_leg', '2645.dat': 'doll_hair',
    };
    for (const [part, slot] of Object.entries(want)) expect([part, miniDollSlotOf(part)]).toEqual([part, slot]);
  });

  it('an unknown PRINT falls back to its mould, an unknown COMPOSITE does not', () => {
    expect(miniDollSlotOf('92198p99.dat')).toBe('doll_head');
    // `…c01` is a different mould (the torso WITH arms), so a print of an
    // unknown composite must not inherit the plain mould's slot.
    expect(miniDollSlotOf('92241p99c01.dat')).toBeNull();
  });

  it('has no row for an ordinary brick', () => {
    for (const p of ['3001.dat', '3626c.dat', '3818.dat', 'parts/973.dat']) {
      expect(miniDollCorrectionFor(p)).toBeNull();
    }
  });
});

describe('the corrected mini-doll reproduces the AUTHENTIC joints', () => {
  // The LDD bones of one unposed doll, in LDD cm: the modal offsets from the
  // torso bone measured over the LXFML corpus (clego §11.2 side B).
  const B = {
    '1006030': [0, 0, 0] as [number, number, number],                      // torso
    '92198': [0, 50.05 / 25, -1.56 / -25] as [number, number, number],     // head, 50.05 LDU above
    '92244': [-11 / 25, 16.83 / 25, 0.78 / -25] as [number, number, number], // left arm
    '92245': [11 / 25, 16.83 / 25, 0.78 / -25] as [number, number, number],  // right arm
    '92248': [-0.01 / 25, 0.02 / 25, -2.31 / -25] as [number, number, number], // hips: the torso's own bone
    '59595': [-10.01 / 25, -57.71 / 25, -2.18 / -25] as [number, number, number], // legs
  };

  it('is broken without the correction: hips on the torso, head at 50, arms at 20', () => {
    // The pre-fix distances clego measured over the affected corpus (§11.3):
    // the hips sits ON the torso (2.31 against an authentic 29.42).
    const { by, diagnostics } = placeDoll(B, { miniDoll: false });
    expect(diagnostics.miniDollPlacements).toBe(0);
    expect(apart(by['1006030']!, by['92248']!)).toBeCloseTo(2.31, 1);
    expect(apart(by['1006030']!, by['92198']!)).toBeCloseTo(50.07, 1);
    expect(apart(by['1006030']!, by['92244']!)).toBeCloseTo(20.13, 1);
    expect(apart(by['92248']!, by['59595']!)).toBeCloseTo(58.59, 1);
  });

  it('with the correction the four joints are the authentic ones', () => {
    const { by, diagnostics } = placeDoll(B);
    expect(diagnostics.miniDollPlacements).toBe(6);
    expect(diagnostics.miniDollDeferredToTable).toBe(0);
    expect(apart(by['1006030']!, by['92198']!)).toBeCloseTo(33.20, 1);  // torso → head
    expect(apart(by['1006030']!, by['92244']!)).toBeCloseTo(11.00, 1);  // torso → arm
    expect(apart(by['1006030']!, by['92245']!)).toBeCloseTo(11.00, 1);
    expect(apart(by['1006030']!, by['92248']!)).toBeCloseTo(29.42, 1);  // torso → hips
    expect(apart(by['92248']!, by['59595']!)).toBeCloseTo(47.48, 1);    // hips → legs
  });

  it('the arms stay MIRRORED about the torso (both libraries put them at ±11)', () => {
    const { by } = placeDoll(B);
    expect(by['92244']!.x - by['1006030']!.x).toBeCloseTo(-(by['92245']!.x - by['1006030']!.x), 3);
  });

  it('every row is the one clego measured', () => {
    expect(MINIDOLL_SLOT_CORRECTION).toEqual({
      doll_leg: [10.01, 0.00, 0.00],
      doll_torso: [0.00, -19.09, 1.72],
      doll_hips: [0.01, 10.33, 2.83],
      doll_arm: [0.00, -2.26, 0.94],
      doll_head: [0.00, -2.24, 3.28],
      doll_hair: [0.00, -2.29, 0.28],
    });
  });
});

describe('composeLxfMiniDoll', () => {
  it('leaves the rotation alone — the defect is the ORIGIN, not the pose', () => {
    const RZ90 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    const p = composeLxfMiniDoll(RZ90, [0, 0, 0], [0, 0, 0]);
    // F·Rz90·F, exactly what an uncorrected part gets.
    [0, 1, 0, -1, 0, 0, 0, 0, 1].forEach((want, i) => expect(p.rot[i]).toBeCloseTo(want, 12));
  });

  it('adds e in the flipped frame, rotated by the flipped bone', () => {
    const RZ90 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    const p = composeLxfMiniDoll(RZ90, [0, 0, 0], [10, 0, 0]);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(-10);
    expect(p.z).toBeCloseTo(0);
  });
});

describe('precedence: the slot rule only fills a hole', () => {
  const dollLeg: [number, number, number] = [0, 0, 0];
  const records: LxfPartRecord[] = [{ designID: '21630', materialId: 1, transformation: boneAt(dollLeg), boneCount: 1 }];

  it('uses the ldraw.xml FILENAME and the slot correction when the row is all-zero', () => {
    // `21630 → 92250.dat` is the one shipped doll row shape: a real filename
    // with an identity correction, which is the bug this rule fixes.
    const t = table({ '21630': ['92250.dat', 0, 0, 0, 0, 1, 0, 0] });
    const out = buildLxfPlacements(records, t, measuredTable({}));
    expect(out.bricks[0]!.part).toBe('92250.dat');
    expect(out.diagnostics.mappedPlacements).toBe(1);
    expect(out.diagnostics.miniDollPlacements).toBe(1);
    expect(out.bricks[0]!.x).toBeCloseTo(10.01); // the doll_leg row
  });

  it('DEFERS to a real ldraw.xml row, and says so', () => {
    const t = table({ '21630': ['92250.dat', 0.4, 0, 0, 0, 1, 0, 0] });
    const out = buildLxfPlacements(records, t, measuredTable({}));
    expect(out.diagnostics.miniDollPlacements).toBe(0);
    expect(out.diagnostics.miniDollDeferredToTable).toBe(1);
    expect(out.bricks[0]!.x).toBeCloseTo(-10); // Studio's row, applied as its inverse
  });

  it('DEFERS to a real measured row when the measured row is what placed it', () => {
    const m: MeasuredAlign = ['92250.dat', 1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0, 40];
    const out = buildLxfPlacements(records, table({}), measuredTable({ '21630': m }));
    expect(out.diagnostics.miniDollPlacements).toBe(0);
    expect(out.diagnostics.miniDollDeferredToTable).toBe(1);
    expect(out.bricks[0]!.x).toBeCloseTo(5);
  });

  it('ignores a measured row the ldraw.xml row outranks', () => {
    // The identity test is on the row that ACTUALLY placed the part. A design
    // with an identity `ldraw.xml` row (which wins) and a stale measured row
    // (which nothing applies) must still get the slot correction — testing both
    // rows deferred 13 corpus placements to a row the loader never reads.
    const t = table({ '21630': ['92250.dat', 0, 0, 0, 0, 1, 0, 0] });
    const m: MeasuredAlign = ['92250.dat', 0, 0, -1, 0, 1, 0, 1, 0, 0, 967, 0, -470, 3];
    const out = buildLxfPlacements(records, t, measuredTable({ '21630': m }));
    expect(out.diagnostics.miniDollPlacements).toBe(1);
    expect(out.diagnostics.miniDollDeferredToTable).toBe(0);
    expect(out.bricks[0]!.x).toBeCloseTo(10.01); // the doll_leg row, not 967 LDU away
  });

  it('identity detection: no row, a zero row and an identity rotation all count', () => {
    expect(isIdentityPartAlign(undefined)).toBe(true);
    expect(isIdentityPartAlign(['p.dat', 0, 0, 0, 0, 1, 0, 0])).toBe(true);
    expect(isIdentityPartAlign(['p.dat', 0, 0, 0, Math.PI / 2, 0, 1, 0])).toBe(false);
    expect(isIdentityPartAlign(['p.dat', 0.4, 0, 0, 0, 1, 0, 0])).toBe(false);
    expect(isIdentityMeasuredAlign(undefined)).toBe(true);
    expect(isIdentityMeasuredAlign(['p.dat', 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 9])).toBe(true);
    expect(isIdentityMeasuredAlign(['p.dat', 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 8, 0, 9])).toBe(false);
    expect(isIdentityMeasuredAlign(['p.dat', 0, -1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 9])).toBe(false);
  });

  it('leaves an ordinary brick exactly where it was', () => {
    const brick: LxfPartRecord[] = [{ designID: '3001', materialId: 1, transformation: boneAt([1, 2, 3]), boneCount: 1 }];
    const t = table({ '3001': ['3001.dat', 0, 0.4, 0, 0, 1, 0, 0] });
    const withDoll = buildLxfPlacements(brick, t, measuredTable({}));
    const without = buildLxfPlacements(brick, t, measuredTable({}), { miniDoll: false });
    expect(withDoll.bricks).toEqual(without.bricks);
    expect(withDoll.diagnostics.miniDollPlacements).toBe(0);
  });
});

describe('the MINIFIG rig is untouched', () => {
  it('still classifies the minifig body parts it always did', () => {
    expect(classifyMinifigPart('973', 'Minifig Torso')).toBe('torso');
    expect(classifyMinifigPart('3626c', 'Minifig Head')).toBe('head');
    expect(classifyMinifigPart('3818', 'Minifig Arm Right')).toBe('arm_right');
    expect(classifyMinifigPart('3819', 'Minifig Arm Left')).toBe('arm_left');
    expect(classifyMinifigPart('3815', 'Minifig Hips')).toBe('hips');
    expect(classifyMinifigPart('981', '~Moved to 3818')).toBe('arm_right');
  });

  it('keeps the canonical minifig offsets — arms 17–18 LDU out, head −24', () => {
    const d = (p: readonly [number, number, number]): number => Math.hypot(p[0], p[1], p[2]);
    expect(d(MINIFIG_CANON.arm_right.position)).toBeGreaterThan(17);
    expect(d(MINIFIG_CANON.arm_right.position)).toBeLessThan(18);
    expect(d(MINIFIG_CANON.arm_left.position)).toBeCloseTo(d(MINIFIG_CANON.arm_right.position), 6);
    expect(MINIFIG_CANON.head.position).toEqual([0, -24, 0]);
    expect(MINIFIG_CANON.hips.position).toEqual([0, 32, 0]);
  });

  it('none of the minifig numbers leaked into the doll table', () => {
    // The two skeletons share nothing: 24/18/32 against 33.20/11.00/29.42.
    const ys = Object.values(MINIDOLL_SLOT_CORRECTION).map(e => Math.abs(e[1]));
    for (const forbidden of [24, 18, 32, 44]) expect(ys).not.toContain(forbidden);
  });
});

describe('normalizeDesignId — LDD mould-variant suffixes', () => {
  it('drops the `;<variant>` LDD writes in its own LXFML dumps', () => {
    // 4,111 of 41732's ids carry one. Before this, the id went to the tables
    // and to the library verbatim, so every part of such a file resolved to
    // nothing: "37 pieces of 13 part types not in library", 0×0 studs, and the
    // mini-doll rule could never fire on the only files that HAVE dolls.
    expect(normalizeDesignId('1006030;I')).toBe('1006030');
    expect(normalizeDesignId('59595;l')).toBe('59595');
    expect(normalizeDesignId('3001')).toBe('3001');
  });

  it('falls back when the attribute is missing or empty', () => {
    expect(normalizeDesignId(null)).toBe('3001');
    expect(normalizeDesignId('')).toBe('3001');
    expect(normalizeDesignId(' ; ', '973')).toBe('973');
    expect(normalizeDesignId(undefined, '973')).toBe('973');
  });
});
