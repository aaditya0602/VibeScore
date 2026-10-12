import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendCareerPath } from '../src/navigator.ts';

const env=['AI_PROVIDER','AI_API_KEY','AI_MODEL','DATABRICKS_HOST','DATABRICKS_TOKEN','DATABRICKS_WAREHOUSE_ID','DATABRICKS_CATALOG','DATABRICKS_SCHEMA','DATABRICKS_RESOURCES_TABLE'] as const;
const original=Object.fromEntries(env.map(x=>[x,process.env[x]]));
test.afterEach(()=>{for(const x of env)original[x]===undefined?delete process.env[x]:process.env[x]=original[x];});

test('navigator remains useful and honest without sponsor services',async()=>{
  for(const x of env)delete process.env[x];
  const result=await recommendCareerPath({goal:'Prepare for an AI-assisted software engineering interview',skill:'verification'});
  assert.equal(result.recommendedDrill.id,'verify-pagination');assert.equal(result.guidance.generatedBy,'rules');
  assert.equal(result.dataSource.enabled,false);assert.equal(result.dataSource.available,true);assert.equal(result.dataSource.source,'Bundled Virginia Tech sources');assert.ok(result.careerResources.length>0);
  assert.match(result.disclaimer,/not hiring/);
});

test('navigator labels retrieved Databricks facts and Gemini guidance',async()=>{
  Object.assign(process.env,{AI_PROVIDER:'gemini',AI_API_KEY:'test',AI_MODEL:'gemini-3.8-flash',DATABRICKS_HOST:'adb-1.2.azuredatabricks.net',DATABRICKS_TOKEN:'test',DATABRICKS_WAREHOUSE_ID:'warehouse',DATABRICKS_CATALOG:'vibescore',DATABRICKS_SCHEMA:'hokie',DATABRICKS_RESOURCES_TABLE:'campus_resources'});
  const resource={resourceId:'career',name:'Career Center',description:'Interview support',url:'https://career.vt.edu/',audience:['students'],skillTags:['verification'],careerTags:['interview'],source:'Virginia Tech',lastVerifiedAt:'2026-09-01T00:00:00.000Z'};
  let resourceQuery:any;
  const result=await recommendCareerPath({goal:'Prepare for an AI-assisted software engineering interview',skill:'verification'},{
    resources:async input=>{resourceQuery=input;return {resources:[resource],source:'Databricks Unity Catalog',retrievedAt:'2026-09-19T00:00:00.000Z',freshness:{newestLastVerifiedAt:resource.lastVerifiedAt,oldestLastVerifiedAt:resource.lastVerifiedAt}};},
    assistant:async()=>({text:'Use the Career Center resource, then practise boundary tests.',provider:'gemini',model:'gemini-3.8-flash',tokens:20}),
  });
  assert.equal(result.guidance.generatedBy,'gemini');assert.equal(result.guidance.model,'gemini-3.8-flash');
  assert.equal(result.dataSource.source,'Databricks Unity Catalog');assert.equal(result.careerResources[0].source,'Virginia Tech');
  assert.equal(result.dataSource.available,true);
  assert.deepEqual(resourceQuery,{skill:'verification',query:'interview',limit:3});
});

test('navigator keeps its practice path when the configured warehouse is unavailable',async()=>{
  Object.assign(process.env,{DATABRICKS_HOST:'adb-1.2.azuredatabricks.net',DATABRICKS_TOKEN:'test',DATABRICKS_WAREHOUSE_ID:'warehouse',DATABRICKS_CATALOG:'vibescore',DATABRICKS_SCHEMA:'hokie',DATABRICKS_RESOURCES_TABLE:'campus_resources'});
  const result=await recommendCareerPath({goal:'Prepare for an AI-assisted software engineering interview',skill:'verification'},{resources:async()=>{throw new Error('sensitive upstream error');}});
  assert.equal(result.recommendedDrill.id,'verify-pagination');assert.equal(result.guidance.generatedBy,'rules');
  assert.equal(result.dataSource.enabled,true);assert.equal(result.dataSource.available,true);assert.equal(result.dataSource.source,'Bundled Virginia Tech sources');
  assert.match(result.dataSource.message??'',/temporarily unavailable/);assert.ok(result.careerResources.length>0);assert.doesNotMatch(JSON.stringify(result),/sensitive upstream/);
});

test('navigator validates all public input',async()=>{
  await assert.rejects(recommendCareerPath({goal:'short',skill:'verification'}),/10 to 500/);
  await assert.rejects(recommendCareerPath({goal:'A valid career preparation goal',skill:'security'}),/valid VibeScore skill/);
});
