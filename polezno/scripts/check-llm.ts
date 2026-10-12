import {loadConfig} from '../src/config.ts';
import {checkLlm} from '../src/llm-check.ts';

try {
  const config=loadConfig({...process.env,MODE:'demo'});
  if(process.argv.includes('--live')) {
    const result=await checkLlm(config);
    console.log(JSON.stringify(result));
    if(!result.ok)process.exitCode=1;
  } else {
    console.log(JSON.stringify({provider:config.llmProvider,model:config.llmModel,keyConfigured:Boolean(config.llmKey),networkRequested:false}));
    console.log('Add --live for one synthetic API request. No patient data is sent.');
  }
}catch{console.error('LLM check failed: invalid_configuration. Secret values are omitted.');process.exitCode=1;}
