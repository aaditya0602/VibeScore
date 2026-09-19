/**
 * Scoring engine v0.1.0 — percentile-based rating with uncertainty.
 *
 * Design (see vibescore-algorithm-design.md):
 *  - rank, don't grade: every metric becomes an empirical percentile
 *    against the population (synthetic seed + real builders)
 *  - four visible dimensions built from feature percentiles
 *  - composite = weighted geometric mean (punishes cratering any one
 *    dimension) mapped to an Elo-like scale, mean ≈ 1500
 *  - RD (rating deviation) from evidence volume + coherence flags;
 *    thin or suspicious history = wide band, "provisional" tier
 *
 * v1 simplifications, on purpose: no cohort keys yet (population is one
 * cohort), no CDF snapshotting (recomputed per request at demo scale),
 * hand-set Phase-A weights. All marked for Stage-6 refinement.
 */

import type { Bundle } from "../../collector/src/report.ts";
import type { PopulationEntry } from "./store.ts";
import { parseBundle } from "./validation.ts";

export const ALGO_VERSION = "0.2.0";

// ---------------------------------------------------------------------------
// raw metrics (higher = better, all derived from bundle.overall)
// ---------------------------------------------------------------------------

type Overall = Bundle["overall"];

interface MetricDef {
  key: string;
  dimension: "efficiency" | "direction" | "craft" | "shipping";
  value: (o: Overall) => number;
}

function shippedFraction(o: Overall): number {
  const total = Object.values(o.outcomes ?? {}).reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  return ((o.outcomes.committed ?? 0) + (o.outcomes.verified ?? 0)) / total;
}

const METRICS: MetricDef[] = [
  // efficiency — waste and delegation scope
  { key: "lowLoopBurn", dimension: "efficiency", value: (o) => 1 - o.loopBurnFraction },
  { key: "scope", dimension: "efficiency", value: (o) => Math.min(o.editsPerPrompt, 10) },
  // direction — steering quality
  { key: "lowCorrection", dimension: "direction", value: (o) => 1 - o.correctionRatio },
  { key: "context", dimension: "direction", value: (o) => o.firstPromptContextScore },
  { key: "specificity", dimension: "direction", value: (o) => Math.min(o.meanPromptSpecificity, 12) },
  { key: "quickRecenter", dimension: "direction", value: (o) => 1 - Math.min(o.meanRedirectDepth, 25) / 25 },
  // craft — verification and recovery discipline
  { key: "toolSuccess", dimension: "craft", value: (o) => o.toolSuccessRate },
  { key: "verifyHabit", dimension: "craft", value: (o) => o.verifyAfterEditRatio },
  { key: "recovery", dimension: "craft", value: (o) => o.errorRecoveryRate },
  // shipping — outcomes
  { key: "shipped", dimension: "shipping", value: shippedFraction },
];

/** Phase-A dimension weights (secret in production; hand-set pending learning loop). */
const DIM_WEIGHTS: Record<MetricDef["dimension"], number> = {
  efficiency: 0.3,
  direction: 0.3,
  craft: 0.25,
  shipping: 0.15,
};

// ---------------------------------------------------------------------------
// percentiles
// ---------------------------------------------------------------------------

/** Midrank empirical percentile of x within values (0–100). */
export function percentile(x: number, values: number[]): number {
  if (values.length === 0) return 50;
  let below = 0, equal = 0;
  for (const v of values) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return (100 * (below + equal / 2)) / values.length;
}

export interface Subscores {
  efficiency: number;
  direction: number;
  craft: number;
  shipping: number;
}

export interface Score {
  handle: string;
  synthetic: boolean;
  rating: number;
  rd: number;
  tier: "provisional" | "established" | "verified";
  subscores: Subscores;
  algoVersion: string;
  population: number;
  coherenceOk: boolean;
  evidence: "self-reported" | "synthetic";
}

// ---------------------------------------------------------------------------
// rating
// ---------------------------------------------------------------------------

/**
 * Coherence red flags. Baseline from red-team experiment E: honest logs
 * naturally contain chain breaks (~7% of events from session resume /
 * compaction), so absolute chain-break counts are NOT flagged here —
 * only signals that were near-zero in every honest sample.
 */
function coherenceOk(b: Bundle): boolean {
  return b.coherence.badJsonLines === 0 &&
    b.coherence.unknownEventRatio < 0.08 &&
    b.coherence.timeRegressions <= 20;
}

export function scorePopulation(entries: PopulationEntry[]): Score[] {
  // Fail closed even when the engine is called outside HTTP ingestion.
  entries = entries.map(e => ({ ...e, bundle: parseBundle(e.bundle) }));
  if (entries.some(e => !e.synthetic)) entries = entries.filter(e => !e.synthetic);
  // column values per metric across the whole population
  const columns = new Map<string, number[]>();
  for (const m of METRICS) {
    columns.set(m.key, entries.map((e) => m.value(e.bundle.overall)));
  }

  return entries.map((e) => {
    const o = e.bundle.overall;

    // dimension percentile = mean of member-metric percentiles
    const dims: Record<MetricDef["dimension"], number[]> = {
      efficiency: [], direction: [], craft: [], shipping: [],
    };
    for (const m of METRICS) {
      dims[m.dimension].push(percentile(m.value(o), columns.get(m.key)!));
    }
    const subscores: Subscores = {
      efficiency: mean(dims.efficiency),
      direction: mean(dims.direction),
      craft: mean(dims.craft),
      shipping: mean(dims.shipping),
    };

    // composite: weighted geometric mean of dimension fractions
    let logSum = 0, wSum = 0;
    for (const [dim, w] of Object.entries(DIM_WEIGHTS)) {
      const frac = Math.max(subscores[dim as keyof Subscores] / 100, 0.02);
      logSum += w * Math.log(frac);
      wSum += w;
    }
    const blend = Math.exp(logSum / wSum); // 0..1
    const rating = Math.round(800 + 1400 * blend);

    // uncertainty: evidence volume shrinks RD; coherence flags widen it
    const cohOk = coherenceOk(e.bundle);
    // Imported aggregates cannot establish identity, integrity or skill. Volume
    // narrows a heuristic evidence band but never grants a verified trust tier.
    let rd = Math.max(160, Math.round(350 / Math.sqrt(1 + o.episodes / 3)));
    if (!cohOk) rd += 75;
    rd = Math.min(Math.max(rd, 60), 350);

    const tier: Score["tier"] = "provisional";

    return {
      handle: e.handle,
      synthetic: e.synthetic,
      rating,
      rd,
      tier,
      subscores: {
        efficiency: Math.round(subscores.efficiency),
        direction: Math.round(subscores.direction),
        craft: Math.round(subscores.craft),
        shipping: Math.round(subscores.shipping),
      },
      algoVersion: ALGO_VERSION,
      population: entries.length,
      coherenceOk: cohOk,
      evidence: e.synthetic ? "synthetic" : "self-reported",
    };
  });
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
