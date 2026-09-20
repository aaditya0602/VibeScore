import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase } from '../src/store.ts';
import { createAppServer } from '../src/server.ts';
import { getPrivateInterview } from '../src/challenges.ts';

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
    call=await api('/api/me');assert.equal(call.data.user.handle,'api_builder');assert.equal(call.data.user.isPublic,false);
    call=await api('/api/challenges');const challenges=call.data.challenges;assert.equal(challenges.length,19);assert.doesNotMatch(JSON.stringify(call.data),/referenceSolution|strongExample|hidden/);
    call=await api('/api/workflow');assert.equal(call.response.status,200);assert.equal(call.data.connected,false);assert.equal(call.data.latest,null);
    call=await api('/api/me/api-token',{method:'POST'});assert.equal(call.response.status,201);assert.match(call.data.token,/^[A-Za-z0-9_-]{40,}$/);
    call=await api('/api/status');assert.equal(call.data.databricks.enabled,false);assert.equal(call.data.ans.enabled,false);
    call=await api('/api/navigator/recommend',{method:'POST',body:JSON.stringify({goal:'software interview',skill:'unknown'})});assert.equal(call.response.status,400);
    call=await api('/api/navigator/recommend',{method:'POST',body:JSON.stringify({goal:'software interview',skill:'verification'})});assert.equal(call.response.status,503);assert.match(call.data.error,/not configured/);
    const drill=challenges.find((x:any)=>x.kind==='drill');
    call=await api(`/api/challenges/${drill.id}/start`,{method:'POST',body:JSON.stringify({mode:'practice'})});const drillAttempt=call.data.attempt.id;
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
