/** Read-only GoDaddy Agent Name Service (ANS) discovery adapter.
 * Uses only the documented registered-agent search and detail routes. It never
 * follows response-provided links or invokes discovered agent endpoints.
 */
export interface AnsSearchInput { query: string; pageSize?: number; }
export interface AnsAgentSummary {
  agentId: string; ansName: string | null; displayName: string; description: string;
  host: string | null; status: string; protocol: string | null; capabilities: string[];
  trustScore: number | null; indexedAt: string | null;
}
export interface AnsSearchResult { totalItems: number | null; agents: AnsAgentSummary[]; }
export interface AnsAgentTrust {
  agentId: string; ansName: string | null; displayName: string; description: string;
  host: string | null; status: string; trustScore: number | null;
  trustVector: { identity: number | null; integrity: number | null };
  coverageRatio: number | null; computedPillars: string[]; missingSignals: string[];
  signals: Array<{ name: string; pillar: string | null; score: number | null; missing: boolean }>;
}

type FetchLike = typeof fetch;
const ALLOWED_HOSTS = new Set(['api.ote-godaddy.com', 'api.godaddy.com']);
const SEARCH_PATH = '/v1/ans/registered-agents';
const DETAIL_PATH = '/v1/ans/registered-agents/';
const MAX_RESPONSE_BYTES = 1_000_000;

export function ansStatus() {
  return { enabled: Boolean(process.env.ANS_API_TOKEN?.trim()), environment: (process.env.ANS_BASE_URL ?? '').includes('api.godaddy.com') ? 'production' : 'ote' };
}

function credentials() {
  const token = process.env.ANS_API_TOKEN?.trim();
  return token ? `Bearer ${token}` : null;
}
function baseUrl() {
  const value = process.env.ANS_BASE_URL?.trim() || 'https://api.ote-godaddy.com';
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('ANS service configuration is invalid.'); }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname.toLowerCase()) || url.port || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('ANS service configuration is invalid.');
  }
  return url.origin;
}
function string(v: unknown, max = 2000): string | null { return typeof v === 'string' ? v.slice(0, max) : null; }
function score(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null; }
function safeArray(v: unknown): unknown[] { return Array.isArray(v) ? v.slice(0, 40) : []; }
function validEnvelope(v: any): v is { items: any[] } { return Boolean(v && typeof v === 'object' && Array.isArray(v.items)); }
function parseSummary(agent: any): AnsAgentSummary | null {
  if (!agent || typeof agent !== 'object' || typeof agent.agentId !== 'string' || agent.agentId.length > 160) return null;
  const endpoints = safeArray(agent.endpoints);
  const endpoint = endpoints.find((e: any) => e && typeof e === 'object');
  const functions = endpoint ? safeArray(endpoint.functions) : [];
  const capabilities = functions.map((f: any) => string(f?.name, 120)).filter((s): s is string => Boolean(s)).slice(0, 20);
  const scores = agent.scores && typeof agent.scores === 'object' ? agent.scores : {};
  const lifecycle = agent.lifecycle && typeof agent.lifecycle === 'object' ? agent.lifecycle : {};
  return {
    agentId: agent.agentId.slice(0, 160), ansName: string(agent.ansName, 240),
    displayName: string(agent.agentDisplayName, 160) ?? 'Unnamed agent',
    description: string(agent.agentDescription, 500) ?? '', host: string(agent.agentHost, 253),
    status: string(lifecycle.status ?? agent.agentStatus, 32) ?? 'UNKNOWN',
    protocol: endpoint ? string(endpoint.protocol, 32) : null, capabilities,
    trustScore: score(scores.trustScore ?? agent.trustScore), indexedAt: string(agent.indexedAt, 40),
  };
}
async function requestJson(path: string, fetchImpl: FetchLike): Promise<any> {
  const auth = credentials();
  if (!auth) throw new Error('ANS discovery is not configured.');
  const response = await fetchImpl(`${baseUrl()}${path}`, {
    method: 'GET', headers: { authorization: auth, accept: 'application/json' },
    signal: AbortSignal.timeout(8_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(response.status === 404 ? 'ANS agent was not found.' : 'ANS discovery is temporarily unavailable.');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('ANS response is too large.');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('ANS response is too large.');
  try { return JSON.parse(text); } catch { throw new Error('ANS returned an invalid response.'); }
}
export async function searchAnsAgents(input: AnsSearchInput, fetchImpl: FetchLike = fetch): Promise<AnsSearchResult> {
  if (!input || typeof input.query !== 'string' || input.query.trim().length < 2 || input.query.trim().length > 128) throw new Error('Enter a search between 2 and 128 characters.');
  const pageSize = Math.max(1, Math.min(20, Math.floor(input.pageSize ?? 8)));
  const params = new URLSearchParams({ query: input.query.trim(), pageSize: String(pageSize), totalRequired: 'true' });
  const body = await requestJson(`${SEARCH_PATH}?${params}`, fetchImpl);
  if (!validEnvelope(body)) throw new Error('ANS returned an invalid discovery response.');
  const agents = body.items.map(parseSummary).filter((x: AnsAgentSummary | null): x is AnsAgentSummary => Boolean(x));
  return { totalItems: Number.isInteger(body.totalItems) && body.totalItems >= 0 ? Math.min(body.totalItems, 1_000_000) : null, agents };
}
export async function getAnsAgentTrust(agentId: string, fetchImpl: FetchLike = fetch): Promise<AnsAgentTrust> {
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(agentId)) throw new Error('ANS agent identifier is invalid.');
  const data = await requestJson(`${DETAIL_PATH}${encodeURIComponent(agentId)}`, fetchImpl);
  if (!data || typeof data !== 'object' || data.agentId !== agentId) throw new Error('ANS returned an invalid agent response.');
  const summary = parseSummary(data);
  if (!summary) throw new Error('ANS returned an invalid agent response.');
  const vector = data.trustVector && typeof data.trustVector === 'object' ? data.trustVector : {};
  const coverage = data.coverage && typeof data.coverage === 'object' ? data.coverage : {};
  const missingness = data.missingness && typeof data.missingness === 'object' ? data.missingness : {};
  const signals = data.signals && typeof data.signals === 'object' ? Object.entries(data.signals).slice(0, 30).map(([name, raw]: [string, any]) => ({
    name: name.slice(0, 120), pillar: string(raw?.pillar, 60), score: score(raw?.score), missing: raw?.missing === true,
  })) : [];
  return {
    agentId: summary.agentId, ansName: summary.ansName, displayName: summary.displayName,
    description: summary.description, host: summary.host, status: summary.status,
    trustScore: score(data.trustScore), trustVector: { identity: score(vector.identity), integrity: score(vector.integrity) },
    coverageRatio: typeof coverage.coverageRatio === 'number' && Number.isFinite(coverage.coverageRatio) ? Math.max(0, Math.min(1, coverage.coverageRatio)) : null,
    computedPillars: safeArray(coverage.computedPillars).map(x => string(x, 60)).filter((x): x is string => Boolean(x)).slice(0, 20),
    missingSignals: safeArray(missingness.missingSignals).map(x => string(x, 120)).filter((x): x is string => Boolean(x)).slice(0, 30),
    signals,
  };
}
