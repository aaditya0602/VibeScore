/**
 * Persona definitions for the skill-tier simulation harness.
 *
 * Each tier carries distribution parameters (mean + jitter) that a seeded
 * PRNG turns into concrete synthetic Claude Code sessions. The three tiers
 * are engineered so the REAL collector pipeline recovers a monotone ordering
 *   thrasher > builder > architect   (loop burn, corrections)
 *   architect > builder > thrasher   (verify-after-edit, first-prompt context, shipping)
 * which is the entire point of the harness: known ground truth in, recovered
 * skill signal out.
 *
 * Erasable-TS only (no enums/namespaces), Node stdlib only, ESM.
 */

export type Tier = "architect" | "builder" | "thrasher";

export interface Persona {
  tier: Tier;
  /** probability a non-first prompt is a correction ("that's wrong", "revert") */
  correctionProb: number;
  /** target loopBurnFraction (fraction of effective tokens spent inside failure loops) */
  loopBurn: number;
  loopBurnJitter: number;
  /** where the failure loop sits: "mid" (benign re-run) or "end" (failing abandon) */
  loopPlacement: "mid" | "end";
  /** loop tool calls error out (thrasher) or not (architect/builder re-runs) */
  loopErrors: boolean;
  loopRepeats: [number, number];
  /** probability an edit stretch is followed by a verification command */
  verifyProb: number;
  /** first-prompt shape → drives firstPromptContextScore */
  firstPromptWords: number;
  firstPromptWordsJitter: number;
  firstPromptFileRefs: [number, number];
  firstPromptConstraints: [number, number];
  /** edits emitted per work prompt (scope proxy) */
  editsPerPrompt: [number, number];
  workPrompts: [number, number];
  /** how the episode ends: git commit / passing verify / failing loop */
  ending: "commit" | "verify" | "abandon";
  /** for "verify" endings, probability the final verify actually passes (ships) */
  shipProb: number;
}

export const PERSONAS: Record<Tier, Persona> = {
  architect: {
    tier: "architect",
    correctionProb: 0.02,
    loopBurn: 0.075,
    loopBurnJitter: 0.02,
    loopPlacement: "mid",
    loopErrors: false,
    loopRepeats: [3, 3],
    verifyProb: 0.7,
    firstPromptWords: 170,
    firstPromptWordsJitter: 30,
    firstPromptFileRefs: [3, 5],
    firstPromptConstraints: [5, 7],
    editsPerPrompt: [4, 6],
    workPrompts: [4, 6],
    ending: "commit",
    shipProb: 1,
  },
  builder: {
    tier: "builder",
    correctionProb: 0.05,
    loopBurn: 0.185,
    loopBurnJitter: 0.03,
    loopPlacement: "mid",
    loopErrors: false,
    loopRepeats: [3, 4],
    verifyProb: 0.35,
    firstPromptWords: 55,
    firstPromptWordsJitter: 15,
    firstPromptFileRefs: [1, 2],
    firstPromptConstraints: [2, 3],
    editsPerPrompt: [2, 4],
    workPrompts: [3, 5],
    ending: "verify",
    shipProb: 0.8,
  },
  thrasher: {
    tier: "thrasher",
    // per-followup probability; realizes ~12% of ALL prompts as corrections
    // once first-prompt dilution over the short thrasher prompt count is
    // accounted for (first prompt is never a correction).
    correctionProb: 0.17,
    loopBurn: 0.36,
    loopBurnJitter: 0.05,
    loopPlacement: "end",
    loopErrors: true,
    loopRepeats: [3, 6],
    verifyProb: 0.1,
    firstPromptWords: 9,
    firstPromptWordsJitter: 4,
    firstPromptFileRefs: [0, 0],
    firstPromptConstraints: [0, 0],
    editsPerPrompt: [0, 2],
    workPrompts: [3, 4],
    ending: "abandon",
    shipProb: 0,
  },
};

// ---------------------------------------------------------------------------
// seeded PRNG (mulberry32) + helpers
// ---------------------------------------------------------------------------

/** mulberry32 — tiny deterministic PRNG, returns () => float in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** stable 32-bit hash for deriving independent PRNG streams from a base seed. */
export function hashSeed(...parts: Array<number | string>): number {
  let h = 2166136261 >>> 0;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function randFloat(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

export function jitter(rng: () => number, mean: number, spread: number): number {
  return mean + (rng() * 2 - 1) * spread;
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function pickN<T>(rng: () => number, arr: readonly T[], n: number): T[] {
  const pool = arr.slice();
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}
