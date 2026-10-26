const fs=require('node:fs');
const {extract,parseRecords}=require('./extract.cjs');
const {createCollectors}=require('./collectors.cjs');
function createSources({store,vault,getSettings,collectors=createCollectors()}) {
 const active=new Set();const controllers=new Map();
 const fingerprint=s=>JSON.stringify({enabled:s.enabled,scope:s.scope,config:s.config});
 function checkCurrent(source){const current=store.get('sources',source.id);if(!current||fingerprint(current)!==fingerprint(source))throw Error('来源已停用、删除或范围已改变，本次整理已停止，请按新设置重试');return current;}
 async function ingest(source,records,targetTaskId,{signal}={}) {
  const counts={received:records.length,created:0,updated:0,ignored:0,duplicates:0,filtered:0};
  let processed=0;for(const m of records) {
   if(signal?.aborted)throw Object.assign(Error('本次采集已取消'),{collectorStatus:'cancelled'});
   checkCurrent(source);if(++processed%200===0)await new Promise(setImmediate);
   const conversation=String(m.conversation||'');
   if(!conversation||!source.scope?.includes(conversation)){counts.filtered++;continue;}
   // Query persisted identity before AI, including already stored non-task messages.
   if(store.hasMessage(source.id,m)){counts.duplicates++;continue;}
   const messageTime=m.at?new Date(m.at):null;const known=messageTime&&!Number.isNaN(messageTime.getTime());
   const fetchWithSignal=(url,options)=>fetch(url,{...options,...(signal?{signal:options.signal?AbortSignal.any([options.signal,signal]):signal}:{})});
   const proposal=await extract(m.text,getSettings(),vault,fetchWithSignal,{now:known?messageTime:new Date(),messageTimeKnown:!!known});
   if(signal?.aborted)throw Object.assign(Error('本次采集已取消'),{collectorStatus:'cancelled'});
   checkCurrent(source);
   const result=store.importMessage(source,m,proposal,targetTaskId);
   if(result.duplicate)counts.duplicates++;else counts[result.action]++;
  }
  return counts;
 }
 async function test(id) {
  const source=store.get('sources',id);if(!source)throw Error('请先保存来源');
  if(source.config?.collector?.kind)return collectors.probe(source,{hasCredential:source.config.collector.kind==='wechat-export'?!!vault.has?.('source-wechat:'+id):false});
  if(source.platform==='email') {const {ImapFlow}=require('imapflow');const pass=await vault.get('source:'+id);if(!pass)throw Error('请保存邮箱授权码后再测试');const c=new ImapFlow({...emailConfig(source,pass),logger:false});try{await c.connect();await c.mailboxOpen(source.config.mailbox||source.config.folder||'INBOX');return {status:'configured',message:'邮箱连接与文件夹检查通过。点击整理一次，验证真实邮件进入任务。'};}finally{await c.logout().catch(()=>{});}}
  if(source.config?.importPath) {const stat=fs.statSync(source.config.importPath);if(!stat.isFile())throw Error('请选择本机导出的 JSON 或文本文件');return {status:'configured',message:'文件位置可读取；这只验证本机文件，不表示已经直接连接微信或钉钉。'};}
  throw Error('请先选择本机导出文件；平台直接采集需要本人授权和兼容的采集器，尚未配置');
 }
 function emailConfig(s,pass){const c=s.config||{};if(!c.host||!c.user)throw Error('请填写邮箱账号和 IMAP 服务器');if(c.secure===false)throw Error('邮箱接入需要启用 SSL/TLS');return {host:c.host,port:Number(c.port)||993,secure:true,auth:{user:c.user,pass},connectionTimeout:20000,socketTimeout:30000};}
 async function sync(id,{force=false,signal}={}) {
  if(active.has(id))return {skipped:true,message:'这个来源正在整理，请稍候'};
  const source=store.get('sources',id);if(!source)throw Error('来源不存在');if(!source.enabled&&!force) return {skipped:true};
  if(!source.scope?.length)throw Error('请先选择要整理的群、联系人或邮箱文件夹范围');
  active.add(id);const controller=new AbortController();controllers.set(id,controller);const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
  // Saving a narrower scope or revoking authorization stops an in-flight process.
  const monitor=setInterval(()=>{try{checkCurrent(source);}catch{controller.abort();}},250);monitor.unref?.();
  const started=new Date().toISOString();store.put('sources',{...source,lastAttemptAt:started});
  try {
   let counts;let checkpoint=source.checkpoint||{};let coverage;let direct;let platformCollectedAt;let fileProcessedAt;
   if(source.config?.collector?.kind){
    const credential=source.config.collector.kind==='wechat-export'?await vault.get('source-wechat:'+id):undefined;
    direct=await collectors.collect(source,{signal:controller.signal,checkCurrent:()=>checkCurrent(source),...(credential?{credential,hasCredential:true}:{})});
    checkCurrent(source);platformCollectedAt=direct.platformCollectedAt;fileProcessedAt=direct.fileProcessedAt;
    // Collection time is true even if later AI fails. It never implies ingestion success.
    store.put('sources',{...store.get('sources',id),...(platformCollectedAt?{platformCollectedAt}:{}),...(fileProcessedAt?{fileProcessedAt}:{}),coverage:direct.coverage,collectorStatus:direct.complete?'processing':'partial'});
    counts=await ingest(source,direct.records,undefined,{signal:controller.signal});
    if(direct.complete)checkpoint=direct.checkpoint;
    coverage=direct.coverage;
   }else if(source.platform==='email') {
    const pass=await vault.get('source:'+id);if(!pass)throw Error('请先保存邮箱授权码');
    const {ImapFlow}=require('imapflow');const {simpleParser}=require('mailparser');const client=new ImapFlow({...emailConfig(source,pass),logger:false});
    try {await client.connect();const folder=source.config.mailbox||source.config.folder||'INBOX';if(!source.scope.includes(folder))throw Error('邮箱文件夹不在已选择范围内');const lock=await client.getMailboxLock(folder);
     try {const validity=String(client.mailbox.uidValidity);const last=checkpoint.uidValidity===validity?(Number(checkpoint.uid)||0):0;
      const found=(await client.search({uid:`${last+1}:*`},{uid:true})).filter(uid=>uid>last).slice(0,200);
      const records=[];let highest=last;
      for(const uid of found){checkCurrent(source);const mail=await client.fetchOne(uid,{source:true},{uid:true});const parsed=await simpleParser(mail.source);records.push({id:parsed.messageId||`${validity}:${uid}`,text:`${parsed.subject||''}\n${parsed.text||''}`,conversation:folder,at:(parsed.date||new Date()).toISOString(),messageId:parsed.messageId,replyTo:parsed.inReplyTo,from:parsed.from?.text||''});highest=Math.max(highest,uid);}
      platformCollectedAt=new Date().toISOString();counts=await ingest(source,records,undefined,{signal:controller.signal});checkpoint={uid:highest,uidValidity:validity};coverage={mode:'imap',folder,batchLimited:found.length===200,attachments:'仅记录正文；附件内容未分析'};
     }finally{lock.release();}
    }finally{await client.logout().catch(()=>{});}
   } else if(source.config?.importPath) {
    const stat=fs.statSync(source.config.importPath);if(stat.size>20*1024*1024)throw Error('导出文件大于 20 MB，请按已选范围拆分');
    const raw=fs.readFileSync(source.config.importPath,'utf8');counts=await ingest(source,parseRecords(raw),undefined,{signal:controller.signal});fileProcessedAt=new Date().toISOString();checkpoint={mtime:stat.mtime.toISOString(),lastReadAt:fileProcessedAt};coverage={mode:'local-export',platformDirect:false,media:'未提供的图片、语音、视频和附件内容不在本次覆盖内'};
   } else {throw Error('尚未接入这个平台的直接采集器。可先选择本人导出的本机记录文件，自动整理文件内的新消息。');}
   const current=checkCurrent(source);const completedAt=new Date().toISOString();
   const collectorStatus=direct?(direct.complete?(counts.created+counts.updated+counts.ignored===0?'no_new':'collected'):'partial'):undefined;
   const next={...current,status:direct&&!direct.complete?'partial':'connected',lastAttemptAt:started,...(!direct||direct.complete?{lastSuccessAt:completedAt}:{}),lastError:direct&&!direct.complete?'平台只返回部分结果，已保存本轮取得消息；检查点未前移，将重试同一范围':'',checkpoint,coverage,lastCounts:counts,...(platformCollectedAt?{platformCollectedAt}:{}),...(fileProcessedAt?{fileProcessedAt}:{}),...(collectorStatus?{collectorStatus}:{})};
   store.put('sources',next);store.log('source.sync',{sourceId:id,success:!direct||direct.complete,counts,coverage,...(collectorStatus?{collectorStatus}:{})});return direct?{...counts,collectorStatus,complete:direct.complete}:counts;
  }catch(e){const current=store.get('sources',id);if(current&&fingerprint(current)===fingerprint(source))store.put('sources',{...current,status:'error',lastError:e.message,lastAttemptAt:started,...(source.config?.collector?.kind?{collectorStatus:e.collectorStatus||'failure'}:{})});store.log('source.sync',{sourceId:id,success:false,error:e.message});throw e;}finally{clearInterval(monitor);signal?.removeEventListener('abort',abort);controllers.delete(id);active.delete(id);}
 }
 async function importText(id,text,targetTaskId){const source=store.get('sources',id);if(!source)throw Error('请先保存来源');if(!source.scope?.length)throw Error('请先选择来源范围');let records=parseRecords(text);if(records.some(m=>!m.conversation)){if(source.scope.length!==1)throw Error('文字未注明来自哪个范围，请选择单一范围或导入含会话标识的 JSON');records=records.map(m=>({...m,conversation:m.conversation||source.scope[0],manualScopeConfirmation:!m.conversation}));}const counts=await ingest(source,records,targetTaskId);store.log('source.import',{sourceId:id,counts});return counts;}
 async function tick(){for(const s of store.all('sources')){if(!s.enabled)continue;const interval=Math.max(5,Number(s.config?.pollMinutes)||15)*60000;if(Date.now()-Date.parse(s.lastAttemptAt||'1970-01-01')<interval)continue;await sync(s.id).catch(()=>{});}}
 function cancel(id){const controller=controllers.get(id);if(!controller)return false;controller.abort();return true;}
 async function probeCollectors(){const results=[];for(const source of store.all('sources'))if(source.config?.collector?.kind)results.push({sourceId:source.id,...await collectors.probe(source,{hasCredential:source.config.collector.kind==='wechat-export'?!!vault.has?.('source-wechat:'+source.id):false})});return results;}
 return {sync,test,importText,tick,ingest,cancel,probeCollectors};
}
module.exports={createSources};
