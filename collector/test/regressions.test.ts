import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseSessionFile, projectIdentity, findClaudeSessionFiles } from "../src/parse.ts";
import { parseCodexSessionFile } from "../src/parse-codex.ts";
import { buildEpisodes } from "../src/episodes.ts";
import { extractFeatures } from "../src/features.ts";
import { buildBundle, summarize } from "../src/report.ts";

const root = mkdtempSync(join(tmpdir(), "vibescore-regression-"));
process.env.VIBESCORE_HOME = join(root, "private-config");
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const cwd = join(root, "private-project");
const ts = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
function fixture(path: string, lines: any[]): string {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
  return path;
}
function claude(type: string, n: number, content: any) {
  return { type, uuid: `claude-${n}`, sessionId: "claude-session", timestamp: ts(n), cwd,
    message: { role: type, model: "test-model", content,
      usage: { input_tokens: 100, output_tokens: 10 } } };
}
function codex(type: string, n: number, payload: any) { return { type, timestamp: ts(n), payload }; }

test("identity: same cwd shares a private stable identity across adapters and processes", async () => {
  const a = await parseSessionFile(fixture(join(root, "identity-claude.jsonl"), [claude("user", 1, "private prompt")]), "encoded-folder");
  const b = await parseCodexSessionFile(fixture(join(root, "identity-codex.jsonl"), [
    codex("session_meta", 0, { id: "codex-session", cwd }),
    codex("event_msg", 2, { type: "user_message", message: "private prompt" }),
  ]));
  assert.ok(a && b);
  assert.equal(a.projectHash, b.projectHash);
  assert.equal(projectIdentity("C:\\Projects\\Demo\\"), projectIdentity("c:/projects/demo"));
  const moduleUrl = new URL("../src/parse.ts", import.meta.url).href;
  const hashInChild = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import {projectIdentity} from ${JSON.stringify(moduleUrl)}; console.log(projectIdentity(${JSON.stringify(cwd)}));`], { encoding: "utf8" }).trim();
  assert.equal(hashInChild, a.projectHash);
  const feats = buildEpisodes([a, b]).map((ep) => extractFeatures(ep));
  const bundle = JSON.stringify(buildBundle([summarize(a.projectHash, feats)], feats, [a.stats, b.stats]));
  assert.equal(bundle.includes("private-project"), false);
  assert.equal(bundle.includes("private prompt"), false);
  assert.equal(bundle.includes(readFileSync(join(process.env.VIBESCORE_HOME!, "project-identity.key")).toString("hex")), false);
});

test("codex: namespaced command/edit tools and subagents retain their meaning", async () => {
  const session = await parseCodexSessionFile(fixture(join(root, "tools.jsonl"), [
    codex("session_meta", 0, { id: "child", cwd, source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } }),
    codex("response_item", 1, { type: "function_call", name: "functions.exec_command", call_id: "t", arguments: JSON.stringify({ cmd: "npm test" }) }),
    codex("response_item", 2, { type: "custom_tool_call", name: "functions.apply_patch", call_id: "e", input: "patch" }),
    codex("response_item", 3, { type: "function_call", name: "exec_command", call_id: "c", arguments: JSON.stringify({ cmd: "git commit -m done" }) }),
  ]));
  assert.ok(session);
  const calls = session.events.flatMap((event) => event.toolCalls ?? []);
  assert.equal(calls[0].klass, "exec");
  assert.equal(calls[0].looksLikeVerification, true);
  assert.equal(calls[1].klass, "edit");
  assert.equal(calls[2].looksLikeCommit, true);
  assert.ok(session.events.every((event) => event.isSidechain));
});

test("features: an unfinished verification or commit never earns success credit", async () => {
  const lines = [claude("user", 1, "build"), ...[
    ["Write", { file_path: "src/a.ts", content: "a" }],
    ["Bash", { command: "npm test" }],
    ["Bash", { command: "git commit -m done" }],
  ].map(([name, input], index) => claude("assistant", index + 2, [{ type: "tool_use", id: `tool-${index}`, name, input }]))];
  const session = await parseSessionFile(fixture(join(root, "unfinished.jsonl"), lines), "project");
  assert.ok(session);
  const features = extractFeatures(buildEpisodes([session])[0]);
  assert.equal(features.verifyAfterEditRatio, 0);
  assert.equal(features.outcome, "ended");
});

test("CLI: Codex-only setup works and nested Claude work merges into the same project", async () => {
  const codexDir = join(root, "codex");
  mkdirSync(codexDir);
  fixture(join(codexDir, "session.jsonl"), [
    codex("session_meta", 0, { id: "codex", cwd }),
    codex("event_msg", 1, { type: "user_message", message: "build" }),
    codex("response_item", 2, { type: "message", role: "assistant", content: [{ text: "done" }] }),
    codex("event_msg", 3, { type: "token_count", info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } }),
  ]);
  const run = (projectsDir: string) => JSON.parse(execFileSync(process.execPath,
    [cli, "report", "--projects-dir", projectsDir, "--codex-dir", codexDir, "--json", "--out", join(root, "bundle.json")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const standalone = run(join(root, "absent-claude"));
  assert.equal(standalone.agent, "codex");
  assert.equal(standalone.projects.length, 1);
  const projectsDir = join(root, "claude-projects");
  const projectDir = join(projectsDir, "encoded-project");
  const nested = join(projectDir, "session", "subagents");
  mkdirSync(nested, { recursive: true });
  const childPath = fixture(join(nested, "agent.jsonl"), [claude("assistant", 4, [{ type: "text", text: "child work" }])]);
  assert.deepEqual(await findClaudeSessionFiles(projectDir), [childPath]);
  const child = await parseSessionFile(childPath, "encoded-project");
  assert.ok(child?.events.every((event) => event.isSidechain));
  const combined = run(projectsDir);
  assert.equal(combined.agent, "claude-code+codex");
  assert.equal(combined.projects.length, 1);
  assert.ok(combined.overall.effectiveTokens > standalone.overall.effectiveTokens);
  assert.ok(combined.overall.agenticLeverage > 0);
});
