import {openSync,readFileSync,writeFileSync,closeSync,unlinkSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
export function acquireLock(path:string):()=>void {
  mkdirSync(dirname(path),{recursive:true});
  const lockPath=path+'.lock.pid';
  function create():number {return openSync(lockPath,'wx',0o600);}
  let fd:number;
  try {fd=create();}
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const pid=Number(readFileSync(lockPath,'utf8'));
    if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Invalid lock file; inspect it manually');
    let alive=true;
    try {process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
    if(alive)throw new Error('Another process already holds this database lock');
    unlinkSync(lockPath); fd=create();
  }
  writeFileSync(fd,String(process.pid));closeSync(fd);
  return ()=>{try {if(readFileSync(lockPath,'utf8')===String(process.pid))unlinkSync(lockPath);}catch{}};
}
