import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';
import {Engine} from '../src/engine.ts';
import {loadConfig} from '../src/config.ts';
import {MENU} from '../src/ui.ts';
import type {TgMessage,Update} from '../src/types.ts';

const stores:Store[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();});
function setup() {
  const store=new Store(':memory:');stores.push(store);
  const config=loadConfig({MODE:'demo',DOCTOR_GROUP_ID:'-1001',DOCTOR_IDS:'101,102',ADMIN_IDS:'101,900'});
  const engine=new Engine(store,config,()=>Date.parse('2026-10-12T10:00:00Z'));
  let next=0;
  const msg=(id:number,text:string,extra:Partial<TgMessage>={},edited=false,messageId?:number)=>{
    const update:Update={update_id:++next};
    update[edited?'edited_message':'message']={message_id:messageId??next,chat:{id,type:'private'},from:{id},text,...extra};
    engine.handle(update);return update;
  };
  const click=(doctor:number,data:string,chat=doctor,type='private')=>engine.handle({update_id:++next,callback_query:{id:'cb'+next,from:{id:doctor},data,message:{message_id:500+next,chat:{id:chat,type}}}});
  const claim=(id:string,doctor=101)=>click(doctor,'claim:'+id,-1001,'supergroup');
  const payloads=()=> (store.db.prepare('SELECT payload FROM outbox ORDER BY id').all() as {payload:string}[]).map(x=>JSON.parse(x.payload));
  return {store,engine,msg,click,claim,payloads};
}

test('user menu navigation creates no consultation or AI work and preserves attribution',()=>{
  const x=setup();x.msg(501,'/start partner_ui');
  const home=x.payloads().at(-1);
  assert.deepEqual(home.reply_markup.keyboard.flat().map((b:{text:string})=>b.text),[MENU.ask,MENU.doctor,MENU.status,MENU.help]);
  for(const button of [MENU.ask,MENU.help,MENU.status])x.msg(501,button);
  assert.equal(x.store.current(501),undefined);assert.equal(x.store.nextAi(),undefined);
  x.msg(501,'Что такое витамин D?');
  const c=x.store.current(501)!;
  assert.equal(c.source,'partner_ui');assert.equal(x.store.history(c.id).length,1);
  const version=c.version;
  for(const button of [MENU.ask,MENU.help,MENU.status])x.msg(501,button);
  assert.equal(x.store.get(c.id)?.version,version);assert.equal(x.store.history(c.id).length,1);
});

test('doctor button queues once; navigation never relays to doctor or reopens active dialogue',()=>{
  const x=setup();x.msg(101,'/start');x.msg(501,MENU.doctor);const c=x.store.current(501)!;
  assert.equal(c.state,'queued');assert.equal(x.store.nextAi(),undefined);
  const length=x.store.history(c.id).length;
  for(const button of [MENU.doctor,MENU.status,MENU.help,MENU.ask])x.msg(501,button);
  assert.equal(x.store.history(c.id).length,length);
  assert.equal(x.payloads().filter(p=>p.chat_id===-1001).length,1);
  x.claim(c.id);const claimedLength=x.store.history(c.id).length;
  const relays=()=>Number(x.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE category='relay'").get()!.n);
  for(const button of [MENU.doctor,MENU.status,MENU.help,MENU.ask])x.msg(501,button);
  assert.equal(x.store.history(c.id).length,claimedLength);assert.equal(relays(),0);assert.equal(x.store.get(c.id)?.state,'doctor');
});

test('doctor case buttons select only owned active cases and navigation is not a patient reply',()=>{
  const x=setup();x.msg(101,'/start');x.msg(102,'/start');
  x.msg(501,MENU.doctor);const a=x.store.current(501)!;x.claim(a.id);
  x.msg(502,MENU.doctor);const b=x.store.current(502)!;x.claim(b.id);
  const before=x.store.history(b.id).length;
  for(const button of [MENU.cases,MENU.help,MENU.stats,MENU.status])x.msg(101,button);
  assert.equal(x.store.history(b.id).length,before);
  x.click(102,'select:'+a.id);assert.equal(x.store.selected(102),undefined);
  x.click(501,'select:'+a.id);x.click(101,'select:'+a.id,-1001,'supergroup');
  assert.equal(x.store.selected(101),b.id);
  x.click(101,'select:'+a.id);assert.equal(x.store.selected(101),a.id);
  x.msg(101,'Ответ в выбранное обращение');
  const relay=x.store.db.prepare("SELECT payload FROM outbox WHERE category='relay' ORDER BY id DESC LIMIT 1").get() as {payload:string};
  assert.equal(JSON.parse(relay.payload).chat_id,501);
  x.msg(101,'/close');x.click(101,'select:'+a.id);assert.equal(x.store.selected(101),undefined);
});

test('close confirmation and cancellation preserve state; finish targets the card, not selected case',()=>{
  const x=setup();x.msg(101,'/start');x.msg(102,'/start');
  x.msg(501,MENU.doctor);const a=x.store.current(501)!;x.claim(a.id);
  x.msg(502,MENU.doctor);const b=x.store.current(502)!;x.claim(b.id);
  x.click(101,'close:'+a.id);assert.equal(x.store.get(a.id)?.state,'doctor');
  x.click(101,'keep:'+a.id);assert.equal(x.store.get(a.id)?.state,'doctor');assert.equal(x.store.selected(101),b.id);
  x.click(102,'finish:'+a.id);x.click(501,'finish:'+a.id);x.click(101,'finish:'+a.id,-1001,'supergroup');
  assert.equal(x.store.get(a.id)?.state,'doctor');
  x.click(101,'close:'+a.id);x.click(101,'finish:'+a.id);
  assert.equal(x.store.get(a.id)?.state,'closed');assert.equal(x.store.get(b.id)?.state,'doctor');assert.equal(x.store.selected(101),b.id);
  const closed=x.payloads().filter(p=>p.chat_id===501&&p.text?.includes('Консультация завершена'));
  x.click(101,'finish:'+a.id);assert.equal(closed.length,1);
  assert.equal(x.payloads().filter(p=>p.chat_id===501&&p.text?.includes('Консультация завершена')).length,1);
  x.msg(501,MENU.ask);assert.equal(x.store.current(501),undefined);
  x.msg(501,'Новый вопрос');assert.notEqual(x.store.current(501)?.id,a.id);
});

test('role menus hide admin actions from doctors and users; typed admin labels stay forbidden',()=>{
  const x=setup();
  for(const id of [101,102,900])x.msg(id,'/start');
  const labels=(id:number)=>x.payloads().find(p=>p.chat_id===id).reply_markup.keyboard.flat().map((b:{text:string})=>b.text);
  assert(labels(101).includes(MENU.cases));assert(labels(101).includes(MENU.stats));assert(!labels(102).includes(MENU.stats));assert(!labels(900).includes(MENU.cases));
  x.msg(501,MENU.retry);x.msg(501,MENU.stats);x.msg(102,MENU.retry);x.msg(102,MENU.stats);
  assert(!x.payloads().some(p=>[501,102].includes(p.chat_id)&&p.text?.includes('Статистика обращений')));
  assert.equal(x.store.current(501),undefined);
});

test('media captions and edited text resembling navigation remain in original case',()=>{
  const x=setup();x.msg(101,'/start');x.msg(501,MENU.doctor);const a=x.store.current(501)!;x.claim(a.id);
  x.msg(101,'',{caption:MENU.help,document:{file_id:'DOC_UI'}});
  const original=x.msg(101,'Первый ответ');
  x.msg(502,MENU.doctor);const b=x.store.current(502)!;x.claim(b.id);
  x.msg(101,MENU.cases,{},true,original.message!.message_id);
  const payloads=x.payloads();
  assert(payloads.some(p=>p.chat_id===501&&p.document==='DOC_UI'&&p.caption.includes(MENU.help)));
  assert(payloads.some(p=>p.chat_id===501&&p.text?.includes(MENU.cases)&&p.text.includes('[Правка сообщения]')));
  assert(!x.store.history(b.id).some(m=>m.role==='doctor'));
});

test('case list pagination is bounded, contains no patient identifiers and validates callbacks',()=>{
  const x=setup();x.msg(101,'/start');
  const ids=[];
  for(let i=0;i<10;i++) {x.msg(500+i,MENU.doctor);const c=x.store.current(500+i)!;ids.push(c.id);x.claim(c.id);}
  x.msg(101,MENU.cases);
  const first=x.payloads().at(-1);
  assert.equal(first.reply_markup.inline_keyboard.length,9);
  assert(first.reply_markup.inline_keyboard.flat().some((b:{callback_data:string})=>b.callback_data==='cases:1'));
  x.click(101,'cases:1');
  const second=x.payloads().at(-2);
  assert.equal(second.reply_markup.inline_keyboard.length,3);
  assert.equal(second.reply_markup.inline_keyboard[0][0].callback_data,'select:'+ids[8]);
  x.click(101,'cases:-1');assert.equal(x.payloads().at(-1).text,'Недоступное действие.');
  for(const p of [first,second]) {
    assert(!/500|501|502/.test(p.text));
    for(const b of p.reply_markup.inline_keyboard.flat())assert(Buffer.byteLength(b.callback_data)<=64);
  }
});
