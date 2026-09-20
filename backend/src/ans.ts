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
interface AnsProvenance { environment: 'production' | 'ote'; retrievedAt: string; }
export interface AnsSearchResult extends AnsProvenance { totalItems: number | null; agents: AnsAgentSummary[]; }
export interface AnsAgentTrust extends AnsProvenance {
  agentId: string; ansName: string | null; displayName: string; description: string;
  host: string | null; status: string; trustScore: number | null;
  trustVector: { identity: number | null; integrity: number | null };
  coverageRatio: number | null; computedPillars: string[]; missingSignals: string[];
  signals: Array<{ name: string; pillar: string | null; score: number | null; missing: boolean }>;
}

type FetchLike = typeof fetch;
export class AnsRequestError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const ALLOWED_HOSTS = new Set(['api.ote-godaddy.com', 'api.godaddy.com']);
const SEARCH_PATH = '/v1/ans/search-registered-agents';
const DETAIL_PATH = '/v1/ans/registered-agents/';
const MAX_RESPONSE_BYTES = 1_000_000;

export function ansStatus() {
  try { return { enabled: Boolean(credentials()), environment: environment(baseUrl()) }; }
  catch { return { enabled: false, environment: 'unknown' }; }
}

function credentials() {
  const key = process.env.ANS_API_KEY?.trim();
  const secret = process.env.ANS_API_SECRET?.trim();
  return key && secret ? `sso-key ${key}:${secret}` : null;
}
function environment(origin: string): AnsProvenance['environment'] { return origin === 'https://api.godaddy.com' ? 'production' : 'ote'; }
function baseUrl() {
  const value = process.env.ANS_BASE_URL?.trim() || 'https://api.godaddy.com';
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
async function requestJson(path: string, fetchImpl: FetchLike, payload?: object): Promise<{ data: any; provenance: AnsProvenance }> {
  const auth = credentials();
  if (!auth) throw new Error('ANS discovery is not configured.');
  const origin = baseUrl();
  const response = await fetchImpl(`${origin}${path}`, {
    method: payload ? 'POST' : 'GET', headers: { authorization: auth, accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(8_000), redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) throw new AnsRequestError(404, 'ANS agent was not found.');
    if (response.status === 429) throw new AnsRequestError(429, 'ANS request limit reached. Try again shortly.');
    if (response.status === 401 || response.status === 403) throw new AnsRequestError(503, 'ANS credentials were rejected by the registry.');
    throw new AnsRequestError(503, 'ANS discovery is temporarily unavailable.');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('ANS response is too large.');
  }
  if (!response.body) throw new Error('ANS returned an invalid response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('ANS response is too large.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); } catch { throw new Error('ANS returned an invalid response.'); }
  return { data, provenance: { environment: environment(origin), retrievedAt: new Date().toISOString() } };
}
export async function searchAnsAgents(input: AnsSearchInput, fetchImpl: FetchLike = fetch): Promise<AnsSearchResult> {
  if (!input || typeof input.query !== 'string' || input.query.trim().length < 2 || input.query.trim().length > 128) throw new Error('Enter a search between 2 and 128 characters.');
  if (input.pageSize !== undefined && !Number.isFinite(input.pageSize)) throw new Error('ANS page size must be a finite number.');
  const pageSize = Math.max(1, Math.min(20, Math.floor(input.pageSize ?? 8)));
  const { data: body, provenance } = await requestJson(SEARCH_PATH, fetchImpl, { query: input.query.trim(), pageSize, totalRequired: true });
  if (!validEnvelope(body)) throw new Error('ANS returned an invalid discovery response.');
  const agents = body.items.slice(0, pageSize).map(parseSummary).filter((x: AnsAgentSummary | null): x is AnsAgentSummary => Boolean(x));
  return { ...provenance, totalItems: Number.isInteger(body.totalItems) && body.totalItems >= 0 ? Math.min(body.totalItems, 1_000_000) : null, agents };
}
export async function getAnsAgentTrust(agentId: string, fetchImpl: FetchLike = fetch): Promise<AnsAgentTrust> {
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(agentId)) throw new Error('ANS agent identifier is invalid.');
  const { data, provenance } = await requestJson(`${DETAIL_PATH}${encodeURIComponent(agentId)}`, fetchImpl);
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
    ...provenance,
    agentId: summary.agentId, ansName: summary.ansName, displayName: summary.displayName,
    description: summary.description, host: summary.host, status: summary.status,
    trustScore: score(data.trustScore), trustVector: { identity: score(vector.identity), integrity: score(vector.integrity) },
    coverageRatio: typeof coverage.coverageRatio === 'number' && Number.isFinite(coverage.coverageRatio) ? Math.max(0, Math.min(1, coverage.coverageRatio)) : null,
    computedPillars: safeArray(coverage.computedPillars).map(x => string(x, 60)).filter((x): x is string => Boolean(x)).slice(0, 20),
    missingSignals: safeArray(missingness.missingSignals).map(x => string(x, 120)).filter((x): x is string => Boolean(x)).slice(0, 30),
    signals,
  };
}
