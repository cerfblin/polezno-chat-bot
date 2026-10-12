import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Knowledge} from '../src/knowledge.ts';
import {AiWorker,ExtractiveAnswerer} from '../src/ai.ts';
import {Engine} from '../src/engine.ts';
import {Store} from '../src/store.ts';
import {DeliveryWorker,MemoryTransport} from '../src/telegram.ts';
import {loadConfig} from '../src/config.ts';
import {route} from '../src/policy.ts';
import type {Product} from '../src/types.ts';

const knowledge=()=>Knowledge.load('data/knowledge.json','data/catalog.json');
test('explicit topic changes retrieve the new source without mixing the previous vitamin',async()=>{
  const k=await knowledge(),previous='Для чего нужен витамин D?';
  for(const [next,id] of [['А витамин C?','ods-vitamin-c'],['А про омега-3?','ods-omega3'],['А магний?','ods-magnesium']]) {
    const evidence=k.searchConversation([previous,next]);
    assert.equal(evidence[0]?.id,id,next);assert(!evidence.some(e=>e.id==='ods-vitamin-d'),next);
  }
});
test('relative follow-ups retain the latest named topic across several turns',async()=>{
  const k=await knowledge();
  for(const [topic,id] of [['Для чего нужен витамин D?','ods-vitamin-d'],['Что такое витамин C?','ods-vitamin-c'],['Что такое магний?','ods-magnesium']]) {
    assert.equal(k.searchConversation([topic,'А его пищевые источники?'])[0]?.id,id,topic);
    assert.equal(k.searchConversation([topic,'А его пищевые источники?','А подробнее?'])[0]?.id,id,topic);
  }
  assert.equal(k.searchConversation(['Что такое витамин D?','А витамин C?','А его пищевые источники?'])[0]?.id,'ods-vitamin-c');
});
test('unknown topics, products and unrelated referential questions never resurrect the old evidence',async()=>{
  const k=await knowledge();
  for(const next of ['А витамин Z?','А СуперНутриXYZ?','А это СуперНутриXYZ?','А как его велосипед починить?'])assert.deepEqual(k.searchConversation(['Что такое пищевые добавки?',next]),[],next);
  assert.deepEqual(k.searchConversation(['Что такое витамин D?','А витамин Z?','А его пищевые источники?']),[]);
  assert.deepEqual(k.searchConversation(['Что такое витамин D?','А СуперНутриXYZ?','А подробнее?']),[]);
  assert.deepEqual(k.searchConversation(['Что такое витамин D?','А это СуперНутриXYZ?','А его пищевые источники?']),[]);
});
test('product follow-ups use only the currently eligible catalog, including after withdrawal',()=>{
  const product:Product={id:'synthetic-product',name:'SYNTHETIC_PRODUCT_ALPHA',description:'Синтетический товар',composition:'Синтетический состав',purpose:'Тест механики',restrictions:'Не для продажи',usage:'Не применять',inStock:true,url:'https://example.org/synthetic-product',updatedAt:'2026-10-12T00:00:00Z',approved:true};
  const k=new Knowledge([], [product]),now=Date.parse('2026-10-12T10:00:00Z');
  const history=[product.name,'А его состав?'];
  assert.equal(k.searchConversation(history,now)[0]?.id,product.id);
  k.products[0].approved=false;assert.deepEqual(k.searchConversation(history,now),[]);
  k.products[0].approved=true;k.products[0].inStock=false;assert.deepEqual(k.searchConversation(history,now),[]);
  k.products[0].inStock=true;assert.deepEqual(k.searchConversation(history,now+8*86400000),[]);
});
test('actual AI worker uses new-topic evidence and avoids model calls for unknown follow-ups',async()=>{
  const store=new Store(':memory:'),engine=new Engine(store,loadConfig({MODE:'demo'})),transport=new MemoryTransport();
  const delivery=new DeliveryWorker(store,transport),seen:string[][]=[];
  const extractive=new ExtractiveAnswerer();
  const ai=new AiWorker(store,engine,await knowledge(),{answer:async(history,evidence)=>{seen.push(evidence.map(e=>e.id));return extractive.answer(history,evidence);}});
  try {
    let sequence=0;
    for(const text of ['Для чего нужен витамин D?','А витамин C?','А его пищевые источники?','А про омега-3?','А витамин Z?','А его пищевые источники?']) {
      engine.handle({update_id:++sequence,message:{message_id:sequence,chat:{id:501,type:'private'},from:{id:501},text}});
      await ai.runOne();await delivery.flush(100);
    }
    assert.deepEqual(seen.map(ids=>ids[0]),['ods-vitamin-d','ods-vitamin-c','ods-vitamin-c','ods-omega3']);
    assert(!seen[1].includes('ods-vitamin-d'));assert.equal(store.current(501)?.state,'ai');
    assert(transport.sent.at(-1)?.payload.text?.toString().includes('Уточните вопрос'));
  } finally {store.close();}
});
test('shop operator requests stay in shop while emergencies, attachments and medical questions take priority',()=>{
  for(const text of ['Переведи на оператора магазина по доставке','Свяжи с оператором магазина','В магазине нужен оператор','Хочу поговорить с обычным менеджером магазина','Мне нужна доставка витаминов','Можно ли мне оформить доставку витаминов?','Передать мне заказ витаминов через оператора магазина'])assert.equal(route(text),'shop',text);
  for(const text of ['Мне нужен врач','Оператор','Оператор магазина, расшифруй анализы','Оператор доставки, можно ребенку витамин D?','Менеджер, подбери мне магний','Можно ли мне оформить доставку? А ребенку можно витамин D?'])assert.equal(route(text),'doctor',text);
  assert.equal(route('Оператор магазина, не могу дышать'),'urgent');
  assert.equal(route('Оператор магазина по доставке',true),'doctor');
  assert.equal(route('Что такое витамин D?'),'ai');
});
test('shop operator gets the configured Mini App link without a doctor case or AI job',()=>{
  const store=new Store(':memory:'),config=loadConfig({MODE:'demo',MINI_APP_URL:'https://example.org/shop'});
  try {
    new Engine(store,config).handle({update_id:1,message:{message_id:1,chat:{id:501,type:'private'},from:{id:501},text:'Переведи на оператора магазина по доставке'}});
    assert.equal(store.current(501)?.state,'ai');assert.equal(store.nextAi(),undefined);
    const rows=store.db.prepare('SELECT payload FROM outbox').all() as {payload:string}[];
    assert(rows.some(r=>JSON.parse(r.payload).text.includes('https://example.org/shop')));
    assert(!rows.some(r=>JSON.parse(r.payload).chat_id===config.groupId));
  } finally {store.close();}
});
