import test from 'node:test';
import assert from 'node:assert/strict';
import { databricksStatus, findCareerResources } from '../src/databricks.ts';

const KEYS=['DATABRICKS_HOST','DATABRICKS_TOKEN','DATABRICKS_WAREHOUSE_ID','DATABRICKS_CATALOG','DATABRICKS_SCHEMA','DATABRICKS_RESOURCE_TABLE'] as const;
function configured(fn:()=>Promise<void>|void){return async()=>{const prior=Object.fromEntries(KEYS.map(k=>[k,process.env[k]]));Object.assign(process.env,{DATABRICKS_HOST:'https://dbc-demo.cloud.databricks.com',DATABRICKS_TOKEN:'secret-token',DATABRICKS_WAREHOUSE_ID:'warehouse_123',DATABRICKS_CATALOG:'vibescore',DATABRICKS_SCHEMA:'hokie',DATABRICKS_RESOURCE_TABLE:'campus_resources'});try{await fn();}finally{for(const k of KEYS)prior[k]===undefined?delete process.env[k]:process.env[k]=prior[k];}}}

test('status is disabled without shared server credentials',configured(async()=>{
  delete process.env.DATABRICKS_TOKEN;
  assert.equal(databricksStatus().enabled,false);
}));

test('resource query uses the statement API, named parameters, and sanitized rows',configured(async()=>{
  let request:any;
  const fetcher:typeof fetch=async(url,init)=>{request={url:String(url),init,body:JSON.parse(String(init?.body))};return new Response(JSON.stringify({
    status:{state:'SUCCEEDED'}, result:{data_array:[
      ['r1','Career Center','Interview support','https://career.vt.edu/interview','["verification","review"]','interview, internship','Virginia Tech','2026-09-19T00:00:00Z'],
      ['bad','Unsafe URL','Nope','javascript:alert(1)','review','career','Unknown',null],
    ]},
  }),{status:200,headers:{'content-type':'application/json'}})};
  const result=await findCareerResources({goal:"interview' OR 1=1 --",skill:'verification'},fetcher);
  assert.equal(request.url,'https://dbc-demo.cloud.databricks.com/api/2.0/sql/statements');
  assert.equal(request.init.redirect,'error');
  assert.match(request.init.headers.authorization,/^Bearer /);
  assert.doesNotMatch(request.body.statement,/OR 1=1/);
  assert.equal(request.body.parameters[0].name,'skill_pattern');
  assert.deepEqual(result.resources.map(x=>x.resourceId),['r1']);
  assert.deepEqual(result.resources[0].skillTags,['verification','review']);
}));

test('rejects invalid hosts, identifiers, inputs, oversized and unfinished responses',configured(async()=>{
  const ok:typeof fetch=async()=>new Response(JSON.stringify({status:{state:'SUCCEEDED'},result:{data_array:[]}}),{status:200});
  process.env.DATABRICKS_HOST='https://evil.example';
  await assert.rejects(()=>findCareerResources({goal:'software interview',skill:'review'},ok),/configuration is invalid/);
  process.env.DATABRICKS_HOST='https://dbc-demo.cloud.databricks.com';process.env.DATABRICKS_RESOURCE_TABLE='resources; DROP TABLE users';
  await assert.rejects(()=>findCareerResources({goal:'software interview',skill:'review'},ok),/table configuration is invalid/);
  process.env.DATABRICKS_RESOURCE_TABLE='campus_resources';
  await assert.rejects(()=>findCareerResources({goal:'x',skill:'review'},ok),/3–280/);
  await assert.rejects(()=>findCareerResources({goal:'software interview',skill:'unknown' as any},ok),/valid VibeScore skill/);
  const unfinished:typeof fetch=async()=>new Response(JSON.stringify({status:{state:'PENDING'}}),{status:200});
  await assert.rejects(()=>findCareerResources({goal:'software interview',skill:'review'},unfinished),/did not finish/);
  const oversized:typeof fetch=async()=>new Response('{}',{status:200,headers:{'content-length':'1000001'}});
  await assert.rejects(()=>findCareerResources({goal:'software interview',skill:'review'},oversized),/too much data/);
}));

test('maps provider limits and malformed results to safe errors',configured(async()=>{
  const limited:typeof fetch=async()=>new Response('{}',{status:429});
  await assert.rejects(()=>findCareerResources({goal:'software interview',skill:'context'},limited),/request limit/);
  const malformed:typeof fetch=async()=>new Response('{',{status:200});
  await assert.rejects(()=>findCareerResources({goal:'software interview',skill:'context'},malformed),/invalid response/);
}));
