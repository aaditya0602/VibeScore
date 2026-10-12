import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { aiStatus, askAssistant } from '../src/providers.ts';

const KEYS=['AI_PROVIDER','AI_API_KEY','AI_MODEL','AI_ENDPOINT','AI_MAX_OUTPUT_TOKENS'] as const;
const saved=Object.fromEntries(KEYS.map(key=>[key,process.env[key]]));
const realFetch=globalThis.fetch;

afterEach(()=>{
  for(const key of KEYS)saved[key]===undefined?delete process.env[key]:process.env[key]=saved[key];
  globalThis.fetch=realFetch;
});

function captureFetch(){
  const calls:Array<{url:string;init:any;body:any}>=[];
  globalThis.fetch=(async(url:string|URL|Request,init:any)=>{
    calls.push({url:String(url),init,body:JSON.parse(init.body)});
    return new Response(JSON.stringify({choices:[{message:{content:'hint'}}],usage:{total_tokens:7}}),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  return calls;
}

test('providers: gemini is the default provider',()=>{
  delete process.env.AI_PROVIDER;
  assert.equal(aiStatus().provider,'gemini');
});

test('providers: gemini uses the documented compatibility request without exposing its key',async()=>{
  Object.assign(process.env,{AI_PROVIDER:'gemini',AI_API_KEY:'private-test-key',AI_MODEL:'gemini-3.8-flash',AI_MAX_OUTPUT_TOKENS:'700'});
  const calls=captureFetch(),out=await askAssistant([{role:'user',content:'hi'}]);
  assert.equal(out.text,'hint');assert.equal(out.tokens,7);assert.doesNotMatch(JSON.stringify(out),/private-test-key/);
  assert.equal(calls[0].url,'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.headers.authorization,'Bearer private-test-key');
  assert.equal(calls[0].body.reasoning_effort,'low');assert.equal(calls[0].body.max_tokens,700);
});

test('providers: openai requires an HTTPS endpoint and uses bearer auth',async()=>{
  Object.assign(process.env,{AI_PROVIDER:'openai',AI_API_KEY:'k2',AI_MODEL:'m'});delete process.env.AI_ENDPOINT;
  assert.equal(aiStatus().enabled,false);
  process.env.AI_ENDPOINT='https://llm.example.com/v1/chat/completions';assert.equal(aiStatus().enabled,true);
  const calls=captureFetch();await askAssistant([{role:'user',content:'hi'}]);
  assert.equal(calls[0].url,process.env.AI_ENDPOINT);assert.equal(calls[0].init.headers.authorization,'Bearer k2');assert.equal(calls[0].init.headers['api-key'],undefined);
  process.env.AI_ENDPOINT='http://llm.example.com/v1/chat/completions';
  await assert.rejects(()=>askAssistant([{role:'user',content:'hi'}]),/invalid/);
});

test('providers: azure keeps its api-key header',async()=>{
  Object.assign(process.env,{AI_PROVIDER:'azure',AI_API_KEY:'k3',AI_MODEL:'m',AI_ENDPOINT:'https://res.openai.azure.com/openai/deployments/d/chat/completions'});
  const calls=captureFetch();await askAssistant([{role:'user',content:'hi'}]);
  assert.equal(calls[0].init.headers['api-key'],'k3');assert.equal(calls[0].init.headers.authorization,undefined);
});

test('providers: Foundry v1 uses the deployment name as its model',async()=>{
  Object.assign(process.env,{AI_PROVIDER:'foundry',AI_API_KEY:'foundry-key',AI_MODEL:'gpt-4.1-mini',AI_ENDPOINT:'https://foundry-demo-ms.openai.azure.com/openai/v1/chat/completions'});
  const calls=captureFetch();await askAssistant([{role:'user',content:'hi'}]);
  assert.equal(aiStatus().enabled,true);
  assert.equal(calls[0].url,process.env.AI_ENDPOINT);
  assert.equal(calls[0].init.headers['api-key'],'foundry-key');
  assert.equal(calls[0].init.headers.authorization,undefined);
  assert.equal(calls[0].body.model,'gpt-4.1-mini');
});

test('providers: failures remain truthful and bounded',async()=>{
  Object.assign(process.env,{AI_PROVIDER:'gemini',AI_API_KEY:'private-test-key',AI_MODEL:'gemini-3.8-flash'});
  globalThis.fetch=(async()=>new Response('{}',{status:429,headers:{'content-type':'application/json'}})) as typeof fetch;
  await assert.rejects(()=>askAssistant([{role:'user',content:'hello'}]),/usage limit/);
  globalThis.fetch=(async()=>new Response('x'.repeat(257_000),{headers:{'content-type':'application/json'}})) as typeof fetch;
  await assert.rejects(()=>askAssistant([{role:'user',content:'hello'}]),/oversized/);
});
