import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, deleteUser, registerUser, setVisibility } from '../src/store.ts';
import { attemptsFor, challengeSummary, clearPlatformUser, createAttempt, finishAttempt, getAttempt, publicChallengeLeaderboard, saveDraft } from '../src/platform-store.ts';

test('attempt lifecycle separates practice from first rated evidence and respects profile privacy',()=>{
  const dir=mkdtempSync(join(tmpdir(),'vibescore-platform-')), prior=process.env.VIBESCORE_DATA_DIR;
  process.env.VIBESCORE_DATA_DIR=dir; closeDatabase();
  try {
    registerUser('rated_user','strong password one');
    const task={id:'task-a',kind:'interview',minutes:20,starterCode:'function solve(){}'};
    const first=createAttempt('rated_user',task,'rated');
    saveDraft(first,{code:'function solve(){return 1}'});
    assert.match(getAttempt(first.id,'rated_user')!.code,/return 1/);
    finishAttempt(first,{score:80,ratingEligible:true});
    const practice=createAttempt('rated_user',task,'practice');
    finishAttempt(practice,{score:100,ratingEligible:true});
    const second=createAttempt('rated_user',{...task,id:'task-b'},'rated');
    finishAttempt(second,{score:60,ratingEligible:true});
    const summary=challengeSummary('rated_user');
    assert.equal(summary.ratedTasks,2);
    assert.equal(summary.rating,1780);
    assert.equal(publicChallengeLeaderboard().length,0);
    setVisibility('rated_user',true);
    assert.equal(publicChallengeLeaderboard()[0].handle,'rated_user');
    clearPlatformUser('rated_user');
    assert.equal(challengeSummary('rated_user').completed,0);
    assert.equal(deleteUser('rated_user'),true);
  } finally {
    closeDatabase(); prior===undefined?delete process.env.VIBESCORE_DATA_DIR:process.env.VIBESCORE_DATA_DIR=prior;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('attempt modes resume independently and summaries retain normalized scores beyond activity history',()=>{
  const dir=mkdtempSync(join(tmpdir(),'vibescore-platform-regression-')), prior=process.env.VIBESCORE_DATA_DIR;
  process.env.VIBESCORE_DATA_DIR=dir; closeDatabase();
  try {
    registerUser('regression_user','strong password two');
    const task={id:'shared-task',kind:'interview',minutes:20,starterCode:'function solve(){}'};
    const rated=createAttempt('regression_user',task,'rated');
    const practice=createAttempt('regression_user',task,'practice');
    assert.notEqual(practice.id,rated.id);
    assert.equal(practice.mode,'practice');
    assert.equal(createAttempt('regression_user',task,'rated').id,rated.id);
    assert.equal(createAttempt('regression_user',task,'practice').id,practice.id);

    finishAttempt(rated,{score:7,maxScore:10,totalScore:70,ratingEligible:true});
    finishAttempt(practice,{score:10,maxScore:10,totalScore:100,ratingEligible:true});
    for(let i=0;i<100;i++) {
      const attempt=createAttempt('regression_user',{...task,id:`rated-${i}`},'rated');
      finishAttempt(attempt,{score:1,maxScore:2,totalScore:50,ratingEligible:true});
    }

    assert.equal(attemptsFor('regression_user').length,100);
    const summary=challengeSummary('regression_user');
    assert.equal(summary.completed,102);
    assert.equal(summary.ratedTasks,101);
    assert.equal(summary.average,50);
    assert.equal(summary.history.find(x=>x.challengeId==='shared-task')?.score,70);
  } finally {
    closeDatabase(); prior===undefined?delete process.env.VIBESCORE_DATA_DIR:process.env.VIBESCORE_DATA_DIR=prior;
    rmSync(dir,{recursive:true,force:true});
  }
});
