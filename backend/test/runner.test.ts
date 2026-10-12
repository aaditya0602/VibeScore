import test from 'node:test';
import assert from 'node:assert/strict';
import { runCode } from '../src/runner.ts';

test('runner evaluates visible and hidden cases without leaking hidden values', async () => {
  const results=await runCode('function solve(a,b){ return a+b }',[
    {id:'visible',args:[2,3],expected:5},
    {id:'hidden',args:[9,8],expected:17,hidden:true},
  ]);
  assert.deepEqual(results.map(x=>x.passed),[true,true]);
  assert.equal(results[0].actual,5);
  assert.equal('actual' in results[1],false);
});

test('runner does not expose Node process or network APIs', async () => {
  const [result]=await runCode('function solve(){ return typeof process+":"+typeof fetch+":"+typeof require }',[
    {id:'sandbox',args:[],expected:'undefined:undefined:undefined'},
  ]);
  assert.equal(result.passed,true);
});

test('runner interrupts non-terminating code', async () => {
  const [result]=await runCode('function solve(){ while(true){} }',[{id:'loop',args:[],expected:null}]);
  assert.equal(result.passed,false);
  assert.match(result.error??'',/resource limit|threw/i);
});

test('runner rejects solutions that mutate input even when the returned value is correct', async () => {
  const [result]=await runCode('function solve(input){ input.changed=true; return input.value }',[{id:'mutation',input:{value:3},expected:3}]);
  assert.equal(result.passed,false);
  assert.match(result.error??'',/mutat/i);
});
