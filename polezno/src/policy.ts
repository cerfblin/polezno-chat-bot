import type {Content, Schedule, TgMessage} from './types.ts';
export function redact(text: string): string {
  return text
    .replace(/(?:https?:\/\/)?(?:t\.me\/|telegram\.me\/)[^\s]+|tg:\/\/[^\s]+/giu, '[контакт скрыт]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu, '[email скрыт]')
    .replace(/@[a-z0-9_]{3,}/giu, '[контакт скрыт]')
    .replace(/(?:\+?\d[\d ()-]{8,}\d)/g, '[телефон скрыт]');
}
export function contentOf(m: TgMessage, edited = false): Content {
  const result: Content = {text: m.text || m.caption || '', edited};
  if (m.photo?.length) return {...result, kind: 'photo', fileId: m.photo.at(-1)!.file_id};
  for (const kind of ['animation','document','video','audio','voice','sticker','video_note'] as const) {
    if (m[kind]?.file_id) return {...result, kind, fileId: m[kind]!.file_id};
  }
  return {...result, unsupported: Boolean(m.contact || m.location || (!m.text && !m.caption))};
}
export function splitText(text: string, max = 3900): string[] {
  if (!Number.isInteger(max) || max < 2) throw new Error('Invalid message limit');
  const parts: string[] = [];
  let current = '';
  for (const char of text) {
    if (current.length + char.length > max) { parts.push(current); current = ''; }
    current += char;
  }
  if (current) parts.push(current);
  return parts.length ? parts : [' '];
}
export type Route = 'doctor'|'urgent'|'shop'|'ai';
export function route(text: string, attachment = false): Route {
  const s = text.toLowerCase().replace(/ё/g, 'е');
  if (/(не могу дышать|задыхаюсь|потер[яи].{0,6}сознани|сильн.{0,10}боль.{0,10}груд|не останавливается.{0,10}кров|срочн.{0,10}помощ|can.t breathe|unconscious)/u.test(s)) return 'urgent';
  if (attachment || /(врач|доктор|специалист|doctor|human)/u.test(s)) return 'doctor';
  const shop=/(оплат|достав|возврат|менеджер|статус заказа|чек|корзин|оператор[^.!?\n]{0,40}магазин|магазин[^.!?\n]{0,40}оператор)/u.test(s);
  const individual=/(?<!\p{L})(?:мне|я|для меня|ребен[а-я]*|детям|мам[аеыу]|пап[аеыу])(?=\s|[.,;:!?]|$)/u.test(s);
  const medical=/(витамин|добавк|препарат|лекарств|магни|желез|омега|таблет|капсул|лечени)/u.test(s);
  // Permission to arrange a purchase/delivery is distinct from permission to take a supplement.
  const medicalIntent=s.replace(/(?:можно|могу)(?:\s+ли)?(?:\s+(?:мне|я|нам))?\s+(?:оформить|оплатить|получить|заказать|купить|вернуть)(?=\s|[.!?,]|$)/gu,'');
  if(individual&&medical&&(/(?<!\p{L})(?:можно|могу|подойдет|подобра|подбери|выбра|посовету|рекоменд|принимать|пить|дать|давать|безопасн)/u.test(medicalIntent)||!shop&&/нужн/u.test(s)))return 'doctor';
  if (/(?:как|когда|сколько).{0,14}(?:принимать|пить|выпить|таблет|капсул)|сколько.{0,18}(?:витамина|магния|железа|омега)|(?:какую|какая).{0,12}доз/u.test(s)) return 'doctor';
  if (/(расшифр|интерпрет|болит|тошн|сыпь|головокруж|анализ|сним[окк]|мрт|(?:^|\s)кт(?=\s|$)|рентген|узи|назнач|дозиров|сколько.{0,12}(принимать|таблет|мг)|лечени|лечить|диагноз|беремен|кормлю|моему ребен|у меня|у ребенка|принимаю|совместим)/u.test(s)||!shop&&/мне.{0,15}(можно|нужн|подойдет)/u.test(s)) return 'doctor';
  if (shop) return 'shop';
  if (/оператор/u.test(s)) return 'doctor';
  return 'ai';
}
function minute(s: string): number { const [h,m] = s.split(':').map(Number); return h*60+m; }
export function workingNow(date: Date, timezone: string, schedule?: Schedule): boolean | null {
  if (!schedule) return null;
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone: timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const v = Object.fromEntries(parts.map(x=>[x.type,x.value]));
  const day = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(v.weekday)+1;
  const now = Number(v.hour)*60+Number(v.minute);
  const previous = day === 1 ? 7 : day-1;
  return (schedule[String(day)] || []).some(([a,b]) => minute(a)<minute(b) ? now>=minute(a)&&now<minute(b) : now>=minute(a)) ||
    (schedule[String(previous)] || []).some(([a,b])=>minute(a)>minute(b)&&now<minute(b));
}
export function waitingText(date: Date, timezone: string, schedule?: Schedule): string {
  const active = workingNow(date,timezone,schedule);
  if (active === null) return 'Обращение в очереди. Врач ответит, когда сможет его принять. Рабочий график пока не настроен; точное время ожидания неизвестно.';
  const hours = Object.entries(schedule!).map(([day,ranges])=>['','Пн','Вт','Ср','Чт','Пт','Сб','Вс'][Number(day)]+': '+ranges.map(x=>x.join('–')).join(', ')).join('; ');
  return 'Обращение в очереди. '+(active ? 'Сейчас рабочее время; свободный врач примет обращение.' : 'Сейчас нерабочее время; врач примет обращение в рабочие часы.')+' График ('+timezone+'): '+(hours || 'рабочих интервалов нет')+'. Точное время ответа неизвестно.';
}
export function sourcePayload(text: string): string | null {
  const payload = text.trim().split(/\s+/)[1];
  return payload && /^[A-Za-z0-9_-]{1,64}$/.test(payload) ? payload : null;
}
export function safeGeneratedText(text: string): boolean {
  return text.length > 0 && text.length <= 12000 &&
    !/(https?:\/\/|www\.|t\.me\/|tg:\/\/|[a-z0-9-]+\.(?:ru|com|org|net|io|рф)\b)/iu.test(text) &&
    !/(\d+[.,]?\d*\s*(мг|мкг|мл|таблет[а-я]*|капсул[а-я]*|mg|mcg|ml)(?=\s|[.,;:!?)]|$)|принимайте|вам следует принимать|отмените.{0,20}(препарат|лекар)|у вас.{0,20}(диагноз|дефицит))/iu.test(text);
}


