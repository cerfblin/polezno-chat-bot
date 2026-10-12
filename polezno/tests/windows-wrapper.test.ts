import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyFile,mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile);
const powershell=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const windows=process.platform==='win32';
async function fixture():Promise<{root:string;runner:string;cleanup:()=>Promise<void>}> {
  const root=await mkdtemp(join(tmpdir(),'polezno-wrapper-'));
  await Promise.all(['scripts','src','var'].map(name=>mkdir(join(root,name))));
  const runner=join(root,'scripts','windows-run.ps1');
  await copyFile(fileURLToPath(new URL('../scripts/windows-run.ps1',import.meta.url)),runner);
  await writeFile(join(root,'.env'),'MODE=demo\n');
  return {root,runner,cleanup:async()=>{
    assert(resolve(root).startsWith(resolve(tmpdir())+sep));
    assert(root.includes('polezno-wrapper-'));
    await rm(root,{recursive:true,force:true});
  }};
}

test('Windows wrapper propagates crash exit code and rotates logs on a later clean run without external APIs',{skip:!windows},async()=>{
  const sandbox=await fixture();
  try {
    await writeFile(join(sandbox.root,'src','main.ts'),[
      "import {existsSync,readFileSync,writeFileSync} from 'node:fs';",
      "const path='var/attempts.txt';",
      "const attempt=existsSync(path)?Number(readFileSync(path,'utf8'))+1:1;",
      "writeFileSync(path,String(attempt));",
      "console.log('SYNTHETIC_ATTEMPT_'+attempt);",
      "process.exit(attempt===1?7:0);"
    ].join('\n'));
    const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',sandbox.runner,'-Mode','Bot','-NodePath',process.execPath];
    await assert.rejects(execute(powershell,args,{windowsHide:true,timeout:10000}),error=>(error as {code?:number}).code===7);
    assert.equal(await readFile(join(sandbox.root,'var','attempts.txt'),'utf8'),'1');
    const result=await execute(powershell,args,{windowsHide:true,timeout:10000});
    assert.equal(result.stderr,'');
    assert.equal(await readFile(join(sandbox.root,'var','attempts.txt'),'utf8'),'2');
    const log=join(sandbox.root,'var','logs','bot.stdout.log');
    assert.match(await readFile(log+'.previous','utf8'),/SYNTHETIC_ATTEMPT_1/);
    assert.match(await readFile(log,'utf8'),/SYNTHETIC_ATTEMPT_2/);
  }finally{await sandbox.cleanup();}
});

test('Windows wrapper rejects a missing executable before running a child',{skip:!windows},async()=>{
  const sandbox=await fixture();
  try {
    const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',sandbox.runner,'-NodePath',join(sandbox.root,'missing','node.exe')];
    await assert.rejects(execute(powershell,args,{windowsHide:true,timeout:10000}),error=>(error as {code?:number}).code===1);
    await assert.rejects(readFile(join(sandbox.root,'var','attempts.txt')));
  }finally{await sandbox.cleanup();}
});
