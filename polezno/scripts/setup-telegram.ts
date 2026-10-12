import {loadConfig} from '../src/config.ts';
import {Telegram} from '../src/telegram.ts';

type Command={command:string;description:string};
const users:Command[]=[
  {command:'start',description:'Открыть главное меню'},
  {command:'help',description:'Как пользоваться ботом'},
  {command:'doctor',description:'Передать вопрос врачу'},
  {command:'status',description:'Статус обращения'}
];
const doctors:Command[]=[
  {command:'start',description:'Открыть кабинет врача'},
  {command:'help',description:'Инструкция для врача'},
  {command:'cases',description:'Мои активные обращения'},
  {command:'case',description:'Выбрать обращение: /case номер'},
  {command:'close',description:'Завершить выбранное обращение'}
];
const admins:Command[]=[
  {command:'stats',description:'Статистика обращений'},
  {command:'retry',description:'Повторить неудачные доставки'}
];
const description='Polezno · помощник по здоровью\n\n💬 Ответы ИИ по справочным материалам\n👨‍⚕️ Связь с врачом по личным вопросам\n📋 Статус обращения в одном меню\n\nНажмите «Начать» или напишите /start, чтобы открыть кнопки. Файлы и анализы передаются врачу.';
const shortDescription='Помощник по здоровью: справочные ответы ИИ и связь с врачом. Меню — /start.';
async function main():Promise<void> {
  const config=loadConfig();
  const scopes:{scope:Record<string,unknown>;commands:Command[]}[]=[{scope:{type:'default'},commands:users}];
  for(const id of new Set([...config.doctorIds,...config.adminIds])) {
    const commands=config.doctorIds.includes(id)?[...doctors]:[{command:'help',description:'Инструкция для администратора'}];
    if(config.adminIds.includes(id))commands.push(...admins);
    scopes.push({scope:{type:'chat',chat_id:id},commands});
  }
  if(!process.argv.includes('--apply')) {
    console.log(JSON.stringify({applied:false,defaultCommands:users,privateRoleScopes:scopes.length-1,description,shortDescription}));return;
  }
  if(config.mode!=='live'||!config.token)throw new Error('Live configuration required');
  const telegram=new Telegram(config.token);
  try {
    for(const item of scopes)await telegram.call('setMyCommands',{...item,language_code:''});
    await telegram.call('setMyDescription',{description,language_code:''});
    await telegram.call('setMyShortDescription',{short_description:shortDescription,language_code:''});
    await telegram.call('setChatMenuButton',{menu_button:{type:'commands'}});
    const [commandResults,profile,shortProfile,menu]=await Promise.all([
      Promise.all(scopes.map(item=>telegram.call('getMyCommands',{scope:item.scope,language_code:''}))),
      telegram.call('getMyDescription',{language_code:''}),
      telegram.call('getMyShortDescription',{language_code:''}),
      telegram.call('getChatMenuButton',{})
    ]);
    const commandsVerified=commandResults.every((result:any,index:number)=>Array.isArray(result)&&JSON.stringify(result.map(({command,description}:Command)=>({command,description})))===JSON.stringify(scopes[index]!.commands));
    const verified=commandsVerified&&profile.description===description&&shortProfile.short_description===shortDescription&&menu.type==='commands';
    console.log(JSON.stringify({applied:true,verified,defaultCommands:users.length,privateRoleScopes:scopes.length-1,doctorScopes:config.doctorIds.length,adminScopes:config.adminIds.length}));
    if(!verified)process.exitCode=1;
  } finally {telegram.stop();}
}
main().catch(()=>{console.error('Telegram setup failed; verify the local configuration and retry.');process.exitCode=1;});
