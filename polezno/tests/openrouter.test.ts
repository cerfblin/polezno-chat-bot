import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.ts';
import {CompatibleAnswerer,LlmError} from '../src/ai.ts';
import {checkLlm} from '../src/llm-check.ts';
import type {Evidence} from '../src/types.ts';

const evidence:Evidence[]=[{id:'s1',title:'Справка',text:'Добавки дополняют рацион.',url:'https://example.org/info',type:'knowledge'}];
const answer={action:'answer',text:'Добавки дополняют рацион.',sourceIds:['s1'],productIds:[]};
const response=(value:unknown)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const config=()=>loadConfig({LLM_PROVIDER:'openrouter-free',LLM_API_KEY:'FAKE_TEST_KEY',LLM_MODEL:'nvidia/nemotron-3-super-120b-a12b:free'});

test('free-only mode pins OpenRouter and explicit free model; missing key keeps extractive startup possible',()=>{
  const disabled=loadConfig({LLM_PROVIDER:'openrouter-free'});
  assert.equal(disabled.llmKey,'');assert.equal(disabled.llmBaseUrl,'https://openrouter.ai/api/v1');
  assert(disabled.llmModel.endsWith(':free'));
  for(const env of [
    {LLM_PROVIDER:'unknown'},
    {LLM_PROVIDER:'openrouter-free',LLM_MODEL:'nvidia/paid-model'},
    {LLM_PROVIDER:'openrouter-free',LLM_MODEL:'openrouter/free'},
    {LLM_PROVIDER:'openrouter-free',LLM_BASE_URL:'https://other.example/api/v1'},
    {LLM_PROVIDER:'openrouter-free',LLM_BASE_URL:'https://openrouter.ai/api/v1?secret=1'},
    {LLM_PROVIDER:'openrouter-free',LLM_BASE_URL:'http://openrouter.ai/api/v1'}
  ])assert.throws(()=>loadConfig(env));
});

test('free requests keep zero price cap, ZDR, no data collection, mandatory schema, no paid fallback or redirects',async()=>{
  let calls=0;
  const fake:typeof fetch=async(url,options)=>{
    calls++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(options?.redirect,'error');
    const body=JSON.parse(String(options?.body));
    assert.equal(body.model,config().llmModel);assert.equal(body.max_tokens,1200);assert(!('max_completion_tokens' in body));
    assert.equal(body.reasoning.enabled,false);assert(!('models' in body));assert(!('route' in body));
    assert.deepEqual(body.provider,{require_parameters:true,data_collection:'deny',zdr:true,max_price:{prompt:0,completion:0,request:0}});
    assert.equal(body.response_format.type,'json_schema');assert.equal(body.response_format.json_schema.strict,true);
    assert(!String(body.messages[1].content).includes('example.org'));
    return response(answer);
  };
  assert.deepEqual(await new CompatibleAnswerer(config(),fake).answer([],evidence),answer);assert.equal(calls,1);
});

test('OpenRouter failures are classified without raw provider messages or automatic paid retries',async()=>{
  for(const [status,kind] of [[401,'invalid_key'],[402,'quota_or_balance'],[403,'access_denied'],[404,'model_or_route_unavailable'],[429,'rate_limit'],[503,'provider_unavailable']] as const) {
    let calls=0;
    const fake:typeof fetch=async()=>{calls++;return new Response(JSON.stringify({error:{message:'SECRET_PERSONAL_DETAILS'}}),{status});};
    await assert.rejects(new CompatibleAnswerer(config(),fake).answer([],evidence),e=>e instanceof LlmError&&e.kind===kind&&!e.message.includes('SECRET'));
    assert.equal(calls,1);
  }
  const network:typeof fetch=async()=>{throw new Error('SECRET_API_KEY');};
  await assert.rejects(new CompatibleAnswerer(config(),network).answer([],evidence),e=>e instanceof LlmError&&e.kind==='network_or_timeout'&&!e.message.includes('SECRET'));
});

test('synthetic checker makes no request without key and sends no Telegram data with key',async()=>{
  let calls=0;
  const fake:typeof fetch=async(_url,options)=>{
    calls++;const body=JSON.parse(String(options?.body));const payload=JSON.parse(body.messages[1].content);
    assert.equal(payload.history.length,1);assert.equal(payload.evidence[0].id,'technical-check');
    assert(!JSON.stringify(payload).includes('chat_id'));assert(!JSON.stringify(payload).includes('file_id'));
    return response({action:'answer',text:'POLEZNO_CONNECTION_OK',sourceIds:['technical-check'],productIds:[]});
  };
  const disabled=await checkLlm(loadConfig({LLM_PROVIDER:'openrouter-free'}),fake);
  assert.equal(disabled.code,'missing_key');assert.equal(calls,0);
  const enabled=await checkLlm(config(),fake);assert.equal(enabled.ok,true);assert.equal(calls,1);
  assert(!JSON.stringify(enabled).includes('FAKE_TEST_KEY'));
});

test('checker reports incompatible, malformed and misleading model answers safely',async()=>{
  for(const [body,expected] of [
    ['{broken','invalid_response'],
    [JSON.stringify({error:{message:'SECRET'}}),'invalid_response'],
    [JSON.stringify({choices:[{finish_reason:'stop',message:{content:'not JSON'}}]}),'invalid_answer'],
    [JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({action:'clarify',text:'Уточните вопрос.',sourceIds:[],productIds:[]})}}]}),'unexpected_test_answer']
  ]) {
    const result=await checkLlm(config(),async()=>new Response(body));
    assert.equal(result.code,expected);assert.equal(result.ok,false);assert(!JSON.stringify(result).includes('SECRET'));
  }
});


test('Apodex uses supported JSON object format with unchanged privacy, price and local evidence checks',async()=>{
  const cfg=loadConfig({LLM_PROVIDER:'openrouter-free',LLM_API_KEY:'FAKE_TEST_KEY'});
  assert.equal(cfg.llmModel,'apodex/apodex-1.1-mini:free');
  let calls=0;
  const fake:typeof fetch=async(_url,options)=>{
    calls++;const body=JSON.parse(String(options?.body));
    assert.deepEqual(body.response_format,{type:'json_object'});
    assert.deepEqual(body.provider,{require_parameters:true,data_collection:'deny',zdr:true,max_price:{prompt:0,completion:0,request:0}});
    return response(calls===1?answer:{...answer,sourceIds:['invented-source']});
  };
  assert.deepEqual(await new CompatibleAnswerer(cfg,fake).answer([],evidence),answer);
  await assert.rejects(new CompatibleAnswerer(cfg,fake).answer([],evidence),e=>e instanceof LlmError&&e.kind==='invalid_answer');
  assert.equal(calls,2);
});
