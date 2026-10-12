import type {Content,TgMessage,Update,Evidence} from './types.ts';
import {Store} from './store.ts';

function int(value:unknown):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value))throw new Error('Invalid Telegram identifier');
  return value;
}
function message(raw:unknown):TgMessage {
  if(!raw||typeof raw!=='object')throw new Error('Invalid Telegram message');
  const r=raw as Record<string,any>;
  const m:TgMessage={message_id:int(r.message_id),chat:{id:int(r.chat?.id),type:String(r.chat?.type)}};
  if(r.from)m.from={id:int(r.from.id),is_bot:Boolean(r.from.is_bot)};
  if(typeof r.text==='string')m.text=r.text.slice(0,20000);
  if(typeof r.caption==='string')m.caption=r.caption.slice(0,10000);
  if(r.reply_to_message)m.reply_to_message={message_id:int(r.reply_to_message.message_id)};
  if(r.media_group_id)m.media_group_id=String(r.media_group_id);
  if(Array.isArray(r.photo))m.photo=r.photo.filter((x:any)=>typeof x.file_id==='string').map((x:any)=>({file_id:x.file_id}));
  for(const kind of ['document','video','audio','voice','animation','sticker','video_note'] as const)
    if(typeof r[kind]?.file_id==='string')m[kind]={file_id:r[kind].file_id};
  if(r.contact)m.contact=true;
  if(r.location)m.location=true;
  return m;
}
export function normalizeUpdate(raw:unknown):Update {
  if(!raw||typeof raw!=='object')throw new Error('Invalid update');
  const r=raw as Record<string,any>;const result:Update={update_id:int(r.update_id)};
  if(r.message)result.message=message(r.message);
  if(r.edited_message)result.edited_message=message(r.edited_message);
  if(r.callback_query)result.callback_query={
    id:String(r.callback_query.id),from:{id:int(r.callback_query.from?.id)},
    ...(typeof r.callback_query.data==='string'?{data:r.callback_query.data.slice(0,64)}:{}),
    ...(r.callback_query.message?{message:message(r.callback_query.message)}:{})
  };
  return result;
}
export class TelegramError extends Error {
  code:number; retryAfter:number;
  constructor(code:number,retryAfter=0) {super('Telegram request failed ('+code+')');this.code=code;this.retryAfter=retryAfter;}
}
export interface Transport { call(method:string,payload:Record<string,unknown>):Promise<any>; }
export class Telegram implements Transport {
  token:string;fetcher:typeof fetch;controller=new AbortController();
  constructor(token:string,fetcher:typeof fetch=fetch){this.token=token;this.fetcher=fetcher;}
  async call(method:string,payload:Record<string,unknown>):Promise<any> {
    if(!/^[A-Za-z]+$/.test(method))throw new Error('Invalid Telegram method');
    let response:Response;
    try {
      response=await this.fetcher('https://api.telegram.org/bot'+this.token+'/'+method,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),
        signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(method==='getUpdates'?40000:20000)])
      });
    } catch { throw new TelegramError(0); }
    let body:{ok?:boolean;result?:any;error_code?:number;parameters?:{retry_after?:number}};
    try {body=await response.json();}catch {throw new TelegramError(response.status>=500?response.status:502);}
    if(!response.ok||!body.ok)throw new TelegramError(body.error_code||response.status,body.parameters?.retry_after||0);
    return body.result;
  }
  stop():void {this.controller.abort();}
}
export class MemoryTransport implements Transport {
  sent:{method:string;payload:Record<string,unknown>;messageId:number}[]=[];
  sequence=10000;
  async call(method:string,payload:Record<string,unknown>):Promise<any> {
    const messageId=++this.sequence;this.sent.push({method,payload,messageId});
    return {message_id:messageId};
  }
}
export class DeliveryWorker {
  store:Store;transport:Transport;now:()=>number;busy=false;
  catalogCurrent?: (snapshot:Evidence[],now:number)=>boolean;
  constructor(store:Store,transport:Transport,now:()=>number=Date.now,catalogCurrent?:(snapshot:Evidence[],now:number)=>boolean) {this.store=store;this.transport=transport;this.now=now;this.catalogCurrent=catalogCurrent;}
  async flush(limit=30):Promise<number> {
    if(this.busy)return 0;this.busy=true;let processed=0;
    try {
      while(processed<limit) {
        const item=this.store.nextOutgoing(this.now());if(!item)break;
        if(item.guard_version!==null) {
          const c=item.conversation_id?this.store.get(item.conversation_id):undefined;
          if(!c||c.state!=='ai'||c.version!==item.guard_version) {this.store.skip(item.id);processed++;continue;}
        }
        try {
          const {__poleznoCatalog,...payload}=JSON.parse(item.payload);
          if(__poleznoCatalog&&(!this.catalogCurrent||!this.catalogCurrent(__poleznoCatalog,this.now()))) {
            this.store.skipAiRemainder(item);
            payload.text='Информация о товарах обновилась. Уточните вопрос, чтобы я проверил актуальные данные, или отправьте /doctor.';
          }
          const result=await this.transport.call(item.method,payload);
          this.store.tx(()=>{
            this.store.finishOutgoing(item,result?.message_id);
            if(item.category==='ai'&&item.conversation_id) {
              this.store.append(item.conversation_id,'assistant',{text:String(payload.text)} satisfies Content,this.now());
            }
          });
        } catch(error) {
          const e=error instanceof TelegramError?error:new TelegramError(0);
          const permanent=(e.code>=400&&e.code<500&&e.code!==429)||item.attempts>=7;
          const delay=e.code===429?Math.max(1,e.retryAfter)*1000:Math.min(60000,1000*2**item.attempts);
          this.store.failure(item.id,permanent,this.now()+delay);
        }
        processed++;
      }
      return processed;
    } finally {this.busy=false;}
  }
}
