/**
 * Claude Code JSONL adapter.
 *
 * This module is the privacy boundary: raw log lines come in, numeric
 * Events go out. All prose is reduced to statistics here and never
 * stored. Version-tolerant by construction: bad lines and unknown event
 * types are counted and skipped, never fatal.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { createReadStream, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32, posix } from "node:path";
import type {
  Event,
  ParsedSession,
  ParseStats,
  PromptStats,
  ToolCallRef,
  UsageNumbers,
} from "./schema.ts";

/** Per-run salt: hashes are stable within a run, useless outside it. */
const SALT = randomBytes(8).toString("hex");

function h(value: string): string {
  return createHash("sha256").update(SALT).update(value).digest("hex").slice(0, 16);
}

/** Stable on this installation only. The private key never enters a bundle. */
export function projectIdentity(path: string, kind: "cwd" | "fallback" = "cwd"): string {
  const dir = process.env.VIBESCORE_HOME ?? join(homedir(), ".vibescore");
  const keyPath = join(dir, "project-identity.key");
  let key: Buffer;
  try { key = readFileSync(keyPath); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Publish a fully written key atomically; concurrent collectors reuse it.
    const temporary = join(dir, `.identity-${randomBytes(12).toString("hex")}`);
    writeFileSync(temporary, randomBytes(32), { flag: "wx", mode: 0o600 });
    try {
      try { linkSync(temporary, keyPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { unlinkSync(temporary); }
    key = readFileSync(keyPath);
  }
  if (key.length !== 32) throw new Error("Invalid local project identity key; restore its backup before collecting.");
  const windowsPath = /^[a-z]:[\\/]/i.test(path) || /^\\\\/.test(path);
  const normalized = kind === "fallback" ? path
    : windowsPath ? win32.normalize(path).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase()
    : posix.normalize(path).replace(/\/$/, "") || "/";
  return createHmac("sha256", key).update(`${kind}\0${normalized}`).digest("hex").slice(0, 16);
}

/** Includes modern <session>/subagents/*.jsonl; does not follow symlinks. */
export async function findClaudeSessionFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => join(e.parentPath, e.name)).sort();
}

// ---------------------------------------------------------------------------
// Prompt text → numbers (text discarded after this function returns)
// ---------------------------------------------------------------------------

const CORRECTION_RE =
  /\b(not what|that'?s wrong|that is wrong|undo|revert|roll ?back|you broke|still broken|didn'?t work|doesn'?t work|not working|stop|wrong file|i meant|i didn'?t ask)\b/i;
const SHORT_NEG_RE = /^\s*(no|nope|wrong|not that|stop)\b/i;
const REDIRECT_RE =
  /\b(instead|actually,? (let'?s|use|make|do)|rather than|on second thought|change of plan|forget (that|it)|scrap that|let'?s (go|switch) (back|with|to))\b/i;
const CONSTRAINT_RE =
  /\b(must|should|don'?t|do not|never|always|only|make sure|ensure|without|at most|at least|exactly|keep|avoid)\b/gi;
const FILE_REF_RE =
  /[\w./\\-]+\.(ts|tsx|js|jsx|py|java|go|rs|rb|c|cpp|h|cs|php|html|css|scss|json|yaml|yml|toml|md|sql|sh|ps1)\b/gi;

export function analyzePrompt(text: string): PromptStats {
  const chars = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const lines = text.split("\n").length;
  const codeFences = (text.match(/```/g) ?? []).length >> 1;
  const fileRefs = (text.match(FILE_REF_RE) ?? []).length;
  const questionMarks = (text.match(/\?/g) ?? []).length;
  const constraintMarkers = (text.match(CONSTRAINT_RE) ?? []).length;
  const isCorrection =
    CORRECTION_RE.test(text) || (chars < 120 && SHORT_NEG_RE.test(text));
  const isRedirect = !isCorrection && REDIRECT_RE.test(text);
  return {
    chars, words, lines, codeFences, fileRefs,
    questionMarks, constraintMarkers, isCorrection, isRedirect,
  };
}

// ---------------------------------------------------------------------------
// Tool calls → refs (inputs hashed, then discarded)
// ---------------------------------------------------------------------------

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
const EXEC_TOOLS = new Set(["Bash", "PowerShell"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const VERIFY_RE =
  /\b(test|pytest|jest|vitest|mocha|tsc|eslint|lint|build|compile|cargo (check|test|build)|go (test|build|vet)|mvn|gradle|npm (test|run (test|build|lint|check))|pnpm (test|build)|yarn (test|build)|make(\s|$)|dotnet (test|build))\b/i;
const COMMIT_RE = /\bgit (commit|push)\b/i;

function classify(tool: string): ToolCallRef["klass"] {
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (READ_TOOLS.has(tool)) return "read";
  if (EXEC_TOOLS.has(tool)) return "exec";
  if (AGENT_TOOLS.has(tool)) return "agent";
  if (tool === "TodoWrite" || tool === "TaskCreate" || tool === "TaskUpdate") return "other";
  return "other";
}

function toToolCallRef(block: any): ToolCallRef {
  const tool = String(block.name ?? "unknown");
  const inputStr = JSON.stringify(block.input ?? {});
  const klass = classify(tool);
  let looksLikeVerification = false;
  let looksLikeCommit = false;
  if (klass === "exec" && typeof block.input?.command === "string") {
    looksLikeVerification = VERIFY_RE.test(block.input.command);
    looksLikeCommit = COMMIT_RE.test(block.input.command);
  }
  // Loop signature: tool + normalized input. For edits/reads, key on the
  // target (file_path etc.) so "same file, slightly different content"
  // still matches; for exec, key on the command head.
  const sigSource =
    typeof block.input?.file_path === "string" ? block.input.file_path
    : typeof block.input?.command === "string" ? block.input.command.slice(0, 60)
    : typeof block.input?.pattern === "string" ? block.input.pattern
    : inputStr.slice(0, 120);
  return {
    id: String(block.id ?? ""),
    tool,
    inputHash: h(tool + " " + sigSource),
    inputChars: inputStr.length,
    klass,
    looksLikeVerification,
    looksLikeCommit,
  };
}

// ---------------------------------------------------------------------------
// Line → Event
// ---------------------------------------------------------------------------

function usageOf(u: any): UsageNumbers {
  return {
    input: Number(u?.input_tokens ?? 0),
    output: Number(u?.output_tokens ?? 0),
    cacheRead: Number(u?.cache_read_input_tokens ?? 0),
    cacheWrite: Number(u?.cache_creation_input_tokens ?? 0),
  };
}

const KNOWN_SKIP_TYPES = new Set([
  "custom-title", "last-prompt", "queue-operation", "summary", "attachment",
  "file-history-snapshot", "todo", "compact-boundary",
]);

function toEvents(obj: any, projectHash: string): Event[] | "unknown" | "skip" {
  const type = obj?.type;
  const base = {
    uuid: String(obj.uuid ?? ""),
    parentUuid: obj.parentUuid != null ? String(obj.parentUuid) : null,
    sessionId: String(obj.sessionId ?? ""),
    ts: obj.timestamp ? Date.parse(obj.timestamp) : 0,
    isSidechain: obj.isSidechain === true,
    agentVersion: String(obj.version ?? ""),
    projectHash,
    branchHash: obj.gitBranch ? h(String(obj.gitBranch)) : null,
  };

  if (type === "user") {
    const content = obj.message?.content;
    if (typeof content === "string") {
      return [{ kind: "prompt", ...base, prompt: analyzePrompt(content) }];
    }
    if (Array.isArray(content)) {
      const events: Event[] = [];
      const textParts: string[] = [];
      for (const block of content) {
        if (block?.type === "tool_result") {
          events.push({
            kind: "tool_result", ...base,
            toolUseId: String(block.tool_use_id ?? ""),
            isError: block.is_error === true,
          });
        } else if (block?.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        }
      }
      if (textParts.length > 0) {
        events.push({ kind: "prompt", ...base, prompt: analyzePrompt(textParts.join("\n")) });
      }
      return events.length > 0 ? events : "skip";
    }
    return "skip";
  }

  if (type === "assistant") {
    const msg = obj.message ?? {};
    const toolCalls: ToolCallRef[] = [];
    let textChars = 0;
    let thinkingChars = 0;
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block?.type === "tool_use") toolCalls.push(toToolCallRef(block));
      else if (block?.type === "text") textChars += String(block.text ?? "").length;
      else if (block?.type === "thinking") thinkingChars += String(block.thinking ?? "").length;
    }
    return [{
      kind: "assistant", ...base,
      model: String(msg.model ?? "unknown"),
      usage: usageOf(msg.usage),
      toolCalls, textChars, thinkingChars,
    }];
  }

  if (type === "system") {
    return [{ kind: "system", ...base, systemSubtype: String(obj.subtype ?? "") }];
  }

  if (KNOWN_SKIP_TYPES.has(type)) return "skip";
  return "unknown";
}

// ---------------------------------------------------------------------------
// File → ParsedSession
// ---------------------------------------------------------------------------

export async function parseSessionFile(
  filePath: string,
  projectDirName: string,
): Promise<ParsedSession | null> {
  let projectHash = projectIdentity(`claude:${projectDirName}`, "fallback");
  const nestedSubagent = /[\\/]subagents[\\/]/.test(filePath);
  const events: Event[] = [];
  const stats: ParseStats = {
    lines: 0, parsed: 0, badJson: 0, unknownType: 0,
    chainBreaks: 0, timeRegressions: 0, unknownEventRatio: 0,
  };
  const seenUuids = new Set<string>();
  let prevTs = 0;
  let localCwd: string | undefined;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    stats.lines++;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      stats.badJson++;
      continue;
    }
    if (!localCwd && typeof obj?.cwd === "string" && obj.cwd) {
      localCwd = obj.cwd;
      projectHash = projectIdentity(localCwd);
      for (const event of events) event.projectHash = projectHash;
    }
    const result = toEvents(obj, projectHash);
    if (result === "unknown") { stats.unknownType++; continue; }
    if (result === "skip") continue;
    for (const ev of result) {
      if (nestedSubagent) ev.isSidechain = true;
      stats.parsed++;
      if (ev.uuid) seenUuids.add(ev.uuid);
      if (ev.parentUuid && !seenUuids.has(ev.parentUuid)) stats.chainBreaks++;
      if (ev.ts && prevTs && ev.ts < prevTs - 5_000 && !ev.isSidechain) {
        stats.timeRegressions++;
      }
      if (ev.ts && !ev.isSidechain) prevTs = ev.ts;
      events.push(ev);
    }
  }

  if (events.length === 0) return null;
  stats.unknownEventRatio =
    stats.lines > 0 ? stats.unknownType / stats.lines : 0;
  const timestamps = events.map((e) => e.ts).filter((t) => t > 0);
  return {
    sessionId: events.find((e) => e.sessionId)?.sessionId ?? "",
    projectHash,
    events,
    stats,
    firstTs: timestamps.length ? Math.min(...timestamps) : 0,
    lastTs: timestamps.length ? Math.max(...timestamps) : 0,
    localCwd,
  };
}
