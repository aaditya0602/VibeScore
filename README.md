# VibeScore

**The skill layer for building with AI.** VibeScore measures how you actually work with coding agents, turns weak spots into targeted practice, and lets you prove your skill through controlled, objectively graded interview rounds — with a public profile you choose to share.

## What it does

VibeScore keeps two kinds of evidence separate, so the score means something:

1. **Workflow evidence — measure real AI-assisted work.** A local collector and MCP server analyze Claude Code and Codex sessions you explicitly select. They reduce each session to numeric workflow signals (correction loops, context quality, verification habits, delivery) on your machine. Raw prompts, source code, commands, paths, and filenames never leave it. Imported evidence is scored against the population and always stays *provisional*.
2. **Challenge evidence — practise and prove skill.** Thirteen focused drills cover framing, context, debugging, verification, review, and efficiency. Six timed coding interviews combine an AI coach, realistic workspace files, objective server-side tests, and an ownership debrief. Controlled first attempts produce the assessed public rating.

New visitors can take the no-account **AI Builder Readiness Check** at `/check`, which recommends a first drill.

```text
Choose a project or a challenge
        ↓
Collect private workflow evidence, or complete a controlled task
        ↓
Get a score, an explanation, and a recommended drill
        ↓
Practise with an AI coach and objective tests
        ↓
Keep results private, or publish them to your profile
```

## Run locally

Requirements: Node.js 22.20+ and npm.

```powershell
npm install
Copy-Item .env.example .env
npm run build
npm start
```

Open [http://localhost:8787](http://localhost:8787). Data is stored in a SQLite database under `backend/data` by default; set `VIBESCORE_DATA_DIR` to change the location.

## Configure the AI coach (optional)

Challenges, the code runner, and scoring all work without an AI provider. To enable the coach and semantic drill review, add a server-side key — Gemini has a free tier ([Google AI Studio](https://aistudio.google.com/apikey)):

```dotenv
AI_PROVIDER=gemini
AI_API_KEY=your-server-side-key
AI_MODEL=gemini-3.8-flash
```

Any OpenAI-compatible chat-completions endpoint also works; see [.env.example](.env.example). Keys stay on the server and never reach the browser. Daily request limits cap spend per deployment and per user. Note that on Gemini's free tier Google may use request content (coach messages, drill answers) to improve its products; workflow telemetry is never sent to the provider.

## Deploy

VibeScore runs free on a Render web service (Docker), with the SQLite database continuously replicated to Backblaze B2 by [Litestream](https://litestream.io) so data survives restarts. The [render.yaml](render.yaml) blueprint sets everything up; [docs/DEPLOY.md](docs/DEPLOY.md) walks through it step by step.

Run exactly one instance — SQLite with Litestream does not support horizontal scaling.

## Use the MCP server

```powershell
npm run mcp
```

Point an MCP client at `node` with the absolute path to `collector/src/mcp.ts`. Tools:

| Tool | Purpose |
|---|---|
| `find_project_sessions` | Discover Claude Code / Codex session files for a chosen project (paths only, nothing analyzed) |
| `analyze_project` | Reduce the selected sessions to numeric workflow signals, locally |
| `explain_report` | Explain the signals in plain language |
| `recommend_drills` | Map the weakest dimension to focused drills |
| `preview_publish` | Show exactly what would be uploaded, with a digest |
| `publish_report` | Upload the previewed aggregate — requires the digest and explicit confirmation |

After signing in, open `/connect` to generate a one-time connection token and copy ready-made Codex or Claude Code configuration. The server only ever receives a validated numeric aggregate.

## Privacy and security

- Accounts and profiles are private by default; publishing is an explicit choice.
- Passwords and recovery codes are stored as one-way hashes.
- Workflow uploads contain derived numbers only — never prompts, code, commands, or paths.
- Interview code runs in a QuickJS sandbox with no Node.js, filesystem, process, environment, or network access.
- Hidden tests and reference solutions stay on the server.
- AI provider keys never enter browser bundles.
- State-changing requests use same-origin checks, HttpOnly session cookies, bounded payloads, and rate limits; responses carry a strict Content-Security-Policy.

## Project layout

| Path | Contents |
|---|---|
| `collector/` | Session parsers (Claude Code, Codex), feature extraction, local report CLI, MCP server |
| `backend/src/` | HTTP server, accounts, scoring engine, challenge catalog, grading, QuickJS runner, AI provider adapter |
| `web/src/` | Single-page app (bundled by esbuild into `backend/public/assets`) |
| `harness/` | Persona simulator that generates synthetic sessions with known skill tiers to validate scoring |
| `docs/` | Deployment guide |

## Development

```powershell
npm run build
npm test
```

The test suite covers session parsing, feature extraction, scoring, accounts, challenge redaction, the QuickJS sandbox, API flows, MCP publishing safeguards, AI-provider requests, and synthetic skill-tier separation.

See [PRD.md](PRD.md) for product requirements, acceptance criteria, the release checklist, and the roadmap.
