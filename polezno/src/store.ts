import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {AiJob, Content, Conversation, Outgoing, SavedMessage, Update, Evidence} from './types.ts';

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true});
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,first_source TEXT NOT NULL,last_source TEXT NOT NULL,created_at INTEGER NOT NULL)',
      "CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),state TEXT NOT NULL CHECK(state IN ('ai','queued','doctor','closed')),doctor_id INTEGER,version INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL,created_at INTEGER NOT NULL,closed_at INTEGER)",
      "CREATE UNIQUE INDEX IF NOT EXISTS one_open ON conversations(user_id) WHERE state!='closed'",
      "CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES conversations(id),role TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL)",
      'CREATE TABLE IF NOT EXISTS doctors(id INTEGER PRIMARY KEY,ready INTEGER NOT NULL DEFAULT 0)',
      'CREATE TABLE IF NOT EXISTS inbound_links(chat_id INTEGER NOT NULL,message_id INTEGER NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id),PRIMARY KEY(chat_id,message_id))',
      'CREATE TABLE IF NOT EXISTS selections(doctor_id INTEGER PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id))',
      "CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending')",
      "CREATE TABLE IF NOT EXISTS ai_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES conversations(id),version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending')",
      "CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,method TEXT NOT NULL,payload TEXT NOT NULL,conversation_id TEXT REFERENCES conversations(id),guard_version INTEGER,category TEXT NOT NULL,destination TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0)",
      'CREATE TABLE IF NOT EXISTS deliveries(chat_id INTEGER NOT NULL,message_id INTEGER NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id),PRIMARY KEY(chat_id,message_id))',
      'CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL,event TEXT NOT NULL,doctor_id INTEGER,created_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS rate_limits(user_id INTEGER PRIMARY KEY,window_start INTEGER NOT NULL,count INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,content TEXT NOT NULL)',
      "CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,next_at,id)",
      "CREATE INDEX IF NOT EXISTS outbox_destination ON outbox(destination,id)",
      "CREATE INDEX IF NOT EXISTS outbox_pending_destination ON outbox(destination,id) WHERE status='pending'",
      "CREATE INDEX IF NOT EXISTS outbox_failed_case ON outbox(destination,conversation_id,id) WHERE status='failed' AND category IN ('history','relay','case')",
      "CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,id)"
    ].join(';'));
    this.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version','1')").run();
  }
  tx<T>(fn: ()=>T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value=fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  ingest(update: Update): void {
    // Store only normalised update fields, never the entire Telegram profile or forward metadata.
    this.db.prepare('INSERT OR IGNORE INTO updates(id,payload) VALUES(?,?)').run(update.update_id,JSON.stringify(update));
  }
  pendingUpdates(): Update[] {
    return (this.db.prepare("SELECT payload FROM updates WHERE status='pending' ORDER BY id").all() as {payload:string}[]).map(x=>JSON.parse(x.payload));
  }
  processed(id: number): boolean { return (this.db.prepare('SELECT status FROM updates WHERE id=?').get(id) as {status:string}|undefined)?.status === 'done'; }
  done(id: number): void { this.db.prepare("UPDATE updates SET status='done',payload='{}' WHERE id=?").run(id); }
  offset(): number { return Number((this.db.prepare('SELECT COALESCE(MAX(id),-1)+1 AS n FROM updates').get() as {n:number}).n); }
  user(id: number, source: string | null, now: number): void {
    const existing = this.db.prepare('SELECT id FROM users WHERE id=?').get(id);
    if (!existing) this.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,source || 'direct',source || 'direct',now);
    else if (source) this.db.prepare('UPDATE users SET last_source=? WHERE id=?').run(source,id);
  }
  current(userId: number): Conversation | undefined {
    return this.db.prepare("SELECT * FROM conversations WHERE user_id=? AND state!='closed'").get(userId) as Conversation|undefined;
  }
  get(id: string): Conversation | undefined { return this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as Conversation|undefined; }
  create(userId: number, now: number): Conversation {
    const source = (this.db.prepare('SELECT last_source FROM users WHERE id=?').get(userId) as {last_source:string}).last_source;
    const id=randomUUID();
    this.db.prepare("INSERT INTO conversations(id,user_id,state,source,created_at) VALUES(?,?,'ai',?,?)").run(id,userId,source,now);
    this.audit(id,'created',now);
    return this.get(id)!;
  }
  append(id: string, role: SavedMessage['role'], content: Content, now: number): void {
    this.db.prepare('INSERT INTO messages(conversation_id,role,content,created_at) VALUES(?,?,?,?)').run(id,role,JSON.stringify(content),now);
  }
  history(id: string): SavedMessage[] { return this.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id').all(id) as SavedMessage[]; }
  bump(id: string): Conversation {
    this.db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').run(id);
    this.db.prepare("UPDATE ai_jobs SET status='superseded' WHERE conversation_id=? AND status='pending'").run(id);
    return this.get(id)!;
  }
  queue(id: string, now: number): boolean {
    const result=this.db.prepare("UPDATE conversations SET state='queued',version=version+1 WHERE id=? AND state='ai'").run(id);
    if (result.changes) { this.audit(id,'queued',now); this.db.prepare("UPDATE ai_jobs SET status='superseded' WHERE conversation_id=? AND status='pending'").run(id); }
    return Boolean(result.changes);
  }
  claim(id: string, doctorId: number, now: number): boolean {
    const result=this.db.prepare("UPDATE conversations SET state='doctor',doctor_id=?,version=version+1 WHERE id=? AND state='queued' AND doctor_id IS NULL").run(doctorId,id);
    if (result.changes) { this.select(doctorId,id); this.audit(id,'claimed',now,doctorId); }
    return Boolean(result.changes);
  }
  closeCase(id: string, doctorId: number, now: number): boolean {
    const result=this.db.prepare("UPDATE conversations SET state='closed',closed_at=?,version=version+1 WHERE id=? AND state='doctor' AND doctor_id=?").run(now,id,doctorId);
    if (result.changes) {
      this.db.prepare('DELETE FROM selections WHERE conversation_id=?').run(id);
      this.audit(id,'closed',now,doctorId);
    }
    return Boolean(result.changes);
  }
  audit(id: string,event: string,now: number,doctorId: number|null=null): void { this.db.prepare('INSERT INTO audit(conversation_id,event,doctor_id,created_at) VALUES(?,?,?,?)').run(id,event,doctorId,now); }
  ready(doctorId: number): void { this.db.prepare('INSERT INTO doctors VALUES(?,1) ON CONFLICT(id) DO UPDATE SET ready=1').run(doctorId); }
  isReady(doctorId: number): boolean { return Boolean(this.db.prepare('SELECT id FROM doctors WHERE id=? AND ready=1').get(doctorId)); }
  select(doctorId: number,id: string): void { this.db.prepare('INSERT INTO selections VALUES(?,?) ON CONFLICT(doctor_id) DO UPDATE SET conversation_id=excluded.conversation_id').run(doctorId,id); }
  selected(doctorId: number): string | undefined { return (this.db.prepare('SELECT conversation_id FROM selections WHERE doctor_id=?').get(doctorId) as {conversation_id:string}|undefined)?.conversation_id; }
  cases(doctorId: number): Conversation[] { return this.db.prepare("SELECT * FROM conversations WHERE state='doctor' AND doctor_id=? ORDER BY created_at").all(doctorId) as Conversation[]; }
  linkIncoming(chatId:number,messageId:number,id:string):void { this.db.prepare('INSERT OR IGNORE INTO inbound_links VALUES(?,?,?)').run(chatId,messageId,id); }
  incomingCase(chatId:number,messageId:number):string|undefined { return (this.db.prepare('SELECT conversation_id FROM inbound_links WHERE chat_id=? AND message_id=?').get(chatId,messageId) as {conversation_id:string}|undefined)?.conversation_id; }
  byReply(doctorId: number,messageId: number): string | undefined { return (this.db.prepare('SELECT conversation_id FROM deliveries WHERE chat_id=? AND message_id=?').get(doctorId,messageId) as {conversation_id:string}|undefined)?.conversation_id; }
  out(method: string,payload: Record<string,unknown>,id: string|null=null,category='general',version: number|null=null,catalogEvidence:Evidence[]=[]): void {
    this.db.prepare('INSERT INTO outbox(method,payload,conversation_id,category,guard_version,destination) VALUES(?,?,?,?,?,?)').run(method,JSON.stringify({...payload,...(catalogEvidence.length?{__poleznoCatalog:catalogEvidence}:{})}),id,category,version,String(payload.chat_id || 'callback'));
  }
  nextOutgoing(now: number): Outgoing | undefined {
    // Failed case messages remain an ordering barrier until /retry succeeds.
    // Other cases and general/admin notices can still reach the same recipient.
    return this.db.prepare(`SELECT o.* FROM outbox o
      WHERE o.status='pending' AND o.next_at<=?
      AND NOT EXISTS (
        SELECT 1 FROM outbox f WHERE f.destination=o.destination AND f.id<o.id
          AND f.status='failed' AND f.conversation_id=o.conversation_id
          AND f.category IN ('history','relay','case')
          AND o.category IN ('history','relay','case')
      )
      AND NOT EXISTS (
        SELECT 1 FROM outbox p WHERE p.destination=o.destination AND p.id<o.id
          AND p.status='pending' AND NOT EXISTS (
            SELECT 1 FROM outbox f WHERE f.destination=p.destination AND f.id<p.id
              AND f.status='failed' AND f.conversation_id=p.conversation_id
              AND f.category IN ('history','relay','case')
              AND p.category IN ('history','relay','case')
        )
      ) ORDER BY o.id LIMIT 1`).get(now) as Outgoing|undefined;
  }
  finishOutgoing(item: Outgoing,messageId?: number): void {
    this.db.prepare("UPDATE outbox SET status='sent',attempts=attempts+1 WHERE id=?").run(item.id);
    if (messageId && item.conversation_id && ['history','relay','case'].includes(item.category)) {
      this.db.prepare('INSERT OR REPLACE INTO deliveries VALUES(?,?,?)').run(Number(item.destination),messageId,item.conversation_id);
    }
  }
  skip(id: number): void { this.db.prepare("UPDATE outbox SET status='skipped' WHERE id=?").run(id); }
  skipAiRemainder(item:Outgoing):void {
    this.db.prepare("UPDATE outbox SET status='skipped' WHERE category='ai' AND conversation_id=? AND guard_version=? AND status='pending' AND id<>?").run(item.conversation_id,item.guard_version,item.id);
  }
  failure(id: number,permanent: boolean,next: number): void {
    this.db.prepare("UPDATE outbox SET attempts=attempts+1,status=?,next_at=? WHERE id=?").run(permanent?'failed':'pending',next,id);
  }
  retry(): number { return Number(this.db.prepare("UPDATE outbox SET status='pending',attempts=0,next_at=0 WHERE status='failed'").run().changes); }
  ai(id: string,version: number): void { this.db.prepare('INSERT INTO ai_jobs(conversation_id,version) VALUES(?,?)').run(id,version); }
  nextAi(): AiJob | undefined { return this.db.prepare("SELECT * FROM ai_jobs WHERE status='pending' ORDER BY id LIMIT 1").get() as AiJob|undefined; }
  jobStatus(id: number,status: string): void { this.db.prepare('UPDATE ai_jobs SET status=? WHERE id=?').run(status,id); }
  recover(): void { this.db.prepare("UPDATE ai_jobs SET status='pending' WHERE status='running'").run(); }
  allowAi(userId: number,now: number,limit: number): boolean {
    const row=this.db.prepare('SELECT * FROM rate_limits WHERE user_id=?').get(userId) as {window_start:number;count:number}|undefined;
    if (!row || now-row.window_start>=60000) { this.db.prepare('INSERT OR REPLACE INTO rate_limits VALUES(?,?,1)').run(userId,now); return true; }
    if (row.count>=limit) return false;
    this.db.prepare('UPDATE rate_limits SET count=count+1 WHERE user_id=?').run(userId); return true;
  }
  stats(): {states:{state:string;n:number}[];doctors:{doctor_id:number;event:string;n:number}[];sources:{source:string;n:number}[];firstSources:{source:string;n:number}[];failed:number} {
    return {
      states:this.db.prepare('SELECT state,COUNT(*) n FROM conversations GROUP BY state').all() as {state:string;n:number}[],
      doctors:this.db.prepare("SELECT doctor_id,event,COUNT(*) n FROM audit WHERE event IN ('claimed','closed') GROUP BY doctor_id,event").all() as {doctor_id:number;event:string;n:number}[],
      sources:this.db.prepare('SELECT source,COUNT(*) n FROM conversations GROUP BY source').all() as {source:string;n:number}[],
      firstSources:this.db.prepare('SELECT first_source source,COUNT(*) n FROM users GROUP BY first_source').all() as {source:string;n:number}[],
      failed:Number((this.db.prepare("SELECT COUNT(*) n FROM outbox WHERE status='failed'").get() as {n:number}).n)
    };
  }
  close(): void { this.db.close(); }
}

