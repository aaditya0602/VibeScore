#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  deleteUser, getUser, loadPublicPopulation, loginUser, parseBundle, recoverAccount,
  registerUser, revokeToken, saveBundle, scoreHistory, setVisibility, userByToken, validHandle, validPassword,
  ValidationError,
} from './store.ts';
import { scorePopulation, ALGO_VERSION } from './scoring.ts';
import { addMessage, attemptsFor, challengeSummary, claimAiUsage, clearPlatformUser, createAttempt,
  finishAttempt, getAttempt, messagesFor, publicChallengeLeaderboard, recordRun, saveDraft, saveFeedback } from './platform-store.ts';
import { getPrivateInterview, getPublicChallenge, listChallenges } from './challenges.ts';
import { assessDrill, gradeInterview } from './assessment.ts';
import { runCode } from './runner.ts';
import { aiStatus, askAssistant } from './providers.ts';
import { ansStatus, getAnsAgentTrust, searchAnsAgents } from './ans.ts';
import { databricksStatus, findCareerResources, type NavigatorSkill } from './databricks.ts';

const PUBLIC_DIR=resolve(fileURLToPath(new URL('../public/',import.meta.url)));
const MIME:Record<string,string>={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const COOKIE='vibescore_session';
const REQUESTS=new Map<string,{start:number;count:number}>();
const PUBLIC_ORIGIN=(process.env.PUBLIC_ORIGIN??'').replace(/\/$/,'');
class HttpError extends Error { status:number; constructor(status:number,message:string){super(message);this.status=status;} }

function securityHeaders(contentType?:string){return {'content-type':contentType??'application/json; charset=utf-8','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'strict-origin-when-cross-origin','permissions-policy':'camera=(), microphone=(), geolocation=()','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"};}
function json(res:ServerResponse,status:number,value:unknown,headers:Record<string,string>={}){const data=JSON.stringify(value);res.writeHead(status,{...securityHeaders(),...headers,'content-length':String(Buffer.byteLength(data))});res.end(data);}
async function body(req:IncomingMessage,max=512_000){let size=0;const chunks:Buffer[]=[];for await(const value of req){const chunk=Buffer.from(value);size+=chunk.length;if(size>max)throw new HttpError(413,'Request is too large.');chunks.push(chunk);}try{return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}catch{throw new HttpError(400,'Request body must be valid JSON.');}}
function cookies(req:IncomingMessage){return Object.fromEntries(String(req.headers.cookie??'').split(';').map(x=>x.trim().split(/=(.*)/s).slice(0,2)).filter(x=>x[0]).map(([k,v])=>[k,decodeURIComponent(v??'')]));}
function token(req:IncomingMessage){const auth=String(req.headers.authorization??'');return String(req.headers['x-token']??(auth.startsWith('Bearer ')?auth.slice(7):cookies(req)[COOKIE]??''));}
function requireUser(req:IncomingMessage){const raw=token(req),user=userByToken(raw);if(!user)throw new HttpError(401,'Sign in to continue.');return {user,token:raw};}
function sessionCookie(value:string,maxAge=7*86400){return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PUBLIC_ORIGIN.startsWith('https://')?'; Secure':''}`;}
function assertOrigin(req:IncomingMessage){const origin=String(req.headers.origin??'');if(!origin)return;if(PUBLIC_ORIGIN&&origin!==PUBLIC_ORIGIN)throw new HttpError(403,'Origin is not allowed.');const host=String(req.headers.host??'');if(!PUBLIC_ORIGIN&&new URL(origin).host!==host)throw new HttpError(403,'Origin is not allowed.');}
function rate(req:IncomingMessage,bucket:string,limit:number,windowMs:number){const forwarded=process.env.TRUST_PROXY==='1'?String(req.headers['x-forwarded-for']??'').split(',')[0].trim():'';const key=`${bucket}:${forwarded||req.socket.remoteAddress||'unknown'}`,now=Date.now(),current=REQUESTS.get(key);if(!current||now-current.start>=windowMs){REQUESTS.set(key,{start:now,count:1});return;}if(++current.count>limit)throw new HttpError(429,'Too many requests. Try again shortly.');}
function text(value:unknown,max:number,name:string){if(typeof value!=='string'||value.length>max)throw new HttpError(400,`${name} is invalid.`);return value;}
function workflowEntries(){const population=loadPublicPopulation();return scorePopulation(population).map((score,i)=>({handle:score.handle,rating:score.rating,rd:score.rd,tier:score.tier,subscores:score.subscores,episodes:population[i].bundle.overall.episodes,agent:population[i].bundle.agent,generatedAt:population[i].bundle.generatedAt})).sort((a,b)=>b.rating-a.rating);}
function publicProfile(handle:string){const user=getUser(handle);if(!user?.isPublic)return null;return {handle,userSince:user.createdAt,workflow:workflowEntries().find(x=>x.handle===handle)??null,challenge:challengeSummary(handle)};}

async function api(req:IncomingMessage,res:ServerResponse,url:URL){
  const path=url.pathname,method=req.method??'GET';
  if(method!=='GET'&&method!=='HEAD')assertOrigin(req);
  if(method==='GET'&&path==='/api/status')return json(res,200,{ok:true,version:'0.2.0',algoVersion:ALGO_VERSION,ai:aiStatus(),ans:ansStatus(),databricks:databricksStatus()});
  if(method==='GET'&&path==='/api/ans/status')return json(res,200,ansStatus());
  if(method==='GET'&&path==='/api/databricks/status')return json(res,200,databricksStatus());
  if(method==='GET'&&path==='/api/ans/search'){
    rate(req,'ans-search',12,10*60_000);const query=url.searchParams.get('q')??'';
    if(query.trim().length<2||query.length>128)throw new HttpError(400,'Enter a search between 2 and 128 characters.');
    try{return json(res,200,await searchAnsAgents({query,pageSize:8}));}catch(error){throw new HttpError(503,(error as Error).message);}
  }
  const ansDetail=path.match(/^\/api\/ans\/agents\/([^/]+)$/);
  if(method==='GET'&&ansDetail){rate(req,'ans-detail',20,10*60_000);try{return json(res,200,await getAnsAgentTrust(decodeURIComponent(ansDetail[1])));}catch(error){throw new HttpError(503,(error as Error).message);}}
  if(method==='POST'&&path==='/api/navigator/recommend'){
    rate(req,'navigator',10,10*60_000);const input=await body(req,16_000),goal=text(input.goal,280,'goal').trim(),skill=text(input.skill,20,'skill') as NavigatorSkill;
    if(goal.length<3)throw new HttpError(400,'Describe a career goal in at least 3 characters.');
    if(!['framing','context','debugging','verification','review','efficiency'].includes(skill))throw new HttpError(400,'Choose a valid VibeScore skill focus.');
    let result;try{result=await findCareerResources({goal,skill});}catch(error){throw new HttpError(503,(error as Error).message);}
    const challenges=listChallenges(),practice=challenges.find(c=>c.kind==='drill'&&c.skill===skill)??null,interview=challenges.find(c=>c.kind==='interview'&&c.skill===skill)??null;
    const query=`${skill} career`,status=ansStatus();let agents:any[]=[];let ansUnavailable=false;
    if(status.enabled){try{agents=(await searchAnsAgents({query,pageSize:3})).agents;}catch{ansUnavailable=true;}}
    return json(res,200,{goal,focusSkill:skill,practice:practice?{id:practice.id,title:practice.title,summary:practice.summary}:null,interview:interview?{id:interview.id,title:interview.title,summary:interview.summary}:null,resources:result.resources,provenance:{source:result.source,queriedAt:result.queriedAt},ans:{enabled:status.enabled,unavailable:ansUnavailable,query,agents,disclaimer:'Registry-reported identity signals; not a safety or quality guarantee.'}});
  }
  if(method==='POST'&&path==='/api/register'){
    rate(req,'auth',12,15*60_000);const input=await body(req);if(!validHandle(input.handle))throw new HttpError(400,'Use 2–24 lowercase letters, numbers, underscores, or hyphens.');if(input.password!==undefined&&!validPassword(input.password))throw new HttpError(400,'Password must contain 10–128 characters.');const created=registerUser(input.handle,input.password);if(!created)throw new HttpError(409,'That handle is already taken.');
    if(input.password===undefined)return json(res,201,{handle:created.handle,token:created.token,recoveryCode:created.recoveryCode,notice:'Save both secrets. They are shown once.'});
    const signed=loginUser(input.handle,input.password)!;revokeToken(created.token);return json(res,201,{user:{handle:signed.handle,createdAt:signed.createdAt,isPublic:signed.isPublic},recoveryCode:created.recoveryCode,notice:'Save your recovery code. It is shown once.'},{'set-cookie':sessionCookie(signed.token)});
  }
  if(method==='POST'&&path==='/api/login'){rate(req,'auth',12,15*60_000);const input=await body(req);const signed=loginUser(text(input.handle,24,'handle'),text(input.password,128,'password'));if(!signed)throw new HttpError(401,'Handle or password is incorrect.');return json(res,200,{user:{handle:signed.handle,createdAt:signed.createdAt,isPublic:signed.isPublic}},{'set-cookie':sessionCookie(signed.token)});}
  if(method==='POST'&&path==='/api/logout'){const current=token(req);if(current)revokeToken(current);return json(res,200,{ok:true},{'set-cookie':sessionCookie('',0)});}
  if(method==='POST'&&path==='/api/recover'){rate(req,'auth',8,30*60_000);const input=await body(req);const recovered=recoverAccount(text(input.handle,24,'handle'),text(input.recoveryCode,256,'recovery code'),text(input.newPassword,128,'password'));if(!recovered)throw new HttpError(400,'Recovery details are invalid.');return json(res,200,{recoveryCode:recovered.recoveryCode,notice:'Save this replacement recovery code. It is shown once.'},{'set-cookie':sessionCookie(recovered.token)});}
  if(method==='GET'&&path==='/api/me'){const {user}=requireUser(req);return json(res,200,{user,summary:challengeSummary(user.handle),attempts:attemptsFor(user.handle).map(a=>({...a,answer:undefined,code:undefined,reflection:undefined}))});}
  if(method==='PATCH'&&path==='/api/me'){const {user}=requireUser(req),input=await body(req);if(typeof input.isPublic!=='boolean')throw new HttpError(400,'isPublic must be true or false.');return json(res,200,{user:setVisibility(user.handle,input.isPublic)});}
  if(method==='DELETE'&&path==='/api/me'){const {user}=requireUser(req),input=await body(req);if(input.confirmHandle!==user.handle)throw new HttpError(400,'Type your exact handle to delete the account.');clearPlatformUser(user.handle);deleteUser(user.handle);return json(res,200,{deleted:true},{'set-cookie':sessionCookie('',0)});}
  if(method==='GET'&&path==='/api/challenges'){const kind=url.searchParams.get('kind');if(kind&&kind!=='drill'&&kind!=='interview')throw new HttpError(400,'Unknown challenge kind.');return json(res,200,{challenges:listChallenges(kind as any||undefined)});}
  if(method==='GET'&&path.startsWith('/api/challenges/')){const challenge=getPublicChallenge(decodeURIComponent(path.slice(16)));if(!challenge)throw new HttpError(404,'Challenge not found.');return json(res,200,{challenge});}
  const start=path.match(/^\/api\/challenges\/([^/]+)\/start$/);
  if(method==='POST'&&start){const {user}=requireUser(req),challenge=getPublicChallenge(decodeURIComponent(start[1]));if(!challenge)throw new HttpError(404,'Challenge not found.');const input=await body(req);if(input.mode!=='practice'&&input.mode!=='rated')throw new HttpError(400,'Choose practice or rated mode.');return json(res,201,{attempt:createAttempt(user.handle,challenge,input.mode)});}
  const match=path.match(/^\/api\/attempts\/([^/]+)(?:\/(run|submit|chat))?$/);
  if(match){const {user}=requireUser(req),attempt=getAttempt(match[1],user.handle);if(!attempt)throw new HttpError(404,'Attempt not found.');const action=match[2];
    if(method==='GET'&&!action)return json(res,200,{attempt,challenge:getPublicChallenge(attempt.challengeId),messages:messagesFor(attempt.id)});
    if(method==='PATCH'&&!action){if(attempt.status!=='active')throw new HttpError(409,'This attempt is already finished.');const input=await body(req);saveDraft(attempt,{answer:input.answer===undefined?undefined:text(input.answer,20_000,'answer'),code:input.code===undefined?undefined:text(input.code,40_000,'code'),reflection:input.reflection===undefined?undefined:text(input.reflection,8_000,'reflection')});return json(res,200,{attempt:getAttempt(attempt.id,user.handle)});}
    if(method==='POST'&&action==='run'){if(attempt.kind!=='interview'||attempt.status!=='active')throw new HttpError(409,'Only active interviews can run code.');rate(req,`run:${user.handle}`,30,10*60_000);const input=await body(req),code=text(input.code??attempt.code,40_000,'code'),challenge=getPrivateInterview(attempt.challengeId)!;saveDraft(attempt,{code});recordRun(attempt.id);const visible=challenge.tests.filter(t=>!t.hidden);const results=await runCode(code,visible.map(t=>({id:t.id,input:t.input,expected:t.expected,hidden:false,label:t.label})));return json(res,200,{results});}
    if(method==='POST'&&action==='submit'){if(attempt.status!=='active')throw new HttpError(409,'This attempt is already finished.');if(attempt.mode==='rated'&&Date.now()>Date.parse(attempt.deadline))throw new HttpError(409,'The rated attempt time has expired.');const input=await body(req);
      if(attempt.kind==='drill'){const answer=text(input.answer??attempt.answer,20_000,'answer');saveDraft(attempt,{answer});const result=assessDrill(attempt.challengeId,answer);if(!result)throw new HttpError(404,'Challenge not found.');finishAttempt(attempt,result);return json(res,200,{result,attempt:getAttempt(attempt.id,user.handle)});}
      const code=text(input.code??attempt.code,40_000,'code'),reflection=text(input.reflection??attempt.reflection??'',8_000,'reflection');saveDraft(attempt,{code,reflection});const challenge=getPrivateInterview(attempt.challengeId)!;recordRun(attempt.id);const executed=await runCode(code,challenge.tests.map(t=>({id:t.id,input:t.input,expected:t.expected,hidden:t.hidden,label:t.label})));const grade=gradeInterview(attempt.challengeId,executed.map(x=>({testId:x.id,passed:x.passed})))!;const result={...grade,totalScore:Math.round(100*grade.score/Math.max(1,grade.maxScore)),reflectionProvided:Boolean(reflection.trim())};finishAttempt(attempt,result);return json(res,200,{result:getAttempt(attempt.id,user.handle)?.result});}
    if(method==='POST'&&action==='chat'){if(attempt.status!=='active')throw new HttpError(409,'This attempt is already finished.');rate(req,`ai:${user.handle}`,12,10*60_000);if(!claimAiUsage(user.handle))throw new HttpError(429,'Daily AI coaching limit reached.');const input=await body(req),message=text(input.message,4_000,'message').trim();if(!message)throw new HttpError(400,'Write a message first.');const challenge=getPublicChallenge(attempt.challengeId)!;addMessage(attempt.id,'user',message);const history=messagesFor(attempt.id).slice(-10);const system=`You are the VibeScore interview coach. Help the candidate reason, clarify requirements, debug, and verify. Do not provide a complete solution or hidden tests. Be concise. Challenge: ${JSON.stringify(challenge)} Current code: ${attempt.code.slice(0,12000)}`;let answer;try{answer=await askAssistant([{role:'system',content:system},...history]);}catch(error){throw new HttpError(503,(error as Error).message);}addMessage(attempt.id,'assistant',answer.text);return json(res,200,{message:answer.text,provider:answer.provider,model:answer.model});}
  }
  if(method==='POST'&&path==='/api/bundles'){const {user}=requireUser(req),input=await body(req,2_000_000),clean=parseBundle(input);saveBundle(user.handle,clean);return json(res,200,{score:scoreHistory(user.handle,1)[0]??null});}
  if(method==='GET'&&path==='/api/leaderboard'){const type=url.searchParams.get('type')??'challenge';if(type==='challenge')return json(res,200,{type,entries:publicChallengeLeaderboard()});if(type==='workflow')return json(res,200,{type,entries:workflowEntries()});throw new HttpError(400,'Unknown leaderboard type.');}
  if(method==='GET'&&path.startsWith('/api/profile/')){const profile=publicProfile(decodeURIComponent(path.slice(13)));if(!profile)throw new HttpError(404,'Public profile not found.');return json(res,200,{profile});}
  if(method==='POST'&&path==='/api/feedback'){const {user}=requireUser(req),input=await body(req),rating=Number(input.rating);if(!Number.isInteger(rating)||rating<1||rating>5)throw new HttpError(400,'Rating must be 1–5.');saveFeedback(user.handle,rating,text(input.message,2000,'message'));return json(res,201,{saved:true});}
  throw new HttpError(404,'API route not found.');
}

async function staticFile(res:ServerResponse,pathname:string){let clean;try{clean=decodeURIComponent(pathname);}catch{throw new HttpError(400,'Invalid path.');}const hasExt=Boolean(extname(clean)),relative=clean==='/'?'index.html':clean.replace(/^\/+/,''),file=resolve(PUBLIC_DIR,relative);if(file!==PUBLIC_DIR&&!file.startsWith(PUBLIC_DIR+sep))throw new HttpError(403,'Forbidden.');try{const data=await readFile(file);res.writeHead(200,{...securityHeaders(MIME[extname(file)]??'application/octet-stream'),'cache-control':'no-cache'});res.end(data);}catch{if(hasExt)throw new HttpError(404,'Not found.');const data=await readFile(resolve(PUBLIC_DIR,'index.html'));res.writeHead(200,{...securityHeaders('text/html; charset=utf-8'),'cache-control':'no-cache'});res.end(data);}}
export function createAppServer(){return createServer(async(req,res)=>{try{const url=new URL(req.url??'/','http://localhost');if(url.pathname.startsWith('/api/'))await api(req,res,url);else await staticFile(res,url.pathname);}catch(error){const status=error instanceof HttpError?error.status:error instanceof ValidationError?400:500;json(res,status,{error:status===500?'Internal server error.':(error as Error).message});if(status===500)console.error(error);}});}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const port=Number(process.env.PORT)||8787;createAppServer().listen(port,()=>console.log(`VibeScore is running at http://localhost:${port}`));}
