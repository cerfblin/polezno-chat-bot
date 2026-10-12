import {CompatibleAnswerer,LlmError} from './ai.ts';
import type {Config,Evidence} from './types.ts';

export type LlmCheck = {ok:boolean;provider:string;model:string;code:string;status?:number};
// A single synthetic request. No Telegram history, IDs, files or medical data are read.
export async function checkLlm(config:Config,fetcher:typeof fetch=fetch):Promise<LlmCheck> {
  const base={provider:config.llmProvider,model:config.llmModel};
  if(!config.llmKey)return {ok:false,...base,code:'missing_key'};
  const direct=config.llmAnswerMode==='direct';
  const evidence:Evidence[]=direct?[]:[{id:'technical-check',type:'knowledge',title:'Технический тест подключения',text:'Проверочный код: POLEZNO_CONNECTION_OK.',url:'https://example.org/technical-check'}];
  try {
    const answer=await new CompatibleAnswerer(config,fetcher).answer([{role:'user',content:direct?'Что такое клетчатка? Дай краткую общую справку без индивидуальных рекомендаций.':'Какой проверочный код указан в техническом материале? Верни его в text, не добавляй других фактов.'}],evidence);
    if(direct)return {ok:answer.action==='answer',...base,code:answer.action==='answer'?'validated_direct_answer':'unexpected_test_answer'};
    if(answer.action!=='answer'||!answer.text.includes('POLEZNO_CONNECTION_OK')||!answer.sourceIds.includes('technical-check'))return {ok:false,...base,code:'unexpected_test_answer'};
    return {ok:true,...base,code:'validated_answer'};
  }catch(error){
    return error instanceof LlmError?{ok:false,...base,code:error.kind,status:error.status}:{ok:false,...base,code:'unexpected_failure'};
  }
}
