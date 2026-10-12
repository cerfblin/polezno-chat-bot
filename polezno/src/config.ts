import {resolve} from 'node:path';
import type {Config, Schedule} from './types.ts';
function integer(value: string | undefined, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('Invalid numeric configuration');
  return n;
}
function ids(value = ''): number[] {
  if (!value.trim()) return [];
  return [...new Set(value.split(',').map(x => integer(x.trim(), 0, 1)))];
}
export function httpsUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password) throw new Error('An HTTPS URL without credentials is required');
  return u.toString();
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const mode = env.MODE || 'demo';
  if (mode !== 'demo' && mode !== 'live') throw new Error('MODE must be demo or live');
  const timezone = env.TIMEZONE || 'Europe/Moscow';
  new Intl.DateTimeFormat('en', {timeZone: timezone}).format();
  let schedule: Schedule | undefined;
  if (env.WORK_SCHEDULE?.trim()) {
    const raw: unknown = JSON.parse(env.WORK_SCHEDULE);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid work schedule');
    for (const [day, ranges] of Object.entries(raw)) {
      if (!/^[1-7]$/.test(day) || !Array.isArray(ranges)) throw new Error('Invalid schedule day');
      for (const range of ranges) {
        if (!Array.isArray(range) || range.length !== 2 || !range.every(x => typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x)) || range[0] === range[1]) throw new Error('Invalid schedule interval');
      }
    }
    schedule = raw as Schedule;
  }
  const llmProvider=env.LLM_PROVIDER || 'compatible';
  if(!['compatible','openrouter-free'].includes(llmProvider))throw new Error('Invalid LLM_PROVIDER');
  const llmAnswerMode=env.LLM_ANSWER_MODE || 'sources';
  if(llmAnswerMode!=='sources'&&llmAnswerMode!=='direct')throw new Error('Invalid LLM_ANSWER_MODE');
  const llmBaseUrl=httpsUrl(env.LLM_BASE_URL || (llmProvider==='openrouter-free'?'https://openrouter.ai/api/v1':'https://api.openai.com/v1')).replace(/\/$/,'');
  if(llmProvider==='openrouter-free' && llmBaseUrl!=='https://openrouter.ai/api/v1')throw new Error('Free-only mode requires the OpenRouter endpoint');
  const llmModel=env.LLM_MODEL || (llmProvider==='openrouter-free'?'apodex/apodex-1.1-mini:free':'');
  if(llmProvider==='openrouter-free' && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+:free$/.test(llmModel))throw new Error('Free-only mode requires an explicit :free model');
  const catalogSource=env.CATALOG_SOURCE?.trim()||'';
  if(catalogSource&&/^[a-z][a-z0-9+.-]*:/i.test(catalogSource)&&! /^[a-z]:[\\/]/i.test(catalogSource))httpsUrl(catalogSource);
  const config: Config = {
    mode, token: env.TELEGRAM_BOT_TOKEN || '', groupId: integer(env.DOCTOR_GROUP_ID, -1001, -Number.MAX_SAFE_INTEGER, -1),
    doctorIds: ids(env.DOCTOR_IDS), adminIds: ids(env.ADMIN_IDS),
    databasePath: resolve(cwd, env.DATABASE_PATH || 'var/polezno.sqlite'),
    knowledgePath: resolve(cwd, env.KNOWLEDGE_PATH || 'data/knowledge.json'),
    catalogPath: resolve(cwd, env.CATALOG_PATH || 'data/catalog.json'),
    catalogSource:catalogSource?(/^https:/i.test(catalogSource)?catalogSource:resolve(cwd,catalogSource)):'',
    catalogSyncSeconds:integer(env.CATALOG_SYNC_SECONDS,300,60,86400),
    miniAppUrl: env.MINI_APP_URL ? httpsUrl(env.MINI_APP_URL) : '', timezone, schedule,
    llmProvider: llmProvider as Config['llmProvider'], llmBaseUrl,
    llmKey: env.LLM_API_KEY || '', llmModel, llmAnswerMode,
    llmTimeoutMs: integer(env.LLM_TIMEOUT_MS, llmProvider==='openrouter-free'?40000:20000, 1000, 120000),
    catalogMaxAgeDays: integer(env.CATALOG_MAX_AGE_DAYS, 7, 1, 365),
    ratePerMinute: integer(env.AI_RATE_PER_MINUTE, 10, 1, 100),
    port: integer(env.PORT, 3080, 1, 65535)
  };
  if (config.llmProvider==='compatible' && Boolean(config.llmKey) !== Boolean(config.llmModel)) throw new Error('Set both LLM_API_KEY and LLM_MODEL');
  if(mode==='live'&&config.llmAnswerMode==='direct'&&!config.llmKey)throw new Error('Direct live mode requires LLM_API_KEY');
  if (mode === 'live' && (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(config.token) || !env.DOCTOR_GROUP_ID || !config.doctorIds.length || !config.adminIds.length)) {
    throw new Error('Live mode requires TELEGRAM_BOT_TOKEN, DOCTOR_GROUP_ID, DOCTOR_IDS and ADMIN_IDS');
  }
  return config;
}
