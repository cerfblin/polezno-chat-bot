import {writeFile} from 'node:fs/promises';
import {loadConfig} from '../src/config.ts';
import {Knowledge} from '../src/knowledge.ts';
import {configurationReadiness} from '../src/readiness.ts';
const args=process.argv.slice(2);
try {
  if(args.length&&!(args.length===2&&args[0]==='--output'))throw new Error('Arguments');
  const config=loadConfig();
  const report=configurationReadiness(config,await Knowledge.load(config.knowledgePath,config.catalogPath,config.catalogMaxAgeDays));
  if(args[1])await writeFile(args[1],JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}catch{console.error('Readiness audit failed. Check configuration and local content files. No secrets or patient messages are printed.');process.exitCode=1;}
