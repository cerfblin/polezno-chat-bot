import {Store} from './store.ts';
import {Engine} from './engine.ts';
import {Knowledge} from './knowledge.ts';
import {AiWorker} from './ai.ts';
import type {Answerer} from './ai.ts';
import {DeliveryWorker,MemoryTransport} from './telegram.ts';
import type {AiAnswer,Config,Evidence,TgMessage} from './types.ts';

export type ScenarioResult={id:string;passed:boolean;checks:Record<string,boolean>;llmCalls:number};
// Synthetic fixtures only: no live Telegram connection, database or patient history.
const scenarios:{id:string;steps:Partial<TgMessage>[];state:string;calls:number;sources?:string[];followUp?:boolean}[]=[
  {id:'general-supplements',steps:[{text:'Что такое пищевые добавки?'}],state:'ai',calls:1,sources:['nih-supplements']},
  {id:'vitamin-d-follow-up',steps:[{text:'Для чего нужен витамин D?'},{text:'А в каких продуктах он содержится?'}],state:'ai',calls:2,sources:['ods-vitamin-d'],followUp:true},
  {id:'magnesium-food',steps:[{text:'В каких продуктах содержится магний?'}],state:'ai',calls:1,sources:['ods-magnesium']},
  {id:'unknown-product',steps:[{text:'Есть ли СуперНутриXYZ в наличии?'}],state:'ai',calls:0},
  {id:'personal-intake-and-pause',steps:[{text:'Как принимать витамин D?'},{text:'А что такое витамин D?'}],state:'queued',calls:0},
  {id:'medical-file',steps:[{document:{file_id:'SYNTHETIC_FILE_NOT_SENT_TO_TELEGRAM'},caption:'Документ для консультации'}],state:'queued',calls:0},
  {id:'shop-stays-in-miniapp',steps:[{text:'Как узнать статус заказа?'}],state:'ai',calls:0}
];
export async function evaluateScenarios(config:Config,knowledge:Knowledge,answerer:Answerer):Promise<ScenarioResult[]> {
  const results:ScenarioResult[]=[];
  for(const scenario of scenarios) {
    const store=new Store(':memory:');
    const engine=new Engine(store,{...config,mode:'demo',token:'',databasePath:':memory:',doctorIds:[101],adminIds:[900],groupId:-1001});
    const transport=new MemoryTransport();const delivery=new DeliveryWorker(store,transport);
    const observations:{history:{role:string;content:string}[];answer?:AiAnswer}[]=[];
    const counted:Answerer={answer:async(history,evidence:Evidence[])=>{
      const observation:{history:{role:string;content:string}[];answer?:AiAnswer}={history};observations.push(observation);
      observation.answer=await answerer.answer(history,evidence);return observation.answer;
    }};
    const worker=new AiWorker(store,engine,knowledge,counted);
    try {
      let id=0;
      for(const step of scenario.steps) {
        engine.handle({update_id:++id,message:{message_id:id,chat:{id:501,type:'private'},from:{id:501},...step}});
        while(await worker.runOne()) { /* process only this in-memory inbox */ }
        await delivery.flush(100);
      }
      const checks:Record<string,boolean>={
        state:store.current(501)?.state===scenario.state,
        llmCalls:observations.length===scenario.calls,
        evidence:!scenario.sources||observations.length===scenario.calls&&observations.every(o=>o.answer?.action==='answer'&&scenario.sources!.some(id=>o.answer?.sourceIds.includes(id))),
        deliveredSources:!scenario.sources||transport.sent.some(x=>String(x.payload.text).includes('Источники:')),
        context:!scenario.followUp||observations.at(-1)?.history.some(x=>x.role==='user'&&x.content.includes('Для чего нужен витамин D?'))===true&&observations.at(-1)?.history.some(x=>x.role==='assistant')===true,
        noProductIds:observations.every(o=>!o.answer?.productIds.length)
      };
      if(scenario.id==='unknown-product')checks.clarification=transport.sent.some(x=>String(x.payload.text).includes('Уточните вопрос'));
      if(scenario.id==='medical-file')checks.filePreserved=store.history(store.current(501)!.id).some(x=>JSON.parse(x.content).fileId==='SYNTHETIC_FILE_NOT_SENT_TO_TELEGRAM');
      if(scenario.id==='shop-stays-in-miniapp')checks.miniApp=transport.sent.some(x=>String(x.payload.text).includes('Mini App'));
      results.push({id:scenario.id,passed:Object.values(checks).every(Boolean),checks,llmCalls:observations.length});
    } finally {store.close();}
  }
  return results;
}
