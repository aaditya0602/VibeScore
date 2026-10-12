import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDatabase, credentialByToken, deleteUser, getDatabase, getUser, loadPublicPopulation, loginUser,
  recoverAccount, registerUser, revokeApiTokens, rotateToken, saveBundle, scoreHistory, setVisibility, userByToken,
} from '../src/store.ts';

function bundle(extra: Record<string,unknown> = {}) {
  const summary = {
    episodes:1, activeMinutes:10, promptCount:2, effectiveTokens:1000, weightedTokens:1000,
    correctionRatio:0, meanRedirectDepth:0, firstPromptContextScore:.5, meanPromptSpecificity:2,
    editsPerPrompt:1, loopBurnFraction:0, loopCount:0, toolSuccessRate:1,
    verifyAfterEditRatio:1, errorRecoveryRate:1, agenticLeverage:0,
    outcomes:{verified:1}, modelHistogram:{'test-model':1000},
  };
  return { schemaVersion:'0.1.0', agent:'codex', generatedAt:'2026-09-19T12:00:00.000Z',
    coherence:{chainBreaks:0,timeRegressions:0,unknownEventRatio:0,badJsonLines:0},
    projects:[{projectHash:'0123456789abcdef',...summary}], overall:summary, ...extra };
}

test('account, evidence, visibility and recovery lifecycle is durable and private by default', () => {
  const dir = mkdtempSync(join(tmpdir(),'vibescore-store-'));
  const prior = process.env.VIBESCORE_DATA_DIR;
  process.env.VIBESCORE_DATA_DIR = dir;
  closeDatabase();
  try {
    const created = registerUser('builder_1','correct horse battery');
    assert.ok(created?.token); assert.ok(created?.recoveryCode);
    assert.equal(created.isPublic,false);
    assert.equal(userByToken(created.token,'api')?.handle,'builder_1');
    assert.equal(credentialByToken(created.token)?.kind,'api');
    assert.equal(userByToken(created.token,'session'),undefined);
    assert.equal(userByToken(created.token,'api')?.handle,'builder_1');
    assert.equal(loginUser('builder_1','wrong password'),null);
    const session=loginUser('builder_1','correct horse battery')!;
    assert.equal(session.handle,'builder_1');
    assert.equal(credentialByToken(session.token)?.kind,'session');
    assert.equal(userByToken(session.token,'api'),undefined);
    assert.equal(userByToken(session.token,'session')?.handle,'builder_1');
    const other=registerUser('other_builder','another good password')!;
    const rotated=rotateToken('builder_1');
    assert.equal(userByToken(created.token,'api'),undefined);
    assert.equal(userByToken(rotated,'api')?.handle,'builder_1');
    revokeApiTokens('builder_1');
    assert.equal(userByToken(rotated,'api'),undefined);
    assert.equal(userByToken(session.token,'session')?.handle,'builder_1','API revocation preserves sessions');
    assert.equal(userByToken(other.token,'api')?.handle,'other_builder','API revocation is scoped to the owner');
    const stored = getDatabase().prepare('SELECT hash FROM credentials').all() as {hash:string}[];
    assert.equal(stored.some(x=>x.hash===created.token),false,'raw token must not be stored');
    saveBundle('builder_1',bundle() as any);
    saveBundle('builder_1',bundle() as any);
    assert.equal(scoreHistory('builder_1').length,1,'duplicate evidence is idempotent');
    assert.equal(loadPublicPopulation().length,0);
    setVisibility('builder_1',true);
    assert.equal(loadPublicPopulation().length,1);
    const recovered = recoverAccount('builder_1',created.recoveryCode,'a newer safe password');
    assert.ok(recovered?.token);
    assert.equal(userByToken(created.token,'api'),undefined,'recovery revokes earlier credentials');
    assert.equal(loginUser('builder_1','a newer safe password')?.handle,'builder_1');
    assert.equal(deleteUser('builder_1'),true);
    assert.equal(getUser('builder_1'),undefined);
    assert.equal(Number((getDatabase().prepare('SELECT count(*) AS n FROM bundles').get() as any).n),0);
  } finally {
    closeDatabase();
    prior === undefined ? delete process.env.VIBESCORE_DATA_DIR : process.env.VIBESCORE_DATA_DIR = prior;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('passwordless CLI registration can establish web access only with its recovery code', () => {
  const dir = mkdtempSync(join(tmpdir(),'vibescore-cli-'));
  const prior = process.env.VIBESCORE_DATA_DIR;
  process.env.VIBESCORE_DATA_DIR = dir; closeDatabase();
  try {
    const created=registerUser('cli_user'); assert.ok(created);
    assert.equal(loginUser('cli_user','any password here'),null);
    assert.equal(recoverAccount('cli_user','bad-code','a proper new password'),null);
    assert.ok(recoverAccount('cli_user',created!.recoveryCode,'a proper new password'));
    assert.ok(loginUser('cli_user','a proper new password'));
  } finally {
    closeDatabase(); prior===undefined?delete process.env.VIBESCORE_DATA_DIR:process.env.VIBESCORE_DATA_DIR=prior;
    rmSync(dir,{recursive:true,force:true});
  }
});
