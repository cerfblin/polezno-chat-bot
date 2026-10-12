import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadConfig} from '../src/config.ts';
import {createSnapshot} from '../src/backup.ts';
try {
  const config=loadConfig();
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const destination=join(dirname(config.databasePath),'backups','polezno-'+stamp+'-'+randomUUID().slice(0,8)+'.sqlite');
  const result=await createSnapshot(config.databasePath,destination);
  console.log(JSON.stringify({snapshotCreated:true,verified:true,...result}));
} catch {console.error('Scheduled backup failed. Check database access and disk space.');process.exitCode=1;}
