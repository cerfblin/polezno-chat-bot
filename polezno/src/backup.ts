import {DatabaseSync,backup} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {stat,mkdir,open,link,unlink} from 'node:fs/promises';

export type SnapshotInfo={bytes:number;conversations:number;messages:number;pendingDeliveries:number};
export async function inspectSnapshot(path:string):Promise<SnapshotInfo> {
  const info=await stat(path);
  if(!info.isFile()||!info.size)throw new Error('Database file required');
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const integrity=db.prepare('PRAGMA integrity_check').all();
    if(integrity.length!==1||Object.values(integrity[0]!)[0]!=='ok')throw new Error('Snapshot integrity failed');
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Snapshot foreign keys failed');
    const version=db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    if(version?.value!=='1')throw new Error('Unsupported snapshot schema');
    const count=(sql:string)=>Number(db.prepare(sql).get()!.n);
    return {bytes:info.size,conversations:count('SELECT count(*) AS n FROM conversations'),
      messages:count('SELECT count(*) AS n FROM messages'),
      pendingDeliveries:count("SELECT count(*) AS n FROM outbox WHERE status='pending'")};
  } finally {db.close();}
}

// Read-only source; publish only a verified snapshot and never overwrite a file.
export async function createSnapshot(source:string,destination:string):Promise<SnapshotInfo> {
  const from=resolve(source),target=resolve(destination);
  if(from===target)throw new Error('Snapshot destination must differ');
  if(!(await stat(from)).isFile())throw new Error('Source database file required');
  await mkdir(dirname(target),{recursive:true});
  const temporary=target+'.partial-'+randomUUID();
  const handle=await open(temporary,'wx',0o600);await handle.close();
  let db:DatabaseSync|undefined;
  try {
    db=new DatabaseSync(from,{readOnly:true});db.exec('PRAGMA busy_timeout=5000');
    await backup(db,temporary);
    const info=await inspectSnapshot(temporary);
    // An exclusive hard link publishes the complete file without a clobber race.
    // Both paths share a directory/filesystem; existing files and symlinks fail.
    await link(temporary,target);
    return info;
  } finally {
    db?.close();
    await unlink(temporary).catch(()=>{});
    for(const suffix of ['-wal','-shm'])await unlink(temporary+suffix).catch(()=>{});
  }
}
