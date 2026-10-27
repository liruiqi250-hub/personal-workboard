'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {createIntake}=require('../server/intake.cjs');
function fixture(list,sync){const values=new Map(),calls=[],cancelled=[];return {calls,cancelled,values,create:()=>createIntake({store:{all:()=>list,get:(table,id)=>list.find(x=>x.id===id),getSetting:(key,fallback)=>values.get(key)||fallback,setSetting:(key,value)=>values.set(key,value)},vault:{has:()=>true},sources:{sync:async id=>{calls.push(id);return sync(id);},cancel:id=>cancelled.push(id)}})};}
const source=id=>({id,name:'合成来源'+id,platform:'manual',enabled:true,scope:['唯一会话'],config:{importPath:'synthetic-record.json'}});
const wait=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
test('立即整理只处理已启用且范围配置完整的来源，逐项失败不影响下一项',async()=>{
 const f=fixture([{...source('off'),enabled:false},{...source('scope'),scope:[]},source('bad'),source('good')],async id=>{if(id==='bad')throw Error('合成工具缺失');return {created:2,updated:1,duplicates:3,received:6};});const job=f.create();job.start();await wait();const state=job.status();assert.equal(state.status,'completed');assert.deepEqual(f.calls,['bad','good']);assert.equal(state.results.find(x=>x.sourceId==='scope').status,'skipped');assert.equal(state.results.find(x=>x.sourceId==='bad').status,'failed');assert.equal(state.results.find(x=>x.sourceId==='good').counts.duplicates,3);
});
test('重复点击复用同一在途任务，不重入也不自动排下一轮',async()=>{
 let finish;const f=fixture([source('one')],()=>new Promise(resolve=>{finish=resolve;}));const job=f.create(),first=job.start();await Promise.resolve();assert.equal(job.start().id,first.id);assert.equal(f.calls.length,1);finish({created:1});await wait();assert.equal(job.status().status,'completed');assert.equal(f.calls.length,1);
});
test('取消沿用来源Abort入口并跳过后续来源，不发送其它消息或报告',async()=>{
 let finish;const f=fixture([source('one'),source('two')],()=>new Promise(resolve=>{finish=resolve;}));const job=f.create();job.start();await Promise.resolve();job.cancel();assert.deepEqual(f.cancelled,['one']);finish({created:1});await wait();assert.equal(job.status().status,'cancelled');assert.deepEqual(f.calls,['one']);assert.equal(job.status().results[1].status,'skipped');
});
test('空来源和重启中断都保留明确状态，绝不自动重新采集',async()=>{
 const empty=fixture([],async()=>{}).create();assert.equal(empty.start().status,'completed');assert.match(empty.status().message,/尚无/);
 const f=fixture([source('one')],async()=>{});f.values.set('intakeJob',{id:'synthetic',status:'running',results:[{sourceId:'one',status:'running'}]});const restored=f.create();assert.equal(restored.status().status,'interrupted');await wait();assert.equal(f.calls.length,0);
});

test('平台采集未明确授权时即使已启用也不启动来源读取',async()=>{
 const f=fixture([{...source('not-authorized'),platform:'dingtalk',config:{collector:{kind:'dingtalk-dws',authorized:false,executable:'synthetic-missing.exe',profile:'synthetic:synthetic'}}}],async()=>{throw Error('must not collect');});const job=f.create();job.start();await wait();assert.equal(f.calls.length,0);assert.equal(job.status().results[0].status,'skipped');assert.match(job.status().results[0].message,/本人.*授权/);
});
