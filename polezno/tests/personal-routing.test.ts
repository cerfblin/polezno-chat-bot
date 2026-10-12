import {test} from 'node:test';
import assert from 'node:assert/strict';
import {route} from '../src/policy.ts';
import {Store} from '../src/store.ts';
import {Engine} from '../src/engine.ts';
import {loadConfig} from '../src/config.ts';

test('personal supplement requests for self, child and parents enter doctor queue before an AI job; reference and delivery remain available',()=>{
  const questions=['Можно ли мне магний?','Можно ли ребёнку витамин D?','Мне 65 лет, какую добавку выбрать?','Могу ли я пить витамин D?','Подбери для мамы витамины'];
  for(const text of questions) {
    const store=new Store(':memory:');
    try {
      assert.equal(route(text),'doctor',text);
      new Engine(store,loadConfig({MODE:'demo'})).handle({update_id:1,message:{message_id:1,chat:{id:501,type:'private'},from:{id:501},text}});
      assert.equal(store.current(501)?.state,'queued');assert.equal(store.nextAi(),undefined);
    }finally{store.close();}
  }
  assert.equal(route('Что такое витамин D?'),'ai');
  assert.equal(route('В каких продуктах содержится магний?'),'ai');
  assert.equal(route('Можно ли мне оформить доставку витаминов?'),'shop');
  assert.equal(route('Посоветуй товар с магнием'),'ai');
});
