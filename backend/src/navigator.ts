import { aiStatus, askAssistant } from './providers.ts';
import { databricksStatus, queryCampusResources, type CampusResourceResult, type VibeScoreSkill } from './databricks.ts';

const SKILLS=new Set<VibeScoreSkill>(['framing','context','debugging','verification','review','efficiency']);
const DRILLS:Record<VibeScoreSkill,{id:string;title:string}>={
  framing:{id:'frame-expense-tracker',title:'Turn an idea into a build brief'},
  context:{id:'context-select-evidence',title:'Build a useful context packet'},
  debugging:{id:'debug-retry-loop',title:'Stop an unproductive fix loop'},
  verification:{id:'verify-pagination',title:'Test what the demo missed'},
  review:{id:'review-ai-patch',title:'Review a patch that weakens a test'},
  efficiency:{id:'efficiency-context-budget',title:'Spend context where it helps'},
};
type Dependencies={resources?:typeof queryCampusResources;assistant?:typeof askAssistant};
const FALLBACK_RESOURCES=[
  {resourceId:'vt-career-interviews',name:'Prepare for an Interview',description:'Virginia Tech guidance and practice options for interviews, including mock interview tools.',url:'https://career.vt.edu/channels/prepare-for-an-interview/',audience:['Virginia Tech students'],skillTags:['framing','context','verification'],careerTags:['interview','internship'],source:'Virginia Tech Career and Professional Development',lastVerifiedAt:'2026-09-19T00:00:00.000Z'},
  {resourceId:'vt-career-topics',name:'Career Resources by Topic',description:'Career readiness lessons and materials covering resumes, professional stories, and interview preparation.',url:'https://career.vt.edu/resources/resources-by-career-topic/',audience:['Virginia Tech students','recent alumni'],skillTags:['framing','context','review'],careerTags:['resume','portfolio','career'],source:'Virginia Tech Career and Professional Development',lastVerifiedAt:'2026-09-19T00:00:00.000Z'},
  {resourceId:'vt-ai-guidance',name:'Considering Generative AI at Virginia Tech',description:'Current Virginia Tech guidance and learning resources for informed, responsible use of generative AI.',url:'https://tlos.vt.edu/resources/generative-ai.html',audience:['Virginia Tech community'],skillTags:['debugging','verification','review','efficiency'],careerTags:['AI literacy','responsible AI'],source:'Virginia Tech TLOS',lastVerifiedAt:'2026-09-19T00:00:00.000Z'},
] satisfies Array<import('./databricks.ts').CampusResource>;

export async function recommendCareerPath(input:unknown,deps:Dependencies={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Navigator request is invalid.');
  const raw=input as any,goal=typeof raw.goal==='string'?raw.goal.trim():'',skill=raw.skill as VibeScoreSkill;
  if(goal.length<10||goal.length>500)throw new Error('Describe a goal in 10 to 500 characters.');
  if(!SKILLS.has(skill))throw new Error('Choose a valid VibeScore skill.');
  const drill=DRILLS[skill],db=databricksStatus();
  let retrieved:CampusResourceResult|null=null;
  let resourceError:string|null=null;
  const careerQuery=['interview','portfolio','internship','research','resume','career'].find(term=>goal.toLowerCase().includes(term))??'';
  if(db.enabled){
    try{retrieved=await (deps.resources??queryCampusResources)({skill,query:careerQuery,limit:3});}
    catch{resourceError='Live campus resources are temporarily unavailable. Your VibeScore practice recommendation is still ready.';}
  }
  const liveResources=retrieved?.resources??[];
  const resources=liveResources.length?liveResources:FALLBACK_RESOURCES.filter(resource=>resource.skillTags.includes(skill)).slice(0,3);
  const fallbackUsed=!liveResources.length;
  let guidance=`Start with “${drill.title},” then use the sourced resources below to connect that skill to your goal.`;
  let generatedBy:'rules'|'gemini'='rules',model:string|null=null;
  if(aiStatus().enabled&&resources.length){
    try{
      const result=await (deps.assistant??askAssistant)([
        {role:'system',content:'You are the VibeScore Hokie Career Navigator. Give concise career-readiness guidance grounded only in the supplied resources. Distinguish sourced facts from advice. Do not invent programs, deadlines, or endorsements.'},
        {role:'user',content:JSON.stringify({goal,skill,recommendedDrill:drill,resources:resources.map(x=>({name:x.name,description:x.description,url:x.url,source:x.source,lastVerifiedAt:x.lastVerifiedAt}))})},
      ]);
      guidance=result.text;generatedBy='gemini';model=result.model;
    }catch{/* Deterministic guidance keeps the no-account path available. */}
  }
  return {skillGap:skill,recommendedDrill:{...drill,path:`/challenge/${drill.id}`},guidance:{text:guidance,generatedBy,model},careerResources:resources,dataSource:{enabled:db.enabled,available:Boolean(resources.length),source:fallbackUsed?'Bundled Virginia Tech sources':db.source,retrievedAt:retrieved?.retrievedAt??null,freshness:retrieved?.freshness??null,message:fallbackUsed?(resourceError??'Using a small bundled set of verified Virginia Tech resources while the live catalog is unavailable.'):null},disclaimer:'Resources are retrieved or linked from identified sources; guidance is educational and is not hiring or academic advice.'};
}
