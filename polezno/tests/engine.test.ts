import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.ts';
import {Engine,URGENT} from '../src/engine.ts';
import {loadConfig} from '../src/config.ts';
import {Knowledge} from '../src/knowledge.ts';
import {AiWorker,ExtractiveAnswerer} from '../src/ai.ts';
import {DeliveryWorker,MemoryTransport,normalizeUpdate} from '../src/telegram.ts';
import type {Config,Update} from '../src/types.ts';

const open:Store[]=[];
afterEach(()=>{for(const s of open.splice(0))s.close();});
function setup(path=':memory:') {
  const store=new Store(path);open.push(store);
  const config:Config=loadConfig({MODE:'demo',DOCTOR_GROUP_ID:'-1001',DOCTOR_IDS:'101,102',ADMIN_IDS:'900'});
  const engine=new Engine(store,config,()=>Date.parse('2026-10-11T10:00:00Z'));
  const transport=new MemoryTransport();const worker=new DeliveryWorker(store,transport);
  let next=0;
  const msg=(id:number,text:string,extra:object={},edited=false,messageId?:number)=>{
    const update:Update={update_id:++next};
    update[edited?'edited_message':'message']={message_id:messageId||next,chat:{id,type:'private'},from:{id},text,...extra};
    engine.handle(update);return update;
  };
  const claim=(id:string,doctor=101,group=-1001)=>engine.handle({update_id:++next,callback_query:{id:'callback_'+next,from:{id:doctor},data:'claim:'+id,message:{message_id:500,chat:{id:group,type:'supergroup'}}}});
  return {store,config,engine,transport,worker,msg,claim};
}

test('complete flow: source, history, file, claim, doctor, close, new conversation',async()=>{
  const x=setup();x.msg(101,'/start');x.msg(501,'/start partner_one');x.msg(501,'Что такое пищевые добавки?');
  const k=new Knowledge([{id:'s1',title:'Добавки',text:'Добавки дополняют рацион.',url:'https://example.org/info',keywords:['добавки'],enabled:true,reviewedBy:'test',checkedAt:'2026-10-11',clinicianReviewed:false}],[]);
  const ai=new AiWorker(x.store,x.engine,k,new ExtractiveAnswerer());
  await ai.runOne();await x.worker.flush(100);
  x.msg(501,'Анализы',{document:{file_id:'FILE'},forward_origin:{sender_user:{id:501,username:'secret_user'}}});
  const first=x.store.current(501)!;assert.equal(first.state,'queued');
  x.claim(first.id);await x.worker.flush(100);
  assert.equal(x.store.get(first.id)?.doctor_id,101);
  assert(x.transport.sent.some(x=>x.method==='sendDocument'&&x.payload.document==='FILE'));
  x.msg(101,'Здравствуйте, документ получен.');await x.worker.flush(100);
  assert(x.transport.sent.some(x=>x.payload.chat_id===501&&String(x.payload.text).includes('документ получен')));
  x.msg(101,'/close');assert.equal(x.store.get(first.id)?.state,'closed');
  x.msg(501,'Новый вопрос');const second=x.store.current(501)!;
  assert.notEqual(second.id,first.id);assert.equal(second.state,'ai');assert.equal(x.store.history(second.id).length,1);
  assert.equal(first.source,'partner_one');
});

test('conditional claim across independent connections has exactly one winner',()=>{
  const dir=join('var','test-'+randomUUID());mkdirSync(dir,{recursive:true});
  const path=join(dir,'db.sqlite');
  const a=new Store(path),b=new Store(path);
  try {
    a.user(501,null,1);const c=a.create(501,1);a.queue(c.id,1);
    const winners=[a.tx(()=>a.claim(c.id,101,2)),b.tx(()=>b.claim(c.id,102,2))];
    assert.equal(winners.filter(Boolean).length,1);assert.equal(b.get(c.id)?.doctor_id,101);
  } finally {a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('unready doctor and a forged group cannot claim',()=>{
  const x=setup();x.msg(501,'/doctor');const c=x.store.current(501)!;
  x.claim(c.id);assert.equal(x.store.get(c.id)?.state,'queued');
  x.msg(101,'/start');x.claim(c.id,101,-999);assert.equal(x.store.get(c.id)?.state,'queued');
  x.claim(c.id,999);assert.equal(x.store.get(c.id)?.state,'queued');
  x.claim(c.id);assert.equal(x.store.get(c.id)?.state,'doctor');
});

test('same update id is idempotent, including a claim',()=>{
  const x=setup();const u=x.msg(501,'/doctor');
  const before=x.store.db.prepare('SELECT COUNT(*) n FROM outbox').get();
  assert.equal(x.engine.handle(u),false);
  assert.deepEqual(x.store.db.prepare('SELECT COUNT(*) n FROM outbox').get(),before);
  x.msg(101,'/start');x.claim(x.store.current(501)!.id);
  assert.equal(x.store.cases(101).length,1);
});

test('no AI job for queued or doctor conversation; messages before/after claim preserved',()=>{
  const x=setup();x.msg(101,'/start');x.msg(501,'Врач');const c=x.store.current(501)!;
  x.msg(501,'Дополнение перед приёмом');x.claim(c.id);x.msg(501,'Дополнение после приёма');
  assert.equal(x.store.nextAi(),undefined);
  const history=x.store.history(c.id).map(x=>JSON.parse(x.content).text);
  assert(history.includes('Дополнение перед приёмом'));assert(history.includes('Дополнение после приёма'));
  const payloads=x.store.db.prepare("SELECT payload FROM outbox WHERE category IN ('history','relay')").all() as {payload:string}[];
  assert.equal(payloads.filter(x=>x.payload.includes('Дополнение перед')).length,1);
  assert.equal(payloads.filter(x=>x.payload.includes('Дополнение после')).length,1);
});

test('doctor privacy: no profile fields, contacts or forward metadata in relay payload',()=>{
  const x=setup();x.msg(101,'/start');
  const raw={update_id:55,message:{message_id:55,chat:{id:501,type:'private',first_name:'SECRET'},from:{id:501,username:'SECRET_USER',first_name:'SECRET'},caption:'Мой @secretuser, email me@example.org, телефон +7 999 123 45 67',photo:[{file_id:'PHOTO'}],forward_origin:{sender_user:{id:501}}}};
  const u=normalizeUpdate(raw);x.engine.handle(u);
  const c=x.store.current(501)!;x.claim(c.id);
  const rows=x.store.db.prepare("SELECT payload FROM outbox WHERE destination='101' AND category IN ('history','relay','case')").all() as {payload:string}[];
  const dump=rows.map(x=>x.payload).join('\n');
  assert(!dump.includes('501'));assert(!dump.includes('SECRET'));assert(!dump.includes('secretuser'));
  assert(!dump.includes('me@example.org'));assert(!dump.includes('forward_origin'));
  assert(dump.includes('PHOTO'));
});

test('reply chooses correct case; unknown reply and foreign close are denied',async()=>{
  const x=setup();x.msg(101,'/start');x.msg(102,'/start');
  x.msg(501,'/doctor');const a=x.store.current(501)!;x.claim(a.id);await x.worker.flush(100);
  const reply=x.transport.sent.find(v=>v.payload.chat_id===101&&String(v.payload.text).includes('Вы приняли'))!.messageId;
  x.msg(502,'/doctor');const b=x.store.current(502)!;x.claim(b.id);await x.worker.flush(100);
  x.msg(101,'Ответ первому',{reply_to_message:{message_id:reply}});
  const out=x.store.db.prepare("SELECT payload FROM outbox WHERE category='relay' ORDER BY id DESC LIMIT 1").get() as {payload:string};
  assert.equal(JSON.parse(out.payload).chat_id,501);
  const count=x.store.history(b.id).length;
  x.msg(101,'Не должен уйти',{reply_to_message:{message_id:999999}});
  assert.equal(x.store.history(b.id).length,count);
  x.msg(102,'/case '+a.id);x.msg(102,'/close');
  assert.equal(x.store.get(a.id)?.state,'doctor');
});

test('edited messages map to original case; closed edits never create a fresh consultation',()=>{
  const x=setup();x.msg(101,'/start');
  const original=x.msg(501,'Врач');const id=original.message!.message_id;
  const c=x.store.current(501)!;x.claim(c.id);
  x.msg(501,'Уточнение правки',{},true,id);
  assert(JSON.parse(x.store.history(c.id).at(-1)!.content).edited);
  x.msg(101,'/close');x.msg(501,'Правка закрытого',{},true,id);
  assert.equal(x.store.current(501),undefined);
});

test('doctor edit cannot jump to newly selected case',async()=>{
  const x=setup();x.msg(101,'/start');x.msg(501,'Врач');const a=x.store.current(501)!;x.claim(a.id);
  const original=x.msg(101,'Первоначальный ответ');x.msg(502,'Врач');const b=x.store.current(502)!;x.claim(b.id);
  x.msg(101,'Исправленный ответ',{},true,original.message!.message_id);
  const payload=x.store.db.prepare("SELECT payload FROM outbox WHERE category='relay' ORDER BY id DESC LIMIT 1").get() as {payload:string};
  assert.equal(JSON.parse(payload.payload).chat_id,501);assert.equal(x.store.get(b.id)?.state,'doctor');
});

test('source first/last attribution and invalid payload',()=>{
  const x=setup();x.msg(501,'/start doctor_first');x.msg(501,'/start partner_last');x.msg(501,'/start invalid.payload');x.msg(501,'Вопрос');
  const row=x.store.db.prepare('SELECT * FROM users WHERE id=501').get() as any;
  assert.equal(row.first_source,'doctor_first');assert.equal(row.last_source,'partner_last');
  assert.equal(x.store.current(501)?.source,'partner_last');
});

test('stats/admin retry are forbidden to users and ordinary doctors',()=>{
  const x=setup();x.msg(501,'/stats');x.msg(101,'/stats');x.msg(900,'/stats');
  const rows=x.store.db.prepare('SELECT payload FROM outbox').all() as {payload:string}[];
  assert(!rows.slice(0,2).some(x=>x.payload.includes('Статистика обращений')));
  assert(rows.at(-1)!.payload.includes('Статистика обращений'));
});

test('urgent request gives emergency instruction and queues; shop remains in Mini App',()=>{
  const x=setup();x.msg(501,'Не могу дышать');assert.equal(x.store.current(501)?.state,'queued');
  const out=x.store.db.prepare('SELECT payload FROM outbox').all() as {payload:string}[];
  assert(out.some(x=>JSON.parse(x.payload).text===URGENT));
  x.msg(502,'Как оплатить доставку?');assert.equal(x.store.current(502)?.state,'ai');assert.equal(x.store.nextAi(),undefined);
});

test('unsupported contacts are explained; media albums kept as separate messages',()=>{
  const x=setup();x.msg(501,'',{contact:{phone_number:'secret'}});assert.equal(x.store.current(501),undefined);
  x.msg(501,'',{photo:[{file_id:'A'}],media_group_id:'ALBUM'});x.msg(501,'',{photo:[{file_id:'B'}],media_group_id:'ALBUM'});
  const content=x.store.history(x.store.current(501)!.id).filter(x=>x.role==='user').map(x=>JSON.parse(x.content));
  assert.deepEqual(content.map(x=>x.fileId),['A','B']);
});

test('AI rate limit retains history and doctor access',()=>{
  const x=setup();x.config.ratePerMinute=1;x.msg(501,'Первый');x.msg(501,'Второй');
  assert.equal(x.store.nextAi(),undefined);x.msg(501,'/doctor');assert.equal(x.store.current(501)?.state,'queued');
});

test('transaction rollback preserves inbox for recovery and creates no partial case',()=>{
  const x=setup();const create=x.store.create.bind(x.store);
  x.store.create=()=>{throw new Error('simulated database failure');};
  const u:Update={update_id:88,message:{message_id:88,chat:{id:501,type:'private'},from:{id:501},text:'Врач'}};
  assert.throws(()=>x.engine.handle(u));assert.equal(x.store.pendingUpdates().length,1);
  assert.equal(x.store.db.prepare('SELECT COUNT(*) n FROM conversations').get()!.n,0);
  x.store.create=create;x.engine.handle(u);assert.equal(x.store.pendingUpdates().length,0);
});

test('lock and persistent inbox/outbox survive restart',async()=>{
  const dir=join('var','restart-'+randomUUID());mkdirSync(dir,{recursive:true});const path=join(dir,'db.sqlite');
  let a=new Store(path);
  try {
    a.user(501,null,1);const c=a.create(501,1);
    a.out('sendMessage',{chat_id:501,text:'persistent'},c.id);
    a.ingest({update_id:9});a.close();a=new Store(path);
    assert.equal(a.get(c.id)?.state,'ai');assert.equal(a.pendingUpdates().length,1);assert.equal(a.offset(),10);
    const t=new MemoryTransport();await new DeliveryWorker(a,t).flush();
    assert.equal(t.sent.length,1);assert.equal(a.nextOutgoing(Date.now()),undefined);
  } finally {a.close();rmSync(dir,{recursive:true,force:true});}
});
