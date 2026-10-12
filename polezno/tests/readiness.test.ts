import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.ts';
import {Knowledge} from '../src/knowledge.ts';
import {configurationReadiness} from '../src/readiness.ts';

test('readiness distinguishes unavailable catalog, unreviewed materials and missing schedule without revealing secrets',()=>{
  const config=loadConfig({MODE:'live',TELEGRAM_BOT_TOKEN:'123:PRIVATE_TEST_TOKEN_123456789',DOCTOR_GROUP_ID:'-1999',DOCTOR_IDS:'1991',ADMIN_IDS:'1992',LLM_PROVIDER:'openrouter-free',LLM_API_KEY:'PRIVATE_LLM_KEY'});
  const knowledge=new Knowledge([{id:'k',title:'Справка',text:'Тест.',url:'https://example.org',keywords:['тест'],enabled:true,reviewedBy:'not clinical',checkedAt:'2026-10-12',clinicianReviewed:false}],[]);
  const report=configurationReadiness(config,knowledge);
  assert.equal(report.checks.catalog.status,'missing');assert.equal(report.checks.materials.status,'needs_review');
  assert.equal(report.checks.schedule.status,'missing');assert.equal(report.checks.doctors.qualificationConfirmed,false);
  assert.equal(report.checks.ai.freeOnly,true);assert.equal(report.fullSpecificationAccepted,false);
  const dump=JSON.stringify(report);
  for(const secret of ['PRIVATE_TEST_TOKEN','PRIVATE_LLM_KEY','1991','1992','1999'])assert(!dump.includes(secret));
});

test('configured working hours and metadata flags do not pretend to prove clinical or external acceptance',()=>{
  const config=loadConfig({WORK_SCHEDULE:'{"1":[["09:00","18:00"]]}',MINI_APP_URL:'https://example.org/app'});
  const report=configurationReadiness(config,new Knowledge([],[]));
  assert.equal(report.checks.schedule.status,'configured');assert.equal(report.checks.miniApp.status,'configured');
  assert.equal(report.checks.materials.status,'missing');assert.equal(report.checks.ai.externalAvailabilityChecked,false);
  assert.equal(report.externalRequests,0);assert.equal(report.patientDataRead,false);assert.equal(report.fullSpecificationAccepted,false);
});
