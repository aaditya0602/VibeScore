/** Privacy-bounded analytics for opt-in Ut Prosim clinics. No account identity or free-form content enters this schema. */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { getDatabase } from './store.ts';

export const CLINIC_SCHEMA_VERSION = 1;
export const CLINIC_CONSENT_VERSION = 'clinic-v1';
export const CLINIC_RETENTION_DAYS = 90;
export const CLINIC_MIN_COHORT = 10;

export const CLINIC_EVENT_TYPES = ['readiness_started','readiness_completed','drill_started','drill_completed','rated_task_submitted','followup_completed','feedback_submitted'] as const;
export const CLINIC_SKILLS = ['framing','context','debugging','verification','review','efficiency'] as const;
export const CLINIC_BANDS = ['starting','developing','ready'] as const;
export type ClinicEventType = typeof CLINIC_EVENT_TYPES[number];
export type ClinicSkill = typeof CLINIC_SKILLS[number];
export type ClinicBand = typeof CLINIC_BANDS[number];

const EVENT_SET=new Set<string>(CLINIC_EVENT_TYPES),SKILL_SET=new Set<string>(CLINIC_SKILLS),BAND_SET=new Set<string>(CLINIC_BANDS);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{40,128}$/;

export class ClinicValidationError extends Error { constructor(message:string){super(message);this.name='ClinicValidationError';} }
function exact(value:unknown, keys:string[], label:string):Record<string,any> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ClinicValidationError(`${label} must be an object.`);
  const object=value as Record<string,any>;
  if(Object.keys(object).some(key=>!keys.includes(key)))throw new ClinicValidationError(`${label} contains unsupported fields.`);
  return object;
}
function cohort(value:unknown):string {
  const clean=typeof value==='string'?value.trim().toUpperCase():'';
  if(!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(clean))throw new ClinicValidationError('Clinic code must contain 3–32 letters, numbers, underscores, or hyphens.');
  return clean;
}
function consentVersion(value:unknown):string {
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value))throw new ClinicValidationError('Consent version is invalid.');
  return value;
}
function tokenHash(token:string){return createHash('sha256').update(token).digest('hex');}
function iso(value:Date|string|number){const date=new Date(value);if(!Number.isFinite(date.getTime()))throw new ClinicValidationError('Timestamp is invalid.');return date.toISOString();}
function database(){
  const db=getDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS clinic_participants (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, participant_key TEXT NOT NULL,
    cohort_id TEXT NOT NULL, consent_version TEXT NOT NULL, consented_at TEXT NOT NULL,
    retention_until TEXT NOT NULL, synthetic INTEGER NOT NULL DEFAULT 0 CHECK(synthetic IN (0,1))
  );
  CREATE INDEX IF NOT EXISTS clinic_participant_cohort ON clinic_participants(cohort_id,synthetic);
  CREATE TABLE IF NOT EXISTS clinic_events (
    event_id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES clinic_participants(id) ON DELETE CASCADE,
    occurred_at TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('readiness_started','readiness_completed','drill_started','drill_completed','rated_task_submitted','followup_completed','feedback_submitted')),
    cohort_id TEXT NOT NULL, participant_key TEXT NOT NULL, skill TEXT,
    outcome_band TEXT, usefulness_rating INTEGER, consent_version TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version=1), synthetic INTEGER NOT NULL CHECK(synthetic IN (0,1)),
    CHECK(skill IS NULL OR skill IN ('framing','context','debugging','verification','review','efficiency')),
    CHECK(outcome_band IS NULL OR outcome_band IN ('starting','developing','ready')),
    CHECK(usefulness_rating IS NULL OR usefulness_rating BETWEEN 1 AND 5)
  );
  CREATE INDEX IF NOT EXISTS clinic_event_cohort ON clinic_events(cohort_id,synthetic,occurred_at);
  CREATE TABLE IF NOT EXISTS clinic_outbox (
    event_id TEXT PRIMARY KEY REFERENCES clinic_events(event_id) ON DELETE CASCADE,
    payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','exported','dead_letter')),
    attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, next_attempt_at TEXT, exported_at TEXT, last_error TEXT
  );
  CREATE TRIGGER IF NOT EXISTS immutable_clinic_participants BEFORE UPDATE ON clinic_participants BEGIN SELECT RAISE(ABORT, 'clinic participants are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_clinic_events BEFORE UPDATE ON clinic_events BEGIN SELECT RAISE(ABORT, 'clinic events are immutable'); END;`);
  return db;
}
function transaction<T>(fn:(db:ReturnType<typeof getDatabase>)=>T):T {
  const db=database();db.exec('BEGIN IMMEDIATE');
  try{const result=fn(db);db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
}
function secret(options:any):string {
  const value=options?.pseudonymSecret??process.env.CLINIC_PSEUDONYM_SECRET;
  if(typeof value!=='string'||value.length<32)throw new ClinicValidationError('Clinic pseudonym secret must contain at least 32 characters.');
  return value;
}

export interface ClinicConsentResult { consented:boolean; participantToken?:string; consentVersion?:string; retentionUntil?:string; }
export function recordClinicConsent(input:unknown, options:any={}):ClinicConsentResult {
  const value=exact(input,['cohortId','consent','consentVersion'],'Clinic consent');
  const cohortId=cohort(value.cohortId),version=consentVersion(value.consentVersion);
  if(value.consent!==true&&value.consent!==false)throw new ClinicValidationError('Consent must be true or false.');
  if(!value.consent)return {consented:false};
  if(version!==CLINIC_CONSENT_VERSION)throw new ClinicValidationError('Consent version is not current.');
  return createParticipant(cohortId,version,false,options);
}
/** Test/demo seed hook. Synthetic rows are permanently labeled and aggregated separately. */
export function createSyntheticClinicParticipant(input:unknown, options:any={}):ClinicConsentResult {
  const value=exact(input,['cohortId','consentVersion'],'Synthetic clinic participant');
  return createParticipant(cohort(value.cohortId),consentVersion(value.consentVersion),true,options);
}
function createParticipant(cohortId:string,version:string,synthetic:boolean,options:any):ClinicConsentResult {
  const now=new Date(options.now??Date.now()),days=options.retentionDays??CLINIC_RETENTION_DAYS;
  if(!Number.isInteger(days)||days<7||days>365)throw new ClinicValidationError('Clinic retention must be 7–365 days.');
  const participantToken=randomBytes(32).toString('base64url'),rotation=now.toISOString().slice(0,7);
  const participantKey=createHmac('sha256',secret(options)).update(`${cohortId}:${rotation}:${participantToken}`).digest('hex').slice(0,32);
  const retentionUntil=new Date(now.getTime()+days*86400_000).toISOString(),id=randomUUID();
  database().prepare(`INSERT INTO clinic_participants(id,token_hash,participant_key,cohort_id,consent_version,consented_at,retention_until,synthetic)
    VALUES(?,?,?,?,?,?,?,?)`).run(id,tokenHash(participantToken),participantKey,cohortId,version,now.toISOString(),retentionUntil,synthetic?1:0);
  return {consented:true,participantToken,consentVersion:version,retentionUntil};
}

export interface ClinicEventResult { eventId:string; recorded:boolean; }
export function recordClinicEvent(input:unknown, options:any={}):ClinicEventResult {
  const value=exact(input,['participantToken','eventId','eventType','skill','outcomeBand','usefulnessRating'],'Clinic event');
  if(typeof value.participantToken!=='string'||!TOKEN.test(value.participantToken))throw new ClinicValidationError('Clinic participant token is invalid.');
  const eventId=value.eventId===undefined?randomUUID():value.eventId;
  if(typeof eventId!=='string'||!UUID.test(eventId))throw new ClinicValidationError('Clinic event ID must be a UUID.');
  if(typeof value.eventType!=='string'||!EVENT_SET.has(value.eventType))throw new ClinicValidationError('Clinic event type is invalid.');
  const eventType=value.eventType as ClinicEventType;
  const skill=value.skill===undefined?null:value.skill;
  const band=value.outcomeBand===undefined?null:value.outcomeBand;
  const rating=value.usefulnessRating===undefined?null:value.usefulnessRating;
  if(skill!==null&&(typeof skill!=='string'||!SKILL_SET.has(skill)))throw new ClinicValidationError('Clinic skill is invalid.');
  if(band!==null&&(typeof band!=='string'||!BAND_SET.has(band)))throw new ClinicValidationError('Clinic outcome band is invalid.');
  if(rating!==null&&(!Number.isInteger(rating)||rating<1||rating>5))throw new ClinicValidationError('Usefulness rating must be an integer from 1 to 5.');
  if(['readiness_completed','drill_started','drill_completed','rated_task_submitted'].includes(eventType)&&skill===null)throw new ClinicValidationError(`${eventType} requires a skill.`);
  if(['readiness_completed','followup_completed'].includes(eventType)&&band===null)throw new ClinicValidationError(`${eventType} requires an outcome band.`);
  if(eventType==='feedback_submitted'&&rating===null)throw new ClinicValidationError('feedback_submitted requires a usefulness rating.');
  if(eventType!=='feedback_submitted'&&rating!==null)throw new ClinicValidationError('Usefulness ratings are accepted only for feedback_submitted.');
  if(!['readiness_completed','followup_completed'].includes(eventType)&&band!==null)throw new ClinicValidationError('Outcome bands are accepted only for readiness and follow-up completion.');
  const occurredAt=iso(options.now??Date.now());
  return transaction(db=>{
    const participant:any=db.prepare('SELECT * FROM clinic_participants WHERE token_hash=?').get(tokenHash(value.participantToken));
    if(!participant)throw new ClinicValidationError('Clinic consent is missing or has been deleted.');
    if(Date.parse(participant.retention_until)<=Date.parse(occurredAt))throw new ClinicValidationError('Clinic consent has expired.');
    const canonical={event_id:eventId,occurred_at:occurredAt,event_type:eventType,cohort_id:participant.cohort_id,participant_key:participant.participant_key,skill,outcome_band:band,usefulness_rating:rating,consent_version:participant.consent_version,schema_version:CLINIC_SCHEMA_VERSION,synthetic:participant.synthetic===1};
    const existing:any=db.prepare('SELECT event_type,cohort_id,participant_key,skill,outcome_band,usefulness_rating FROM clinic_events WHERE event_id=?').get(eventId);
    if(existing){
      const same=existing.event_type===eventType&&existing.cohort_id===participant.cohort_id&&existing.participant_key===participant.participant_key&&(existing.skill??null)===skill&&(existing.outcome_band??null)===band&&(existing.usefulness_rating??null)===rating;
      if(!same)throw new ClinicValidationError('Clinic event ID conflicts with an existing event.');
      return {eventId,recorded:false};
    }
    db.prepare(`INSERT INTO clinic_events(event_id,participant_id,occurred_at,event_type,cohort_id,participant_key,skill,outcome_band,usefulness_rating,consent_version,schema_version,synthetic)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId,participant.id,occurredAt,eventType,participant.cohort_id,participant.participant_key,skill,band,rating,participant.consent_version,CLINIC_SCHEMA_VERSION,participant.synthetic);
    db.prepare('INSERT INTO clinic_outbox(event_id,payload,created_at) VALUES(?,?,?)').run(eventId,JSON.stringify(canonical),occurredAt);
    return {eventId,recorded:true};
  });
}

export function deleteClinicParticipant(participantToken:string):boolean {
  if(typeof participantToken!=='string'||!TOKEN.test(participantToken))return false;
  return transaction(db=>Number(db.prepare('DELETE FROM clinic_participants WHERE token_hash=?').run(tokenHash(participantToken)).changes)>0);
}
export function purgeExpiredClinicData(now:Date|string|number=Date.now()):number {
  const cutoff=iso(now);
  return transaction(db=>Number(db.prepare('DELETE FROM clinic_participants WHERE retention_until<=?').run(cutoff).changes));
}

export function clinicOutboxBatch(limit=50, now:Date|string|number=Date.now()):Array<{eventId:string;payload:Record<string,unknown>;attempts:number}> {
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new ClinicValidationError('Clinic export batch size must be 1–100.');
  return (database().prepare(`SELECT event_id,payload,attempts FROM clinic_outbox
    WHERE state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,event_id LIMIT ?`).all(iso(now),limit) as any[])
    .map(row=>({eventId:row.event_id,payload:JSON.parse(row.payload),attempts:row.attempts}));
}
export function markClinicOutboxExported(eventIds:string[],now:Date|string|number=Date.now()):number {
  if(!Array.isArray(eventIds)||eventIds.length<1||eventIds.length>100||eventIds.some(id=>typeof id!=='string'||!UUID.test(id)))throw new ClinicValidationError('Exported clinic event IDs must be 1–100 UUIDs.');
  const at=iso(now);
  return transaction(db=>eventIds.reduce((count,id)=>count+Number(db.prepare("UPDATE clinic_outbox SET state='exported',exported_at=?,next_attempt_at=NULL,last_error=NULL WHERE event_id=? AND state='pending'").run(at,id).changes),0));
}
export function markClinicOutboxFailed(eventId:string,failureCode:'timeout'|'unavailable'|'rejected'|'invalid_schema',now:Date|string|number=Date.now()):{state:'pending'|'dead_letter';attempts:number} {
  if(typeof eventId!=='string'||!UUID.test(eventId))throw new ClinicValidationError('Clinic event ID must be a UUID.');
  if(!['timeout','unavailable','rejected','invalid_schema'].includes(failureCode))throw new ClinicValidationError('Clinic export failure code is invalid.');
  return transaction(db=>{
    const row:any=db.prepare("SELECT attempts FROM clinic_outbox WHERE event_id=? AND state='pending'").get(eventId);
    if(!row)throw new ClinicValidationError('Pending clinic outbox event was not found.');
    const attempts=row.attempts+1,state=attempts>=5?'dead_letter':'pending',delay=Math.min(60*2**(attempts-1),3600),next=state==='pending'?new Date(Date.parse(iso(now))+delay*1000).toISOString():null;
    db.prepare('UPDATE clinic_outbox SET attempts=?,state=?,next_attempt_at=?,last_error=? WHERE event_id=?').run(attempts,state,next,failureCode,eventId);
    return {state,attempts};
  });
}
export function clinicOutboxStatus():{pending:number;exported:number;deadLetter:number;lastSuccessAt:string|null} {
  const db=database(),counts=db.prepare('SELECT state,count(*) AS n FROM clinic_outbox GROUP BY state').all() as any[];
  const values=new Map(counts.map(row=>[row.state,Number(row.n)]));
  const latest:any=db.prepare("SELECT max(exported_at) AS at FROM clinic_outbox WHERE state='exported'").get();
  return {pending:values.get('pending')??0,exported:values.get('exported')??0,deadLetter:values.get('dead_letter')??0,lastSuccessAt:latest?.at??null};
}

export interface ClinicAggregate {
  cohortId:string; synthetic:boolean; suppressed:boolean; minimumCohort:number; participantCount:number|null; participantCountLabel:string;
  freshness:string|null; metrics:null|Record<string,number|null>; skillGaps:null|Array<{skill:string;participants:number}>; limitations:string[];
}
export function clinicAggregate(rawCohortId:string, synthetic=false):ClinicAggregate {
  const cohortId=cohort(rawCohortId),db=database(),flag=synthetic?1:0;
  const rows=db.prepare('SELECT * FROM clinic_events WHERE cohort_id=? AND synthetic=? ORDER BY occurred_at,event_id').all(cohortId,flag) as any[];
  const participants=new Set(rows.map(row=>row.participant_key)),count=participants.size;
  const freshness=rows.length?rows[rows.length-1].occurred_at:null;
  const base={cohortId,synthetic,suppressed:count<CLINIC_MIN_COHORT,minimumCohort:CLINIC_MIN_COHORT,participantCount:count<CLINIC_MIN_COHORT?null:count,participantCountLabel:count<CLINIC_MIN_COHORT?`<${CLINIC_MIN_COHORT}`:String(count),freshness,
    limitations:['Observational clinic metrics do not establish causation.','Missing follow-up or feedback is reported through denominators.','Small cohorts are suppressed to reduce re-identification risk.']};
  if(count<CLINIC_MIN_COHORT)return {...base,freshness:null,metrics:null,skillGaps:null};
  const unique=(type:string)=>new Set(rows.filter(row=>row.event_type===type).map(row=>row.participant_key)).size;
  const starts=unique('readiness_started'),readiness=unique('readiness_completed'),drillStarts=unique('drill_started'),drillCompletions=unique('drill_completed'),rated=unique('rated_task_submitted'),followups=unique('followup_completed'),feedback=unique('feedback_submitted');
  const feedbackByParticipant=new Map(rows.filter(row=>row.event_type==='feedback_submitted'&&row.usefulness_rating!==null).map(row=>[row.participant_key,row.usefulness_rating]));
  const positive=[...feedbackByParticipant.values()].filter(value=>value>=4).length;
  const baseline=new Map(rows.filter(row=>row.event_type==='readiness_completed'&&row.outcome_band).map(row=>[row.participant_key,row.outcome_band]));
  const followup=new Map(rows.filter(row=>row.event_type==='followup_completed'&&row.outcome_band).map(row=>[row.participant_key,row.outcome_band]));
  const order=new Map(CLINIC_BANDS.map((band,index)=>[band,index])),paired=[...baseline].filter(([key])=>followup.has(key));
  const improved=paired.filter(([key,band])=>(order.get(followup.get(key))??0)>(order.get(band)??0)).length;
  const gaps=new Map<string,Set<string>>();
  for(const row of rows.filter(row=>row.event_type==='readiness_completed'&&row.skill&&row.outcome_band!=='ready')){
    const members=gaps.get(row.skill)??new Set<string>();members.add(row.participant_key);gaps.set(row.skill,members);
  }
  const skillGaps=[...gaps].map(([skill,members])=>({skill,participants:members.size})).sort((a,b)=>b.participants-a.participants||a.skill.localeCompare(b.skill));
  const ratio=(numerator:number,denominator:number)=>denominator?Number((numerator/denominator).toFixed(4)):null;
  return {...base,suppressed:false,skillGaps,metrics:{readinessStarts:starts,readinessCompletions:readiness,readinessCompletionRate:ratio(readiness,starts),drillStarts,drillCompletions,drillCompletionRate:ratio(drillCompletions,drillStarts),ratedTaskSubmissions:rated,followupResponses:followups,pairedSkillBands:paired.length,improvedSkillBands:improved,skillImprovementRate:ratio(improved,paired.length),feedbackResponses:feedback,positiveFeedbackResponses:positive,positiveFeedbackRate:ratio(positive,feedback)}};
}
