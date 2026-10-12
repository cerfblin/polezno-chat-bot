import {loadConfig} from '../src/config.ts';
import {importCatalog,Knowledge,readJson,validateKnowledge} from '../src/knowledge.ts';
const source=process.argv[2];
if(!source) {console.error('Usage: pnpm import <local JSON file or HTTPS URL>');process.exitCode=1;}
else {
  try {const config=loadConfig();const items=validateKnowledge(await readJson(config.knowledgePath));console.log('Imported products: '+await importCatalog(source,config.catalogPath,fetch,products=>{new Knowledge(items,products,config.catalogMaxAgeDays);}));}
  catch {console.error('Import rejected; previous catalog remains unchanged. Check source JSON, fields and HTTPS URL.');process.exitCode=1;}
}
