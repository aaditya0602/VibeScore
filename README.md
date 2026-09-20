# VibeScore

**The skill layer for building with AI.** VibeScore measures how developers use AI on real projects, turns weak spots into targeted practice, and provides controlled interview rounds that can support a public skills profile.

Built for **VTHacks 14**.

- **Live beta:** [vibescore-vthacks-2026.azurewebsites.net](https://vibescore-vthacks-2026.azurewebsites.net)
- **Hokie experience:** [vibescore-vthacks-2026.azurewebsites.net/hokie](https://vibescore-vthacks-2026.azurewebsites.net/hokie)

## What it does

VibeScore provides two complementary paths:

1. **Measure real AI-assisted work.** A local collector and MCP server analyze explicitly selected Claude Code and Codex sessions. They derive workflow signals without uploading raw prompts, source code, paths, or filenames.
2. **Practise and prove AI-building skills.** Thirteen focused drills cover framing, context, debugging, verification, review, and efficiency. Six timed JavaScript interview rounds combine an AI coach with objective server-side tests.

Users can keep their profile private or publish separate challenge and workflow scores to the leaderboard. Imported workflow evidence remains provisional; controlled interview results are assessed independently.

## Hackathon experience

The VTHacks build includes:

- A polished responsive application with account recovery, privacy controls, dashboards, profiles, and leaderboards.
- A no-account **Hokie AI Builder Readiness Check** that recommends a focused next drill.
- A **Hokie AI Career Navigator** that pairs a VibeScore skill path with governed campus and career resources from Databricks Unity Catalog.
- Gemini-powered interview coaching when a Gemini API key is configured.
- A GoDaddy Agent Name Service trust explorer for discovering registered agents and reviewing registry trust signals.
- A privacy-first MCP flow with explicit project session discovery, report explanation, drill recommendations, publish preview, and confirmation-bound publishing.
- A guided Connect page that issues a one-time collector token and prepares Codex and Claude Code MCP configuration.

The project targets **Overall**, **Best UI/UX**, **Best Ut Prosim**, **Best Use of Gemini API**, **Best Domain Name**, **Deloitte x Databricks AI Agent for the Virginia Tech Student Experience**, and **GoDaddy Best Use of ANS**.

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

For Azure App Service, use one application instance, set `VIBESCORE_DATA_DIR=/home/data`, `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true`, and `TRUST_PROXY=1` so per-client rate limits use Azure's forwarded address. SQLite is the beta store and must remain on the persistent `/home` mount; scale-out requires replacing it with a shared database.

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
ANS_BASE_URL=https://api.godaddy.com
ANS_API_KEY=your-production-developer-key
ANS_API_SECRET=your-production-developer-secret
```

Create the key pair in the GoDaddy Classic Developer Portal and store both values only in the deployed app's server-side settings. VibeScore sends the pair with GoDaddy's `sso-key` authorization scheme. The backend only contacts allowlisted GoDaddy HTTPS hosts, rejects redirects and oversized responses, returns a sanitized trust summary, and never invokes endpoints supplied by discovered agents.

After the final HTTPS domain is connected, prepare and register the hosted scoring agent with:

```powershell
npm run ans -- prepare --host agent.example.com
npm run ans -- register --host agent.example.com
```

The helper stores the private key, CSR, and registration state under the gitignored `.local/ans` directory. The registration response contains the DNS challenge; after adding it at the registrar, use `npm run ans -- verify-acme`, inspect `npm run ans -- status`, add the returned discovery records, and finish with `npm run ans -- verify-dns`.

## Configure the Databricks career navigator

Create a SQL warehouse and run [databricks/setup.sql](databricks/setup.sql) to create the curated `campus_resources` table. Give the deployed identity only `USE CATALOG`, `USE SCHEMA`, and `SELECT` access required for that table, then set:

```dotenv
DATABRICKS_HOST=https://your-workspace.azuredatabricks.net
DATABRICKS_TOKEN=your-server-side-service-token
DATABRICKS_WAREHOUSE_ID=your-sql-warehouse-id
DATABRICKS_CATALOG=vibescore
DATABRICKS_SCHEMA=hokie
DATABRICKS_RESOURCES_TABLE=campus_resources
DATABRICKS_CLINIC_EVENTS_TABLE=clinic_event_v1
```

The token stays on the server. The adapter accepts only recognized Databricks workspace hosts, uses parameterized statements, and rejects redirects and oversized responses. Grant `SELECT` on `campus_resources` and only the `INSERT`/`MERGE` permissions needed on `clinic_event_v1`. Clinic exports use an idempotent event-ID merge from the bounded local outbox; failures back off and become visible dead letters after five attempts. `/api/status` reports whether the connection is configured without exposing the host, warehouse, table, or credential. When Databricks is unavailable, the navigator still returns its VibeScore drill and clinic events remain queued locally.

Open `/hokie` to use the public navigator. `POST /api/navigator/recommend` accepts a 10–500 character `goal` and one VibeScore `skill`: `framing`, `context`, `debugging`, `verification`, `review`, or `efficiency`.

## Run an opt-in clinic

The `/hokie` experience is free and its readiness check and career navigator require no account or public profile. Optional clinic evaluation records only coarse completion events, a VibeScore skill, readiness/follow-up bands, and an optional 1–5 usefulness rating. It never accepts names, email, account handles, prompts, code, ANS searches, or free-form feedback.

Configure a private pseudonym key on the server:

```dotenv
CLINIC_PSEUDONYM_SECRET=generate-at-least-32-random-characters
```

Participants explicitly opt in with a clinic code such as `VTHACKS26`. Their one-time participant token is held only in that browser so they can submit an optional follow-up or delete their clinic data. The server stores only its hash and a rotating keyed pseudonym. Participant records expire after 90 days. Public impact summaries suppress every metric, count, and freshness timestamp until at least ten participants have contributed, and synthetic demo cohorts remain separately labeled.

Facilitators can use the one-page [Hokie clinic facilitator guide](docs/clinic-facilitator-guide.md) for consent language, timing, a low-bandwidth worksheet, and reporting guardrails.

## Use the MCP server

Run the local stdio server with:

```powershell
npm run mcp
```

Configure an MCP client to execute `node` with the absolute path to `collector/src/mcp.ts`. The server exposes:

- `analyze_project`
- `find_project_sessions`
- `explain_report`
- `recommend_drills`
- `preview_publish`
- `publish_report`

Session discovery runs only after an explicit request, matches local Claude Code and Codex metadata to the selected repository, and returns paths without analyzing or uploading them. Analysis remains limited to the selected project and session files. Publishing requires a preview digest and explicit confirmation. Set `VIBESCORE_SERVER` and `VIBESCORE_TOKEN` in the MCP process environment to publish an aggregate report; the token determines the destination profile.

After signing in, open **Connect Codex + Claude** to create the one-time collector token and copy the prepared client configuration. The token is revocable and is stored by the server only as a one-way hash.

The deployed application also exposes a stateless MCP scoring agent at `/mcp` and advertises it at `/.well-known/mcp.json`. It provides public scoring explanations, drill recommendations, and public-profile verification. Publishing a workflow report through that endpoint requires the collector token. The local collector remains the privacy boundary: raw prompts, code, commands, filenames, and paths are never accepted by the hosted agent.

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

See [PRD.md](PRD.md) for product requirements, delivery status, sponsor-track implementation plans, acceptance criteria, and the release test checklist.
