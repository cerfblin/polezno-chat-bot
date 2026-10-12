import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.ts';
import {createSnapshot,inspectSnapshot} from '../src/backup.ts';

test('verified snapshot preserves queued work and restores without source WAL files',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'polezno-backup-'));
  const source=join(directory,'source.sqlite'),target=join(directory,'snapshot.sqlite');
  const store=new Store(source);
  try {
    store.user(501,null,1);const conversation=store.create(501,1);store.queue(conversation.id,1);
    store.append(conversation.id,'user',{text:'Synthetic question'},1);
    store.out('sendMessage',{chat_id:501,text:'Synthetic delivery'},conversation.id);
    const result=await createSnapshot(source,target);
    assert.equal(result.conversations,1);assert.equal(result.messages,1);assert.equal(result.pendingDeliveries,1);
    const isolated=join(directory,'isolated.sqlite');await writeFile(isolated,await readFile(target));
    const restored=new Store(isolated);
    try {
      assert.equal(restored.get(conversation.id)?.state,'queued');
      assert(restored.nextOutgoing(Date.now()));
      assert.equal(restored.history(conversation.id).length,1);
    }finally{restored.close();}
    assert(!(await readdir(directory)).some(name=>name.includes('.partial-')));
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('snapshots cannot overwrite an existing backup or source and do not create missing source',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'polezno-backup-'));const source=join(directory,'source.sqlite');
  const store=new Store(source);store.close();
  try {
    const target=join(directory,'existing.sqlite');await writeFile(target,'KEEP_EXISTING');
    await assert.rejects(createSnapshot(source,target));assert.equal(await readFile(target,'utf8'),'KEEP_EXISTING');
    await assert.rejects(createSnapshot(source,source));
    await assert.rejects(createSnapshot(join(directory,'missing.sqlite'),join(directory,'absent.sqlite')));
    const names=await readdir(directory);assert(!names.includes('missing.sqlite'));assert(!names.some(name=>name.includes('.partial-')));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('foreign key violations and unrelated databases cannot produce published backups',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'polezno-backup-'));const source=join(directory,'source.sqlite');
  const store=new Store(source);store.db.exec('PRAGMA foreign_keys=OFF');
  store.db.prepare('INSERT INTO messages(conversation_id,role,content,created_at) VALUES(?,?,?,?)').run('absent','user','{}',1);store.close();
  try {
    await assert.rejects(inspectSnapshot(source));await assert.rejects(createSnapshot(source,join(directory,'rejected.sqlite')));
    const other=join(directory,'other.sqlite');const db=new DatabaseSync(other);db.exec('CREATE TABLE other(value TEXT)');db.close();
    await assert.rejects(createSnapshot(other,join(directory,'wrong-schema.sqlite')));
    const names=await readdir(directory);assert(!names.includes('rejected.sqlite'));assert(!names.includes('wrong-schema.sqlite'));
    assert(!names.some(name=>name.includes('.partial-')));
  }finally{await rm(directory,{recursive:true,force:true});}
});
