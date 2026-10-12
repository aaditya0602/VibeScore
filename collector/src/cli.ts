#!/usr/bin/env node
/**
 * vibescore CLI
 *
 *   vibescore report (--projects-dir <dir> | --codex-dir <dir>) [--out bundle.json] [--json]
 *
 * Scans only the session roots explicitly selected on the command line, computes skill features on-device,
 * prints a report. Raw prompts/code never leave the machine; the optional
 * bundle contains derived numbers only.
 */

import { readdir } from "node:fs/promises";
import { writeFileSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseBundle } from "../../backend/src/validation.ts";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Commit timestamps (epoch ms) from the project's real git log, read
 * locally. Only timestamps are used — no messages, no diffs, no authors —
 * and they never enter the bundle; they only inform the outcome feature.
 */
async function gitCommitTimestamps(cwd: string): Promise<number[]> {
  try {
    const { stdout } = await execFileP(
      "git", ["-C", cwd, "log", "--format=%ct", "--max-count=2000"],
      { timeout: 10_000 });
    return stdout.split("\n")
      .map((l) => Number(l.trim()) * 1000)
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return []; // dir gone, not a repo, or no git — feature degrades silently
  }
}
import { parseSessionFile, findClaudeSessionFiles } from "./parse.ts";
import { buildEpisodes } from "./episodes.ts";
import { extractFeatures, type EpisodeFeatures } from "./features.ts";
import { summarize, buildBundle, renderReport, type ProjectSummary } from "./report.ts";
import type { ParsedSession, ParseStats } from "./schema.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "compare") {
    const { runCompare } = await import("./compare.ts");
    const truthPath = argValue(args, "--truth");
    const files = args.slice(1).filter((a) => a.endsWith(".json"));
    if (files.length < 2) {
      console.error("usage: vibescore compare <bundle.json> <bundle.json> [...] [--truth ranking.txt]");
      process.exit(1);
    }
    console.log(runCompare(files, truthPath));
    return;
  }

  if (cmd === "submit") {
    const bundlePath = argValue(args, "--bundle");
    const server = submitServer(argValue(args, "--server") ?? "http://localhost:8787");
    const token = argValue(args, "--token") ?? process.env.VIBESCORE_TOKEN;
    if (!bundlePath) {
      throw new Error("usage: vibescore submit --bundle <file.json> [--server url] --token <token> (or VIBESCORE_TOKEN)");
    }
    if (!token || token.length < 32 || token.length > 256 || /[\s\x00-\x1f\x7f]/.test(token)) {
      throw new Error("A valid API token is required. Create one in Settings; submit never creates an account or changes profile visibility.");
    }
    if (statSync(bundlePath).size > 2_000_000) throw new Error("Bundle exceeds the 2 MB limit.");
    const bundle = parseBundle(JSON.parse(readFileSync(bundlePath, "utf8")));
    const resp = await fetch(`${server}/api/bundles`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", "x-token": token },
      body: JSON.stringify(bundle),
    });
    const body = await submissionResponse(resp);
    const s = body.score;
    console.log(`scored: ${s.rating} ± ${s.rd} (${s.tier})`);
    console.log(`subscores: efficiency ${s.subscores.efficiency} · direction ${s.subscores.direction} · craft ${s.subscores.craft} · shipping ${s.subscores.shipping}`);
    console.log(`profile: ${server}/profile/${encodeURIComponent(s.handle)} (available only if you publish your profile in Settings)`);
    return;
  }

  if (cmd !== "report") {
    console.log("usage: vibescore report (--projects-dir <dir> | --codex-dir <dir>) [--no-claude] [--no-codex] [--out bundle.json] [--html report.html] [--json]\n       vibescore compare <bundles...> [--truth ranking.txt]\n       vibescore submit --bundle <file.json> [--server url] --token <token> (or VIBESCORE_TOKEN)");
    process.exit(cmd ? 1 : 0);
  }

  const projectsDir = argValue(args, "--projects-dir");
  const codexDir = argValue(args, "--codex-dir");
  if (!projectsDir && !codexDir) {
    throw new Error("Select at least one session root with --projects-dir or --codex-dir. VibeScore never scans global agent history implicitly.");
  }
  const outPath = argValue(args, "--out");
  const asJson = args.includes("--json");

  let projectDirs: string[] = [];
  try {
    if (projectsDir && !args.includes("--no-claude")) {
      const entries = await readdir(projectsDir, { withFileTypes: true });
      projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const summaries: ProjectSummary[] = [];
  const allFeats: EpisodeFeatures[] = [];
  const allStats: ParseStats[] = [];
  const sessionsByProject = new Map<string, ParsedSession[]>();
  const agents = new Set<string>();
  function addSession(session: ParsedSession, agent: string): void {
    const list = sessionsByProject.get(session.projectHash) ?? [];
    list.push(session);
    sessionsByProject.set(session.projectHash, list);
    allStats.push(session.stats);
    agents.add(agent);
  }

  for (const dirName of projectDirs) {
    const dir = join(projectsDir, dirName);
    let files: string[] = [];
    try {
      files = await findClaudeSessionFiles(dir);
    } catch { continue; }

    for (const f of files) {
      try {
        const parsed = await parseSessionFile(f, dirName);
        if (parsed) addSession(parsed, "claude-code");
      } catch (err) {
        console.error(`  ! skipping ${f}: ${(err as Error).message}`);
      }
    }
  }

  // Codex CLI rollouts (~/.codex/sessions or --codex-dir) — same report,
  // same privacy boundary. Absent dir → empty list, no error.
  const { parseCodexSessionFile, findCodexSessionFiles } = await import("./parse-codex.ts");
  const codexFiles = args.includes("--no-codex") || !codexDir
    ? [] : await findCodexSessionFiles(codexDir);
  for (const f of codexFiles) {
    try {
      const s = await parseCodexSessionFile(f);
      if (!s) continue;
      addSession(s, "codex");
    } catch (err) {
      console.error(`  ! skipping codex rollout: ${(err as Error).message}`);
    }
  }
  for (const [hash, sessions] of sessionsByProject) {
    const localCwd = sessions.find((s) => s.localCwd)?.localCwd;
    const commitTs = localCwd ? await gitCommitTimestamps(localCwd) : [];
    const feats = buildEpisodes(sessions).map((ep) => extractFeatures(ep, commitTs));
    allFeats.push(...feats);
    const summary = summarize(hash, feats);
    summary.label = localCwd ? basename(localCwd) : hash.slice(0, 8);
    summaries.push(summary);
  }

  if (allFeats.length === 0) {
    console.error("no parseable sessions found");
    process.exit(1);
  }

  summaries.sort((a, b) => b.effectiveTokens - a.effectiveTokens);
  const bundle = buildBundle(summaries, allFeats, allStats,
    [...agents].join("+"));

  if (asJson) {
    console.log(JSON.stringify(bundle, null, 2));
  } else {
    console.log(renderReport(summaries, bundle));
  }
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(bundle, null, 2));
    (asJson ? console.error : console.log)(`bundle written: ${outPath} (derived numbers only — inspect it yourself)`);
  }
  const htmlPath = argValue(args, "--html");
  if (htmlPath) {
    const { renderHtmlReport } = await import("./html.ts");
    writeFileSync(htmlPath, renderHtmlReport(summaries, bundle));
    (asJson ? console.error : console.log)(`html report written: ${htmlPath} (open in any browser — fully offline)`);
  }
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error((err as Error).message); process.exitCode = 1; });
}

/** Accept TLS destinations, with HTTP restricted to literal local development hosts. */
export function submitServer(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Server must use HTTPS, except localhost/loopback development.");
  if (url.username || url.password || url.search || url.hash) throw new Error("Server URL must not contain credentials, query, or fragment.");
  return url.href.replace(/\/$/, "");
}

/** Bound streamed responses before parsing; only print validated score fields. */
export async function submissionResponse(response: Response): Promise<any> {
  if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("Server returned a non-JSON response.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Server returned an empty response.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 64_000) { await reader.cancel(); throw new Error("Server response exceeds 64 KB."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: any;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Server returned invalid JSON."); }
  if (!response.ok) throw new Error(`Submit failed (HTTP ${response.status}).`);
  const s = body?.score;
  if (!s || !/^[a-z0-9][a-z0-9_-]{1,23}$/.test(s.handle ?? "") || typeof s.tier !== "string" || !/^[a-zA-Z0-9 _-]{1,80}$/.test(s.tier)
    || ![s.rating, s.rd, ...["efficiency", "direction", "craft", "shipping"].map(k => s.subscores?.[k])].every(n => typeof n === "number" && Number.isFinite(n))) {
    throw new Error("Server returned an invalid score.");
  }
  return body;
}
