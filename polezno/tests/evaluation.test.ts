import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Knowledge} from '../src/knowledge.ts';
import {ExtractiveAnswerer} from '../src/ai.ts';
import {loadConfig} from '../src/config.ts';
import {evaluateScenarios} from '../src/evaluation.ts';
import {route} from '../src/policy.ts';
const knowledge=()=>Knowledge.load('data/knowledge.json','data/catalog.json');

test('public reference questions retrieve their intended source across Russian and Latin topic names',async()=>{
 const k=await knowledge();
 for(const [question,id] of [
  ['Что такое пищевые добавки?','nih-supplements'],['Основы здорового питания','who-diet'],
  ['Для чего нужен витамин D?','ods-vitamin-d'],['Что такое витамин Д?','ods-vitamin-d'],['Витамин D3','ods-vitamin-d'],
  ['Для чего нужен витамин C?','ods-vitamin-c'],['Что такое витамин С?','ods-vitamin-c'],['Аскорбиновая кислота','ods-vitamin-c'],
  ['В каких продуктах содержится магний?','ods-magnesium'],['Магния','ods-magnesium'],
  ['Зачем организму железо?','ods-iron'],['Что такое omega-3?','ods-omega3'],['Омега 3','ods-omega3'],
  ['Что означает штамм пробиотика?','ods-probiotics']
 ])assert.equal(k.search(question)[0]?.id,id,question);
});

test('search preserves vitamin identity and rejects unknown brands and unrelated questions',async()=>{
 const k=await knowledge();
 assert(!k.search('Для чего нужен витамин D?').some(x=>x.id==='ods-vitamin-c'));
 assert(!k.search('Для чего нужен витамин C?').some(x=>x.id==='ods-vitamin-d'));
 for(const q of ['Что такое витамин Z?','Есть ли СуперНутриXYZ в наличии?','Как починить велосипед?','СуперНутриXYZ и иммунитет'])assert.deepEqual(k.search(q),[],q);
});

test('intake instructions route to doctor while reference questions remain with AI',()=>{
 for(const q of ['Как принимать витамин D?','Как пить магний?','Когда принимать железо?','Сколько витамина D нужно в день?','Какая дозировка нужна?'])assert.equal(route(q),'doctor',q);
 for(const q of ['Для чего нужен витамин D?','Что такое витамин C?','В каких продуктах содержится магний?'])assert.equal(route(q),'ai',q);
});

test('seven synthetic acceptance scenarios pass without external network or patient data',async()=>{
 const results=await evaluateScenarios(loadConfig({MODE:'demo'}),await knowledge(),new ExtractiveAnswerer());
 assert.equal(results.length,7);assert(results.every(x=>x.passed),JSON.stringify(results));
 assert.equal(results.reduce((sum,x)=>sum+x.llmCalls,0),4);
});
