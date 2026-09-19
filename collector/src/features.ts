/**
 * Feature extractors — episode-level skill signals.
 *
 * Every function here consumes the numeric Event stream only; there is
 * no prose anywhere in this module by construction (see schema.ts).
 */

import type { Episode } from "./episodes.ts";
import type { Event, ToolCallRef } from "./schema.ts";

// ---------------------------------------------------------------------------
// Model capability weights (design fault #4: applied per message, not per
// session). Rough, config-level — cohort normalization does the real work
// server-side; these only keep mixed-model episodes comparable locally.
// ---------------------------------------------------------------------------

const CAPABILITY_WEIGHTS: Array<[RegExp, number]> = [
  [/fable|mythos/i, 1.4],
  [/opus/i, 1.25],
  [/sonnet/i, 1.0],
  [/haiku/i, 0.6],
];

export function capabilityWeight(model: string): number {
  for (const [re, w] of CAPABILITY_WEIGHTS) if (re.test(model)) return w;
  return 1.0;
}

/** Price-proportional token blend (Claude pricing ratios: out≈5×in, cacheWrite≈1.25×, cacheRead≈0.1×). */
function effectiveTokens(u: NonNullable<Event["usage"]>): number {
  return u.input + 5 * u.output + 1.25 * u.cacheWrite + 0.1 * u.cacheRead;
}

// ---------------------------------------------------------------------------

export interface EpisodeFeatures {
  projectHash: string;
  firstTs: number;
  lastTs: number;
  activeMinutes: number;

  // volume
  promptCount: number;
  assistantTurns: number;
  toolCallCount: number;
  sidechainTokenFraction: number;

  // efficiency
  rawTokensIn: number;
  rawTokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  effectiveTokens: number;          // price-proportional
  weightedTokens: number;           // effective × per-message capability weight
  tokensPerActiveMinute: number;

  // direction
  correctionCount: number;
  correctionRatio: number;          // corrections / prompts
  redirectCount: number;
  meanRedirectDepth: number;        // assistant turns to get back on track
  firstPromptContextScore: number;  // 0..1
  meanPromptSpecificity: number;    // constraint markers + file refs per prompt
  editsPerPrompt: number;           // scope proxy

  // failure loops
  loopCount: number;
  loopBurnTokens: number;
  loopBurnFraction: number;
  longestLoopCalls: number;

  // fluency
  toolSuccessRate: number;
  editCount: number;
  verifyAfterEditRatio: number;     // edit stretches followed by verification
  errorRecoveryRate: number;        // errors resolved within 2 assistant turns
  agenticLeverage: number;          // sidechain effective-token share (0..1)

  // shipping
  outcome: "committed" | "verified" | "error_abandon" | "short" | "ended";

  /** effective tokens per model id */
  modelHistogram: Record<string, number>;
}

interface ToolCallSite {
  ref: ToolCallRef;
  eventIndex: number;
  ts: number;
  isError: boolean | null; // null = result never seen
}

/** Grace window after an episode ends in which a git commit still counts as its outcome. */
export const COMMIT_GRACE_MS = 30 * 60 * 1000;

/**
 * @param commitTimestamps optional epoch-ms commit times from the project's
 * real git log, read locally. Fixes the manual-commit blindspot: users who
 * commit in a terminal after the session ended previously scored outcome
 * "ended" (observed in pilot data — Laksh bundle, shipping 0.00 artifact).
 */
export function extractFeatures(ep: Episode, commitTimestamps?: number[]): EpisodeFeatures {
  const events = ep.events;

  // ---- volume + efficiency accumulators ----
  let promptCount = 0, assistantTurns = 0;
  let rawIn = 0, rawOut = 0, cacheRead = 0, cacheWrite = 0;
  let eff = 0, weighted = 0, sidechainEff = 0;
  const modelHistogram: Record<string, number> = {};

  // ---- tool call index (id → site) ----
  const sites: ToolCallSite[] = [];
  const siteById = new Map<string, ToolCallSite>();

  // ---- direction accumulators ----
  const promptIndices: number[] = [];
  let correctionCount = 0, redirectCount = 0;
  let specificitySum = 0;
  let firstPromptContextScore = 0;
  let sawFirstPrompt = false;
  const redirectDepths: number[] = [];
  let pendingCorrectionAt = -1;

  events.forEach((ev, i) => {
    if (ev.kind === "prompt" && ev.prompt && !ev.isSidechain) {
      promptCount++;
      promptIndices.push(i);
      const p = ev.prompt;
      specificitySum += p.constraintMarkers + p.fileRefs;
      if (!sawFirstPrompt) {
        sawFirstPrompt = true;
        firstPromptContextScore = Math.min(1,
          0.4 * Math.min(p.words / 150, 1) +
          0.3 * (Math.min(p.fileRefs, 5) / 5) +
          0.3 * (Math.min(p.constraintMarkers, 8) / 8));
      }
      if (p.isCorrection) {
        correctionCount++;
        if (pendingCorrectionAt >= 0) {
          // correction while still correcting → depth extends; count turns so far
          redirectDepths.push(assistantTurnsBetween(events, pendingCorrectionAt, i));
        }
        pendingCorrectionAt = i;
      } else {
        if (p.isRedirect) redirectCount++;
        if (pendingCorrectionAt >= 0) {
          redirectDepths.push(assistantTurnsBetween(events, pendingCorrectionAt, i));
          pendingCorrectionAt = -1;
        }
      }
    }

    if (ev.kind === "assistant") {
      if (!ev.isSidechain) assistantTurns++;
      const u = ev.usage;
      if (u) {
        rawIn += u.input; rawOut += u.output;
        cacheRead += u.cacheRead; cacheWrite += u.cacheWrite;
        const e = effectiveTokens(u);
        eff += e;
        weighted += e * capabilityWeight(ev.model ?? "");
        if (ev.isSidechain) sidechainEff += e;
        const m = ev.model ?? "unknown";
        modelHistogram[m] = (modelHistogram[m] ?? 0) + e;
      }
      for (const ref of ev.toolCalls ?? []) {
        const site: ToolCallSite = { ref, eventIndex: i, ts: ev.ts, isError: null };
        sites.push(site);
        if (ref.id) siteById.set(ref.id, site);
      }
    }

    if (ev.kind === "tool_result" && ev.toolUseId) {
      const site = siteById.get(ev.toolUseId);
      if (site) site.isError = ev.isError === true;
    }
  });

  // ---- failure loops: same signature ≥3 times within a sliding window ----
  const WINDOW = 8, MIN_REPEATS = 3;
  const loopSpans: Array<[number, number]> = []; // [startEventIdx, endEventIdx]
  for (let i = 0; i < sites.length; i++) {
    let repeats = 1;
    let last = i;
    for (let j = i + 1; j < Math.min(i + WINDOW, sites.length); j++) {
      if (sites[j].ref.inputHash === sites[i].ref.inputHash) { repeats++; last = j; }
    }
    if (repeats >= MIN_REPEATS) {
      loopSpans.push([sites[i].eventIndex, sites[last].eventIndex]);
    }
  }
  const merged = mergeSpans(loopSpans);
  let loopBurnTokens = 0;
  let longestLoopCalls = 0;
  for (const [a, b] of merged) {
    let calls = 0;
    for (const s of sites) if (s.eventIndex >= a && s.eventIndex <= b) calls++;
    longestLoopCalls = Math.max(longestLoopCalls, calls);
    for (let i = a; i <= b; i++) {
      const ev = events[i];
      if (ev.kind === "assistant" && ev.usage) loopBurnTokens += effectiveTokens(ev.usage);
    }
  }

  // ---- fluency ----
  const resolved = sites.filter((s) => s.isError !== null);
  const errors = resolved.filter((s) => s.isError === true);
  const toolSuccessRate = resolved.length > 0 ? 1 - errors.length / resolved.length : 1;

  const editSites = sites.filter((s) => s.ref.klass === "edit");
  // edit stretches: runs of edit calls with <5 non-edit calls between
  const stretches: Array<[number, number]> = [];
  for (const s of editSites) {
    const lastStretch = stretches[stretches.length - 1];
    if (lastStretch && countSitesBetween(sites, lastStretch[1], s.eventIndex, "edit") < 5) {
      lastStretch[1] = s.eventIndex;
    } else {
      stretches.push([s.eventIndex, s.eventIndex]);
    }
  }
  let verifiedStretches = 0;
  stretches.forEach(([, end], idx) => {
    const nextStart = idx + 1 < stretches.length ? stretches[idx + 1][0] : events.length;
    const verified = sites.some((s) =>
      s.eventIndex > end && s.eventIndex < nextStart &&
      s.ref.looksLikeVerification && s.isError === false);
    if (verified) verifiedStretches++;
  });

  let recovered = 0;
  for (const errSite of errors) {
    const after = sites.filter((s) =>
      s.eventIndex > errSite.eventIndex &&
      s.ref.klass === errSite.ref.klass && s.isError === false);
    if (after.length > 0 &&
        assistantTurnsBetween(events, errSite.eventIndex, after[0].eventIndex) <= 2) {
      recovered++;
    }
  }

  // ---- outcome ----
  const tail = sites.slice(-Math.max(5, Math.floor(sites.length * 0.2)));
  const committedOutsideSession = (commitTimestamps ?? []).some(
    (t) => t >= ep.firstTs && t <= ep.lastTs + COMMIT_GRACE_MS);
  const committed = committedOutsideSession ||
    tail.some((s) => s.ref.looksLikeCommit && s.isError === false) ||
    sites.some((s) => s.ref.looksLikeCommit && s.isError === false &&
      s.eventIndex > events.length * 0.7);
  const verifiedEnd = tail.some((s) => s.ref.looksLikeVerification && s.isError === false);
  const tailResults = resolved.slice(-5);
  const errorEnd = tailResults.length >= 2 &&
    tailResults.filter((s) => s.isError).length >= Math.ceil(tailResults.length * 0.6);
  const outcome: EpisodeFeatures["outcome"] =
    promptCount < 3 && sites.length < 3 ? "short"
    : committed ? "committed"
    : verifiedEnd ? "verified"
    : errorEnd ? "error_abandon"
    : "ended";

  if (pendingCorrectionAt >= 0) {
    redirectDepths.push(assistantTurnsBetween(events, pendingCorrectionAt, events.length - 1));
  }

  const activeMinutes = ep.activeMs / 60_000;
  return {
    projectHash: ep.projectHash,
    firstTs: ep.firstTs,
    lastTs: ep.lastTs,
    activeMinutes: round2(activeMinutes),
    promptCount,
    assistantTurns,
    toolCallCount: sites.length,
    sidechainTokenFraction: eff > 0 ? round4(sidechainEff / eff) : 0,
    rawTokensIn: rawIn,
    rawTokensOut: rawOut,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    effectiveTokens: Math.round(eff),
    weightedTokens: Math.round(weighted),
    tokensPerActiveMinute: activeMinutes > 0 ? Math.round(eff / activeMinutes) : 0,
    correctionCount,
    correctionRatio: promptCount > 0 ? round4(correctionCount / promptCount) : 0,
    redirectCount,
    meanRedirectDepth: redirectDepths.length > 0 ? round2(mean(redirectDepths)) : 0,
    firstPromptContextScore: round4(firstPromptContextScore),
    meanPromptSpecificity: promptCount > 0 ? round2(specificitySum / promptCount) : 0,
    editsPerPrompt: promptCount > 0 ? round2(editSites.length / promptCount) : 0,
    loopCount: merged.length,
    loopBurnTokens: Math.round(loopBurnTokens),
    loopBurnFraction: eff > 0 ? round4(loopBurnTokens / eff) : 0,
    longestLoopCalls,
    toolSuccessRate: round4(toolSuccessRate),
    editCount: editSites.length,
    verifyAfterEditRatio: stretches.length > 0 ? round4(verifiedStretches / stretches.length) : 0,
    errorRecoveryRate: errors.length > 0 ? round4(recovered / errors.length) : 1,
    agenticLeverage: eff > 0 ? round4(sidechainEff / eff) : 0,
    outcome,
    // zero-token entries (e.g. "<synthetic>" harness messages) are noise, drop
    modelHistogram: Object.fromEntries(
      Object.entries(modelHistogram)
        .map(([k, v]) => [k, Math.round(v)] as [string, number])
        .filter(([, v]) => v > 0)),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Capped: beyond REDIRECT_DEPTH_CAP main-thread turns the agent is doing
 * delegated autonomous work, not thrashing — uncapped counts conflate the
 * two (observed: depth 217 on real logs where a correction preceded a long
 * healthy autonomous run).
 */
export const REDIRECT_DEPTH_CAP = 25;

function assistantTurnsBetween(events: Event[], fromIdx: number, toIdx: number): number {
  let n = 0;
  for (let i = fromIdx + 1; i < toIdx; i++) {
    if (events[i].kind === "assistant" && !events[i].isSidechain) n++;
    if (n >= REDIRECT_DEPTH_CAP) return REDIRECT_DEPTH_CAP;
  }
  return n;
}

function countSitesBetween(
  sites: ToolCallSite[], fromEventIdx: number, toEventIdx: number,
  excludeKlass: string,
): number {
  return sites.filter((s) =>
    s.eventIndex > fromEventIdx && s.eventIndex < toEventIdx &&
    s.ref.klass !== excludeKlass).length;
}

function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0].slice() as [number, number]];
  for (const [a, b] of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function round2(x: number): number { return Math.round(x * 100) / 100; }
function round4(x: number): number { return Math.round(x * 10_000) / 10_000; }
