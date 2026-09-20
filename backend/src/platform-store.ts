import { randomUUID } from 'node:crypto';
import { getDatabase } from './store.ts';

function db() {
  const d = getDatabase();
  d.exec(`CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY, handle TEXT NOT NULL REFERENCES users(handle) ON DELETE CASCADE, challenge_id TEXT NOT NULL, kind TEXT NOT NULL,
    mode TEXT NOT NULL, started_at TEXT NOT NULL, deadline TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    answer TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT '', reflection TEXT NOT NULL DEFAULT '',
    result TEXT, run_count INTEGER NOT NULL DEFAULT 0, submitted_at TEXT);
    CREATE INDEX IF NOT EXISTS attempt_owner ON attempts(handle, started_at);
    CREATE TABLE IF NOT EXISTS assistant_messages (id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_usage (id INTEGER PRIMARY KEY, handle TEXT NOT NULL REFERENCES users(handle) ON DELETE CASCADE, day TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, handle TEXT NOT NULL REFERENCES users(handle) ON DELETE CASCADE, rating INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);`);
  return d;
}
export interface Attempt {
  id:string; handle:string; challengeId:string; kind:string; mode:'practice'|'rated'; startedAt:string; deadline:string;
  status:string; answer:string; code:string; reflection:string; result:any; runCount:number; submittedAt:string|null;
}
function row(r:any): Attempt | null {
  if (!r) return null;
  return {id:r.id,handle:r.handle,challengeId:r.challenge_id,kind:r.kind,mode:r.mode,startedAt:r.started_at,deadline:r.deadline,status:r.status,
    answer:r.answer,code:r.code,reflection:r.reflection,result:r.result?JSON.parse(r.result):null,runCount:r.run_count,submittedAt:r.submitted_at};
}
export function createAttempt(handle:string, c:{id:string;kind:string;minutes:number;starterCode?:string}, mode:'practice'|'rated'):Attempt {
  const d=db();
  const existing=row(d.prepare("SELECT * FROM attempts WHERE handle=? AND challenge_id=? AND mode=? AND status='active' ORDER BY started_at DESC LIMIT 1").get(handle,c.id,mode));
  if (existing && (mode==='practice' || Date.now()<Date.parse(existing.deadline))) return existing;
  if (existing) d.prepare("UPDATE attempts SET status='expired' WHERE id=?").run(existing.id);
  const id=randomUUID(), now=new Date();
  d.prepare('INSERT INTO attempts(id,handle,challenge_id,kind,mode,started_at,deadline,code) VALUES(?,?,?,?,?,?,?,?)').run(id,handle,c.id,c.kind,mode,now.toISOString(),new Date(now.getTime()+c.minutes*60000).toISOString(),c.starterCode??'');
  return getAttempt(id,handle)!;
}
export function getAttempt(id:string, handle:string):Attempt|null {return row(db().prepare('SELECT * FROM attempts WHERE id=? AND handle=?').get(id,handle));}
export function attemptsFor(handle:string):Attempt[] {return db().prepare('SELECT * FROM attempts WHERE handle=? ORDER BY started_at DESC LIMIT 100').all(handle).map(x=>row(x)!);}
export function saveDraft(a:Attempt, input:{answer?:string;code?:string;reflection?:string}) {
  db().prepare("UPDATE attempts SET answer=?,code=?,reflection=? WHERE id=? AND status='active'").run(input.answer??a.answer,input.code??a.code,input.reflection??a.reflection,a.id);
}
export function recordRun(id:string) { db().prepare('UPDATE attempts SET run_count=run_count+1 WHERE id=?').run(id); }
export function finishAttempt(a:Attempt,result:any) {
  const previous=db().prepare("SELECT id FROM attempts WHERE handle=? AND challenge_id=? AND mode='rated' AND status='submitted' AND id<>? LIMIT 1").get(a.handle,a.challengeId,a.id);
  result.ratingEligible=Boolean(result.ratingEligible && !previous && a.mode==='rated');
  if (previous && a.mode==='rated') result.ratingNote='Only the first completed rated attempt on each task contributes to your beta rating. Retakes are for practice.';
  db().prepare("UPDATE attempts SET status='submitted',result=?,submitted_at=? WHERE id=? AND status='active'").run(JSON.stringify(result),new Date().toISOString(),a.id);
}
export function messagesFor(id:string) {return db().prepare('SELECT role,content FROM assistant_messages WHERE attempt_id=? ORDER BY id').all(id) as {role:'user'|'assistant';content:string}[];}
export function addMessage(id:string,role:string,content:string) {db().prepare('INSERT INTO assistant_messages(attempt_id,role,content,created_at) VALUES(?,?,?,?)').run(id,role,content,new Date().toISOString());}
export function claimAiUsage(handle:string):boolean {
  const d=db(), day=new Date().toISOString().slice(0,10);
  const global=Number(process.env.AI_DAILY_REQUEST_LIMIT)||200, perUser=Number(process.env.AI_USER_DAILY_REQUEST_LIMIT)||20;
  const total=d.prepare('SELECT count(*) AS n FROM ai_usage WHERE day=?').get(day) as any;
  const user=d.prepare('SELECT count(*) AS n FROM ai_usage WHERE day=? AND handle=?').get(day,handle) as any;
  if(total.n>=global||user.n>=perUser) return false;
  d.prepare('INSERT INTO ai_usage(handle,day,created_at) VALUES(?,?,?)').run(handle,day,new Date().toISOString());
  return true;
}
export function challengeSummary(handle:string) {
  const all=(db().prepare('SELECT * FROM attempts WHERE handle=? ORDER BY started_at DESC').all(handle) as any[]).map(x=>row(x)!);
  const scored=all.filter(a=>a.result?.ratingEligible);
  const average=scored.length?Math.round(scored.reduce((s,a)=>s+Number(a.result.totalScore??a.result.score??0),0)/scored.length):null;
  return {completed:all.filter(a=>a.status==='submitted').length,ratedTasks:scored.length,rating:average===null?null:800+14*average,
    eligible:scored.length>=2,average,history:scored.map(a=>({at:a.submittedAt,score:a.result.totalScore??a.result.score,challengeId:a.challengeId})).reverse()};
}
export function publicChallengeLeaderboard(limit=100) {
  const handles=(db().prepare('SELECT handle FROM users WHERE is_public=1 ORDER BY handle').all() as any[]).map(x=>x.handle);
  return handles.map(handle=>({handle,...challengeSummary(handle)})).filter(x=>x.eligible)
    .sort((a,b)=>(b.rating??0)-(a.rating??0)||b.ratedTasks-a.ratedTasks||a.handle.localeCompare(b.handle)).slice(0,Math.max(1,Math.min(250,limit)));
}
export function clearPlatformUser(handle:string) {
  const d=db();
  d.prepare('DELETE FROM assistant_messages WHERE attempt_id IN (SELECT id FROM attempts WHERE handle=?)').run(handle);
  for (const table of ['attempts','ai_usage','feedback']) d.prepare(`DELETE FROM ${table} WHERE handle=?`).run(handle);
}
export function saveFeedback(handle:string,rating:number,message:string) {db().prepare('INSERT INTO feedback VALUES(?,?,?,?,?)').run(randomUUID(),handle,rating,message,new Date().toISOString());}
