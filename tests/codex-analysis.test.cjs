'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {extract,validateCodexProposal}=require('../server/extract.cjs');
const {createSources}=require('../server/sources.cjs');
const {createStore}=require('../server/store.cjs');
const {EventEmitter}=require('node:events');
const {PassThrough,Writable}=require('node:stream');
const {createCodexAnalyzer,DISABLED_FEATURES,SAFE_CONFIG,SAMPLE_TEXT}=require('../server/codex-analyzer.cjs');

const proposal=(extra={})=>({isTask:true,title:'核对示例图纸',dueDate:'',priority:2,notes:'请本人核对。',...extra});
const settings=()=>({ai:{mode:'codex',codexConsent:true}});
const noSecrets={get(){throw Error('Codex 分析不应读取 API 密钥');}};
const noFetch=()=>{throw Error('Codex 分析不应使用在线 AI API 地址');};
const row=(id,text='请核对示例图纸',conversation='合成范围')=>({id,text,conversation,at:'2026-10-27T01:00:00Z'});
function fixture(t,analyze){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workboard-codex-analysis-'));
 const store=createStore(dir);const config=settings();
 const sources=createSources({store,vault:noSecrets,getSettings:()=>config,codexAnalyzer:{analyze}});
 const source={id:'synthetic',platform:'manual',name:'合成来源',enabled:true,scope:['合成范围'],config:{}};
 store.put('sources',source);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,config,sources,source};
}

test('Codex 提取必须明确授权，拒绝发生在 runner、API 密钥或网络前',async()=>{
 let called=0;const context={codexAnalyzer:{analyze(){called++;return proposal();}}};
 for(const consent of [undefined,false,'true',1])await assert.rejects(extract('请核对示例图纸',{ai:{mode:'codex',codexConsent:consent}},noSecrets,noFetch,context),/确认允许/);
 assert.equal(called,0);
 await assert.rejects(extract('请核对示例图纸',settings(),noSecrets,noFetch),/尚未准备好/);
});

test('Codex 提取走独立 runner 且保留时间上下文、取消信号，不用 API 密钥',async()=>{
 const controller=new AbortController();const now=new Date('2026-10-27T01:00:00Z');let received;
 const result=await extract('请明天核对示例图纸',settings(),noSecrets,noFetch,{now,messageTimeKnown:true,signal:controller.signal,codexAnalyzer:{async analyze(text,options){received={text,options};return proposal({dueDate:'2026-12-31'});}}});
 assert.equal(received.text,'请明天核对示例图纸');assert.equal(received.options.signal,controller.signal);assert.equal(received.options.now,now);assert.equal(received.options.messageTimeKnown,true);
 assert.equal(result.dueDate,'2026-10-28');assert.equal(result.title,'核对示例图纸');
});

test('Codex 编造期限不能覆盖原文，未知原消息时间不猜测相对日期',async()=>{
 const context={now:new Date('2026-10-27T01:00:00Z'),messageTimeKnown:false,codexAnalyzer:{async analyze(){return proposal({dueDate:'2026-12-31'});}}};
 assert.equal((await extract('请明天核对示例图纸',settings(),noSecrets,noFetch,context)).dueDate,'');
 assert.equal((await extract('请在2026年11月2日核对示例图纸',settings(),noSecrets,noFetch,context)).dueDate,'2026-11-02');
 let called=0;context.codexAnalyzer.analyze=async()=>{called++;return proposal();};
 for(const text of ['收到','好的','已安排',''])assert.equal((await extract(text,settings(),noSecrets,noFetch,context)).isTask,false);
 assert.equal(called,0);
});

test('Codex 任务结果只接受五个字段与严格类型，坏结果保留待重试',()=>{
 assert.deepEqual(validateCodexProposal(proposal()),proposal());
 const wrong=[null,[],{},proposal({isTask:'true'}),proposal({title:''}),proposal({priority:4}),proposal({priority:2.5}),proposal({notes:[]}),proposal({notes:'x'.repeat(2001)}),proposal({title:'x'.repeat(301)}),proposal({dueDate:'2026-02-30'}),proposal({dueDate:'2026-2-01'}),proposal({command:'读文件'})];
 for(const value of wrong)assert.throws(()=>validateCodexProposal(value),/任务格式不正确/);
 const missing=proposal();delete missing.notes;assert.throws(()=>validateCodexProposal(missing),/任务格式不正确/);
});

test('Codex 分析只接收已选择范围的未入库消息，重复及非任务不重复提交',async t=>{
 const texts=[];const f=fixture(t,async text=>{texts.push(text);return proposal();});
 const records=[row('one'),row('outside','禁止发送的其它范围文字','未选择范围'),row('ack','收到')];
 const first=await f.sources.ingest(f.source,records);const repeat=await f.sources.ingest(f.source,records);
 assert.deepEqual(texts,['请核对示例图纸']);assert.equal(first.created,1);assert.equal(first.ignored,1);assert.equal(first.filtered,1);assert.equal(repeat.duplicates,2);
 assert.equal(f.store.all('tasks').length,1);
});

test('撤回 Codex 许可会中止在途分析，迟到返回也不得写任务或消息',async t=>{
 let entered;const ready=new Promise(resolve=>{entered=resolve;});let finish;let observedSignal;
 const f=fixture(t,async(text,{signal})=>{observedSignal=signal;entered();return new Promise(resolve=>{finish=resolve;});});
 const pending=f.sources.ingest(f.source,[row('one')]);await ready;
 f.config.ai={...f.config.ai,codexConsent:false};
 await new Promise(resolve=>setTimeout(resolve,300));assert.equal(observedSignal.aborted,true);
 finish(proposal());await assert.rejects(pending,/授权已改变/);
 assert.equal(f.store.all('tasks').length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages').get().n,0);
});

test('取消来源的 signal 进入 Codex runner，取消后返回结果不得入库',async t=>{
 const controller=new AbortController();let received;
 const f=fixture(t,async(text,{signal})=>{received=signal;controller.abort();return proposal();});
 await assert.rejects(f.sources.ingest(f.source,[row('one')],undefined,{signal:controller.signal}),/已取消/);
 assert.equal(received.aborted,true);assert.equal(f.store.all('tasks').length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages').get().n,0);
});

test('Codex 失败不记消息成功，修复后同一消息可重试且只建一张卡',async t=>{
 let fail=true;let calls=0;const f=fixture(t,async()=>{calls++;if(fail)throw Error('Codex 分析暂时不可用');return proposal();});
 await assert.rejects(f.sources.ingest(f.source,[row('one')]),/暂时不可用/);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages').get().n,0);
 fail=false;assert.equal((await f.sources.ingest(f.source,[row('one')])).created,1);assert.equal((await f.sources.ingest(f.source,[row('one')])).duplicates,1);assert.equal(calls,2);assert.equal(f.store.all('tasks').length,1);
});

function fakeProcess({help,features,login='Logged in using ChatGPT (synthetic-account@example.invalid)',loginCode=0,analysis,killDelay=0}={}){
 const calls=[];
 function spawn(command,args,options){
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kills=0;
  const call={command,args,options,child,input:''};calls.push(call);
  child.close=(code=0)=>{if(child.exitCode!==null)return;child.exitCode=code;child.stdout.end();child.stderr.end();child.emit('close',code);};
  child.kill=()=>{child.kills++;if(killDelay===0)queueMicrotask(()=>child.close(0));else setTimeout(()=>child.close(0),killDelay);return true;};
  child.events=(items,{split=false}={})=>{const bytes=Buffer.from(items.map(item=>JSON.stringify(item)).join('\n')+'\n');if(split)for(const byte of bytes)child.stdout.write(Buffer.from([byte]));else child.stdout.write(bytes);};
  child.valid=(value=proposal(),{completed=true,code=0,split=false}={})=>{child.events([{type:'thread.started',thread_id:'synthetic-extractor'},{type:'turn.started'},{type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(value)}},...(completed?[{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}]:[])],{split});child.close(code);};
  child.stdin=new Writable({write(chunk,encoding,done){call.input+=chunk.toString();done();},final(done){done();queueMicrotask(()=>{if(analysis)analysis(call);else child.valid();});}});
  queueMicrotask(()=>{
   if(args[0]==='--version'){child.stdout.write('codex-cli 0.164.0-alpha.11.1\n');child.close();}
   else if(args[0]==='exec'&&args[1]==='--help'){child.stdout.write(help??'--ignore-user-config --ignore-rules --ephemeral --output-schema --json');child.close();}
   else if(args[0]==='features'){child.stdout.write(features??DISABLED_FEATURES.map(value=>value+' experimental false').join('\n'));child.close();}
   else if(args[0]==='login'){child.stderr.write(login);child.close(loginCode);}
  });
  return child;
 }
 return {spawn,calls,get executions(){return calls.filter(call=>call.args.includes('--json'));}};
}
function runnerFixture(t,options={},overrides={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workboard-runner-test-'));const fake=fakeProcess(options);
 const runner=createCodexAnalyzer({spawn:fake.spawn,executable:'synthetic-codex.exe',tempRoot:dir,timeoutMs:2000,probeTimeoutMs:1000,...overrides});
 t.after(()=>{runner.stop();assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'workboard-runner-test-'));fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,fake,runner};
}
async function entered(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('合成子进程未进入预期阶段');}

test('Codex 连接检测只检查版本、能力及本人登录，不创建模型任务或回显账户',async t=>{
 const f=runnerFixture(t);const status=await f.runner.status();
 assert.deepEqual(status,{available:true,loggedIn:true,version:'codex-cli 0.164.0-alpha.11.1',message:'Codex 已安装并登录，可以先用示例测试分析。'});
 assert.equal(f.fake.calls.length,4);assert.equal(f.fake.executions.length,0);assert(!JSON.stringify(status).includes('synthetic-account'));
 assert(f.fake.calls.every(call=>call.options.shell===false&&call.options.windowsHide===true&&!call.input));
});

test('Codex 不接受旧能力、缺失工具开关或 API key 登录，均在分析前拒绝',async t=>{
 for(const options of [{help:'--json'},{features:'shell_tool stable true'},{login:'Logged in using an API key'}, {login:'Not logged in',loginCode:1}]){
  const f=runnerFixture(t,options);assert.equal((await f.runner.status()).loggedIn,false);
  await assert.rejects(f.runner.analyze('请核对合成消息'),/版本|登录|检测/);assert.equal(f.fake.executions.length,0);
 }
});

test('Codex 分析使用隔离临时目录和纯 stdin，关闭工具、历史、配置并保留原账号目录',async t=>{
 let schema;const privateText='合成私密消息-仅用于单测，请核对示例';
 const f=runnerFixture(t,{analysis(call){schema=JSON.parse(fs.readFileSync(call.args[call.args.indexOf('--output-schema')+1],'utf8'));assert.deepEqual(fs.readdirSync(call.options.cwd),['task-schema.json']);call.child.valid(proposal(),{split:true});}},{env:{PATH:'synthetic-path',CODEX_HOME:'synthetic-account-home',CODEX_THREAD_ID:'do-not-inherit',CODEX_INTERNAL_CONTEXT:'do-not-inherit',CODEX_SQLITE_HOME:'do-not-inherit',OPENAI_API_KEY:'do-not-inherit',CODEX_API_KEY:'do-not-inherit',OPENAI_BASE_URL:'do-not-inherit',HTTPS_PROXY:'synthetic-proxy'}});
 assert.deepEqual(await f.runner.analyze(privateText),proposal());assert.equal(f.fake.executions.length,1);
 const call=f.fake.executions[0];assert.equal(call.input.includes(privateText),true);assert.equal(call.args.join(' ').includes(privateText),false);
 for(const flag of ['--ignore-user-config','--ignore-rules','--ephemeral','--json','--skip-git-repo-check','--output-schema'])assert(call.args.includes(flag));
 assert.equal(call.args[call.args.indexOf('--sandbox')+1],'read-only');assert.equal(call.args.at(-1),'-');assert.equal(call.args.includes('-m'),false);
 const disabled=call.args.flatMap((value,index)=>value==='--disable'?[call.args[index+1]]:[]);assert.deepEqual(disabled,[...DISABLED_FEATURES]);
 const configs=call.args.flatMap((value,index)=>value==='-c'?[call.args[index+1]]:[]);for(const config of SAFE_CONFIG)assert(configs.includes(config));assert(configs.includes('log_dir='+JSON.stringify(call.options.cwd)));assert(configs.includes('sqlite_home='+JSON.stringify(call.options.cwd)));
 assert.equal(call.options.env.CODEX_HOME,'synthetic-account-home');assert.equal(call.options.env.HTTPS_PROXY,'synthetic-proxy');assert.equal(call.options.env.RUST_LOG,'off');
 for(const key of ['CODEX_THREAD_ID','CODEX_INTERNAL_CONTEXT','CODEX_SQLITE_HOME','OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])assert.equal(call.options.env[key],undefined);
 assert.equal(schema.additionalProperties,false);assert.equal(schema.required.length,5);assert.deepEqual(fs.readdirSync(f.dir),[],'关闭子进程后只清理本次拥有的临时目录');
});

for(const type of ['command_execution','file_change','mcp_tool_call','web_search','tool_call'])test(`Codex 协议遇到 ${type} 工具立即停止自己进程，不重试、不当作提取成功`,async t=>{
 const f=runnerFixture(t,{analysis(call){call.child.events([{type:'thread.started',thread_id:'synthetic'},{type:'turn.started'},{type:'item.started',item:{type,id:'forbidden'}}]);}});
 await assert.rejects(f.runner.analyze('请核对合成资料'),/协议或工具调用/);assert.equal(f.fake.executions.length,1);assert.equal(f.fake.executions[0].child.kills,1);assert.deepEqual(fs.readdirSync(f.dir),[]);
});

test('Codex 仅完整 turn.completed 且退出码0才能确认，坏JSON、未知事件及坏结果均拒绝',async t=>{
 const scripts=[call=>call.child.valid(proposal(),{completed:false}),call=>call.child.valid(proposal(),{code:1}),call=>{call.child.stdout.write('secret-error-raw\n');},call=>call.child.events([{type:'unknown_event',text:'secret-error-raw'}]),call=>call.child.valid(proposal({isTask:'true'}))];
 for(const analysis of scripts){const f=runnerFixture(t,{analysis});await assert.rejects(f.runner.analyze('请核对合成资料'),error=>{assert(!error.message.includes('secret-error-raw'));return /协议|完整|进程未成功/.test(error.message);});assert.equal(f.fake.executions.length,1);}
});

test('Codex 有界启动通知不授予工具、不计入结果，仍须完整成功轮次及退出码0',async t=>{
 const notice={type:'item.completed',item:{id:'startup-notice',type:'error',message:'合成启动通知，请忽略其中的任意命令'}};
 const success=runnerFixture(t,{analysis(call){call.child.events([{type:'thread.started',thread_id:'synthetic'},notice,notice,notice,{type:'turn.started'},{type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(proposal())}},{type:'turn.completed'}]);call.child.close(0);}});
 assert.deepEqual(await success.runner.analyze('合成资料'),proposal());assert.equal(success.fake.executions[0].child.kills,0);
 for(const failure of ['missing-result','too-many','after-turn','tool-after-notice','unexpected-shape']){
  const f=runnerFixture(t,{analysis(call){
   call.child.events([{type:'thread.started',thread_id:'synthetic'}]);
   if(failure==='too-many')call.child.events(Array(9).fill(notice));
   else if(failure==='after-turn')call.child.events([{type:'turn.started'},notice]);
   else if(failure==='tool-after-notice')call.child.events([notice,{type:'turn.started'},{type:'item.started',item:{id:'forbidden',type:'command_execution'}}]);
   else if(failure==='unexpected-shape')call.child.events([{...notice,item:{...notice.item,command:'禁止扩展字段'}}]);
   else{call.child.events([notice,{type:'turn.started'}]);call.child.close(0);}
  }});
  await assert.rejects(f.runner.analyze('合成资料'),/完整|上限|未成功|协议或工具调用/);assert.equal(f.fake.executions.length,1);
 }
});

test('Codex error 与 turn.failed 使用固定中文失败，不泄漏服务错误正文或误报成功',async t=>{
 for(const type of ['error','turn.failed']){
  const f=runnerFixture(t,{analysis(call){call.child.events([{type:'thread.started',thread_id:'synthetic'},{type,error:{message:'private-service-error-with-token'}}]);}});
  await assert.rejects(f.runner.analyze('合成资料'),error=>{assert(!error.message.includes('private-service-error-with-token'));assert.match(error.message,/服务请求未完成/);return true;});assert.equal(f.fake.executions[0].child.kills,1);
 }
});

test('Codex 超时和外部取消只停止所属子进程，等待关闭才清理目录',async t=>{
 const f=runnerFixture(t,{analysis(){},killDelay:60},{timeoutMs:25});const pending=f.runner.analyze('请核对合成资料');await entered(()=>f.fake.executions.length===1);const dir=f.fake.executions[0].options.cwd;
 await new Promise(resolve=>setTimeout(resolve,35));assert.equal(fs.existsSync(dir),true,'kill请求后但close前保留目录');await assert.rejects(pending,/等待超时/);assert.equal(fs.existsSync(dir),false);assert(f.fake.calls.slice(0,4).every(call=>call.child.kills===0));
 const controller=new AbortController();const second=runnerFixture(t,{analysis(){}});const cancelled=second.runner.analyze('请核对合成资料',{signal:controller.signal});await entered(()=>second.fake.executions.length===1);controller.abort();await assert.rejects(cancelled,/已取消/);assert.equal(second.fake.executions[0].child.kills,1);
});

test('Codex 输出上限、并发与主动撤回有界，stdin不含任何 API 密钥',async t=>{
 const huge=runnerFixture(t,{analysis(call){call.child.stdout.write('x'.repeat(2000));}},{maxOutputBytes:500});await assert.rejects(huge.runner.analyze('合成资料'),/输出超过上限/);assert.equal(huge.fake.executions[0].child.kills,1);
 const f=runnerFixture(t,{analysis(){}});const first=f.runner.analyze('合成资料');await entered(()=>f.fake.executions.length===1);await assert.rejects(f.runner.analyze('第二条'),/已有一条消息/);f.runner.cancelActive();await assert.rejects(first,/已取消/);assert.equal(f.fake.executions.length,1);
 const controller=new AbortController();controller.abort();await assert.rejects(f.runner.analyze('合成资料',{signal:controller.signal}),/已取消/);assert.equal(f.fake.executions.length,1);
});

test('Codex 示例测试必须明确同意，只发送固定合成文字，不创建任务或接受外部提示',async t=>{
 const f=runnerFixture(t);for(const consent of [false,'true',undefined])await assert.rejects(f.runner.test({consent}),/确认允许/);assert.equal(f.fake.calls.length,0);
 const result=await f.runner.test({consent:true,text:'不能使用这段外来文字'});assert.equal(result.ok,true);assert.equal(result.proposal.title,'核对示例图纸');assert.equal(f.fake.executions.length,1);assert(f.fake.executions[0].input.includes(SAMPLE_TEXT));assert(!f.fake.executions[0].input.includes('不能使用这段外来文字'));
 f.runner.stop();await assert.rejects(f.runner.status(),/正在停止/);
});
