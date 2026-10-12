/** Project-scoped local analysis. Never executes project code or scans global logs. */
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, extname, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { parseSessionFile, projectIdentity } from "./parse.ts";
import { parseCodexSessionFile } from "./parse-codex.ts";
import { buildEpisodes } from "./episodes.ts";
import { extractFeatures } from "./features.ts";
import { summarize, buildBundle, type Bundle } from "./report.ts";
import type { ParsedSession } from "./schema.ts";

export interface SessionSource { agent: "claude-code" | "codex"; file: string }
export interface SessionDiscovery { root: string; sources: SessionSource[]; scanned: number; truncated: boolean; }
export interface ProjectAnalysis {
  report_id: string;
  assessment: "provisional";
  session_count: number;
  bundle: Bundle | null;
  repository: { files: number; source_files: number; test_files: number; documentation_files: number;
    languages: Record<string, number>; has_ci: boolean; has_container_config: boolean; truncated: boolean };
  limitations: string[];
}

const SKIP = new Set([".git", "node_modules", ".venv", "venv", "vendor", "dist", "build", ".next", "coverage", ".codex", ".claude"]);
const LANGUAGES: Record<string, string> = { ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".cs": "csharp", ".rb": "ruby", ".cpp": "cpp", ".c": "c", ".swift": "swift", ".kt": "kotlin" };

async function jsonlFiles(root: string, cap = 5000): Promise<{ files: string[]; scanned: number; truncated: boolean }> {
  const files: string[] = [], pending = [root]; let scanned = 0, truncated = false;
  while (pending.length && scanned < cap) {
    const dir = pending.pop()!; let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++scanned > cap) { truncated = true; break; }
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  }
  if (pending.length) truncated = true;
  return { files, scanned, truncated };
}

/** Explicit local discovery only. Returns matching paths; it never analyzes or uploads them. */
export async function findProjectSessions(root: string, agents: ("claude-code" | "codex")[] = ["claude-code", "codex"], limit = 32): Promise<SessionDiscovery> {
  if (!isAbsolute(root)) throw new Error("Project root must be an absolute directory path.");
  const canonicalRoot = await realpath(root), projectHash = projectIdentity(canonicalRoot);
  if (!(await lstat(canonicalRoot)).isDirectory()) throw new Error("Project root must be a directory.");
  const bounded = Math.max(1, Math.min(32, Math.floor(limit))), sources: SessionSource[] = [];
  let scanned = 0, truncated = false;
  const roots: { agent: "claude-code" | "codex"; dir: string }[] = [];
  if (agents.includes('claude-code')) roots.push({agent:'claude-code',dir:process.env.VIBESCORE_CLAUDE_SESSIONS_DIR || join(homedir(),'.claude','projects')});
  if (agents.includes('codex')) roots.push({agent:'codex',dir:process.env.VIBESCORE_CODEX_SESSIONS_DIR || join(homedir(),'.codex','sessions')});
  for (const sourceRoot of roots) {
    const found = await jsonlFiles(sourceRoot.dir); scanned += found.scanned; truncated ||= found.truncated;
    for (const file of found.files) {
      if (sources.length >= bounded) { truncated = true; break; }
      try {
        const info = await lstat(file); if (info.size > 32 * 1024 * 1024) continue;
        const parsed = sourceRoot.agent === 'codex' ? await parseCodexSessionFile(file) : await parseSessionFile(file, basename(canonicalRoot));
        if (!parsed?.localCwd) continue;
        let sessionRoot = parsed.localCwd; try { sessionRoot = await realpath(sessionRoot); } catch {}
        if (projectIdentity(sessionRoot) === projectHash) sources.push({agent:sourceRoot.agent,file:await realpath(file)});
      } catch { /* malformed or inaccessible history is skipped */ }
    }
  }
  return {root:canonicalRoot,sources,scanned,truncated};
}

async function repositoryIndicators(root: string): Promise<ProjectAnalysis["repository"]> {
  const result = { files: 0, source_files: 0, test_files: 0, documentation_files: 0,
    languages: {} as Record<string, number>, has_ci: false, has_container_config: false, truncated: false };
  const pending = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 20_000) {
    const { dir, depth } = pending.pop()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { result.truncated = true; continue; }
    for (const entry of entries) {
      if (++visited > 20_000) { result.truncated = true; break; }
      if (entry.isSymbolicLink() || SKIP.has(entry.name) || entry.name.startsWith(".env")) continue;
      if (entry.isDirectory()) {
        if (depth < 12) pending.push({ dir: join(dir, entry.name), depth: depth + 1 });
        else result.truncated = true;
        continue;
      }
      if (!entry.isFile()) continue;
      result.files++;
      const language = LANGUAGES[extname(entry.name).toLowerCase()];
      if (language) { result.source_files++; result.languages[language] = (result.languages[language] ?? 0) + 1; }
      if (/(?:[.-](?:test|spec)\.|^test_|_test\.)/i.test(entry.name) || /[\\/](?:tests?|__tests__)$/.test(dir)) result.test_files++;
      if (/\.(md|rst|adoc)$/i.test(entry.name)) result.documentation_files++;
      if (/[\\/]\.github[\\/]workflows$/.test(dir) || /^\.gitlab-ci\.yml$/.test(entry.name)) result.has_ci = true;
      if (/^(dockerfile|compose\.ya?ml|docker-compose\.ya?ml)$/i.test(entry.name)) result.has_container_config = true;
    }
  }
  if (pending.length) result.truncated = true;
  return result;
}

export async function analyzeProject(root: string, sources: SessionSource[] = []): Promise<ProjectAnalysis> {
  if (!isAbsolute(root)) throw new Error("Project root must be an absolute directory path.");
  const canonicalRoot = await realpath(root);
  if (!(await lstat(canonicalRoot)).isDirectory()) throw new Error("Project root must be a directory.");
  if (sources.length > 32) throw new Error("Select at most 32 session files per report.");
  const projectHash = projectIdentity(canonicalRoot);
  const sessions: ParsedSession[] = [];
  const agents = new Set<string>();
  const seen = new Set<string>();
  for (const source of sources) {
    if (!isAbsolute(source.file)) throw new Error("Session file paths must be absolute.");
    const file = await realpath(source.file);
    if (seen.has(file)) continue;
    seen.add(file);
    const info = await lstat(file);
    if (!info.isFile() || !file.endsWith(".jsonl") || info.size > 32 * 1024 * 1024) {
      throw new Error("Session inputs must be JSONL files under 32 MiB.");
    }
    const parsed = source.agent === "codex" ? await parseCodexSessionFile(file)
      : await parseSessionFile(file, basename(canonicalRoot));
    if (!parsed) continue;
    // No guessing: metadata must identify the user-selected project exactly.
    if (!parsed.localCwd) throw new Error("Session has no project directory metadata; select a session with cwd metadata.");
    let sessionRoot = parsed.localCwd;
    try { sessionRoot = await realpath(sessionRoot); } catch { /* original metadata remains authoritative */ }
    if (projectIdentity(sessionRoot) !== projectHash) throw new Error("A selected session belongs to a different project.");
    parsed.projectHash = projectHash;
    for (const event of parsed.events) event.projectHash = projectHash;
    sessions.push(parsed);
    agents.add(source.agent);
  }
  const features = buildEpisodes(sessions).map((episode) => extractFeatures(episode));
  const bundle = features.length ? buildBundle([summarize(projectHash, features)], features,
    sessions.map((session) => session.stats), [...agents].sort().join("+")) : null;
  return {
    report_id: randomUUID(), assessment: "provisional", session_count: sessions.length, bundle,
    repository: await repositoryIndicators(canonicalRoot),
    limitations: [
      "Passive session heuristics are self-reported evidence, not a verified hiring credential.",
      "Repository indicators count file names and structure; they do not establish code quality or correctness.",
      "Only explicitly selected session files are analyzed. No other project history is scanned.",
      ...(!bundle ? ["No usable sessions selected. Add explicit Claude Code or Codex JSONL session paths to assess AI usage."] : []),
    ],
  };
}

export function explainReport(report: ProjectAnalysis) {
  const o = report.bundle?.overall;
  return { assessment: report.assessment, available: Boolean(o), dimensions: o ? {
    direction: { correction_ratio: o.correctionRatio, initial_context: o.firstPromptContextScore,
      meaning: "How often you redirected the assistant and provided initial context. Task difficulty can change these signals." },
    efficiency: { loop_burn_fraction: o.loopBurnFraction, effective_tokens: o.effectiveTokens,
      meaning: "Repeated tool patterns and a price-weighted token proxy. Repetition can be legitimate exploration." },
    verification: { after_edit_ratio: o.verifyAfterEditRatio, tool_success_rate: o.toolSuccessRate,
      meaning: "Observed verification commands after edits and successful tool results. This is not an independent test run." },
    outcomes: { counts: o.outcomes, meaning: "Observed session endings. Commit or verification evidence is a proxy for delivery." },
  } : {}, limitations: report.limitations };
}

export function recommendDrills(report: ProjectAnalysis) {
  const o = report.bundle?.overall;
  const drills = [
    { id: "verify-pagination", category: "verification", title: "Test what the demo missed", priority: 1 - (o?.verifyAfterEditRatio ?? 0), task: "Ask the assistant to reproduce the bug, add a regression test, fix it, and run the tests before concluding." },
    { id: "frame-expense-tracker", category: "framing", title: "Turn an idea into a build brief", priority: 1 - (o?.firstPromptContextScore ?? 0), task: "Specify inputs, outputs, edge cases, constraints, and a success check before requesting implementation." },
    { id: "debug-retry-loop", category: "debugging", title: "Stop an unproductive fix loop", priority: o?.loopBurnFraction ?? 0.5, task: "After two failed attempts, summarize evidence and change the debugging hypothesis before another edit." },
  ];
  return { basis: o ? "Observed provisional usage signals" : "Starter practice; no session evidence yet",
    drills: drills.sort((a, b) => b.priority - a.priority).map(({ priority, ...drill }) => ({ ...drill, practice_path: `/challenge/${drill.id}` })),
    practice_path: "/practice", note: "Practice recommendations are coaching suggestions, not scored attempts." };
}
