#!/usr/bin/env node
/** Seed a clearly labeled synthetic cohort for the organizer impact demo. */
import { clinicAggregate, createSyntheticClinicParticipant, recordClinicEvent } from '../backend/src/clinic-analytics.ts';
import { closeDatabase, getDatabase } from '../backend/src/store.ts';

const cohortId=(process.argv[2]??'VTHACKS26').trim().toUpperCase();
if(!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(cohortId))throw new Error('Use a 3–32 character clinic code.');
if((process.env.CLINIC_PSEUDONYM_SECRET??'').length<32)throw new Error('Set CLINIC_PSEUDONYM_SECRET before seeding the synthetic clinic demo.');

try{
  // Initialize clinic tables before reading the synthetic participant count.
  clinicAggregate(cohortId,true);
  const db=getDatabase();
  const current=Number(db.prepare('SELECT count(*) AS n FROM clinic_participants WHERE cohort_id=? AND synthetic=1').get(cohortId).n);
  const tokens=[];
  for(let i=current;i<10;i++)tokens.push(createSyntheticClinicParticipant({cohortId,consentVersion:'synthetic-v1'}).participantToken);
  for(const [index,participantToken] of tokens.entries()){
    if(!participantToken)continue;
    const ordinal=current+index,skill=ordinal<6?'verification':'context',outcomeBand=ordinal<4?'starting':'developing';
    recordClinicEvent({participantToken,eventType:'readiness_started'});
    recordClinicEvent({participantToken,eventType:'readiness_completed',skill,outcomeBand});
    if(ordinal<8)recordClinicEvent({participantToken,eventType:'drill_started',skill});
    if(ordinal<6)recordClinicEvent({participantToken,eventType:'drill_completed',skill});
    if(ordinal<5)recordClinicEvent({participantToken,eventType:'followup_completed',outcomeBand:ordinal<4?'developing':'starting'});
    if(ordinal<4)recordClinicEvent({participantToken,eventType:'feedback_submitted',usefulnessRating:ordinal<3?5:2});
  }
  console.log(JSON.stringify({ok:true,cohortId,synthetic:true,participants:10,added:tokens.length}));
}finally{closeDatabase();}
