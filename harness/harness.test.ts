import { test } from "node:test";
import assert from "node:assert/strict";

import { PERSONAS, mulberry32, hashSeed, type Tier } from "./personas.ts";
import { generateSession, DEFAULT_BASE_TS } from "./generate.ts";
import { simulateBuilder } from "./seed.ts";
import { parseSessionFile } from "../collector/src/parse.ts";
import { buildEpisodes } from "../collector/src/episodes.ts";
import { extractFeatures, type EpisodeFeatures } from "../collector/src/features.ts";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// (a) reproducibility — same seed → identical output & features
// ---------------------------------------------------------------------------

test("reproducibility: identical seed → identical JSONL", () => {
  for (const tier of Object.keys(PERSONAS) as Tier[]) {
    const a = generateSession(PERSONAS[tier], mulberry32(999), { sessionId: "s", baseTs: DEFAULT_BASE_TS });
    const b = generateSession(PERSONAS[tier], mulberry32(999), { sessionId: "s", baseTs: DEFAULT_BASE_TS });
    assert.deepEqual(a, b, `${tier} sessions diverged for identical seed`);
  }
});

test("reproducibility: identical seed → identical features", async () => {
  const s1 = await simulateBuilder(PERSONAS.builder, hashSeed(7, "builder", 0));
  const s2 = await simulateBuilder(PERSONAS.builder, hashSeed(7, "builder", 0));
  const strip = (f: EpisodeFeatures) => ({ ...f, projectHash: "", firstTs: 0, lastTs: 0 });
  assert.deepEqual(s1.feats.map(strip), s2.feats.map(strip));
});

// ---------------------------------------------------------------------------
// (c) generated JSONL parses cleanly
// ---------------------------------------------------------------------------

test("parse integrity: 0 unknownType, 0 badJson, 0 chainBreaks", async () => {
  for (const tier of Object.keys(PERSONAS) as Tier[]) {
    const lines = generateSession(PERSONAS[tier], mulberry32(123), { sessionId: "p", baseTs: DEFAULT_BASE_TS });
    const dir = mkdtempSync(join(tmpdir(), "vs-parse-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, lines.join("\n"));
    const parsed = await parseSessionFile(file, "sim-proj");
    assert.ok(parsed, `${tier} produced no parseable session`);
    assert.equal(parsed.stats.unknownType, 0, `${tier} unknownType`);
    assert.equal(parsed.stats.badJson, 0, `${tier} badJson`);
    assert.equal(parsed.stats.chainBreaks, 0, `${tier} chainBreaks`);
    assert.equal(parsed.stats.timeRegressions, 0, `${tier} timeRegressions`);
  }
});

// ---------------------------------------------------------------------------
// (b) tier separation — the whole point of the harness
// ---------------------------------------------------------------------------

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function tierFeats(tier: Tier, nBuilders: number): Promise<EpisodeFeatures[]> {
  const feats: EpisodeFeatures[] = [];
  for (let i = 0; i < nBuilders; i++) {
    const sim = await simulateBuilder(PERSONAS[tier], hashSeed(42, tier, i));
    feats.push(...sim.feats);
  }
  return feats;
}

test("tier separation: collector recovers the ground-truth ordering", async () => {
  const N = 5;
  const arch = await tierFeats("architect", N);
  const buil = await tierFeats("builder", N);
  const thra = await tierFeats("thrasher", N);

  const shipped = (fs: EpisodeFeatures[]) =>
    fs.filter((f) => f.outcome === "committed" || f.outcome === "verified").length / fs.length;

  const m = (fs: EpisodeFeatures[], key: keyof EpisodeFeatures) =>
    mean(fs.map((f) => f[key] as number));

  const table = {
    architect: {
      loopBurnFraction: m(arch, "loopBurnFraction"),
      correctionRatio: m(arch, "correctionRatio"),
      verifyAfterEditRatio: m(arch, "verifyAfterEditRatio"),
      firstPromptContextScore: m(arch, "firstPromptContextScore"),
      shipped: shipped(arch),
    },
    builder: {
      loopBurnFraction: m(buil, "loopBurnFraction"),
      correctionRatio: m(buil, "correctionRatio"),
      verifyAfterEditRatio: m(buil, "verifyAfterEditRatio"),
      firstPromptContextScore: m(buil, "firstPromptContextScore"),
      shipped: shipped(buil),
    },
    thrasher: {
      loopBurnFraction: m(thra, "loopBurnFraction"),
      correctionRatio: m(thra, "correctionRatio"),
      verifyAfterEditRatio: m(thra, "verifyAfterEditRatio"),
      firstPromptContextScore: m(thra, "firstPromptContextScore"),
      shipped: shipped(thra),
    },
  };
  console.error("tier means:\n" + JSON.stringify(table, null, 2));

  // loop burn: thrasher > builder > architect
  assert.ok(table.thrasher.loopBurnFraction > table.builder.loopBurnFraction,
    `loopBurn thrasher(${table.thrasher.loopBurnFraction}) > builder(${table.builder.loopBurnFraction})`);
  assert.ok(table.builder.loopBurnFraction > table.architect.loopBurnFraction,
    `loopBurn builder(${table.builder.loopBurnFraction}) > architect(${table.architect.loopBurnFraction})`);

  // corrections: thrasher > architect
  assert.ok(table.thrasher.correctionRatio > table.architect.correctionRatio,
    `correction thrasher(${table.thrasher.correctionRatio}) > architect(${table.architect.correctionRatio})`);

  // verify-after-edit: architect > thrasher
  assert.ok(table.architect.verifyAfterEditRatio > table.thrasher.verifyAfterEditRatio,
    `verify architect(${table.architect.verifyAfterEditRatio}) > thrasher(${table.thrasher.verifyAfterEditRatio})`);

  // first-prompt context: architect > builder > thrasher
  assert.ok(table.architect.firstPromptContextScore > table.builder.firstPromptContextScore,
    `context architect > builder`);
  assert.ok(table.builder.firstPromptContextScore > table.thrasher.firstPromptContextScore,
    `context builder > thrasher`);

  // shipping: architect > thrasher
  assert.ok(table.architect.shipped > table.thrasher.shipped,
    `shipped architect(${table.architect.shipped}) > thrasher(${table.thrasher.shipped})`);
});
