/**
 * Synthetic Claude Code session generator.
 *
 * generateSession(persona, rng) -> string[] of JSONL lines in the EXACT shape
 * collector/src/parse.ts consumes: valid parentUuid chain, monotonic ISO
 * timestamps, assistant `message.usage`, tool_use / tool_result pairs.
 *
 * The generator is structured so the collector recovers each persona's
 * engineered features:
 *   - loopBurnFraction: a burst of identical tool calls whose effective-token
 *     budget is solved to hit persona.loopBurn exactly (fraction = loopEff /
 *     (normalEff + loopEff)). Same command string 3+ times → parser's loop
 *     detector fires (episodes.ts window=8, min repeats=3).
 *   - correctionRatio: a fraction of prompts drawn from the CORRECTION_RE lexicon.
 *   - verifyAfterEditRatio: each work prompt is one edit stretch (edits use
 *     unique file_paths so they don't self-loop, then >=5 unique-path reads
 *     close the stretch); a verify command in the gap marks it verified.
 *   - firstPromptContextScore: first prompt sized to persona word/ref/constraint
 *     targets, matching FILE_REF_RE and CONSTRAINT_RE.
 *   - outcome: git commit (architect) / passing verify (builder) / failing
 *     loop at the tail (thrasher).
 */

import {
  type Persona,
  randInt,
  randFloat,
  jitter,
  pick,
  pickN,
} from "./personas.ts";

const MODEL = "claude-sonnet-5";
const AGENT_VERSION = "2.0.0";

// Fixed epoch base so timestamps (and therefore all derived features) are fully
// reproducible for a given seed — no wall-clock enters generation.
export const DEFAULT_BASE_TS = Date.parse("2025-01-06T09:00:00.000Z");

// price-proportional effective tokens — mirrors collector/src/features.ts
function effOf(u: Usage): number {
  return u.input + 5 * u.output + 1.25 * u.cacheWrite + 0.1 * u.cacheRead;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// ---------------------------------------------------------------------------
// prose banks — text is discarded by the parser after it derives numbers, so
// these only need to hit the right lexicons / word counts.
// ---------------------------------------------------------------------------

const FILE_POOL = [
  "src/auth.ts", "src/db.ts", "src/api.ts", "src/router.ts", "src/cache.ts",
  "src/server.ts", "src/queue.ts", "src/config.ts", "src/model.ts", "src/utils.ts",
] as const;

// each phrase carries >=1 CONSTRAINT_RE marker
const CONSTRAINT_PHRASES = [
  "You must validate every input before use.",
  "Make sure the existing tests keep passing.",
  "Do not store any secret in plaintext.",
  "Always propagate errors to the caller.",
  "Never block the main event loop.",
  "Ensure the public API stays backward compatible.",
  "Keep each function small and focused.",
  "Avoid introducing any new global state.",
  "Only touch the modules named above.",
] as const;

const NEUTRAL_FILLER = [
  "walk through the existing structure first and follow the patterns already established here",
  "explain the reasoning behind each design choice as you go so it stays reviewable",
  "the module boundaries matter and the data flow between them has to stay clean",
  "prefer the standard library over new dependencies and keep the surface area tight",
  "document the tricky parts inline and leave the rest of the codebase untouched for now",
] as const;

const BUILDER_PROMPTS = [
  "add the handler in src/api.ts and make sure it validates the body",
  "wire up the database layer in src/db.ts, keep the queries simple",
  "now build the router in src/router.ts and ensure routes are typed",
  "extend the cache in src/cache.ts, do not break existing callers",
] as const;

const THRASHER_FIRST = [
  "just build me a quick app that works",
  "make a thing that does the stuff please",
  "set up the whole project for me now",
  "get something running as fast as possible",
] as const;

const THRASHER_PROMPTS = [
  "make it work now",
  "why is this taking so long",
  "just do the whole thing already",
  "do the rest of it too",
  "keep going and finish it",
] as const;

const CORRECTION_PROMPTS = [
  "no, that's wrong, revert it",
  "nope",
  "that doesn't work, stop",
  "undo that, wrong file",
  "no, roll back the last change",
] as const;

const VERIFY_CMDS = [
  "npm test", "npm run build", "npm run lint", "tsc --noEmit",
  "npm run check", "vitest run", "npm run typecheck",
] as const;

// ---------------------------------------------------------------------------
// prompt text builders
// ---------------------------------------------------------------------------

function architectFirstPrompt(persona: Persona, rng: () => number): string {
  const nRefs = randInt(rng, persona.firstPromptFileRefs[0], persona.firstPromptFileRefs[1]);
  const nCons = randInt(rng, persona.firstPromptConstraints[0], persona.firstPromptConstraints[1]);
  const targetWords = Math.round(jitter(rng, persona.firstPromptWords, persona.firstPromptWordsJitter));
  const files = pickN(rng, FILE_POOL, Math.max(nRefs, 1));
  const parts: string[] = [];
  parts.push(`Build the authentication and persistence layer spanning ${files.join(", ")}.`);
  for (const c of pickN(rng, CONSTRAINT_PHRASES, Math.max(nCons, 1))) parts.push(c);
  // pad with neutral filler (no lexicon tokens) until the word target is met
  let text = parts.join(" ");
  let i = 0;
  while (wordCount(text) < targetWords) {
    text += " " + NEUTRAL_FILLER[i % NEUTRAL_FILLER.length];
    i++;
  }
  return text;
}

function builderFirstPrompt(persona: Persona, rng: () => number): string {
  const nRefs = randInt(rng, persona.firstPromptFileRefs[0], persona.firstPromptFileRefs[1]);
  const nCons = randInt(rng, persona.firstPromptConstraints[0], persona.firstPromptConstraints[1]);
  const files = pickN(rng, FILE_POOL, Math.max(nRefs, 1));
  const parts: string[] = [`Build a small REST service in ${files.join(" and ")}.`];
  for (const c of pickN(rng, CONSTRAINT_PHRASES, Math.max(nCons, 1))) parts.push(c);
  let text = parts.join(" ");
  const targetWords = Math.round(jitter(rng, persona.firstPromptWords, persona.firstPromptWordsJitter));
  let i = 0;
  while (wordCount(text) < targetWords) {
    text += " " + NEUTRAL_FILLER[i % NEUTRAL_FILLER.length];
    i++;
  }
  return text;
}

function firstPrompt(persona: Persona, rng: () => number): string {
  if (persona.tier === "architect") return architectFirstPrompt(persona, rng);
  if (persona.tier === "builder") return builderFirstPrompt(persona, rng);
  // thrasher: vague, 5-15 words, no refs, no constraints
  return pick(rng, THRASHER_FIRST);
}

function followupPrompt(persona: Persona, rng: () => number): string {
  if (persona.tier === "thrasher") return pick(rng, THRASHER_PROMPTS);
  if (persona.tier === "builder") return pick(rng, BUILDER_PROMPTS);
  // architect follow-ups stay specific
  const file = pick(rng, FILE_POOL);
  const c = pick(rng, CONSTRAINT_PHRASES);
  return `Next, implement the module in ${file}. ${c}`;
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// turn plan — build structure first (so we can size the loop to a token target),
// then render sequentially into a valid uuid/timestamp chain.
// ---------------------------------------------------------------------------

interface PromptTurn { t: "prompt"; text: string }
interface ToolTurn {
  t: "tool";
  tool: string;
  input: Record<string, unknown>;
  isError: boolean;
  usage: Usage;
  isLoop: boolean;
}
type Turn = PromptTurn | ToolTurn;

function normalUsage(rng: () => number): Usage {
  return {
    input: randInt(rng, 5, 100),
    output: randInt(rng, 150, 2500),
    cacheRead: randInt(rng, 5000, 120000),
    cacheWrite: randInt(rng, 0, 30000),
  };
}

/** Build a usage whose effOf ≈ target E, staying inside realistic field ranges. */
function usageForEffective(E: number, rng: () => number): Usage {
  const input = randInt(rng, 5, 100);
  let rem = E - input;
  const output = Math.max(0, Math.min(2500, Math.floor(rem / 5)));
  rem -= 5 * output;
  const cacheRead = Math.max(0, Math.min(120000, Math.floor(rem / 0.1)));
  rem -= 0.1 * cacheRead;
  const cacheWrite = Math.max(0, Math.min(30000, Math.round(rem / 1.25)));
  return { input, output, cacheRead, cacheWrite };
}

export function generateSession(
  persona: Persona,
  rng: () => number,
  opts: { sessionId?: string; baseTs?: number } = {},
): string[] {
  const sessionId = opts.sessionId ?? `sess-${randInt(rng, 100000, 999999)}`;
  const baseTs = opts.baseTs ?? DEFAULT_BASE_TS;

  const plan: Turn[] = [];
  let editCounter = 0;
  let readCounter = 0;
  let verifyIdx = 0;

  const nPrompts = randInt(rng, persona.workPrompts[0], persona.workPrompts[1]);
  let loopInsertAt = -1; // plan index at which to splice a mid-session loop

  for (let p = 0; p < nPrompts; p++) {
    const isFirst = p === 0;
    const isCorrection = !isFirst && rng() < persona.correctionProb;
    const text = isFirst
      ? firstPrompt(persona, rng)
      : isCorrection
        ? pick(rng, CORRECTION_PROMPTS)
        : followupPrompt(persona, rng);
    plan.push({ t: "prompt", text });

    // edit stretch — unique file_path per edit so edits don't self-loop
    const nEdits = randInt(rng, persona.editsPerPrompt[0], persona.editsPerPrompt[1]);
    for (let e = 0; e < nEdits; e++) {
      plan.push({
        t: "tool",
        tool: e % 2 === 0 ? "Write" : "Edit",
        input: { file_path: `src/feat${editCounter++}.ts`, content: "..." },
        isError: false,
        usage: normalUsage(rng),
        isLoop: false,
      });
    }

    // optional verification in the stretch gap (rotate command → no verify-loop)
    if (nEdits > 0 && rng() < persona.verifyProb) {
      plan.push({
        t: "tool",
        tool: "Bash",
        input: { command: VERIFY_CMDS[verifyIdx++ % VERIFY_CMDS.length] },
        isError: false,
        usage: normalUsage(rng),
        isLoop: false,
      });
    }

    // >=5 unique-path reads close the stretch (so the next prompt is a NEW stretch)
    for (let r = 0; r < 5; r++) {
      plan.push({
        t: "tool",
        tool: "Read",
        input: { file_path: `src/ref${readCounter++}.ts` },
        isError: false,
        usage: normalUsage(rng),
        isLoop: false,
      });
    }

    if (isFirst) loopInsertAt = plan.length; // splice mid-session loop after prompt 1's block
  }

  // ---- normal effective-token total (loop turns not yet added) ----
  let normalEff = 0;
  for (const turn of plan) if (turn.t === "tool") normalEff += effOf(turn.usage);

  // ---- size + build the failure loop to hit persona.loopBurn exactly ----
  const target = Math.min(0.9, Math.max(0.001, jitter(rng, persona.loopBurn, persona.loopBurnJitter)));
  const loopEff = (target / (1 - target)) * normalEff;
  let k = randInt(rng, persona.loopRepeats[0], persona.loopRepeats[1]);
  const MAX_PER = 60000;
  while (loopEff / k > MAX_PER) k++; // keep per-turn usage inside realistic ranges
  const per = loopEff / k;
  const loopCmd = persona.loopErrors
    ? "npm test -- --run failing-suite"
    : "git status --porcelain";
  const loopTurns: Turn[] = [];
  for (let i = 0; i < k; i++) {
    loopTurns.push({
      t: "tool",
      tool: "Bash",
      input: { command: loopCmd },
      isError: persona.loopErrors,
      usage: usageForEffective(per, rng),
      isLoop: true,
    });
  }

  if (persona.loopPlacement === "end") {
    // thrasher: failing loop is the tail → error_abandon outcome
    for (const t of loopTurns) plan.push(t);
  } else {
    const at = loopInsertAt >= 0 ? loopInsertAt : plan.length;
    plan.splice(at, 0, ...loopTurns);
  }

  // ---- ending turn (shipping signal) ----
  if (persona.ending === "commit") {
    plan.push({
      t: "tool",
      tool: "Bash",
      input: { command: `git commit -m "ship feature ${randInt(rng, 1, 999)}"` },
      isError: false,
      usage: normalUsage(rng),
      isLoop: false,
    });
  } else if (persona.ending === "verify") {
    const passes = rng() < persona.shipProb;
    plan.push({
      t: "tool",
      tool: "Bash",
      input: { command: pick(rng, VERIFY_CMDS) },
      isError: !passes,
      usage: normalUsage(rng),
      isLoop: false,
    });
  }
  // thrasher "abandon": nothing appended — the failing loop already sits at the tail

  return render(plan, persona, rng, sessionId, baseTs);
}

// ---------------------------------------------------------------------------
// render plan → JSONL lines with a valid chain + monotonic timestamps
// ---------------------------------------------------------------------------

function render(
  plan: Turn[],
  _persona: Persona,
  rng: () => number,
  sessionId: string,
  baseTs: number,
): string[] {
  const lines: string[] = [];
  let clock = baseTs;
  let prevUuid: string | null = null;
  let uuidN = 0;
  const newUuid = () => `${sessionId}-e${++uuidN}`;

  const pace = () => {
    // usual 30s–5min turn cadence, occasional 15–30min idle
    if (rng() < 0.08) clock += randInt(rng, 15 * 60_000, 30 * 60_000);
    else clock += randInt(rng, 30_000, 300_000);
    return clock;
  };
  const shortGap = () => {
    clock += randInt(rng, 1_000, 30_000);
    return clock;
  };

  const base = (ts: number, parent: string | null, uuid: string, sidechain = false) => ({
    uuid,
    parentUuid: parent,
    sessionId,
    timestamp: new Date(ts).toISOString(),
    isSidechain: sidechain,
    version: AGENT_VERSION,
    gitBranch: "main",
    cwd: "C:/sim/project",
  });

  for (const turn of plan) {
    if (turn.t === "prompt") {
      const uuid = newUuid();
      lines.push(JSON.stringify({
        type: "user",
        ...base(pace(), prevUuid, uuid),
        message: { role: "user", content: turn.text },
      }));
      prevUuid = uuid;
    } else {
      const toolUseId = `tu-${uuidN}-${Math.floor(rng() * 1e6)}`;
      const aUuid = newUuid();
      lines.push(JSON.stringify({
        type: "assistant",
        ...base(pace(), prevUuid, aUuid),
        requestId: `req-${aUuid}`,
        message: {
          role: "assistant",
          model: MODEL,
          content: [
            { type: "text", text: "working on it." },
            { type: "tool_use", id: toolUseId, name: turn.tool, input: turn.input },
          ],
          usage: {
            input_tokens: turn.usage.input,
            output_tokens: turn.usage.output,
            cache_read_input_tokens: turn.usage.cacheRead,
            cache_creation_input_tokens: turn.usage.cacheWrite,
          },
        },
      }));
      prevUuid = aUuid;

      const rUuid = newUuid();
      lines.push(JSON.stringify({
        type: "user",
        ...base(shortGap(), prevUuid, rUuid),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: turn.isError }],
        },
      }));
      prevUuid = rUuid;
    }
  }

  return lines;
}
