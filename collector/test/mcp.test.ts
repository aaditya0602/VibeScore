import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "../src/mcp.ts";

const tmp = mkdtempSync(join(tmpdir(), "vibescore-mcp-"));
process.env.VIBESCORE_HOME = join(tmp, "config");
const project = join(tmp, "project");
mkdirSync(project);
const session = join(tmp, "explicit.jsonl");
const stamp = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
writeFileSync(session, [
  { type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", timestamp: stamp(0), cwd: project, message: { role: "user", content: "Implement a useful feature with tests" } },
  { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: "s1", timestamp: stamp(1), cwd: project, message: { role: "assistant", model: "fixture", content: [{ type: "text", text: "Done" }], usage: { input_tokens: 30, output_tokens: 4 } } },
].map(JSON.stringify).join("\n"));

test("MCP handshake exposes local analysis, coaching, preview and guarded publish tools", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["analyze_project", "explain_report", "preview_publish", "publish_report", "recommend_drills"]);
    const analyzed = await client.callTool({ name: "analyze_project", arguments: { root: project, sessions: [{ agent: "claude-code", file: session }] } });
    const report = JSON.parse((analyzed.content[0] as { text: string }).text);
    assert.equal(report.session_count, 1);
    assert.equal(report.assessment, "provisional");
    assert.equal(JSON.stringify(report).includes(session), false);
    const explained = await client.callTool({ name: "explain_report", arguments: { report_id: report.report_id } });
    assert.equal(JSON.parse((explained.content[0] as { text: string }).text).available, true);
    const drills = await client.callTool({ name: "recommend_drills", arguments: { report_id: report.report_id } });
    assert.ok(JSON.parse((drills.content[0] as { text: string }).text).drills.length >= 3);
    const previewed = await client.callTool({ name: "preview_publish", arguments: { report_id: report.report_id } });
    const preview = JSON.parse((previewed.content[0] as { text: string }).text);
    assert.match(preview.sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(preview.upload).includes(project), false);
    const rejected = await client.callTool({ name: "publish_report", arguments: { report_id: report.report_id, expected_sha256: "0".repeat(64), confirm: true } });
    assert.equal(rejected.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
