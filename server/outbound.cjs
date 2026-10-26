'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const MAX_FILE_BYTES=20*1024*1024;
const MAX_RESULT_BYTES=4*1024*1024;
const MIME={'.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.html':'text/html','.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.zip':'application/zip','.dxf':'application/dxf','.step':'model/step','.stp':'model/step','.stl':'model/stl'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function within(root,file){const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
function splitText(value,limit=3500){
 const text=String(value||'');if(!text.trim())throw Error('没有可回传的文字结果');
 if(Buffer.byteLength(text)>MAX_RESULT_BYTES)throw Error('结果超过本版本 4 MiB 文字上限，请在本机查看');
 const parts=[];let position=0;
 while(position<text.length){let end=Math.min(position+limit,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;parts.push(text.slice(position,end));position=end;}
 return parts;
}
function createOutbound({store,wechat,getSettings=()=>({}),dataDir,now=()=>new Date().toISOString()}={}){
 if(!store?.db||!dataDir)throw Error('文件回传需要本机持久存储与数据目录');
 const db=store.db;
 db.exec('CREATE TABLE IF NOT EXISTS outbound_artifacts(id TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS outbound_transfers(id TEXT PRIMARY KEY,json TEXT NOT NULL);');
 const put=(table,value)=>{db.prepare(`INSERT INTO ${table}(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`).run(value.id,JSON.stringify(value));return value;};
 const get=(table,id)=>{const row=db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id);return row?JSON.parse(row.json):null;};
 const all=table=>db.prepare(`SELECT json FROM ${table}`).all().map(row=>JSON.parse(row.json));
 for(const transfer of all('outbound_transfers'))if(['uploading','sending','preparing'].includes(transfer.status))put('outbound_transfers',{...transfer,parts:transfer.parts?.map(part=>part.status==='sending'?{...part,status:'unknown'}:part),status:transfer.kind==='approval'?'expired':'unknown',updatedAt:now(),message:transfer.kind==='approval'?'上次确认通知随进程退出失效，旧确认码不会恢复':'上次在回传中退出，结果待本人核对；未自动重发'});
 function authorizedRoot(value){
  const settings=getSettings();if(!settings.wechatRemoteEnabled)throw Error('微信遥控已关闭，不能回传项目文件');
  if(typeof value!=='string'||!path.isAbsolute(value))throw Error('产出文件缺少已授权项目目录');
  const root=fs.realpathSync.native(value);
  if(!Array.isArray(settings.allowedProjects)||!settings.allowedProjects.some(item=>{try{return same(fs.realpathSync.native(item),root);}catch{return false;}}))throw Error('文件所属项目已撤回授权');
  if(!fs.statSync(root).isDirectory())throw Error('项目目录不可用');return root;
 }
 function readChecked(file,root,expected){
  if(typeof file!=='string'||!path.isAbsolute(file))throw Error('只支持已登记文件的绝对路径');
  const canonical=fs.realpathSync.native(file);const canonicalRoot=fs.realpathSync.native(root);
  if(!within(canonicalRoot,canonical))throw Error('文件真实位置超出已授权目录');
  const filename=path.basename(canonical);const extension=path.extname(filename).toLowerCase();
  if(!MIME[extension]||/^(?:\.env(?:\.|$)|credentials(?:\.|$)|id_(?:rsa|ed25519)(?:\.|$))/i.test(filename)||/[\x00-\x1f\x7f]/.test(filename))throw Error('该文件类型或名称不允许回传');
  const descriptor=fs.openSync(canonical,'r');let bytes;let stat;
  try{
   stat=fs.fstatSync(descriptor);const current=fs.statSync(canonical);
   if(!same(fs.realpathSync.native(file),canonical)||stat.ino!==current.ino||stat.dev!==current.dev||!stat.isFile())throw Error('文件位置已经改变，请在本机核对');
   if(stat.size<1||stat.size>MAX_FILE_BYTES)throw Error('文件为空或超过本版本 20 MiB 上限');
   bytes=fs.readFileSync(descriptor);
  }finally{fs.closeSync(descriptor);}
  if(bytes.length>MAX_FILE_BYTES||bytes.subarray(0,2).toString('ascii')==='MZ')throw Error('文件大小或内容类型不允许回传');
  if(extension==='.pdf'&&bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw Error('PDF 文件内容与扩展名不符');
  if(['.docx','.xlsx','.pptx','.zip'].includes(extension)&&bytes.subarray(0,2).toString('ascii')!=='PK')throw Error('文档内容与扩展名不符');
  const sha256=hash(bytes);if(expected&&(expected.sha256!==sha256||expected.size!==bytes.length||!same(expected.path,canonical)))throw Error('登记后文件内容或位置已改变，请重新核对产出');
  return {bytes,path:canonical,root:canonicalRoot,filename,size:bytes.length,sha256,mime:MIME[extension]};
 }
 function register({file,root,kind,reportId,threadId,turnId,authorizedProject}){
  const declaredPath=path.resolve(file);const identity=kind==='report'?[kind,reportId]:[kind,threadId,turnId,process.platform==='win32'?declaredPath.toLowerCase():declaredPath];
  const id=hash(Buffer.from(identity.join('\0')));
  const existing=get('outbound_artifacts',id);if(existing)return existing;
  const {bytes,...metadata}=readChecked(file,root);return put('outbound_artifacts',{id,...metadata,declaredPath,kind,reportId,threadId,turnId,authorizedProject,createdAt:now()});
 }
 function registerReport(reportId){
  const report=store.get('reports',reportId);if(!report||!['pdf','docx','html'].includes(report.format))throw Error('只能回传已登记的报告');
  return register({file:report.path,root:path.dirname(report.path),kind:'report',reportId});
 }
 function registerCodexResult({threadId,turnId,text,error,cwd,artifacts=[]}){
  if(typeof threadId!=='string'||!threadId||typeof turnId!=='string'||!turnId)throw Error('产出必须关联明确的受管会话和本轮编号');
  const resultText=String(text||error||'本轮没有文字结果，请在本机核对任务状态');
  if(Buffer.byteLength(resultText)>MAX_RESULT_BYTES)throw Error('完整结果超过本版本 4 MiB 上限，未截断回传');
  const resultDir=path.join(dataDir,'codex-results');fs.mkdirSync(resultDir,{recursive:true});
  const file=path.join(resultDir,`Codex结果_${hash(Buffer.from(threadId+'\0'+turnId)).slice(0,24)}.txt`);
  if(fs.existsSync(file)){if(fs.readFileSync(file,'utf8')!==resultText)throw Error('本轮已有不同结果，请在本机核对');}
  else fs.writeFileSync(file,resultText,{flag:'wx'});
  const authorizedProject=fs.realpathSync.native(cwd);
  const result=register({file,root:resultDir,kind:'codex-result',threadId,turnId,authorizedProject});
  const registered=[];const rejected=[];
  for(const artifact of Array.isArray(artifacts)?artifacts.slice(0,20):[]){try{
   const root=authorizedRoot(cwd);const filePath=typeof artifact==='string'?artifact:artifact?.path;
   registered.push(register({file:path.resolve(root,filePath||''),root,kind:'codex-artifact',threadId,turnId}));
  }catch(error){rejected.push({file:typeof artifact==='string'?artifact:artifact?.path||'',reason:error.message});}}
  if(Array.isArray(artifacts)&&artifacts.length>20)rejected.push({file:'',reason:'本轮明确产出超过20个文件，其余留在本机未自动上传'});
  return {result,artifacts:registered,rejected};
 }
 function activeFor(key){return all('outbound_transfers').find(item=>item.key===key&&['accepted','unknown','uploading','sending','preparing'].includes(item.status));}
 function newTransfer(value){if(activeFor(value.key))throw Error('已有回传记录，请先核对手机结果，避免重复发送');return put('outbound_transfers',{id:randomUUID(),createdAt:now(),updatedAt:now(),readStatus:'unknown',...value});}
 function verifyArtifact(artifact){
  if(!artifact)throw Error('只能回传已登记的报告或本轮明确产出文件');
  if(artifact.kind==='codex-artifact')authorizedRoot(artifact.root);
  if(artifact.kind==='codex-result')authorizedRoot(artifact.authorizedProject);
  return readChecked(artifact.path,artifact.root,artifact);
 }
 async function sendArtifact(id,{requestId=randomUUID()}={}){
  const artifact=get('outbound_artifacts',id);const checked=verifyArtifact(artifact);
  if(all('outbound_transfers').some(item=>item.requestId===requestId))throw Error('这个回传请求已经处理，不能重放');
  let transfer=newTransfer({key:'artifact:'+id,kind:'file',artifactId:id,threadId:artifact.threadId,turnId:artifact.turnId,reportId:artifact.reportId,requestId,filename:artifact.filename,size:artifact.size,sha256:artifact.sha256,status:'uploading',uploadStatus:'not_started',deliveryStatus:'not_sent'});
  const clientId='wb-'+transfer.id;
  let acceptedAtRemote=false;
  try{
   const result=await wechat.sendFile({bytes:checked.bytes,filename:artifact.filename,clientId,onProgress:async progress=>{
    verifyArtifact(artifact);transfer=put('outbound_transfers',{...transfer,status:progress.phase==='sending'?'sending':'uploading',phase:progress.phase,uploadStatus:progress.uploadStatus||transfer.uploadStatus,updatedAt:now()});
   }});
   if(result?.accepted!==true)throw Object.assign(Error('微信未明确确认接收文件'),{deliveryStatus:'unknown',uploadStatus:result?.uploadStatus});
   acceptedAtRemote=true;
   return put('outbound_transfers',{...transfer,status:'accepted',deliveryStatus:'server_accepted',uploadStatus:result.uploadStatus||'server_accepted',uploaded:result.uploaded===true,acceptedAt:now(),updatedAt:now(),message:'文件接口已接受；已读状态未知',receipt:{clientId:result.clientId||clientId,sha256:result.sha256||artifact.sha256}});
  }catch(error){const uncertain=acceptedAtRemote||error.deliveryStatus==='unknown'||(!error.deliveryStatus&&transfer.phase==='sending');
   const failed=put('outbound_transfers',{...transfer,status:uncertain?'unknown':'failed',deliveryStatus:error.deliveryStatus||'not_sent',uploadStatus:error.uploadStatus||transfer.uploadStatus,updatedAt:now(),message:error.message});
   throw Object.assign(Error(error.message),{transfer:failed});
  }
 }
 async function continueText(transfer){
  try{for(let i=0;i<transfer.parts.length;i++){
   if(transfer.parts[i].status==='accepted')continue;
   if(transfer.threadId)authorizedRoot(transfer.cwd);
   transfer.parts[i].status='sending';transfer.status='sending';transfer.updatedAt=now();put('outbound_transfers',transfer);
   const body=transfer.parts.length>1?`[${i+1}/${transfer.parts.length}]\n${transfer.parts[i].text}`:transfer.parts[i].text;
   const response=await wechat.sendText({text:body,clientId:transfer.parts[i].clientId});
   if(response?.accepted!==true)throw Error('微信未明确确认接收文字');
   transfer.parts[i].status='accepted';transfer.parts[i].acceptedAt=now();put('outbound_transfers',transfer);
  }
  transfer.status='accepted';transfer.acceptedAt=now();transfer.updatedAt=now();transfer.message='完整文字接口已逐段接受；已读状态未知';return put('outbound_transfers',transfer);
  }catch(error){const uncertain=transfer.parts.some(part=>part.status==='sending');for(const part of transfer.parts)if(part.status==='sending')part.status='unknown';transfer.status=uncertain?'unknown':'failed';transfer.message=error.message;transfer.updatedAt=now();put('outbound_transfers',transfer);throw Object.assign(Error('文字结果回传中断，请核对已收到的分段：'+error.message),{transfer});}
 }
 async function sendText(text,{key,threadId,turnId,cwd,requestId=randomUUID(),kind='text'}={}){
  if(typeof key!=='string'||!key)throw Error('完整回传需要唯一的业务编号');
  if(all('outbound_transfers').some(item=>item.requestId===requestId))throw Error('这个回传请求已经处理，不能重放');
  if(threadId)authorizedRoot(cwd);
  const id=randomUUID();const parts=splitText(text).map((part,index)=>({text:part,sha256:hash(Buffer.from(part)),status:'pending',clientId:`wb-${id}-${index+1}`}));
  return continueText(newTransfer({id,key,kind,requestId,threadId,turnId,cwd,status:'preparing',parts,sha256:hash(Buffer.from(text)),size:Buffer.byteLength(text)}));
 }
 function resolve(id,decision){
  const transfer=get('outbound_transfers',id);if(!transfer||transfer.status!=='unknown'||decision!=='not_received')throw Error('请先在本机核对这一次待确认回传');
  if(transfer.kind==='approval')throw Error('旧操作确认通知不能重发，请在本机核对当前任务');
  const parts=transfer.parts?.map(part=>part.status==='unknown'?{...part,status:'confirmed_not_received'}:part);
  return put('outbound_transfers',{...transfer,parts,status:'confirmed_not_received',updatedAt:now(),history:[...(transfer.history||[]),{at:now(),decision,previousStatus:transfer.status}],message:'本人已核对不明分段或文件未收到；仍需手动重试'});
 }
 async function retry(id){
  const transfer=get('outbound_transfers',id);if(!transfer||!['confirmed_not_received','failed'].includes(transfer.status))throw Error('请先核对回传结果，再选择手动重试');
  if(transfer.kind==='approval')throw Error('旧操作确认通知不能重发，请在本机核对当前任务');
  if(transfer.kind==='file')return sendArtifact(transfer.artifactId);
  if(transfer.threadId&&!getSettings().wechatRemoteEnabled)throw Error('微信遥控已关闭，不能重试结果回传');
  const earlier=all('outbound_transfers').find(item=>item.id!==id&&item.key===transfer.key&&['accepted','unknown','sending','preparing'].includes(item.status));if(earlier)throw Error('已有同一结果的其他回传记录，请先核对');
  for(const part of transfer.parts)if(part.status!=='accepted'){part.attempts=[...(part.attempts||[]),{clientId:part.clientId,status:part.status,at:now()}];part.clientId='wb-'+randomUUID();part.status='pending';}
  transfer.status='preparing';transfer.updatedAt=now();put('outbound_transfers',transfer);return continueText(transfer);
 }
 function list(){return {artifacts:all('outbound_artifacts').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,200),transfers:all('outbound_transfers').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,200).map(({parts,...item})=>({...item,parts:parts?.map(({text,...part})=>({...part,characters:text.length}))}))};}
 return {registerReport,registerCodexResult,sendArtifact,sendText,resolve,retry,list,getArtifact:id=>get('outbound_artifacts',id)};
}
module.exports={createOutbound,splitText,MAX_FILE_BYTES};
