import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtmlReport } from "../src/html.ts";
import type { ProjectSummary, Bundle } from "../src/report.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectHash: "abc123def456abc123def456",
    label: "my-project",
    episodes: 3,
    activeMinutes: 145.2,
    promptCount: 27,
    effectiveTokens: 1_250_000,
    weightedTokens: 900_000,
    correctionRatio: 0.12,
    meanRedirectDepth: 1.4,
    firstPromptContextScore: 0.63,
    meanPromptSpecificity: 2.1,
    editsPerPrompt: 1.8,
    loopBurnFraction: 0.08,
    loopCount: 2,
    toolSuccessRate: 0.94,
    verifyAfterEditRatio: 0.55,
    errorRecoveryRate: 0.8,
    agenticLeverage: 0.4,
    outcomes: { committed: 2, ended: 1 },
    modelHistogram: { "claude-fable-5": 1_200_000, "claude-haiku-x": 0 },
    ...overrides,
  };
}

function makeBundle(summaries: ProjectSummary[]): Bundle {
  const overall: Bundle["overall"] = (() => {
    const { projectHash, label, ...rest } = makeSummary();
    return rest;
  })();
  return {
    schemaVersion: "0.1.0",
    agent: "claude-code",
    generatedAt: "2026-07-10T12:00:00.000Z",
    coherence: {
      chainBreaks: 0,
      timeRegressions: 0,
      unknownEventRatio: 0.01,
      badJsonLines: 0,
    },
    projects: summaries.map(({ label, ...rest }) => rest),
    overall,
  };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test("starts with an HTML doctype", () => {
  const summaries = [makeSummary()];
  const html = renderHtmlReport(summaries, makeBundle(summaries));
  assert.ok(/^<!doctype html>/i.test(html.trimStart()), "expected leading <!doctype html>");
});

test("contains the trust banner", () => {
  const summaries = [makeSummary()];
  const html = renderHtmlReport(summaries, makeBundle(summaries));
  assert.ok(html.includes("no LLM, no network"));
  assert.ok(html.includes("2026-07-10T12:00:00.000Z"), "generatedAt timestamp shown");
  assert.ok(html.includes("0.1.0"), "schemaVersion shown");
});

test("shows the project label", () => {
  const summaries = [makeSummary({ label: "vibescore-collector" })];
  const html = renderHtmlReport(summaries, makeBundle(summaries));
  assert.ok(html.includes("vibescore-collector"));
});

test("escapes hostile labels", () => {
  const summaries = [makeSummary({ label: '<script>alert("x")</script>' })];
  const html = renderHtmlReport(summaries, makeBundle(summaries));
  assert.ok(!html.includes("<script>"), "raw <script> must not appear");
  assert.ok(html.includes("&lt;script&gt;"), "escaped form must appear");
});

test("makes no external references (self-contained)", () => {
  const summaries = [
    makeSummary(),
    makeSummary({ projectHash: "fff000fff000fff000", label: undefined }),
  ];
  const html = renderHtmlReport(summaries, makeBundle(summaries));
  assert.ok(!html.includes("http://"), "no http:// URLs");
  assert.ok(!html.includes("https://"), "no https:// URLs");
});

test("skips zero-token model histogram entries and falls back to truncated hash", () => {
  const summaries = [makeSummary({ label: undefined })];
  const html = renderHtmlReport(summaries, makeBundle(summaries));
  assert.ok(!html.includes("claude-haiku-x"), "zero-token model omitted");
  assert.ok(html.includes("claude-fable-5"), "nonzero-token model shown");
  assert.ok(html.includes("abc123def456"), "truncated projectHash used as title");
});
