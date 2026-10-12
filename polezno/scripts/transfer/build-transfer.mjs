import {readFile,writeFile,mkdir,readdir,lstat,copyFile,access} from 'node:fs/promises';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,randomUUID,createHash,createCipheriv,scryptSync} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {parseEnv} from 'node:util';
import {hostname} from 'node:os';
import {DatabaseSync} from 'node:sqlite';

const assets=dirname(fileURLToPath(import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function absent(path) {try {await access(path);}catch(e){if(e.code==='ENOENT')return;throw e;}throw new Error('Destination already exists');}
async function activeLock(path) {
  let text;try {text=await readFile(path+'.lock.pid','utf8');}catch(e){if(e.code==='ENOENT')return false;throw e;}
  const pid=Number(text);if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Invalid source lock');
  try {process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}
}
async function filesAt(root) {
  const result=[];
  async function visit(directory,prefix='') {
    for(const name of (await readdir(directory)).sort()) {
      const path=join(directory,name),info=await lstat(path),local=prefix+name;
      if(info.isSymbolicLink())throw new Error('Symbolic link is not transferable');
      if(info.isDirectory())await visit(path,local+'/');
      else if(info.isFile())result.push(local);
      else throw new Error('Unexpected file type');
    }
  }
  await visit(root);return result;
}
export async function buildTransfer(project,output,{liveSnapshot=false}={}) {
  const root=resolve(project),destination=resolve(output),keyFile=destination+'-key.txt';
  const nested=relative(root,destination);
  if(!nested||(!nested.startsWith('..')&&!isAbsolute(nested)))throw new Error('Output must be outside source project');
  await absent(destination);await absent(destination+'.zip');await absent(keyFile);
  const {loadConfig}=await import(pathToFileURL(join(root,'src/config.ts')).href);
  const {createSnapshot}=await import(pathToFileURL(join(root,'src/backup.ts')).href);
  const rawEnv=await readFile(join(root,'.env'),'utf8'),env=parseEnv(rawEnv),config=loadConfig(env,root);
  if((JSON.parse(await readFile(join(root,'package.json'),'utf8'))).name!=='polezno-bot')throw new Error('Wrong project');
  const running=await activeLock(config.databasePath);
  if(running&&!liveSnapshot)throw new Error('Source bot is still running; stop it before the final transfer');
  if(config.catalogSource&&!/^https:/i.test(config.catalogSource))throw new Error('Local catalog source needs portable mapping');
  const snapshotPath=join(root,'var','backups','polezno-transfer-'+randomUUID()+'.sqlite');
  const snapshot=await createSnapshot(config.databasePath,snapshotPath);
  const sourceDb=new DatabaseSync(snapshotPath,{readOnly:true});
  let pending;
  try {pending={inbox:Number(sourceDb.prepare("SELECT COUNT(*) n FROM updates WHERE status='pending'").get().n),ai:Number(sourceDb.prepare("SELECT COUNT(*) n FROM ai_jobs WHERE status IN ('pending','running')").get().n)};} finally {sourceDb.close();}
  await mkdir(join(destination,'polezno'),{recursive:true,mode:0o700});
  const rootNames=['AGENTS.md','README.md','WORKFLOW.md','package.json','pnpm-lock.yaml','tsconfig.json','Dockerfile','compose.yaml','.env.example','.gitignore','.dockerignore'];
  const sourceNames=[...rootNames];
  for(const directory of ['src','scripts','tests','docs','data','.agents']) {
    for(const name of await filesAt(join(root,directory)))sourceNames.push(directory+'/'+name);
  }
  for(const name of sourceNames) {
    if((await lstat(join(root,name))).isSymbolicLink())throw new Error('Source link rejected');
    const target=join(destination,'polezno',name);await mkdir(dirname(target),{recursive:true});await copyFile(join(root,name),target);
  }
  // Bundle the actual configured reference data under portable standard paths.
  await copyFile(config.knowledgePath,join(destination,'polezno/data/knowledge.json'));
  await copyFile(config.catalogPath,join(destination,'polezno/data/catalog.json'));
  for(const name of ['restore-private.mjs','verify-package.mjs','transfer-tests.mjs'])await copyFile(join(assets,name),join(destination,name));
  let portableEnv=rawEnv;
  for(const [name,value] of Object.entries({DATABASE_PATH:'var/polezno.sqlite',KNOWLEDGE_PATH:'data/knowledge.json',CATALOG_PATH:'data/catalog.json'})) {
    const line=new RegExp('^'+name+'=.*$','m');
    portableEnv=line.test(portableEnv)?portableEnv.replace(line,name+'='+value):portableEnv+'\n'+name+'='+value+'\n';
  }
  const secret=randomBytes(32).toString('base64url'),salt=randomBytes(16),iv=randomBytes(12),format='polezno-private-v1';
  const privateFiles=[{name:'.env',bytes:Buffer.from(portableEnv)},{name:'polezno.sqlite',bytes:await readFile(snapshotPath)}];
  const createdAt=new Date().toISOString();
  const payload={version:1,createdAt,files:privateFiles.map(f=>({name:f.name,data:f.bytes.toString('base64'),sha256:hash(f.bytes)}))};
  const key=scryptSync(secret,salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024});
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(format));
  const body=Buffer.concat([cipher.update(deflateSync(Buffer.from(JSON.stringify(payload)))),cipher.final()]);
  await mkdir(join(destination,'private'),{mode:0o700});
  await writeFile(join(destination,'private/polezno-private.pzenc'),JSON.stringify({format,kdf:'scrypt-n16384-r8-p1',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),body:body.toString('base64')})+'\n',{flag:'wx',mode:0o600});
  const preliminary=liveSnapshot||running;
  if(!preliminary&&await activeLock(config.databasePath))throw new Error('Source restarted while packaging; final transfer refused');
  const report=JSON.parse(await readFile(join(root,'docs/verification-results.json'),'utf8'));
  const state={format:1,createdAt,timezone:'Europe/Moscow',sourceHost:hostname(),sourceProject:root,preliminary,sourceRunningAtSnapshot:running,sourceStoppedAtBuild:!running,requiresFinalSnapshotAfterSourceStop:preliminary,snapshot,pending,testsAtSource:report.tests,privatePathsNormalized:['DATABASE_PATH','KNOWLEDGE_PATH','CATALOG_PATH'],autostartIncluded:false,rawSecretsIncluded:false};
  await writeFile(join(destination,'TRANSFER-STATE.json'),JSON.stringify(state,null,2)+'\n',{flag:'wx'});
  const guide=(await readFile(join(assets,'START-HERE.template.md'),'utf8')).replaceAll('{{TEST_COUNT}}',String(report.tests.total)).replaceAll('{{CREATED_DATE}}',new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())).replaceAll('{{KEY_FILE}}',destination.split(/[\\/]/).at(-1)+'-key.txt').replaceAll('{{BUILD_STATE}}',preliminary?'ПРЕДВАРИТЕЛЬНАЯ КОПИЯ: исходный бот продолжает работать. Перед боевым запуском нужен финальный пакет после его остановки.':'ФИНАЛЬНАЯ КОПИЯ: локальный исходный бот был остановлен при сборке. Убедитесь, что он не запущен снова.');
  await writeFile(join(destination,'START-HERE.md'),guide,{flag:'wx'});
  const names=await filesAt(destination),checksums={};
  const needles=[secret,...Object.entries(env).filter(([name,value])=>/TOKEN|KEY|PASSWORD|SECRET/i.test(name)&&value.length>=8).map(([,value])=>value)];
  for(const name of names) {
    if(name==='polezno/.env'||/\.sqlite(?:$|[.-])|\.lock\.pid$/.test(name)||name.endsWith('-key.txt'))throw new Error('Private file in public package');
    const bytes=await readFile(join(destination,name));
    if(needles.some(value=>bytes.includes(Buffer.from(value))))throw new Error('Secret scan failed');
    checksums[name]=hash(bytes);
  }
  await writeFile(join(destination,'SHA256SUMS.json'),JSON.stringify({format:1,files:checksums},null,2)+'\n',{flag:'wx'});
  await writeFile(keyFile,secret+'\n',{flag:'wx',mode:0o600});
  return {prepared:true,preliminary,files:names.length+1,snapshot:snapshot,sourceCodeChanged:false,sourceBotStopped:false,keyStoredSeparately:true};
}
async function cli() {
  const args=process.argv.slice(2);let project,output,liveSnapshot=false;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--project')project=args[++i];
    else if(args[i]==='--out')output=args[++i];
    else if(args[i]==='--live-snapshot')liveSnapshot=true;
    else throw new Error('Unknown argument');
  }
  if(!project||!output)throw new Error('Explicit source and output paths required');
  console.log(JSON.stringify(await buildTransfer(project,output,{liveSnapshot})));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  await cli().catch(error=>{console.error(error.message==='Source bot is still running; stop it before the final transfer'?error.message:'Transfer preparation failed; inspect paths and configuration locally. Secret values omitted.');process.exitCode=1;});
}
