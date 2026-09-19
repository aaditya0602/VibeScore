/**
 * HTML rendering: self-contained local skill report.
 *
 * The richer sibling of renderReport() in report.ts — produces a complete
 * static HTML document with inline CSS only. Zero external requests: no
 * fonts, no CDNs, no scripts required. Everything interpolated from data
 * is escaped.
 */

import type { ProjectSummary, Bundle } from "./report.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}

function fmtMinutes(m: number): string {
  return m >= 60 ? (m / 60).toFixed(1) + "h" : m.toFixed(0) + "m";
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

/** clamp a 0..1-ish metric to a bar width percentage */
function barWidth(x: number): string {
  const clamped = Math.max(0, Math.min(1, x));
  return (clamped * 100).toFixed(1) + "%";
}

interface MetricSpec {
  key: keyof ProjectSummary;
  name: string;
  lowerBetter: boolean;
}

const BAR_METRICS: MetricSpec[] = [
  { key: "correctionRatio", name: "Correction ratio", lowerBetter: true },
  { key: "loopBurnFraction", name: "Loop-burn fraction", lowerBetter: true },
  { key: "firstPromptContextScore", name: "First-prompt context", lowerBetter: false },
  { key: "verifyAfterEditRatio", name: "Verify after edit", lowerBetter: false },
  { key: "toolSuccessRate", name: "Tool success rate", lowerBetter: false },
  { key: "errorRecoveryRate", name: "Error recovery rate", lowerBetter: false },
];

function metricRow(spec: MetricSpec, value: number): string {
  const cls = spec.lowerBetter ? "bar bar-lower" : "bar";
  const note = spec.lowerBetter ? ' <span class="hint">(lower is better)</span>' : "";
  return `
      <div class="metric">
        <div class="metric-head">
          <span class="metric-name">${escapeHtml(spec.name)}${note}</span>
          <span class="metric-value">${escapeHtml(pct(value))}</span>
        </div>
        <div class="track"><div class="${cls}" style="width:${barWidth(value)}"></div></div>
      </div>`;
}

function outcomeChips(outcomes: Record<string, number>): string {
  const entries = Object.entries(outcomes);
  if (entries.length === 0) return '<span class="chip chip-muted">no outcomes</span>';
  return entries
    .map(([k, v]) => `<span class="chip">${escapeHtml(k)} &times;${escapeHtml(String(v))}</span>`)
    .join("\n          ");
}

function modelChips(hist: Record<string, number>): string {
  const entries = Object.entries(hist).filter(([, tokens]) => tokens > 0);
  if (entries.length === 0) return '<span class="chip chip-muted">no model data</span>';
  return entries
    .map(([m, t]) => `<span class="chip chip-model">${escapeHtml(m)} · ${escapeHtml(fmtTokens(t))} tok</span>`)
    .join("\n          ");
}

function statCell(label: string, value: string): string {
  return `
        <div class="stat">
          <div class="stat-value">${escapeHtml(value)}</div>
          <div class="stat-label">${escapeHtml(label)}</div>
        </div>`;
}

function projectCard(s: ProjectSummary): string {
  const title = s.label ?? s.projectHash.slice(0, 12) + "…";
  return `
    <section class="card">
      <h2>${escapeHtml(title)}</h2>
      <p class="meta">
        ${escapeHtml(String(s.episodes))} episodes ·
        ${escapeHtml(String(s.promptCount))} prompts ·
        ${escapeHtml(fmtMinutes(s.activeMinutes))} active ·
        ${escapeHtml(fmtTokens(s.effectiveTokens))} effective tokens
      </p>
      ${BAR_METRICS.map((spec) => metricRow(spec, s[spec.key] as number)).join("\n")}
      <div class="chip-row">
        <span class="chip-row-label">Outcomes</span>
          ${outcomeChips(s.outcomes)}
      </div>
      <div class="chip-row">
        <span class="chip-row-label">Models</span>
          ${modelChips(s.modelHistogram)}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------

export function renderHtmlReport(summaries: ProjectSummary[], bundle: Bundle): string {
  const o = bundle.overall;

  const overallCard = `
    <section class="card card-overall">
      <h2>Overall</h2>
      <div class="stat-grid">
        ${statCell("episodes", String(o.episodes))}
        ${statCell("prompts", String(o.promptCount))}
        ${statCell("active time", fmtMinutes(o.activeMinutes))}
        ${statCell("effective tokens", fmtTokens(o.effectiveTokens))}
        ${statCell("correction ratio", pct(o.correctionRatio))}
        ${statCell("loop-burn fraction", pct(o.loopBurnFraction))}
        ${statCell("tool success rate", pct(o.toolSuccessRate))}
        ${statCell("verify-after-edit", pct(o.verifyAfterEditRatio))}
      </div>
    </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VibeScore — local skill report</title>
<style>
  :root {
    --bg: #f6f7f9;
    --card: #ffffff;
    --text: #1a1d21;
    --muted: #5c6570;
    --border: #e2e6ea;
    --track: #edf0f3;
    --bar: #3b82c4;
    --bar-lower: #c47a3b;
    --banner-bg: #e7f3ea;
    --banner-border: #b7dcc0;
    --banner-text: #1d4d2b;
    --chip-bg: #eef1f4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171a;
      --card: #1d2126;
      --text: #e8eaed;
      --muted: #9aa4ae;
      --border: #2c323a;
      --track: #262c33;
      --bar: #5b9bd5;
      --bar-lower: #d59a5b;
      --banner-bg: #17301e;
      --banner-border: #2b5a39;
      --banner-text: #a4d8b2;
      --chip-bg: #262c33;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  main { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 1.5rem; margin: 0 0 6px; }
  h2 { font-size: 1.1rem; margin: 0 0 10px; }
  .banner {
    background: var(--banner-bg);
    border: 1px solid var(--banner-border);
    color: var(--banner-text);
    border-radius: 10px;
    padding: 14px 18px;
    margin: 18px 0 28px;
    font-weight: 600;
  }
  .banner .banner-sub {
    font-weight: 400;
    font-size: 0.85rem;
    margin-top: 6px;
    opacity: 0.85;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px 22px;
    margin-bottom: 22px;
  }
  .meta { color: var(--muted); font-size: 0.9rem; margin: 0 0 16px; }
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 14px;
  }
  .stat-value { font-size: 1.35rem; font-weight: 700; }
  .stat-label { color: var(--muted); font-size: 0.8rem; }
  .metric { margin-bottom: 12px; }
  .metric-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 0.88rem;
    margin-bottom: 4px;
  }
  .metric-name { color: var(--text); }
  .metric-value { color: var(--muted); font-variant-numeric: tabular-nums; }
  .hint { color: var(--muted); font-size: 0.78rem; }
  .track {
    background: var(--track);
    border-radius: 6px;
    height: 10px;
    overflow: hidden;
  }
  .bar { background: var(--bar); height: 100%; border-radius: 6px; }
  .bar-lower { background: var(--bar-lower); }
  .chip-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
  }
  .chip-row-label {
    color: var(--muted);
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-right: 4px;
  }
  .chip {
    background: var(--chip-bg);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 11px;
    font-size: 0.82rem;
    white-space: normal;
  }
  .chip-muted { color: var(--muted); }
  footer { color: var(--muted); font-size: 0.8rem; margin-top: 8px; }
</style>
</head>
<body>
<main>
  <h1>VibeScore — local skill report</h1>
  <div class="banner">
    Generated 100% locally — no LLM, no network. Every number below was computed
    on your machine from your own session logs.
    <div class="banner-sub">
      generated ${escapeHtml(bundle.generatedAt)} · schema ${escapeHtml(bundle.schemaVersion)} · agent ${escapeHtml(bundle.agent)}
    </div>
  </div>
${overallCard}
${summaries.map(projectCard).join("\n")}
  <footer>Nothing has left this machine. Bars are div widths, not tracking pixels.</footer>
</main>
</body>
</html>
`;
}
