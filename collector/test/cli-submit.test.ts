import test from 'node:test';
import assert from 'node:assert/strict';
import { submitServer, submissionResponse } from '../src/cli.ts';

test('CLI submission permits HTTPS and loopback only', () => {
  assert.equal(submitServer('https://vibescore.example/'),'https://vibescore.example');
  assert.equal(submitServer('http://127.0.0.1:8787/'),'http://127.0.0.1:8787');
  assert.throws(()=>submitServer('http://vibescore.example'),/HTTPS/);
  assert.throws(()=>submitServer('https://user:secret@vibescore.example'),/must not contain credentials/);
});

test('CLI submission accepts only bounded validated score responses', async () => {
  const valid={score:{handle:'builder_1',rating:1500,rd:160,tier:'provisional',subscores:{efficiency:50,direction:50,craft:50,shipping:50}}};
  assert.equal((await submissionResponse(new Response(JSON.stringify(valid),{headers:{'content-type':'application/json'}}))).score.handle,'builder_1');
  await assert.rejects(submissionResponse(new Response('<html>no</html>',{headers:{'content-type':'text/html'}})),/non-JSON/);
  await assert.rejects(submissionResponse(new Response(JSON.stringify({score:{handle:'builder_1'}}),{headers:{'content-type':'application/json'}})),/invalid score/);
  await assert.rejects(submissionResponse(new Response('x'.repeat(65_000),{headers:{'content-type':'application/json'}})),/exceeds 64 KB/);
});
