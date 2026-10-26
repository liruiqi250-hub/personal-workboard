const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const iso = () => new Date().toISOString();
const parse = row => row ? JSON.parse(row.json) : null;
const statuses = new Set(['inbox','todo','doing','waiting','done']);
function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'workboard.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,taskId TEXT,type TEXT,at TEXT,before TEXT,after TEXT);
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,sourceId TEXT,ref TEXT,at TEXT,json TEXT,taskId TEXT);
    CREATE INDEX IF NOT EXISTS message_ref ON messages(sourceId,ref);
    CREATE TABLE IF NOT EXISTS message_aliases(sourceId TEXT NOT NULL,ref TEXT NOT NULL,messageId TEXT NOT NULL,PRIMARY KEY(sourceId,ref));
    CREATE INDEX IF NOT EXISTS message_alias_message ON message_aliases(messageId);
    CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY,at TEXT,json TEXT);`);
  function all(table) { if(!['tasks','sources','reports','deliveries','activity'].includes(table))throw Error('未知数据表'); return db.prepare(`SELECT json FROM ${table}`).all().map(parse); }
  function get(table,id) { if(!['tasks','sources','reports','deliveries'].includes(table))throw Error('未知数据表'); return parse(db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id)); }
  function put(table,value) { if(!['tasks','sources','reports','deliveries'].includes(table))throw Error('未知数据表'); db.prepare(`INSERT INTO ${table}(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`).run(value.id,JSON.stringify(value)); return value; }
  const getSetting = (key, fallback) => parse(db.prepare('SELECT json FROM kv WHERE key=?').get(key)) ?? fallback;
  const setSetting = (key,value) => {db.prepare('INSERT INTO kv(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(key,JSON.stringify(value));return value;};
  let transactionDepth=0;
  function atomic(fn){if(transactionDepth)return fn();db.exec('BEGIN IMMEDIATE');transactionDepth++;try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}finally{transactionDepth--;}}
  function event(taskId,type,before,after) {db.prepare('INSERT INTO events(taskId,type,at,before,after) VALUES(?,?,?,?,?)').run(taskId,type,iso(),before?JSON.stringify(before):null,after?JSON.stringify(after):null);}
  function validateTask(p) {
    if(p.title !== undefined && (!String(p.title).trim() || String(p.title).length>300))throw Error('请填写 1–300 字的任务内容');
    if(p.status !== undefined && !statuses.has(p.status))throw Error('任务状态无效');
    if(p.dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate)||Number.isNaN(Date.parse(p.dueDate))||new Date(p.dueDate).toISOString().slice(0,10)!==p.dueDate))throw Error('请填写真实存在的日期，格式为 年-月-日');
  }
  function createTask(input) {
    validateTask(input); const now=iso();
    const task={id:randomUUID(),title:String(input.title||'').trim(),notes:String(input.notes||''),status:input.status||'todo',dueDate:input.dueDate||'',priority:Math.max(1,Math.min(3,Number(input.priority)||2)),sourceId:input.sourceId||'',sourceRef:input.sourceRef||'',sourceText:String(input.sourceText||''),links:input.links||[],createdAt:now,updatedAt:now,completedAt:input.status==='done'?now:null,deletedAt:null,example:!!input.example};
    if(!task.title)throw Error('请填写任务内容'); put('tasks',task);event(task.id,'created',null,task);return task;
  }
  function patchTask(id,input) {
    const before=get('tasks',id);if(!before)throw Error('找不到这件事，请刷新列表'); validateTask(input);
    const allowed=['title','notes','status','dueDate','priority','links'];const fields={}; for(const k of allowed)if(k in input)fields[k]=input[k];
    const task={...before,...fields,updatedAt:iso()};
    if(task.status==='done' && before.status!=='done')task.completedAt=task.updatedAt;
    if(task.status!=='done')task.completedAt=null;
    put('tasks',task);event(id,task.status==='done'&&before.status!=='done'?'completed':before.status==='done'&&task.status!=='done'?'reopened':'updated',before,task);return task;
  }
  function deleted(id,restore=false) {const before=get('tasks',id);if(!before)throw Error('找不到任务');const next={...before,deletedAt:restore?null:iso(),updatedAt:iso()};put('tasks',next);event(id,restore?'restored':'deleted',before,next);return next;}
  function log(kind,detail) {const v={id:randomUUID(),at:iso(),kind,...detail};db.prepare('INSERT INTO activity(id,at,json) VALUES(?,?,?)').run(v.id,v.at,JSON.stringify(v)); return v;}
  function events() {return db.prepare('SELECT * FROM events ORDER BY id').all().map(e=>({...e,before:e.before?JSON.parse(e.before):null,after:e.after?JSON.parse(e.after):null}));}
  function messageId(sourceId,ref) {return createHash('sha256').update(sourceId+'\0'+ref).digest('hex');}
  const legacyTextRef=/^text-(0|[1-9]\d*)-([a-f0-9]{16})$/;
  const canonicalTextRef=/^text-[a-f0-9]{64}-[1-9]\d*$/;
  const textMigrationKey=sourceId=>'text-occurrence-aliases-v1:'+sourceId;
  function migrateLegacyTextRefs(sourceId) {
    const key=textMigrationKey(sourceId);if(getSetting(key,false))return;
    const legacy=[];
    for(const row of db.prepare('SELECT id,ref,json FROM messages WHERE sourceId=?').all(sourceId)) {
      const match=legacyTextRef.exec(row.ref);if(!match||!Number.isSafeInteger(Number(match[1])))continue;
      let body;try{body=JSON.parse(row.json);}catch{continue;}if(!body||typeof body!=='object')continue;
      const text=String(body.text||body.content||body.body||'');if(!text)continue;
      const digest=createHash('sha256').update(text).digest('hex');
      if(digest.slice(0,16)!==match[2])continue;
      legacy.push({id:row.id,line:Number(match[1]),digest});
    }
    // Keep the old message, task and evidence untouched; aliases only bridge identity formats.
    legacy.sort((a,b)=>a.line-b.line||a.id.localeCompare(b.id));
    db.prepare('DELETE FROM message_aliases WHERE sourceId=?').run(sourceId);
    const occurrences=new Map();const direct=db.prepare('SELECT id FROM messages WHERE sourceId=? AND ref=?');
    const alias=db.prepare('INSERT INTO message_aliases(sourceId,ref,messageId) VALUES(?,?,?)');
    for(const row of legacy) {
      const n=(occurrences.get(row.digest)||0)+1;occurrences.set(row.digest,n);
      const ref=`text-${row.digest}-${n}`;
      // An already stored canonical message remains authoritative; existing duplicate cards stay intact.
      if(!direct.get(sourceId,ref))alias.run(sourceId,ref,row.id);
    }
    setSetting(key,{version:1});
  }
  function findMessageByRef(sourceId,ref) {
    return db.prepare('SELECT id,taskId FROM messages WHERE sourceId=? AND ref=? LIMIT 1').get(sourceId,ref)
      ||db.prepare('SELECT m.id,m.taskId FROM message_aliases a JOIN messages m ON m.id=a.messageId AND m.sourceId=a.sourceId WHERE a.sourceId=? AND a.ref=?').get(sourceId,ref);
  }
  function messageRef(message) { return String(message.id||message.messageId||message.sourceRef||createHash('sha256').update(JSON.stringify(message)).digest('hex')); }
  function hasMessage(sourceId,message) {
    const ref=messageRef(message);
    if(canonicalTextRef.test(ref))migrateLegacyTextRefs(sourceId);
    return !!findMessageByRef(sourceId,ref);
  }
  function importMessage(source,message,proposal,targetTaskId) {
    const ref=messageRef(message);
    // This runs inside the import transaction, including its persisted migration marker.
    if(legacyTextRef.test(ref))db.prepare('DELETE FROM kv WHERE key=?').run(textMigrationKey(source.id));
    if(canonicalTextRef.test(ref)||canonicalTextRef.test(String(message.replyTo||'')))migrateLegacyTextRefs(source.id);
    const id=messageId(source.id,ref);const existing=findMessageByRef(source.id,ref);
    if(existing)return {duplicate:true,taskId:existing.taskId};
    const text=String(message.text||message.content||message.body||'');
    let task=targetTaskId?get('tasks',targetTaskId):null;
    if(targetTaskId&&!task)throw Error('要关联的任务不存在');
    // Exact reply links are safe to reuse; broad title similarity is only a review suggestion.
    if(!task && message.replyTo) {const link=findMessageByRef(source.id,String(message.replyTo));if(link?.taskId)task=get('tasks',link.taskId);}
    let action='ignored';
    if(task) {
      const links=[...(task.links||[]),{sourceId:source.id,ref,text,at:message.at||iso()}];
      const updates={links};
      // New evidence is retained; no textual claim silently closes someone else's task.
      if(proposal?.dueDate&&!task.dueDate)updates.dueDate=proposal.dueDate;
      task=patchTask(task.id,updates);action='updated';
    } else if(proposal?.isTask) {
      task=createTask({title:proposal.title||text.slice(0,120),notes:proposal.notes||'',status:'inbox',dueDate:proposal.dueDate||'',priority:proposal.priority||2,sourceId:source.id,sourceRef:ref,sourceText:text,links:[{sourceId:source.id,ref,text,at:message.at||iso()}]});action='created';
    }
    db.prepare('INSERT INTO messages(id,sourceId,ref,at,json,taskId) VALUES(?,?,?,?,?,?)').run(id,source.id,ref,message.at||iso(),JSON.stringify(message),task?.id||null);
    return {duplicate:false,taskId:task?.id||null,action};
  }
  function relink(messageIdValue,targetId) {
    const msg=db.prepare('SELECT * FROM messages WHERE id=?').get(messageIdValue);const target=get('tasks',targetId);
    if(!msg||!target)throw Error('消息或目标任务不存在');
    if(msg.taskId===targetId)return target;
    const oldTask=msg.taskId?get('tasks',msg.taskId):null;
    db.prepare('UPDATE messages SET taskId=? WHERE id=?').run(targetId,messageIdValue);
    if(oldTask){const links=(oldTask.links||[]).filter(l=>!(l.sourceId===msg.sourceId&&l.ref===msg.ref));const updated=patchTask(oldTask.id,{links});if(oldTask.sourceId===msg.sourceId&&oldTask.sourceRef===msg.ref){const corrected={...updated,sourceId:links[0]?.sourceId||'',sourceRef:links[0]?.ref||'',sourceText:links[0]?.text||''};put('tasks',corrected);event(oldTask.id,'association.corrected',updated,corrected);}}
    const body=JSON.parse(msg.json); patchTask(targetId,{links:[...(target.links||[]).filter(l=>!(l.sourceId===msg.sourceId&&l.ref===msg.ref)),{sourceId:msg.sourceId,ref:msg.ref,text:body.text||body.content||'',at:msg.at}]});
    log('association.corrected',{messageId:messageIdValue,targetId});return get('tasks',targetId);
  }
  return {db,file,all,get,put,getSetting,setSetting,hasMessage:(...args)=>atomic(()=>hasMessage(...args)),createTask:p=>atomic(()=>createTask(p)),patchTask:(id,p)=>atomic(()=>patchTask(id,p)),deleted:(id,restore)=>atomic(()=>deleted(id,restore)),log,events,importMessage:(...args)=>atomic(()=>importMessage(...args)),relink:(...args)=>atomic(()=>relink(...args)),
    messages:()=>db.prepare('SELECT id,sourceId,ref,at,taskId,json FROM messages ORDER BY at DESC LIMIT 300').all().map(m=>({...m,message:JSON.parse(m.json),json:undefined})),
    backup:dest=>{db.exec('PRAGMA wal_checkpoint(FULL)'); db.prepare('VACUUM INTO ?').run(dest);return dest;},
    close:()=>db.close()};
}
module.exports={createStore};
