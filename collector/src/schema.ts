/**
 * Common event schema — the privacy boundary of the whole system.
 *
 * INVARIANT: no field in these types may carry prose (prompt text, code,
 * file contents, file paths). Message text is reduced to derived numbers
 * inside the parser and discarded. Tool inputs survive only as salted
 * hashes for loop detection. If you add a string field here, it must be
 * an enum-like tag or a hash — never user content.
 */

export type EventKind =
  | "prompt"        // human-authored user message
  | "assistant"     // model response (may contain tool calls)
  | "tool_result"   // result of a tool call
  | "system"        // harness event (hooks, notices)
  | "meta";         // attachments, queue ops, titles — counted, not analyzed

export interface UsageNumbers {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Derived from prompt text at the parse boundary; text itself is discarded. */
export interface PromptStats {
  chars: number;
  words: number;
  lines: number;
  codeFences: number;
  fileRefs: number;        // path-looking tokens
  questionMarks: number;
  constraintMarkers: number; // "must", "don't", "only", "make sure", numbers with units…
  /** correction/redirect classifier (v0 lexicon) */
  isCorrection: boolean;
  isRedirect: boolean;     // softer steer ("instead", "actually, let's…")
}

export interface ToolCallRef {
  id: string;
  /** tool name is harness vocabulary, not user content */
  tool: string;
  /** salted hash of tool input for loop-signature matching; input discarded */
  inputHash: string;
  inputChars: number;
  /** coarse class for verification/edit heuristics */
  klass: "edit" | "read" | "exec" | "search" | "agent" | "other";
  /** exec commands only: matched a verification pattern (test/build/lint) — boolean derived locally, command discarded */
  looksLikeVerification: boolean;
  looksLikeCommit: boolean;
}

export interface Event {
  kind: EventKind;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  ts: number;               // epoch ms
  isSidechain: boolean;
  agentVersion: string;
  /** hash of cwd — identifies project without revealing the path */
  projectHash: string;
  branchHash: string | null;

  // kind === "prompt"
  prompt?: PromptStats;

  // kind === "assistant"
  model?: string;
  usage?: UsageNumbers;
  toolCalls?: ToolCallRef[];
  textChars?: number;
  thinkingChars?: number;

  // kind === "tool_result"
  toolUseId?: string;
  isError?: boolean;

  // kind === "system"
  systemSubtype?: string;
}

export interface ParseStats {
  lines: number;
  parsed: number;
  badJson: number;
  unknownType: number;
  /** coherence checks (anti-tamper v0) */
  chainBreaks: number;         // parentUuid references a uuid never seen
  timeRegressions: number;     // timestamp earlier than predecessor
  unknownEventRatio: number;
}

export interface ParsedSession {
  sessionId: string;
  projectHash: string;
  events: Event[];
  stats: ParseStats;
  firstTs: number;
  lastTs: number;
  /**
   * LOCAL-ONLY: real cwd recovered from the log, used on-device to read
   * git history for outcome detection. Never serialized into a bundle —
   * bundles carry projectHash only.
   */
  localCwd?: string;
}
