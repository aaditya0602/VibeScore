import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAnsAgentTrust, searchAnsAgents } from '../src/ans.ts';

function response(value: unknown, status = 200, headers: Record<string,string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type':'application/json', ...headers } });
}
const old = { token: process.env.ANS_API_TOKEN, base: process.env.ANS_BASE_URL };
function setup() { process.env.ANS_API_TOKEN = 'test-private-token'; process.env.ANS_BASE_URL = 'https://api.ote-godaddy.com'; }
test.after(() => {
  if (old.token === undefined) delete process.env.ANS_API_TOKEN; else process.env.ANS_API_TOKEN = old.token;
  if (old.base === undefined) delete process.env.ANS_BASE_URL; else process.env.ANS_BASE_URL = old.base;
});

test('search calls only documented route and returns bounded sanitized results', async () => {
  setup(); let captured: Request | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return response({ totalItems: 1, items: [{ agentId:'agent-1', ansName:'ans://helper', agentDisplayName:'Helper', agentDescription:'Useful agent', agentHost:'example.test', lifecycle:{status:'ACTIVE'}, endpoints:[{protocol:'MCP', functions:[{name:'Search', tags:['x']}]}], scores:{trustScore:91}, hiddenSecret:'omit' }] });
  };
  const found = await searchAnsAgents({ query:'  campus navigator  ', pageSize:999 }, fetcher);
  assert.equal(captured?.url, 'https://api.ote-godaddy.com/v1/ans/registered-agents?query=campus+navigator&pageSize=20&totalRequired=true');
  assert.equal(captured?.headers.get('authorization'), 'Bearer test-private-token');
  assert.equal(captured?.redirect, 'error');
  assert.equal(found.agents[0].trustScore, 91); assert.deepEqual(found.agents[0].capabilities, ['Search']);
  assert.equal('hiddenSecret' in found.agents[0], false);
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
