/**
 * Aggregation + rendering: episodes → project summaries → builder bundle.
 */

import type { EpisodeFeatures } from "./features.ts";
import type { ParseStats } from "./schema.ts";

export interface ProjectSummary {
  projectHash: string;
  /** display label (folder leaf name) — kept OUT of the uploadable bundle */
  label?: string;
  episodes: number;
  activeMinutes: number;
  promptCount: number;
  effectiveTokens: number;
  weightedTokens: number;
  // token-weighted means across episodes
  correctionRatio: number;
  meanRedirectDepth: number;
  firstPromptContextScore: number;
  meanPromptSpecificity: number;
  editsPerPrompt: number;
  loopBurnFraction: number;
  loopCount: number;
  toolSuccessRate: number;
  verifyAfterEditRatio: number;
  errorRecoveryRate: number;
  agenticLeverage: number;
  outcomes: Record<string, number>;
  modelHistogram: Record<string, number>;
}

export interface Bundle {
  schemaVersion: string;
  agent: string;
  generatedAt: string;
  coherence: {
    chainBreaks: number;
    timeRegressions: number;
    unknownEventRatio: number;
    badJsonLines: number;
  };
  projects: ProjectSummary[];
  overall: Omit<ProjectSummary, "projectHash" | "label">;
}

const WEIGHTED_MEAN_FIELDS = [
  "correctionRatio", "meanRedirectDepth", "firstPromptContextScore",
  "meanPromptSpecificity", "editsPerPrompt", "loopBurnFraction",
  "toolSuccessRate", "verifyAfterEditRatio", "errorRecoveryRate",
  "agenticLeverage",
] as const;

export function summarize(
  projectHash: string,
  feats: EpisodeFeatures[],
): ProjectSummary {
  const totalWeight = feats.reduce((a, f) => a + Math.max(f.effectiveTokens, 1), 0);
  const wmean = (field: (typeof WEIGHTED_MEAN_FIELDS)[number]) =>
    round4(feats.reduce((a, f) => a + f[field] * Math.max(f.effectiveTokens, 1), 0) / totalWeight);

  const outcomes: Record<string, number> = {};
  const modelHistogram: Record<string, number> = {};
  for (const f of feats) {
    outcomes[f.outcome] = (outcomes[f.outcome] ?? 0) + 1;
    for (const [m, t] of Object.entries(f.modelHistogram)) {
      modelHistogram[m] = (modelHistogram[m] ?? 0) + t;
    }
  }

  return {
    projectHash,
    episodes: feats.length,
    activeMinutes: round1(feats.reduce((a, f) => a + f.activeMinutes, 0)),
    promptCount: feats.reduce((a, f) => a + f.promptCount, 0),
    effectiveTokens: feats.reduce((a, f) => a + f.effectiveTokens, 0),
    weightedTokens: feats.reduce((a, f) => a + f.weightedTokens, 0),
    correctionRatio: wmean("correctionRatio"),
    meanRedirectDepth: wmean("meanRedirectDepth"),
    firstPromptContextScore: wmean("firstPromptContextScore"),
    meanPromptSpecificity: wmean("meanPromptSpecificity"),
    editsPerPrompt: wmean("editsPerPrompt"),
    loopBurnFraction: wmean("loopBurnFraction"),
    loopCount: feats.reduce((a, f) => a + f.loopCount, 0),
    toolSuccessRate: wmean("toolSuccessRate"),
    verifyAfterEditRatio: wmean("verifyAfterEditRatio"),
    errorRecoveryRate: wmean("errorRecoveryRate"),
    agenticLeverage: wmean("agenticLeverage"),
    outcomes,
    modelHistogram,
  };
}

export function buildBundle(
  projectSummaries: ProjectSummary[],
  allFeats: EpisodeFeatures[],
  parseStats: ParseStats[],
  agent: string = "claude-code",
): Bundle {
  const overall = summarize("__overall__", allFeats);
  delete (overall as any).projectHash;
  return {
    schemaVersion: "0.1.0",
    agent,
    generatedAt: new Date().toISOString(),
    coherence: {
      chainBreaks: parseStats.reduce((a, s) => a + s.chainBreaks, 0),
      timeRegressions: parseStats.reduce((a, s) => a + s.timeRegressions, 0),
      unknownEventRatio: round4(
        parseStats.reduce((a, s) => a + s.unknownEventRatio, 0) / Math.max(parseStats.length, 1)),
      badJsonLines: parseStats.reduce((a, s) => a + s.badJson, 0),
    },
    // labels stripped: bundle carries hashes only
    projects: projectSummaries.map(({ label, ...rest }) => rest),
    overall: overall as Bundle["overall"],
  };
}

// ---------------------------------------------------------------------------
// terminal rendering
// ---------------------------------------------------------------------------

export function renderReport(summaries: ProjectSummary[], bundle: Bundle): string {
  const lines: string[] = [];
  const bar = "─".repeat(72);
  lines.push(bar, " VIBESCORE — local skill report (nothing has left this machine)", bar);

  for (const s of summaries) {
    lines.push("");
    lines.push(` ${s.label ?? s.projectHash}`);
    lines.push(`   episodes ${s.episodes} · prompts ${s.promptCount} · active ${fmtMin(s.activeMinutes)} · eff-tokens ${fmtK(s.effectiveTokens)}`);
    lines.push(`   direction   correction ${pct(s.correctionRatio)} · redirect-depth ${s.meanRedirectDepth} · 1st-prompt-context ${pct(s.firstPromptContextScore)} · specificity ${s.meanPromptSpecificity}/prompt`);
    lines.push(`   efficiency  loop-burn ${pct(s.loopBurnFraction)} (${s.loopCount} loops) · edits/prompt ${s.editsPerPrompt}`);
    lines.push(`   fluency     tool-success ${pct(s.toolSuccessRate)} · verify-after-edit ${pct(s.verifyAfterEditRatio)} · recovery ${pct(s.errorRecoveryRate)} · agentic ${pct(s.agenticLeverage)}`);
    lines.push(`   outcomes    ${Object.entries(s.outcomes).map(([k, v]) => `${k}:${v}`).join(" · ") || "—"}`);
  }

  const o = bundle.overall;
  lines.push("", bar, " OVERALL");
  lines.push(`   ${o.episodes} episodes · ${o.promptCount} prompts · ${fmtMin(o.activeMinutes)} active · ${fmtK(o.effectiveTokens)} eff-tokens`);
  lines.push(`   correction ${pct(o.correctionRatio)} · loop-burn ${pct(o.loopBurnFraction)} · tool-success ${pct(o.toolSuccessRate)} · verify ${pct(o.verifyAfterEditRatio)}`);
  lines.push(`   coherence: chain-breaks ${bundle.coherence.chainBreaks} · time-regressions ${bundle.coherence.timeRegressions} · unknown-events ${pct(bundle.coherence.unknownEventRatio)}`);
  lines.push(bar);
  return lines.join("\n");
}

function pct(x: number): string { return (x * 100).toFixed(1) + "%"; }
function fmtK(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + "M"
    : n >= 1_000 ? (n / 1_000).toFixed(0) + "k" : String(n);
}
function fmtMin(m: number): string {
  return m >= 60 ? (m / 60).toFixed(1) + "h" : m.toFixed(0) + "m";
}
function round1(x: number): number { return Math.round(x * 10) / 10; }
function round4(x: number): number { return Math.round(x * 10_000) / 10_000; }
