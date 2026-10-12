import {contentOf} from './policy.ts';
import type {Config,TgMessage} from './types.ts';

export const MENU={ask:'💬 Задать вопрос',doctor:'👨‍⚕️ Связаться с врачом',status:'📋 Статус обращения',help:'ℹ️ Помощь',cases:'📂 Мои обращения',stats:'📊 Статистика',retry:'🔄 Повторить доставки'} as const;
const commands=new Map<string,string>([[MENU.ask,'/ask'],[MENU.doctor,'/doctor'],[MENU.status,'/status'],[MENU.help,'/help'],[MENU.cases,'/cases'],[MENU.stats,'/stats'],[MENU.retry,'/retry']]);

// Only a new, standalone text can be a keyboard action. Media and edits remain content.
export function menuCommand(m:TgMessage,edited=false):string|undefined {
  if(edited||!m.text)return;
  const content=contentOf(m);
  if(!content.kind&&!content.unsupported)return commands.get(m.text);
}
export function keyboard(config:Config,id:number):object {
  const doctor=config.doctorIds.includes(id),admin=config.adminIds.includes(id);
  const rows:string[][]=doctor?[[MENU.cases,MENU.help]]:admin?[[MENU.help]]:[[MENU.ask,MENU.doctor],[MENU.status,MENU.help]];
  if(admin)rows.push([MENU.stats,MENU.retry]);
  return {keyboard:rows.map(row=>row.map(text=>({text}))),resize_keyboard:true,is_persistent:true,one_time_keyboard:false,input_field_placeholder:doctor?'Ответьте на сообщение нужного обращения':admin?'Выберите действие в меню':'Напишите вопрос или выберите действие'};
}
export const caseLabel=(id:string):string=>'№ '+id.slice(0,8);
export const USER_HOME='Polezno · помощник по здоровью\n\nЗадайте вопрос о здоровье и добавках — ИИ ответит по справочным материалам. Личные рекомендации, назначения и анализы передаются врачу.\n\n💬 Вопрос — просто напишите его в чат.\n👨‍⚕️ Врач — передать текущий разговор специалисту.\n📋 Статус — узнать, кто отвечает сейчас.\n\nПеред отправкой файлов скройте ФИО и контакты: содержимое и имена файлов автоматически не обезличиваются.';
