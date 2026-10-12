import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getDatabase } from '../src/store.ts';
import { clinicOutboxStatus, recordClinicConsent, recordClinicEvent } from '../src/clinic-analytics.ts';
import { databricksClinicStatus, exportClinicOutboxOnce } from '../src/databricks-clinic.ts';

const names=['DATABRICKS_HOST','DATABRICKS_TOKEN','DATABRICKS_WAREHOUSE_ID','DATABRICKS_CATALOG','DATABRICKS_SCHEMA','DATABRICKS_CLINIC_EVENTS_TABLE'] as const;
const secret='test-only-clinic-pseudonym-secret-32-characters';
function configured(){
  process.env.DATABRICKS_HOST='https://adb-123456789.12.azuredatabricks.net';process.env.DATABRICKS_TOKEN='private-export-token';
  process.env.DATABRICKS_WAREHOUSE_ID='warehouse-123';process.env.DATABRICKS_CATALOG='vibescore';process.env.DATABRICKS_SCHEMA='hokie';process.env.DATABRICKS_CLINIC_EVENTS_TABLE='clinic_event_v1';
}
function isolated(name:string,fn:()=>void|Promise<void>){return async()=>{
  const dir=mkdtempSync(join(tmpdir(),name)),priorDir=process.env.VIBESCORE_DATA_DIR,prior=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  process.env.VIBESCORE_DATA_DIR=dir;closeDatabase();for(const key of names)delete process.env[key];
  try{await fn();}finally{closeDatabase();priorDir===undefined?delete process.env.VIBESCORE_DATA_DIR:process.env.VIBESCORE_DATA_DIR=priorDir;for(const key of names){const value=prior[key];value===undefined?delete process.env[key]:process.env[key]=value;}rmSync(dir,{recursive:true,force:true});}
};}
function queued(){
  const consent=recordClinicConsent({cohortId:'VTHACKS26',consent:true,consentVersion:'clinic-v1'},{pseudonymSecret:secret,now:'2026-09-19T12:00:00Z'});
  return recordClinicEvent({participantToken:consent.participantToken,eventType:'readiness_completed',skill:'verification',outcomeBand:'developing'},{now:'2026-09-19T12:05:00Z'}).eventId;
}
const success=()=>new Response(JSON.stringify({statement_id:'statement-1',status:{state:'SUCCEEDED'}}),{status:200,headers:{'content-type':'application/json'}});

test('exports a bounded event with an idempotent parameterized MERGE',isolated('vibescore-db-clinic-success-',async()=>{
  configured();const eventId=queued();let request:Request|undefined;
  const result=await exportClinicOutboxOnce(async(input,init)=>{request=new Request(input,init);return success();},{now:'2026-09-19T12:10:00Z',pollIntervalMs:0});
  assert.equal(result.enabled,true);assert.equal(result.attempted,1);assert.equal(result.succeeded,1);assert.equal(result.failed,0);assert.equal(result.pending,0);assert.equal(result.exported,1);
  assert.equal(request?.url,'https://adb-123456789.12.azuredatabricks.net/api/2.0/sql/statements/');assert.equal(request?.redirect,'error');assert.equal(request?.headers.get('authorization'),'Bearer private-export-token');
  const body=await request?.json() as any;assert.match(body.statement,/^MERGE INTO `vibescore`\.`hokie`\.`clinic_event_v1`/);assert.doesNotMatch(body.statement,/VTHACKS26|verification|developing/);
  const params=new Map(body.parameters.map((item:any)=>[item.name,item]));assert.equal(params.get('event_id').value,eventId);assert.equal(params.get('cohort_id').value,'VTHACKS26');assert.equal(params.get('synthetic').value,'false');
  let calls=0;const again=await exportClinicOutboxOnce(async()=>{calls++;return success();},{now:'2026-09-19T12:11:00Z'});assert.equal(again.attempted,0);assert.equal(calls,0);
}));

test('disabled or invalid exporter configuration leaves the outbox untouched',isolated('vibescore-db-clinic-disabled-',async()=>{
  queued();let calls=0;let result=await exportClinicOutboxOnce(async()=>{calls++;return success();});
  assert.equal(result.enabled,false);assert.equal(result.attempted,0);assert.equal(result.pending,1);assert.equal(calls,0);
  configured();process.env.DATABRICKS_HOST='https://attacker.example';result=await exportClinicOutboxOnce(async()=>{calls++;return success();});
  assert.equal(result.enabled,false);assert.equal(result.pending,1);assert.equal(calls,0);
}));

test('timeouts use the closed retry code and exponential backoff',isolated('vibescore-db-clinic-timeout-',async()=>{
  configured();const eventId=queued(),timeout=Object.assign(new Error('aborted'),{name:'TimeoutError'});
  const result=await exportClinicOutboxOnce(async()=>{throw timeout;},{now:'2026-09-19T12:10:00Z',deadlineMs:100});
  assert.equal(result.failed,1);assert.equal(result.pending,1);
  const row:any=getDatabase().prepare('SELECT attempts,last_error,next_attempt_at FROM clinic_outbox WHERE event_id=?').get(eventId);
  assert.equal(row.attempts,1);assert.equal(row.last_error,'timeout');assert.equal(row.next_attempt_at,'2026-09-19T12:11:00.000Z');
}));

test('redirect failures and oversized responses fail closed without exporting',isolated('vibescore-db-clinic-bounds-',async()=>{
  configured();const first=queued();
  let result=await exportClinicOutboxOnce(async()=>{throw new TypeError('redirect blocked');},{now:'2026-09-19T12:10:00Z'});
  assert.equal(result.failed,1);let row:any=getDatabase().prepare('SELECT state,last_error FROM clinic_outbox WHERE event_id=?').get(first);assert.equal(row.state,'pending');assert.equal(row.last_error,'rejected');
  getDatabase().prepare("UPDATE clinic_outbox SET next_attempt_at=NULL").run();
  result=await exportClinicOutboxOnce(async()=>new Response('{}',{status:200,headers:{'content-length':'1000001','content-type':'application/json'}}),{now:'2026-09-19T12:20:00Z'});
  assert.equal(result.failed,1);row=getDatabase().prepare('SELECT state,attempts,last_error FROM clinic_outbox WHERE event_id=?').get(first);assert.equal(row.state,'pending');assert.equal(row.attempts,2);assert.equal(row.last_error,'unavailable');
}));

test('tampered free-form payloads never reach Databricks and become dead letters',isolated('vibescore-db-clinic-dead-',async()=>{
  configured();const eventId=queued(),db=getDatabase(),stored:any=db.prepare('SELECT payload FROM clinic_outbox WHERE event_id=?').get(eventId),payload=JSON.parse(stored.payload);
  payload.raw_prompt='private text';db.prepare('UPDATE clinic_outbox SET payload=? WHERE event_id=?').run(JSON.stringify(payload),eventId);
  let calls=0;
  for(let attempt=0;attempt<5;attempt++){
    db.prepare('UPDATE clinic_outbox SET next_attempt_at=NULL WHERE event_id=?').run(eventId);
    await exportClinicOutboxOnce(async()=>{calls++;return success();},{now:new Date(Date.parse('2026-09-19T13:00:00Z')+attempt*3600_000)});
  }
  assert.equal(calls,0);const row:any=db.prepare('SELECT state,attempts,last_error FROM clinic_outbox WHERE event_id=?').get(eventId);
  assert.equal(row.state,'dead_letter');assert.equal(row.attempts,5);assert.equal(row.last_error,'invalid_schema');
  assert.deepEqual(clinicOutboxStatus(),{pending:0,exported:0,deadLetter:1,lastSuccessAt:null});assert.equal(databricksClinicStatus().deadLetter,1);
}));
