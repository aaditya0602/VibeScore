import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANS_PRODUCTION_BASE, runAnsCommand } from '../../scripts/ans-register.mjs';

const fixtures=join(dirname(fileURLToPath(import.meta.url)),'fixtures','ans');
const fixture=name=>JSON.parse(readFileSync(join(fixtures,name),'utf8'));
const env={ANS_API_KEY:'fixture-key',ANS_API_SECRET:'fixture-secret'};
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});

function preparedDir() {
  const dir=mkdtempSync(join(tmpdir(),'vibescore-ans-register-'));
  writeFileSync(join(dir,'host.txt'),'agent.example.com\n');
  writeFileSync(join(dir,'identity.csr.pem'),'-----BEGIN CERTIFICATE REQUEST-----\nfixture\n-----END CERTIFICATE REQUEST-----\n');
  return dir;
}
function state(value) {
  return JSON.stringify(value,null,2)+'\n';
}

test('registration validates and sanitizes the fixture before atomically saving state', async()=>{
  const dir=preparedDir(),calls:any[]=[];let output='';
  try {
    const valid=fixture('registration-valid.json');
    const saved=await runAnsCommand(['register','--host','agent.example.com'],{baseDir:dir,env,write:text=>output+=text,fetchImpl:async(url,init)=>{calls.push({url:String(url),init});return response(valid);}});
    assert.equal(calls.length,1);assert.equal(calls[0].url,ANS_PRODUCTION_BASE+'/v1/agents/register');assert.equal(calls[0].init.method,'POST');
    assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.headers.authorization,'sso-key fixture-key:fixture-secret');
    const payload=JSON.parse(calls[0].init.body);assert.equal(payload.agentHost,'agent.example.com');assert.equal(payload.identityCsrPEM.includes('CERTIFICATE REQUEST'),true);
    assert.equal(payload.endpoints[0].agentUrl,'https://agent.example.com/mcp');
    assert.deepEqual(payload.endpoints[0].functions.map((item:any)=>item.id),['describe_scoring','recommend_drill','preview_workflow_report','publish_workflow_report','verify_public_profile']);
    const persisted=JSON.parse(readFileSync(join(dir,'registration.json'),'utf8'));
    assert.deepEqual(persisted,saved);assert.equal('serverInternal' in persisted,false);assert.deepEqual(JSON.parse(output),saved);
    assert.equal(statSync(join(dir,'registration.json')).mode&0o777,0o600);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('an incomplete registration fixture cannot replace existing state', async()=>{
  const dir=preparedDir();
  try {
    const statePath=join(dir,'registration.json'),existing=state({agentId:'agent-old',challenge:{dnsRecord:{name:'old',type:'TXT',value:'old'}}});
    writeFileSync(statePath,existing,{mode:0o600});
    await assert.rejects(runAnsCommand(['register','--host','agent.example.com'],{baseDir:dir,env,write:()=>{},fetchImpl:async()=>response(fixture('registration-invalid.json'))}),/incomplete registration response/);
    assert.equal(readFileSync(statePath,'utf8'),existing);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('status and verification commands use the saved agent id and expected methods', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'vibescore-ans-state-')),calls:any[]=[];let output='';
  mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'registration.json'),state({agentId:'agent-1234'}),{mode:0o600});
  const byPath=new Map([
    ['/v1/agents/agent-1234',fixture('status-active.json')],
    ['/v1/agents/agent-1234/verify-acme',fixture('verify-acme.json')],
    ['/v1/agents/agent-1234/verify-dns',fixture('verify-dns.json')],
  ]);
  const fetchImpl=async(url,init)=>{const path=new URL(String(url)).pathname;calls.push({path,method:init?.method});return response(byPath.get(path));};
  try {
    const status=await runAnsCommand(['status'],{baseDir:dir,env,write:text=>output+=text,fetchImpl});
    const acme=await runAnsCommand(['verify-acme'],{baseDir:dir,env,write:text=>output+=text,fetchImpl});
    const dns=await runAnsCommand(['verify-dns'],{baseDir:dir,env,write:text=>output+=text,fetchImpl});
    assert.deepEqual(status,fixture('status-active.json'));assert.deepEqual(acme,fixture('verify-acme.json'));assert.deepEqual(dns,fixture('verify-dns.json'));
    assert.deepEqual(calls,[{path:'/v1/agents/agent-1234',method:'GET'},{path:'/v1/agents/agent-1234/verify-acme',method:'POST'},{path:'/v1/agents/agent-1234/verify-dns',method:'POST'}]);
    assert.deepEqual(output.trim().split('\n}\n{').length,3);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
