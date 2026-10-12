import {readFile,writeFile,rename,access} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

// Explicit packaging option for the owner's single PRIVATE archive.
// Keep the default builder's separate-key format unchanged.
export async function includePrivateKey(output) {
  const root=resolve(output),keyPath='private/restore-key.txt';
  const manifest=JSON.parse(await readFile(join(root,'SHA256SUMS.json'),'utf8'));
  const state=JSON.parse(await readFile(join(root,'TRANSFER-STATE.json'),'utf8'));
  if(manifest.format!==1||state.format!==1||state.keyIncluded||typeof state.preliminary!=='boolean')throw Error('Not a fresh transfer package');
  for(const [name,expected] of Object.entries(manifest.files)) {
    if(!name||name.startsWith('/')||name.includes('\\')||name.includes(':')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Unsafe package path');
    const digest=createHash('sha256').update(await readFile(join(root,name))).digest('hex');
    if(digest!==expected)throw Error('Package checksum mismatch');
  }
  try {await access(join(root,keyPath));throw Error('Internal key already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
  const external=root+'-key.txt',key=await readFile(external);
  if(!/^[A-Za-z0-9_-]{43}\r?\n?$/.test(key.toString()))throw Error('Invalid key file');
  let guide=await readFile(join(root,'START-HERE.md'),'utf8');
  const name=basename(root)+'-key.txt';
  if(!guide.includes(name))throw Error('Unrecognized guide');
  guide=guide.replace('# Polezno — передача на другой ПК и другому Codex','# Polezno — всё для переноса в одном ЧАСТНОМ архиве')
    .replace('2. Отдельный файл **'+name+'**. Хранить отдельно от архива; содержимое не вставлять в чат или логи.','Ключ уже включён: **private/restore-key.txt**. Отдельно ничего переносить не нужно. Этот ZIP даёт доступ к токенам Telegram/OpenRouter и приватной базе; не публиковать, не загружать в публичные репозитории и не вставлять содержимое ключей в чат. Шифрование внутреннего блока не защищает от владельца ZIP: ключ находится рядом.')
    .replace('и ключ расшифрования.','; ключ расшифрования по прямой просьбе владельца включён внутрь.')
    .replaceAll('ПУТЬ/'+name,keyPath)
    .replace('-NodePath "ПУТЬ/node.exe"','-NodePath "ПУТЬ/node.exe" -IncludeKey')
    .replace('Финальный ZIP и его ключ перенести на новый ПК','Финальный единый ZIP с внутренним ключом перенести на новый ПК')
    .replace('Настройки и история зашифрованы; восстанови локально,','Настройки и история зашифрованы, ключ включён в private/restore-key.txt по прямому решению владельца. Архив целиком приватный; восстанови локально,');
  await rename(external,join(root,keyPath));
  await writeFile(join(root,'START-HERE.md'),guide);
  Object.assign(state,{bundleType:'all-in-one-private',keyIncluded:true,keyPath,rawSecretsIncluded:true,settingsAndDatabaseEncrypted:true,wholeArchiveEncrypted:false,doNotPublish:true});
  await writeFile(join(root,'TRANSFER-STATE.json'),JSON.stringify(state,null,2)+'\n');
  const names=[...Object.keys(manifest.files),keyPath],checksums={};
  for(const name of names)checksums[name]=createHash('sha256').update(await readFile(join(root,name))).digest('hex');
  await writeFile(join(root,'SHA256SUMS.json'),JSON.stringify({format:1,files:checksums},null,2)+'\n');
  return {privateSingleArchive:true,keyIncluded:true,keyPath,preliminary:state.preliminary};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {if(process.argv.length!==3)throw Error('Output directory required');console.log(JSON.stringify(await includePrivateKey(process.argv[2])));}
  catch {console.error('Private single-archive packaging failed. Secret values omitted.');process.exitCode=1;}
}
