// Bounded, offline acceptance. Never loads .env or opens the production database.
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {performance} from 'node:perf_hooks';
import {Store} from '../src/store.ts';
import {Engine} from '../src/engine.ts';
import {loadConfig} from '../src/config.ts';
import {DeliveryWorker,TelegramError} from '../src/telegram.ts';
import type {Update} from '../src/types.ts';

const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--output'))throw new Error('Usage: node scripts/check-load.ts [--output report.json]');
const started=performance.now();
const dir=await mkdtemp(join(tmpdir(),'polezno-load-'));
let store:Store|undefined;
try {
  const databasePath=join(dir,'synthetic.sqlite');
  const config=loadConfig({MODE:'demo',DOCTOR_GROUP_ID:'-1001',DOCTOR_IDS:'101,102',ADMIN_IDS:'900',DATABASE_PATH:databasePath});
  store=new Store(databasePath);
  let clock=Date.parse('2026-10-12T09:00:00Z');let sequence=0;
  let engine=new Engine(store,config,()=>clock);
  const message=(user:number,text:string,extra:object={}):Update=>{
    const update:Update={update_id:++sequence,message:{message_id:sequence,chat:{id:user,type:'private'},from:{id:user},text,...extra}};
    engine.handle(update);return update;
  };
  const historicalRows=10000,conversations=100;
  store.tx(()=>{
    const insert=store!.db.prepare("INSERT INTO outbox(method,payload,category,destination,status) VALUES('sendMessage',?,'general',?,'sent')");
    for(let i=0;i<historicalRows;i++)insert.run('{"text":"synthetic old delivery"}',String(i%2?101:102));
  });
  message(101,'/start');message(102,'/start');
  const expectedFiles=new Map<string,{doctor:number;caseId:string}>();
  const replay:Update[]=[];
  for(let i=0;i<conversations;i++) {
    const user=10001+i,doctor=i%2?101:102;
    message(user,'/start partner_load');message(user,'/doctor');
    const photo='LOAD_PHOTO_'+i,document='LOAD_PDF_'+i;
    message(user,'Синтетическое фото',{photo:[{file_id:photo}]});
    replay.push(message(user,'Синтетический PDF',{document:{file_id:document}}));
    message(user,'Дополнение '+i);
    const c=store.current(user)!;
    expectedFiles.set(photo,{doctor,caseId:c.id});expectedFiles.set(document,{doctor,caseId:c.id});
    engine.handle({update_id:++sequence,callback_query:{id:'load_'+i,from:{id:doctor},data:'claim:'+c.id,
      message:{message_id:2000+i,chat:{id:-1001,type:'supergroup'}}}});
  }
  const rowsBefore=Number(store.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n);
  for(const update of replay)assert.equal(engine.handle(update),false);
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n),rowsBefore);
  const attempted=new Set<string>(),delivered=new Set<string>();
  const completedOrder=new Map<string,string[]>();
  let requests=0,temporaryErrors=0,permanentErrors=0,messageId=50000;
  const transport={call:async(method:string,payload:Record<string,unknown>)=>{
    requests++;
    if(method==='sendDocument'||method==='sendPhoto') {
      const fileId=String(payload.document||payload.photo);
      const target=expectedFiles.get(fileId);assert(target,'unknown synthetic file');
      assert.equal(payload.chat_id,target.doctor,'file must reach its assigned doctor');
      if(method==='sendDocument'&&!attempted.has(fileId)) {
        attempted.add(fileId);
        if(Number(fileId.split('_').at(-1))%25===0) {permanentErrors++;throw new TelegramError(403);}
        temporaryErrors++;throw new TelegramError(429,1);
      }
      assert(!delivered.has(fileId),'successful file delivery must not repeat');delivered.add(fileId);
      const order=completedOrder.get(target.caseId)||[];order.push(fileId);completedOrder.set(target.caseId,order);
    }
    return {message_id:++messageId};
  }};
  let worker=new DeliveryWorker(store,transport,()=>clock);
  await worker.flush(50);
  store.close();store=new Store(databasePath);store.recover();
  engine=new Engine(store,config,()=>clock);worker=new DeliveryWorker(store,transport,()=>clock);
  for(const update of replay)assert.equal(engine.handle(update),false);
  async function drain():Promise<void> {
    for(let round=0;round<conversations*2;round++) {
      assert(performance.now()-started<60000,'Offline load check exceeded its 60-second resource budget');
      await worker.flush(1000);
      assert(performance.now()-started<60000,'Offline load check exceeded its 60-second resource budget');
      const future=Number(store!.db.prepare("SELECT COUNT(*) n FROM outbox WHERE status='pending' AND next_at>?").get(clock)!.n);
      if(!future)return;
      clock+=1001;
    }
    throw new Error('Synthetic queue did not settle within its bounded retry rounds');
  }
  await drain();assert.equal(store.stats().failed,4);
  message(900,'/retry');await drain();
  assert.equal(store.stats().failed,0);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE status='pending'").get()!.n),0);
  assert.equal(delivered.size,conversations*2);
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) n FROM audit WHERE event='claimed'").get()!.n),conversations);
  for(const [file,target] of expectedFiles)if(file.startsWith('LOAD_PDF_')) {
    const order=completedOrder.get(target.caseId)!;
    assert(order.indexOf(file)>order.indexOf(file.replace('PDF','PHOTO')));
  }
  const report={passed:true,scope:'Offline synthetic SQLite/Engine/DeliveryWorker; no Telegram, LLM or production data',
    conversations,historicalSentRows:historicalRows,deliveredFiles:delivered.size,requests,temporaryErrors,permanentErrors,
    restartTested:true,adminRetryTested:true,duplicateUpdatesSuppressed:replay.length*2,
    wrongRecipientFiles:0,duplicateSuccessfulFiles:0,pendingDeliveries:0,failedDeliveries:0,
    durationMs:Math.round(performance.now()-started),limitation:'Not a measurement of Telegram/LLM throughput or production capacity'};
  if(args[1])await writeFile(resolve(args[1]),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally {
  store?.close();
  assert(resolve(dir).startsWith(resolve(tmpdir())+sep));
  await rm(dir,{recursive:true,force:true});
}
