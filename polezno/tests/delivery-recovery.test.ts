import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store} from '../src/store.ts';
import {Engine} from '../src/engine.ts';
import {loadConfig} from '../src/config.ts';
import {DeliveryWorker,MemoryTransport,TelegramError} from '../src/telegram.ts';
import type {Update} from '../src/types.ts';

test('failed document holds later case history through restart and admin retry; other cases continue',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'polezno-delivery-'));
  const path=join(dir,'test.sqlite');
  let store=new Store(path);
  const config=loadConfig({MODE:'demo',DOCTOR_GROUP_ID:'-1001',DOCTOR_IDS:'101',ADMIN_IDS:'900'});
  let engine=new Engine(store,config);let sequence=0;
  function msg(id:number,text:string,extra:object={}):Update {
    const update:Update={update_id:++sequence,message:{message_id:sequence,chat:{id,type:'private'},from:{id},text,...extra}};
    engine.handle(update);return update;
  }
  function claim(id:string):void {
    engine.handle({update_id:++sequence,callback_query:{id:'test_'+sequence,from:{id:101},data:'claim:'+id,
      message:{message_id:500+sequence,chat:{id:-1001,type:'supergroup'}}}});
  }
  const transport=new MemoryTransport();
  let blocked=true;
  const fault={call:async(method:string,payload:Record<string,unknown>)=>{
    if(blocked&&method==='sendDocument'&&payload.document==='TEST_PDF')throw new TelegramError(403);
    return transport.call(method,payload);
  }};
  try {
    msg(101,'/start');
    msg(501,'Фото перед документом',{photo:[{file_id:'TEST_PHOTO'}]});
    msg(501,'Документ',{document:{file_id:'TEST_PDF'}});
    msg(501,'Текст после документа до приёма');
    const first=store.current(501)!;claim(first.id);
    let worker=new DeliveryWorker(store,fault);
    await worker.flush(100);
    const late=msg(501,'Уточнение после документа');
    msg(502,'/doctor');const second=store.current(502)!;claim(second.id);
    await worker.flush(100);
    assert.equal(store.stats().failed,1);
    assert(transport.sent.some(x=>x.method==='sendPhoto'&&x.payload.chat_id===101));
    assert(transport.sent.some(x=>x.payload.chat_id===101&&JSON.stringify(x.payload.reply_markup??{}).includes('close:'+second.id)),'other case must continue');
    assert(!transport.sent.some(x=>x.payload.chat_id===101&&String(x.payload.text).includes('Уточнение после документа')),
      'later messages must wait for the missing document');
    assert(!transport.sent.some(x=>x.payload.chat_id===101&&String(x.payload.text).includes('Текст после документа до приёма')),
      'the remainder of the first history must wait too');

    store.close();store=new Store(path);store.recover();engine=new Engine(store,config);
    assert.equal(engine.handle(late),false,'replayed update must not add a second relay');
    blocked=false;msg(900,'/retry');
    worker=new DeliveryWorker(store,fault);await worker.flush(100);
    const doctor=transport.sent.filter(x=>x.payload.chat_id===101);
    const documentIndex=doctor.findIndex(x=>x.method==='sendDocument'&&x.payload.document==='TEST_PDF');
    const lateIndex=doctor.findIndex(x=>String(x.payload.text).includes('Уточнение после документа'));
    const historyIndex=doctor.findIndex(x=>String(x.payload.text).includes('Текст после документа до приёма'));
    assert(documentIndex>=0&&historyIndex>documentIndex&&lateIndex>historyIndex);
    assert.equal(doctor.filter(x=>x.method==='sendPhoto'&&x.payload.photo==='TEST_PHOTO').length,1);
    assert.equal(doctor.filter(x=>x.method==='sendDocument'&&x.payload.document==='TEST_PDF').length,1);
    assert.equal(doctor.filter(x=>String(x.payload.text).includes('Уточнение после документа')).length,1);
    assert.equal(store.stats().failed,0);
    assert.equal(store.nextOutgoing(Date.now()),undefined);
    assert.equal(store.get(first.id)?.state,'doctor');
  }finally {
    store.close();
    assert(resolve(dir).startsWith(resolve(tmpdir())+'\\')||resolve(dir).startsWith(resolve(tmpdir())+'/'));
    rmSync(dir,{recursive:true,force:true});
  }
});

test('failed administrative notice does not block a case or unrelated messages',async()=>{
  const store=new Store(':memory:');
  try {
    store.user(501,null,1);const c=store.create(501,1);
    store.out('sendMessage',{chat_id:101,text:'notice'});
    const notice=store.nextOutgoing(Date.now())!;store.failure(notice.id,true,0);
    store.out('sendDocument',{chat_id:101,document:'TEST_PDF'},c.id,'history');
    const transport=new MemoryTransport();await new DeliveryWorker(store,transport).flush();
    assert.equal(transport.sent.length,1);assert.equal(transport.sent[0].method,'sendDocument');
  }finally{store.close();}
});
