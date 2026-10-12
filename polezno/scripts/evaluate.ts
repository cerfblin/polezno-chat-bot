import {writeFile} from 'node:fs/promises';
import {loadConfig} from '../src/config.ts';
import {Knowledge} from '../src/knowledge.ts';
import {CompatibleAnswerer,ExtractiveAnswerer} from '../src/ai.ts';
import {evaluateScenarios} from '../src/evaluation.ts';

const config=loadConfig();const live=process.argv.includes('--live');
if(live&&!config.llmKey)throw new Error('LLM_API_KEY is required for --live');
const knowledge=await Knowledge.load(config.knowledgePath,config.catalogPath,config.catalogMaxAgeDays);
const results=await evaluateScenarios(config,knowledge,live?new CompatibleAnswerer(config):new ExtractiveAnswerer());
const report={date:new Date().toISOString(),mode:live?'synthetic-external-api':'offline',provider:live?config.llmProvider:'extractive',model:live?config.llmModel:null,telegramRequests:0,patientDataUsed:false,knowledgeItems:knowledge.items.length,total:results.length,passed:results.filter(x=>x.passed).length,results};
const outputIndex=process.argv.indexOf('--output');
if(outputIndex>=0){const path=process.argv[outputIndex+1];if(!path||path.startsWith('--'))throw new Error('Provide --output path');await writeFile(path,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report));
if(report.passed!==report.total)process.exitCode=1;
