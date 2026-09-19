import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexSessionFile, findCodexSessionFiles } from "../src/parse-codex.ts";

// ---------------------------------------------------------------------------
// fixture builders — synthetic Codex rollout JSONL mirroring the real format:
// every line is { timestamp, type, payload }, with response_item / event_msg
// payloads keyed by payload.type.
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-07-01T10:00:00.000Z");
const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

const SECRET = "hunter2-super-secret-prompt-text-XYZZY";
const FIXTURE_CWD = "C:\\Users\\someone\\projects\\demo";

function fixtureLines(): any[] {
  return [
    {
      timestamp: iso(0), type: "session_meta",
      payload: {
        id: "0197-test-session-id", timestamp: iso(0), cwd: FIXTURE_CWD,
        originator: "codex_cli_rs", cli_version: "0.99.0", source: "cli",
        model_provider: "openai",
      },
    },
    {
      timestamp: iso(1), type: "turn_context",
      payload: { turn_id: "turn-1", cwd: FIXTURE_CWD, model: "gpt-5.2-codex", approval_policy: "never" },
    },
    {
      timestamp: iso(2), type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1", model_context_window: 272000 },
    },
    {
      timestamp: iso(3), type: "event_msg",
      payload: { type: "user_message", message: `fix the failing test, ${SECRET}. don't touch config.yaml`, images: [] },
    },
    // user-role response_item duplicating the prompt (must NOT double count)
    {
      timestamp: iso(3), type: "response_item",
      payload: {
        type: "message", role: "user",
        content: [{ type: "input_text", text: `fix the failing test, ${SECRET}. don't touch config.yaml` }],
      },
    },
    {
      timestamp: iso(4), type: "response_item",
      payload: { type: "reasoning", summary: [{ type: "summary_text", text: "thinking about the fix" }], content: null, encrypted_content: "AAAA" },
    },
    // assistant tool call (exec via custom_tool_call, raw command string input)
    {
      timestamp: iso(5), type: "response_item",
      payload: { type: "custom_tool_call", status: "completed", call_id: "call-1", name: "exec", input: "npm test --silent" },
    },
    // matching end event with a failing exit code → tool_result.isError
    {
      timestamp: iso(6), type: "event_msg",
      payload: { type: "exec_command_end", call_id: "call-1", turn_id: "turn-1", exit_code: 1, stdout: "", stderr: "1 failing" },
    },
    {
      timestamp: iso(6), type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call-1", output: "1 test failing: expected 2 to equal 3" },
    },
    // an edit tool call
    {
      timestamp: iso(7), type: "response_item",
      payload: { type: "custom_tool_call", status: "completed", call_id: "call-2", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/math.ts\n-  return a - b;\n+  return a + b;\n*** End Patch" },
    },
    {
      timestamp: iso(8), type: "event_msg",
      payload: { type: "patch_apply_end", call_id: "call-2", turn_id: "turn-1", success: true },
    },
    {
      timestamp: iso(8), type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call-2", output: "Done!" },
    },
    // final assistant message
    {
      timestamp: iso(9), type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed the sign error and the test passes now." }] },
    },
    // token usage arrives after the message → folded into that assistant event
    {
      timestamp: iso(10), type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 900, reasoning_output_tokens: 300, total_tokens: 5900 },
          last_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 900, reasoning_output_tokens: 300, total_tokens: 5900 },
          model_context_window: 272000,
        },
        rate_limits: {},
      },
    },
    {
      timestamp: iso(11), type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "Fixed.", duration_ms: 9000 },
    },
  ];
}

function writeFixture(lines: (any | string)[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vs-codex-test-"));
  const p = join(dir, "rollout-2026-07-01T10-00-00-01234567-89ab-cdef-0123-456789abcdef.jsonl");
  writeFileSync(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
  return p;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test("codex: parses rollout into common-schema events of the right kinds", async () => {
  const session = await parseCodexSessionFile(writeFixture(fixtureLines()));
  assert.ok(session, "session should parse");
  const kinds = session.events.map((e) => e.kind);

  assert.equal(kinds.filter((k) => k === "prompt").length, 1, "exactly one prompt (no double count from response_item user message)");
  assert.equal(kinds.filter((k) => k === "tool_result").length, 2);
  assert.equal(kinds.filter((k) => k === "system").length, 2); // task_started + task_complete
  // assistant events: two tool calls + one final message
  assert.equal(kinds.filter((k) => k === "assistant").length, 3);

  assert.equal(session.sessionId, "0197-test-session-id");
  assert.equal(session.stats.badJson, 0);
  assert.equal(session.stats.unknownType, 0);
  assert.equal(session.stats.chainBreaks, 0);
  assert.ok(session.firstTs > 0 && session.lastTs >= session.firstTs);
});

test("codex: privacy — prompt text, commands and paths never appear in the result", async () => {
  const session = await parseCodexSessionFile(writeFixture(fixtureLines()));
  assert.ok(session);
  const flat = JSON.stringify(session);
  assert.ok(!flat.includes(SECRET), "secret prompt text must not leak");
  assert.ok(!flat.includes("npm test"), "exec command must not leak");
  assert.ok(!flat.includes("math.ts"), "patched file path must not leak");
  // localCwd is the ONE sanctioned local-only prose field; everything else
  // must be free of the cwd too.
  const { localCwd, ...rest } = session;
  assert.ok(!JSON.stringify(rest).includes("demo"), "cwd must not leak outside localCwd");

  // prompt reduced to numbers, and the analyzer saw the real text
  const prompt = session.events.find((e) => e.kind === "prompt");
  assert.ok(prompt?.prompt);
  assert.ok(prompt.prompt.chars > SECRET.length);
  assert.ok(prompt.prompt.fileRefs >= 1, "config.yaml counts as a file ref");
});

test("codex: localCwd and projectHash recovered from session_meta", async () => {
  const session = await parseCodexSessionFile(writeFixture(fixtureLines()));
  assert.ok(session);
  assert.equal(session.localCwd, FIXTURE_CWD);
  assert.ok(/^[0-9a-f]{16}$/.test(session.projectHash));
  for (const ev of session.events) assert.equal(ev.projectHash, session.projectHash);
});

test("codex: tool calls classified and errors propagated to tool_result", async () => {
  const session = await parseCodexSessionFile(writeFixture(fixtureLines()));
  assert.ok(session);
  const withTools = session.events.filter((e) => (e.toolCalls?.length ?? 0) > 0);
  assert.equal(withTools.length, 2);

  const execCall = withTools[0].toolCalls![0];
  assert.equal(execCall.klass, "exec");
  assert.equal(execCall.looksLikeVerification, true, "npm test is a verification command");
  assert.equal(execCall.looksLikeCommit, false);
  assert.ok(/^[0-9a-f]{16}$/.test(execCall.inputHash));

  const editCall = withTools[1].toolCalls![0];
  assert.equal(editCall.klass, "edit");

  const results = session.events.filter((e) => e.kind === "tool_result");
  const r1 = results.find((r) => r.toolUseId === "call-1");
  const r2 = results.find((r) => r.toolUseId === "call-2");
  assert.equal(r1?.isError, true, "exit_code 1 → isError");
  assert.equal(r2?.isError, false, "successful patch → not an error");
});

test("codex: assistant message carries model, usage, and thinkingChars", async () => {
  const session = await parseCodexSessionFile(writeFixture(fixtureLines()));
  assert.ok(session);
  const assistants = session.events.filter((e) => e.kind === "assistant");
  const msg = assistants[assistants.length - 1]; // the final text message
  assert.equal(msg.model, "gpt-5.2-codex");
  assert.ok((msg.textChars ?? 0) > 0);
  // token_count after the message folds into it; input split into uncached+cached
  assert.deepEqual(msg.usage, { input: 1000, output: 900, cacheRead: 4000, cacheWrite: 0 });
  // reasoning item before the first tool call folds into that assistant event
  const first = assistants[0];
  assert.ok((first.thinkingChars ?? 0) > 0);
  assert.equal(session.events.find((e) => e.kind === "prompt")!.agentVersion, "0.99.0");
});

test("codex: malformed line increments badJson without throwing", async () => {
  const lines: (any | string)[] = fixtureLines();
  lines.splice(4, 0, "{this is not json", '{"type": "some_future_thing", "payload": {}}');
  const session = await parseCodexSessionFile(writeFixture(lines));
  assert.ok(session);
  assert.equal(session.stats.badJson, 1);
  assert.equal(session.stats.unknownType, 1);
  assert.equal(session.events.filter((e) => e.kind === "prompt").length, 1, "good lines still parsed");
});

test("codex: findCodexSessionFiles tolerates a missing root", async () => {
  const missing = join(tmpdir(), "vs-codex-definitely-missing-" + Date.now());
  assert.deepEqual(await findCodexSessionFiles(missing), []);
});

test("codex: findCodexSessionFiles walks nested year/month/day dirs", async () => {
  const root = mkdtempSync(join(tmpdir(), "vs-codex-walk-"));
  const nested = join(root, "2026", "07", "01");
  mkdirSync(nested, { recursive: true });
  const a = join(nested, "rollout-a.jsonl");
  writeFileSync(a, "");
  writeFileSync(join(nested, "notes.txt"), "ignore me");
  const found = await findCodexSessionFiles(root);
  assert.deepEqual(found, [a]);
});
