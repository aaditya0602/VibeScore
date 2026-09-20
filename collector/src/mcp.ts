#!/usr/bin/env node
/** Local VibeScore MCP. It reads only paths explicitly supplied by the caller. */
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { analyzeProject, explainReport, findProjectSessions, recommendDrills, type ProjectAnalysis } from "./analyze.ts";
import { submissionResponse } from "./cli.ts";
import { parseBundle } from "../../backend/src/validation.ts";

export const server = new McpServer({ name: "vibescore", version: "0.2.0" });
const reports = new Map<string, ProjectAnalysis>();
const previews = new Map<string, { digest: string; bundle: unknown }>();
const sessionSchema = z.array(z.object({ agent: z.enum(["claude-code", "codex"]), file: z.string().min(1) }).strict()).max(32).optional();
const reportId = z.string().uuid();
const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

server.registerTool("analyze_project", {
  description: "Analyze repository structure and explicitly selected Claude Code/Codex JSONL sessions locally. Never scans agent history automatically or executes repository code.",
  inputSchema: { root: z.string().min(1), sessions: sessionSchema },
}, async ({ root, sessions }) => {
  const report = await analyzeProject(root, sessions ?? []);
  reports.set(report.report_id, report);
  while (reports.size > 20) reports.delete(reports.keys().next().value!);
  return asText(report);
});

server.registerTool("find_project_sessions", {
  description: "After an explicit user request, find Claude Code and Codex JSONL sessions whose project metadata matches one absolute repository path. Returns local paths only and does not analyze or upload them.",
  inputSchema: { root: z.string().min(1), agents: z.array(z.enum(["claude-code", "codex"])).min(1).max(2).optional(), limit: z.number().int().min(1).max(32).optional() },
}, async ({ root, agents, limit }) => asText(await findProjectSessions(root, agents, limit)));

server.registerTool("explain_report", {
  description: "Explain the provisional evidence and limitations of a report from this MCP session.",
  inputSchema: { report_id: reportId },
}, async ({ report_id }) => {
  const report = reports.get(report_id);
  if (!report) throw new Error("Unknown report_id. Run analyze_project first.");
  return asText(explainReport(report));
});

server.registerTool("recommend_drills", {
  description: "Recommend practice drills based on a local provisional report.",
  inputSchema: { report_id: reportId },
}, async ({ report_id }) => {
  const report = reports.get(report_id);
  if (!report) throw new Error("Unknown report_id. Run analyze_project first.");
  return asText(recommendDrills(report));
});

server.registerTool("preview_publish", {
  description: "Preview the numeric aggregate bundle before upload. Returns a SHA-256 digest that must be supplied unchanged to publish_report.",
  inputSchema: { report_id: reportId },
}, async ({ report_id }) => {
  const report = reports.get(report_id);
  if (!report?.bundle) throw new Error("This report has no usable sessions to publish.");
  const bundle = parseBundle(report.bundle);
  const digest = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
  previews.set(report_id, { digest, bundle });
  return asText({ report_id, sha256: digest, upload: bundle, privacy: "Only validated aggregate metrics are included; no prompts, code, repository paths, or filenames." });
});

server.registerTool("publish_report", {
  description: "Publish a previously previewed numeric report. Requires the matching preview SHA-256, confirm=true, and VIBESCORE_SERVER and VIBESCORE_TOKEN environment variables.",
  inputSchema: { report_id: reportId, expected_sha256: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) },
}, async ({ report_id, expected_sha256 }) => {
  const preview = previews.get(report_id);
  if (!preview || preview.digest !== expected_sha256) throw new Error("No matching publish preview. Run preview_publish and use its exact sha256.");
  const serverUrl = process.env.VIBESCORE_SERVER;
  const token = process.env.VIBESCORE_TOKEN;
  if (!serverUrl || !token) throw new Error("Set VIBESCORE_SERVER and VIBESCORE_TOKEN before publishing.");
  const target = new URL(serverUrl);
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(target.hostname.toLowerCase());
  if (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) {
    throw new Error("VIBESCORE_SERVER must use HTTPS, except for localhost/loopback development.");
  }
  if (target.username || target.password || target.search || target.hash) throw new Error("VIBESCORE_SERVER must not contain credentials, query, or fragment.");
  target.pathname = `${target.pathname.replace(/\/$/, "")}/api/bundles`;
  const response = await fetch(target, { method: "POST", redirect: "error", headers: { "content-type": "application/json", "x-token": token }, body: JSON.stringify(preview.bundle) });
  const body = await submissionResponse(response);
  previews.delete(report_id);
  return asText({ published: true, handle:body.score?.handle??null, score: body.score ?? null });
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await server.connect(new StdioServerTransport());
}
