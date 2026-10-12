import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash,createCipheriv,scryptSync} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {decryptPackage,restoreFiles,FORMAT,KDF} from './restore-private.mjs';
const secret=randomBytes(32).toString('base64url');
const entries=[{name:'.env',data:Buffer.from('MODE=demo\nTOKEN=SYNTHETIC\n')},{name:'polezno.sqlite',data:Buffer.from('SQLite format 3\0SYNTHETIC')}];
function encrypt(files=entries) {
  const salt=randomBytes(16),iv=randomBytes(12),key=scryptSync(secret,salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024});
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(FORMAT));
  const payload={version:1,files:files.map(file=>({name:file.name,data:file.data.toString('base64'),sha256:createHash('sha256').update(file.data).digest('hex')}))};
  const body=Buffer.concat([cipher.update(deflateSync(Buffer.from(JSON.stringify(payload)))),cipher.final()]);
  return Buffer.from(JSON.stringify({format:FORMAT,kdf:KDF,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),body:body.toString('base64')}));
}
test('authenticated round trip restores exact synthetic bytes and refuses existing directory',async()=>{
  const files=decryptPackage(encrypt(),secret);assert.deepEqual(files,entries);
  const parent=await mkdtemp(join(tmpdir(),'polezno-private-')),directory=join(parent,'restored');
  try {
    await restoreFiles(files,directory);
    for(const entry of entries)assert.deepEqual(await readFile(join(directory,entry.name)),entry.data);
    const existing=join(parent,'existing');await mkdir(existing);await writeFile(join(existing,'.env'),'KEEP');
    await assert.rejects(restoreFiles(files,existing));assert.equal(await readFile(join(existing,'.env'),'utf8'),'KEEP');
  }finally{assert(resolve(parent).startsWith(resolve(tmpdir())));await rm(parent,{recursive:true,force:true});}
});
test('wrong key, tampering, path traversal and duplicate names are rejected',()=>{
  const data=encrypt();assert.throws(()=>decryptPackage(data,randomBytes(32).toString('base64url')));
  const record=JSON.parse(data);const body=Buffer.from(record.body,'base64');body[0]^=1;record.body=body.toString('base64');
  assert.throws(()=>decryptPackage(Buffer.from(JSON.stringify(record)),secret));
  assert.throws(()=>decryptPackage(encrypt([{...entries[0],name:'../.env'},entries[1]]),secret));
  assert.throws(()=>decryptPackage(encrypt([entries[0],entries[0]]),secret));
});
