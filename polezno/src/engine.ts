import {Store} from './store.ts';
import {contentOf,redact,route,sourcePayload,splitText,waitingText} from './policy.ts';
import type {Config,Content,Conversation,TgMessage,Update,Evidence} from './types.ts';
import {keyboard,menuCommand,caseLabel,USER_HOME} from './ui.ts';

export const URGENT='Если есть угроза жизни или выраженное ухудшение состояния, обратитесь в местную экстренную службу сейчас. Не ждите ответа в очереди бота.';
export class Engine {
  store:Store; config:Config; now:()=>number;
  constructor(store:Store,config:Config,now:()=>number=Date.now) { this.store=store;this.config=config;this.now=now; }
  say(chat:number,text:string,id:string|null=null,category='general',version:number|null=null,buttons?:unknown,catalogEvidence:Evidence[]=[]):void {
    const parts=splitText(text);
    parts.forEach((part,i)=>this.store.out('sendMessage',{chat_id:chat,text:part,...(i===parts.length-1&&buttons?{reply_markup:buttons}:{})},id,category,version,catalogEvidence));
  }
  button(id:string,action='close'):unknown {
    return {inline_keyboard:[[{text:action==='claim'?'👨‍⚕️ Взять обращение':'✅ Завершить обращение',callback_data:action+':'+id}]]};
  }
  menu(chat:number,text:string,id:string|null=null):void {this.say(chat,text,id,'general',null,keyboard(this.config,chat));}
  userStatus(chat:number):void {
    const c=this.store.current(chat);
    const text=!c?'💬 Можно задать вопрос\n\nАктивного обращения нет. Напишите вопрос — начнётся новый разговор.':c.state==='queued'?'🕓 Ожидаем врача\n\n'+waitingText(new Date(this.now()),this.config.timezone,this.config.schedule)+'\n\nУточнения и файлы можно отправлять в этот чат.':c.state==='doctor'?'👨‍⚕️ Врач на связи\n\nОбращение '+caseLabel(c.id)+' принято. Пишите сюда — сообщения и файлы будут переданы врачу.':'💬 Отвечает ИИ\n\nНапишите вопрос или уточнение. Для личной консультации нажмите «Связаться с врачом».';
    this.menu(chat,text,c?.id);
  }
  caseList(doctor:number,page=0):void {
    const cases=this.store.cases(doctor),selected=this.store.selected(doctor),size=8;
    const pages=Math.max(1,Math.ceil(cases.length/size)),current=Math.min(page,pages-1);
    if(!cases.length) {this.menu(doctor,'📂 Мои обращения\n\nАктивных обращений нет. Новые можно принять в рабочей группе.');return;}
    const rows=cases.slice(current*size,(current+1)*size).map(c=>[{text:(c.id===selected?'● ':'')+'Обращение '+caseLabel(c.id),callback_data:'select:'+c.id}]);
    const navigation=[];
    if(current>0)navigation.push({text:'← Назад',callback_data:'cases:'+(current-1)});
    if(current+1<pages)navigation.push({text:'Далее →',callback_data:'cases:'+(current+1)});
    if(navigation.length)rows.push(navigation);
    this.say(doctor,'📂 Мои обращения · '+cases.length+'\n\nВыберите, кому ответить. ● — выбранное обращение.\nСтраница '+(current+1)+' из '+pages+'.',null,'general',null,{inline_keyboard:rows});
  }
  selectCase(doctor:number,id:string):boolean {
    const c=this.store.get(id);
    if(!c||c.state!=='doctor'||c.doctor_id!==doctor)return false;
    this.store.select(doctor,id);
    this.say(doctor,'Выбрано обращение '+caseLabel(id)+'.\n\nСледующее сообщение без reply будет отправлено в него. Чтобы ответить в другое обращение, используйте ответ на его сообщение или кнопку «Мои обращения».',id,'case',null,this.button(id));
    return true;
  }
  confirmClose(doctor:number,id:string):boolean {
    const c=this.store.get(id);
    if(!c||c.state!=='doctor'||c.doctor_id!==doctor)return false;
    this.say(doctor,'Завершить обращение '+caseLabel(id)+'?\n\nПосле завершения новые вопросы пользователя начнут отдельный разговор.',id,'case',null,{inline_keyboard:[[{text:'✅ Да, завершить',callback_data:'finish:'+id},{text:'Продолжить консультацию',callback_data:'keep:'+id}]]});
    return true;
  }
  relay(chat:number,content:Content,id:string,category='relay',prefix=''):void {
    const text=prefix+(content.edited?'[Правка сообщения]\n':'')+redact(content.text);
    if(!content.kind || !content.fileId) { this.say(chat,text||'[Нет текстового содержимого]',id,category); return; }
    // A new send* request has no forward-origin or Telegram profile of the author.
    const methods:Record<string,string>={photo:'sendPhoto',document:'sendDocument',video:'sendVideo',audio:'sendAudio',voice:'sendVoice',animation:'sendAnimation',sticker:'sendSticker',video_note:'sendVideoNote'};
    if(['sticker','video_note'].includes(content.kind)) {
      this.say(chat,text || 'Вложение',id,category);
      this.store.out(methods[content.kind],{chat_id:chat,[content.kind]:content.fileId},id,category);
    } else {
      const caption=splitText(text||'Вложение',900);
      this.store.out(methods[content.kind],{chat_id:chat,[content.kind]:content.fileId,caption:caption.shift()},id,category);
      for(const part of caption)this.say(chat,part,id,category);
    }
  }
  escalate(c:Conversation,urgent=false):void {
    if(this.store.queue(c.id,this.now())) {
      this.store.append(c.id,'system',{text:'Обращение передано врачу.'},this.now());
      this.say(this.config.groupId,'🩺 Новое обращение '+caseLabel(c.id)+'\n\nТребуется консультация врача.'+(urgent?'\n⚠️ Отмечены срочные формулировки.':'')+'\n\nПосле приёма история и файлы придут в личный чат бота.',c.id,'general',null,this.button(c.id,'claim'));
      this.userStatus(c.user_id);
    }
  }
  handle(update:Update):boolean {
    this.store.ingest(update);
    return this.store.tx(()=>{
      if(this.store.processed(update.update_id))return false;
      if(update.callback_query)this.callback(update.callback_query);
      else {
        const m=update.edited_message || update.message;
        if(m && !m.from?.is_bot && m.chat.type==='private' && m.from && m.chat.id===m.from.id) {
          if(this.config.doctorIds.includes(m.from.id))this.doctor(m,Boolean(update.edited_message));
          else if(this.config.adminIds.includes(m.from.id))this.admin(m,Boolean(update.edited_message));
          else this.user(m,Boolean(update.edited_message));
        }
      }
      this.store.done(update.update_id);return true;
    });
  }
  callback(cb:NonNullable<Update['callback_query']>):void {
    const m=cb.message; const [action,id]=cb.data?.split(':')||[];
    let message='Недоступное действие.';
    if(action==='claim' && id && m?.chat.id===this.config.groupId && this.config.doctorIds.includes(cb.from.id)) {
      if(!this.store.isReady(cb.from.id))message='Сначала откройте личный чат бота и отправьте /start.';
      else if(this.store.claim(id,cb.from.id,this.now())) {
        const c=this.store.get(id)!;
        message='Обращение закреплено за вами.';
        this.store.out('editMessageReplyMarkup',{chat_id:m.chat.id,message_id:m.message_id,reply_markup:{inline_keyboard:[]}},id);
        this.say(cb.from.id,'Вы приняли обращение '+caseLabel(id)+'.\n\nНиже история текущего разговора. Отвечайте на сообщение нужного обращения или выберите его кнопкой «Мои обращения».',id,'case',null,this.button(id));
        for(const entry of this.store.history(id)) {
          const labels={user:'Пользователь',assistant:'ИИ',doctor:'Врач',system:'Система'};
          this.relay(cb.from.id,JSON.parse(entry.content),id,'history','Обращение '+caseLabel(id)+' · '+labels[entry.role]+'\n');
        }
        this.userStatus(c.user_id);
      } else message='Обращение уже принято или закрыто.';
    } else if(id && m?.chat.type==='private' && m.chat.id===cb.from.id && this.config.doctorIds.includes(cb.from.id) && this.store.isReady(cb.from.id)) {
      if(action==='cases'&&/^\d{1,6}$/.test(id)) {this.caseList(cb.from.id,Number(id));message='Список обращений.';}
      else if(action==='select')message=this.selectCase(cb.from.id,id)?'Обращение выбрано.':'Обращение недоступно или уже завершено.';
      else if(action==='close')message=this.confirmClose(cb.from.id,id)?'Подтвердите завершение.':'Вы не можете закрыть это обращение.';
      else if(action==='finish'||action==='keep') {
        const c=this.store.get(id);
        if(c?.state==='doctor'&&c.doctor_id===cb.from.id) {
          if(action==='finish')message=this.close(id,cb.from.id)?'Обращение завершено.':'Обращение уже завершено.';
          else message='Продолжайте консультацию. Выбранное обращение не изменилось.';
          this.store.out('editMessageReplyMarkup',{chat_id:m.chat.id,message_id:m.message_id,reply_markup:{inline_keyboard:[]}},id);
        } else message='Обращение недоступно или уже завершено.';
      }
    }
    this.store.out('answerCallbackQuery',{callback_query_id:cb.id,text:message,show_alert:false});
  }
  close(id:string,doctorId:number):boolean {
    const c=this.store.get(id);
    if(!c || !this.store.closeCase(id,doctorId,this.now()))return false;
    this.store.append(id,'system',{text:'Врач завершил обращение.'},this.now());
    this.menu(c.user_id,'✅ Консультация завершена\n\nЕсли появится новый вопрос, напишите его здесь — начнётся новый разговор с ИИ.',id);
    this.menu(doctorId,'✅ Обращение '+caseLabel(id)+' завершено.\n\nСледующее можно выбрать кнопкой «Мои обращения».',id);
    return true;
  }
  admin(m:TgMessage,edited=false):boolean {
    const command=menuCommand(m,edited)||(m.text||'').trim().split(/\s+/)[0].split('@')[0];
    if(command==='/stats') {
      const stats=this.store.stats();
      const states:Record<string,string>={ai:'Диалоги с ИИ',queued:'Ожидают врача',doctor:'У врача',closed:'Завершены'};
      const events:Record<string,string>={claimed:'принято',closed:'завершено'};
      const text=['📊 Статистика обращений','',...stats.states.map(x=>(states[x.state]||x.state)+': '+x.n),'','Приём/закрытие по врачам:',...stats.doctors.map(x=>'Врач '+x.doctor_id+' · '+(events[x.event]||x.event)+': '+x.n),'','Источники обращений (последний переход):',...stats.sources.map(x=>x.source+': '+x.n),'','Первый источник пользователей:',...stats.firstSources.map(x=>x.source+': '+x.n),'','Ошибки доставки: '+stats.failed].join('\n');
      this.menu(m.chat.id,text); return true;
    }
    if(command==='/retry') { this.menu(m.chat.id,'🔄 Поставлено на повтор: '+this.store.retry());return true; }
    if(!this.config.doctorIds.includes(m.chat.id)) { this.menu(m.chat.id,'Polezno · администратор\n\n📊 Статистика — обращения, врачи и источники переходов.\n🔄 Повторить доставки — вернуть сообщения с ошибкой в очередь отправки.'); return true; }
    return false;
  }
  doctor(m:TgMessage,edited=false):void {
    const text=m.text||''; const [raw,arg]=text.trim().split(/\s+/); const cmd=menuCommand(m,edited)||(raw||'').split('@')[0];
    if(['/stats','/retry'].includes(cmd)) {
      if(this.config.adminIds.includes(m.chat.id))this.admin(m,edited);
      else this.say(m.chat.id,'Команда доступна только администратору.');
      return;
    }
    if(cmd==='/start'||cmd==='/help'||cmd==='/menu') {
      this.store.ready(m.chat.id);
      const selected=this.store.selected(m.chat.id);
      this.menu(m.chat.id,'Polezno · кабинет врача'+(this.config.adminIds.includes(m.chat.id)?' и администратора':'')+'\n\nАктивных обращений: '+this.store.cases(m.chat.id).length+(selected?'\nВыбрано: '+caseLabel(selected):'')+'\n\n1. Примите обращение в рабочей группе.\n2. Отвечайте на его сообщение или выберите обращение в меню.\n3. Завершите консультацию кнопкой под карточкой.\n\n«Мои обращения» — выбрать собеседника. Ответ через reply всегда относится к сообщению, на которое вы отвечаете.\nКоманды /cases, /case <номер> и /close также работают.');return;
    }
    if(!this.store.isReady(m.chat.id)) {this.say(m.chat.id,'Сначала отправьте /start.');return;}
    if(cmd==='/cases') {this.caseList(m.chat.id);return;}
    if(cmd==='/ask'||cmd==='/doctor'||cmd==='/status') {this.menu(m.chat.id,'Вы в кабинете врача. Выберите обращение кнопкой «Мои обращения».');return;}
    if(cmd==='/case') {
      if(!arg||!this.selectCase(m.chat.id,arg))this.menu(m.chat.id,'Обращение недоступно. Выберите активное кнопкой «Мои обращения».');
      return;
    }
    const id=edited?this.store.incomingCase(m.chat.id,m.message_id):m.reply_to_message?this.store.byReply(m.chat.id,m.reply_to_message.message_id):this.store.selected(m.chat.id);
    const c=id?this.store.get(id):undefined;
    if(!c || c.state!=='doctor'||c.doctor_id!==m.chat.id) {this.menu(m.chat.id,'Выберите своё активное обращение кнопкой «Мои обращения» или ответьте на его сообщение.');return;}
    if(cmd==='/close') {this.close(c.id,m.chat.id);return;}
    if(cmd.startsWith('/')) {this.say(m.chat.id,'Неизвестная команда. /help');return;}
    const content=contentOf(m,edited);
    if(content.unsupported) {this.say(m.chat.id,'Поддерживаются текст, фото, документы и медиа. Контакты и геопозиция не передаются.');return;}
    this.store.linkIncoming(m.chat.id,m.message_id,c.id);
    this.store.append(c.id,'doctor',content,this.now());
    this.relay(c.user_id,content,c.id,'relay',content.kind?'':'Врач:\n');
    this.say(m.chat.id,'↗ Ответ поставлен на отправку · '+caseLabel(c.id),c.id,'case',null,this.button(c.id));
  }
  user(m:TgMessage,edited=false):void {
    const text=m.text||''; const cmd=menuCommand(m,edited)||text.trim().split(/\s+/)[0].split('@')[0];
    this.store.user(m.chat.id,cmd==='/start'?sourcePayload(text):null,this.now());
    if(['/stats','/retry','/cases','/case','/close'].includes(cmd)) {this.say(m.chat.id,'Команда недоступна. Для консультации напишите вопрос или /doctor.');return;}
    if(cmd==='/start'||cmd==='/help'||cmd==='/menu') {
      const state=this.store.current(m.chat.id)?.state;
      this.menu(m.chat.id,USER_HOME+(state==='queued'?'\n\n🕓 Сейчас ваше обращение ожидает врача.':state==='doctor'?'\n\n👨‍⚕️ Сейчас сообщения получает врач.':''));return;
    }
    if(cmd==='/status') {
      this.userStatus(m.chat.id);return;
    }
    if(cmd==='/ask') {
      const c=this.store.current(m.chat.id);
      if(c&&c.state!=='ai')this.userStatus(m.chat.id);
      else this.menu(m.chat.id,'💬 О чём хотите узнать?\n\nНапишите вопрос в чат. Например: «Что такое витамин D?» или «Для чего нужны пищевые добавки?»'+(c?'\n\nПродолжим текущий разговор.':''));
      return;
    }
    const current=this.store.current(m.chat.id);
    if(cmd==='/doctor'&&current&&current.state!=='ai') {this.userStatus(m.chat.id);return;}
    if(cmd.startsWith('/')&&cmd!=='/doctor') {this.say(m.chat.id,'Неизвестная команда. /help');return;}
    const content=contentOf(m,edited);
    if(cmd==='/doctor'&&!edited&&!content.kind)content.text='Хочу обратиться к врачу.';
    if(content.unsupported) {this.say(m.chat.id,'Поддерживаются текст, фото, документы и медиа. Контакты и геопозиция не передаются.');return;}
    const originalId=edited?this.store.incomingCase(m.chat.id,m.message_id):undefined;
    if(edited && (!originalId || this.store.get(originalId)?.state==='closed')) {this.say(m.chat.id,'Правка не относится к активному разговору. Отправьте сообщение заново.');return;}
    let c=(originalId?this.store.get(originalId):this.store.current(m.chat.id))||this.store.create(m.chat.id,this.now());
    this.store.linkIncoming(m.chat.id,m.message_id,c.id);

    this.store.append(c.id,'user',content,this.now());
    const target=route(content.text,Boolean(content.kind));
    if(target==='urgent')this.say(m.chat.id,URGENT,c.id);
    if(c.state==='doctor') {this.relay(c.doctor_id!,content,c.id,'relay','Обращение '+caseLabel(c.id)+' · Пользователь\n');return;}
    if(c.state==='queued')return;
    if(target==='doctor'||target==='urgent'||cmd==='/doctor') {this.escalate(c,target==='urgent');return;}
    if(target==='shop') {
      this.say(m.chat.id,'По оплате, доставке и работе магазина обратитесь к менеджеру в Mini App.'+(this.config.miniAppUrl?'\n'+this.config.miniAppUrl:' Ссылка на Mini App пока не настроена.'),c.id);return;
    }
    c=this.store.bump(c.id);
    if(!this.store.allowAi(m.chat.id,this.now(),this.config.ratePerMinute)) {
      this.say(m.chat.id,'Слишком много запросов. Подождите минуту и повторите вопрос. Врач доступен по /doctor.',c.id);return;
    }
    this.store.ai(c.id,c.version);
  }
}


