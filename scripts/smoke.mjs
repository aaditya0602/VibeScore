#!/usr/bin/env node
/** Public, read-only release smoke test. Usage: npm run smoke -- https://host */

const raw = process.argv[2] ?? process.env.VIBESCORE_SERVER;
if (!raw) throw new Error('Provide the deployed origin, for example: npm run smoke -- https://vibescore.example');
const origin = new URL(raw);
const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(origin.hostname.toLowerCase());
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) throw new Error('Smoke target must use HTTPS except on loopback.');
if (origin.username || origin.password || origin.search || origin.hash || (origin.pathname !== '/' && origin.pathname !== '')) throw new Error('Smoke target must be an origin without credentials, path, query, or fragment.');

const MAX = 512_000;
async function read(path, expectedType = 'application/json') {
  const response = await fetch(new URL(path, origin), { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { accept: expectedType } });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}.`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith(expectedType)) throw new Error(`${path} returned ${type || 'no content type'}.`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX) throw new Error(`${path} exceeded the smoke-test response limit.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX) throw new Error(`${path} exceeded the smoke-test response limit.`);
  return new TextDecoder().decode(bytes);
}

function assert(condition, message) { if (!condition) throw new Error(message); }
const status = JSON.parse(await read('/api/status'));
assert(status.ok === true && typeof status.version === 'string', '/api/status is malformed.');
assert(status.ai && typeof status.ai.enabled === 'boolean', '/api/status is missing AI status.');
assert(status.ans && typeof status.ans.enabled === 'boolean', '/api/status is missing ANS status.');
assert(status.databricks && typeof status.databricks.enabled === 'boolean', '/api/status is missing Databricks status.');

const catalog = JSON.parse(await read('/api/challenges'));
assert(Array.isArray(catalog.challenges) && catalog.challenges.length === 19, 'Expected 13 drills and 6 interviews.');
assert(!JSON.stringify(catalog).includes('hidden'), 'Challenge catalog exposed hidden judge data.');

const metadata = JSON.parse(await read('/.well-known/mcp.json'));
assert(metadata.transport === 'STREAMABLE-HTTP' && new URL(metadata.endpoint).pathname === '/mcp', 'Hosted MCP metadata is malformed.');
assert(Array.isArray(metadata.tools) && metadata.tools.includes('preview_workflow_report') && metadata.tools.includes('publish_workflow_report'), 'Hosted MCP preview/publish tools are missing.');

const app = await read('/hokie', 'text/html');
assert(app.includes('VibeScore') && app.includes('/assets/app.js'), 'Application shell is malformed.');

console.log(JSON.stringify({
  ok: true,
  origin: origin.origin,
  version: status.version,
  challenges: catalog.challenges.length,
  ai: status.ai.enabled,
  ans: status.ans.enabled,
  databricks: status.databricks.enabled,
  hostedMcpTools: metadata.tools.length,
}, null, 2));
