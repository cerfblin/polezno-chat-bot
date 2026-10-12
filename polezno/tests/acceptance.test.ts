import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {main} from '../src/main.ts';
import {loadConfig} from '../src/config.ts';
import {Engine} from '../src/engine.ts';
import {Store} from '../src/store.ts';
import {TelegramError} from '../src/telegram.ts';
import {MENU} from '../src/ui.ts';
import type {Update} from '../src/types.ts';

function fixture() {
  const base=resolve('var');mkdirSync(base,{recursive:true});
  const dir=mkdtempSync(join(base,'acceptance-'));
  writeFileSync(join(dir,'knowledge.json'),JSON.stringify([{id:'test-vitamin',title:'Синтетическая справка',text:'Синтетические материалы для проверки механики.',url:'https://example.org/test',keywords:['витамин','уточни','справку','про','новый','вопрос'],enabled:true,reviewedBy:'synthetic-test',checkedAt:'2026-10-12',clinicianReviewed:false}]));
  writeFileSync(join(dir,'catalog.json'),'[]');
  const config=loadConfig({MODE:'live',TELEGRAM_BOT_TOKEN:'123:SYNTHETIC_TELEGRAM_TOKEN_12345',DOCTOR_GROUP_ID:'-1001',DOCTOR_IDS:'101,102',ADMIN_IDS:'900',DATABASE_PATH:join(dir,'db.sqlite'),KNOWLEDGE_PATH:join(dir,'knowledge.json'),CATALOG_PATH:join(dir,'catalog.json'),LLM_PROVIDER:'openrouter-free',LLM_API_KEY:'SYNTHETIC_LLM_KEY',LLM_TIMEOUT_MS:'1000'});
  config.port=0;
  let sequence=0,messageId=1000,stopped=false,waiting:((updates:Update[])=>void)|undefined;
  const queue:Update[]=[];
  const sent:{method:string;payload:Record<string,any>}[]=[];
  const abort=new AbortController();
  const msg=(id:number,text:string,extra:object={}):Update=>({update_id:++sequence,message:{message_id:sequence,chat:{id,type:'private'},from:{id},text,...extra}});
  const click=(doctor:number,data:string,group=false):Update=>({update_id:++sequence,callback_query:{id:'cb'+sequence,from:{id:doctor},data,message:{message_id:++messageId,chat:{id:group?-1001:doctor,type:group?'supergroup':'private'}}}});
  const enqueue=(...updates:Update[])=>{queue.push(...updates);if(waiting){const done=waiting;waiting=undefined;done(queue.splice(0));}};
  const api={
    async call(method:string,payload:Record<string,unknown>):Promise<any> {
      if(method==='getMe')return {id:99999};
      if(method==='getChat')return {type:'supergroup'};
      if(method==='getChatMember')return {status:'member'};
      if(method==='getWebhookInfo')return {url:''};
      if(method==='getUpdates') {
        if(stopped)return [];
        if(queue.length)return queue.splice(0);
        return await new Promise<Update[]>(done=>{waiting=done;});
      }
      sent.push({method,payload});return {message_id:++messageId};
    },
    stop(){stopped=true;if(waiting){const done=waiting;waiting=undefined;done([]);}}
  };
  return {config,dir,abort,msg,click,enqueue,api,sent,cleanup(){assert(dir.startsWith(base+'\\')||dir.startsWith(base+'/'));rmSync(dir,{recursive:true,force:true});}};
}
function reply(text:string):Response {
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({action:'answer',text,sourceIds:['test-vitamin'],productIds:[]})}}]}));
}

test('runtime acceptance: external adapter, late AI, competing claims, failed file retry, close button and clean new context',async t=>{
  const x=fixture();let phase='first',calls=0,failedFile=false,caseId='';
  let releaseLate:((value:Response)=>void)|undefined;
  t.mock.method(globalThis,'fetch',async(url:unknown,options:RequestInit)=>{
    assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
    const request=JSON.parse(String(options.body));calls++;
    assert.deepEqual(request.provider.max_price,{prompt:0,completion:0,request:0});
    assert.equal(request.provider.zdr,true);assert.equal(request.provider.data_collection,'deny');
    assert.equal(request.response_format.type,'json_object');assert.equal(options.redirect,'error');
    if(calls===1)return reply('СИНТЕТИЧЕСКИЙ ПЕРВЫЙ ОТВЕТ');
    if(calls===2) {
      phase='doctor';
      x.enqueue(x.msg(501,MENU.doctor),x.msg(501,'ФОТО_ИЗ_СТАРОГО_РАЗГОВОРА',{photo:[{file_id:'TEST_PHOTO'}]}),x.msg(501,'PDF_ИЗ_СТАРОГО_РАЗГОВОРА',{document:{file_id:'TEST_PDF'}}));
      return await new Promise<Response>(done=>{releaseLate=done;});
    }
    assert.equal(calls,3);
    const context=JSON.parse(request.messages[1].content);
    assert.deepEqual(context.history,[{role:'user',content:'Новый вопрос про витамин'}]);
    assert(!JSON.stringify(context).includes('СТАРОГО_РАЗГОВОРА'));
    return reply('СИНТЕТИЧЕСКИЙ НОВЫЙ ОТВЕТ');
  });
  const original=x.api.call.bind(x.api);
  x.api.call=async(method,payload)=>{
    if(method==='sendDocument'&&payload.document==='TEST_PDF'&&!failedFile) {
      failedFile=true;
      setImmediate(()=>x.enqueue(x.msg(900,MENU.retry)));
      throw new TelegramError(403);
    }
    const result=await original(method,payload);
    if(method==='sendMessage'&&payload.chat_id===501&&String(payload.text).includes('СИНТЕТИЧЕСКИЙ ПЕРВЫЙ ОТВЕТ')&&phase==='first') {
      phase='followup';x.enqueue(x.msg(501,'Уточни справку про витамин'));
    }
    if(method==='sendMessage'&&payload.chat_id===-1001) {
      caseId=(payload.reply_markup as any).inline_keyboard[0][0].callback_data.split(':')[1];
      x.enqueue(x.click(101,'claim:'+caseId,true),x.click(102,'claim:'+caseId,true));
    }
    if(method==='sendDocument'&&payload.chat_id===101) {
      releaseLate?.(reply('LATE_AI_MUST_NOT_BE_SENT'));
      x.enqueue(x.msg(101,'СИНТЕТИЧЕСКИЙ ОТВЕТ ВРАЧА'));
    }
    if(method==='sendMessage'&&payload.chat_id===501&&String(payload.text).includes('СИНТЕТИЧЕСКИЙ ОТВЕТ ВРАЧА')&&phase==='doctor') {
      phase='closing';x.enqueue(x.click(101,'close:'+caseId));
    }
    if(method==='sendMessage'&&payload.chat_id===101&&JSON.stringify(payload.reply_markup??{}).includes('finish:'+caseId)&&phase==='closing') {
      phase='new';x.enqueue(x.click(101,'finish:'+caseId),x.msg(501,'Новый вопрос про витамин'));
    }
    if(method==='sendMessage'&&payload.chat_id===501&&String(payload.text).includes('СИНТЕТИЧЕСКИЙ НОВЫЙ ОТВЕТ')) {phase='done';x.abort.abort();}
    return result;
  };
  x.enqueue(x.msg(101,'/start'),x.msg(102,'/start'),x.msg(501,'/start partner_acceptance'),x.msg(501,'Что такое витамин?'));
  const deadline=setTimeout(()=>{releaseLate?.(reply('LATE_AI_MUST_NOT_BE_SENT'));x.abort.abort();},10000);
  try {
    await main({config:x.config,api:x.api,signal:x.abort.signal});
    assert.equal(phase,'done',JSON.stringify({calls,failedFile,caseId,deliveries:x.sent.map(v=>v.method+':'+v.payload.chat_id)}));assert.equal(calls,3);assert(failedFile);
    assert(!x.sent.some(v=>String(v.payload.text).includes('LATE_AI_MUST_NOT_BE_SENT')));
    assert.equal(x.sent.filter(v=>v.method==='sendDocument'&&v.payload.chat_id===101).length,1);
    assert.equal(x.sent.filter(v=>v.method==='sendPhoto'&&v.payload.chat_id===101).length,1);
    assert(!x.sent.some(v=>[ 'sendPhoto','sendDocument'].includes(v.method)&&v.payload.chat_id===102));
    const store=new Store(x.config.databasePath);
    try {
      assert.equal(store.get(caseId)?.state,'closed');assert.equal(store.get(caseId)?.doctor_id,101);
      assert.equal(store.current(501)?.state,'ai');assert.equal(store.current(501)?.source,'partner_acceptance');
      assert.equal(store.stats().failed,0);assert.equal(store.nextOutgoing(Date.now()),undefined);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audit WHERE event='claimed'").get()!.n,1);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM ai_jobs WHERE status='superseded'").get()!.n,1);
      assert.equal(store.history(store.current(501)!.id).filter(m=>m.role==='user').length,1);
    } finally {store.close();}
    assert(!existsSync(x.config.databasePath+'.lock.pid'));
  } finally {clearTimeout(deadline);releaseLate?.(reply('LATE_AI_MUST_NOT_BE_SENT'));x.abort.abort();x.cleanup();}
});

test('runtime recovery replays pending inbox once, supersedes crashed AI and retries Telegram 429',async t=>{
  const x=fixture();let llmCalls=0,sendAttempts=0,pollAttempts=0,answerDelivered=false,pollRecovered=false;
  const first=x.msg(501,'Что такое витамин?');
  const pending=x.msg(501,'Уточни вопрос про витамин');
  const seed=new Store(x.config.databasePath);
  try {
    new Engine(seed,x.config).handle(first);
    seed.jobStatus(seed.nextAi()!.id,'running');
    seed.ingest(pending);
  } finally {seed.close();}
  t.mock.method(globalThis,'fetch',async(_url:unknown,options:RequestInit)=>{
    llmCalls++;
    const context=JSON.parse(JSON.parse(String(options.body)).messages[1].content);
    assert.deepEqual(context.history.map((h:{content:string})=>h.content),['Что такое витамин?','Уточни вопрос про витамин']);
    return reply('СИНТЕТИЧЕСКИЙ ВОССТАНОВЛЕННЫЙ ОТВЕТ');
  });
  const original=x.api.call.bind(x.api);
  x.api.call=async(method,payload)=>{
    if(method==='getUpdates') {
      pollAttempts++;
      if(pollAttempts===1)throw new TelegramError(429,1);
      if(pollAttempts===2) {
        pollRecovered=true;if(answerDelivered)x.abort.abort();
        return [pending]; // Telegram may repeat the last persisted update after reconnect.
      }
    }
    if(method==='sendMessage'&&payload.chat_id===501) {
      if(sendAttempts++===0)throw new TelegramError(429,1);
      const result=await original(method,payload);answerDelivered=true;if(pollRecovered)x.abort.abort();return result;
    }
    return original(method,payload);
  };
  const deadline=setTimeout(()=>x.abort.abort(),8000);
  try {
    await main({config:x.config,api:x.api,signal:x.abort.signal});
    assert.equal(llmCalls,1);assert.equal(sendAttempts,2);assert(pollRecovered);assert(pollAttempts>=2);
    assert.equal(x.sent.filter(v=>v.method==='sendMessage'&&v.payload.chat_id===501).length,1);
    const store=new Store(x.config.databasePath);
    try {
      assert.equal(store.pendingUpdates().length,0);assert.equal(store.stats().failed,0);assert.equal(store.nextAi(),undefined);
      assert.equal(store.history(store.current(501)!.id).filter(m=>m.role==='user').length,2);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM ai_jobs WHERE status='superseded'").get()!.n,1);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM ai_jobs WHERE status='done'").get()!.n,1);
      assert.equal(new Engine(store,x.config).handle(pending),false);
    } finally {store.close();}
    assert(!existsSync(x.config.databasePath+'.lock.pid'));
  } finally {clearTimeout(deadline);x.abort.abort();x.cleanup();}
});
