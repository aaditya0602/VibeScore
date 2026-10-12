/** Read-only Databricks SQL adapter for governed campus resources. */

export type VibeScoreSkill = 'framing' | 'context' | 'debugging' | 'verification' | 'review' | 'efficiency';

export interface CampusResourceQuery {
  skill?: VibeScoreSkill;
  query?: string;
  limit?: number;
}

export interface CampusResource {
  resourceId: string;
  name: string;
  description: string;
  url: string;
  audience: string[];
  skillTags: string[];
  careerTags: string[];
  source: string;
  lastVerifiedAt: string | null;
}

export interface CampusResourceResult {
  resources: CampusResource[];
  source: 'Databricks Unity Catalog';
  retrievedAt: string;
  freshness: {
    newestLastVerifiedAt: string | null;
    oldestLastVerifiedAt: string | null;
  };
}

export interface DatabricksStatus {
  enabled: boolean;
  source: 'Databricks Unity Catalog';
}

export type FetchLike = typeof fetch;
export type QueryOptions = { deadlineMs?: number; pollIntervalMs?: number };
export interface DatabricksParameter { name:string; value:string; type:'STRING'|'INT'|'BOOLEAN'|'TIMESTAMP'; }

const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_DEADLINE_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const SKILLS = new Set<VibeScoreSkill>(['framing', 'context', 'debugging', 'verification', 'review', 'efficiency']);
const WORKSPACE_HOST_SUFFIXES = ['.azuredatabricks.net', '.cloud.databricks.com', '.gcp.databricks.com'];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const WAREHOUSE_ID = /^[A-Za-z0-9-]{1,128}$/;
const STATEMENT_ID = /^[A-Za-z0-9-]{1,128}$/;

export interface DatabricksConfig {
  origin: string;
  token: string;
  warehouseId: string;
  table: string;
}

function cleanEnvironmentValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function workspaceOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw.includes('://') ? raw : `https://${raw}`); }
  catch { throw new Error('Databricks service configuration is invalid.'); }
  const hostname = url.hostname.toLowerCase();
  const trusted = WORKSPACE_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix) && hostname.length > suffix.length);
  if (url.protocol !== 'https:' || !trusted || url.port || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Databricks service configuration is invalid.');
  }
  return url.origin;
}

function sqlIdentifier(value: string | null): string {
  if (!value || !IDENTIFIER.test(value)) throw new Error('Databricks service configuration is invalid.');
  return `\`${value}\``;
}

export function databricksConfigFor(tableVariable:'DATABRICKS_RESOURCES_TABLE'|'DATABRICKS_CLINIC_EVENTS_TABLE'): DatabricksConfig | null {
  const host = cleanEnvironmentValue('DATABRICKS_HOST');
  const token = cleanEnvironmentValue('DATABRICKS_TOKEN');
  const warehouseId = cleanEnvironmentValue('DATABRICKS_WAREHOUSE_ID');
  const catalog = cleanEnvironmentValue('DATABRICKS_CATALOG');
  const schema = cleanEnvironmentValue('DATABRICKS_SCHEMA');
  const tableName = cleanEnvironmentValue(tableVariable);
  if (!host || !token || !warehouseId || !catalog || !schema || !tableName) return null;
  if (!WAREHOUSE_ID.test(warehouseId)) throw new Error('Databricks service configuration is invalid.');
  return {
    origin: workspaceOrigin(host), token, warehouseId,
    table: [catalog, schema, tableName].map(sqlIdentifier).join('.'),
  };
}

export function databricksStatus(): DatabricksStatus {
  try { return { enabled: Boolean(databricksConfigFor('DATABRICKS_RESOURCES_TABLE')), source: 'Databricks Unity Catalog' }; }
  catch { return { enabled: false, source: 'Databricks Unity Catalog' }; }
}

function safeString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function safeTags(value: unknown): string[] {
  let values: unknown[] = [];
  if (Array.isArray(value)) values = value;
  else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) values = parsed; } catch { values = []; }
    } else values = trimmed.split(',');
  }
  return [...new Set(values.map(item => safeString(item, 80)).filter((item): item is string => Boolean(item)))].slice(0, 20);
}

function safeHttpsUrl(value: unknown): string | null {
  const raw = safeString(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href.slice(0, 2048);
  } catch { return null; }
}

function safeTimestamp(value: unknown): string | null {
  const raw = safeString(value, 80);
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

async function boundedJson(response: Response): Promise<any> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Databricks response is too large.');
  }
  if (!response.body) throw new Error('Databricks returned an invalid response.');
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
        throw new Error('Databricks response is too large.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
  catch { throw new Error('Databricks returned an invalid response.'); }
}

function unavailable(status: number): Error {
  if (status === 429) return new Error('Databricks is busy. Please try again shortly.');
  return new Error('Campus resources are temporarily unavailable.');
}

async function requestJson(
  cfg: DatabricksConfig,
  path: string,
  fetchImpl: FetchLike,
  deadline: number,
  init: RequestInit = {},
): Promise<any> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Databricks resource lookup timed out.');
  let response: Response;
  try {
    response = await fetchImpl(`${cfg.origin}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/json', ...init.headers },
      redirect: 'error', signal: AbortSignal.timeout(Math.min(8_000, remaining)),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('Databricks resource lookup timed out.');
    throw new Error('Campus resources are temporarily unavailable.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw unavailable(response.status);
  }
  return boundedJson(response);
}

function state(body: any): string | null {
  return safeString(body?.status?.state, 32)?.toUpperCase() ?? null;
}

function terminalFailure(current: string): boolean {
  return current === 'FAILED' || current === 'CANCELED' || current === 'CLOSED';
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

async function executeStatement(query: CampusResourceQuery, fetchImpl: FetchLike, options: QueryOptions): Promise<any> {
  const cfg = databricksConfigFor('DATABRICKS_RESOURCES_TABLE');
  if (!cfg) throw new Error('Databricks campus resources are not configured.');
  const limit = Math.max(1, Math.min(10, Math.floor(query.limit ?? 3)));
  const statement = [
    'SELECT resource_id, name, description, url, skill_tags, career_tags, source, last_verified_at',
    `FROM ${cfg.table}`,
    "WHERE (:skill = '' OR lower(skill_tags) LIKE concat('%', lower(:skill), '%'))",
    "AND (:query = '' OR lower(concat_ws(' ', name, description, career_tags, skill_tags)) LIKE concat('%', lower(:query), '%'))",
    'ORDER BY last_verified_at DESC',
    `LIMIT ${limit}`,
  ].join('\n');
  return executeDatabricksStatement(cfg,statement,[
    { name: 'skill', value: query.skill ?? '', type: 'STRING' },
    { name: 'query', value: query.query?.trim() ?? '', type: 'STRING' },
  ],fetchImpl,options);
}

/** Execute a statement assembled from trusted source text against an already validated table configuration. */
export async function executeDatabricksStatement(cfg:DatabricksConfig,statement:string,parameters:DatabricksParameter[],fetchImpl:FetchLike=fetch,options:QueryOptions={}):Promise<any> {
  const deadlineMs = Math.max(1, Math.min(30_000, Math.floor(options.deadlineMs ?? DEFAULT_DEADLINE_MS)));
  const deadline = Date.now() + deadlineMs;
  const created = await requestJson(cfg, '/api/2.0/sql/statements/', fetchImpl, deadline, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      warehouse_id: cfg.warehouseId,
      statement,
      parameters,
      disposition: 'INLINE', format: 'JSON_ARRAY', byte_limit: MAX_RESPONSE_BYTES,
      wait_timeout: '5s', on_wait_timeout: 'CONTINUE',
    }),
  });
  let body = created;
  let current = state(body);
  if (!current) throw new Error('Databricks returned an invalid response.');
  const statementId = safeString(body.statement_id, 128);
  const pollInterval = Math.max(0, Math.min(2_000, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)));
  while (current === 'PENDING' || current === 'RUNNING') {
    if (!statementId || !STATEMENT_ID.test(statementId)) throw new Error('Databricks returned an invalid response.');
    if (Date.now() + pollInterval >= deadline) throw new Error('Databricks resource lookup timed out.');
    await delay(pollInterval);
    body = await requestJson(cfg, `/api/2.0/sql/statements/${encodeURIComponent(statementId)}`, fetchImpl, deadline);
    current = state(body);
    if (!current) throw new Error('Databricks returned an invalid response.');
  }
  if (terminalFailure(current)) throw new Error('Campus resources are temporarily unavailable.');
  if (current !== 'SUCCEEDED') throw new Error('Databricks returned an invalid response.');
  if (body?.result?.next_chunk_internal_link || body?.result?.external_links) throw new Error('Databricks returned an incomplete response.');
  return body;
}

function parseResources(body: any, limit: number): CampusResource[] {
  const columns = body?.manifest?.schema?.columns;
  const rows = body?.result?.data_array;
  if (!Array.isArray(columns) || !Array.isArray(rows)) throw new Error('Databricks returned an invalid resource response.');
  const names = columns.slice(0, 30).map((column: any) => safeString(column?.name, 80));
  const required = ['resource_id', 'name', 'description', 'url', 'skill_tags', 'career_tags', 'source', 'last_verified_at'];
  const positions = new Map(required.map(name => [name, names.indexOf(name)]));
  const audiencePosition = names.indexOf('audience');
  if ([...positions.values()].some(position => position < 0)) throw new Error('Databricks returned an invalid resource response.');
  const resources: CampusResource[] = [];
  for (const row of rows.slice(0, limit)) {
    if (!Array.isArray(row)) continue;
    const at = (name: string) => row[positions.get(name)!];
    const resourceId = safeString(at('resource_id'), 160);
    const name = safeString(at('name'), 200);
    const url = safeHttpsUrl(at('url'));
    if (!resourceId || !name || !url) continue;
    resources.push({
      resourceId, name, description: safeString(at('description'), 1000) ?? '', url,
       audience: audiencePosition >= 0 ? safeTags(row[audiencePosition]) : [], skillTags: safeTags(at('skill_tags')),
      careerTags: safeTags(at('career_tags')), source: safeString(at('source'), 200) ?? 'Virginia Tech',
      lastVerifiedAt: safeTimestamp(at('last_verified_at')),
    });
  }
  return resources;
}

export async function queryCampusResources(
  input: CampusResourceQuery,
  fetchImpl: FetchLike = fetch,
  options: QueryOptions = {},
): Promise<CampusResourceResult> {
  if (!input || typeof input !== 'object') throw new Error('Campus resource query is invalid.');
  if (input.skill !== undefined && !SKILLS.has(input.skill)) throw new Error('Campus resource skill is invalid.');
  if (input.query !== undefined && (typeof input.query !== 'string' || input.query.trim().length > 240)) throw new Error('Campus resource query must be at most 240 characters.');
  if (input.limit !== undefined && (!Number.isFinite(input.limit) || input.limit < 1)) throw new Error('Campus resource limit is invalid.');
  const limit = Math.max(1, Math.min(10, Math.floor(input.limit ?? 3)));
  const body = await executeStatement(input, fetchImpl, options);
  const resources = parseResources(body, limit);
  const verified = resources.map(resource => resource.lastVerifiedAt).filter((value): value is string => Boolean(value)).sort();
  return {
    resources, source: 'Databricks Unity Catalog', retrievedAt: new Date().toISOString(),
    freshness: {
      newestLastVerifiedAt: verified.at(-1) ?? null,
      oldestLastVerifiedAt: verified[0] ?? null,
    },
  };
}
