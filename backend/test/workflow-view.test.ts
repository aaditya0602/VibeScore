import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, registerUser, saveBundle, scoreHistory, setVisibility } from '../src/store.ts';
import { currentWorkflowScore, publicWorkflowLeaderboard, publicWorkflowScore } from '../src/workflow-view.ts';

function bundle(quality: number, generatedAt = '2026-09-19T12:00:00.000Z') {
  const summary = {
    episodes:quality ? 8 : 1, activeMinutes:10, promptCount:2, effectiveTokens:1000, weightedTokens:1000,
    correctionRatio:1-quality, meanRedirectDepth:quality ? 0 : 20, firstPromptContextScore:quality,
    meanPromptSpecificity:quality ? 8 : 0, editsPerPrompt:quality ? 4 : 0, loopBurnFraction:1-quality,
    loopCount:quality ? 0 : 2, toolSuccessRate:quality, verifyAfterEditRatio:quality,
    errorRecoveryRate:quality, agenticLeverage:quality, outcomes:quality ? {verified:8} : {ended:1},
    modelHistogram:{'test-model':1000},
  };
  return {schemaVersion:'0.1.0',agent:'codex',generatedAt,
    coherence:{chainBreaks:0,timeRegressions:0,unknownEventRatio:0,badJsonLines:0},
    projects:[{projectHash:`${quality ? 'a' : 'b'}`.repeat(16),...summary}],overall:summary};
}

test('workflow views use one current population while enforcing visibility and stable ordering', () => {
  const dir=mkdtempSync(join(tmpdir(),'vibescore-workflow-view-')),prior=process.env.VIBESCORE_DATA_DIR;
  process.env.VIBESCORE_DATA_DIR=dir;closeDatabase();
  try {
    registerUser('alpha_builder','a strong password');
    saveBundle('alpha_builder',bundle(1) as any);
    const savedSnapshot=scoreHistory('alpha_builder',1)[0].rating;
    registerUser('private_builder','a strong password');
    saveBundle('private_builder',bundle(0) as any);
    registerUser('beta_builder','a strong password');
    saveBundle('beta_builder',bundle(1) as any);
    setVisibility('alpha_builder',true);setVisibility('beta_builder',true);

    const current=currentWorkflowScore('alpha_builder')!;
    assert.ok(current.rating>savedSnapshot,'current score reflects builders added after the saved snapshot');
    assert.equal(current.agent,'codex');assert.equal(current.episodes,8);
    assert.match(current.recommendation.path,/^\/challenge\//);
    assert.equal(publicWorkflowScore('private_builder'),null);
    assert.equal(currentWorkflowScore('private_builder')?.handle,'private_builder','owner view may include private evidence');
    assert.deepEqual(publicWorkflowLeaderboard().map(entry=>entry.handle),['alpha_builder','beta_builder'],'equal entries sort deterministically by handle');
  } finally {
    closeDatabase();prior===undefined?delete process.env.VIBESCORE_DATA_DIR:process.env.VIBESCORE_DATA_DIR=prior;
    rmSync(dir,{recursive:true,force:true});
  }
});
