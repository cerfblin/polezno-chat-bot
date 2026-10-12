import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/config.ts';
import {Store} from '../src/store.ts';
import {Engine} from '../src/engine.ts';
import {Knowledge} from '../src/knowledge.ts';
import {AiWorker,ExtractiveAnswerer} from '../src/ai.ts';
import {MemoryTransport,DeliveryWorker} from '../src/telegram.ts';
import type {Update} from '../src/types.ts';
const root=fileURLToPath(new URL('..',import.meta.url));
const config=loadConfig({MODE:'demo',DOCTOR_IDS:'101,102',ADMIN_IDS:'900',DOCTOR_GROUP_ID:'-1001'},root);
const store=new Store(':memory:');const engine=new Engine(store,config);
const knowledge=await Knowledge.load(config.knowledgePath,config.catalogPath);
const ai=new AiWorker(store,engine,knowledge,new ExtractiveAnswerer());
const transport=new MemoryTransport();const delivery=new DeliveryWorker(store,transport);
let updateId=0;
function message(id:number,text:string,extra:object={}):void {engine.handle({update_id:++updateId,message:{message_id:updateId,chat:{id,type:'private'},from:{id},text,...extra}});}
async function flush():Promise<void> {while(await ai.runOne()){}while(await delivery.flush(1000)){}}
message(101,'/start');message(501,'/start partner_demo');
message(501,'Что такое пищевые добавки?');await flush();
message(501,'Передаю документ врачу',{document:{file_id:'demo_document'}});await flush();
const first=store.current(501)!;
engine.handle({update_id:++updateId,callback_query:{id:'demo_claim',from:{id:101},data:'claim:'+first.id,message:{message_id:1,chat:{id:-1001,type:'supergroup'}}}} satisfies Update);
await flush();
message(101,'Документ получен. Уточните ваш вопрос.');message(501,'Спасибо');await flush();
message(101,'/close');message(501,'Что такое здоровое питание?');await flush();
const next=store.current(501)!;
console.log(JSON.stringify({
  mode:'offline',networkRequests:0,
  checks:{doctorAccepted:store.get(first.id)?.doctor_id===101,firstClosed:store.get(first.id)?.state==='closed',newConversation:next.id!==first.id,newConversationAi:next.state==='ai',fileDelivered:transport.sent.some(x=>x.method==='sendDocument'),aiAnswered:transport.sent.some(x=>String(x.payload.text||'').includes('Источники:'))},
  sentMessages:transport.sent.length,statistics:store.stats()
},null,2));
store.close();
