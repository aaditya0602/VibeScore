import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { closeDatabase, getDatabase, userByToken } from '../src/store.ts';
import { createAppServer } from '../src/server.ts';
import { getPrivateInterview } from '../src/challenges.ts';

function workflowBundle() {
  const summary = {
    episodes:1,activeMinutes:10,promptCount:2,effectiveTokens:1000,weightedTokens:1000,
    correctionRatio:0,meanRedirectDepth:0,firstPromptContextScore:.5,meanPromptSpecificity:2,
    editsPerPrompt:1,loopBurnFraction:0,loopCount:0,toolSuccessRate:1,verifyAfterEditRatio:1,
    errorRecoveryRate:1,agenticLeverage:0,outcomes:{verified:1},modelHistogram:{'test-model':1000},
  };
  return {schemaVersion:'0.1.0',agent:'codex',generatedAt:'2026-09-19T12:00:00.000Z',
    coherence:{chainBreaks:0,timeRegressions:0,unknownEventRatio:0,badJsonLines:0},
    projects:[{projectHash:'0123456789abcdef',...summary}],overall:summary};
}

test('public beta API supports account, catalog, drill and interview flows without leaking judge data', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'vibescore-api-')),prior=process.env.VIBESCORE_DATA_DIR;
  process.env.VIBESCORE_DATA_DIR=dir; closeDatabase();
  const server=createAppServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('no test address');const base=`http://127.0.0.1:${address.port}`;
  let cookie='';
  const api=async(path:string,init:RequestInit={})=>{
    const headers=new Headers(init.headers);headers.set('origin',base);if(cookie)headers.set('cookie',cookie);if(init.body)headers.set('content-type','application/json');
    const response=await fetch(base+path,{...init,headers});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return {response,data:await response.json() as any};
  };
  try {
    let call=await api('/api/register',{method:'POST',body:JSON.stringify({handle:'api_builder',password:'correct horse battery'})});
    assert.equal(call.response.status,201);assert.ok(call.data.recoveryCode);assert.match(cookie,/vibescore_session/);
    call=await api('/api/me');assert.equal(call.data.user.handle,'api_builder');assert.equal(call.data.user.isPublic,false);assert.equal(call.data.workflow,null);
    call=await api('/api/workflow');assert.equal(call.response.status,200);assert.equal(call.data.connected,false);assert.equal(call.data.latest,null);
    const unauthenticated=await fetch(base+'/api/me/api-token',{method:'POST'});assert.equal(unauthenticated.status,401);
    call=await api('/api/me/api-token',{method:'POST'});assert.equal(call.response.status,201);assert.equal(call.response.headers.get('cache-control'),'no-store');
    const firstToken=call.data.token;assert.equal(userByToken(firstToken,'api')?.handle,'api_builder');
    call=await api('/api/me/api-token',{method:'POST'});const replacement=call.data.token;
    assert.notEqual(replacement,firstToken);assert.equal(userByToken(firstToken,'api'),undefined);assert.equal(userByToken(replacement,'api')?.handle,'api_builder');
    const collectorRequest=async(path:string,init:RequestInit={})=>{
      const headers=new Headers(init.headers);headers.set('x-token',replacement);headers.set('origin',base);if(init.body)headers.set('content-type','application/json');
      const response=await fetch(base+path,{...init,headers});return {response,data:await response.json() as any};
    };
    let scoped=await collectorRequest('/api/me');assert.equal(scoped.response.status,401);
    scoped=await collectorRequest('/api/attempts/not-an-attempt');assert.equal(scoped.response.status,401);
    scoped=await collectorRequest('/api/me',{method:'PATCH',body:JSON.stringify({isPublic:true})});assert.equal(scoped.response.status,401);
    scoped=await collectorRequest('/api/me',{method:'DELETE',body:JSON.stringify({confirmHandle:'api_builder'})});assert.equal(scoped.response.status,401);
    call=await api('/api/me');assert.equal(call.response.status,200);assert.equal(call.data.user.isPublic,false,'collector token cannot mutate or delete the account');
    call=await api('/api/bundles',{method:'POST',body:JSON.stringify(workflowBundle())});assert.equal(call.response.status,401,'browser sessions cannot publish collector evidence');
    scoped=await collectorRequest('/api/bundles',{method:'POST',body:JSON.stringify(workflowBundle())});assert.equal(scoped.response.status,200);assert.equal(scoped.data.score.handle,'api_builder');
    const publishedWorkflow=scoped.data.score;
    call=await api('/api/me');assert.deepEqual(call.data.workflow,publishedWorkflow,'private dashboard uses the same current workflow projection');
    assert.equal(call.data.workflow.episodes,1);assert.match(call.data.workflow.recommendation.path,/^\/challenge\//);
    const metadata=await fetch(base+'/.well-known/mcp.json').then(response=>response.json()) as any;
    assert.equal(metadata.endpoint,base+'/mcp');assert.ok(metadata.tools.includes('publish_workflow_report'));
    const mcpClient=new Client({name:'vibescore-test-client',version:'1.0.0'});
    const mcpTransport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:`Bearer ${replacement}`}}});
    await mcpClient.connect(mcpTransport);
    try {
      const tools=await mcpClient.listTools();
      assert.deepEqual(tools.tools.map(tool=>tool.name).sort(),['describe_scoring','preview_workflow_report','publish_workflow_report','recommend_drill','verify_public_profile']);
      const preview=await mcpClient.callTool({name:'preview_workflow_report',arguments:{bundle:workflowBundle()}});
      const sha256=JSON.parse((preview.content[0] as {text:string}).text).sha256;
      const published=await mcpClient.callTool({name:'publish_workflow_report',arguments:{bundle:workflowBundle(),expected_sha256:sha256,confirm:true}});
      const publication=JSON.parse((published.content[0] as {text:string}).text);
      assert.equal(publication.published,true);assert.equal(publication.handle,'api_builder');assert.ok(publication.score);
    } finally {await mcpClient.close();}
    call=await api('/api/me/api-token',{method:'DELETE'});assert.equal(call.data.revoked,true);assert.equal(userByToken(replacement,'api'),undefined);
    call=await api('/api/me');assert.equal(call.response.status,200);assert.equal(call.data.token,undefined,'secrets are not retrievable');
    call=await api('/api/challenges');assert.equal(call.data.challenges.length,19);assert.doesNotMatch(JSON.stringify(call.data),/referenceSolution|strongExample|hidden/);
    const drill=call.data.challenges.find((x:any)=>x.kind==='drill');
    call=await api(`/api/challenges/${drill.id}/start`,{method:'POST',body:JSON.stringify({mode:'practice'})});const drillAttempt=call.data.attempt.id;
    const priorKey=process.env.AI_API_KEY;delete process.env.AI_API_KEY;
    try {
      call=await api(`/api/attempts/${drillAttempt}/chat`,{method:'POST',body:JSON.stringify({message:'   '})});assert.equal(call.response.status,400);
      call=await api(`/api/attempts/${drillAttempt}/chat`,{method:'POST',body:JSON.stringify({message:7})});assert.equal(call.response.status,400);
      call=await api(`/api/attempts/${drillAttempt}/chat`,{method:'POST',body:JSON.stringify({message:'Help me clarify requirements.'})});assert.equal(call.response.status,503);
      assert.equal(Number((getDatabase().prepare('SELECT count(*) AS n FROM ai_usage').get() as any).n),0);
      assert.equal(Number((getDatabase().prepare('SELECT count(*) AS n FROM assistant_messages').get() as any).n),0);
    } finally {priorKey===undefined?delete process.env.AI_API_KEY:process.env.AI_API_KEY=priorKey;}
    call=await api(`/api/attempts/${drillAttempt}/submit`,{method:'POST',body:JSON.stringify({answer:'First clarify the user, constraints, tests, and a small plan.'})});
    assert.equal(call.response.status,200);assert.equal(call.data.result.ratingEligible,false);
    const interview=getPrivateInterview('interview-retry-planner')!;
    call=await api(`/api/challenges/${interview.id}/start`,{method:'POST',body:JSON.stringify({mode:'rated'})});const interviewAttempt=call.data.attempt.id;
    call=await api(`/api/attempts/${interviewAttempt}/submit`,{method:'POST',body:JSON.stringify({code:interview.referenceSolution,reflection:'I checked boundary windows and repeated calls.'})});
    assert.equal(call.response.status,200);assert.equal(call.data.result.complete,true);assert.equal(call.data.result.totalScore,100);assert.doesNotMatch(JSON.stringify(call.data),/expected|input/);
    call=await api('/api/me',{method:'PATCH',body:JSON.stringify({isPublic:true})});assert.equal(call.data.user.isPublic,true);
    call=await api('/api/profile/api_builder');assert.equal(call.data.profile.handle,'api_builder');
    const bad=await fetch(base+'/api/me',{method:'PATCH',headers:{origin:'https://evil.example','content-type':'application/json',cookie},body:'{"isPublic":false}'});
    assert.equal(bad.status,403);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));closeDatabase();prior===undefined?delete process.env.VIBESCORE_DATA_DIR:process.env.VIBESCORE_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});
  }
});

test('public navigator API validates input and returns a useful no-credential fallback',async()=>{
  const names=['DATABRICKS_HOST','DATABRICKS_TOKEN','DATABRICKS_WAREHOUSE_ID','DATABRICKS_CATALOG','DATABRICKS_SCHEMA','DATABRICKS_RESOURCES_TABLE'] as const;
  const prior=Object.fromEntries(names.map(name=>[name,process.env[name]]));for(const name of names)delete process.env[name];
  const server=createAppServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('no test address');const base=`http://127.0.0.1:${address.port}`;
  const post=async(value:unknown)=>{const response=await fetch(base+'/api/navigator/recommend',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(value)});return {response,data:await response.json() as any};};
  try{
    const status=await fetch(base+'/api/status').then(response=>response.json()) as any;
    assert.equal(status.databricks.enabled,false);assert.equal(status.databricks.source,'Databricks Unity Catalog');
    let call=await post({goal:'short',skill:'verification'});assert.equal(call.response.status,400);
    call=await post({goal:'Prepare for an AI-assisted software engineering interview',skill:'verification'});
    assert.equal(call.response.status,200);assert.equal(call.data.recommendedDrill.id,'verify-pagination');
    assert.equal(call.data.guidance.generatedBy,'rules');assert.equal(call.data.dataSource.available,true);assert.equal(call.data.dataSource.source,'Bundled Virginia Tech sources');assert.ok(call.data.careerResources.length>0);
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const name of names)prior[name]===undefined?delete process.env[name]:process.env[name]=prior[name];
  }
});

test('public clinic API keeps consent optional, tokens non-cacheable, deletion available, and small cohorts suppressed',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'vibescore-clinic-api-')),priorDir=process.env.VIBESCORE_DATA_DIR,priorSecret=process.env.CLINIC_PSEUDONYM_SECRET;
  process.env.VIBESCORE_DATA_DIR=dir;process.env.CLINIC_PSEUDONYM_SECRET='test-clinic-pseudonym-secret-with-32-chars';closeDatabase();
  const server=createAppServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('no test address');const base=`http://127.0.0.1:${address.port}`;
  const call=async(path:string,method:string,value?:unknown)=>{const response=await fetch(base+path,{method,headers:{origin:base,...(value===undefined?{}:{'content-type':'application/json'})},body:value===undefined?undefined:JSON.stringify(value)});return {response,data:await response.json() as any};};
  try{
    let result=await call('/api/clinic/consent','POST',{cohortId:'VTHACKS26',consent:false});
    assert.equal(result.response.status,200);assert.deepEqual(result.data,{consented:false});assert.equal(result.response.headers.get('cache-control'),'no-store');
    assert.equal((getDatabase().prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='clinic_participants'").get() as any).n,0,'declining creates no analytics schema or row');
    result=await call('/api/clinic/consent','POST',{cohortId:'VTHACKS26',consent:true});
    assert.equal(result.response.status,200);assert.equal(result.response.headers.get('cache-control'),'no-store');assert.match(result.data.participantToken,/^[A-Za-z0-9_-]{40,128}$/);
    const participantToken=result.data.participantToken;
    result=await call('/api/clinic/events','POST',{participantToken,eventType:'readiness_started'});assert.equal(result.response.status,201);assert.equal(result.response.headers.get('cache-control'),'no-store');
    result=await call('/api/clinic/events','POST',{participantToken,eventType:'readiness_completed',skill:'verification',outcomeBand:'developing'});assert.equal(result.response.status,201);
    result=await call('/api/clinic/events','POST',{participantToken,eventType:'readiness_started',rawPrompt:'must never be accepted'});assert.equal(result.response.status,400);
    const summary=await fetch(base+'/api/impact/summary?cohort=vthacks26').then(response=>response.json()) as any;
    assert.equal(summary.live.suppressed,true);assert.equal(summary.live.participantCount,null);assert.equal(summary.live.freshness,null);assert.equal(summary.live.metrics,null);
    assert.equal(summary.synthetic.synthetic,true);assert.ok(!JSON.stringify(summary).includes(participantToken));
    const guide=await fetch(base+'/docs/clinic-facilitator-guide.md');assert.equal(guide.status,200);assert.match(guide.headers.get('content-type')??'',/^text\/markdown/);assert.match(await guide.text(),/Hokie AI Builder Readiness clinic/i);
    result=await call('/api/clinic/participant','DELETE',{participantToken});assert.equal(result.response.status,200);assert.equal(result.data.deleted,true);assert.equal(result.response.headers.get('cache-control'),'no-store');
    result=await call('/api/clinic/events','POST',{participantToken,eventType:'readiness_started'});assert.equal(result.response.status,400);
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));closeDatabase();
    priorDir===undefined?delete process.env.VIBESCORE_DATA_DIR:process.env.VIBESCORE_DATA_DIR=priorDir;
    priorSecret===undefined?delete process.env.CLINIC_PSEUDONYM_SECRET:process.env.CLINIC_PSEUDONYM_SECRET=priorSecret;
    rmSync(dir,{recursive:true,force:true});
  }
});
