import {createSnapshot} from '../src/backup.ts';
import {loadConfig} from '../src/config.ts';
const destination=process.argv[2];
if(!destination){console.error('Usage: node scripts/backup.ts <destination.sqlite>');process.exitCode=1;}
else {
  try {
    const config=loadConfig();
    const result=await createSnapshot(config.databasePath,destination);
    console.log(JSON.stringify({snapshotCreated:true,verified:true,...result}));
  }catch{console.error('Backup failed. Check paths and permissions.');process.exitCode=1;}
}

