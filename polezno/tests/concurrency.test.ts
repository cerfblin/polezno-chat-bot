import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdirSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.ts';

test('two simultaneous workers compete using the actual Store.claim implementation',async()=>{
  const dir=resolve('var','concurrent-'+randomUUID());mkdirSync(dir,{recursive:true});
  const path=join(dir,'db.sqlite');const store=new Store(path);
  const workers:Worker[]=[];
  try {
    store.user(501,null,1);const c=store.create(501,1);store.queue(c.id,1);
    const code=[
      "const {parentPort,workerData}=require('node:worker_threads');",
      "(async()=>{const {Store}=await import(workerData.module);const store=new Store(workerData.path);",
      "parentPort.postMessage('ready');",
      "parentPort.once('message',()=>{try {const won=store.tx(()=>store.claim(workerData.id,workerData.doctor,2));parentPort.postMessage({won});}catch(e){parentPort.postMessage({error:String(e)});}finally{store.close();}});",
      "})();"
    ].join('\n');
    for(const doctor of [101,102])workers.push(new Worker(code,{eval:true,workerData:{module:new URL('../src/store.ts',import.meta.url).href,path,id:c.id,doctor}}));
    const ready=workers.map(w=>new Promise<void>((ok,bad)=>{w.once('message',m=>m==='ready'?ok():bad(new Error('Worker not ready')));w.once('error',bad);}));
    await Promise.all(ready);
    const results=workers.map(w=>new Promise<{won?:boolean;error?:string}>((ok,bad)=>{w.once('message',ok);w.once('error',bad);}));
    for(const w of workers)w.postMessage('claim');
    const values=await Promise.all(results);
    assert(values.every(x=>!x.error));assert.equal(values.filter(x=>x.won).length,1);
    assert([101,102].includes(store.get(c.id)!.doctor_id!));
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audit WHERE event='claimed'").get()!.n,1);
  }finally{
    await Promise.all(workers.map(w=>w.terminate()));store.close();rmSync(dir,{recursive:true,force:true});
  }
});
