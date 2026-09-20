/** Bounded, idempotent Databricks exporter for privacy-reduced clinic events. */
import { CLINIC_BANDS, CLINIC_EVENT_TYPES, CLINIC_SKILLS, clinicOutboxBatch, clinicOutboxStatus, markClinicOutboxExported, markClinicOutboxFailed } from './clinic-analytics.ts';
import { databricksConfigFor, executeDatabricksStatement, type DatabricksParameter, type FetchLike, type QueryOptions } from './databricks.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPES=new Set<string>(CLINIC_EVENT_TYPES),SKILLS=new Set<string>(CLINIC_SKILLS),BANDS=new Set<string>(CLINIC_BANDS);
const PAYLOAD_KEYS=['event_id','occurred_at','event_type','cohort_id','participant_key','skill','outcome_band','usefulness_rating','consent_version','schema_version','synthetic'];

interface ClinicExportEvent {
  event_id:string;occurred_at:string;event_type:string;cohort_id:string;participant_key:string;skill:string|null;
  outcome_band:string|null;usefulness_rating:number|null;consent_version:string;schema_version:number;synthetic:boolean;
}
export interface ClinicExportStatus {
  enabled:boolean;source:'Databricks Unity Catalog';pending:number;exported:number;deadLetter:number;lastSuccessAt:string|null;
}
export interface ClinicExportResult extends ClinicExportStatus { attempted:number;succeeded:number;failed:number; }

function exportConfig(){return databricksConfigFor('DATABRICKS_CLINIC_EVENTS_TABLE');}
export function databricksClinicStatus():ClinicExportStatus {
  let enabled=false;try{enabled=Boolean(exportConfig());}catch{enabled=false;}
  return {enabled,source:'Databricks Unity Catalog',...clinicOutboxStatus()};
}
function parseEvent(value:unknown):ClinicExportEvent {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_schema');
  const event=value as Record<string,any>;
  if(Object.keys(event).length!==PAYLOAD_KEYS.length||Object.keys(event).some(key=>!PAYLOAD_KEYS.includes(key)))throw new Error('invalid_schema');
  if(typeof event.event_id!=='string'||!UUID.test(event.event_id))throw new Error('invalid_schema');
  if(typeof event.occurred_at!=='string'||!Number.isFinite(Date.parse(event.occurred_at))||new Date(event.occurred_at).toISOString()!==event.occurred_at)throw new Error('invalid_schema');
  if(typeof event.event_type!=='string'||!EVENT_TYPES.has(event.event_type))throw new Error('invalid_schema');
  if(typeof event.cohort_id!=='string'||!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(event.cohort_id))throw new Error('invalid_schema');
  if(typeof event.participant_key!=='string'||!/^[a-f0-9]{32}$/.test(event.participant_key))throw new Error('invalid_schema');
  if(event.skill!==null&&(typeof event.skill!=='string'||!SKILLS.has(event.skill)))throw new Error('invalid_schema');
  if(event.outcome_band!==null&&(typeof event.outcome_band!=='string'||!BANDS.has(event.outcome_band)))throw new Error('invalid_schema');
  if(event.usefulness_rating!==null&&(!Number.isInteger(event.usefulness_rating)||event.usefulness_rating<1||event.usefulness_rating>5))throw new Error('invalid_schema');
  if(typeof event.consent_version!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(event.consent_version)||event.schema_version!==1||typeof event.synthetic!=='boolean')throw new Error('invalid_schema');
  return event as ClinicExportEvent;
}
function parameters(event:ClinicExportEvent):DatabricksParameter[] {
  return [
    {name:'event_id',value:event.event_id,type:'STRING'},
    {name:'occurred_at',value:event.occurred_at,type:'TIMESTAMP'},
    {name:'event_type',value:event.event_type,type:'STRING'},
    {name:'cohort_id',value:event.cohort_id,type:'STRING'},
    {name:'participant_key',value:event.participant_key,type:'STRING'},
    {name:'skill',value:event.skill??'',type:'STRING'},
    {name:'outcome_band',value:event.outcome_band??'',type:'STRING'},
    {name:'usefulness_rating',value:String(event.usefulness_rating??0),type:'INT'},
    {name:'consent_version',value:event.consent_version,type:'STRING'},
    {name:'schema_version',value:String(event.schema_version),type:'INT'},
    {name:'synthetic',value:String(event.synthetic),type:'BOOLEAN'},
  ];
}
function statement(table:string):string {
  return `MERGE INTO ${table} AS target
USING (SELECT :event_id AS event_id, :occurred_at AS occurred_at, :event_type AS event_type,
  :cohort_id AS cohort_id, :participant_key AS participant_key, NULLIF(:skill, '') AS skill,
  NULLIF(:outcome_band, '') AS outcome_band, NULLIF(:usefulness_rating, 0) AS usefulness_rating,
  :consent_version AS consent_version, :schema_version AS schema_version, :synthetic AS synthetic) AS source
ON target.event_id = source.event_id
WHEN NOT MATCHED THEN INSERT (event_id,occurred_at,event_type,cohort_id,participant_key,skill,outcome_band,usefulness_rating,consent_version,schema_version,synthetic)
VALUES (source.event_id,source.occurred_at,source.event_type,source.cohort_id,source.participant_key,source.skill,source.outcome_band,source.usefulness_rating,source.consent_version,source.schema_version,source.synthetic)`;
}
function failure(error:unknown):'timeout'|'unavailable'|'rejected'|'invalid_schema' {
  const message=error instanceof Error?error.message:'';
  if(message==='invalid_schema')return 'invalid_schema';
  if(/timed out/i.test(message))return 'timeout';
  if(/temporarily unavailable/i.test(message))return 'rejected';
  return 'unavailable';
}

export async function exportClinicOutboxOnce(fetchImpl:FetchLike=fetch,options:QueryOptions&{batchSize?:number;now?:Date|string|number}={}):Promise<ClinicExportResult> {
  let cfg;try{cfg=exportConfig();}catch{cfg=null;}
  if(!cfg)return {...databricksClinicStatus(),attempted:0,succeeded:0,failed:0};
  const batch=clinicOutboxBatch(Math.max(1,Math.min(25,Math.floor(options.batchSize??25))),options.now??Date.now());
  let attempted=0,succeeded=0,failed=0;
  for(const item of batch){
    attempted++;
    try{
      const event=parseEvent(item.payload);
      if(event.event_id!==item.eventId)throw new Error('invalid_schema');
      await executeDatabricksStatement(cfg,statement(cfg.table),parameters(event),fetchImpl,options);
      markClinicOutboxExported([item.eventId],options.now??Date.now());succeeded++;
    }catch(error){
      const code=failure(error);markClinicOutboxFailed(item.eventId,code,options.now??Date.now());failed++;
      if(code!=='invalid_schema')break;
    }
  }
  return {...databricksClinicStatus(),attempted,succeeded,failed};
}
