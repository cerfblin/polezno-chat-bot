import {readFile,writeFile,rename,mkdir,unlink,stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {httpsUrl} from './config.ts';
import type {Evidence,KnowledgeItem,Product} from './types.ts';

function array(raw:unknown): Record<string,unknown>[] {
  if (!Array.isArray(raw) || raw.length>10000 || raw.some(x=>!x || typeof x!=='object' || Array.isArray(x))) throw new Error('Expected array of records, max 10000');
  return raw;
}
function str(record:Record<string,unknown>,key:string): string {
  const value=record[key];
  if (typeof value!=='string' || !value.trim() || value.length>20000) throw new Error('Invalid field: '+key);
  return value;
}
function unique(items:{id:string}[]): void {
  if (items.some(x=>!/^[a-zA-Z0-9_-]{1,80}$/.test(x.id)) || new Set(items.map(x=>x.id)).size!==items.length) throw new Error('Invalid or duplicate IDs');
}
function date(value:string): void { if (!Number.isFinite(Date.parse(value))) throw new Error('Invalid date'); }
export function validateProducts(raw:unknown): Product[] {
  const result=array(raw).map(x=>{
    for (const key of ['id','name','description','composition','purpose','restrictions','usage','url','updatedAt']) str(x,key);
    httpsUrl(x.url as string); date(x.updatedAt as string);
    if (typeof x.inStock!=='boolean' || typeof x.approved!=='boolean') throw new Error('Invalid product flags');
    return Object.fromEntries(['id','name','description','composition','purpose','restrictions','usage','inStock','url','updatedAt','approved'].map(k=>[k,x[k]])) as Product;
  });
  unique(result); return result;
}
export function validateKnowledge(raw:unknown): KnowledgeItem[] {
  const result=array(raw).map(x=>{
    for (const key of ['id','title','text','url','reviewedBy','checkedAt']) str(x,key);
    httpsUrl(x.url as string); date(x.checkedAt as string);
    if (!Array.isArray(x.keywords) || !x.keywords.length || x.keywords.some(k=>typeof k!=='string'||!k.trim()) || typeof x.enabled!=='boolean' || typeof x.clinicianReviewed!=='boolean') throw new Error('Invalid knowledge fields');
    return x as unknown as KnowledgeItem;
  });
  unique(result); return result;
}
export async function readJson(path:string): Promise<unknown> { return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,'')); }
export async function importCatalog(source:string,destination:string,fetcher:typeof fetch=fetch,check?:(products:Product[])=>void): Promise<number> {
  let raw:unknown;
  if (/^https?:/i.test(source)) {
    httpsUrl(source);
    const response=await fetcher(source,{signal:AbortSignal.timeout(20000),redirect:'error'});
    if (!response.ok) throw new Error('Catalog HTTP error');
    if (Number(response.headers.get('content-length') || 0)>5_000_000) throw new Error('Catalog too large');
    const reader=response.body?.getReader(); if (!reader) throw new Error('Empty catalog response');
    const chunks:Uint8Array[]=[]; let size=0;
    try {
      while(true) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength; if(size>5_000_000)throw new Error('Catalog too large'); chunks.push(value); }
    } finally { await reader.cancel().catch(()=>{}); }
    raw=JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,''));
  } else {
    if((await stat(source)).size>5_000_000)throw new Error('Catalog too large');
    const text=await readFile(source,'utf8');
    if(Buffer.byteLength(text)>5_000_000)throw new Error('Catalog too large');
    raw=JSON.parse(text.replace(/^\uFEFF/,''));
  }
  const products=validateProducts(raw);
  check?.(products);
  await mkdir(dirname(destination),{recursive:true});
  const temp=destination+'.'+randomUUID()+'.tmp';
  try {
    await writeFile(temp,JSON.stringify(products,null,2)+'\n',{mode:0o600,flag:'wx'});
    await rename(temp,destination);
  }finally{await unlink(temp).catch(()=>{});}
  return products.length;
}
const stop=new Set(['что','как','это','для','или','есть','такое','такой','можно','расскажи','пожалуйста','чего','зачем','нужен','нужна','нужно','каких','какие','какой','чем','отличается','объясни','организм','организму','его','она','они','про','еще','подробнее','поподробнее','нее','него','них','этого','the','what','and','are']);
function normalized(text:string):string {
  const letters:Record<string,string>={а:'a',в:'b',с:'c',д:'d',е:'e',к:'k'};
  return text.toLowerCase().replace(/ё/g,'е')
    .replace(/(?:витамин(?:а|у|ом|е)?|vitamin)(?:[\s-]+([a-zа-я])|([a-z]))(\d{0,2})(?![\p{L}\p{N}])/gu,(_match,separated:string,joined:string,digits:string)=>{const letter=letters[separated||joined]||(separated||joined);return 'vitamintype'+letter+(letter==='d'&&/^[23]$/.test(digits)?'':digits);})
    .replace(/(?:омега|omega)[ -]?3(?!\d)/gu,'омега3');
}
function tokens(text:string):string[] {
  return [...new Set((normalized(text).match(/[\p{L}\p{N}]{3,}/gu)||[]).filter(x=>!stop.has(x)).map(x=>
    x.length>5&&!/\d|^vitamintype[\p{L}]\d{0,2}$/u.test(x)?x.slice(0,-2):x))];
}
function matches(token:string,hay:string[]):boolean {
  return hay.some(h=>h===token || (token.length>=4&&!/^vitamintype[\p{L}]\d{0,2}$/u.test(token)&&h.startsWith(token)));
}
const relativeQuestion=/(?:^|[^\p{L}])(?:он|она|оно|они|его|ее|их|него|нее|них|этот|эта|это|эти|этого|этом|этому)(?=$|[^\p{L}])|^\s*(?:а\s+)?(?:еще|подробнее|поподробнее)[\s?!.]*$/u;
const genericTopicTokens=new Set(tokens('роль пищевые источники общие сведения продукты состав ограничения применение польза'));
export class Knowledge {
  items:KnowledgeItem[];
  products:Product[];
  maxAgeDays:number;
  constructor(items:KnowledgeItem[],products:Product[],maxAgeDays=7) {
    this.items=validateKnowledge(items); this.products=validateProducts(products); this.maxAgeDays=maxAgeDays;
    unique([...this.items,...this.products]);
  }
  static async load(knowledgePath:string,catalogPath:string,maxAgeDays=7):Promise<Knowledge> {
    return new Knowledge(validateKnowledge(await readJson(knowledgePath)),validateProducts(await readJson(catalogPath)),maxAgeDays);
  }
  productEvidence(now:number):Evidence[] {
    return this.products.filter(p=>p.approved&&p.inStock&&Date.parse(p.updatedAt)<=now&&now-Date.parse(p.updatedAt)<=this.maxAgeDays*86400000).map(p=>({
      id:p.id,title:p.name,text:[p.description,'Состав: '+p.composition,'Назначение: '+p.purpose,'Ограничения: '+p.restrictions,'Применение по карточке: '+p.usage].join('\n'),url:p.url,type:'product' as const
    }));
  }
  catalogEvidenceCurrent(snapshot:Evidence[],now=Date.now()):boolean {
    const current=this.productEvidence(now);
    return snapshot.every(e=>e.type==='product'&&current.some(c=>c.id===e.id&&c.title===e.title&&c.text===e.text&&c.url===e.url));
  }
  searchConversation(questions:string[],now=Date.now()):Evidence[] {
    const last=questions.at(-1)||'';
    const relative=(text:string)=>relativeQuestion.test(text.toLowerCase().replace(/ё/g,'е'));
    if(!relative(last))return this.search(last,now);
    const products=this.productEvidence(now),items=this.items.filter(x=>x.enabled);
    const topics=[...new Set([...items.flatMap(x=>tokens(x.keywords.join(' '))),...products.flatMap(x=>tokens(x.title))])].filter(t=>!genericTopicTokens.has(t));
    const hasTopic=(text:string)=>tokens(text).some(t=>/^vitamintype[\p{L}]\d{0,2}$/u.test(t)||matches(t,topics));
    // A new named topic stands on its own; an unknown topic must not inherit an old answer.
    if(hasTopic(last))return this.search(last,now);
    const known=[...items.flatMap(x=>tokens(x.title+' '+x.text+' '+x.keywords.join(' '))),...products.flatMap(x=>tokens(x.title+' '+x.text))];
    if(tokens(last).some(t=>!matches(t,known)))return [];
    for(let i=questions.length-2;i>=0;i--) {
      const previous=questions[i];
      if(relative(previous)&&!hasTopic(previous)) {
        if(tokens(previous).some(t=>!matches(t,known)))return [];
        continue;
      }
      if(!this.search(previous,now).length)return [];
      return this.search(last+' '+previous,now);
    }
    return this.search(last,now);
  }
  search(query:string,now=Date.now()): Evidence[] {
    const q=tokens(query); if(!q.length)return [];
    const evidence:Evidence[]=this.items.filter(x=>x.enabled).map(x=>({id:x.id,title:x.title,text:x.text,url:x.url,type:'knowledge'}));
    evidence.push(...this.productEvidence(now));
    const vitamins=q.filter(t=>/^vitamintype[\p{L}]\d{0,2}$/u.test(t));
    return evidence.map(x=>{
      const item=this.items.find(k=>k.id===x.id);
      const title=tokens(x.title+' '+(item?.keywords.join(' ')||''));
      const hay=tokens(x.title+' '+x.text+' '+(item?.keywords.join(' ')||''));
      const hits=q.filter(t=>matches(t,hay));
      // Preserve named vitamins and favor a topic explicitly named in title/keywords.
      const topicMatch=!vitamins.length||vitamins.some(t=>hay.includes(t));
      const coverage=hits.length/q.length;
      return {e:x,coverage,topicMatch,score:coverage+q.filter(t=>matches(t,title)).length/q.length};
    }).filter(x=>x.topicMatch&&x.coverage>=0.6).sort((a,b)=>b.score-a.score).slice(0,4).map(x=>x.e);
  }
}
