'use strict';
const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');const {createHash}=require('node:crypto');
const WECHAT_REVISION='2c49469a91e2f3b0c73a581e15a8ad2db25b7923';
const KINDS=['wechat-export','dingtalk-dws'];
const WECHAT_RUNNER=require('./wechat-export-runner.cjs');
class CollectorError extends Error{constructor(message,status='failure'){super(message);this.name='CollectorError';this.collectorStatus=status;}}
function cancelled(){return new CollectorError('本次采集已取消','cancelled');}
function checkAbort(signal){if(signal?.aborted)throw cancelled();}
function runProcess(executable,args,{spawnImpl=spawn,signal,timeoutMs=30000,maxBytes=16*1024*1024,input='',cwd}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(cancelled());return;}
  if(typeof executable!=='string'||!executable.trim()||/[\0\r\n]/.test(executable)||/\.(cmd|bat|ps1)$/i.test(executable)){reject(new CollectorError('请选择真实 EXE 或 Python EXE；不能使用命令脚本'));return;}
  let child,timer,ended=false,size=0;const out=[],err=[];
  function done(error,result){if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);if(error)reject(error);else resolve(result);}
  function stop(error){try{child?.kill();}catch{}done(error);}
  function onAbort(){stop(cancelled());}
  try{child=spawnImpl(executable,args,{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],...(cwd?{cwd}:{})});}
  catch(e){done(new CollectorError(e.code==='ENOENT'?'采集工具尚未安装或路径不存在':'采集工具无法启动',e.code==='ENOENT'?'not_installed':'failure'));return;}
  const read=(target,chunk)=>{if(ended)return;const b=Buffer.from(chunk);size+=b.length;if(size>maxBytes){stop(new CollectorError('采集输出超过本轮上限，请缩小时间窗口'));return;}target.push(b);};
  child.stdout.on('data',b=>read(out,b));child.stderr.on('data',b=>read(err,b));
  child.on('error',e=>done(new CollectorError(e.code==='ENOENT'?'采集工具尚未安装或路径不存在':'采集工具无法启动',e.code==='ENOENT'?'not_installed':'failure')));
  child.on('close',(code,exitSignal)=>done(null,{code,signal:exitSignal,stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(err).toString('utf8')}));
  signal?.addEventListener('abort',onAbort,{once:true});
  timer=setTimeout(()=>stop(new CollectorError('采集工具运行超时，保留原检查点','failure')),timeoutMs);
  // stdin is a fixed JSON contract, never evaluated as shell or Python source.
  child.stdin.on('error',()=>{});child.stdin.end(input);
  if(signal?.aborted)onAbort();
 });
}
function json(text){try{return JSON.parse(String(text).replace(/^\uFEFF/,''));}catch{throw new CollectorError('采集工具返回的 JSON 不符合已核实接口；本轮未提交检查点');}}
function instant(value){if(value===null||value===undefined||value==='')return new Date(NaN);if(typeof value==='number')return new Date(value<1e12?value*1000:value);if(typeof value==='string'&&/^\d{10,13}$/.test(value))return instant(Number(value));return new Date(value);}
function iso(value){const d=instant(value);return Number.isNaN(d.getTime())?null:d.toISOString();}
function dwsTime(value){
 // The official reader uses dingTalkMessageLocation = fixed UTC+08:00 for
 // unzoned DingTalk wall times; do not depend on this computer's OS timezone.
 if(typeof value==='string'&&/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value))return iso(value.replace(' ','T')+'+08:00');
 return iso(value);
}
function stableWx(value){return typeof value==='string'&&/^(?:[A-Za-z][A-Za-z0-9_-]{5,}|[A-Za-z0-9_-]+@chatroom)$/.test(value);}
function stableDws(value){return typeof value==='string'&&/^cid[A-Za-z0-9+/_=-]{4,}$/.test(value);}
function validStart(value){
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!iso(value))return false;
 const day=value.slice(0,10),date=new Date(day+'T00:00:00Z');return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===day;
}
function configOf(source){return source.config?.collector||{};}
function validateWechatCredential(raw,source){
 const invalid=()=>new CollectorError('请本人提供与已选微信账号匹配的离线数据库密钥 JSON；不会扫描进程或尝试其他账号','needs_credential');
 if(!raw)throw invalid();
 let sealed;try{sealed=typeof raw==='string'?JSON.parse(raw):raw;}catch{throw invalid();}
 const c=configOf(source);let expectedDir;try{expectedDir=fs.realpathSync(c.dbDir);}catch{throw invalid();}
 if(!sealed||sealed.schema!==1||sealed.accountId!==c.accountId||typeof sealed.accountDir!=='string'||!path.isAbsolute(sealed.accountDir))throw invalid();
 const samePath=(a,b)=>process.platform==='win32'?path.normalize(a).toLowerCase()===path.normalize(b).toLowerCase():path.normalize(a)===path.normalize(b);
 if(!samePath(sealed.accountDir,expectedDir)||!sealed.keys||typeof sealed.keys!=='object'||Array.isArray(sealed.keys))throw invalid();
 const entries=Object.entries(sealed.keys);if(!entries.length||entries.length>256)throw invalid();const keys=Object.create(null);
 for(const [relative,hex] of entries){
  const rel=relative.replaceAll('\\','/');
  if(!rel||rel.length>240||rel.startsWith('/')||rel.includes(':')||rel.split('/').some(part=>!part||part==='.'||part==='..')||!rel.endsWith('.db')||Object.hasOwn(keys,rel)||typeof hex!=='string'||!/^(?:[a-fA-F0-9]{64}|[a-fA-F0-9]{96})$/.test(hex))throw invalid();
  keys[rel]=hex.toLowerCase();
 }
 const credential={schema:1,accountId:c.accountId,accountDir:expectedDir,keys};if(Buffer.byteLength(JSON.stringify(credential),'utf8')>60*1024)throw invalid();return credential;
}
function binding(source){const c=configOf(source);return createHash('sha256').update(JSON.stringify({kind:c.kind,executable:c.executable,scriptPath:c.scriptPath,dbDir:c.dbDir,accountId:c.accountId,profile:c.profile,startAt:c.startAt,scope:source.scope})).digest('hex');}
function configuration(source){
 const c=configOf(source);
 if(!KINDS.includes(c.kind))throw new CollectorError('请选择已核实的平台采集器','not_installed');
 if(source.platform!==(c.kind==='wechat-export'?'wechat':'dingtalk'))throw new CollectorError('采集器与来源平台不匹配');
 if(c.authorized!==true)throw new CollectorError('请本人完成工具登录，并明确授权所选账号与范围','needs_login');
 if(!Array.isArray(source.scope)||!source.scope.length||new Set(source.scope).size!==source.scope.length||!source.scope.every(c.kind==='wechat-export'?stableWx:stableDws))throw new CollectorError('请填写唯一、明确的稳定会话 ID；空范围和群昵称不能直接采集','needs_scope');
 if(source.scope.length>30)throw new CollectorError('单个来源最多选择 30 个会话，请分开配置','needs_scope');
 if(!c.executable)throw new CollectorError('请先安装指定采集工具并选择真实可执行文件','not_installed');
 if(/\.(cmd|bat|ps1)$/i.test(c.executable)||/[\0\r\n]/.test(c.executable))throw new CollectorError('请选择真实 EXE 或 Python EXE；不支持命令脚本');
 if(c.kind==='wechat-export'){
  if(!c.scriptPath||!path.isAbsolute(c.scriptPath)||path.basename(c.scriptPath).toLowerCase()!=='cli.py')throw new CollectorError('请选择已核实 v1.4.0 源码目录中的 cli.py','not_installed');
  if(!c.dbDir||!path.isAbsolute(c.dbDir)||!stableWx(c.accountId))throw new CollectorError('请本人指定唯一微信账号目录及本人稳定账号；不能自动挑选账号','needs_login');
 }else{
  if(!/^[A-Za-z0-9_.@-]+:[A-Za-z0-9_.@-]+$/.test(c.profile||''))throw new CollectorError('请本人填写明确的钉钉 corpId:userId 登录身份','needs_login');
  if(!validStart(c.startAt))throw new CollectorError('请填写首次采集起点，含时区的真实日期时间','needs_scope');
 }
 return c;
}
function parseDwsLedger(payload,conversation,range,profile){
 // +chat-messages is currently dual_validate. Accept its documented direct ledger
 // and the same ledger in the official unified success envelope; never guess arrays.
 const p=Array.isArray(payload?.messages)?payload:(payload?.outcome==='success'&&Array.isArray(payload.data?.messages)?payload.data:null);
 if(!p)throw new CollectorError('钉钉输出缺少已核实的 messages 台账；版本可能不兼容');
 const records=[];
 for(const m of p.messages){
  if(!m||typeof m!=='object'||typeof m.messageId!=='string'||!m.messageId)throw new CollectorError('钉钉消息缺少稳定编号，本轮保留检查点');
  const cid=m.conversationId||m.openConversationId||conversation;if(cid!==conversation)throw new CollectorError('钉钉响应包含授权范围外的会话，已停止本轮');
  const at=dwsTime(m.createTime);if(!at)throw new CollectorError('钉钉消息缺少有效时间，无法验证时间范围');
  if(range&&(Date.parse(at)<Date.parse(range.start)||Date.parse(at)>=Date.parse(range.end)))throw new CollectorError('钉钉消息超出本轮时间范围，已停止本轮');
  // Runtime calls always supply the verified corpId:userId. Offline parser
  // fixtures may omit it; a platform's numbering is never assumed global.
  records.push({id:profile?`dws:${profile}:${conversation}:${m.messageId}`:`dws:${conversation}:${m.messageId}`,...(profile?{profile}:{}),messageId:m.messageId,conversation,text:typeof m.text==='string'?m.text:'',at,from:m.senderId||'',mediaReviewed:false,messageType:m.messageType||m.msgType||null});
 }
 const complete=p.complete===true&&p.hasMore===false&&p.paginationKnown===true&&!p.partial&&!p.truncated&&!p.truncatedByPageLimit&&!p.truncatedByResultLimit&&Number(p.failedCount||0)===0&&(!p.failures||p.failures.length===0);
 return {records,complete,pagesFetched:Number(p.pagesFetched)||0,stopReason:String(p.stopReason||'')};
}
function normalizeWechat(payload,scope,accountId){
 if(payload?.ok!==true)throw new CollectorError(payload?.status==='needs_login'?'微信未就绪，请本人登录选定账号后重试':'微信采集器未完成本轮读取',payload?.status==='needs_login'?'needs_login':'failure');
 if(payload.accountId!==accountId)throw new CollectorError('微信实际账号与本人绑定账号不匹配');
 if(!Array.isArray(payload.chats)||payload.chats.length!==scope.length)throw new CollectorError('微信输出没有完整覆盖已选范围');
 const seen=new Set(),records=[];
 for(const chat of payload.chats){
  if(!scope.includes(chat.username)||seen.has(chat.username))throw new CollectorError('微信输出包含未授权或重复范围');seen.add(chat.username);
  if(!Array.isArray(chat.messages))throw new CollectorError('微信输出缺少消息数组');
  for(const m of chat.messages){
   if(typeof m.source_db!=='string'||!m.source_db||m.local_id===undefined||m.local_id===null)throw new CollectorError('微信消息缺少完整分片与本地编号');
   if(typeof m.time!=='string'||!/(?:Z|[+-]\d\d:\d\d)$/.test(m.time))throw new CollectorError('微信消息时间缺少原始时区，无法核对');
   const at=iso(m.time);if(!at)throw new CollectorError('微信消息时间无法核对');
   records.push({id:`wechat:${accountId}:${chat.username}:${m.source_db}:${String(m.local_id)}`,accountId,conversation:chat.username,text:typeof m.content==='string'?m.content:'',at,from:m.sender_username||'',sourceDb:m.source_db,localId:String(m.local_id),serverId:m.server_id||'',messageType:m.type_code,senderStatus:m.sender_status||'',mediaReviewed:false});
  }
 }
 return records;
}
function createCollectors({spawnImpl=spawn,now=()=>new Date()}={}){
 async function command(c,args,options){checkAbort(options?.signal);options?.checkCurrent?.();const result=await runProcess(c.executable,args,{spawnImpl,...options});options?.checkCurrent?.();checkAbort(options?.signal);return result;}
 async function probe(source,options={}){
  try{
   const c=configuration(source);
   if(c.kind==='wechat-export'){
    if(options.hasCredential!==true&&!options.credential)throw new CollectorError('请本人提供该账号的离线数据库密钥；本程序不读取微信进程内存','needs_credential');
    if(!fs.existsSync(c.scriptPath))throw new CollectorError('指定的微信源码工具尚未安装','not_installed');
    const result=await command(c,['-c',WECHAT_RUNNER,'--check','--tool-dir',path.dirname(c.scriptPath)],{...options,timeoutMs:15000});const p=json(result.stdout);
    if(result.code!==0||p.ok!==true)throw new CollectorError('微信工具版本或依赖未就绪，请核对指定版本与 SHA-256',p.status==='not_installed'?'not_installed':'failure');
    return {status:'configured',kind:c.kind,revision:WECHAT_REVISION,accountVerified:false,message:'指定源码与依赖检查通过；尚未读取微信，也未验证当前账号登录。整理时仅读取所选稳定会话。'};
   }
   const version=await command(c,['--version'],{...options,timeoutMs:10000});if(version.code!==0)throw new CollectorError('钉钉 CLI 版本探测失败');
   const help=await command(c,['chat','+chat-messages','--help'],{...options,timeoutMs:10000});
   if(help.code!==0||!['--start','--end','--page-all','--no-reactions'].every(x=>help.stdout.includes(x)))throw new CollectorError('钉钉 CLI 缺少已核实的范围/分页读取命令，请使用兼容版本');
   const authHelp=await command(c,['auth','status','--help'],{...options,timeoutMs:10000});if(authHelp.code!==0||!authHelp.stdout.includes('--readonly'))throw new CollectorError('钉钉 CLI 不支持只读登录探测，已停止');
   const status=await command(c,['auth','status','--readonly','--profile',c.profile,'--format','json'],{...options,timeoutMs:10000});const p=json(status.stdout);const [corp,user]=c.profile.split(':');
   if(status.code!==0||p.success!==true||p.authenticated!==true||p.corp_id!==corp||p.user_id!==user)throw new CollectorError('选定钉钉身份未登录、已失效或与保存身份不符，请本人处理','needs_login');
   return {status:'configured',kind:c.kind,accountVerified:true,message:'已核对选定钉钉本地登录态；未读取聊天，平台读取权限仍待首次整理验证。'};
  }catch(e){if(e.collectorStatus==='cancelled')throw e;return {status:e.collectorStatus||'failure',message:e.message};}
 }
 async function collect(source,options={}){
  const c=configuration(source);const credential=c.kind==='wechat-export'?validateWechatCredential(options.credential,source):undefined;
  const ready=await probe(source,{...options,...(credential?{hasCredential:true}:{})});if(ready.status!=='configured')throw new CollectorError(ready.message,ready.status);
  if(c.kind==='wechat-export'){
   const r=await command(c,['-c',WECHAT_RUNNER,'--collect','--tool-dir',path.dirname(c.scriptPath)],{...options,timeoutMs:Math.min(600000,Math.max(30000,Number(c.timeoutMs)||180000)),input:JSON.stringify({accountDir:c.dbDir,accountId:c.accountId,scope:source.scope,credential}),maxBytes:20*1024*1024});
   const platformCollectedAt=now().toISOString();const payload=json(r.stdout);if(r.code!==0)throw new CollectorError(payload.status==='needs_credential'?'微信离线密钥缺失、失效或不匹配，请本人核对':payload.status==='snapshot_incomplete'?'微信数据库快照未包含本轮完整 WAL，或源库发生变化，本轮未提交':'微信读取失败，版本/依赖/权限需核对',['needs_credential','snapshot_incomplete','needs_login'].includes(payload.status)?payload.status:'failure');
   const records=normalizeWechat(payload,source.scope,c.accountId),finished=now().toISOString();
   return {records,complete:true,collectorStatus:'collected',checkpoint:{adapter:c.kind,binding:binding(source),lastFullCollectionAt:finished},platformCollectedAt,fileProcessedAt:finished,coverage:{mode:c.kind,platformDirect:true,incremental:'指定会话重新读取，入库前持久去重',mediaReviewed:false,media:'仅文字与媒体占位；图片、语音、视频和附件内容未读取',revision:WECHAT_REVISION,scope:[...source.scope]}};
  }
  const old=source.checkpoint?.adapter===c.kind&&source.checkpoint?.binding===binding(source)?source.checkpoint:null;
  const start=iso(old?.committedThrough||c.startAt);const end=new Date(Math.min(now().getTime(),Date.parse(start)+86400000)).toISOString();
  if(Date.parse(start)>now().getTime())throw new CollectorError('首次采集起点不能在未来','needs_scope');
  const records=[],windows=[];let complete=true;let platformCollectedAt=source.platformCollectedAt;
  if(start!==end)for(const conversation of source.scope){
   let r;
   try{r=await command(c,['chat','+chat-messages','--conversation-id',conversation,'--start',start,'--end',end,'--order','asc','--page-all','--page-limit','50','--max-items','5000','--no-reactions','--profile',c.profile,'--format','json'],{...options,timeoutMs:120000});}
   catch(e){if(!windows.length||e.collectorStatus==='cancelled')throw e;complete=false;windows.push({conversation,complete:false,error:'本群采集未完成，原检查点保留'});break;}
   platformCollectedAt=now().toISOString();
   if(r.code!==0&&!r.stdout.trim())throw new CollectorError('钉钉采集失败或网络断开，保留原检查点');
   const parsed=parseDwsLedger(json(r.stdout),conversation,{start,end},c.profile);records.push(...parsed.records);complete=complete&&parsed.complete&&r.code===0;windows.push({conversation,...parsed,records:undefined});
  }
  const finished=now().toISOString();return {records,complete,collectorStatus:complete?'collected':'partial',...(complete?{checkpoint:{adapter:c.kind,binding:binding(source),committedThrough:end,lastFullCollectionAt:finished}}:{}),platformCollectedAt,fileProcessedAt:finished,coverage:{mode:c.kind,platformDirect:true,queriedPlatform:windows.length>0,range:{start,end},backlog:Date.parse(end)<now().getTime(),complete,windows,mediaReviewed:false,media:'仅消息文字；图片、语音、视频、附件、话题回复及 reaction 未读取',scope:[...source.scope]}};
 }
 return {probe,collect,kinds:KINDS};
}
module.exports={createCollectors,runProcess,parseDwsLedger,normalizeWechat,validateWechatCredential,CollectorError};
