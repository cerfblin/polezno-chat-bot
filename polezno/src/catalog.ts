import {stat} from 'node:fs/promises';
import {Knowledge,importCatalog,readJson,validateProducts} from './knowledge.ts';
import type {Config} from './types.ts';

// Updates the existing Knowledge instance so the AI worker sees new stock/cards.
export class CatalogManager {
  knowledge:Knowledge;config:Config;fetcher:typeof fetch;busy=false;
  lastAttempt:number|null=null;lastLoaded:number|null=null;failed=false;
  private signature='';private controller=new AbortController();
  constructor(knowledge:Knowledge,config:Config,fetcher:typeof fetch=fetch) {
    this.knowledge=knowledge;this.config=config;
    this.fetcher=(input,init)=>fetcher(input,{...init,signal:AbortSignal.any([this.controller.signal,...(init?.signal?[init.signal]:[])])});
  }
  async refresh(now=Date.now()):Promise<boolean> {
    if(this.busy||this.controller.signal.aborted)return false;
    this.busy=true;let sourceFailed=false;
    try {
      if(this.config.catalogSource&&(this.lastAttempt===null||now-this.lastAttempt>=this.config.catalogSyncSeconds*1000)) {
        this.lastAttempt=now;
        try {
          await importCatalog(this.config.catalogSource,this.config.catalogPath,this.fetcher,
            products=>{new Knowledge(this.knowledge.items,products,this.knowledge.maxAgeDays);});
        }catch {sourceFailed=true;}
      }
      const info=await stat(this.config.catalogPath);
      const signature=[info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs].join(':');
      if(signature!==this.signature) {
        if(info.size>5_000_000)throw new Error('Catalog too large');
        const candidate=new Knowledge(this.knowledge.items,validateProducts(await readJson(this.config.catalogPath)),this.knowledge.maxAgeDays);
        this.knowledge.products=candidate.products;
        this.signature=signature;this.lastLoaded=now;
      }
      this.failed=sourceFailed;return !sourceFailed;
    }catch {this.failed=true;return false;}
    finally{this.busy=false;}
  }
  stop():void {this.controller.abort();}
}
