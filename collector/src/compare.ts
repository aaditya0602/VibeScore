/**
 * Separability harness (Phase-0 gate tooling).
 *
 *   vibescore compare a.json b.json c.json [--truth ranking.txt]
 *
 * Ranks builders by a naive candidate composite from their bundles.
 * With --truth (one bundle filename per line, best builder first), also
 * reports Spearman ρ against the hidden hand-ranking.
 * Gate per implementation plan: ρ ≥ 0.6 or metrics get redesigned.
 *
 * The composite here is deliberately crude Phase-A heuristics — the point
 * is testing whether the FEATURES carry signal, not shipping a rating.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Bundle } from "./report.ts";

interface Candidate {
  name: string;
  composite: number;
  parts: Record<string, number>;
}

/** Phase-A heuristic composite: each part scaled ~0..1, higher = better. */
export function naiveComposite(b: Bundle): Candidate["parts"] {
  const o = b.overall;
  return {
    lowCorrection: clamp01(1 - o.correctionRatio / 0.25),
    lowLoopBurn: clamp01(1 - o.loopBurnFraction / 0.4),
    context: clamp01(o.firstPromptContextScore),
    verifyHabit: clamp01(o.verifyAfterEditRatio),
    recovery: clamp01(o.errorRecoveryRate),
    toolSuccess: clamp01((o.toolSuccessRate - 0.85) / 0.15),
    shipping: clamp01(shippedFraction(o.outcomes)),
    scope: clamp01(o.editsPerPrompt / 6),
  };
}

function shippedFraction(outcomes: Record<string, number>): number {
  const total = Object.values(outcomes).reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  return ((outcomes.committed ?? 0) + (outcomes.verified ?? 0)) / total;
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

/** geometric mean — punishes cratering any dimension (algo doc §Stage 5 rationale) */
function geoMean(parts: Record<string, number>): number {
  const vals = Object.values(parts).map((v) => Math.max(v, 0.01));
  return Math.exp(vals.reduce((a, v) => a + Math.log(v), 0) / vals.length);
}

export function spearman(rankA: string[], rankB: string[]): number {
  const n = rankA.length;
  if (n < 2) return NaN;
  const pos = new Map(rankB.map((x, i) => [x, i]));
  let d2 = 0;
  rankA.forEach((x, i) => {
    const j = pos.get(x);
    if (j === undefined) throw new Error(`truth ranking missing entry: ${x}`);
    d2 += (i - j) ** 2;
  });
  return 1 - (6 * d2) / (n * (n * n - 1));
}

export function runCompare(files: string[], truthPath?: string): string {
  const candidates: Candidate[] = files.map((f) => {
    const bundle: Bundle = JSON.parse(readFileSync(f, "utf8"));
    const parts = naiveComposite(bundle);
    return { name: basename(f), composite: geoMean(parts), parts };
  });
  candidates.sort((a, b) => b.composite - a.composite);

  const lines: string[] = [];
  lines.push("rank  composite  builder");
  candidates.forEach((c, i) => {
    lines.push(` ${String(i + 1).padEnd(4)} ${c.composite.toFixed(3).padEnd(9)} ${c.name}`);
    lines.push(`       ${Object.entries(c.parts).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(" ")}`);
  });

  if (truthPath) {
    const truth = readFileSync(truthPath, "utf8")
      .split("\n").map((l) => l.trim()).filter(Boolean);
    const rho = spearman(candidates.map((c) => c.name), truth);
    lines.push("");
    lines.push(`Spearman ρ vs hand-ranking: ${rho.toFixed(3)}  ${rho >= 0.6 ? "— GATE PASSED (≥0.6)" : "— GATE FAILED (<0.6): redesign metrics before backend work"}`);
  }
  return lines.join("\n");
}
