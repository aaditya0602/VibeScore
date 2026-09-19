import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzePrompt, parseSessionFile } from "../src/parse.ts";
import { buildEpisodes } from "../src/episodes.ts";
import { extractFeatures } from "../src/features.ts";
import type { ParsedSession } from "../src/schema.ts";

// ---------------------------------------------------------------------------
// fixture builders — synthetic Claude Code JSONL
// ---------------------------------------------------------------------------

let uuidCounter = 0;
function uid(): string { return `u-${++uuidCounter}`; }

function baseFields(ts: number, parent: string | null, sidechain = false) {
  return {
    uuid: uid(),
    parentUuid: parent,
    sessionId: "sess-1",
    timestamp: new Date(ts).toISOString(),
    isSidechain: sidechain,
    version: "2.0.0",
    gitBranch: "main",
    cwd: "C:/proj",
  };
}

function userLine(ts: number, parent: string | null, text: string) {
  return { type: "user", ...baseFields(ts, parent), message: { role: "user", content: text } };
}

function toolResultLine(ts: number, parent: string | null, toolUseId: string, isError = false) {
  return {
    type: "user", ...baseFields(ts, parent),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError }] },
  };
}

function assistantLine(
  ts: number, parent: string | null,
  opts: { model?: string; out?: number; tools?: Array<{ name: string; input: any; id: string }>; sidechain?: boolean } = {},
) {
  const content: any[] = [{ type: "text", text: "ok." }];
  for (const t of opts.tools ?? []) {
    content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
  }
  return {
    type: "assistant", ...baseFields(ts, parent, opts.sidechain ?? false),
    requestId: "req-" + uid(),
    message: {
      role: "assistant", model: opts.model ?? "claude-sonnet-5", content,
      usage: {
        input_tokens: 100, output_tokens: opts.out ?? 200,
        cache_read_input_tokens: 1000, cache_creation_input_tokens: 50,
      },
    },
  };
}

function writeFixture(lines: any[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vs-test-"));
  const p = join(dir, "session.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
  return p;
}

// ---------------------------------------------------------------------------
// prompt analysis
// ---------------------------------------------------------------------------

test("analyzePrompt: correction detection", () => {
  assert.equal(analyzePrompt("no, that's wrong, revert it").isCorrection, true);
  assert.equal(analyzePrompt("nope").isCorrection, true);
  assert.equal(analyzePrompt("add a login page with tests").isCorrection, false);
  // long prompt starting with "no" but not a short negation
  const long = "notice that the config file must support yaml " + "x".repeat(150);
  assert.equal(analyzePrompt(long).isCorrection, false);
});

test("analyzePrompt: redirect vs correction precedence", () => {
  const p = analyzePrompt("actually, let's use postgres instead");
  assert.equal(p.isCorrection, false);
  assert.equal(p.isRedirect, true);
});

test("analyzePrompt: context features", () => {
  const p = analyzePrompt(
    "Build auth in src/auth.ts and src/db.ts. Must use argon2, don't store plaintext. Make sure tests pass.");
  assert.ok(p.fileRefs >= 2, `fileRefs=${p.fileRefs}`);
  assert.ok(p.constraintMarkers >= 3, `constraints=${p.constraintMarkers}`);
  assert.equal(p.codeFences, 0);
});

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

test("parser: privacy — no prose in events", async () => {
  const secret = "SUPER_SECRET_API_KEY_abc123";
  const f = writeFixture([
    userLine(1000, null, `here is my key ${secret} fix the bug in main.py`),
    assistantLine(2000, "u-1"),
  ]);
  const parsed = await parseSessionFile(f, "C--proj");
  assert.ok(parsed);
  assert.ok(!JSON.stringify(parsed).includes(secret), "raw text leaked into events");
});

test("parser: tolerant of bad json and unknown types", async () => {
  const f = writeFixture([
    userLine(1000, null, "hello build me an app"),
    { type: "brand-new-event-type-from-future-version", data: 1 },
    assistantLine(2000, "u-1"),
  ]);
  // inject a corrupt line
  const { appendFileSync } = await import("node:fs");
  appendFileSync(f, "\n{this is not json");
  const parsed = await parseSessionFile(f, "C--proj");
  assert.ok(parsed);
  assert.equal(parsed.stats.badJson, 1);
  assert.equal(parsed.stats.unknownType, 1);
  assert.equal(parsed.events.length, 2);
});

test("parser: tool_use / tool_result pairing survives", async () => {
  const f = writeFixture([
    userLine(1000, null, "run the tests"),
    assistantLine(2000, "u-1", { tools: [{ name: "Bash", input: { command: "npm test" }, id: "t1" }] }),
    toolResultLine(3000, "u-2", "t1", false),
  ]);
  const parsed = await parseSessionFile(f, "C--proj");
  assert.ok(parsed);
  const tr = parsed.events.find((e) => e.kind === "tool_result");
  assert.equal(tr?.toolUseId, "t1");
  assert.equal(tr?.isError, false);
});

// ---------------------------------------------------------------------------
// episodes + features
// ---------------------------------------------------------------------------

async function sessionFromLines(lines: any[]): Promise<ParsedSession> {
  const parsed = await parseSessionFile(writeFixture(lines), "C--proj");
  assert.ok(parsed);
  return parsed;
}

test("episodes: gap splitting", async () => {
  const HOUR = 3600_000;
  const s1 = await sessionFromLines([
    userLine(0, null, "start feature"),
    assistantLine(1 * HOUR, "u-1"),
  ]);
  const s2 = await sessionFromLines([
    userLine(10 * HOUR, null, "continue"),  // 9h gap → new episode
    assistantLine(10 * HOUR + 60_000, "u-1"),
  ]);
  const eps = buildEpisodes([s1, s2]);
  assert.equal(eps.length, 2);
});

test("features: correction ratio + loop detection + verification", async () => {
  let t = 0;
  const step = () => (t += 60_000);
  const loopTool = (id: string) =>
    ({ name: "Bash", input: { command: "npm test -- --run flaky" }, id });
  const lines = [
    userLine(step(), null, "build a REST API in src/api.ts, must validate inputs"),
    assistantLine(step(), null, { tools: [{ name: "Write", input: { file_path: "src/api.ts", content: "..." }, id: "w1" }] }),
    toolResultLine(step(), null, "w1", false),
    // failure loop: same command 3× with errors
    assistantLine(step(), null, { tools: [loopTool("b1")] }),
    toolResultLine(step(), null, "b1", true),
    assistantLine(step(), null, { tools: [loopTool("b2")] }),
    toolResultLine(step(), null, "b2", true),
    assistantLine(step(), null, { tools: [loopTool("b3")] }),
    toolResultLine(step(), null, "b3", true),
    // user corrects
    userLine(step(), null, "stop, that's wrong, the test command doesn't work"),
    assistantLine(step(), null, { tools: [{ name: "Bash", input: { command: "npm run build" }, id: "b4" }] }),
    toolResultLine(step(), null, "b4", false),
    userLine(step(), null, "great, now commit it"),
    assistantLine(step(), null, { tools: [{ name: "Bash", input: { command: "git commit -m done" }, id: "g1" }] }),
    toolResultLine(step(), null, "g1", false),
  ];
  const s = await sessionFromLines(lines);
  const [ep] = buildEpisodes([s]);
  const f = extractFeatures(ep);

  assert.equal(f.promptCount, 3);
  assert.equal(f.correctionCount, 1);
  assert.ok(Math.abs(f.correctionRatio - 1 / 3) < 0.01);
  assert.ok(f.loopCount >= 1, `loopCount=${f.loopCount}`);
  assert.ok(f.loopBurnTokens > 0);
  assert.equal(f.outcome, "committed");
  assert.ok(f.verifyAfterEditRatio > 0, "build after edit should count as verification");
  assert.ok(f.toolSuccessRate < 1);
});

test("features: sidechain tokens attributed as agentic leverage", async () => {
  const lines = [
    userLine(1000, null, "use a subagent to explore the codebase then summarize"),
    assistantLine(2000, "u-1", { tools: [{ name: "Agent", input: { prompt: "explore" }, id: "a1" }] }),
    assistantLine(3000, null, { sidechain: true, out: 5000 }),
    assistantLine(4000, null, { sidechain: true, out: 5000 }),
    toolResultLine(5000, "u-2", "a1", false),
    assistantLine(6000, null, { out: 300 }),
  ];
  const s = await sessionFromLines(lines);
  const [ep] = buildEpisodes([s]);
  const f = extractFeatures(ep);
  assert.ok(f.agenticLeverage > 0.5, `agenticLeverage=${f.agenticLeverage}`);
  // sidechain assistant turns must not count as main-thread turns
  assert.equal(f.assistantTurns, 2);
});

test("features: out-of-session commit flips outcome to committed", async () => {
  const lines = [
    userLine(1000, null, "build the parser module with full error handling"),
    assistantLine(60_000, "u-1", { tools: [{ name: "Write", input: { file_path: "src/p.ts", content: "..." }, id: "w1" }] }),
    toolResultLine(120_000, null, "w1", false),
    userLine(180_000, null, "now add the reader module in src/r.ts"),
    assistantLine(240_000, null, { tools: [{ name: "Write", input: { file_path: "src/r.ts", content: "..." }, id: "w2" }] }),
    toolResultLine(300_000, null, "w2", false),
    userLine(360_000, null, "looks good, I'll take it from here"),
    assistantLine(420_000, null, { tools: [{ name: "Read", input: { file_path: "src/r.ts" }, id: "r1" }] }),
    toolResultLine(480_000, null, "r1", false),
  ];
  const s = await sessionFromLines(lines);
  const [ep] = buildEpisodes([s]);
  // no commit inside the session…
  assert.equal(extractFeatures(ep).outcome, "ended");
  // …but a real git commit 10 min after the episode = committed
  const commitTs = [ep.lastTs + 10 * 60_000];
  assert.equal(extractFeatures(ep, commitTs).outcome, "committed");
  // commit far outside the grace window does not count
  const lateCommit = [ep.lastTs + 3 * 60 * 60_000];
  assert.equal(extractFeatures(ep, lateCommit).outcome, "ended");
});

test("features: zero-token models dropped from histogram", async () => {
  const lines = [
    userLine(1000, null, "quick thing"),
    { type: "assistant", ...baseFields(2000, "u-1"),
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "x" }],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    assistantLine(3000, null, { out: 500 }),
  ];
  const s = await sessionFromLines(lines);
  const [ep] = buildEpisodes([s]);
  const f = extractFeatures(ep);
  assert.ok(!("<synthetic>" in f.modelHistogram), "zero-token synthetic model should be filtered");
  assert.ok(Object.keys(f.modelHistogram).length === 1);
});

test("features: mixed-model per-message weighting (design fault #4)", async () => {
  const lines = [
    userLine(1000, null, "do a thing"),
    assistantLine(2000, "u-1", { model: "claude-haiku-4-5", out: 1000 }),
    assistantLine(3000, null, { model: "claude-opus-4-8", out: 1000 }),
  ];
  const s = await sessionFromLines(lines);
  const [ep] = buildEpisodes([s]);
  const f = extractFeatures(ep);
  assert.ok(Object.keys(f.modelHistogram).length === 2);
  // weighted ≠ effective when models differ in capability weight
  assert.notEqual(f.weightedTokens, f.effectiveTokens);
});
