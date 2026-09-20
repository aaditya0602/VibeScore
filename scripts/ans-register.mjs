#!/usr/bin/env node
/** Production GoDaddy ANS registration helper. Secrets and key material stay in .local/ans. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ANS_PRODUCTION_BASE = 'https://api.godaddy.com';

function option(args, name) { const i=args.indexOf(name); return i>=0?args[i+1]:undefined; }
export function ansHost(value) {
  const clean=String(value??'').trim().toLowerCase();
  if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(clean)) throw new Error('Pass a fully qualified domain with --host, for example agent.vibescore.dev.');
  return clean;
}
function credentials(env) {
  const key=env.ANS_API_KEY,secret=env.ANS_API_SECRET;
  if (!key||!secret||/[\r\n]/.test(key+secret)) throw new Error('Set ANS_API_KEY and ANS_API_SECRET in the shell. Do not paste them into source files.');
  return `sso-key ${key}:${secret}`;
}
async function responseJson(response) {
  const reader=response.body?.getReader(); if(!reader)throw new Error(`ANS returned an empty response (${response.status}).`);
  const chunks=[];let size=0;
  try { for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>256_000){await reader.cancel();throw new Error('ANS response exceeded 256 KB.');}chunks.push(value);} } finally { reader.releaseLock(); }
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error(`ANS returned invalid JSON (${response.status}).`);}
  if(!response.ok)throw new Error(`ANS request failed (${response.status}): ${typeof value?.message==='string'?value.message:'See the GoDaddy developer portal.'}`);
  return value;
}
async function request(path, method, body, fetchImpl, env) {
  return responseJson(await fetchImpl(ANS_PRODUCTION_BASE+path,{method,redirect:'error',signal:AbortSignal.timeout(20_000),headers:{authorization:credentials(env),accept:'application/json',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}));
}
export function registrationState(value) {
  const agentId=typeof value?.agentId==='string'&&/^[a-zA-Z0-9-]{4,128}$/.test(value.agentId)?value.agentId:null;
  const record=value?.challenge?.dnsRecord;
  const name=typeof record?.name==='string'&&record.name.length<=253?record.name:null;
  const type=record?.type==='TXT'?'TXT':null;
  const dnsValue=typeof record?.value==='string'&&record.value.length<=2048?record.value:null;
  if(!agentId||!name||!type||!dnsValue)throw new Error('ANS returned an incomplete registration response; no state was saved.');
  return {agentId,ansName:typeof value.ansName==='string'?value.ansName:null,status:typeof value.status==='string'?value.status:null,expiresAt:typeof value.expiresAt==='string'?value.expiresAt:null,challenge:{dnsRecord:{name,type,value:dnsValue}}};
}
function readState(path) {
  let value;try{value=JSON.parse(readFileSync(path,'utf8'));}catch{throw new Error('The saved registration state is invalid.');}
  if(typeof value.agentId!=='string'||!/^[a-zA-Z0-9-]{4,128}$/.test(value.agentId))throw new Error('The saved registration state is invalid.');
  return value;
}
function writeState(path, value) {
  const temporary=`${path}.tmp-${process.pid}`;
  writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  chmodSync(temporary,0o600);
  renameSync(temporary,path);
}

/** Execute one CLI operation. Dependencies are injectable so production flows can be tested without live credentials. */
export async function runAnsCommand(args, options={}) {
  const command=args[0];
  const dir=resolve(options.baseDir??'.local/ans');
  const key=resolve(dir,'identity.key.pem'),csr=resolve(dir,'identity.csr.pem'),statePath=resolve(dir,'registration.json');
  const fetchImpl=options.fetchImpl??fetch,env=options.env??process.env,execFile=options.execFile??execFileSync;
  const write=options.write??(text=>process.stdout.write(text));
  const show=value=>write(JSON.stringify(value,null,2)+'\n');
  if (!command || command==='help' || command==='--help') {
    write(`VibeScore ANS registration\n\n  npm run ans -- prepare --host agent.example.com\n  npm run ans -- register --host agent.example.com\n  npm run ans -- status\n  npm run ans -- verify-acme\n  npm run ans -- verify-dns\n\nprepare creates a private identity key and CSR under .local/ans (gitignored). register sends the CSR and hosted MCP metadata to production ANS and saves the returned DNS challenge. Verification commands use the saved agentId.\n`);
    return;
  }
  if (command==='prepare') {
    const domain=ansHost(option(args,'--host'));mkdirSync(dir,{recursive:true});
    if ((existsSync(key)||existsSync(csr))&&!args.includes('--force')) throw new Error('Identity material already exists. Use the existing CSR, or pass --force only if you intend to replace the key before registration.');
    execFile('openssl',['req','-new','-newkey','rsa:2048','-nodes','-keyout',key,'-out',csr,'-subj',`/CN=${domain}`,'-addext',`subjectAltName=DNS:${domain}`],{stdio:'ignore'});
    chmodSync(key,0o600);writeFileSync(resolve(dir,'host.txt'),domain+'\n',{mode:0o600});
    write(`Created ${csr}\nPrivate key: ${key} (keep private; never commit or upload it)\n`);
    return;
  }
  if (command==='register') {
    const domain=ansHost(option(args,'--host'));const origin=`https://${domain}`;
    const preparedHost=readFileSync(resolve(dir,'host.txt'),'utf8').trim();
    if(domain!==preparedHost)throw new Error(`The CSR was prepared for ${preparedHost}; register that host or create a new CSR with --force.`);
    const identityCsrPEM=readFileSync(csr,'utf8');
    const result=await request('/v1/agents/register','POST',{agentDisplayName:'VibeScore Scoring Agent',agentHost:domain,version:'0.3.0',identityCsrPEM,endpoints:[{agentUrl:`${origin}/mcp`,metaDataUrl:`${origin}/.well-known/mcp.json`,documentationUrl:`${origin}/privacy`,protocol:'MCP',transports:['STREAMABLE-HTTP'],functions:[
      {id:'describe_scoring',name:'Describe VibeScore scoring',tags:['scoring','skills','privacy']},
      {id:'recommend_drill',name:'Recommend an AI-building drill',tags:['practice','coaching','skills']},
      {id:'preview_workflow_report',name:'Preview a privacy-reduced workflow report',tags:['workflow','privacy','assessment']},
      {id:'publish_workflow_report',name:'Publish a privacy-reduced workflow report',tags:['workflow','assessment','profile']},
      {id:'verify_public_profile',name:'Verify a public VibeScore profile',tags:['profile','credential','leaderboard']},
    ]}]},fetchImpl,env);
    const saved=registrationState(result);mkdirSync(dir,{recursive:true});writeState(statePath,saved);show(saved);
    return saved;
  }
  if (command==='status') {
    const saved=readState(statePath),result=await request(`/v1/agents/${encodeURIComponent(saved.agentId)}`,'GET',undefined,fetchImpl,env);show(result);return result;
  }
  if (command==='verify-acme' || command==='verify-dns') {
    const saved=readState(statePath),result=await request(`/v1/agents/${encodeURIComponent(saved.agentId)}/${command}`,'POST',undefined,fetchImpl,env);show(result);return result;
  }
  throw new Error(`Unknown command: ${command}. Run npm run ans -- help.`);
}

if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  runAnsCommand(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
