import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { aiStatus, askAssistant } from '../src/providers.ts';

const names=['AI_PROVIDER','AI_API_KEY','AI_MODEL','AI_ENDPOINT','AI_MAX_OUTPUT_TOKENS'] as const;
const original=Object.fromEntries(names.map(name=>[name,process.env[name]]));
function restore(){for(const name of names)original[name]===undefined?delete process.env[name]:process.env[name]=original[name];mock.restoreAll();}

test('Gemini adapter uses the documented compatibility request without exposing its key', async t => {
  t.after(restore);process.env.AI_PROVIDER='gemini';process.env.AI_API_KEY='private-test-key';process.env.AI_MODEL='gemini-3.8-flash';process.env.AI_MAX_OUTPUT_TOKENS='700';
  let request:any;
  mock.method(globalThis,'fetch',async (url:any,init:any)=>{request={url:String(url),init};return new Response(JSON.stringify({choices:[{message:{content:'Start by clarifying the empty-input behavior.'}}],usage:{total_tokens:42}}),{headers:{'content-type':'application/json'}});});
  const result=await askAssistant([{role:'user',content:'Help me reason.'}]);
  assert.equal(result.provider,'gemini');assert.equal(result.model,'gemini-3.8-flash');assert.equal(result.tokens,42);
  assert.equal(request.url,'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(request.init.redirect,'error');assert.equal(request.init.headers.authorization,'Bearer private-test-key');
  const payload=JSON.parse(request.init.body);assert.equal(payload.reasoning_effort,'low');assert.equal(payload.max_tokens,700);
  assert.doesNotMatch(JSON.stringify(result),/private-test-key/);
});

test('AI status and provider failures remain truthful and bounded', async t => {
  t.after(restore);delete process.env.AI_API_KEY;process.env.AI_PROVIDER='gemini';process.env.AI_MODEL='gemini-3.8-flash';
  assert.equal(aiStatus().enabled,false);
  process.env.AI_API_KEY='private-test-key';
  mock.method(globalThis,'fetch',async()=>new Response('{}',{status:429,headers:{'content-type':'application/json'}}));
  await assert.rejects(askAssistant([{role:'user',content:'hello'}]),/usage limit/);
  mock.restoreAll();
  mock.method(globalThis,'fetch',async()=>new Response('x'.repeat(257_000),{headers:{'content-type':'application/json'}}));
  await assert.rejects(askAssistant([{role:'user',content:'hello'}]),/oversized/);
});
