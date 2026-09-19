import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, deleteUser, registerUser, setVisibility } from '../src/store.ts';
import { challengeSummary, clearPlatformUser, createAttempt, finishAttempt, getAttempt, publicChallengeLeaderboard, saveDraft } from '../src/platform-store.ts';

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
