#!/usr/bin/env node
/**
 * Repeatable visual + geometric fixtures for the LEGO tab (audit P2, "add
 * focused visual fixtures"). Drives the REAL app in headless Chrome, loads each
 * fixture through the production search → indexed-source path, pins what can be
 * measured, and captures fixed cameras for review.
 *
 * WHY IT IS NOT A SCORE. The audit is explicit: "targeted gap/transform
 * assertions plus reviewed images rather than a single subjective score." Every
 * assertion here is a number with a stated meaning, and the images exist to be
 * LOOKED AT — nothing in this script claims a render is correct.
 *
 * What each fixture pins:
 *   • the SOURCE — index path + sha256/12 `hash`. If the corpus moves, the
 *     fixture FAILS loudly and must be re-baselined; it does not quietly pass
 *     against different bytes.
 *   • the CAMERA — fixed named views plus close-ups derived from the model's own
 *     measured bounding box, so the same model always frames the same way.
 *   • the STATE — explode 0, all layers/steps visible, autorotate off.
 *   • the TRANSFORMS — live instance matrices vs the saved assembled matrices,
 *     at explode 0 and after a 0 → 100 → 0 round trip.
 *   • per-fixture GEOMETRY assertions (below), each tied to a measured defect.
 *
 * Manual gate, not CI: it needs Chrome and the dev server (which needs the local
 * clego corpus). See CLAUDE.md "Visual fixtures".
 *
 *   bun dev:web                    # in another shell, port 4000
 *   node scripts/lego-visual-fixtures.mjs [--only NAME] [--out DIR]
 *
 * Exit code 0 = every assertion held. Non-zero = at least one did not; the
 * summary names which. Output: output/visual-fixtures/<date>/.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DEV = process.env.DEV_URL ?? 'http://localhost:4000';
const ONLY = flag('--only', null);
const DAY = new Date().toISOString().slice(0, 10);
const OUT = flag('--out', join('output', 'visual-fixtures', DAY));

/**
 * Fixtures. `source` is the index entry the auto-loader is EXPECTED to pick;
 * `expect` is a list of {name, ok(m), got(m)} predicates over the measurement
 * bundle, so a failure reports the number that moved, not just "failed".
 */
const FIXTURES = [
  {
    name: '10316-rivendell',
    setNum: '10316-1',
    indexKey: '10316',
    why: 'the reported floating-elf-hair defect; MB_ALIGN v5 seats worn headgear on its head',
    source: { path: 'MecabricksLDR/10316.ldr', hash: 'cce43c4b614e' },
    closeups: ['headgear'],
    contactCheck: false, // 6.3k microscale pieces — minutes, and not what this fixture is about
    expect: [
      { name: 'placements rendered', ok: m => m.placements >= 6260, got: m => `${m.placements} placements / ${m.instances} instances` },
      { name: 'no substituted moulds', ok: m => m.substituted === 0, got: m => m.substituted },
      // The three genuinely unmodelled moulds documented in the audit:
      // 20926/20932 (dual-moulded "2K" minifig legs — LDraw has only the
      // obsolete single legs, at a DIFFERENT origin) and 1000341 (a
      // Mecabricks-internal sword-blade id). A misplaced piece is worse than a
      // hole, so these stay missing on purpose; a FOURTH would be a regression.
      { name: 'only the 3 documented unmodelled moulds are missing', ok: m => m.missing === 3, got: m => m.missingParts.map(p => p.part).join(',') || '(none)' },
      // The FIX, as a number: LDraw seats a headgear part at its head's own
      // origin, so a worn piece and its head coincide. Before MB_ALIGN v5 the
      // 17 worn pieces sat 18.0–60.5 LDU above their heads, i.e. ZERO of them
      // coincided. This is the assertion that would catch a regression.
      { name: 'worn headgear seated on its head (<=1 LDU)', ok: m => m.headgear.seated >= 17, got: m => `${m.headgear.seated} of ${m.headgear.candidates} candidates` },
      { name: 'nothing stranded above a head on its own axis', ok: m => m.headgear.stranded === 0, got: m => `${m.headgear.stranded}${m.headgear.worst.length ? ' — ' + JSON.stringify(m.headgear.worst.slice(0, 3)) : ''}` },
    ],
  },
  {
    name: '71043-hogwarts',
    setNum: '71043-1',
    indexKey: '71043',
    why: 'the reported separated-pieces defect; native .lxf with the measured alignment table + FRAME_SIGN fix',
    source: { path: 'LXF/71043_hogwarts_castle.lxf', hash: '479bdba847f9' },
    closeups: ['lower', 'upper'],
    // OFF for this one: the contact check is documented to under-count exactly
    // this class (microscale/SNOT, 71043 by name), so the number would be noise
    // — and voxelising 5,967 surfaces costs minutes. The controls carry it.
    contactCheck: false,
    expect: [
      { name: 'placements rendered', ok: m => m.placements === 5967, got: m => `${m.placements} placements / ${m.instances} instances` },
      { name: 'no missing part types', ok: m => m.missing === 0, got: m => m.missingParts.map(p => p.part).join(',') || '(none)' },
      // Explode is EXONERATED (audit P0 #2) and must stay that way: at slider 0
      // the live matrices must be the saved assembled ones, before and after a
      // full round trip. Tolerance is float32 storage noise.
      { name: 'assembled transforms restored after 0→100→0', ok: m => m.returnToZeroMaxDelta < 1e-3, got: m => m.returnToZeroMaxDelta },
    ],
  },
  {
    name: '10182-cafe-corner-omr',
    setNum: '10182-1',
    indexKey: '10182',
    why: 'simple official OMR control — authentic LDraw source, near-axis-aligned build, so any defect here is ours',
    source: { path: 'OMR/10182-1.mpd', hash: '5961e9f58822' },
    closeups: [],
    contactCheck: true,
    expect: [
      { name: 'placements rendered', ok: m => m.placements === 2417, got: m => `${m.placements} placements / ${m.instances} instances` },
      { name: 'no missing part types', ok: m => m.missing === 0, got: m => m.missing },
      // PRISTINE state, before any explode call touches the matrices: this is
      // pure float32 storage quantisation of the float64 assembled matrices.
      { name: 'assembled transforms intact at explode 0', ok: m => m.explodeZeroMaxDelta < 1e-4, got: m => m.explodeZeroMaxDelta },
      // Return-to-zero is a LOOSER bound on purpose, and the reason is measured:
      // setExplodeFactor round-trips each matrix through decompose()/compose(),
      // which is exact only for translation+rotation+scale. LDraw permits
      // sheared placements, and this file contains some — worst part 3818, 1.19e-3
      // scene units ≈ 0.024 LDU. Sub-visible, but it is NOT float noise, so
      // asserting the pristine tolerance here would be asserting a falsehood.
      { name: 'assembled transforms restored after 0→100→0', ok: m => m.returnToZeroMaxDelta < 5e-3, got: m => `${m.returnToZeroMaxDelta} (worst part ${m.returnToZeroWorstPart})` },
      // The rotation profile as a pinned BASELINE, not a claim about the model.
      // A change in how rotations are composed moves this number; an absolute
      // threshold would only encode a guess (the first draft asserted "<0.10"
      // for a modular building and measured 0.31).
      { name: 'rotation profile matches baseline 0.307', ok: m => Math.abs(m.rotatedFraction - 0.307) < 0.03, got: m => m.rotatedFraction },
    ],
  },
  {
    name: '21309-saturn-v-rotated',
    setNum: '21309-1',
    indexKey: '21309',
    why: 'rotated/SNOT control — a radial rocket build exercises non-axis-aligned placement, which is where a basis or ordering error shows first',
    source: { path: 'OMR/21309-1.mpd', hash: 'eb5699526520' },
    closeups: [],
    contactCheck: true,
    expect: [
      { name: 'placements rendered', ok: m => m.placements === 1845, got: m => `${m.placements} placements / ${m.instances} instances` },
      { name: 'no missing part types', ok: m => m.missing === 0, got: m => m.missing },
      { name: 'assembled transforms restored after 0→100→0', ok: m => m.returnToZeroMaxDelta < 1e-3, got: m => m.returnToZeroMaxDelta },
      // Premise AND baseline: this control must keep exercising rotated
      // placement, and the fraction is pinned so a change in rotation handling
      // moves it. Measured 0.390 against 10182's 0.307.
      { name: 'rotation profile matches baseline 0.390', ok: m => Math.abs(m.rotatedFraction - 0.390) < 0.03, got: m => m.rotatedFraction },
    ],
  },
];

// ─── Browser harness ─────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const summary = { generated: new Date().toISOString(), dev: DEV, fixtures: [] };
let failures = 0;

for (const fx of FIXTURES) {
  if (ONLY && fx.name !== ONLY) continue;
  process.stdout.write(`\n── ${fx.name} (${fx.setNum}) ──\n`);
  const result = await runFixture(fx);
  summary.fixtures.push(result);
  failures += result.failed.length;
  writeFileSync(join(OUT, `${fx.name}.json`), JSON.stringify(result, null, 1));
  for (const f of result.failed) console.log(`  FAIL ${f.name}: ${f.got}`);
  for (const p of result.passed) console.log(`  ok   ${p.name}: ${p.got}`);
}

writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
await browser.close();
console.log(`\n${failures ? `${failures} assertion(s) FAILED` : 'all assertions held'} — ${OUT}`);
process.exit(failures ? 1 : 0);

// ─── One fixture ─────────────────────────────────────────────────────────────

async function runFixture(fx) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => errors.push(`pageerror: ${String(e).slice(0, 300)}`));

  const out = { fixture: fx.name, setNum: fx.setNum, why: fx.why, passed: [], failed: [], errors: [] };

  try {
    await openLegoTab(page);
    // The source the fixture pins, checked against the LIVE index before the
    // model loads: a corpus change must re-baseline the fixture, not slip
    // through it.
    const idxEntry = await page.evaluate(async key => {
      const r = await fetch('/lego-models-index.json');
      const j = await r.json();
      return { schema: j.schema ?? 1, generated: j.generated, models: j.sets[key]?.models ?? null };
    }, fx.indexKey);
    out.index = { schema: idxEntry.schema, generated: idxEntry.generated };
    const primary = idxEntry.models?.[0] ?? null;
    out.source = { pinned: fx.source, actual: primary ? { path: primary.path, hash: primary.hash ?? null } : null };
    record(out, 'index source matches the pinned path',
      primary?.path === fx.source.path, primary?.path ?? '(not indexed)');
    record(out, 'index source matches the pinned content hash',
      primary?.hash === fx.source.hash, primary?.hash ?? '(no hash)');

    await selectSet(page, fx.setNum);
    const bricks = await waitForRender(page);
    if (!bricks) throw new Error('model never finished rendering');

    const m = await measure(page, fx);
    out.measurements = m;
    for (const e of fx.expect) record(out, e.name, !!e.ok(m), String(e.got(m)));

    if (fx.contactCheck) {
      out.contact = await page.evaluate(() => window.__ldrawViewer.auditConnectivity(4)
        .then(r => ({
          pieces: r.pieces, components: r.components, largestPct: +r.largestPct.toFixed(2),
          detached: r.detached, airborneDetached: r.airborneDetached,
          groundedDetached: r.groundedDetached, piecesWithoutGeometry: r.piecesWithoutGeometry,
          piecesWithSnaps: r.piecesWithSnaps, snapOnlyUnions: r.snapOnlyUnions,
          resolutionLDU: r.resolutionLDU, toleranceLDU: r.toleranceLDU,
        })));
      // RECORDED, NOT ASSERTED. The contact check finds surface-contact
      // candidates and is blind to clip/bar/pin grips, so a number here is a
      // trend line for review, never a pass/fail on assembly correctness.
      console.log(`  (contact candidates: ${out.contact.largestPct}% largest, ${out.contact.airborneDetached} airborne groups — recorded, not asserted)`);
    }

    await capture(page, fx, m, out);
  } catch (err) {
    out.failed.push({ name: 'fixture ran to completion', got: String(err).slice(0, 300) });
  }
  out.errors = errors.slice(0, 10);
  await page.close();
  return out;
}

function record(out, name, ok, got) {
  (ok ? out.passed : out.failed).push({ name, got });
}

async function openLegoTab(page) {
  await page.goto(`${DEV}/#lego`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'LEGO')?.click();
  });
  await page.waitForTimeout(1200);
  // Stats overlay forces CONTINUOUS rendering. On-demand rendering plus a
  // backgrounded automation tab otherwise leaves the canvas without a fresh
  // frame and every screenshot times out (CLAUDE.md, browser-automation caveats).
  await page.evaluate(() => {
    const cb = document.getElementById('lego-stats');
    if (cb && !cb.checked) cb.click();
  });
}

/** Click the card whose set number is EXACTLY this one (no regex surprises). */
async function selectSet(page, setNum) {
  const hit = await page.evaluate(async set => {
    const input = document.getElementById('lego-search');
    input.value = set;
    document.getElementById('lego-search-btn').click();
    await new Promise(r => setTimeout(r, 2500));
    const card = [...document.querySelectorAll('.lego-result-card')]
      .find(c => c.querySelector('.lego-result-num')?.textContent.trim() === set);
    if (!card) return 'no-card';
    card.click();
    return 'clicked';
  }, setNum);
  if (hit !== 'clicked') throw new Error(`search did not surface a card for ${setNum}`);
}

async function waitForRender(page) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const n = await page.evaluate(() => {
      const v = window.__ldrawViewer;
      if (!v || !v.loaded) return 0;
      let n = 0;
      for (const s of v.stepGroups.values()) {
        s.group.traverse(o => { if (o.isInstancedMesh && !o.userData.mirrorOf) n += (o.userData.originalMatrices?.length ?? 0); });
      }
      return n;
    });
    const settled = n > 0 && await page.evaluate(() =>
      /bricks rendered/.test(document.getElementById('lego-status')?.textContent ?? '')
      && !(window.__ldrawViewer?.warp?.running));
    if (settled) { await page.waitForTimeout(2500); return n; }
    await page.waitForTimeout(2000);
  }
  return 0;
}

/** Everything measurable about the loaded model, in one page evaluation. */
function measure(page, fx) {
  return page.evaluate(() => {
    const v = window.__ldrawViewer;

    /** Every live instance as {part, pos, rot(3x3 columns)}. */
    const each = fn => {
      for (const s of v.stepGroups.values()) {
        s.group.traverse(o => {
          if (!o.isInstancedMesh || o.userData.mirrorOf) return;
          const a = o.instanceMatrix.array;
          const cnt = o.userData.originalMatrices?.length ?? 0;
          for (let i = 0; i < cnt; i++) fn(o, a, i * 16);
        });
      }
    };

    const diffToOriginals = () => {
      let max = 0, n = 0, placements = 0, worst = null;
      each((o, a, b) => {
        const want = o.userData.originalMatrices[b / 16].elements;
        let local = 0;
        for (let k = 0; k < 16; k++) {
          const d = Math.abs(a[b + k] - want[k]);
          if (d > local) local = d;
        }
        if (local > max) { max = local; worst = o.userData.partName ?? '?'; }
        n++;
        if (o.userData.primary) placements++;
      });
      return { max, n, placements, worst };
    };

    // ── State the fixture pins: all layers/steps, explode 0, no autorotate ──
    v.setAutoRotate(false);
    const maxSlider = v.getSliderMode() === 'layer' ? v.getMaxAvailableLayer() : v.getMaxAvailableStep();
    v.setMaxStep(maxSlider);

    // PRISTINE first: the matrices exactly as load() wrote them, before any
    // explode call touches them. Measuring after a setExplodeFactor(0) would
    // hide the round-trip's own error, which is the thing under test.
    const at0 = diffToOriginals();
    v.setExplodeFactor(1.0);
    const at100 = diffToOriginals();
    v.setExplodeFactor(0);
    const back0 = diffToOriginals();

    // ── Bounding box + rotation profile from the live matrices ──────────────
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const ys = [];
    let rotated = 0, total = 0;
    const heads = [], others = [];
    each((o, a, b) => {
      const p = [a[b + 12], a[b + 13], a[b + 14]];
      for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
      ys.push(p[1]);
      // Axis-aligned test: normalise each basis column, then require exactly one
      // near-unit component. Anything else is a genuinely rotated placement.
      let axisAligned = true;
      for (let c = 0; c < 3; c++) {
        const col = [a[b + c * 4], a[b + c * 4 + 1], a[b + c * 4 + 2]];
        const len = Math.hypot(col[0], col[1], col[2]) || 1;
        const big = col.filter(x => Math.abs(x / len) > 0.999).length;
        const small = col.filter(x => Math.abs(x / len) < 0.001).length;
        if (big !== 1 || small !== 2) { axisAligned = false; break; }
      }
      if (!axisAligned) rotated++;
      total++;
      // Only the bucket's PRIMARY mesh, or a multi-coloured part would appear
      // several times at the same point and be counted as its own headgear.
      if (!o.userData.primary) return;
      const part = String(o.userData.partName ?? '?').toLowerCase();
      (/^3626/.test(part) ? heads : others).push({ part, p });
    });
    ys.sort((a, b) => a - b);
    const pct = q => ys.length ? ys[Math.min(ys.length - 1, Math.floor(q * ys.length))] : 0;

    // ── Headgear seating (10316's defect, as a number) ──────────────────────
    // LDraw's convention: a worn headgear part's origin COINCIDES with the
    // head's. Verified corpus-wide against OMR (median local dy = 0.00). So a
    // worn piece and its head must sit at the same point; 10316's used to be
    // 18.0–60.5 LDU apart. "candidates" is every non-head piece close enough to
    // a head to be worn by it at all.
    // Scene units are STUDS (viewer.ts LDU_TO_UNITS = 1/20), so every distance
    // below is converted to LDU — the unit the audit's measurements are in.
    const LDU_PER_UNIT = 20;
    const NEAR = 80, SEATED = 1.0;
    // "stranded" is the DEFECT SIGNATURE, stated tightly: a piece sitting on a
    // head's own vertical axis (horizontal offset ≤ 2 LDU — headgear's place and
    // essentially nothing else's) but lifted clear of it. The 17 pieces measured
    // in the audit had dx = dz = 0.00 and dy 18.0–60.5 LDU. World +Y is up
    // (confirmed from the captures), so only pieces ABOVE a head count.
    const AXIS = 2.0, LIFT_MIN = 4, LIFT_MAX = 90;
    let seated = 0, stranded = 0, candidates = 0;
    const worst = [];
    const seatedHeads = [];
    let strandedTarget = null;
    for (const o of others) {
      let best = Infinity, bestHead = null;
      for (const h of heads) {
        const d = Math.hypot(o.p[0] - h.p[0], o.p[1] - h.p[1], o.p[2] - h.p[2]) * LDU_PER_UNIT;
        if (d < best) { best = d; bestHead = h; }
      }
      if (best > NEAR) continue;
      candidates++;
      if (best <= SEATED) { seated++; seatedHeads.push(bestHead.p); continue; }
      const horiz = Math.hypot(o.p[0] - bestHead.p[0], o.p[2] - bestHead.p[2]) * LDU_PER_UNIT;
      const lift = (o.p[1] - bestHead.p[1]) * LDU_PER_UNIT;
      if (horiz <= AXIS && lift > LIFT_MIN && lift <= LIFT_MAX) {
        stranded++;
        worst.push({ part: o.part, liftLDU: +lift.toFixed(2) });
        strandedTarget ??= bestHead.p;
      }
    }
    worst.sort((a, b) => b.liftLDU - a.liftLDU);

    // Close-up subject: of the heads WITH something seated on them, the one in
    // the most open space. A dense 6.3k-piece build will otherwise put the
    // camera inside a wall — the first attempt framed nothing but brown roof.
    let seatedTarget = null, bestCrowd = Infinity;
    for (const hp of seatedHeads) {
      let crowd = 0;
      for (const o of others) {
        if (Math.abs(o.p[0] - hp[0]) < 8 && Math.abs(o.p[1] - hp[1]) < 8 && Math.abs(o.p[2] - hp[2]) < 8) crowd++;
      }
      if (crowd < bestCrowd) { bestCrowd = crowd; seatedTarget = hp; }
    }

    return {
      // `instances` counts every InstancedMesh entry; `placements` counts one
      // per (part, colour) bucket — a multi-coloured part emits several meshes
      // over the SAME matrices, so only the second is comparable to a brick
      // count. They differ by 15 on 10182.
      instances: at0.n,
      placements: at0.placements,
      sliderMode: v.getSliderMode(),
      sliderAtMax: maxSlider,
      explodeZeroMaxDelta: at0.max,
      explodeFullMaxDelta: at100.max,
      returnToZeroMaxDelta: back0.max,
      // Which part carries the worst return-to-zero error — setExplodeFactor
      // round-trips through decompose()/compose(), which is exact only for
      // translation+rotation+scale, and LDraw permits sheared placements.
      returnToZeroWorstPart: back0.worst,
      missing: (v.missingParts ?? []).length,
      missingParts: (v.missingParts ?? []).slice(0, 10),
      substituted: (v.substitutedParts ?? []).length,
      unresolvedSubparts: (v.unresolvedSubparts ?? []).length,
      edgesDropped: !!v.edgesDroppedForSize,
      sizeStuds: v.getModelSizeStuds(),
      bbox: { lo, hi, span: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] },
      yPercentile: { p15: pct(0.15), p50: pct(0.5), p85: pct(0.85) },
      rotatedInstances: rotated,
      rotatedFraction: +(rotated / Math.max(1, total)).toFixed(4),
      heads: heads.length,
      // `target` is a head that HAS something seated on it — the close-up
      // subject. If nothing is seated it falls back to a head with a floating
      // piece above it, which is exactly what you want to look at then.
      headgear: {
        candidates, seated, stranded, worst: worst.slice(0, 10),
        target: seatedTarget ?? strandedTarget ?? null,
      },
      status: document.getElementById('lego-status')?.textContent?.slice(-500) ?? null,
    };
  });
}

// ─── Capture ─────────────────────────────────────────────────────────────────

/** Fixed named views plus the fixture's close-ups, all at explode 0. */
async function capture(page, fx, m, out) {
  const canvas = await page.$('#lego-viewer canvas') ?? await page.$('canvas');
  if (!canvas) { out.failed.push({ name: 'canvas present for capture', got: 'no canvas' }); return; }
  out.images = [];

  for (const view of ['iso', 'front', 'left']) {
    await page.evaluate(v => { window.__ldrawViewer?.setView(v); }, view);
    await page.waitForTimeout(2800);
    await shoot(page, canvas, `${fx.name}-${view}.png`, out);
  }

  const diag = Math.hypot(...m.bbox.span) || 1;
  for (const kind of fx.closeups ?? []) {
    const target = closeupTarget(kind, m);
    if (!target) continue;
    // Camera sits on a fixed oblique from the target at a fraction of the
    // model diagonal, so the same model always frames identically.
    // Scene units are STUDS: 3 units ≈ 60 LDU frames one minifig; a
    // fifth of the model diagonal frames a wall/foundation band.
    const r = kind === 'headgear' ? 6 : diag * 0.20;
    await page.evaluate(({ t, r }) => {
      const v = window.__ldrawViewer;
      v.cameraAnim = null;
      v.controls.target.set(t[0], t[1], t[2]);
      v.camera.position.set(t[0] + r * 0.9, t[1] + r * 0.55, t[2] + r * 1.3);
      v.controls.update();
      v.invalidate?.();
      v.composer?.render();
    }, { t: target, r });
    await page.waitForTimeout(2500);
    await shoot(page, canvas, `${fx.name}-closeup-${kind}.png`, out);
  }
}

/** Close-up targets, all derived from the model's own measured geometry. */
function closeupTarget(kind, m) {
  const cx = (m.bbox.lo[0] + m.bbox.hi[0]) / 2;
  const cz = (m.bbox.lo[2] + m.bbox.hi[2]) / 2;
  if (kind === 'lower') return [cx, m.yPercentile.p15, cz];  // foundation band
  if (kind === 'upper') return [cx, m.yPercentile.p85, cz];  // wall / tower band
  if (kind === 'headgear') return m.headgear.target ?? null;
  return null;
}

async function shoot(page, canvas, file, out) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await canvas.screenshot({ path: join(OUT, file), timeout: 25000 });
      out.images.push(file);
      return;
    } catch {
      // A backgrounded tab throttles rAF, so the compositor sometimes has no
      // fresh frame and the capture times out. Retrying is the documented fix.
      await page.waitForTimeout(1800);
    }
  }
  out.failed.push({ name: `captured ${file}`, got: 'screenshot timed out 4x' });
}
