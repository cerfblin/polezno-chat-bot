import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,utimes,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {CatalogManager} from '../src/catalog.ts';
import {Knowledge,importCatalog} from '../src/knowledge.ts';
import {loadConfig} from '../src/config.ts';
import {Store} from '../src/store.ts';
import {Engine} from '../src/engine.ts';
import {AiWorker} from '../src/ai.ts';
import {DeliveryWorker,MemoryTransport} from '../src/telegram.ts';
import type {Config,KnowledgeItem,Product,AiAnswer} from '../src/types.ts';

const now=Date.parse('2026-10-12T09:00:00Z');
const item:KnowledgeItem={id:'k1',title:'Справочный материал',text:'Общая справка.',url:'https://example.org/info',keywords:['справка'],enabled:true,reviewedBy:'test',checkedAt:'2026-10-12',clinicianReviewed:false};
const product:Product={id:'p1',name:'Тестовый товар',description:'Тестовая карточка, не для продажи.',composition:'Пример состава',purpose:'Пример назначения',restrictions:'Пример ограничений',usage:'По согласованию с врачом',inStock:true,url:'https://example.org/product',updatedAt:'2026-10-12T00:00:00Z',approved:true};
const answer:AiAnswer={action:'answer',text:'Тестовая карточка, не для продажи.',sourceIds:[],productIds:['p1']};
async function fixture(run:(config:Config,knowledge:Knowledge,dir:string)=>Promise<void>):Promise<void> {
  const dir=await mkdtemp(join(tmpdir(),'polezno-catalog-'));
  try {
    const config=loadConfig({MODE:'demo',CATALOG_PATH:join(dir,'catalog.json'),DATABASE_PATH:join(dir,'db.sqlite'),DOCTOR_IDS:'101',ADMIN_IDS:'900'});
    await writeFile(config.catalogPath,'[]');
    await run(config,new Knowledge([item],[]),dir);
  }finally{assert(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});}
}

test('local catalog reloads without API requests or restart; malformed replacement retains validated memory',async()=>{
  await fixture(async(config,k)=>{
    let calls=0;
    const manager=new CatalogManager(k,config,async()=>{calls++;throw new Error('Unexpected request');});
    assert(await manager.refresh(now));
    await writeFile(config.catalogPath,JSON.stringify([product]));
    await utimes(config.catalogPath,new Date(),new Date(now+1000));
    assert(await manager.refresh(now+1000));assert.equal(k.search('Тестовый товар',now)[0]?.id,'p1');
    await writeFile(config.catalogPath,'[{"broken":true}]');
    await utimes(config.catalogPath,new Date(),new Date(now+2000));
    assert.equal(await manager.refresh(now+2000),false);assert.equal(manager.failed,true);
    assert.equal(k.products[0].id,'p1');assert.equal(calls,0);
  });
});

test('periodic source validates cross IDs before publish and keeps previous file on a bad export',async()=>{
  await fixture(async(config,k)=>{
    config.catalogSource='https://example.org/export';config.catalogSyncSeconds=60;
    let calls=0;let exported:unknown=[product];
    const manager=new CatalogManager(k,config,async(_url,init)=>{
      calls++;assert.equal(init?.redirect,'error');assert(init?.signal);
      return new Response(JSON.stringify(exported));
    });
    assert(await manager.refresh(now));assert.equal(calls,1);assert.equal(k.products.length,1);
    assert(await manager.refresh(now+1000));assert.equal(calls,1);
    const previous=await readFile(config.catalogPath,'utf8');
    exported=[{...product,id:'k1'}];
    assert.equal(await manager.refresh(now+60000),false);assert.equal(calls,2);
    assert.equal(await readFile(config.catalogPath,'utf8'),previous);assert.equal(k.products[0].id,'p1');
    assert.deepEqual((await readdir(resolve(config.catalogPath,'..'))).filter(x=>x.endsWith('.tmp')),[]);
    exported=[{...product,inStock:false}];
    assert(await manager.refresh(now+120000));assert.equal(k.search('Тестовый товар',now).length,0);
  });
});

test('catalog shutdown aborts a source request and overlapping refreshes never duplicate it',async()=>{
  await fixture(async(config,k)=>{
    config.catalogSource='https://example.org/export';let calls=0;
    const manager=new CatalogManager(k,config,async(_url,init)=>{
      calls++;
      return await new Promise<Response>((_ok,bad)=>{init!.signal!.addEventListener('abort',()=>bad(new Error('Aborted')),{once:true});});
    });
    const pending=manager.refresh(now);
    assert.equal(await manager.refresh(now),false);assert.equal(calls,1);
    manager.stop();assert.equal(await pending,false);
    assert.equal(await manager.refresh(now+60000),false);assert.equal(calls,1);
    assert.equal(await readFile(config.catalogPath,'utf8'),'[]');
  });
});

test('source options reject HTTP, credentials, unsupported schemes and an excessive refresh frequency',()=>{
  for(const env of [{CATALOG_SOURCE:'http://example.org/data'},{CATALOG_SOURCE:'https://user:secret@example.org/data'},{CATALOG_SOURCE:'ftp://example.org/data'},{CATALOG_SYNC_SECONDS:'5'}])assert.throws(()=>loadConfig(env));
  assert.equal(loadConfig({}).catalogSource,'');assert.equal(loadConfig({CATALOG_SOURCE:'C:\\catalog\\data.json'}).catalogSource,'C:\\catalog\\data.json');
});

test('catalog evidence rejects withdrawn, expired, unapproved or changed product information',()=>{
  const k=new Knowledge([],[product]);const snapshot=k.productEvidence(now);
  assert(k.catalogEvidenceCurrent(snapshot,now));
  for(const changed of [{...product,inStock:false},{...product,approved:false},{...product,restrictions:'Изменённые ограничения'},{...product,url:'https://example.org/new'},{...product,name:'Другое название'},{...product,updatedAt:'2027-01-01'}]) {
    k.products=[changed];assert.equal(k.catalogEvidenceCurrent(snapshot,now),false);
  }
  k.products=[product];assert.equal(k.catalogEvidenceCurrent(snapshot,now+8*86400000),false);
});

test('product answer is checked again after DB restart and stale split response becomes one clarification',async()=>{
  await fixture(async(config,k)=>{
    k.products=[product];let store=new Store(config.databasePath);
    try {
      const engine=new Engine(store,config,()=>now);
      engine.handle({update_id:1,message:{message_id:1,from:{id:501},chat:{id:501,type:'private'},text:'Тестовый товар'}});
      let release!:(answer:AiAnswer)=>void;
      const ai=new AiWorker(store,engine,k,{answer:async()=>await new Promise(ok=>{release=ok;})});
      const pending=ai.runOne();k.products=[];
      release({...answer,text:'Тестовая карточка. '.repeat(500)});await pending;
      assert(Number(store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE category='ai'").get()!.n)>1);
      const id=store.current(501)!.id;
      store.close();store=new Store(config.databasePath);
      const transport=new MemoryTransport();
      await new DeliveryWorker(store,transport,()=>now,(s,t)=>k.catalogEvidenceCurrent(s,t)).flush(100);
      assert.equal(transport.sent.length,1);
      assert(String(transport.sent[0].payload.text).includes('Информация о товарах обновилась'));
      assert(!JSON.stringify(transport.sent).includes('example.org/product'));
      assert(!JSON.stringify(transport.sent).includes('__poleznoCatalog'));
      assert.equal(store.history(id).filter(x=>x.role==='assistant').length,1);
      assert.equal(store.stats().failed,0);
    }finally{store.close();}
  });
});

test('current catalog produces a linked product answer and never exposes internal evidence to Telegram',async()=>{
  await fixture(async(config,k)=>{
    config.catalogSource='https://example.org/export';
    const manager=new CatalogManager(k,config,async()=>new Response(JSON.stringify([product])));
    assert(await manager.refresh(now));
    const store=new Store(':memory:');
    try {
      const engine=new Engine(store,config,()=>now);let calls=0;
      const ai=new AiWorker(store,engine,k,{answer:async()=>{calls++;return answer;}});
      const transport=new MemoryTransport();
      const delivery=new DeliveryWorker(store,transport,()=>now,(s,t)=>k.catalogEvidenceCurrent(s,t));
      engine.handle({update_id:1,message:{message_id:1,from:{id:501},chat:{id:501,type:'private'},text:'Тестовый товар'}});
      await ai.runOne();await delivery.flush();assert.equal(calls,1);
      assert(String(transport.sent[0].payload.text).includes(product.url));assert(!('__poleznoCatalog' in transport.sent[0].payload));
      k.products=[];
      engine.handle({update_id:2,message:{message_id:2,from:{id:501},chat:{id:501,type:'private'},text:'Тестовый товар'}});
      await ai.runOne();await delivery.flush();assert.equal(calls,1,'withdrawn product must not lead to another model request');
      assert(!String(transport.sent.at(-1)!.payload.text).includes(product.url));
    }finally{store.close();manager.stop();}
  });
});

test('a destination publish failure cleans its temporary file and preserves existing destination',async()=>{
  await fixture(async(config,_k,dir)=>{
    const source=join(dir,'source.json');await writeFile(source,JSON.stringify([product]));
    const before=await readdir(dir);
    await assert.rejects(importCatalog(source,dir));
    assert.deepEqual((await readdir(dir)).sort(),before.sort());
  });
});
