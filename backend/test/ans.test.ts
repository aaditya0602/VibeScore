import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnsRequestError, ansStatus, getAnsAgentTrust, searchAnsAgents } from '../src/ans.ts';

function response(value: unknown, status = 200, headers: Record<string,string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type':'application/json', ...headers } });
}
const old = { key: process.env.ANS_API_KEY, secret: process.env.ANS_API_SECRET, base: process.env.ANS_BASE_URL };
function setup() { process.env.ANS_API_KEY = 'test-private-key'; process.env.ANS_API_SECRET = 'test-private-secret'; process.env.ANS_BASE_URL = 'https://api.ote-godaddy.com'; }
test.after(() => {
  if (old.key === undefined) delete process.env.ANS_API_KEY; else process.env.ANS_API_KEY = old.key;
  if (old.secret === undefined) delete process.env.ANS_API_SECRET; else process.env.ANS_API_SECRET = old.secret;
  if (old.base === undefined) delete process.env.ANS_BASE_URL; else process.env.ANS_BASE_URL = old.base;
});

test('search calls only documented route and returns bounded sanitized results', async () => {
  setup(); let captured: Request | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return response({ totalItems: 1, items: [{ agentId:'agent-1', ansName:'ans://helper', agentDisplayName:'Helper', agentDescription:'Useful agent', agentHost:'example.test', lifecycle:{status:'ACTIVE'}, endpoints:[{protocol:'MCP', functions:[{name:'Search', tags:['x']}]}], scores:{trustScore:91}, hiddenSecret:'omit' }] });
  };
  const found = await searchAnsAgents({ query:'  campus navigator  ', pageSize:999 }, fetcher);
  assert.equal(captured?.url, 'https://api.ote-godaddy.com/v1/ans/search-registered-agents');
  assert.equal(captured?.method, 'POST');
  assert.equal(captured?.headers.get('content-type'), 'application/json');
  assert.deepEqual(await captured?.json(), { query: 'campus navigator', pageSize: 20, totalRequired: true });
  assert.equal(captured?.headers.get('authorization'), 'sso-key test-private-key:test-private-secret');
  assert.equal(captured?.redirect, 'error');
  assert.equal(found.agents[0].trustScore, 91); assert.deepEqual(found.agents[0].capabilities, ['Search']);
  assert.equal('hiddenSecret' in found.agents[0], false);
  assert.equal(found.environment, 'ote');
  assert.ok(Number.isFinite(Date.parse(found.retrievedAt)));
  assert.ok(!JSON.stringify(found).includes('test-private'));
});

test('detail exposes trust summary while dropping arbitrary evidence payloads', async () => {
  setup(); let url = '';
  const fetcher: typeof fetch = async input => { url = String(input); return response({ agentId:'agent-1', agentDisplayName:'Helper', trustScore:83, trustVector:{identity:90,integrity:76}, coverage:{coverageRatio:0.75,computedPillars:['identity']}, missingness:{missingSignals:['dns-proof'],penalties:{identity:99}}, signals:{dns:{pillar:'identity',score:90,missing:false,evidence:{secret:'not returned'}}} }); };
  const data = await getAnsAgentTrust('agent-1', fetcher);
  assert.equal(url, 'https://api.ote-godaddy.com/v1/ans/registered-agents/agent-1');
  assert.equal(data.trustScore, 83); assert.deepEqual(data.missingSignals, ['dns-proof']);
  assert.deepEqual(data.signals, [{name:'dns',pillar:'identity',score:90,missing:false}]);
});

test('rejects untrusted base URLs and malformed responses', async () => {
  setup();
  process.env.ANS_BASE_URL = 'https://attacker.example';
  await assert.rejects(searchAnsAgents({query:'agents'}, async () => response({items:[]})), /configuration is invalid/);
  setup();
  await assert.rejects(searchAnsAgents({query:'agents'}, async () => response({notItems:[]})), /invalid discovery response/);
});

test('rejects redirects, oversized and invalid request data', async () => {
  setup();
  await assert.rejects(searchAnsAgents({query:'x'}, async () => response({items:[]})), /2 and 128/);
  await assert.rejects(getAnsAgentTrust('../admin', async () => response({})), /identifier is invalid/);
  await assert.rejects(searchAnsAgents({query:'agents'}, async () => new Response('', {status:302,headers:{location:'https://attacker.example'}})), /temporarily unavailable/);
  await assert.rejects(searchAnsAgents({query:'agents'}, async () => response({items:[]},200,{'content-length':'1000001'})), /too large/);
});

test('status requires both credentials and a valid service origin', async () => {
  setup();
  assert.deepEqual(ansStatus(), { enabled: true, environment: 'ote' });
  delete process.env.ANS_API_SECRET;
  assert.equal(ansStatus().enabled, false);
  await assert.rejects(searchAnsAgents({query:'agents'}, async () => response({items:[]})), /not configured/);
  setup(); process.env.ANS_BASE_URL = 'https://attacker.example';
  assert.equal(ansStatus().enabled, false);
  setup(); process.env.ANS_BASE_URL = 'https://api.godaddy.com';
  assert.deepEqual(ansStatus(), { enabled: true, environment: 'production' });
});

test('cancels streamed responses at the byte limit without content length', async () => {
  setup(); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(600_000)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(searchAnsAgents({query:'agents'}, async () => new Response(stream)), /too large/);
  assert.equal(cancelled, true);
});

test('partial details preserve unknown signals and include production provenance', async () => {
  setup(); process.env.ANS_BASE_URL = 'https://api.godaddy.com';
  const data = await getAnsAgentTrust('agent-1', async (input, init) => {
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    return response({agentId:'agent-1', trustScore:null, trustVector:{identity:null}, coverage:{coverageRatio:null}});
  });
  assert.equal(data.environment, 'production');
  assert.ok(Number.isFinite(Date.parse(data.retrievedAt)));
  assert.equal(data.trustScore, null);
  assert.deepEqual(data.trustVector, {identity:null,integrity:null});
  assert.equal(data.coverageRatio, null);
});

test('bounds search result count and rejects nonfinite page sizes', async () => {
  setup();
  const found = await searchAnsAgents({query:'agents',pageSize:2}, async () => response({items:Array.from({length:5},(_,i)=>({agentId:`agent-${i}`}))}));
  assert.equal(found.agents.length, 2);
  await assert.rejects(searchAnsAgents({query:'agents',pageSize:NaN}), /finite number/);
});

test('preserves humane upstream not-found and rate-limit semantics', async () => {
  setup();
  await assert.rejects(getAnsAgentTrust('agent-1', async () => response({},404)), (error:any) => error instanceof AnsRequestError && error.status===404 && /not found/i.test(error.message));
  await assert.rejects(searchAnsAgents({query:'agents'}, async () => response({},429)), (error:any) => error instanceof AnsRequestError && error.status===429 && /limit/i.test(error.message));
  await assert.rejects(searchAnsAgents({query:'agents'}, async () => response({},401)), (error:any) => error instanceof AnsRequestError && error.status===503 && /credentials/i.test(error.message));
});
