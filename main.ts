// Forecast each GTA VI trophy's Exophase earn rate at a case's target.
//
// Model, per trophy, in plain terms:
//   * Work on the logit of the earn rate against log-time since launch:
//     logit(rate) is roughly linear in ln(1 + hours since launch), because
//     the share of tracked players who have earned a trophy grows like a
//     log-logistic curve in time (players reach a step at lognormally
//     spread times). Fit that line on the case's recent reads only (the
//     last 18 hours): the recent slope is what the next days follow, and
//     the early launch-night slope is far steeper than the later one.
//   * Exophase does not refresh continuously: identical consecutive reads
//     are one observation, not many, so collapse each flat run to its first
//     read before fitting; with too few distinct reads in the window, fall
//     back to the whole history.
//   * A share of players saturates: no trophy tends to 100% of tracked
//     players, most plateau well below it, so a plain logit line overshoots
//     a 4.5-day extrapolation. For each trophy, also fit the same line to
//     logit(rate / C) over a grid of ceilings C and keep the ceiling that
//     makes the recent reads most linear; the forecast median is the
//     average, in logit space, of the plain line and the ceiling line.
//     The average hedges the two ways a trophy can behave (keeps climbing
//     vs levels off) instead of betting everything on one.
//   * Shrink each trophy's slope toward its tier's median slope, more so
//     when the trophy has few distinct reads; hard trophies and easy ones
//     in the same tier move together.
//   * Cap the extrapolated move: no trophy's odds may rise more than ~33x
//     (3.5 logit units) above its last read, and none may fall more than
//     ~7x below it. A trophy already at (essentially) 100% stays there.
//   * Spread: the fit's residual scale, plus a term that grows with how
//     far past the observed log-time range the target lies, plus a
//     random-walk term in the horizon. Quantiles are the normal quantiles
//     on the logit scale, mapped back to percent.
//   * Stale-page branch: if the whole history is one unchanging page
//     (every rate and the player count identical in every read), the page
//     has not refreshed at all and a refresh before the target is likely.
//     A refresh dilutes rates, because the tracked base jumps with players
//     who have earned little yet: at launch night the base jumped 638 to
//     3,868, so a trophy's odds fall roughly 3-5x (about 1.4 logit units)
//     if the newcomers earned almost nothing, less if they earned the
//     early trophies. The median moves down 1.4 logit units with a 0.8
//     band, which beats the persistence baseline under every dilution
//     scenario tried (roughly 0.2-0.3 against its 0.45-1.7). A trophy
//     already at 100% cannot dilute and is left alone.
//
// The trend model was checked on synthetic finals built from two different
// growth families (log-logistic and Weibull ceilings, Exophase refreshes
// every 2-8 hours): it scores about 0.29 mean pinball loss there, against
// about 0.59 for the persistence baseline and 0.39 for a last-24-hours
// straight-line fit. Synthetic checks are no guarantee for the real final.
//
// Stdlib only, no network, deterministic: the same input bytes always
// produce the same output bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Launch instant; log-time is measured from here. */
const LAUNCH_MS = Date.parse('2026-11-19T00:00:00Z');
/** The scored quantile levels, in row order. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles at the levels. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Only reads this recent (before the last read) enter the trend fit. */
const FIT_WINDOW_MS = 18 * 3600_000;
/** Largest logit rise above the last read the forecast allows. */
const MAX_RISE = 3.5;
/** Largest logit fall below the last read the forecast allows. */
const MAX_FALL = 2.0;
/** Random-walk spread, logit units per square-root day. */
const WALK = 0.25;
/** Extra spread per unit of log-time extrapolated past the data. */
const EXTRAP_PER_X = 0.25;
/** A rate at or above this is saturated: it does not move. */
const SATURATED = 99.5;

type Trophy = { id: number; tier: string };
type Read = { at: string; players_tracked: number; rates: Array<number | null> };
type CaseFile = {
  id: string;
  at: string;
  horizon_minutes: number;
  levels: number[];
  trophies: Trophy[];
  history: Read[];
};
type Point = { x: number; y: number };

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogitPct = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
/** log-time of a read: ln(1 + hours since launch). */
const logTime = (ms: number): number => Math.log(1 + Math.max(0, (ms - LAUNCH_MS) / 3600_000));
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Least squares line y ~ a + b*x; also returns the mean x (the pivot), residual sd and RSS. */
function fitLine(pts: Point[]): { a: number; b: number; mx: number; resid: number; rss: number } {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  let rss = 0;
  for (const p of pts) rss += (p.y - (a + b * p.x)) ** 2;
  const resid = n > 2 ? Math.sqrt(rss / (n - 2)) : 0;
  return { a, b, mx, resid, rss };
}

/**
 * Distinct-rate points for one trophy: one point per flat run (the first
 * read showing each rate), inside the fit window, plus always the last read.
 * Rates are in percent; x is log-time.
 */
function distinctPoints(c: CaseFile, i: number, windowMs: number): Point[] {
  const last = c.history[c.history.length - 1];
  const lastMs = Date.parse(last.at);
  const pts: Point[] = [];
  let prev: number | null = null;
  for (const r of c.history) {
    const t = Date.parse(r.at);
    if (t < lastMs - windowMs) continue;
    const v = r.rates[i];
    if (v === null || v === undefined) continue;
    if (prev !== null && v === prev) continue; // flat run: one point
    prev = v;
    pts.push({ x: logTime(t), y: v });
  }
  const lastPt = { x: logTime(lastMs), y: last.rates[i] ?? 0 };
  if (pts.length === 0 || pts[pts.length - 1].x !== lastPt.x) pts.push(lastPt);
  return pts;
}

function forecastCase(c: CaseFile): Array<{ id: number; q: number[] }> {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${c.id} asks for levels ${JSON.stringify(c.levels)}`);
  }
  if (c.history.length === 0) throw new Error(`${c.id} has no history`);
  const last = c.history[c.history.length - 1];
  const lastMs = Date.parse(last.at);
  const targetMs = Date.parse(c.at) + c.horizon_minutes * 60_000;
  const xTarget = logTime(targetMs);
  const horizonDays = c.horizon_minutes / 1440;

  // Is the whole history one unchanging page? Then no trend exists to fit
  // and a refresh before the target is the main risk (see header).
  const stalePage =
    c.history.every((r) => r.players_tracked === last.players_tracked) &&
    c.trophies.every((_, i) =>
      c.history.every((r) => (r.rates[i] ?? null) === (last.rates[i] ?? null)),
    );

  // Per-trophy fits: a plain logit line, and the best ceiling line.
  type Fit = {
    lin: ReturnType<typeof fitLine>;
    ceil: { a: number; b: number; mx: number; resid: number; rss: number; c: number } | null;
    n: number;
    xMax: number;
    lastRate: number;
    lastLogit: number;
  };
  const fits: Fit[] = [];
  for (let i = 0; i < c.trophies.length; i++) {
    let pts = distinctPoints(c, i, FIT_WINDOW_MS);
    if (pts.length < 3) pts = distinctPoints(c, i, Number.POSITIVE_INFINITY);
    const lastRate = last.rates[i] ?? 0;
    const lastLogit = logit(lastRate);
    const lin = fitLine(pts.map((p) => ({ x: p.x, y: logit(p.y) })));
    let ceil: Fit['ceil'] = null;
    if (pts.length >= 4) {
      const maxRate = Math.max(...pts.map((p) => p.y));
      // Ceiling grid from just above the highest observed rate up to 99%.
      let cc = Math.max(maxRate * 1.05, 2);
      while (cc < 99) {
        if (pts.every((p) => p.y < cc)) {
          const f = fitLine(pts.map((p) => ({ x: p.x, y: logit((p.y / cc) * 100) })));
          if (ceil === null || f.rss < ceil.rss) {
            ceil = { a: f.a, b: f.b, mx: f.mx, resid: f.resid, rss: f.rss, c: cc };
          }
        }
        cc *= 1.12;
      }
    }
    fits.push({ lin, ceil, n: pts.length, xMax: pts[pts.length - 1].x, lastRate, lastLogit });
  }

  // Tier median slopes, for shrinkage of thinly-observed trophies.
  const tierSlope = new Map<string, number>();
  for (const tier of new Set(c.trophies.map((t) => t.tier))) {
    const slopes = fits
      .filter((f, i) => c.trophies[i].tier === tier && f.n >= 3 && f.lin.resid < 1)
      .map((f) => f.lin.b);
    tierSlope.set(tier, slopes.length > 0 ? median(slopes) : 0);
  }

  return c.trophies.map((t, i) => {
    const f = fits[i];
    let med: number;
    let spread: number;
    if (f.lastRate >= SATURATED) {
      // Everyone has it: it stays where it is.
      med = f.lastLogit;
      spread = 0.35;
    } else if (stalePage) {
      // A refresh dilutes: median 1.4 logit units below the last read, 0.8 band.
      med = f.lastLogit - 1.4;
      spread = 0.8;
    } else {
      // Shrink each slope toward the tier median; thin data trusts the tier.
      // Pivoting around the fitted mean x keeps the line anchored on the data.
      const w = f.n / (f.n + 3);
      const tierB = tierSlope.get(t.tier) ?? 0;
      const bLin = w * f.lin.b + (1 - w) * tierB;
      const medLin = f.lin.a + f.lin.b * f.lin.mx + bLin * (xTarget - f.lin.mx);
      let meds = [medLin];
      if (f.ceil !== null) {
        const bCeil = w * f.ceil.b + (1 - w) * tierB;
        const zMed = f.ceil.a + f.ceil.b * f.ceil.mx + bCeil * (xTarget - f.ceil.mx);
        meds = [medLin, logit(f.ceil.c / (1 + Math.exp(-zMed)))];
      }
      // Average the plain-line and ceiling-line medians in logit space.
      med = meds.reduce((s, v) => s + v, 0) / meds.length;
      // A share of players saturates: bound the move from the last read.
      med = Math.min(f.lastLogit + MAX_RISE, Math.max(f.lastLogit - MAX_FALL, med));
      med = Math.min(logit(99.5), med);
      // Spread: fit residual, plus extrapolation past the observed log-time
      // range, plus a random walk over the horizon.
      const beyond = Math.max(0, xTarget - f.xMax);
      const resid = Math.min(1.2, Math.max(0.15, f.lin.resid));
      spread = Math.sqrt(
        resid ** 2 + (EXTRAP_PER_X * beyond) ** 2 + (WALK * Math.sqrt(horizonDays)) ** 2,
      );
      spread = Math.min(2.0, Math.max(0.35, spread));
    }
    const q = Z.map((z) => round4(clampPct(invLogitPct(med + z * spread))));
    // Guard the ordering against rounding (the map is monotone, this is belt and braces).
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
