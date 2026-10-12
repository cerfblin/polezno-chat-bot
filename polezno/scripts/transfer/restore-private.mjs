import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDecipheriv,createHash,scryptSync} from 'node:crypto';
import {inflateSync} from 'node:zlib';

export const FORMAT='polezno-private-v1';
export const KDF='scrypt-n16384-r8-p1';
const LIMIT=32*1024*1024;
export function decryptPackage(bytes,secret) {
  if(bytes.length>LIMIT||!/^[A-Za-z0-9_-]{43}$/.test(secret))throw new Error('Invalid package or key');
  const record=JSON.parse(bytes.toString('utf8'));
  if(record.format!==FORMAT||record.kdf!==KDF)throw new Error('Unsupported package');
  const salt=Buffer.from(record.salt,'base64'),iv=Buffer.from(record.iv,'base64');
  const tag=Buffer.from(record.tag,'base64'),body=Buffer.from(record.body,'base64');
  if(salt.length!==16||iv.length!==12||tag.length!==16||!body.length)throw new Error('Invalid envelope');
  const key=scryptSync(secret,salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024});
  const decipher=createDecipheriv('aes-256-gcm',key,iv);
  decipher.setAAD(Buffer.from(FORMAT));decipher.setAuthTag(tag);
  const compressed=Buffer.concat([decipher.update(body),decipher.final()]);
  const payload=JSON.parse(inflateSync(compressed,{maxOutputLength:LIMIT}).toString('utf8'));
  if(payload.version!==1||!Array.isArray(payload.files)||payload.files.length!==2)throw new Error('Invalid payload');
  const names=new Set();
  const files=payload.files.map(file=>{
    if(!['.env','polezno.sqlite'].includes(file.name)||names.has(file.name)||typeof file.data!=='string'||typeof file.sha256!=='string')throw new Error('Invalid file entry');
    names.add(file.name);
    const data=Buffer.from(file.data,'base64');
    if(!data.length||data.length>LIMIT||createHash('sha256').update(data).digest('hex')!==file.sha256)throw new Error('File checksum failed');
    if(file.name==='polezno.sqlite'&&!data.subarray(0,16).equals(Buffer.from('SQLite format 3\0')))throw new Error('Invalid SQLite header');
    return {name:file.name,data};
  });
  return files;
}
export async function restoreFiles(files,output) {
  // Decryption/validation precedes this call. Existing directories are refused.
  const directory=resolve(output);
  await mkdir(directory,{mode:0o700});
  for(const file of files) {
    if(!['.env','polezno.sqlite'].includes(file.name))throw new Error('Unexpected filename');
    await writeFile(join(directory,file.name),file.data,{flag:'wx',mode:0o600});
  }
}
async function cli() {
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++) {
    const name=args[i];
    if(name==='--verify'||name==='--help')options[name]=true;
    else if(['--package','--key-file','--out'].includes(name)&&args[i+1]&&!args[i+1].startsWith('--'))options[name]=args[++i];
    else throw new Error('Invalid arguments');
  }
  if(options['--help']) {
    console.log('node restore-private.mjs --package <file.pzenc> --key-file <local-key.txt> (--verify | --out <new-directory>)');return;
  }
  if(!options['--package']||!options['--key-file']||Boolean(options['--verify'])===Boolean(options['--out']))throw new Error('Choose verify or output');
  const [bytes,keyFile]=await Promise.all([readFile(options['--package']),readFile(options['--key-file'],'utf8')]);
  const files=decryptPackage(bytes,keyFile.trim());
  if(options['--verify'])console.log(JSON.stringify({verified:true,files:files.map(file=>file.name),totalBytes:files.reduce((n,file)=>n+file.data.length,0)}));
  else {await restoreFiles(files,options['--out']);console.log(JSON.stringify({restored:true,files:files.map(file=>file.name)}));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  await cli().catch(()=>{console.error('Private transfer failed. Check the key, package integrity and a new output directory. Secret values are omitted.');process.exitCode=1;});
}
