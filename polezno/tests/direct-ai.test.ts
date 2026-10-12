import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AiWorker,CompatibleAnswerer,validateAnswer} from '../src/ai.ts';
import {loadConfig} from '../src/config.ts';
import {Engine} from '../src/engine.ts';
import {Knowledge} from '../src/knowledge.ts';
import {Store} from '../src/store.ts';
import {checkLlm} from '../src/llm-check.ts';
import {DeliveryWorker,MemoryTransport} from '../src/telegram.ts';
import type {AiAnswer} from '../src/types.ts';

const answer:AiAnswer={action:'answer',text:'Общая справка модели без ссылки на локальный материал.',sourceIds:[],productIds:[]};
const config=()=>loadConfig({MODE:'demo',LLM_PROVIDER:'openrouter-free',LLM_API_KEY:'SYNTHETIC_KEY',LLM_ANSWER_MODE:'direct',DOCTOR_IDS:'101',ADMIN_IDS:'900'});
const response=(value:unknown)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
function setup() {
  const store=new Store(':memory:'),engine=new Engine(store,config());let sequence=0;
  const msg=(text:string)=>engine.handle({update_id:++sequence,message:{message_id:sequence,chat:{id:501,type:'private'},from:{id:501},text}});
  return {store,engine,msg};
}

test('direct external answers work without knowledge and preserve the current conversation',async()=>{
  const x=setup(),requests:any[]=[],transport=new MemoryTransport();
  const fake:typeof fetch=async(_url,opts)=>{requests.push(JSON.parse(String(opts?.body)));return response(answer);};
  const ai=new AiWorker(x.store,x.engine,new Knowledge([],[]),new CompatibleAnswerer(x.engine.config,fake));
  try {
    x.msg('Что такое клетчатка?');await ai.runOne();await new DeliveryWorker(x.store,transport).flush(100);
    x.msg('А какие бывают её виды?');await ai.runOne();await new DeliveryWorker(x.store,transport).flush(100);
    assert.equal(requests.length,2);
    const payload=JSON.parse(requests[1].messages[1].content);
    assert.deepEqual(payload.evidence,[]);
    assert.deepEqual(payload.history.map((m:any)=>m.role),['user','assistant','user']);
    assert.equal(payload.history[0].content,'Что такое клетчатка?');
    assert.equal(payload.history.at(-1).content,'А какие бывают её виды?');
    assert(requests[0].messages[0].content.includes('отсутствие evidence НЕ мешает ответить'));
    assert(requests[0].messages[0].content.includes('ТОЛЬКО из product evidence'));
    assert.equal(requests[0].response_format.type,'json_object');
    assert.deepEqual(requests[0].provider.max_price,{prompt:0,completion:0,request:0});
    assert.equal(requests[0].provider.zdr,true);assert.equal(requests[0].provider.data_collection,'deny');
    assert.equal(transport.sent.at(-1)?.payload.text,answer.text);
    assert(!transport.sent.some(m=>String(m.payload.text).includes('Источники:')));
  } finally {x.store.close();}
});

test('direct validation permits own knowledge but still rejects invented sources, products, URLs and doses',()=>{
  assert.deepEqual(validateAnswer(answer,[],'direct'),answer);
  assert.throws(()=>validateAnswer(answer,[],'sources'));
  for(const bad of [{...answer,sourceIds:['invented']},{...answer,productIds:['invented']},{...answer,text:'Читайте https://example.org'},{...answer,text:'Принимайте 10 мг.'},{...answer,command:'close'}])assert.throws(()=>validateAnswer(bad,[],'direct'));
  assert.throws(()=>loadConfig({LLM_ANSWER_MODE:'anything'}));
  assert.throws(()=>loadConfig({MODE:'live',LLM_ANSWER_MODE:'direct'}));
  assert.equal(loadConfig({}).llmAnswerMode,'sources');
});

test('direct mode keeps personal requests and files out of the model and remains paused in queue',async()=>{
  for(const text of ['Подбери мне витамин B12','Расшифруй анализы','/doctor']) {
    const x=setup();let calls=0;
    try {
      const ai=new AiWorker(x.store,x.engine,new Knowledge([],[]),{answer:async()=>{calls++;return answer;}});
      x.msg(text);x.msg('Что такое клетчатка?');await ai.runOne();
      assert.equal(x.store.current(501)?.state,'queued');assert.equal(calls,0,text);
    } finally {x.store.close();}
  }
  const x=setup();
  try {
    x.engine.handle({update_id:100,message:{message_id:100,chat:{id:501,type:'private'},from:{id:501},document:{file_id:'SYNTHETIC_FILE'}}});
    assert.equal(x.store.current(501)?.state,'queued');assert.equal(x.store.nextAi(),undefined);
  } finally {x.store.close();}
});

test('late direct answer is suppressed after a doctor request without needing evidence',async()=>{
  const x=setup();let release!:(value:AiAnswer)=>void;
  try {
    const ai=new AiWorker(x.store,x.engine,new Knowledge([],[]),{answer:async()=>new Promise(ok=>{release=ok;})});
    x.msg('Что такое клетчатка?');const pending=ai.runOne();
    x.msg('/doctor');release(answer);await pending;
    assert.equal(x.store.current(501)?.state,'queued');
    assert.equal(x.store.db.prepare("SELECT count(*) n FROM outbox WHERE category='ai'").get()?.n,0);
  } finally {x.store.close();}
});

test('direct provider failure is explicit and never falls back to fabricated knowledge',async()=>{
  const x=setup();
  try {
    const ai=new AiWorker(x.store,x.engine,new Knowledge([],[]),{answer:async()=>{throw new Error('PRIVATE_PROVIDER_BODY');}});
    x.msg('Что такое клетчатка?');await ai.runOne();
    const row=x.store.db.prepare("SELECT payload FROM outbox WHERE category='ai'").get() as {payload:string};
    assert(JSON.parse(row.payload).text.includes('ИИ не смог ответить'));
    assert(!row.payload.includes('PRIVATE_PROVIDER_BODY'));assert(!row.payload.includes('Источники:'));
  } finally {x.store.close();}
});

test('synthetic direct connectivity check calls the adapter with no evidence',async()=>{
  let calls=0;
  const result=await checkLlm(config(),async(_url,opts)=>{
    calls++;const payload=JSON.parse(JSON.parse(String(opts?.body)).messages[1].content);
    assert.deepEqual(payload.evidence,[]);assert.equal(payload.history.length,1);
    return response(answer);
  });
  assert.equal(calls,1);assert.equal(result.ok,true);assert.equal(result.code,'validated_direct_answer');
});
