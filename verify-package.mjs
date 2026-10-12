import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
try {
  const root=dirname(fileURLToPath(import.meta.url));
  const manifest=JSON.parse(await readFile(join(root,'SHA256SUMS.json'),'utf8'));
  if(manifest.format!==1||!manifest.files||typeof manifest.files!=='object')throw new Error('Invalid manifest');
  let checked=0;
  for(const [name,expected] of Object.entries(manifest.files)) {
    if(!name||name.includes('\\')||name.startsWith('/')||name.includes(':')||name.split('/').some(part=>part==='..'||part==='.'||!part)||!/^[0-9a-f]{64}$/.test(expected))throw new Error('Invalid entry');
    const digest=createHash('sha256').update(await readFile(join(root,name))).digest('hex');
    if(digest!==expected)throw new Error('Checksum mismatch');
    checked++;
  }
  if(!checked)throw new Error('Empty manifest');
  console.log(JSON.stringify({verified:true,files:checked}));
} catch {console.error('Package verification failed. Restore the original archive before continuing.');process.exitCode=1;}
