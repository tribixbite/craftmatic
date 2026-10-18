/**
 * The per-tick COST model: what a scripted vehicle's tick is PREDICTED to cost
 * on each phone, from the work the simulator counts. It is a trend detector,
 * never a pass: every number it prints is labelled "predicted".
 *
 * Calibration. `vehicles.js` prints, once a second per vehicle with telemetry
 * on (`/scriptevent craftmatic:vehicle_telemetry fast`), its swept-footprint
 * block probes of that tick (`sweepChecks`) and its own measured milliseconds
 * per tick over the last second (`msPerTick`, Date.now() around the runtime's
 * whole tick). The device rounds' content logs hold hundreds of such pairs per
 * phone; a least-squares line through the MOVING ones (sweepChecks > 0) is the
 * model (`fitCost`). The fits below are frozen from the logs named in
 * `COST_CALIBRATION_LOGS`; `test/sim-input.test.ts` re-derives them from those
 * files when they are on this machine.
 *
 * Known limits: `msPerTick` is a one-second average while `sweepChecks` is one
 * tick's count, so each pair is noisy; the intercept is everything else the
 * runtime does per tick (the entity query, the HUD, the camera reads), measured
 * only for the vehicles the rounds drove (the X-wing, the Milano, the McLaren,
 * four ground cars and the yacht); a 36-block barge on the Pixel of 2026-09-25
 * (an older runtime) spent 20-24 ms on ~890 probes where this fit says 15.8.
 */

/** One phone's fit: ms per tick = `interceptMs` + `msPerCheck` x sweep checks. */
export interface CostFit {
  device: 'pixel' | 'saga';
  interceptMs: number;
  msPerCheck: number;
  /** Moving samples the fit was made from. */
  samples: number;
  /** Where they came from (round folders), for the report. */
  evidence: string;
}

/** The content logs the frozen fits were made from (device, path under the main checkout's `output/`). */
export const COST_CALIBRATION_LOGS: ReadonlyArray<readonly ['pixel' | 'saga', string]> = [
  ['pixel', 'device-round-2026-10-07j/pixel/milano-cmvt.txt'],
  ['pixel', 'device-round-2026-10-07j/pixel/contentlog-milano.txt'],
  ['pixel', 'device-round-2026-10-07j/pixel/contentlog-final.txt'],
  ['pixel', 'device-round-2026-10-07k/pixel/contentlog-final.txt'],
  ['pixel', 'device-round-2026-10-07l/pixel/contentlog-final.txt'],
  ['saga', 'device-round-2026-10-07j/saga/ContentLog-30j-live.txt'],
  ['saga', 'device-round-2026-10-07k/saga/ContentLog-30k-live.txt'],
  ['saga', 'device-round-2026-10-07l/saga/ContentLog-30l-live.txt'],
];

/**
 * The frozen fits (2026-10-08, 120 Pixel and 491 Saga moving samples from the logs above). Checks against the
 * rounds' own readings: the Milano's level cruise, 770 checks, predicts 14.2 ms on the Pixel (30j measured 14.5
 * median) and 14.8 on the Saga (30l measured 13.4); 1,532 checks blocked predicts 27.0 on the Saga (30k: 26-27).
 */
export const COST_FITS: Readonly<Record<'pixel' | 'saga', CostFit>> = {
  pixel: { device: 'pixel', interceptMs: 4.1369, msPerCheck: 0.013098, samples: 120, evidence: 'Pixel rounds 30j/30k/30l content logs (CMVT sweepChecks / msPerTick)' },
  saga: { device: 'saga', interceptMs: 2.4657, msPerCheck: 0.016028, samples: 491, evidence: 'Saga rounds 30j/30k/30l content logs (CMVT sweepChecks / msPerTick)' },
};

/** Over this predicted ms per tick the report WARNS (`tick-budget`): half the 50 ms tick, never a failure. */
export const TICK_BUDGET_WARN_MS = 25;

/** One telemetry sample: a vehicle's sweep checks in one tick and the runtime's measured ms per tick. */
export interface CostSample { type: string; id: string; t: number; sweepChecks: number; msPerTick: number }

/** Every `CMVT {...}` telemetry line with `sweepChecks` in a text (a content log, or the simulator's console lines), one per vehicle and tick. */
export function parseCmvtSamples(text: string): CostSample[] {
  const out: CostSample[] = [], seen = new Set<string>();
  for (const m of text.matchAll(/CMVT (\{[^\n]*?\})(?=\s|$)/g)) {
    let j: Record<string, unknown>;
    try { j = JSON.parse(m[1]!) as Record<string, unknown>; } catch { continue; }
    if (typeof j['sweepChecks'] !== 'number' || typeof j['msPerTick'] !== 'number') continue;
    const key = `${String(j['id'])}|${String(j['t'])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: String(j['type']), id: String(j['id']), t: Number(j['t']), sweepChecks: j['sweepChecks'] as number, msPerTick: j['msPerTick'] as number });
  }
  return out;
}

/** The least-squares line ms = a + b x checks through the MOVING samples (sweepChecks > 0). */
export function fitCost(samples: readonly CostSample[]): { interceptMs: number; msPerCheck: number; samples: number; rmsMs: number } {
  const xs = samples.filter(s => s.sweepChecks > 0);
  const n = xs.length;
  if (n < 2) return { interceptMs: NaN, msPerCheck: NaN, samples: n, rmsMs: NaN };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of xs) { sx += s.sweepChecks; sy += s.msPerTick; sxx += s.sweepChecks ** 2; sxy += s.sweepChecks * s.msPerTick; }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
  const rms = Math.sqrt(xs.reduce((acc, s) => acc + (s.msPerTick - (a + b * s.sweepChecks)) ** 2, 0) / n);
  return { interceptMs: a, msPerCheck: b, samples: n, rmsMs: rms };
}

/** The predicted ms of one tick with `sweepChecks` probes on a phone (labelled predicted wherever it is shown). */
export function predictedMsPerTick(device: 'pixel' | 'saga', sweepChecks: number): number {
  const f = COST_FITS[device];
  return f.interceptMs + f.msPerCheck * sweepChecks;
}

/** A percentile (0..1) of numbers (nearest rank). */
const pct = (xs: readonly number[], p: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
};

/** A scenario's predicted cost: p50 / p95 per phone over the telemetry samples, and the `tick-budget` warnings. */
export interface CostSummary {
  samples: number;
  movingSamples: number;
  sweepChecksP50: number;
  sweepChecksP95: number;
  predicted: Record<'pixel' | 'saga', { p50: number; p95: number }>;
  /** `tick-budget`: one line per phone whose predicted p95 is over `TICK_BUDGET_WARN_MS` (a warning, never a failure). */
  warnings: string[];
}

/** Summarise a scenario's telemetry samples (only the MOVING ones are costed: a parked vehicle sweeps nothing). */
export function summarizeCost(samples: readonly CostSample[]): CostSummary {
  const moving = samples.filter(s => s.sweepChecks > 0).map(s => s.sweepChecks);
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  const predicted = Object.fromEntries((['pixel', 'saga'] as const).map(d => [d, { p50: r1(predictedMsPerTick(d, pct(moving, 0.5))), p95: r1(predictedMsPerTick(d, pct(moving, 0.95))) }])) as CostSummary['predicted'];
  const warnings = moving.length ? (['pixel', 'saga'] as const).filter(d => predicted[d].p95 > TICK_BUDGET_WARN_MS).map(d => `tick-budget: predicted ${predicted[d].p95} ms/tick (p95) on the ${d}, over ${TICK_BUDGET_WARN_MS} (a trend warning: the model is a line through device telemetry, not a measurement)`) : [];
  return { samples: samples.length, movingSamples: moving.length, sweepChecksP50: pct(moving, 0.5), sweepChecksP95: pct(moving, 0.95), predicted, warnings };
}
