import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {parseEnv} from 'node:util';
import {Store} from '../../src/store.ts';
import {inspectSnapshot} from '../../src/backup.ts';
import {buildTransfer} from './build-transfer.mjs';
import {includePrivateKey} from './include-private-key.mjs';
import {createHash} from 'node:crypto';
import {decryptPackage,restoreFiles} from './restore-private.mjs';

async function fixture() {
  const base=resolve(tmpdir()),parent=await mkdtemp(join(base,'polezno-build-')),root=join(parent,'source');
  await mkdir(root);
  for(const dir of ['src','scripts','tests','docs','data','.agents','var'])await mkdir(join(root,dir));
  for(const name of ['AGENTS.md','README.md','WORKFLOW.md','pnpm-lock.yaml','tsconfig.json','Dockerfile','compose.yaml','.env.example','.gitignore','.dockerignore'])await writeFile(join(root,name),'SYNTHETIC TEST\n');
  await writeFile(join(root,'package.json'),JSON.stringify({name:'polezno-bot',type:'module'}));
  await writeFile(join(root,'docs/verification-results.json'),JSON.stringify({tests:{total:0,passed:0}}));
  for(const name of ['config.ts','backup.ts'])await copyFile(new URL('../../src/'+name,import.meta.url),join(root,'src',name));
  await writeFile(join(root,'data/knowledge.json'),'[]');await writeFile(join(root,'data/catalog.json'),'[]');
  const token='123:SYNTHETIC_TRANSFER_TOKEN_12345',llm='SYNTHETIC_TRANSFER_KEY_12345';
  await writeFile(join(root,'.env'),'MODE=demo\nDATABASE_PATH=var/test.sqlite\nTELEGRAM_BOT_TOKEN='+token+'\nLLM_PROVIDER=openrouter-free\nLLM_API_KEY='+llm+'\n');
  const db=join(root,'var/test.sqlite'),store=new Store(db);
  store.user(501,null,1);const c=store.create(501,1);store.append(c.id,'user',{text:'SYNTHETIC HISTORY'},1);store.close();
  return {root,parent,db,token,llm,async cleanup(){assert(parent.startsWith(base+'\\')||parent.startsWith(base+'/'));await rm(parent,{recursive:true,force:true});}};
}
test('builder creates a stopped-source package, portable settings and exact restorable synthetic history',async()=>{
  const x=await fixture(),out=join(x.parent,'final');
  try {
    const result=await buildTransfer(x.root,out);assert.equal(result.preliminary,false);
    const secret=(await readFile(out+'-key.txt','utf8')).trim();
    const files=decryptPackage(await readFile(join(out,'private/polezno-private.pzenc')),secret);
    const settings=parseEnv(files.find(f=>f.name==='.env').data.toString());
    assert.equal(settings.TELEGRAM_BOT_TOKEN,x.token);assert.equal(settings.LLM_API_KEY,x.llm);
    assert.equal(settings.DATABASE_PATH,'var/polezno.sqlite');assert.equal(settings.KNOWLEDGE_PATH,'data/knowledge.json');
    const restored=join(x.parent,'restored');await restoreFiles(files,restored);
    const info=await inspectSnapshot(join(restored,'polezno.sqlite'));assert.equal(info.messages,1);assert.equal(info.conversations,1);
    const manifest=JSON.parse(await readFile(join(out,'SHA256SUMS.json'),'utf8'));
    assert(!Object.keys(manifest.files).some(name=>name.includes('.sqlite')||name==='polezno/.env'||name.endsWith('-key.txt')));
    for(const name of Object.keys(manifest.files)) {
      const bytes=await readFile(join(out,name));assert(!bytes.includes(Buffer.from(x.token)));assert(!bytes.includes(Buffer.from(x.llm)));assert(!bytes.includes(Buffer.from(secret)));
    }
    assert.equal(JSON.parse(await readFile(join(out,'TRANSFER-STATE.json'),'utf8')).sourceStoppedAtBuild,true);
    await assert.rejects(buildTransfer(x.root,out));
  } finally {await x.cleanup();}
});
test('active source refuses final packaging; an explicitly requested draft records the cutover requirement',async()=>{
  const x=await fixture(),out=join(x.parent,'draft');
  try {
    await writeFile(x.db+'.lock.pid',String(process.pid));
    await assert.rejects(buildTransfer(x.root,out),/Source bot is still running/);
    await assert.rejects(access(out));
    const result=await buildTransfer(x.root,out,{liveSnapshot:true});assert.equal(result.preliminary,true);
    const state=JSON.parse(await readFile(join(out,'TRANSFER-STATE.json'),'utf8'));
    assert.equal(state.requiresFinalSnapshotAfterSourceStop,true);assert.equal(state.sourceRunningAtSnapshot,true);
    assert.equal(await readFile(x.db+'.lock.pid','utf8'),String(process.pid));
  } finally {await x.cleanup();}
});

test('explicit single-private-archive option includes the correct key, updates instructions and checksums, and refuses repetition',async()=>{
  const x=await fixture(),out=join(x.parent,'single');
  try {
    await buildTransfer(x.root,out,{liveSnapshot:true});
    const result=await includePrivateKey(out);assert.equal(result.keyIncluded,true);
    await assert.rejects(access(out+'-key.txt'));
    const key=(await readFile(join(out,result.keyPath),'utf8')).trim();
    const files=decryptPackage(await readFile(join(out,'private/polezno-private.pzenc')),key);
    assert.equal(parseEnv(files.find(f=>f.name==='.env').data.toString()).TELEGRAM_BOT_TOKEN,x.token);
    const guide=await readFile(join(out,'START-HERE.md'),'utf8');
    assert(guide.includes('--key-file "private/restore-key.txt"'));
    assert(guide.includes('-IncludeKey'));assert(!guide.includes('Отдельный файл **single-key.txt**'));assert(!guide.includes(key));
    const state=JSON.parse(await readFile(join(out,'TRANSFER-STATE.json'),'utf8'));
    assert.equal(state.bundleType,'all-in-one-private');assert.equal(state.wholeArchiveEncrypted,false);assert.equal(state.doNotPublish,true);assert.equal(state.preliminary,true);
    const manifest=JSON.parse(await readFile(join(out,'SHA256SUMS.json'),'utf8'));
    for(const [name,expected] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(await readFile(join(out,name))).digest('hex'),expected);
    assert(manifest.files[result.keyPath]);await assert.rejects(includePrivateKey(out));
  } finally {await x.cleanup();}
});
