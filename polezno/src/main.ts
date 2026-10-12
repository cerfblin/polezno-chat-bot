import {createServer} from 'node:http';
import type {Server} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from './config.ts';
import type {Config} from './types.ts';
import {Store} from './store.ts';
import {Engine} from './engine.ts';
import {Knowledge} from './knowledge.ts';
import {AiWorker,CompatibleAnswerer,ExtractiveAnswerer} from './ai.ts';
import {DeliveryWorker,Telegram,normalizeUpdate} from './telegram.ts';
import {acquireLock} from './lock.ts';
import {CatalogManager} from './catalog.ts';

export function healthServer(store:Store,ready:()=>boolean):Server {
  return createServer((request,response)=>{
    if(request.method!=='GET'||!['/health','/ready'].includes(request.url||'')) {response.writeHead(404).end();return;}
    const ok=request.url==='/health'||ready();
    response.writeHead(ok?200:503,{'content-type':'application/json','cache-control':'no-store'});
    response.end(JSON.stringify({status:ok?'ok':'not_ready',failedDeliveries:store.stats().failed}));
  });
}
export type RuntimeApi = {call(method:string,payload:Record<string,unknown>):Promise<any>;stop():void};
export async function main(options:{config?:Config;api?:RuntimeApi;signal?:AbortSignal}={}):Promise<void> {
  const config=options.config||loadConfig();
  if(config.mode==='demo') {
    console.log('Demo mode. Run "node scripts/demo.ts" for the complete offline scenario. Live mode requires .env settings.');
    return;
  }
  if(options.signal?.aborted)return;
  const unlock=acquireLock(config.databasePath);
  let store:Store|undefined;let server:Server|undefined;let api:RuntimeApi|undefined;
  let catalog:CatalogManager|undefined;
  let running=true;let connected=false;
  const stop=()=>{running=false;connected=false;api?.stop();catalog?.stop();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);options.signal?.addEventListener('abort',stop,{once:true});
  try {
    store=new Store(config.databasePath);store.recover();
    const knowledge=await Knowledge.load(config.knowledgePath,config.catalogPath,config.catalogMaxAgeDays);
    catalog=new CatalogManager(knowledge,config);
    await catalog.refresh();
    const engine=new Engine(store,config);
    api=options.api||new Telegram(config.token);
    const me=await api.call('getMe',{});
    const group=await api.call('getChat',{chat_id:config.groupId});
    if(!['group','supergroup'].includes(group.type))throw new Error('Doctor group must be a Telegram group');
    const member=await api.call('getChatMember',{chat_id:config.groupId,user_id:me.id});
    if(['left','kicked','restricted'].includes(member.status))throw new Error('Bot needs permission to send messages to doctor group');
    const webhook=await api.call('getWebhookInfo',{});
    if(webhook.url)throw new Error('A webhook is configured; remove it explicitly before using polling');
    const answerer=config.llmKey?new CompatibleAnswerer(config):new ExtractiveAnswerer();
    const ai=new AiWorker(store,engine,knowledge,answerer);
    const delivery=new DeliveryWorker(store,api,Date.now,(snapshot,now)=>knowledge.catalogEvidenceCurrent(snapshot,now));
    for(const update of store.pendingUpdates())engine.handle(update);
    connected=true;
    server=healthServer(store,()=>connected);
    await new Promise<void>((ok,bad)=>{server!.once('error',bad);server!.listen(config.port,'127.0.0.1',ok);});
    console.log(JSON.stringify({event:'started',mode:'live',llm:config.llmKey?config.llmProvider:'extractive',llmAnswerMode:config.llmAnswerMode,catalogProducts:knowledge.products.length}));
    const poll=async()=>{
      while(running) {
        try {
          for(const pending of store!.pendingUpdates())engine.handle(pending);
          const updates=await api!.call('getUpdates',{offset:store!.offset(),timeout:25,allowed_updates:['message','edited_message','callback_query']});
          connected=true;
          for(const raw of updates) {
            const update=normalizeUpdate(raw);
            store!.ingest(update);
            engine.handle(update);
          }
        }catch {
          if(!running)break;
          connected=false;console.error(JSON.stringify({event:'poll_failed'}));await delay(2000);
        }
      }
    };
    const answer=async()=>{
      while(running) {
        await ai.runOne();
        await delay(200);
      }
    };
    // Delivery must keep running while a slow model request is in flight.
    const deliver=async()=>{
      while(running) {
        await delivery.flush();
        await delay(200);
      }
    };
    const maintain=async()=>{
      let failed=false;
      while(running) {
        await catalog!.refresh();
        if(catalog!.failed&&!failed)console.error(JSON.stringify({event:'catalog_refresh_failed'}));
        failed=catalog!.failed;
        if(running)await delay(1000);
      }
    };
    await Promise.all([poll(),answer(),deliver(),maintain()]);
  } finally {
    running=false;api?.stop();catalog?.stop();
    if(server)await new Promise<void>(ok=>server!.close(()=>ok()));
    store?.close();unlock();
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);options.signal?.removeEventListener('abort',stop);
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  await main().catch(()=>{console.error('Startup/runtime failed. Check configuration, database access and connectivity. Secrets and request bodies are omitted.');process.exitCode=1;});
}


