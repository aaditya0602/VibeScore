/** Minimal, read-only Databricks SQL adapter for the Hokie Career Navigator.
 * User input is passed only through named parameters. Catalog, schema, and
 * table identifiers come from validated server configuration.
 */
export type NavigatorSkill = 'framing' | 'context' | 'debugging' | 'verification' | 'review' | 'efficiency';

export interface CareerResource {
  resourceId: string;
  name: string;
  description: string;
  url: string;
  skillTags: string[];
  careerTags: string[];
  source: string;
  lastVerifiedAt: string | null;
}

export interface CareerResourceResult {
  resources: CareerResource[];
  source: 'databricks';
  queriedAt: string;
}

type FetchLike = typeof fetch;
const MAX_RESPONSE_BYTES = 1_000_000;
const STATEMENT_PATH = '/api/2.0/sql/statements';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const WAREHOUSE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ALLOWED_HOST_SUFFIXES = ['.azuredatabricks.net', '.cloud.databricks.com', '.gcp.databricks.com'];

function configured() {
  return Boolean(process.env.DATABRICKS_HOST?.trim() && process.env.DATABRICKS_TOKEN?.trim() && process.env.DATABRICKS_WAREHOUSE_ID?.trim());
}

export function databricksStatus() {
  let enabled = configured();
  if (enabled) {
    try {
      workspaceOrigin(); token(); warehouseId();
      identifier('DATABRICKS_CATALOG','main'); identifier('DATABRICKS_SCHEMA','default'); identifier('DATABRICKS_RESOURCE_TABLE','campus_resources');
    } catch { enabled = false; }
  }
  return { enabled, source:'Databricks SQL' };
}

function workspaceOrigin() {
  const value = process.env.DATABRICKS_HOST?.trim();
  if (!value) throw new Error('Databricks career resources are not configured.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Databricks service configuration is invalid.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '') || !ALLOWED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    throw new Error('Databricks service configuration is invalid.');
  }
  return url.origin;
}

function configValue(name: string, fallback?: string) {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error('Databricks career resources are not configured.');
  return value;
}

function identifier(name: string, fallback: string) {
  const value = configValue(name, fallback);
  if (!IDENTIFIER.test(value)) throw new Error('Databricks table configuration is invalid.');
  return `\`${value}\``;
}

function token() {
  return configValue('DATABRICKS_TOKEN');
}

function warehouseId() {
  const value = configValue('DATABRICKS_WAREHOUSE_ID');
  if (!WAREHOUSE_ID.test(value)) throw new Error('Databricks warehouse configuration is invalid.');
  return value;
}

function boundedString(value: unknown, max: number) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function tags(value: unknown) {
  if (Array.isArray(value)) return value.filter(x => typeof x === 'string').map(x => x.slice(0, 80)).slice(0, 20);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter(x => typeof x === 'string').map(x => x.slice(0, 80)).slice(0, 20);
  } catch {}
  return trimmed.split(',').map(x => x.trim()).filter(Boolean).map(x => x.slice(0, 80)).slice(0, 20);
}

function safeResource(row: unknown): CareerResource | null {
  if (!Array.isArray(row) || row.length < 8) return null;
  const resourceId = boundedString(row[0], 160), name = boundedString(row[1], 160), description = boundedString(row[2], 800);
  const rawUrl = boundedString(row[3], 1000), source = boundedString(row[6], 160) || 'Virginia Tech resource';
  if (!resourceId || !name) return null;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const lastVerifiedAt = boundedString(row[7], 64) || null;
  return { resourceId, name, description, url:url.href, skillTags:tags(row[4]), careerTags:tags(row[5]), source, lastVerifiedAt };
}

function careerKeyword(goal: string) {
  const stop = new Set(['about','after','build','career','could','from','help','into','learn','looking','prepare','student','that','this','using','want','with']);
  return (goal.toLowerCase().match(/[a-z0-9]+/g) || []).find(word => word.length >= 3 && !stop.has(word)) || 'career';
}

export async function findCareerResources(input: { goal: string; skill: NavigatorSkill }, fetchImpl: FetchLike = fetch): Promise<CareerResourceResult> {
  if (!configured()) throw new Error('Databricks career resources are not configured.');
  if (!input || typeof input.goal !== 'string' || input.goal.trim().length < 3 || input.goal.length > 280) throw new Error('Describe a career goal in 3–280 characters.');
  const skills = new Set<NavigatorSkill>(['framing','context','debugging','verification','review','efficiency']);
  if (!skills.has(input.skill)) throw new Error('Choose a valid VibeScore skill focus.');

  const table = `${identifier('DATABRICKS_CATALOG','main')}.${identifier('DATABRICKS_SCHEMA','default')}.${identifier('DATABRICKS_RESOURCE_TABLE','campus_resources')}`;
  const statement = `SELECT CAST(resource_id AS STRING), CAST(name AS STRING), CAST(description AS STRING), CAST(url AS STRING), CAST(skill_tags AS STRING), CAST(career_tags AS STRING), CAST(source AS STRING), CAST(last_verified_at AS STRING) FROM ${table} WHERE lower(CAST(skill_tags AS STRING)) LIKE :skill_pattern OR lower(CAST(career_tags AS STRING)) LIKE :career_pattern ORDER BY CASE WHEN lower(CAST(skill_tags AS STRING)) LIKE :skill_pattern THEN 0 ELSE 1 END, name LIMIT 12`;
  const response = await fetchImpl(`${workspaceOrigin()}${STATEMENT_PATH}`, {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(20_000),
    headers:{ authorization:`Bearer ${token()}`, 'content-type':'application/json', accept:'application/json' },
    body:JSON.stringify({
      warehouse_id:warehouseId(), statement, disposition:'INLINE', format:'JSON_ARRAY',
      wait_timeout:'15s', on_wait_timeout:'CANCEL', row_limit:12,
      parameters:[
        { name:'skill_pattern', value:`%${input.skill}%`, type:'STRING' },
        { name:'career_pattern', value:`%${careerKeyword(input.goal)}%`, type:'STRING' },
      ],
    }),
  });
  if (!response.ok) throw new Error(response.status === 429 ? 'Databricks is at its request limit. Try again shortly.' : 'Databricks career resources are temporarily unavailable.');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('Databricks returned too much data.');
  const raw = await response.text();
  if (Buffer.byteLength(raw,'utf8') > MAX_RESPONSE_BYTES) throw new Error('Databricks returned too much data.');
  let data: any;
  try { data = JSON.parse(raw); } catch { throw new Error('Databricks returned an invalid response.'); }
  if (data?.status?.state !== 'SUCCEEDED') throw new Error('Databricks did not finish the resource query. Try again shortly.');
  if (!Array.isArray(data?.result?.data_array)) throw new Error('Databricks returned an invalid resource result.');
  const resources = data.result.data_array.map(safeResource).filter((x: CareerResource | null): x is CareerResource => Boolean(x)).slice(0, 6);
  return { resources, source:'databricks', queriedAt:new Date().toISOString() };
}
