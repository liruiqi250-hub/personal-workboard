const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');const {spawn}=require('node:child_process');
const {createStore}=require('./store.cjs');const {createVault}=require('./vault.cjs');const {createSources}=require('./sources.cjs');const {createUpdates}=require('./updates.cjs');const {shanghaiDate}=require('./extract.cjs');
const {buildReport,exportDocx}=require('../server/reports.cjs');const {WechatClient}=require('../server/wechat.cjs');const {CodexController}=require('../server/codex.cjs');
const {createManagedCodexStore}=require('./managed-codex-store.cjs');const {createOutbound}=require('./outbound.cjs');
const {validateWechatCredential}=require('./collectors.cjs');
const pkg=require('../package.json');const VERSION=pkg.version;const PORT=Number(process.env.BOARD_PORT)||18327;const HOST='127.0.0.1';
const dataDir=path.resolve(process.env.BOARD_DATA_DIR||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.local','share'),'PersonalWorkboard'));
const instanceId=crypto.randomUUID();
fs.mkdirSync(dataDir,{recursive:true});
const lockFile=path.join(dataDir,'service.lock');let ownsLock=false;
if(require.main===module){
 if(fs.existsSync(lockFile)){let running=false;try{const pid=Number(fs.readFileSync(lockFile,'utf8'));process.kill(pid,0);running=true;}catch{}if(running){console.error('这个个人数据目录已有运行中的看板，请打开已有网址。');process.exit(3);}fs.unlinkSync(lockFile);}
 fs.writeFileSync(lockFile,String(process.pid),{flag:'wx'});ownsLock=true;
 const pending=path.join(dataDir,'restore-next-start.sqlite');
 if(fs.existsSync(pending)){for(const suffix of ['-wal','-shm']){const f=path.join(dataDir,'workboard.sqlite'+suffix);if(fs.existsSync(f))fs.unlinkSync(f);}fs.copyFileSync(pending,path.join(dataDir,'workboard.sqlite'));fs.unlinkSync(pending);}
}
const reportDefault=path.join(dataDir,'报告');const store=createStore(dataDir);const vault=createVault(dataDir);const token=crypto.randomBytes(32).toString('hex');
for(const d of store.all('deliveries'))if(d.status==='sending')store.put('deliveries',{...d,status:'unknown',message:'上次服务在发送中退出，结果未知，请核对手机后再决定是否重试'});
const defaults={name:'',aliases:[],reportDir:reportDefault,reportTime:'17:30',workdays:[1,2,3,4,5],dailyEnabled:false,wechatRemoteEnabled:false,onboardingStep:0,onboardingComplete:false,autoLaunch:false,ai:{mode:'rules',baseUrl:'',model:''},updates:{owner:'liruiqi250-hub',repo:'personal-workboard',publicKey:''},allowedProjects:[]};
function settings(){const saved=store.getSetting('settings',{});const updates={...defaults.updates,...saved.updates};if(!updates.owner&&!updates.repo)Object.assign(updates,{owner:defaults.updates.owner,repo:defaults.updates.repo});return {...defaults,...saved,ai:{...defaults.ai,...saved.ai},updates};}
function safeLog(kind,data){store.log(kind,data);}
async function onCodexOutput(event){
 if(event.type!=='completed')return;
 const result=codex.getResult(event.threadId);
 if(!result||result.turnId!==event.turnId){safeLog('codex.result_error',{message:'本轮结果与持久受管记录不一致，未自动回传'});return;}
 store.setSetting('lastCodexResult',{...result,at:new Date().toISOString()});
 try{
  const files=outbound.registerCodexResult(result);
  if(!settings().wechatRemoteEnabled)return;
  await outbound.sendText(result.text||result.error||`Codex 任务状态：${result.status}`,{key:`codex-result:${result.threadId}:${result.turnId}`,threadId:result.threadId,turnId:result.turnId,cwd:result.cwd});
  if((result.text||'').length>3500)await outbound.sendArtifact(files.result.id);
  for(const artifact of files.artifacts)await outbound.sendArtifact(artifact.id);
  if(files.rejected.length)safeLog('codex.artifacts_skipped',{threadId:result.threadId,turnId:result.turnId,files:files.rejected});
 }catch(error){safeLog('wechat.reply',{status:'failed',threadId:result.threadId,turnId:result.turnId,message:'Codex 结果已保存在本机；回传状态请到微信助手核对：'+error.message});}
}
const codex=new CodexController({getSettings:settings,persistence:createManagedCodexStore(store),onOutput:onCodexOutput,onApproval:async approval=>{
 const thread=codex.listThreads().find(item=>item.id===approval.threadId);if(!thread)return;
 const details=[approval.reason,approval.command&&'命令：'+approval.command,approval.cwd&&'目录：'+approval.cwd,approval.permissions&&'权限：'+JSON.stringify(approval.permissions),approval.network&&'网络：'+JSON.stringify(approval.network)].filter(Boolean).join('\n');
 await outbound.sendText(`任务等待确认\n${details||'Codex 需要你的决定'}\n回复 /同意 ${approval.code} 或 /拒绝 ${approval.code}`,{key:'codex-approval:'+approval.code,threadId:approval.threadId,turnId:approval.turnId,cwd:thread.cwd,kind:'approval'}).catch(()=>safeLog('codex.approval_notification_failed',{threadId:approval.threadId}));
}});
const seenInbound=new Set();
const wechat=new WechatClient({vault,getSettings:settings,onStatus:s=>{store.setSetting('wechatStatus',{...s,qrDataUrl:undefined,qrcode:undefined});},onMessage:async m=>{const id=m.id||m.messageId;const ledger='wechat-input:'+crypto.createHash('sha256').update(String(m.senderId)+':'+String(id)).digest('hex');if(!m.verifiedOwner||seenInbound.has(id)||store.getSetting(ledger,null))return;store.setSetting(ledger,{at:new Date().toISOString(),state:'received'});seenInbound.add(id);if(seenInbound.size>1000)seenInbound.delete(seenInbound.values().next().value);try{await routeWechat(m.text,id);store.setSetting(ledger,{at:new Date().toISOString(),state:'routed'});}catch(e){store.setSetting(ledger,{at:new Date().toISOString(),state:'failed',message:e.message});await wechat.sendText({text:e.message}).catch(()=>{});}}});
const outbound=createOutbound({store,wechat,getSettings:settings,dataDir});
const sources=createSources({store,vault,getSettings:settings});
async function saveSource(input){
 if(input.wechatKeys!==undefined&&typeof input.wechatKeys!=='string')throw Error('离线逐库密钥应为 JSON 文本，请勿放入来源配置');
 const id=input.id||crypto.randomUUID();const old=store.get('sources',id)||{};const platform=input.platform||old.platform;
 if(!['wechat','email','dingtalk','manual'].includes(platform))throw Error('来源类型无效');
 const source={...old,id,platform,name:String(input.name||old.name||'我的来源').slice(0,100),enabled:!!input.enabled,scope:Array.isArray(input.scope)?input.scope.map(String):[],config:{...old.config,...input.config},status:old.status||'configured'};
 const credentialChanged=!!input.password||typeof input.wechatKeys==='string'&&!!input.wechatKeys.trim();
 const changed=!old.id||credentialChanged||JSON.stringify([old.platform,old.scope,old.config])!==JSON.stringify([source.platform,source.scope,source.config]);
 if(changed||!source.enabled)sources.cancel(id);
 let wechatCredential;
 if(typeof input.wechatKeys==='string'&&input.wechatKeys.trim()){
  if(platform!=='wechat'||source.config.collector?.kind!=='wechat-export')throw Error('解密凭据仅用于明确的本人微信采集来源');
  let keys;try{keys=JSON.parse(input.wechatKeys);}catch{throw Error('请填写本人提供的逐库密钥 JSON 对象，内容不会回填页面');}
  wechatCredential=validateWechatCredential({schema:1,accountId:source.config.collector.accountId,accountDir:source.config.collector.dbDir,keys},source);
 }
 if(input.password)await vault.set('source:'+id,input.password);
 if(wechatCredential)await vault.set('source-wechat:'+id,JSON.stringify(wechatCredential));
 if(credentialChanged)source.config={...source.config,credentialRevision:crypto.randomUUID()};
 if(changed){sources.cancel(id);Object.assign(source,{status:'configured',collectorStatus:source.config.collector?.kind?'configured':undefined,lastError:'',lastSuccessAt:null,platformCollectedAt:null,fileProcessedAt:null,coverage:{mode:'not_verified',platformDirect:false},checkpoint:{}});}
 else if(!source.enabled)sources.cancel(id);
 return store.put('sources',source);
}
function eventRows(){return store.events();}
function preview(type,date){return buildReport({tasks:store.all('tasks'),events:eventRows(),sources:store.all('sources'),type:type||'daily',date:date||shanghaiDate(),name:settings().name||'我的工作',now:new Date()});}
async function saveReport({type='daily',date=shanghaiDate(),format='html'}) {
 if(!['daily','weekly'].includes(type)||!['html','docx','pdf'].includes(format))throw Error('报告类型或格式无效');
 const report=preview(type,date);let revision=1+store.all('reports').filter(r=>r.type===type&&r.startDate===report.startDate&&r.endDate===report.endDate).length;
 const dir=path.resolve(settings().reportDir||reportDefault);fs.mkdirSync(dir,{recursive:true});let name;let file;do{name=`${type==='daily'?'日报':'周报'}_${report.startDate}_${report.endDate}_R${revision}.${format}`;file=path.join(dir,name);if(!fs.existsSync(file))break;revision++;}while(revision<100000);
 if(format==='docx')await exportDocx(report,file);else if(format==='html')fs.writeFileSync(file,report.html,{flag:'wx',encoding:'utf8'});else await printPdf(report.html,file);
 if(!fs.existsSync(file)||fs.statSync(file).size<20)throw Error('报告保存失败，请检查目录权限和磁盘空间');
 const saved={id:crypto.randomUUID(),type,startDate:report.startDate,endDate:report.endDate,revision,createdAt:new Date().toISOString(),cutoffAt:report.cutoffAt,summary:report.summary,stats:report.stats,path:file,format,fileName:name};store.put('reports',saved);outbound.registerReport(saved.id);safeLog('report.saved',{id:saved.id,type,format});return {...saved,downloadUrl:`/api/report/${saved.id}/download`};
}
function spawnWait(exe,args,{input,timeout=60000}={}){return new Promise((resolve,reject)=>{const p=spawn(exe,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{p.kill();reject(Error('操作超时，请重试'));},timeout);p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',()=>{clearTimeout(timer);reject(Error('所需本机工具不可用'));});p.on('close',c=>{clearTimeout(timer);c===0?resolve(out.trim()):reject(Error('本机工具执行失败，请查看诊断信息'));});p.stdin.end(input||'');});}
async function printPdf(html,file){const candidates=[path.join(process.env['PROGRAMFILES(X86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),path.join(process.env.PROGRAMFILES||'C:/Program Files','Microsoft/Edge/Application/msedge.exe'),path.join(process.env.PROGRAMFILES||'C:/Program Files','Google/Chrome/Application/chrome.exe')];const browser=candidates.find(fs.existsSync);if(!browser)throw Error('导出 PDF 需要本机 Edge 或 Chrome；也可以先导出 Word');const temp=path.join(dataDir,'print',crypto.randomUUID());fs.mkdirSync(temp,{recursive:true});const htmlPath=path.join(temp,'report.html');fs.writeFileSync(htmlPath,html);await spawnWait(browser,['--headless=new','--disable-gpu','--no-pdf-header-footer','--no-first-run',`--user-data-dir=${path.join(temp,'profile')}`,`--print-to-pdf=${file}`,require('node:url').pathToFileURL(htmlPath).href],{timeout:60000});if(!fs.existsSync(file))throw Error('PDF 尚未生成，请尝试 Word 格式');}
async function choosePath(kind){if(process.platform!=='win32')return {path:kind==='folder'?settings().reportDir:'',manual:true};const script=kind==='folder'?`Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择本机保存文件夹'; if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}`:`Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Filter='记录或备份|*.json;*.txt;*.sqlite|所有文件|*.*'; if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.FileName)}`;return {path:await spawnWait('powershell.exe',['-NoProfile','-STA','-Command',script],{timeout:180000})};}
function openPath(file){if(!path.isAbsolute(file)||!fs.existsSync(file))throw Error('位置不存在，请重新选择');spawn('explorer.exe',[file],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});return {opened:true,path:file};}
async function backup(){const dir=path.join(dataDir,'backups');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,`workboard-${VERSION}-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);store.backup(file);return {path:file,createdAt:new Date().toISOString(),version:VERSION,credentialsIncluded:false};}
const updater=createUpdates({version:VERSION,dataDir,getSettings:settings,backup});
let updateLaunchPending=false;
async function sendReport(id,{scheduled=false}={}){const report=store.get('reports',id);if(!report)throw Error('请先生成报告');const prior=store.all('deliveries').find(d=>d.reportId===id&&['accepted','unknown','sending'].includes(d.status));if(prior)throw Error('这份报告已有发送记录，请先核对，避免重复发送');const delivery={id:crypto.randomUUID(),reportId:id,date:report.endDate,revision:report.revision,createdAt:new Date().toISOString(),status:'sending',scheduled};store.put('deliveries',delivery);
 try{const result=await wechat.sendText({text:report.summary});const next={...delivery,status:'accepted',message:'微信接口已接受；本程序未取得用户已读回执',acceptedAt:new Date().toISOString(),result:result?.messageId?{messageId:result.messageId}:undefined};store.put('deliveries',next);return next;}catch(e){const next={...delivery,status:'unknown',message:'发送结果需核对：'+e.message};store.put('deliveries',next);throw Error(next.message);}}
async function routeWechat(text,requestId=crypto.randomUUID()){const t=String(text||'').trim();if(/^(你好|帮助|菜单|\/help)$/.test(t))return wechat.sendText({text:'可以问我：今天待办、日报、周报。\n遥控需在本机开启并选择允许项目：/codex 任务内容\n/停止、/同意 审批码、/拒绝 审批码。'});
 if(/^(今天待办|今日待办|今天还有哪些事情没做[？?]?)$/.test(t)){const tasks=store.all('tasks').filter(x=>!x.deletedAt&&!x.example&&x.status!=='done');return wechat.sendText({text:tasks.length?tasks.slice(0,30).map((x,i)=>`${i+1}. ${x.title}${x.dueDate?'（'+x.dueDate+'）':''}`).join('\n'):'当前没有已记录的未完成事项。消息来源覆盖请在本机查看。'});}
 if(/^(日报|周报)$/.test(t))return wechat.sendText({text:preview(t==='日报'?'daily':'weekly').summary});
 if(t.startsWith('/codex ')){const s=settings();if(!s.wechatRemoteEnabled)throw Error('请先在本机开启微信遥控 Codex');if(!s.allowedProjects.length)throw Error('请先在本机选择允许操作的工作项目');const r=await codex.run({prompt:t.slice(7),cwd:s.allowedProjects[0],requestId});return wechat.sendText({text:`已提交到本机 Codex，完成后回传完整结果。\n会话编号：${r.threadId}`});}
 const resume=t.match(/^\/继续\s+(\S+)\s+([\s\S]+)$/);if(resume){const id=resume[1]==='最近'?codex.getLastThreadId():resume[1];if(!id)throw Error('尚无本看板登记的受管会话');await codex.resume({threadId:id,prompt:resume[2],requestId});return wechat.sendText({text:'已继续指定任务：'+id});}
 if(t==='/停止'){const id=codex.getLastThreadId();if(!id)throw Error('目前没有本组件管理的任务可停止');return codex.interrupt({threadId:id});}
 const file=t.match(/^\/文件\s+(\S+)$/);if(file)return outbound.sendArtifact(file[1],{requestId:'wechat-file:'+requestId});
 if(/^(日报文件|周报文件)$/.test(t)){const report=await saveReport({type:t==='日报文件'?'daily':'weekly',format:'docx'});return outbound.sendArtifact(outbound.registerReport(report.id).id,{requestId:'wechat-report:'+requestId});}
 const approval=t.match(/^\/(同意|拒绝)\s+(\S+)$/);if(approval){const r=await codex.approve({code:approval[2],decision:approval[1]==='同意'?'accept':'decline'});return wechat.sendText({text:'已处理这一次确认请求。'});}
 return wechat.sendText({text:'请发送“今天待办”“日报”“周报”，或使用 /codex 开头提交本机任务。普通聊天不会自动作为系统命令执行。'});
}
let scheduleBusy=false;
async function tick(){if(scheduleBusy)return;scheduleBusy=true;try{sources.tick().catch(e=>safeLog('source.scheduler_error',{message:e.message}));const s=settings();if(!s.dailyEnabled)return;const now=new Date();const local=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Shanghai'}));const today=shanghaiDate(now);if(!s.workdays.includes(local.getDay()))return;const time=`${String(local.getHours()).padStart(2,'0')}:${String(local.getMinutes()).padStart(2,'0')}`;if(time<s.reportTime)return;
 const key='daily-attempt-'+today;let previous=store.getSetting(key,null);if(previous?.state==='started'){const priorDelivery=store.all('deliveries').find(d=>d.date===today&&['accepted','sending','unknown'].includes(d.status));previous=priorDelivery?{...previous,state:'needs_confirmation',reportId:priorDelivery.reportId}:{...previous,state:'generation_failed',message:'上版生成任务中断，可重新生成'};store.setSetting(key,previous);}if(previous&&!['generation_failed','generated'].includes(previous.state)&&!(previous.state==='generating'&&Date.now()-Date.parse(previous.at)>600000))return;
 let r=previous?.state==='generated'?store.get('reports',previous.reportId):null;
 if(!r){store.setSetting(key,{at:now.toISOString(),state:'generating'});try{r=await saveReport({type:'daily',date:today,format:'html'});store.setSetting(key,{at:now.toISOString(),state:'generated',reportId:r.id});}catch(e){store.setSetting(key,{at:now.toISOString(),state:'generation_failed',message:e.message});safeLog('report.generation_failed',{message:e.message});return;}}
 try{await sendReport(r.id,{scheduled:true});store.setSetting(key,{at:now.toISOString(),state:'accepted',reportId:r.id});}catch(e){store.setSetting(key,{at:now.toISOString(),state:'needs_confirmation',reportId:r.id,message:e.message});}
 }catch(e){safeLog('scheduler.error',{message:e.message});}finally{scheduleBusy=false;}}
async function api(method,p={}) {
 switch(method){
 case 'bootstrap':return {version:VERSION,tasks:store.all('tasks'),sources:store.all('sources').map(s=>({...s,hasCredential:vault.has(s.platform==='wechat'&&s.config?.collector?.kind==='wechat-export'?'source-wechat:'+s.id:'source:'+s.id)})),settings:settings(),reports:store.all('reports').map(r=>({...r,downloadUrl:`/api/report/${r.id}/download`})),deliveries:store.all('deliveries'),outbound:outbound.list(),connections:{wechat:await wechat.status(),codex:await codex.status()},update:updater.status(),paths:{dataDir,reportDir:settings().reportDir},activity:store.all('activity').sort((a,b)=>b.at.localeCompare(a.at)).slice(0,100),messages:store.messages().map(m=>({...m,text:m.message.text,createdAt:m.at})),schedule:{lastTickAt:store.getSetting('lastTickAt',null),daily:store.getSetting('daily-attempt-'+shanghaiDate(),null)}};
 case 'task.create':return store.createTask(p);
 case 'task.patch':return store.patchTask(p.id,p);
 case 'task.delete':return store.deleted(p.id);
 case 'task.restore':return store.deleted(p.id,true);
 case 'settings.save':{const old=settings();const valid={};for(const k of Object.keys(defaults))if(k in p)valid[k]=p[k];if(valid.reportTime&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(valid.reportTime))throw Error('提醒时间格式应为 09:00');if(valid.workdays&&!valid.workdays.every(x=>Number.isInteger(x)&&x>=0&&x<7))throw Error('工作日无效');if(valid.allowedProjects){valid.allowedProjects=valid.allowedProjects.map(x=>path.resolve(x));for(const d of valid.allowedProjects)if(!fs.existsSync(d)||!fs.statSync(d).isDirectory())throw Error('所选工作项目目录不存在');}if(valid.reportDir){valid.reportDir=path.resolve(valid.reportDir);fs.mkdirSync(valid.reportDir,{recursive:true});fs.accessSync(valid.reportDir,fs.constants.W_OK);}if(p.aiKey)await vault.set('ai-key',p.aiKey);const s={...old,...valid,ai:{...old.ai,...valid.ai},updates:{...old.updates,...valid.updates}};store.setSetting('settings',s);return s;}
 case 'settings.chooseReportDir':{const r=await choosePath('folder');if(r.path)store.setSetting('settings',{...settings(),reportDir:r.path});return r;}
 case 'settings.chooseProject':return choosePath('folder');
 case 'settings.openReportDir':fs.mkdirSync(settings().reportDir,{recursive:true});return openPath(settings().reportDir);
 case 'app.openDataDir':return openPath(dataDir);
 case 'source.save':return saveSource(p);
 case 'source.remove':sources.cancel(p.id);store.db.prepare('DELETE FROM sources WHERE id=?').run(p.id);await vault.delete('source:'+p.id);await vault.delete('source-wechat:'+p.id);return {removed:true};
 case 'source.cancel':return {cancelled:sources.cancel(p.id),message:'已请求取消本轮采集；已经入库的消息保留，检查点仅在完整成功后前移'};
 case 'source.probeCollectors':return sources.probeCollectors();
 case 'source.test':return sources.test(p.id);
 case 'source.sync':return sources.sync(p.id,{force:true});
 case 'source.import':return sources.importText(p.id,p.text,p.targetTaskId);
 case 'source.relink':return store.relink(p.messageId,p.targetTaskId);
 case 'source.pickImport':{const chosen=await choosePath('file');if(!chosen.path)return {cancelled:true};return {path:chosen.path,...await sources.importText(p.id,fs.readFileSync(chosen.path,'utf8'),p.targetTaskId)};}
 case 'report.preview':return preview(p.type,p.date);
 case 'report.export':return saveReport(p);
 case 'report.open':{const r=store.get('reports',p.id);if(!r)throw Error('报告不存在');return openPath(r.path);}
 case 'report.send':return sendReport(p.id);
 case 'report.sendFile':return outbound.sendArtifact(outbound.registerReport(p.id).id);
 case 'outbound.send':return outbound.sendArtifact(p.id);
 case 'outbound.resolve':return outbound.resolve(p.id,p.decision);
 case 'outbound.retry':return outbound.retry(p.id);
 case 'outbound.list':return outbound.list();
 case 'report.retryDaily':{const key='daily-attempt-'+shanghaiDate();const job=store.getSetting(key,null);if(!job||!['generation_failed','needs_confirmation'].includes(job.state))throw Error('当前没有可人工恢复的日报');if(job.reportId){const pending=store.all('deliveries').some(d=>d.reportId===job.reportId&&['sending','accepted','unknown'].includes(d.status));if(pending)throw Error('请先到发送记录核对这份报告的结果，避免重复发送');store.setSetting(key,{...job,state:'generated'});}await tick();return store.getSetting(key,null);}
 case 'delivery.resolve':{const d=store.get('deliveries',p.id);if(!d||d.status!=='unknown'||p.decision!=='not_received')throw Error('请先核对确切的待确认发送记录');const next={...d,status:'confirmed_not_received',resolvedAt:new Date().toISOString(),message:'本人已核对未收到，可手动重试；尚未再次发送'};store.put('deliveries',next);safeLog('delivery.resolved',{id:d.id,decision:p.decision});return next;}
 case 'wechat.connect':return wechat.connect();
 case 'wechat.status':return wechat.status();
 case 'wechat.confirm':return wechat.confirm(p);
 case 'wechat.disconnect':return wechat.disconnect();
 case 'wechat.test':return wechat.sendText({text:'这是个人待办事项看板的测试消息。请核对接收微信是否正确。'});
 case 'codex.status':return codex.status();
 case 'codex.threads':return codex.listThreads();
 case 'codex.result':{const result=codex.getResult(p.threadId);if(!result)throw Error('本会话尚无已登记的完成结果，请先核对当前任务状态');return result;}
 case 'codex.interrupt':return codex.interrupt(p);
 case 'update.check':return updater.check();
 case 'update.download':return updater.download();
 case 'update.install':{if(updateLaunchPending)throw Error('更新已经在准备或执行中，请等待完成后刷新网页');updateLaunchPending=true;try{const ready=await updater.prepareInstall();if(process.platform!=='win32')throw Error('自动更新脚本目前仅支持 Windows');const script=path.resolve(__dirname,'../scripts/update.ps1');if(!fs.existsSync(script))throw Error('本机升级脚本缺失，请按部署指南修复');setTimeout(()=>{const logDir=path.join(dataDir,'logs');fs.mkdirSync(logDir,{recursive:true});const out=fs.openSync(path.join(logDir,'update.log'),'a');const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-PackagePath',ready.file,'-ExpectedSha256',ready.sha256,'-DataDir',dataDir,'-Port',String(PORT)],{cwd:path.resolve(__dirname,'..'),windowsHide:true,detached:true,stdio:['ignore',out,out]});child.on('error',()=>{updateLaunchPending=false;safeLog('update.error',{message:'无法启动本机更新脚本'});});child.unref();fs.closeSync(out);},250);return {...ready,installing:true,message:'签名已验证，数据已备份。更新正在后台执行并重启服务，完成后请刷新网页；失败详情保存在本机更新日志。'};}catch(e){updateLaunchPending=false;throw e;}}
 case 'backup.create':return backup();
 case 'backup.restore':{if(!p.confirmed)throw Error('恢复会替换当前任务数据，请先确认并做好备份');const chosen=await choosePath('file');if(!chosen.path)return {cancelled:true};const check=new(require('node:sqlite').DatabaseSync)(chosen.path,{readOnly:true});try{check.prepare('SELECT id,json FROM tasks LIMIT 1').all();}finally{check.close();}const saved=await backup();store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');fs.copyFileSync(chosen.path,path.join(dataDir,'restore-next-start.sqlite'));return {prepared:true,backup:saved,message:'恢复文件已准备，请停止并重新启动本机服务完成恢复。'};}
 case 'app.minimize':return {message:'关闭网页不会停止本机后台服务。'};
 case 'app.quit':return {message:'请使用交付目录中的停止脚本停止本机服务。'};
 case 'service.stop':setTimeout(stop,100);return {stopping:true};
 default:throw Error('不支持的操作，请刷新到当前版本');
 }
}
const contentTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};
function trusted(req){const expected=`127.0.0.1:${PORT}`;if(![expected,`localhost:${PORT}`].includes(req.headers.host))return false;const origin=req.headers.origin;return !origin||[`http://${expected}`,`http://localhost:${PORT}`].includes(origin);}
function json(res,code,value){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
const server=http.createServer(async(req,res)=>{try{
 if(!trusted(req))return json(res,403,{ok:false,error:'只允许本机同源访问'});const url=new URL(req.url,`http://${HOST}:${PORT}`);
 if(url.pathname==='/health')return json(res,200,{ok:true,version:VERSION,service:'personal-workboard',host:HOST,startedAt,instanceId,apiVersion:1});
 if(url.pathname==='/api/session'&&req.method==='GET')return json(res,200,{token});
 if(url.pathname==='/api/call'&&req.method==='POST'){if(req.headers['x-board-token']!==token)return json(res,403,{ok:false,error:'本机请求验证失败'});const parts=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>22*1024*1024)return json(res,413,{ok:false,error:'内容过大，请分批导入'});parts.push(chunk);}let input;try{input=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{return json(res,400,{ok:false,error:'请求格式错误'});}try{return json(res,200,{ok:true,data:await api(input.method,input.payload||{})});}catch(e){return json(res,200,{ok:false,error:e.message});}}
 if(url.pathname.startsWith('/api/report/')&&url.pathname.endsWith('/download')){const id=url.pathname.split('/')[3];const r=store.get('reports',id);if(!r||!fs.existsSync(r.path))return json(res,404,{ok:false,error:'报告文件不存在，请重新导出'});res.writeHead(200,{'Content-Type':r.format==='pdf'?'application/pdf':r.format==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/html; charset=utf-8','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(r.fileName)}`,'Cache-Control':'no-store'});return fs.createReadStream(r.path).pipe(res);}
 if(req.method!=='GET')return json(res,405,{ok:false,error:'不支持的请求'});
 const root=path.resolve(__dirname,'../dist');let target=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(!target.startsWith(root+path.sep)&&target!==root)return json(res,403,{ok:false,error:'路径不允许'});if(!path.extname(target)||!fs.existsSync(target))target=path.join(root,'index.html');if(!fs.existsSync(target))return json(res,503,{ok:false,error:'界面尚未构建，请执行部署脚本'});
 res.writeHead(200,{'Content-Type':contentTypes[path.extname(target)]||'application/octet-stream','Cache-Control':path.extname(target)==='.html'||target.endsWith('client.js')?'no-store':'public, max-age=3600','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"});fs.createReadStream(target).pipe(res);
 }catch{json(res,500,{ok:false,error:'本机服务处理失败，请查看诊断信息'});}});
const startedAt=new Date().toISOString();let timer;
server.on('error',err=>{console.error(err.code==='EADDRINUSE'?`端口 ${PORT} 已使用，请先检查已有看板，或设置 BOARD_PORT。`:'本机服务启动失败：'+err.code);if(ownsLock&&fs.existsSync(lockFile))fs.unlinkSync(lockFile);process.exit(1);});
if(require.main===module){server.listen(PORT,HOST,()=>{console.log(`个人待办事项看板 V${VERSION} http://${HOST}:${PORT}`);fs.writeFileSync(path.join(dataDir,'service.json'),JSON.stringify({pid:process.pid,port:PORT,version:VERSION,startedAt,instanceId}));wechat.start().catch(()=>{});timer=setInterval(()=>{store.setSetting('lastTickAt',new Date().toISOString());tick();},60000);timer.unref();});}
function stop(){if(timer)clearInterval(timer);for(const source of store.all('sources'))sources.cancel(source.id);wechat.stop?.();codex.stop?.();server.close(()=>{store.close();if(ownsLock&&fs.existsSync(lockFile))fs.unlinkSync(lockFile);process.exit(0);});setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
module.exports={api,server,store,settings,preview,saveReport,tick,routeWechat,outbound,VERSION,PORT,dataDir};
