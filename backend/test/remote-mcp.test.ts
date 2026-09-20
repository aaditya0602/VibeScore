import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { closeDatabase, loginUser, registerUser, revokeToken, loadBundle, setVisibility } from '../src/store.ts';
import { createAppServer } from '../src/server.ts';

function workflowBundle(quality = 1) {
  const summary = {
    episodes:1,activeMinutes:10,promptCount:2,effectiveTokens:1000,weightedTokens:1000,
    correctionRatio:0,meanRedirectDepth:0,firstPromptContextScore:.5,meanPromptSpecificity:2,
    editsPerPrompt:quality,loopBurnFraction:1-quality,loopCount:quality?0:1,toolSuccessRate:quality,verifyAfterEditRatio:quality,
    errorRecoveryRate:quality,agenticLeverage:0,outcomes:quality?{verified:1}:{ended:1},modelHistogram:{'test-model':1000},
  };
  return {schemaVersion:'0.1.0',agent:'codex',generatedAt:'2026-09-19T12:00:00.000Z',
    coherence:{chainBreaks:0,timeRegressions:0,unknownEventRatio:0,badJsonLines:0},
    projects:[{projectHash:'0123456789abcdef',...summary}],overall:summary};
}

test('hosted MCP enforces privacy and request-scoped authorization under concurrency', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibescore-mcp-'));
  const prior = process.env.VIBESCORE_DATA_DIR;
  process.env.VIBESCORE_DATA_DIR = dir; closeDatabase();
  const server = createAppServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  const base = `http://127.0.0.1:${address.port}`;
  const clients: Client[] = [];
  async function connect(token?: string) {
    const client = new Client({name:'privacy-test',version:'1.0.0'});
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'), {
      requestInit: {headers: token ? {authorization:`Bearer ${token}`} : {}},
    }));
    return client;
  }
  function payload(result: any) { return JSON.parse(result.content[0].text); }
  try {
    const first = registerUser('mcp_first','a strong password')!, second = registerUser('mcp_second')!;
    const firstSession=loginUser(first.handle,'a strong password')!;
    const [anonymous, sessionClient, one, two] = await Promise.all([connect(),connect(firstSession.token),connect(first.token),connect(second.token)]);
    const metadata = await fetch(base+'/.well-known/mcp.json').then(r=>r.json()) as any;
    const listed = await anonymous.listTools();
    assert.deepEqual(metadata.tools.slice().sort(), listed.tools.map(t=>t.name).sort());
    assert.ok(!metadata.tools.includes('analyze_project'));
    const preview=payload(await anonymous.callTool({name:'preview_workflow_report',arguments:{bundle:workflowBundle()}}));
    assert.match(preview.sha256,/^[a-f0-9]{64}$/);assert.ok(preview.upload);
    const denied = await anonymous.callTool({name:'publish_workflow_report',arguments:{bundle:workflowBundle(),expected_sha256:preview.sha256,confirm:true}});
    assert.equal(denied.isError,true);
    const sessionDenied = await sessionClient.callTool({name:'publish_workflow_report',arguments:{bundle:workflowBundle(),expected_sha256:preview.sha256,confirm:true}});
    assert.equal(sessionDenied.isError,true,'browser session credentials cannot publish through hosted MCP');
    assert.equal(loadBundle(first.handle),null);
    const leaked = {...workflowBundle(),prompt:'private text should never persist'};
    assert.equal((await one.callTool({name:'preview_workflow_report',arguments:{bundle:leaked}})).isError,true);
    assert.equal(loadBundle(first.handle),null);
    const results = await Promise.all([
      one.callTool({name:'publish_workflow_report',arguments:{bundle:workflowBundle(),expected_sha256:preview.sha256,confirm:true}}),
      (async()=>{const bundle=workflowBundle(0),checked=payload(await two.callTool({name:'preview_workflow_report',arguments:{bundle}}));return two.callTool({name:'publish_workflow_report',arguments:{bundle,expected_sha256:checked.sha256,confirm:true}});})(),
      anonymous.callTool({name:'describe_scoring',arguments:{}}),
    ]);
    assert.equal(payload(results[0]).handle,first.handle);
    assert.equal(payload(results[1]).handle,second.handle);
    assert.ok(loadBundle(first.handle)); assert.ok(loadBundle(second.handle));
    assert.equal((await anonymous.callTool({name:'verify_public_profile',arguments:{handle:first.handle}})).isError,true);
    setVisibility(first.handle,true);
    const publicResult = payload(await anonymous.callTool({name:'verify_public_profile',arguments:{handle:first.handle}}));
    assert.equal(publicResult.handle,first.handle);
    assert.doesNotMatch(JSON.stringify(publicResult),/projectHash|modelHistogram|private text/);
    const leaderboard = await fetch(base+'/api/leaderboard?type=workflow').then(r=>r.json()) as any;
    assert.equal(leaderboard.entries.length,1);
    assert.equal(leaderboard.entries[0].handle,first.handle);
    assert.deepEqual(publicResult.workflow,leaderboard.entries[0],'MCP profile verification and web leaderboard share the current workflow projection');
    assert.equal(publicResult.workflow.generatedAt,'2026-09-19T12:00:00.000Z');
    assert.ok(leaderboard.entries[0].rating>1500,'private evidence belongs in the anonymous comparison population');
    revokeToken(first.token);
    assert.equal((await one.callTool({name:'publish_workflow_report',arguments:{bundle:workflowBundle(),expected_sha256:preview.sha256,confirm:true}})).isError,true);
    const evil = await fetch(base+'/mcp',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'});
    assert.equal(evil.status,403);
    const response = await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.match(response.headers.get('content-type')??'',/application\/json/);
    await response.json();
  } finally {
    await Promise.all(clients.map(c=>c.close()));
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    closeDatabase();
    prior===undefined ? delete process.env.VIBESCORE_DATA_DIR : process.env.VIBESCORE_DATA_DIR=prior;
    rmSync(dir,{recursive:true,force:true});
  }
});
