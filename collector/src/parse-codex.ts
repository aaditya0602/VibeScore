/**
 * Codex CLI rollout JSONL adapter.
 *
 * Same privacy boundary as parse.ts: raw rollout lines come in, numeric
 * Events go out. Prompt/message text is reduced to statistics via
 * analyzePrompt and discarded; tool inputs survive only as salted hashes.
 * Version-tolerant: bad JSON lines and unknown item types are counted and
 * skipped, never fatal.
 *
 * Empirical rollout format (observed in ~/.codex/sessions rollouts):
 *   Every line: { timestamp: ISO string, type: string, payload: {...} }
 *   Top-level types:
 *     - session_meta   payload: { id, timestamp, cwd, originator,
 *                                 cli_version, source, model_provider, ... }
 *     - turn_context   payload: { turn_id, cwd, model, approval_policy, ... }
 *     - compacted      payload: { message, replacement_history, ... }
 *     - response_item  payload.type:
 *         message                  { role: user|assistant|developer,
 *                                    content: [{ type: input_text|output_text, text }] }
 *         reasoning                { summary: [...], content: null|[...],
 *                                    encrypted_content }
 *         function_call            { name, arguments: JSON string, call_id }
 *         custom_tool_call         { name, input: string, call_id, status }
 *         function_call_output     { call_id, output: string }
 *         custom_tool_call_output  { call_id, output: string }
 *     - event_msg      payload.type:
 *         user_message             { message, images, ... }   ← canonical prompt
 *         agent_message            { message, phase }         ← dup of assistant msg
 *         token_count              { info: null | { total_token_usage,
 *                                    last_token_usage: { input_tokens,
 *                                    cached_input_tokens, output_tokens, ... } } }
 *         exec_command_end         { call_id, exit_code, ... }
 *         patch_apply_end          { call_id, success, ... }
 *         mcp_tool_call_end        { call_id, result: { Ok: { isError } } | { Err } }
 *         task_started / task_complete / turn_aborted / context_compacted /
 *         thread_goal_updated / web_search_end / ...
 *
 * The format has NO uuid/parentUuid chains, so chainBreaks is always 0
 * (synthetic per-line uuids are emitted; parentUuid is always null).
 */

import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { analyzePrompt, projectIdentity } from "./parse.ts";
import type {
  Event,
  ParsedSession,
  ParseStats,
  ToolCallRef,
  UsageNumbers,
} from "./schema.ts";

/** Per-run salt: hashes are stable within a run, useless outside it. */
const SALT = randomBytes(8).toString("hex");

function h(value: string): string {
  return createHash("sha256").update(SALT).update(value).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Tool calls → refs (inputs hashed, then discarded)
// ---------------------------------------------------------------------------

// Kept in sync with parse.ts (which does not export these regexes).
const VERIFY_RE =
  /\b(test|pytest|jest|vitest|mocha|tsc|eslint|lint|build|compile|cargo (check|test|build)|go (test|build|vet)|mvn|gradle|npm (test|run (test|build|lint|check))|pnpm (test|build)|yarn (test|build)|make(\s|$)|dotnet (test|build))\b/i;
const COMMIT_RE = /\bgit (commit|push)\b/i;

const EDIT_TOOLS = new Set(["apply_patch", "edit_file", "write_file", "create_file"]);
const EXEC_TOOLS = new Set([
  "shell", "local_shell", "shell_command", "exec", "exec_command", "bash",
]);
const READ_TOOLS = new Set([
  "read_file", "read", "list_dir", "list_files", "list_directory", "find",
  "search", "search_files", "grep", "glob", "view_image", "web_search", "fetch_url",
]);

function classifyCodexTool(tool: string): ToolCallRef["klass"] {
  tool = tool.split(/\.|__/).at(-1) ?? tool;
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (EXEC_TOOLS.has(tool)) return "exec";
  if (READ_TOOLS.has(tool)) return "read";
  if (["spawn_agent", "send_message", "wait_agent", "wait", "followup_task"].includes(tool)) return "agent";
  return "other";
}

/**
 * Recover the command string from a Codex tool input. function_call
 * arguments are a JSON string ({ command: string | string[] , ... });
 * custom_tool_call "exec" input is the raw command/script text itself.
 */
function commandOf(klass: ToolCallRef["klass"], rawInput: string): string | null {
  if (klass !== "exec") return null;
  try {
    const parsed = JSON.parse(rawInput);
    if (typeof parsed?.command === "string") return parsed.command;
    if (typeof parsed?.cmd === "string") return parsed.cmd;
    if (Array.isArray(parsed?.command)) return parsed.command.join(" ");
  } catch {
    // not JSON → the raw string IS the command (custom_tool_call "exec")
    return rawInput;
  }
  return rawInput;
}

function toToolCallRef(name: string, callId: string, rawInput: string): ToolCallRef {
  const tool = String(name || "unknown");
  const klass = classifyCodexTool(tool);
  const command = commandOf(klass, rawInput);
  let parsed: any = null;
  try { parsed = JSON.parse(rawInput); } catch { /* raw text input */ }
  // Loop signature: key on the target (path/pattern) or command head so
  // "same target, slightly different content" still matches.
  const sigSource =
    typeof parsed?.file_path === "string" ? parsed.file_path
    : typeof parsed?.path === "string" ? parsed.path
    : typeof parsed?.pattern === "string" ? parsed.pattern
    : typeof command === "string" ? command.slice(0, 60)
    : rawInput.slice(0, 120);
  return {
    id: callId,
    tool,
    inputHash: h(tool + " " + sigSource),
    inputChars: rawInput.length,
    klass,
    looksLikeVerification: command != null && VERIFY_RE.test(command),
    looksLikeCommit: command != null && COMMIT_RE.test(command),
  };
}

// ---------------------------------------------------------------------------
// Usage / error helpers
// ---------------------------------------------------------------------------

/**
 * Codex token_count reports last_token_usage with input_tokens INCLUSIVE of
 * cached_input_tokens. Split them so UsageNumbers.input means uncached input.
 * The rollout format has no cache-write figure → cacheWrite is always 0.
 */
function usageOf(u: any): UsageNumbers {
  const input = Number(u?.input_tokens ?? 0);
  const cached = Number(u?.cached_input_tokens ?? 0);
  return {
    input: Math.max(0, input - cached),
    output: Number(u?.output_tokens ?? 0),
    cacheRead: cached,
    cacheWrite: 0,
  };
}

const ZERO_USAGE: UsageNumbers = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Derive isError from a tool output string without retaining it. */
function outputLooksLikeError(output: string): boolean {
  try {
    const parsed = JSON.parse(output);
    const code = parsed?.metadata?.exit_code ?? parsed?.exit_code ?? parsed?.exitCode;
    if (typeof code === "number") return code !== 0;
    if (parsed?.error != null) return true;
  } catch { /* plain text output */ }
  // Codex sometimes embeds "exit code: N" / "exited with code N" markers.
  const m = output.slice(0, 300).match(/exit(?:ed with)? code:?\s*(-?\d+)/i);
  if (m) return Number(m[1]) !== 0;
  return false;
}

// event_msg subtypes that carry no skill signal (or duplicate response
// items) — counted as known skips, never as unknownType.
const KNOWN_SKIP_EVENT_MSG = new Set([
  "agent_message", "agent_message_delta", "agent_reasoning",
  "agent_reasoning_delta", "agent_reasoning_raw_content",
  "agent_reasoning_raw_content_delta", "agent_reasoning_section_break",
  "exec_command_begin", "exec_command_output_delta", "exec_approval_request",
  "apply_patch_approval_request", "patch_apply_begin",
  "mcp_tool_call_begin", "web_search_begin", "web_search_end",
  "thread_goal_updated", "turn_diff", "plan_update", "background_event",
  "stream_error", "error", "notification", "shutdown_complete",
  "list_custom_prompts_response", "mcp_list_tools_response",
  "view_image_tool_call", "entered_review_mode", "exited_review_mode",
]);

// event_msg subtypes surfaced as kind "system" (session shape signal).
const SYSTEM_EVENT_MSG = new Set([
  "task_started", "task_complete", "turn_aborted", "context_compacted",
]);

// ---------------------------------------------------------------------------
// File → ParsedSession
// ---------------------------------------------------------------------------

export async function parseCodexSessionFile(
  filePath: string,
): Promise<ParsedSession | null> {
  const events: Event[] = [];
  const stats: ParseStats = {
    lines: 0, parsed: 0, badJson: 0, unknownType: 0,
    // Rollout lines carry no parentUuid chains, so chainBreaks stays 0 by
    // construction — the coherence signal for this format is timestamps only.
    chainBreaks: 0, timeRegressions: 0, unknownEventRatio: 0,
  };

  // Session-level state recovered as we stream.
  let sessionId = "";
  let localCwd: string | undefined;
  let projectHash = projectIdentity(`codex:${dirname(filePath)}`, "fallback");
  let isSidechain = false;
  let agentVersion = "";
  let model = "codex-unknown";
  let prevTs = 0;
  let lineNo = 0;
  /** reasoning chars accumulated since the last assistant event */
  let pendingThinking = 0;
  /** last assistant event, for folding trailing token_count usage in */
  let lastAssistant: Event | null = null;
  /** tool_result events already emitted, patchable by *_end event_msgs */
  const resultsByCallId = new Map<string, Event>();
  /** error verdicts from *_end event_msgs that arrived before the output item */
  const pendingErrByCallId = new Map<string, boolean>();

  function setCwd(cwd: unknown): void {
    if (typeof cwd !== "string" || cwd.length === 0 || localCwd) return;
    localCwd = cwd;
    projectHash = projectIdentity(cwd);
    for (const ev of events) ev.projectHash = projectHash; // retro-fix early lines
  }

  function base(ts: number): Omit<Event, "kind"> {
    return {
      uuid: `codex-${lineNo}`,
      parentUuid: null,
      sessionId,
      ts,
      isSidechain,
      agentVersion,
      projectHash,
      branchHash: null, // rollouts carry no git branch info
    };
  }

  function push(ev: Event): void {
    stats.parsed++;
    if (ev.ts && prevTs && ev.ts < prevTs - 5_000) stats.timeRegressions++;
    if (ev.ts) prevTs = ev.ts;
    events.push(ev);
  }

  function recordCallError(callId: unknown, isError: boolean): void {
    const id = String(callId ?? "");
    if (!id) return;
    const emitted = resultsByCallId.get(id);
    if (emitted) emitted.isError = isError;
    else pendingErrByCallId.set(id, isError);
  }

  function pushAssistantEvent(
    ts: number,
    fields: { textChars?: number; toolCalls?: ToolCallRef[] },
  ): void {
    const ev: Event = {
      kind: "assistant",
      ...base(ts),
      model,
      usage: { ...ZERO_USAGE },
      toolCalls: fields.toolCalls ?? [],
      textChars: fields.textChars ?? 0,
      thinkingChars: pendingThinking,
    };
    pendingThinking = 0;
    lastAssistant = ev;
    push(ev);
  }

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    stats.lines++;
    lineNo++;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      stats.badJson++;
      continue;
    }

    const type = obj?.type;
    const p = obj?.payload ?? {};
    const ts = obj?.timestamp ? Date.parse(obj.timestamp) : 0;

    if (type === "session_meta") {
      isSidechain = typeof p.source === "object" && p.source !== null && "subagent" in p.source;
      if (typeof p.id === "string" && p.id) sessionId = p.id;
      if (typeof p.cli_version === "string") agentVersion = p.cli_version;
      setCwd(p.cwd);
      continue;
    }

    if (type === "turn_context") {
      if (typeof p.model === "string" && p.model) model = p.model;
      setCwd(p.cwd);
      continue;
    }

    if (type === "compacted") continue; // context compaction blob — no signal

    if (type === "event_msg") {
      const sub = String(p.type ?? "");
      if (sub === "user_message") {
        // Canonical human prompt. (response_item user-role messages are
        // skipped below: they duplicate this text plus injected context.)
        push({ kind: "prompt", ...base(ts), prompt: analyzePrompt(String(p.message ?? "")) });
      } else if (sub === "token_count") {
        // Cumulative per-turn usage arrives after the model output; fold the
        // latest last_token_usage into the most recent assistant event.
        if (p.info?.last_token_usage && lastAssistant) {
          lastAssistant.usage = usageOf(p.info.last_token_usage);
        }
      } else if (sub === "exec_command_end") {
        recordCallError(p.call_id, Number(p.exit_code ?? 0) !== 0);
      } else if (sub === "patch_apply_end") {
        recordCallError(p.call_id, p.success === false);
      } else if (sub === "mcp_tool_call_end") {
        const err = p.result?.Ok ? p.result.Ok.isError === true : p.result?.Err != null;
        recordCallError(p.call_id, err);
      } else if (SYSTEM_EVENT_MSG.has(sub)) {
        push({ kind: "system", ...base(ts), systemSubtype: sub });
      } else if (!KNOWN_SKIP_EVENT_MSG.has(sub)) {
        stats.unknownType++;
      }
      continue;
    }

    if (type === "response_item") {
      const sub = String(p.type ?? "");
      if (sub === "message") {
        if (p.role === "assistant") {
          let textChars = 0;
          for (const block of Array.isArray(p.content) ? p.content : []) {
            if (typeof block?.text === "string") textChars += block.text.length;
          }
          pushAssistantEvent(ts, { textChars });
        }
        // role user/developer: skipped. user-role items duplicate the
        // event_msg/user_message prompt and additionally carry harness-
        // injected context (instructions, environment), which would inflate
        // prompt stats if counted.
      } else if (sub === "reasoning") {
        // Fold reasoning size into the next assistant event's thinkingChars.
        // Plaintext summary/content lengths when present; otherwise the
        // encrypted_content length is used as a size proxy.
        let chars = 0;
        for (const s of Array.isArray(p.summary) ? p.summary : []) {
          if (typeof s?.text === "string") chars += s.text.length;
        }
        for (const c of Array.isArray(p.content) ? p.content : []) {
          if (typeof c?.text === "string") chars += c.text.length;
        }
        if (chars === 0 && typeof p.encrypted_content === "string") {
          chars = p.encrypted_content.length;
        }
        pendingThinking += chars;
      } else if (sub === "function_call") {
        pushAssistantEvent(ts, {
          toolCalls: [toToolCallRef(p.name, String(p.call_id ?? ""), String(p.arguments ?? ""))],
        });
      } else if (sub === "custom_tool_call") {
        pushAssistantEvent(ts, {
          toolCalls: [toToolCallRef(p.name, String(p.call_id ?? ""), String(p.input ?? ""))],
        });
      } else if (sub === "local_shell_call") {
        pushAssistantEvent(ts, {
          toolCalls: [toToolCallRef("local_shell", String(p.call_id ?? ""), JSON.stringify(p.action ?? {}))],
        });
      } else if (sub === "web_search_call") {
        pushAssistantEvent(ts, {
          toolCalls: [toToolCallRef("web_search", String(p.call_id ?? p.id ?? ""), JSON.stringify(p.action ?? {}))],
        });
      } else if (sub === "function_call_output" || sub === "custom_tool_call_output") {
        const callId = String(p.call_id ?? "");
        const ev: Event = {
          kind: "tool_result",
          ...base(ts),
          toolUseId: callId,
          isError: pendingErrByCallId.get(callId) ?? outputLooksLikeError(String(p.output ?? "")),
        };
        pendingErrByCallId.delete(callId);
        if (callId) resultsByCallId.set(callId, ev);
        push(ev);
      } else {
        stats.unknownType++;
      }
      continue;
    }

    stats.unknownType++;
  }

  if (events.length === 0) return null;

  if (!sessionId) {
    // Fall back to the rollout filename: rollout-<timestamp>-<uuid>.jsonl
    const name = basename(filePath, ".jsonl");
    const m = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    sessionId = m ? m[1] : name;
  }
  for (const ev of events) ev.sessionId = sessionId;

  stats.unknownEventRatio = stats.lines > 0 ? stats.unknownType / stats.lines : 0;
  const timestamps = events.map((e) => e.ts).filter((t) => t > 0);
  const session: ParsedSession = {
    sessionId,
    projectHash,
    events,
    stats,
    firstTs: timestamps.length > 0 ? Math.min(...timestamps) : 0,
    lastTs: timestamps.length > 0 ? Math.max(...timestamps) : 0,
  };
  if (localCwd) session.localCwd = localCwd;
  return session;
}

// ---------------------------------------------------------------------------
// Discovery: ~/.codex/sessions/**/*.jsonl
// ---------------------------------------------------------------------------

export async function findCodexSessionFiles(root?: string): Promise<string[]> {
  const dir = root ?? join(homedir(), ".codex", "sessions");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return []; // dir absent or unreadable → no Codex sessions
  }
  const files: string[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      files.push(join(e.parentPath ?? dir, e.name));
    }
  }
  return files.sort();
}
