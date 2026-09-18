/**
 * Arm-placement and isolation analysis for a verification round.
 *
 * Reads each set's `<set>-positions.json` (world translations + part ids, in
 * scene units where 1 unit = 20 LDU) and `<set>-probe.json`, then:
 *   - de-duplicates placements. The probe dumps EVERY InstancedMesh, and a
 *     multi-coloured part emits several meshes over the SAME matrices, so the
 *     raw row count over-counts placements. Identical (part, x, y, z) tuples
 *     can only be the same physical placement re-emitted.
 *   - runs the minifig arm check: for each arm instance, the distance in LDU to
 *     the nearest torso instance. An authentic arm sits 17-18 LDU from its
 *     torso origin.
 *
 * node scripts/_verify-sets-analyze.mjs <outDir> [set...]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';


const LDRAW = 'C:/git/clego/extracted/studio_release/app/ldraw';
const LDU_PER_UNIT = 20;

const DEFAULT_SETS = ['910047', '910004', '10303', '10326', '76419', '71043', '76435',
  '21061', '21063', '60446', '10341', '10337', '42172', '76286', '31141',
  '11371', '21318', '910032'];

// Same CLI shape as the batch driver that produced the input.
const [, , rootArg, ...setArgs] = process.argv;
const ROOT = rootArg ?? 'output/verify-sets';
const SETS = setArgs.length > 0 ? setArgs : DEFAULT_SETS;

/**
 * LDraw ids that ARE human minifig arms, independent of a description lookup.
 * 981/982 are "~Moved to" alias stubs for 3819/3818; 16000/16001 are the
 * dual-moulded variants. These are the arms the "detached arm" defect is about.
 */
const ARM_IDS = new Set(['3818', '3819', '3818a', '3818b', '3818c01', '3819a',
  '3819b', '3819c01', '981', '982', '16000', '16001']);
/**
 * `Minifig Mechanical Arm` (59230, 98313, 53989, 76116) is counted SEPARATELY:
 * it is a skeleton/droid arm that mates with the mechanical torso 30375, and
 * builders also use it as a plain detail element with no figure anywhere near
 * (21061 Notre-Dame: 30 of them, zero torsos). Folding it into the arm metric
 * manufactures detached-arm "defects" out of ordinary decorative usage.
 */
const MECH_ARM_RE = /minifig\s+mechanical\s+arm/i;
/**
 * Torsos only. 3814/3815 are NOT torsos despite sitting in the same id
 * neighbourhood — 3815 is "Minifig Hips" and 3814 is "MINI UPPER PART (Needs
 * Work)". Admitting hips as a torso can only SHORTEN a nearest-torso distance,
 * which would mask exactly the defect being looked for.
 */
// `(^|_)` because BrickLink-derived composites arrive as `bl_973pb6424c01_3814_0`
// — anchoring on `^973` alone scored three correctly-placed 11371 arms as
// 94 and 306 LDU strays purely because their torso's id carried a `bl_` prefix.
const TORSO_RE = /(^|_)973/;
const MECH_TORSO_IDS = new Set(['30375']);

/** First `0 <description>` line of a part file, or null. */
const descCache = new Map();
const partDesc = id => {
  if (descCache.has(id)) return descCache.get(id);
  let d = null;
  for (const rel of [`parts/${id}.dat`, `UnOfficial/parts/${id}.dat`, `LEGO/${id}.dat`]) {
    const p = join(LDRAW, rel);
    if (!existsSync(p)) continue;
    const first = readFileSync(p, 'latin1').split(/\r?\n/, 1)[0] ?? '';
    const m = /^\s*0\s+(.*)$/.exec(first);
    if (m) { d = m[1].trim(); break; }
  }
  descCache.set(id, d);
  return d;
};

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

const summary = [];
for (const set of SETS) {
  const dir = join(ROOT, set);
  const posFile = join(dir, `${set}-positions.json`);
  const probeFile = join(dir, `${set}-probe.json`);
  const stdoutFile = join(dir, 'stdout.json');

  const rec = { set, loadOk: false, rawRows: 0, placements: 0 };
  if (!existsSync(posFile)) {
    rec.failure = existsSync(join(dir, 'stderr.txt'))
      ? readFileSync(join(dir, 'stderr.txt'), 'utf8').trim().slice(0, 400)
      : 'no positions dump produced';
    rec.captures = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.png')) : [];
    summary.push(rec);
    continue;
  }

  const rows = JSON.parse(readFileSync(posFile, 'utf8'));
  rec.rawRows = rows.length;
  const seen = new Set();
  const placements = [];
  for (const [part, x, y, z] of rows) {
    const k = `${part}|${x}|${y}|${z}`;
    if (seen.has(k)) continue;
    seen.add(k);
    placements.push([part, x, y, z]);
  }
  rec.placements = placements.length;
  rec.loadOk = placements.length > 0;

  const probe = existsSync(probeFile) ? JSON.parse(readFileSync(probeFile, 'utf8')) : {};
  rec.meshes = probe.meshes ?? null;
  rec.missingParts = probe.missingParts ?? null;
  rec.status = (probe.status ?? '').replace(/\s+/g, ' ').trim().slice(-160) || null;
  rec.explodeZeroMaxDelta = probe.explodeZeroMaxDelta ?? null;
  rec.returnToZeroMaxDelta = probe.returnToZeroMaxDelta ?? null;

  if (existsSync(stdoutFile)) {
    try {
      const out = JSON.parse(readFileSync(stdoutFile, 'utf8'));
      const errs = out.errors ?? [];
      const uniq = [...new Set(errs.map(e => e.replace(/\d{3,}/g, 'N').slice(0, 120)))];
      rec.consoleErrorCount = errs.length;
      rec.consoleErrorKinds = uniq.slice(0, 4);
    } catch { rec.consoleErrorKinds = ['stdout unparsable']; }
  }

  // ---- isolation screen (the FLOATING defect class) ----------------------
  // Nearest-neighbour distance per placement via a uniform spatial hash. A
  // brick in contact with its neighbours has a neighbour within a stud or two;
  // anything whose NEAREST neighbour is many studs away is detached from the
  // model. This is a screen, not a verdict — an intentionally separate
  // sub-build (a spare minifig, a loose accessory) reads the same way, so the
  // montages remain the arbiter.
  {
    const CELL = 4; // studs
    const grid = new Map();
    const keyOf = (x, y, z) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
    placements.forEach((p, i) => {
      const k = keyOf(p[1], p[2], p[3]);
      let b = grid.get(k); if (!b) grid.set(k, b = []); b.push(i);
    });
    const nn = [];
    for (let i = 0; i < placements.length; i++) {
      const [, x, y, z] = placements[i];
      let best = Infinity;
      // Widen the ring until a neighbour is found or the model is exhausted.
      for (let r = 1; r <= 12 && !(best < (r - 1) * CELL); r++) {
        const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r - 1 && r > 1) continue;
          const b = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!b) continue;
          for (const j of b) {
            if (j === i) continue;
            const q = placements[j];
            const d = (x - q[1]) ** 2 + (y - q[2]) ** 2 + (z - q[3]) ** 2;
            if (d < best) best = d;
          }
        }
      }
      nn.push(Math.sqrt(best));
    }
    const isolated = nn
      .map((d, i) => [d, placements[i]])
      .filter(([d]) => d > 6 && Number.isFinite(d))
      .sort((a, b) => b[0] - a[0]);
    rec.isolatedOver6Studs = isolated.length;
    rec.isolatedWorst = isolated.slice(0, 6)
      .map(([d, p]) => ({ part: p[0], nnStuds: +d.toFixed(1), at: [p[1], p[2], p[3]] }));
  }

  // ---- minifig arm check -------------------------------------------------
  const ids = [...new Set(placements.map(p => p[0]))];
  const descs = Object.fromEntries(ids.map(i => [i, partDesc(i)]));
  const isArm = id => ARM_IDS.has(id) || /^minifig\s+arm\b/i.test(descs[id] ?? '');
  const isMechArm = id => MECH_ARM_RE.test(descs[id] ?? '');
  const isTorso = id => TORSO_RE.test(id) || /^minifig\s+torso\b/i.test(descs[id] ?? '');
  const isAnyTorso = id => isTorso(id) || MECH_TORSO_IDS.has(id)
    || /minifig\s+mechanical\s+torso/i.test(descs[id] ?? '');
  /** Every part whose description mentions an arm at all — the widest net. */
  const isArmBroad = id => isArm(id) || isMechArm(id) || /\barm\b/i.test(descs[id] ?? '');

  const arms = placements.filter(p => isArm(p[0]));
  const mechArms = placements.filter(p => isMechArm(p[0]));
  const armsBroad = placements.filter(p => isArmBroad(p[0]));
  const torsos = placements.filter(p => isTorso(p[0]));
  const allTorsos = placements.filter(p => isAnyTorso(p[0]));

  rec.armCount = arms.length;
  rec.mechArmCount = mechArms.length;
  rec.armCountBroadDescMatch = armsBroad.length;
  rec.torsoCount = torsos.length;
  rec.armPartIds = [...new Set(arms.map(p => p[0]))];
  rec.mechArmPartIds = [...new Set(mechArms.map(p => p[0]))];
  rec.torsoPartIds = [...new Set(torsos.map(p => p[0]))].slice(0, 12);

  /** Nearest-torso distance, in LDU, for every arm placement. */
  const distsTo = (armSet, torsoSet) => armSet.map(([, ax, ay, az]) => {
    let best = Infinity;
    for (const [, tx, ty, tz] of torsoSet) {
      const d = (ax - tx) ** 2 + (ay - ty) ** 2 + (az - tz) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best) * LDU_PER_UNIT;
  });

  if (!arms.length || !torsos.length) {
    rec.armCheck = arms.length
      ? `${arms.length} arm(s) but 0 torsos — cannot measure`
      : (mechArms.length
        ? `no human minifigures (${mechArms.length} mechanical-arm parts used as detail)`
        : 'no minifigures in this set');
    rec.armMedianLdu = null;
    rec.armFracInBand = null;
  } else {
    const dists = distsTo(arms, torsos);
    const inBand = dists.filter(d => d >= 14 && d <= 21).length;
    rec.armMedianLdu = +median(dists).toFixed(2);
    rec.armMinLdu = +Math.min(...dists).toFixed(2);
    rec.armMaxLdu = +Math.max(...dists).toFixed(2);
    rec.armFracInBand = +(inBand / dists.length).toFixed(3);
    rec.armInBandCount = inBand;
    rec.armOutliersLdu = dists.filter(d => d < 14 || d > 21).map(d => +d.toFixed(2))
      .sort((a, b) => a - b);
    rec.armDistancesLdu = dists.map(d => +d.toFixed(2)).sort((a, b) => a - b);
    rec.armCheck = 'measured';
  }

  if (mechArms.length && allTorsos.length) {
    const md = distsTo(mechArms, allTorsos);
    rec.mechArmMedianLdu = +median(md).toFixed(2);
    rec.mechArmFracInBand = +(md.filter(d => d >= 14 && d <= 21).length / md.length).toFixed(3);
  }
  summary.push(rec);
}

writeFileSync(join(ROOT, 'summary.json'), JSON.stringify(summary, null, 1));

// Compact console table for the report.
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('set', 9) + pad('placem.', 9) + pad('ok', 4) + pad('arms', 6)
  + pad('torsos', 8) + pad('medLDU', 9) + pad('%band', 7) + pad('isol>6st', 9)
  + pad('missing', 9) + 'errs');
for (const r of summary) {
  console.log(pad(r.set, 9) + pad(r.placements, 9) + pad(r.loadOk ? 'Y' : 'N', 4)
    + pad(r.armCount ?? '-', 6) + pad(r.torsoCount ?? '-', 8)
    + pad(r.armMedianLdu ?? '-', 9)
    + pad(r.armFracInBand == null ? '-' : Math.round(r.armFracInBand * 100) + '%', 7)
    + pad(r.isolatedOver6Studs ?? '-', 9)
    + pad(r.missingParts ?? '-', 9)
    + (r.consoleErrorCount ?? '-'));
}
