#!/usr/bin/env node
/**
 * vibescore CLI
 *
 *   vibescore report [--projects-dir <dir>] [--out bundle.json] [--json]
 *
 * Scans local Claude Code and Codex session logs, computes skill features on-device,
 * prints a report. Raw prompts/code never leave the machine; the optional
 * bundle contains derived numbers only.
 */

import { readdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
    // vibescore submit --bundle me.json --server http://localhost:8787 --handle aaditya [--token t]
    const bundlePath = argValue(args, "--bundle");
    const server = (argValue(args, "--server") ?? "http://localhost:8787").replace(/\/$/, "");
    const handle = argValue(args, "--handle");
    let token = argValue(args, "--token");
    if (!bundlePath || !handle) {
      console.error("usage: vibescore submit --bundle <file.json> --handle <name> [--server url] [--token t]");
      process.exit(1);
    }
    const { readFileSync } = await import("node:fs");
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
    if (!token) {
      const reg = await fetch(`${server}/api/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle }),
      });
      const regBody = await reg.json() as any;
      if (!reg.ok) {
        console.error(`register failed: ${regBody.error ?? reg.status} (existing handle? pass --token)`);
        process.exit(1);
      }
      token = regBody.token as string;
      console.log(`registered '${handle}'. SAVE THIS TOKEN for future submits:\n  ${token}\n`);
    }
    const resp = await fetch(`${server}/api/bundles`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-token": token },
      body: JSON.stringify(bundle),
    });
    const body = await resp.json() as any;
    if (!resp.ok) {
      console.error(`submit failed: ${body.error ?? resp.status}`);
      process.exit(1);
    }
    const s = body.score;
    console.log(`scored: ${s.rating} ± ${s.rd} (${s.tier})`);
    console.log(`subscores: efficiency ${s.subscores.efficiency} · direction ${s.subscores.direction} · craft ${s.subscores.craft} · shipping ${s.subscores.shipping}`);
    console.log(`profile: ${server}/profile.html?u=${encodeURIComponent(handle)}`);
    return;
  }

  if (cmd !== "report") {
    console.log("usage: vibescore report [--projects-dir <dir>] [--codex-dir <dir>] [--no-claude] [--no-codex] [--out bundle.json] [--html report.html] [--json]\n       vibescore compare <bundles...> [--truth ranking.txt]\n       vibescore submit --bundle <file.json> --handle <name> [--server url] [--token t]");
    process.exit(cmd ? 1 : 0);
  }

  const projectsDir = argValue(args, "--projects-dir")
    ?? join(homedir(), ".claude", "projects");
  const outPath = argValue(args, "--out");
  const asJson = args.includes("--json");

  let projectDirs: string[] = [];
  try {
    if (!args.includes("--no-claude")) {
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
  const codexFiles = args.includes("--no-codex")
    ? [] : await findCodexSessionFiles(argValue(args, "--codex-dir"));
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
