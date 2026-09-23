# VibeScore product requirements

**Status:** Public beta

**Primary audience:** Students and early-career developers who want to improve and prove how well they build with AI

## 1. Product summary

VibeScore is the skill and credibility layer for AI-assisted software development. It measures how a developer uses AI on real projects, converts weak areas into targeted drills, runs controlled AI-assisted coding interviews, and lets the developer publish an evidence-based skill profile and leaderboard score.

The product keeps two kinds of evidence separate:

- **Workflow evidence** comes from explicitly selected Claude Code and Codex sessions. It measures process signals and remains provisional.
- **Challenge evidence** comes from controlled, timed tasks with server-side grading. It produces the assessed public rating.

## 2. Problem

AI coding tools can generate output quickly, but current portfolios and interview platforms rarely show whether someone can:

- frame a useful task;
- provide the right context;
- identify and correct failures;
- verify generated work;
- review tradeoffs and security implications;
- use agents efficiently without losing ownership of the result.

Developers also lack a clear bridge from "I use AI" to credible evidence that employers, mentors, and peers can inspect. Existing coding leaderboards mostly measure algorithm recall, while raw AI-usage counts reward volume instead of judgment.

## 3. Product goals

1. Give users a useful assessment within two minutes and a meaningful practice task within ten minutes.
2. Measure AI-building behavior without uploading raw prompts, source code, local paths, or filenames.
3. Keep controlled challenge ratings distinct from imported real-work signals.
4. Make every public result opt-in and explain what evidence produced it.
5. Give users a practical skill-development path: assess, practise, verify, and publish.

## 4. Non-goals

- Claiming that a workflow score proves job performance.
- Ranking users from practice attempts or raw prompt volume.
- Uploading complete conversations or repositories for analytics.

## 5. Users and core journeys

### Visitor

1. Opens the AI Builder Readiness Check at `/check` without creating an account.
2. Receives a skill diagnosis and one recommended drill.
3. Creates a private account if they want to save progress.

### Registered builder

1. Completes drills and timed interviews with AI coaching.
2. Runs objective tests and receives a controlled challenge result.
3. Chooses whether to publish a profile and appear on a leaderboard.

### Project builder

1. Runs the local VibeScore MCP against a project and session files they explicitly select.
2. Reviews an aggregate workflow report and recommended drills.
3. Previews the exact publish payload and digest.
4. Confirms publication in a separate step.
5. Keeps the workflow score visibly labeled as provisional.

## 6. Principles

- **Local-first privacy.** Analysis of Claude Code and Codex sessions happens on the user's machine. Raw prompts and source code are never uploaded — only validated numeric aggregates leave the local collector.
- **Explicit selection only.** The collector and MCP never scan agent history automatically; the user supplies the project root and session files.
- **Provisional vs. assessed.** Imported workflow evidence is always labeled provisional and never inflates the assessed challenge rating.
- **Confirm before publish.** Publishing requires a preview of the exact payload and its digest, then explicit confirmation.
- **Private by default.** New accounts and profiles start private; nothing becomes public without opt-in.

## 7. Current implementation

### Completed product capabilities

| Area | Delivered behavior | Evidence in repository |
| --- | --- | --- |
| Public application | Responsive single-page product with landing, practice, privacy, leaderboard, profiles, and settings | `web/src/app.js`, `backend/public` |
| Accounts | Registration, secure sessions, login, recovery code, visibility controls, and cascading deletion | `backend/src/store.ts`, `backend/src/server.ts` |
| Curriculum | Thirteen drills across framing, context, debugging, verification, review, and efficiency | `backend/src/challenges.ts` |
| Interviews | Six timed JavaScript interview rounds with workspace artifacts, visible and hidden tests, and an ownership debrief | `backend/src/challenges.ts`, `backend/src/assessment.ts` |
| Safe execution | QuickJS worker with time and memory limits and no Node.js, filesystem, process, environment, or network APIs | `backend/src/runner.ts` |
| Assessment | Transparent drill feedback and objective interview grading | `backend/src/assessment.ts` |
| Ratings | Separate controlled challenge rating and provisional workflow rating | `backend/src/platform-store.ts`, `backend/src/scoring.ts` |
| Profiles and leaderboard | Private-by-default profiles with opt-in public challenge and workflow leaderboards | `backend/src/platform-store.ts`, `web/src/app.js` |
| Local collector | Claude Code and Codex parsing, project identity, episode generation, feature extraction, comparison, and self-contained report | `collector/src` |
| MCP | Explicit local session discovery, analysis, explanation, recommendations, publish preview, and confirmation-bound publish tools | `collector/src/mcp.ts` |
| Workflow connection | Signed-in Connect page, one-time API-token rotation, copyable Codex and Claude Code configuration, and private dashboard score | `backend/src/server.ts`, `/connect` in `web/src/app.js` |
| AI coach | Server-side, provider-agnostic coaching adapter over an OpenAI-compatible chat-completions endpoint | `backend/src/providers.ts` |
| AI Builder Readiness Check | No-account, short readiness check with a recommended next drill | `/check` in `web/src/app.js` |
| Persistence | SQLite storage for accounts, attempts, messages, workflow bundles, scores, and feedback | `backend/src/store.ts`, `backend/src/platform-store.ts` |

### Delivered privacy and security properties

- Accounts and profiles start private.
- Passwords, recovery codes, and sessions are stored as one-way hashes (scrypt for passwords, SHA-256 for tokens); sessions expire after 7 days.
- Raw prompts, source code, commands, paths, and filenames are excluded from publishable workflow bundles.
- MCP publication requires a preview digest and explicit confirmation.
- Hidden tests, reference solutions, and private rubric details stay server-side.
- AI coach credentials stay in server-side environment variables and are never returned to the browser.
- Interview code runs without host or network capabilities.
- Browser mutations use same-origin checks, bounded payloads, secure cookies, and rate limits.

### Current verification state

The automated suite covers collectors, privacy reduction, MCP safeguards, scoring, accounts, assessment, hidden-test redaction, QuickJS isolation, API flows, provider request behavior, and deterministic score separation.

## 8. The collector and MCP server

The local collector (`collector/src`) parses Claude Code and Codex session files that the user explicitly points it at, establishes project identity, generates episodes, extracts behavioral features, and produces a self-contained HTML report. Nothing is uploaded at this stage.

The VibeScore MCP server (`collector/src/mcp.ts`) exposes six tools to a local MCP-capable client:

| Tool | Purpose |
| --- | --- |
| `analyze_project` | Analyze repository structure and explicitly selected Claude Code/Codex sessions locally |
| `find_project_sessions` | After an explicit request, locate local session files matching one absolute repository path (returns paths only) |
| `explain_report` | Explain the provisional evidence and limitations behind a generated report |
| `recommend_drills` | Recommend practice drills based on a local report |
| `preview_publish` | Preview the exact numeric aggregate bundle and return its SHA-256 digest |
| `publish_report` | Publish a previously previewed bundle; requires the matching digest, explicit confirmation, and server/handle/token environment variables |

`publish_report` enforces HTTPS (except localhost), rejects redirects, and rejects any server URL containing embedded credentials, a query string, or a fragment.

## 9. Workflow scoring

Scoring (`backend/src/scoring.ts`) is percentile-based with uncertainty:

- Each raw behavioral metric (loop-burn, edit scope, correction ratio, context quality, prompt specificity, redirect depth, tool success, verify-after-edit habit, error recovery, shipped fraction) becomes an empirical percentile against the population.
- Percentiles roll up into four weighted dimensions — **efficiency**, **direction**, **craft**, and **shipping** — combined as a weighted geometric mean and mapped to an Elo-like rating centered near 1500.
- **Rating deviation (RD)** narrows as evidence volume (episode count) grows and widens when coherence checks fail, producing a visible confidence band.
- Imported workflow evidence is always reported with a **provisional** tier, kept separate from the assessed challenge rating produced by controlled interviews.

## 10. Drills and interviews

Thirteen drills (`backend/src/challenges.ts`) cover framing, context, debugging, verification, review, and efficiency, each with a stated skill, difficulty, and time estimate. When an AI provider is configured, drill answers receive a semantic rubric review: the model scores each rubric criterion against the exact scenario, treats the answer as untrusted data, and cannot exceed caps set by deterministic quality signals (length, structure, reused answers). Without a provider, or if the review fails validation, a transparent phrase/rubric checker grades the answer instead. Either way, users see per-criterion evidence and feedback, and drill results never affect the assessed challenge rating.

Six timed interview rounds combine pure-function problems and repository-style scenarios:

1. **Build a deterministic retry planner** — foundation, verification
2. **Reconcile an AI usage ledger** — intermediate, debugging
3. **Schedule dependent build tasks** — advanced, framing
4. **Repair an AI-generated authorization patch** — intermediate, review (repository-style, six server-side tests covering authentication, ownership, admin access, and non-disclosure)
5. **Extend a saved-search repository** — intermediate, framing (repository-style, six tests covering normalization, ownership, duplicates, limits, and ordering)
6. **Debug a stale-cache incident** — advanced, debugging (repository-style, six tests covering freshness, expiry, coalescing, and invalidation)

Each interview provides starter code and any attached artifacts beside an editor, runs visible tests on demand while hidden tests stay server-side, offers the AI coach, and closes with an **ownership debrief**: explain the final code without the assistant, name one rejected AI suggestion, name one remaining risk, and justify the tests. Correctness and debrief evidence are reported as separate, non-blended results.

Interview code executes in a QuickJS WASM runtime inside a worker thread with a per-test interrupt, an overall time ceiling, and a bounded memory limit; it has no access to Node.js, filesystem, process, environment, or network APIs.

## 11. AI coach

The AI coach is a server-side adapter (`backend/src/providers.ts`) over any OpenAI-compatible chat-completions endpoint. Gemini is the intended default provider because of its free tier; other OpenAI-compatible endpoints are also supported by configuration. The provider, model, endpoint, and API key are all set server-side and never exposed to the browser. The adapter enforces HTTPS, request timeouts, bounded output length, and returns useful errors on quota, timeout, or empty-response conditions without losing the user's in-progress work.

The coach gives hints and reasoning help during drills and interviews without producing a complete solution.

## 12. Accounts, privacy, and publishing

- Registration creates a handle and, optionally, a password; a one-time recovery code is issued and never shown again.
- Sessions and API tokens are opaque, hashed, and expire (sessions after 7 days).
- Users can rotate their API connection token, which revokes the previous one.
- Visibility (`isPublic`) is off by default and toggled explicitly.
- Account deletion requires typing the exact handle and cascades to owned attempts, messages, bundles, and scores.
- Workflow bundle uploads (`POST /api/bundles`) accept only the validated numeric aggregate produced by `preview_publish` — never raw session content.

## 13. Leaderboards and profiles

- Two independent leaderboards: **challenge** (assessed, from controlled interviews) and **workflow** (provisional, from imported sessions).
- Public profiles show only what the user has opted to publish, with evidence counts and labels.
- Sorting and ties are deterministic; private users never appear in public listings.

## 14. Security requirements

- Same-origin checks, bounded request bodies, secure cookies, and rate limits on mutating endpoints (registration, login, recovery, token rotation).
- Passwords hashed with scrypt; tokens and recovery codes hashed with SHA-256; nothing reversible is stored.
- Hidden interview tests and reference solutions never appear in API responses, logs, or the browser bundle.
- AI provider credentials and any future third-party credentials stay server-side.
- Interview code execution has no host, filesystem, process, environment, or network access.
- Foreign-key cascades remove all user-owned data on account deletion.

## 15. Deployment

VibeScore is deployed as a Docker container (`Dockerfile`, Node.js ≥ 22.20) to a single Render free web service. Data lives in SQLite and is continuously replicated to Backblaze B2 via Litestream for durability across restarts. The deployment runs a single instance and sleeps when idle, waking on the next request. The server derives its canonical origin from Render's injected `RENDER_EXTERNAL_URL` unless `PUBLIC_ORIGIN` is set for a custom domain. GitHub Actions CI runs the build, the full test suite, and a production-image smoke test on every push. Full setup and operational steps are documented in `docs/DEPLOY.md`.

## 16. Acceptance criteria

- The readiness check at `/check` works without an account, on mobile and desktop.
- A user can complete drills, run an interview, and view results without ever exposing hidden tests or reference solutions to the client.
- Practice (drill) results never change the assessed challenge rating.
- Workflow bundles uploaded via the MCP contain only validated numeric aggregates; no prompts, code, paths, or filenames.
- `preview_publish` and `publish_report` cannot be bypassed: publishing without a matching digest and explicit confirmation fails.
- Private accounts and profiles never appear in public leaderboards or profile lookups.
- Account deletion removes all owned attempts, messages, bundles, and scores.
- The AI coach degrades gracefully (useful error, preserved work) when unconfigured, rate-limited, or timing out.
- Interview code cannot access the filesystem, network, process, or environment from within the QuickJS sandbox.

## 17. Test checklist

### Build and automated suite

- [ ] Install succeeds from a clean checkout with the documented Node.js version.
- [ ] `npm run build` completes and produces the browser bundle.
- [ ] `npm test` passes with no skipped or flaky tests.
- [ ] No generated secrets, databases, or local data appear in `git status`.

### Public pages and navigation

- [ ] Landing page loads over HTTPS with no console errors.
- [ ] Every header, footer, call-to-action, and back link reaches the intended route.
- [ ] Refreshing a client-side route serves the application instead of a 404.
- [ ] Loading, empty, success, and failure states are visible and understandable.
- [ ] `/check` works without authentication.

### Account lifecycle

- [ ] Registration validates handles and password requirements.
- [ ] Recovery code appears once and can recover the account.
- [ ] Login, logout, expired sessions, and invalid credentials behave correctly.
- [ ] Profiles start private.
- [ ] Publishing and unpublishing updates leaderboard/profile visibility.
- [ ] Account deletion requires the correct handle and removes owned attempts, messages, bundles, and scores.
- [ ] Auth responses and browser storage never reveal raw session tokens, password hashes, or recovery hashes.

### Drills and interviews

- [ ] All thirteen drills load and show the correct skill, difficulty, time, brief, and requirements.
- [ ] Drill drafts save and submitted feedback matches the documented rubric behavior.
- [ ] Practice results never change the controlled public rating.
- [ ] All six interview rounds start with a correct deadline and starter code.
- [ ] Autosave survives navigation and reload.
- [ ] Visible tests show useful evidence without revealing hidden inputs.
- [ ] Submission produces stable results and first-rated-attempt eligibility behaves as documented.
- [ ] The timer, expired attempt, repeated submission, and simultaneous action paths are handled.

### Code-runner security

- [ ] Correct solutions pass visible and hidden cases.
- [ ] Infinite loops terminate within the limit.
- [ ] Large allocations fail safely.
- [ ] Node.js APIs, filesystem, process, environment, and network calls are unavailable.
- [ ] Hidden tests and reference solutions never appear in API responses, logs, or browser bundles.

### Scoring, profiles, and leaderboards

- [ ] Challenge and workflow leaderboards remain separate.
- [ ] Practice attempts do not inflate assessed ratings.
- [ ] Thin workflow history widens uncertainty and remains provisional.
- [ ] Private users never appear publicly.
- [ ] Public profiles show the correct evidence count and labels.
- [ ] Sorting and ties are deterministic.
- [ ] Synthetic test accounts cannot influence real public rankings.

### Collector and MCP

- [ ] Claude Code and Codex fixtures parse without leaking prompt text, commands, source, filenames, or paths.
- [ ] Malformed and partial session files fail safely or report diagnostics.
- [ ] Explicit project and session selection is enforced.
- [ ] The HTML report is self-contained and escapes hostile labels.
- [ ] MCP handshake exposes only the documented tools.
- [ ] `preview_publish` returns the exact payload and digest.
- [ ] `publish_report` rejects missing confirmation, wrong digest, changed payload, and non-HTTPS production targets.
- [ ] A successful upload stores only the validated aggregate.

### AI coach

- [ ] `/api/status` reports the configured provider and model truthfully without returning the key.
- [ ] A live coaching request succeeds against the configured provider.
- [ ] The assistant gives hints and reasoning help without giving a complete interview solution.
- [ ] Per-user and total daily limits work.
- [ ] 401, 403, 429, timeout, provider 5xx, malformed response, and empty response show useful messages and preserve the user's work.
- [ ] The API key is absent from HTML, JavaScript, network responses, logs, and Git history.

### Deployment and operations

- [ ] Canonical domain resolves from an external network.
- [ ] HTTPS certificate is valid and HTTP redirects safely.
- [ ] The effective origin (`PUBLIC_ORIGIN`, else Render's `RENDER_EXTERNAL_URL`) matches the canonical HTTPS URL, session cookies carry `Secure`, and cross-origin state-changing requests are rejected.
- [ ] `/api/status` returns HTTP 200 after a cold start (including a Render sleep/wake cycle).
- [ ] SQLite data survives an application restart and is recoverable from the Litestream/B2 replica.
- [ ] Security headers, secure cookies, TLS policy, request limits, and rate limits remain active.
- [ ] A fresh private-browser session can complete the core assess-practise-prove flow.

### UI/UX and accessibility

- [ ] Layout works at 360 px, 768 px, and 1280 px widths.
- [ ] Text meets readable contrast and does not rely on color alone.
- [ ] Every form control has a visible label, clear error, and logical tab order.
- [ ] Focus remains visible and dialogs or dynamic regions return focus appropriately.
- [ ] Timers and status changes have accessible text.
- [ ] Touch targets are large enough for mobile use.
- [ ] Reduced-motion preferences are respected.
- [ ] Long handles, messages, and errors do not break layouts.

## 18. Roadmap

- **Verified / drill-backed tier.** A rating tier that requires a minimum amount of controlled, drill-backed evidence rather than imported workflow signals alone.
- **Cohort normalization by model class.** As the population grows, percentile against a matched cohort (model/tool class) instead of one global population.
- **Anti-gaming coherence checks.** Stronger detection of inconsistent or synthetic-looking session histories before they widen or narrow rating deviation.
- **Repository depth analysis.** Extend the collector beyond episode-level features toward structural signals in the codebase itself.
- **Live session capture.** Capture sessions as they happen instead of relying on file import after the fact.
