import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,rmSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {main} from '../src/main.ts';
import {loadConfig} from '../src/config.ts';
import {Store} from '../src/store.ts';
import type {Update} from '../src/types.ts';

test('runtime polling + AI + relay + close + restartable state + graceful shutdown without external network',async()=>{
  const dir=resolve('var','runtime-'+randomUUID());mkdirSync(dir,{recursive:true});
  const root=fileURLToPath(new URL('..',import.meta.url));
  const config=loadConfig({MODE:'live',TELEGRAM_BOT_TOKEN:'123:THIS_IS_A_FAKE_TEST_TOKEN_12345',DOCTOR_GROUP_ID:'-1001',DOCTOR_IDS:'101',ADMIN_IDS:'900',DATABASE_PATH:join(dir,'db.sqlite')},root);
  config.port=0;
  const abort=new AbortController();let updateId=0;let messageId=100;let stage=0;let answerCount=0;let doctorFiles=0;
  let stopped=false;let waiting:((updates:Update[])=>void)|undefined;
  const messages:Record<string,unknown>[]=[];
  const queue:Update[]=[];
  function msg(id:number,text:string,extra:object={}):Update {return {update_id:++updateId,message:{message_id:updateId,chat:{id,type:'private'},from:{id},text,...extra}};}
  function enqueue(...updates:Update[]):void {
    queue.push(...updates);
    if(waiting){const resolve=waiting;waiting=undefined;resolve(queue.splice(0));}
  }
  enqueue(msg(101,'/start'),msg(501,'/start partner_runtime'),msg(501,'Что такое пищевые добавки?'));
  const fake={
    async call(method:string,payload:Record<string,unknown>):Promise<any> {
      if(method==='getMe')return {id:99999};
      if(method==='getChat')return {type:'supergroup'};
      if(method==='getChatMember')return {status:'member'};
      if(method==='getWebhookInfo')return {url:''};
      if(method==='getUpdates'){
        if(stopped)return [];
        if(queue.length)return queue.splice(0);
        return await new Promise<Update[]>(ok=>{waiting=ok;});
      }
      messages.push({method,...payload});
      if(method==='sendMessage'&&payload.chat_id===501&&String(payload.text).includes('Источники:')){
        answerCount++;
        if(stage===0){stage=1;enqueue(msg(501,'Документ',{document:{file_id:'RUNTIME_DOC'}}));}
        else if(stage===3){stage=4;abort.abort();}
      }
      if(method==='sendMessage'&&payload.chat_id===-1001&&stage===1){
        const data=(payload.reply_markup as any).inline_keyboard[0][0].callback_data;
        stage=2;
        enqueue({update_id:++updateId,callback_query:{id:'runtime_claim',from:{id:101},data,message:{message_id:messageId,chat:{id:-1001,type:'supergroup'}}}});
      }
      if(method==='sendDocument'&&payload.chat_id===101){doctorFiles++;enqueue(msg(101,'Документ получен. Уточните вопрос.'));}
      if(method==='sendMessage'&&payload.chat_id===501&&String(payload.text).includes('Документ получен')){
        stage=3;enqueue(msg(101,'/close'),msg(501,'Что такое здоровое питание?'));
      }
      return {message_id:++messageId};
    },
    stop(){stopped=true;if(waiting){const ok=waiting;waiting=undefined;ok([]);}}
  };
  const timeout=setTimeout(()=>abort.abort(),5000);
  try {
    await main({config,api:fake,signal:abort.signal});
    assert.equal(stage,4);assert.equal(answerCount,2);assert.equal(doctorFiles,1);assert(stopped);
    assert(!existsSync(config.databasePath+'.lock.pid'));
    const store=new Store(config.databasePath);
    try {
      assert.equal(store.stats().states.find(x=>x.state==='closed')?.n,1);
      assert.equal(store.current(501)?.state,'ai');
      assert(messages.some(x=>x.method==='answerCallbackQuery'));
    }finally{store.close();}
  }finally{clearTimeout(timeout);abort.abort();rmSync(dir,{recursive:true,force:true});}
});
