import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databricksStatus, queryCampusResources } from '../src/databricks.ts';

const envNames = ['DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'DATABRICKS_WAREHOUSE_ID', 'DATABRICKS_CATALOG', 'DATABRICKS_SCHEMA', 'DATABRICKS_RESOURCES_TABLE'] as const;
const original = Object.fromEntries(envNames.map(name => [name, process.env[name]]));

function setup() {
  process.env.DATABRICKS_HOST = 'https://adb-123456789.12.azuredatabricks.net';
  process.env.DATABRICKS_TOKEN = 'private-test-token';
  process.env.DATABRICKS_WAREHOUSE_ID = 'warehouse-123';
  process.env.DATABRICKS_CATALOG = 'vibescore';
  process.env.DATABRICKS_SCHEMA = 'hokie';
  process.env.DATABRICKS_RESOURCES_TABLE = 'campus_resources';
}

test.after(() => {
  for (const name of envNames) {
    const value = original[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function resultBody(state = 'SUCCEEDED') {
  return {
    statement_id: 'statement-123', status: { state },
    manifest: { schema: { columns: ['resource_id', 'name', 'description', 'url', 'skill_tags', 'career_tags', 'source', 'last_verified_at'].map(name => ({ name })) } },
    result: { data_array: [[
      'career-center', 'Career Center', 'Interview and internship support', 'https://career.vt.edu/',
      'verification,context', 'interview', 'Virginia Tech Career Center', '2026-09-01T00:00:00Z',
    ]] },
  };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('executes a parameterized read-only query and returns sanitized resources with freshness', async () => {
  setup(); let request: Request | undefined;
  const found = await queryCampusResources({ skill: 'verification', query: "interview' OR 1=1 --", limit: 3 }, async (input, init) => {
    request = new Request(input, init);
    return json(resultBody());
  });
  assert.equal(request?.url, 'https://adb-123456789.12.azuredatabricks.net/api/2.0/sql/statements/');
  assert.equal(request?.method, 'POST');
  assert.equal(request?.redirect, 'error');
  assert.equal(request?.headers.get('authorization'), 'Bearer private-test-token');
  const payload = await request?.json() as any;
  assert.match(payload.statement, /^SELECT /);
  assert.match(payload.statement, /FROM `vibescore`\.`hokie`\.`campus_resources`/);
  assert.doesNotMatch(payload.statement, /\baudience\b|array_contains/);
  assert.match(payload.statement, /lower\(skill_tags\) LIKE/);
  assert.doesNotMatch(payload.statement, /OR 1=1/);
  assert.deepEqual(payload.parameters, [
    { name: 'skill', value: 'verification', type: 'STRING' },
    { name: 'query', value: "interview' OR 1=1 --", type: 'STRING' },
  ]);
  assert.deepEqual(found.resources[0], {
    resourceId: 'career-center', name: 'Career Center', description: 'Interview and internship support', url: 'https://career.vt.edu/',
    audience: [], skillTags: ['verification', 'context'], careerTags: ['interview'],
    source: 'Virginia Tech Career Center', lastVerifiedAt: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(found.source, 'Databricks Unity Catalog');
  assert.equal(found.freshness.newestLastVerifiedAt, '2026-09-01T00:00:00.000Z');
  assert.ok(Number.isFinite(Date.parse(found.retrievedAt)));
  assert.ok(!JSON.stringify(found).includes('private-test-token'));
});

test('polls the statement within a deadline', async () => {
  setup(); const requests: Request[] = [];
  const bodies = [
    { statement_id: 'statement-123', status: { state: 'PENDING' } },
    { statement_id: 'statement-123', status: { state: 'RUNNING' } },
    resultBody(),
  ];
  const found = await queryCampusResources({}, async (input, init) => {
    requests.push(new Request(input, init));
    return json(bodies.shift());
  }, { pollIntervalMs: 0, deadlineMs: 1_000 });
  assert.equal(requests.length, 3);
  assert.equal(requests[1].url, 'https://adb-123456789.12.azuredatabricks.net/api/2.0/sql/statements/statement-123');
  assert.equal(requests[1].method, 'GET');
  assert.equal(found.resources.length, 1);
});

test('status is enabled only for complete, valid server configuration', () => {
  setup();
  assert.deepEqual(databricksStatus(), { enabled: true, source: 'Databricks Unity Catalog' });
  delete process.env.DATABRICKS_TOKEN;
  assert.equal(databricksStatus().enabled, false);
  setup(); process.env.DATABRICKS_HOST = 'https://attacker.example';
  assert.equal(databricksStatus().enabled, false);
  setup(); process.env.DATABRICKS_CATALOG = 'vibescore; DROP TABLE users';
  assert.equal(databricksStatus().enabled, false);
});

test('rejects untrusted hosts, unsafe identifiers, and invalid query values before fetch', async () => {
  setup(); let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return json(resultBody()); };
  process.env.DATABRICKS_HOST = 'https://adb-1.azuredatabricks.net.attacker.example';
  await assert.rejects(queryCampusResources({}, fetcher), /configuration is invalid/);
  setup(); process.env.DATABRICKS_RESOURCES_TABLE = 'resources` JOIN secrets';
  await assert.rejects(queryCampusResources({}, fetcher), /configuration is invalid/);
  setup();
  await assert.rejects(queryCampusResources({ skill: 'security' as any }, fetcher), /skill is invalid/);
  await assert.rejects(queryCampusResources({ query: 'x'.repeat(241) }, fetcher), /at most 240/);
  await assert.rejects(queryCampusResources({ limit: Number.NaN }, fetcher), /limit is invalid/);
  assert.equal(calls, 0);
});

test('drops unsafe and malformed resource rows without exposing arbitrary fields', async () => {
  setup(); const body = resultBody();
  body.result.data_array = [
     ['one', 'Unsafe URL', 'x', 'javascript:alert(1)', [], [], 'source', 'bad date'],
     ['two', 'Safe', 'x'.repeat(2_000), 'https://student.vt.edu/path', '["debugging"]', ['portfolio'], 'VT', '2026-08-01'],
     ['', 'Missing ID', 'x', 'https://vt.edu/', [], [], 'VT', '2026-08-01'],
  ];
  (body as any).secret = 'must-not-escape';
  const found = await queryCampusResources({}, async () => json(body));
  assert.equal(found.resources.length, 1);
  assert.equal(found.resources[0].resourceId, 'two');
  assert.equal(found.resources[0].description.length, 1000);
   assert.deepEqual(found.resources[0].audience, []);
  assert.ok(!JSON.stringify(found).includes('must-not-escape'));
});

test('rejects redirects, oversized, malformed, failed, and incomplete responses safely', async () => {
  setup();
  await assert.rejects(queryCampusResources({}, async () => new Response('', { status: 302, headers: { location: 'https://attacker.example' } })), /temporarily unavailable/);
  await assert.rejects(queryCampusResources({}, async () => json({}, 200, { 'content-length': '1000001' })), /too large/);
  await assert.rejects(queryCampusResources({}, async () => new Response('{bad json')), /invalid response/);
  await assert.rejects(queryCampusResources({}, async () => json({ statement_id: 'x', status: { state: 'FAILED' }, error: { message: 'token=secret' } })), /temporarily unavailable/);
  const incomplete = resultBody(); incomplete.result = { ...incomplete.result, next_chunk_internal_link: '/next' } as any;
  await assert.rejects(queryCampusResources({}, async () => json(incomplete)), /incomplete response/);
});

test('enforces response byte limit while streaming and reports a polling deadline', async () => {
  setup(); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(600_000)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(queryCampusResources({}, async () => new Response(stream)), /too large/);
  assert.equal(cancelled, true);
  await assert.rejects(queryCampusResources({}, async () => json({ statement_id: 'statement-123', status: { state: 'PENDING' } }), { deadlineMs: 1, pollIntervalMs: 1 }), /timed out/);
});
