import type { Bundle, ProjectSummary } from "../../collector/src/report.ts";

export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ValidationError"; }
}

const SIGNALS = ["episodes", "activeMinutes", "promptCount", "effectiveTokens", "weightedTokens",
  "correctionRatio", "meanRedirectDepth", "firstPromptContextScore", "meanPromptSpecificity",
  "editsPerPrompt", "loopBurnFraction", "loopCount", "toolSuccessRate", "verifyAfterEditRatio",
  "errorRecoveryRate", "agenticLeverage", "outcomes", "modelHistogram"];
const RATIOS = ["correctionRatio", "firstPromptContextScore", "loopBurnFraction", "toolSuccessRate",
  "verifyAfterEditRatio", "errorRecoveryRate", "agenticLeverage"];
const OUTCOMES = ["committed", "verified", "error_abandon", "short", "ended"];

function record(value: unknown, keys: string[], path: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${path} must be an object`);
  if (Object.keys(value).some(k => !keys.includes(k))) throw new ValidationError(`${path} contains unsupported fields`);
  return value as Record<string, any>;
}
function number(value: unknown, min: number, max: number, path: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
    throw new ValidationError(`${path} must be ${integer ? "an integer" : "a finite number"} between ${min} and ${max}`);
  }
  return value;
}
function summary(value: unknown, path: string, project = false): any {
  const o = record(value, project ? [...SIGNALS, "projectHash"] : SIGNALS, path);
  const clean: Record<string, any> = {};
  if (project) {
    if (typeof o.projectHash !== "string" || !/^[a-f0-9]{16,64}$/.test(o.projectHash)) throw new ValidationError(`${path}.projectHash must be a hash`);
    clean.projectHash = o.projectHash;
  }
  clean.episodes = number(o.episodes, 1, 1_000_000, `${path}.episodes`, true);
  for (const k of ["promptCount", "loopCount"]) clean[k] = number(o[k], 0, 100_000_000, `${path}.${k}`, true);
  for (const k of ["effectiveTokens", "weightedTokens"]) clean[k] = number(o[k], 0, 1e15, `${path}.${k}`);
  clean.activeMinutes = number(o.activeMinutes, 0, 100_000_000, `${path}.activeMinutes`);
  for (const k of RATIOS) clean[k] = number(o[k], 0, 1, `${path}.${k}`);
  clean.meanRedirectDepth = number(o.meanRedirectDepth, 0, 25, `${path}.meanRedirectDepth`);
  clean.meanPromptSpecificity = number(o.meanPromptSpecificity, 0, 1000, `${path}.meanPromptSpecificity`);
  clean.editsPerPrompt = number(o.editsPerPrompt, 0, 1_000_000, `${path}.editsPerPrompt`);
  const outcomes = record(o.outcomes, OUTCOMES, `${path}.outcomes`);
  clean.outcomes = Object.fromEntries(Object.entries(outcomes).map(([k, v]) => [k, number(v, 0, clean.episodes, `${path}.outcomes.${k}`, true)]));
  if (Object.values(clean.outcomes).reduce((a: number, b: any) => a + b, 0) !== clean.episodes) throw new ValidationError(`${path}.outcomes must sum to episodes`);
  if (!o.modelHistogram || typeof o.modelHistogram !== "object" || Array.isArray(o.modelHistogram) || Object.keys(o.modelHistogram).length > 64) throw new ValidationError(`${path}.modelHistogram is invalid`);
  clean.modelHistogram = Object.fromEntries(Object.entries(o.modelHistogram).map(([k, v]) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,95}$/.test(k) || ["__proto__", "constructor", "prototype"].includes(k)) throw new ValidationError(`${path}.modelHistogram contains an invalid model identifier`);
    return [k, number(v, 0, 1e15, `${path}.modelHistogram value`)];
  }));
  return clean;
}

/** Reject unknown fields, including prompt text, labels and source paths; rebuild only numeric telemetry. */
export function parseBundle(input: unknown): Bundle {
  const b = record(input, ["schemaVersion", "agent", "generatedAt", "coherence", "projects", "overall"], "bundle");
  if (b.schemaVersion !== "0.1.0") throw new ValidationError("unsupported bundle schemaVersion");
  if (!["claude-code", "codex", "claude-code+codex"].includes(b.agent)) throw new ValidationError("unsupported agent");
  if (typeof b.generatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(b.generatedAt) || !Number.isFinite(Date.parse(b.generatedAt))) throw new ValidationError("generatedAt must be an ISO UTC date");
  const c = record(b.coherence, ["chainBreaks", "timeRegressions", "unknownEventRatio", "badJsonLines"], "coherence");
  const coherence = {
    chainBreaks: number(c.chainBreaks, 0, 1e9, "coherence.chainBreaks", true),
    timeRegressions: number(c.timeRegressions, 0, 1e9, "coherence.timeRegressions", true),
    unknownEventRatio: number(c.unknownEventRatio, 0, 1, "coherence.unknownEventRatio"),
    badJsonLines: number(c.badJsonLines, 0, 1e9, "coherence.badJsonLines", true),
  };
  if (!Array.isArray(b.projects) || b.projects.length > 1000) throw new ValidationError("projects must be an array of at most 1000 summaries");
  const projects: ProjectSummary[] = b.projects.map((p: unknown, i: number) => summary(p, `projects[${i}]`, true));
  if (new Set(projects.map(p => p.projectHash)).size !== projects.length) throw new ValidationError("duplicate project hashes");
  const overall = summary(b.overall, "overall");
  if (projects.length) {
    for (const k of ["episodes", "promptCount", "loopCount", "effectiveTokens", "weightedTokens"] as const) {
      const total = projects.reduce((sum, p) => sum + p[k], 0);
      if (Math.abs(total - overall[k]) > Math.max(0.01, Math.abs(total) * 1e-9)) throw new ValidationError(`project ${k} totals do not match overall`);
    }
  }
  return { schemaVersion: "0.1.0", agent: b.agent, generatedAt: b.generatedAt, coherence, projects, overall };
}

export function looksLikeBundle(input: unknown): input is Bundle {
  try { parseBundle(input); return true; } catch { return false; }
}
