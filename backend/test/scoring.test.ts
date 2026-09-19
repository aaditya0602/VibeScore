import { test } from "node:test";
import assert from "node:assert/strict";
import { percentile, scorePopulation } from "../src/scoring.ts";
import type { PopulationEntry } from "../src/store.ts";
import type { Bundle } from "../../collector/src/report.ts";

function fakeBundle(overrides: Partial<Bundle["overall"]> = {}, coherence: Partial<Bundle["coherence"]> = {}): Bundle {
  const overall: Bundle["overall"] = {
    episodes: 10, activeMinutes: 600, promptCount: 100,
    effectiveTokens: 10_000_000, weightedTokens: 10_000_000,
    correctionRatio: 0.05, meanRedirectDepth: 5,
    firstPromptContextScore: 0.4, meanPromptSpecificity: 3,
    editsPerPrompt: 3, loopBurnFraction: 0.2, loopCount: 10,
    toolSuccessRate: 0.95, verifyAfterEditRatio: 0.4,
    errorRecoveryRate: 0.6, agenticLeverage: 0,
    outcomes: { committed: 5, ended: 5 },
    modelHistogram: { "claude-sonnet-5": 10_000_000 },
    ...overrides,
  };
  if (overrides.episodes !== undefined && overrides.outcomes === undefined) {
    overall.outcomes = { ended: overall.episodes };
  }
  return {
    schemaVersion: "0.1.0", agent: "claude-code",
    generatedAt: new Date().toISOString(),
    coherence: {
      chainBreaks: 50, timeRegressions: 0, unknownEventRatio: 0.01,
      badJsonLines: 0, ...coherence,
    },
    projects: [], overall,
  };
}

function entry(handle: string, overrides: Partial<Bundle["overall"]> = {},
  coherence: Partial<Bundle["coherence"]> = {}): PopulationEntry {
  return { handle, synthetic: false, bundle: fakeBundle(overrides, coherence) };
}

test("percentile: midrank behavior", () => {
  assert.equal(percentile(5, [1, 2, 3, 4]), 100);
  assert.equal(percentile(0, [1, 2, 3, 4]), 0);
  assert.equal(percentile(2, [1, 2, 3]), 50); // one below, one equal (half), one above
  assert.equal(percentile(7, []), 50);        // empty population → neutral
});

test("scoring: strong profile outranks weak profile", () => {
  const pop = [
    entry("strong", {
      correctionRatio: 0.02, loopBurnFraction: 0.06, verifyAfterEditRatio: 0.75,
      firstPromptContextScore: 0.8, toolSuccessRate: 0.99, errorRecoveryRate: 0.9,
      outcomes: { committed: 9, ended: 1 },
    }),
    entry("mid", {}),
    entry("weak", {
      correctionRatio: 0.14, loopBurnFraction: 0.4, verifyAfterEditRatio: 0.05,
      firstPromptContextScore: 0.1, toolSuccessRate: 0.88, errorRecoveryRate: 0.3,
      outcomes: { ended: 8, error_abandon: 2 },
    }),
  ];
  const scores = scorePopulation(pop);
  const byHandle = new Map(scores.map((s) => [s.handle, s]));
  assert.ok(byHandle.get("strong")!.rating > byHandle.get("mid")!.rating);
  assert.ok(byHandle.get("mid")!.rating > byHandle.get("weak")!.rating);
  // subscores are 0-100 percentiles
  for (const s of scores) {
    for (const v of Object.values(s.subscores)) {
      assert.ok(v >= 0 && v <= 100);
    }
  }
});

test("scoring: thin history widens RD and marks provisional", () => {
  const pop = [
    entry("thick", { episodes: 30 }),
    entry("thin", { episodes: 1 }),
  ];
  const scores = scorePopulation(pop);
  const thick = scores.find((s) => s.handle === "thick")!;
  const thin = scores.find((s) => s.handle === "thin")!;
  assert.ok(thin.rd > thick.rd);
  assert.equal(thin.tier, "provisional");
});

test("scoring: coherence flags widen RD", () => {
  const pop = [
    entry("clean", { episodes: 10 }),
    entry("dirty", { episodes: 10 }, { badJsonLines: 4, timeRegressions: 40 }),
  ];
  const scores = scorePopulation(pop);
  const clean = scores.find((s) => s.handle === "clean")!;
  const dirty = scores.find((s) => s.handle === "dirty")!;
  assert.ok(dirty.rd >= clean.rd + 75);
  assert.equal(dirty.coherenceOk, false);
  assert.equal(clean.coherenceOk, true);
});

test("scoring: geometric mean punishes a cratered dimension", () => {
  const pop = [
    // identical except one ships nothing at all
    entry("ships", { outcomes: { committed: 10 } }),
    entry("never-ships", { outcomes: { ended: 10 } }),
    entry("filler-a", { correctionRatio: 0.08 }),
    entry("filler-b", { correctionRatio: 0.03 }),
  ];
  const scores = scorePopulation(pop);
  const ships = scores.find((s) => s.handle === "ships")!;
  const never = scores.find((s) => s.handle === "never-ships")!;
  assert.ok(ships.rating - never.rating > 50,
    `expected shipping crater to cost >50 rating, got ${ships.rating - never.rating}`);
});

test("scoring: imported evidence stays provisional and synthetic accounts cannot affect real scores", () => {
  const real = entry("real", { episodes: 10_000 });
  const baseline = scorePopulation([real]);
  const mixed = scorePopulation([real, { ...entry("synthetic"), synthetic: true }]);
  assert.deepEqual(mixed, baseline);
  assert.equal(baseline[0].tier, "provisional");
  assert.equal(baseline[0].evidence, "self-reported");
  assert.ok(baseline[0].rd >= 160);
});

test("scoring: malformed evidence is rejected before producing scores", () => {
  assert.throws(() => scorePopulation([entry("bad", { episodes: -4 })]), /episodes/);
  assert.throws(() => scorePopulation([entry("bad", { toolSuccessRate: NaN })]), /finite/);
});
