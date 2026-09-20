import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

type Entry={start:number;count:number};

/** Small in-process limiter for a single-instance beta deployment. */
export class RateLimiter {
  private entries=new Map<string,Entry>();
  private readonly maxEntries:number;
  constructor(maxEntries=10_000){this.maxEntries=maxEntries;}
  allow(key:string,limit:number,windowMs:number,now=Date.now()):boolean {
    const clean=key.slice(0,300),current=this.entries.get(clean);
    if(!current||now-current.start>=windowMs){this.entries.delete(clean);this.entries.set(clean,{start:now,count:1});this.trim(now,windowMs);return true;}
    current.count++;
    return current.count<=limit;
  }
  get size(){return this.entries.size;}
  private trim(now:number,windowMs:number){
    if(this.entries.size<=this.maxEntries)return;
    for(const [key,value] of this.entries){if(now-value.start>=windowMs)this.entries.delete(key);}
    const target=Math.floor(this.maxEntries*.9);
    for(const key of this.entries.keys()){if(this.entries.size<=target)break;this.entries.delete(key);}
  }
}

export function requestAddress(req:IncomingMessage,trustProxy:boolean):string {
  if(trustProxy){
    const values=String(req.headers['x-forwarded-for']??'').split(',').map(value=>value.trim().replace(/^\[|\]$/g,'')).filter(Boolean);
    const forwarded=values.find(value=>isIP(value));
    if(forwarded)return forwarded;
  }
  return String(req.socket.remoteAddress||'unknown').slice(0,80);
}
