import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, requestAddress } from '../src/rate-limit.ts';

test('rate limiter enforces windows and bounds attacker-controlled keys',()=>{
  const limiter=new RateLimiter(10);
  assert.equal(limiter.allow('same',2,1_000,0),true);
  assert.equal(limiter.allow('same',2,1_000,10),true);
  assert.equal(limiter.allow('same',2,1_000,20),false);
  assert.equal(limiter.allow('same',2,1_000,1_001),true);
  for(let i=0;i<30;i++)limiter.allow(`key-${i}`,1,60_000,2_000);
  assert.ok(limiter.size<=10);
});

test('forwarded addresses are used only behind the configured proxy',()=>{
  const req={headers:{'x-forwarded-for':'203.0.113.4, bad-value'},socket:{remoteAddress:'10.0.0.5'}} as any;
  assert.equal(requestAddress(req,false),'10.0.0.5');
  assert.equal(requestAddress(req,true),'203.0.113.4');
});
