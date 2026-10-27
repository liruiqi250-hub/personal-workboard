'use strict';
const {randomUUID}=require('node:crypto');
const countKeys=['received','created','updated','duplicates','ignored','filtered'];
const copy=value=>value?JSON.parse(JSON.stringify(value)):null;
function sourceReady(source,vault){
 if(!source.enabled)return '来源未启用';
 if(!Array.isArray(source.scope)||!source.scope.length)return '请先保存指定读取范围';
 const config=source.config||{};
 if(config.collector?.kind&&config.collector.authorized!==true)return '请本人完成工具登录并明确授权所选账号与范围';
 if(source.platform==='email')return config.host&&config.user&&config.secure!==false&&vault.has('source:'+source.id)?'':'请先保存邮箱 IMAP、授权码与单一文件夹，并检测连接';
 if(config.collector?.kind==='wechat-export')return vault.has('source-wechat:'+source.id)?'':'本人微信来源的离线凭据尚未配置';
 if(config.collector?.kind==='dingtalk-dws')return config.collector.executable&&config.collector.profile?'':'请先准备钉钉工具、本人组织身份和授权会话范围';
 return config.importPath?'':'请先配置并检测消息来源；尚未选择平台采集器或本人导出文件';
}
function createIntake({store,sources,vault,now=()=>new Date().toISOString()}){
 let job=store.getSetting('intakeJob',null),activeId=null,runningSource=null;
 const save=()=>store.setSetting('intakeJob',copy(job));
 if(job&&['running','cancelling'].includes(job.status)){job={...job,status:'interrupted',finishedAt:now(),message:'上次服务在整理期间停止，已入库消息保留；请核对来源结果后本人重试。',results:(job.results||[]).map(row=>['pending','running'].includes(row.status)?{...row,status:'skipped',message:'服务中断，本项完整结果尚未确认'}:row)};save();}
 async function execute(id){
  try{
   for(const row of job.results){
    if(job.id!==id)break;
    if(job.status==='cancelling'){if(row.status==='pending'){row.status='skipped';row.message='本轮已取消，尚未读取此来源';save();}continue;}
    const source=store.get('sources',row.sourceId),reason=source?sourceReady(source,vault):'来源已删除';
    if(reason){row.status='skipped';row.message=reason;save();continue;}
    runningSource=source.id;row.status='running';save();
    try{
     const result=await sources.sync(source.id);
     if(result?.skipped){row.status='skipped';row.message='该来源正在其它整理中，本轮没有重复提交';}
     else{row.status=result?.complete===false?'failed':'success';row.counts=Object.fromEntries(countKeys.map(key=>[key,Number.isSafeInteger(result?.[key])&&result[key]>=0?result[key]:0]));row.message=result?.complete===false?'仅取得部分消息，完整结果待核对，检查点未前移':'本轮整理完成，请核对任务依据';}
    }catch(error){row.status='failed';row.message=job.status==='cancelling'?'本来源整理已请求取消，已入库消息保留':('本来源整理未完成，已入库记录保留，请核对任务依据：'+String(error?.message||'请检查来源连接')).slice(0,400);}
    finally{runningSource=null;save();}
   }
   job.status=job.status==='cancelling'?'cancelled':'completed';job.finishedAt=now();save();
  }finally{if(activeId===id)activeId=null;}
 }
 function start(){
  if(activeId)return copy(job);
  const enabled=store.all('sources').filter(source=>source.enabled);
  job={id:randomUUID(),status:enabled.length?'running':'completed',startedAt:now(),finishedAt:enabled.length?null:now(),message:enabled.length?'仅整理已启用、保存范围与授权配置的来源，不会发送日报或微信。':'尚无已启用来源，请先配置邮箱、钉钉或本人导出记录。',results:enabled.map(source=>({sourceId:source.id,name:source.name,platform:source.platform,status:'pending',counts:Object.fromEntries(countKeys.map(k=>[k,0])),message:''}))};save();
  if(enabled.length){activeId=job.id;const id=activeId;queueMicrotask(()=>execute(id).catch(()=>{if(job.id===id){job.status='interrupted';job.finishedAt=now();job.message='本轮完整结果未确认，请核对后手动重试';save();}activeId=null;}));}
  return copy(job);
 }
 function cancel(){if(activeId){job.status='cancelling';job.message='已请求取消本轮，已入库消息保留';if(runningSource)sources.cancel(runningSource);save();}return copy(job);}
 return {start,status:()=>copy(job),cancel,stop:cancel};
}
module.exports={createIntake,sourceReady};
