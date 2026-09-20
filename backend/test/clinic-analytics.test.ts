import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getDatabase } from '../src/store.ts';
import { clinicAggregate, clinicOutboxBatch, createSyntheticClinicParticipant, deleteClinicParticipant, markClinicOutboxExported, markClinicOutboxFailed, purgeExpiredClinicData, recordClinicConsent, recordClinicEvent } from '../src/clinic-analytics.ts';

const pseudonymSecret='test-only-pseudonym-key-with-at-least-32-characters';
function isolated(name:string,fn:()=>void|Promise<void>){return async()=>{const dir=mkdtempSync(join(tmpdir(),name)),prior=process.env.VIBESCORE_DATA_DIR;process.env.VIBESCORE_DATA_DIR=dir;closeDatabase();try{await fn();}finally{closeDatabase();prior===undefined?delete process.env.VIBESCORE_DATA_DIR:process.env.VIBESCORE_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}};}
const consent=(cohortId='VTHACKS26',now='2026-09-19T12:00:00.000Z')=>recordClinicConsent({cohortId,consent:true,consentVersion:'clinic-v1'},{pseudonymSecret,now});
const event=(participantToken:string,eventType:string,extra:Record<string,unknown>={},now='2026-09-19T12:05:00.000Z')=>recordClinicEvent({participantToken,eventType,...extra},{now});

test('declining analytics stores nothing and strict schemas reject identity or raw-content fields',isolated('vibescore-clinic-consent-',()=>{
  assert.deepEqual(recordClinicConsent({cohortId:'VTHACKS26',consent:false,consentVersion:'clinic-v1'},{pseudonymSecret}),{consented:false});
  assert.throws(()=>recordClinicConsent({cohortId:'VTHACKS26',consent:true,consentVersion:'clinic-v1',handle:'student'} as any,{pseudonymSecret}),/unsupported fields/);
  assert.throws(()=>recordClinicEvent({participantToken:'x'.repeat(43),eventType:'readiness_started',rawPrompt:'secret'} as any),/unsupported fields/);
  clinicAggregate('VTHACKS26');
  const db=getDatabase();
  assert.equal((db.prepare('SELECT count(*) AS n FROM clinic_participants').get() as any).n,0);
  const columns=(db.prepare("SELECT name FROM pragma_table_info('clinic_events')").all() as any[]).map(x=>x.name);
  assert.equal(columns.some(name=>/handle|email|(?:^|_)ip(?:_|$)|prompt|source_code|raw_content/i.test(name)),false);
}));

test('consented coarse events are idempotent and enter the outbox in the same transaction',isolated('vibescore-clinic-event-',()=>{
  const participant=consent(),token=participant.participantToken!,id='11111111-1111-4111-8111-111111111111';
  assert.deepEqual(recordClinicEvent({participantToken:token,eventId:id,eventType:'readiness_completed',skill:'verification',outcomeBand:'developing'},{now:'2026-09-19T12:05:00Z'}),{eventId:id,recorded:true});
  assert.deepEqual(recordClinicEvent({participantToken:token,eventId:id,eventType:'readiness_completed',skill:'verification',outcomeBand:'developing'},{now:'2026-09-19T12:06:00Z'}),{eventId:id,recorded:false});
  assert.throws(()=>recordClinicEvent({participantToken:token,eventId:id,eventType:'readiness_completed',skill:'review',outcomeBand:'developing'}),/conflicts/);
  assert.throws(()=>event(token,'feedback_submitted'),/requires a usefulness rating/);
  assert.throws(()=>event(token,'drill_completed',{skill:'verification',outcomeBand:'ready'}),/Outcome bands are accepted only/);
  const db=getDatabase(),stored:any=db.prepare('SELECT * FROM clinic_events').get(),outbox:any=db.prepare('SELECT * FROM clinic_outbox').get();
  assert.equal(stored.cohort_id,'VTHACKS26');assert.equal(stored.skill,'verification');assert.equal(stored.outcome_band,'developing');assert.equal(stored.synthetic,0);
  assert.equal(outbox.event_id,id);assert.equal(outbox.state,'pending');assert.equal(outbox.attempts,0);
  const payload=JSON.parse(outbox.payload);assert.equal(payload.participantToken,undefined);assert.equal(payload.participant_key.length,32);assert.equal(payload.event_id,id);assert.equal(payload.schema_version,1);assert.equal(payload.synthetic,false);
}));

test('aggregate suppresses cohorts below ten and reports denominators after the threshold',isolated('vibescore-clinic-aggregate-',()=>{
  const tokens:string[]=[];
  for(let index=0;index<9;index++){
    const token=consent().participantToken!;tokens.push(token);event(token,'readiness_started');event(token,'readiness_completed',{skill:'verification',outcomeBand:'starting'});
  }
  let summary=clinicAggregate('vthacks26');
  assert.equal(summary.suppressed,true);assert.equal(summary.participantCount,null);assert.equal(summary.participantCountLabel,'<10');assert.equal(summary.freshness,null);assert.equal(summary.metrics,null);
  const tenth=consent().participantToken!;tokens.push(tenth);event(tenth,'readiness_started');event(tenth,'readiness_completed',{skill:'verification',outcomeBand:'developing'});
  for(const [index,token] of tokens.entries()){
    if(index<8){event(token,'drill_started',{skill:'verification'});if(index<6)event(token,'drill_completed',{skill:'verification'});}
    if(index<5)event(token,'followup_completed',{outcomeBand:index<4?'developing':'starting'});
    if(index<4)event(token,'feedback_submitted',{usefulnessRating:index<3?5:2});
  }
  summary=clinicAggregate('VTHACKS26');const metrics=summary.metrics!;
  assert.equal(summary.suppressed,false);assert.equal(summary.participantCount,10);assert.equal(summary.synthetic,false);
  assert.equal(metrics.readinessStarts,10);assert.equal(metrics.readinessCompletions,10);assert.equal(metrics.readinessCompletionRate,1);
  assert.equal(metrics.drillStarts,8);assert.equal(metrics.drillCompletions,6);assert.equal(metrics.drillCompletionRate,.75);
  assert.equal(metrics.pairedSkillBands,5);assert.equal(metrics.improvedSkillBands,4);assert.equal(metrics.skillImprovementRate,.8);
  assert.equal(metrics.feedbackResponses,4);assert.equal(metrics.positiveFeedbackResponses,3);assert.equal(metrics.positiveFeedbackRate,.75);
  assert.deepEqual(summary.skillGaps,[{skill:'verification',participants:10}]);
}));

test('synthetic cohorts stay separate and are always labeled synthetic',isolated('vibescore-clinic-synthetic-',()=>{
  for(let index=0;index<10;index++){
    const created=createSyntheticClinicParticipant({cohortId:'DEMO26',consentVersion:'synthetic-v1'},{pseudonymSecret,now:'2026-09-19T12:00:00Z'});
    event(created.participantToken!,'readiness_started');
  }
  const live=clinicAggregate('DEMO26'),synthetic=clinicAggregate('DEMO26',true);
  assert.equal(live.suppressed,true);assert.equal(live.participantCount,null);
  assert.equal(synthetic.synthetic,true);assert.equal(synthetic.suppressed,false);assert.equal(synthetic.participantCount,10);
}));

test('participant deletion cascades through events/outbox and retention purge removes expired mappings',isolated('vibescore-clinic-delete-',()=>{
  const first=recordClinicConsent({cohortId:'VTHACKS26',consent:true,consentVersion:'clinic-v1'},{pseudonymSecret,now:'2026-01-01T00:00:00Z',retentionDays:30});
  event(first.participantToken!,'readiness_started',{},'2026-01-02T00:00:00Z');
  assert.equal(deleteClinicParticipant(first.participantToken!),true);assert.equal(deleteClinicParticipant(first.participantToken!),false);
  let db=getDatabase();assert.equal((db.prepare('SELECT count(*) AS n FROM clinic_events').get() as any).n,0);assert.equal((db.prepare('SELECT count(*) AS n FROM clinic_outbox').get() as any).n,0);
  const second=recordClinicConsent({cohortId:'VTHACKS26',consent:true,consentVersion:'clinic-v1'},{pseudonymSecret,now:'2026-02-01T00:00:00Z',retentionDays:30});
  assert.equal(purgeExpiredClinicData('2026-03-04T00:00:00Z'),1);
  assert.throws(()=>event(second.participantToken!,'readiness_started',{},'2026-03-04T00:00:00Z'),/missing or has been deleted/);
}));

test('bounded outbox retries are idempotent, back off, and end in a visible dead letter',isolated('vibescore-clinic-outbox-',()=>{
  const token=consent().participantToken!,first=event(token,'readiness_started',{},'2026-09-19T12:05:00Z').eventId,second=event(token,'readiness_completed',{skill:'context',outcomeBand:'developing'},'2026-09-19T12:06:00Z').eventId;
  assert.deepEqual(clinicOutboxBatch(1,'2026-09-19T12:07:00Z').map(x=>x.eventId),[first]);
  assert.deepEqual(markClinicOutboxFailed(first,'timeout','2026-09-19T12:05:00Z'),{state:'pending',attempts:1});
  assert.equal(clinicOutboxBatch(10,'2026-09-19T12:05:30Z').some(x=>x.eventId===first),false);
  assert.equal(markClinicOutboxExported([second],'2026-09-19T12:06:00Z'),1);assert.equal(markClinicOutboxExported([second]),0);
  for(let attempt=2;attempt<=5;attempt++)markClinicOutboxFailed(first,'unavailable',new Date(Date.parse('2026-09-19T12:05:00Z')+attempt*3600_000));
  const dead:any=getDatabase().prepare('SELECT state,attempts,last_error FROM clinic_outbox WHERE event_id=?').get(first);
  assert.equal(dead.state,'dead_letter');assert.equal(dead.attempts,5);assert.equal(dead.last_error,'unavailable');
  assert.equal(clinicOutboxBatch(10,'2026-09-21T00:00:00Z').length,0);
}));
