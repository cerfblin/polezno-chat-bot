import {Knowledge} from './knowledge.ts';
import type {Config} from './types.ts';

// Configuration audit only. No API calls, message reads, secret values or identifiers.
export function configurationReadiness(config:Config,knowledge:Knowledge,now=Date.now()) {
  const enabled=knowledge.items.filter(x=>x.enabled);
  const unreviewed=enabled.filter(x=>!x.clinicianReviewed).length;
  const scheduled=Boolean(config.schedule&&Object.values(config.schedule).some(r=>r.length));
  const checks={
    catalog:{status:knowledge.productEvidence(now).length?'configured':'missing',records:knowledge.products.length,
      eligibleProducts:knowledge.productEvidence(now).length,sourceConfigured:Boolean(config.catalogSource)},
    materials:{status:!enabled.length?'missing':unreviewed?'needs_review':'marked_reviewed',enabled:enabled.length,withoutClinicianReview:unreviewed},
    doctors:{status:config.doctorIds.length?'configured':'missing',configuredCount:config.doctorIds.length,qualificationConfirmed:false},
    schedule:{status:scheduled?'configured':'missing',timezone:config.timezone},
    ai:{status:config.llmKey&&config.llmModel?'configured':'missing',externalAvailabilityChecked:false,
      freeOnly:config.llmProvider==='openrouter-free'},
    miniApp:{status:config.miniAppUrl?'configured':'deferred'}
  };
  return {scope:'Configuration and content metadata only; not clinical or deployment approval',
    patientDataRead:false,externalRequests:0,checks,
    manualAcceptance:['Confirm practicing doctors and the working schedule','Approve sources, answer boundaries and a responsible reviewer',
      'Verify remaining live Telegram concurrency, AI handoff and delivery recovery','Agree privacy boundaries and access/retention',
      'Verify permanent hosting, startup, backup and restore'],
    fullSpecificationAccepted:false};
}
