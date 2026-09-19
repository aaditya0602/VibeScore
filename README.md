# VibeScore

**The skill layer for building with AI.** VibeScore measures how developers use AI on real projects, turns weak spots into targeted practice, and provides controlled interview rounds that can support a public skills profile.

Built for **VTHacks 14**.

- **Live beta:** [vibescore-vthacks-2026.azurewebsites.net](https://vibescore-vthacks-2026.azurewebsites.net)
- **Hokie experience:** [vibescore-vthacks-2026.azurewebsites.net/hokie](https://vibescore-vthacks-2026.azurewebsites.net/hokie)

## What it does

VibeScore provides two complementary paths:

1. **Measure real AI-assisted work.** A local collector and MCP server analyze explicitly selected Claude Code and Codex sessions. They derive workflow signals without uploading raw prompts, source code, paths, or filenames.
2. **Practise and prove AI-building skills.** Twelve focused drills cover framing, context, debugging, verification, review, and efficiency. Three timed JavaScript interview rounds combine an AI coach with objective server-side tests.

Users can keep their profile private or publish separate challenge and workflow scores to the leaderboard. Imported workflow evidence remains provisional; controlled interview results are assessed independently.

## Hackathon experience

The VTHacks build includes:

- A polished responsive application with account recovery, privacy controls, dashboards, profiles, and leaderboards.
- A no-account **Hokie AI Builder Readiness Check** that recommends a focused next drill.
- Gemini-powered interview coaching when a Gemini API key is configured.
- A GoDaddy Agent Name Service trust explorer for discovering registered agents and reviewing registry trust signals.
- A privacy-first MCP flow with report explanation, drill recommendations, publish preview, and confirmation-bound publishing.

The project targets **Overall**, **Best UI/UX**, **Cloudforce HokieAI Side Kick**, **Best Use of Gemini API**, **Best Ut Prosim**, **Best Domain Name**, and **Best Use of ANS**.

## Product flow

```text
Choose a project or challenge
        ↓
Collect private workflow evidence or complete a controlled task
        ↓
Receive a score, explanation, and recommended drill
        ↓
Practise with an AI coach and objective tests
        ↓
Keep the result private or publish it to a profile
```

## Run locally

Requirements: Node.js 22.20 or newer and npm.

```powershell
npm install
Copy-Item .env.example .env
npm run build
npm start
```

Open [http://localhost:8787](http://localhost:8787).

The application stores its SQLite database in `backend/data` by default. Set `VIBESCORE_DATA_DIR` to use another persistent location.

## Configure the AI coach

The core challenges and code runner work without an AI provider. For Gemini:

```dotenv
AI_PROVIDER=gemini
AI_API_KEY=your-server-side-key
AI_MODEL=gemini-3.8-flash
```

The provider key remains server-side. Z.ai and Azure OpenAI-compatible endpoints are also supported; see [.env.example](.env.example) for every setting.

## Configure GoDaddy ANS

```dotenv
ANS_BASE_URL=https://api.ote-godaddy.com
ANS_API_TOKEN=your-event-or-ote-token
```

The backend only contacts allowlisted GoDaddy HTTPS hosts. It rejects redirects and oversized responses, returns a sanitized trust summary, and never invokes endpoints supplied by discovered agents.

## Use the MCP server

Run the local stdio server with:

```powershell
npm run mcp
```

Configure an MCP client to execute `node` with the absolute path to `collector/src/mcp.ts`. The server exposes:

- `analyze_project`
- `explain_report`
- `recommend_drills`
- `preview_publish`
- `publish_report`

Analysis is limited to the project and session files supplied to the tool. Publishing requires a preview digest and explicit confirmation. Set `VIBESCORE_SERVER`, `VIBESCORE_HANDLE`, and `VIBESCORE_TOKEN` in the MCP process environment to publish an aggregate report.

## Privacy and security

- Accounts and public profiles are private by default.
- Passwords and recovery codes are stored as one-way hashes.
- Raw prompts and source code stay out of workflow upload bundles.
- Interview code runs in QuickJS without Node.js, filesystem, process, environment, or network access.
- Hidden tests and reference solutions remain server-side.
- Provider and ANS credentials never enter browser bundles.
- State-changing browser requests use same-origin checks, secure cookies, bounded payloads, and rate limits.

## Development checks

```powershell
npm run build
npm test
```

The suite covers collectors, scoring, accounts, challenge redaction, the QuickJS sandbox, API flows, MCP publishing safeguards, Gemini-compatible requests, ANS response sanitization, and synthetic ranking separation.

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for the architecture, API surface, and deployment details.
