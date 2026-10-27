'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const vm=require('node:vm');const crypto=require('node:crypto');const {createRequire}=require('node:module');
const mainFile=path.resolve(__dirname,'../server/main.cjs');const baseRequire=createRequire(mainFile);
function fixture(t,extraEnv={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workboard-main-remote-'));const data=path.join(dir,'data');const project=path.join(dir,'project');fs.mkdirSync(data);fs.mkdirSync(project);const calls=[];let options;let persistence;let analysisCancels=0;const credential=new Map();
 const adapter={result:null,async status(){return {available:false,status:'offline-test'};},listThreads(){return [{id:'t-1',cwd:project,status:'completed'}];},getLastThreadId(){return persistence.load()?.lastThreadId||null;},getResult(id){return id==='t-1'?adapter.result:null;},async run({requestId}){persistence.save({lastThreadId:'t-1',requestId});return {threadId:'t-1'};},async resume(input){calls.push({type:'resume',input});return {threadId:input.threadId};},async interrupt(input){calls.push({type:'interrupt',input});return {interrupted:true};},stop(){}};
 const wechat={status:()=>({status:'connected',controllerBound:true}),stop(){},async sendText(p){calls.push({type:'text',...p});return {accepted:true,clientId:p.clientId};},async sendFile(p){calls.push({type:'file',...p});for(const phase of ['uploading','uploaded','sending'])await p.onProgress?.({phase,uploadStatus:phase==='uploading'?'not_started':'server_accepted'});return {accepted:true,uploaded:true,uploadStatus:'server_accepted',clientId:p.clientId};}};
 let app;
 function load(){
  const module={exports:{}};const mocked=name=>{
   if(name==='./codex-analyzer.cjs')return {createCodexAnalyzer:()=>({async status(){calls.push({type:'analysis-status'});return {available:true,loggedIn:true,version:'codex-cli synthetic',message:'合成登录态'};},async test({consent}){if(consent!==true)throw Error('请先确认示例分析授权');calls.push({type:'analysis-test'});return {ok:true,proposal:{isTask:true,title:'合成示例',dueDate:'',priority:2,notes:'示例'},message:'固定合成示例完成'};},cancelActive(){analysisCancels++;},stop(){}})};
   if(name==='../server/codex.cjs')return {CodexController:function(value){options=value;persistence=value.persistence;return adapter;}};
   if(name==='../server/wechat.cjs')return {WechatClient:function(){return wechat;}};
   if(name==='./vault.cjs')return {createVault:()=>({has:k=>credential.has(k),get:async k=>credential.get(k),set:async(k,v)=>credential.set(k,v),delete:async k=>credential.delete(k)})};
   return baseRequire(name);
  };mocked.main=null;
  const fakeProcess={env:{...process.env,BOARD_DATA_DIR:data,BOARD_PORT:'1',...extraEnv},platform:process.platform,pid:process.pid,on(){},exit(){throw Error('测试不允许退出宿主');}};
  const context=vm.createContext({console,Buffer,URL,fetch,AbortSignal,setTimeout,clearTimeout,setInterval,clearInterval});
  new vm.Script('(function(require,module,exports,__filename,__dirname,process){\n'+fs.readFileSync(mainFile,'utf8')+'\n})',{filename:mainFile}).runInContext(context)(mocked,module,module.exports,mainFile,path.dirname(mainFile),fakeProcess);
  app=module.exports;
 }
 load();t.after(()=>app.store.close());
 return {dir,data,project,calls,adapter,credential,get app(){return app;},get options(){return options;},get analysisCancels(){return analysisCancels;},async configure(){await app.api('settings.save',{wechatRemoteEnabled:true,allowedProjects:[project],reportDir:path.join(dir,'reports')});},reopen(){app.store.close();load();}};
}

test('过期会话在读取业务前明确拒绝且health无缓存，更新令牌后只保存一张合成任务',async t=>{
 const f=fixture(t);const server=f.app.server;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;
 const request=(route,options={})=>new Promise((resolve,reject)=>{
  const req=require('node:http').request(base+route,{agent:false,method:options.method||'GET',headers:{Host:'127.0.0.1:1',Connection:'close',...options.headers}},res=>{const parts=[];res.on('data',chunk=>parts.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:{get:name=>res.headers[name]},json:async()=>JSON.parse(Buffer.concat(parts).toString('utf8'))}));});req.on('error',reject);req.end(options.body);
 });
 const health=await request('/health');assert.equal(health.status,200);assert.equal(health.headers.get('cache-control'),'no-store');assert.equal((await health.json()).version,require('../package.json').version);
 const invalid=await request('/api/call',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':'expired'},body:JSON.stringify({method:'task.create',payload:{title:'合成重启前草稿'}})});
 assert.equal(invalid.status,403);assert.equal((await invalid.json()).errorCode,'SESSION_EXPIRED');assert.equal(f.app.store.all('tasks').length,0);
 const session=await request('/api/session');assert.equal(session.headers.get('cache-control'),'no-store');const token=(await session.json()).token;
 const saved=await request('/api/call',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':token},body:JSON.stringify({method:'task.create',payload:{title:'合成重启前草稿'}})});
 assert.equal(saved.status,200);assert.equal((await saved.json()).ok,true);assert.equal(f.app.store.all('tasks').length,1);
 const denied=await request('/api/call',{method:'POST',headers:{Origin:'https://example.invalid','X-Board-Token':'expired'},body:'{}'});assert.equal(denied.status,403);assert.equal((await denied.json()).errorCode,undefined);
});
test('主路由从持久最近受管会话停止和明确续接，不依赖进程变量',async t=>{const f=fixture(t);await f.configure();await f.app.routeWechat('/codex 合成任务','request-1');f.reopen();await f.app.routeWechat('/停止','stop-1');await f.app.routeWechat('/继续 最近 补充要求','resume-1');assert.equal(f.calls.find(c=>c.type==='interrupt').input.threadId,'t-1');assert.equal(f.calls.find(c=>c.type==='resume').input.threadId,'t-1');});
test('主程序完成回调保存完整长文并通过登记文件链路回传',async t=>{const f=fixture(t);await f.configure();fs.writeFileSync(path.join(f.project,'产出.txt'),'本轮合成文件');const text='完整工作结果😀'.repeat(1700);f.adapter.result={threadId:'t-1',turnId:'turn-1',cwd:f.project,status:'completed',text,artifacts:[{path:'产出.txt',kind:'add',source:'fileChange',status:'completed'}]};await f.options.onOutput({type:'completed',threadId:'t-1',turnId:'turn-1'});assert.equal(f.app.store.getSetting('lastCodexResult').text,text);const sent=f.calls.filter(c=>c.type==='text');assert(sent.length>2);assert.equal(sent.map(c=>c.text.replace(/^\[\d+\/\d+\]\n/,'')).join(''),text);const files=f.calls.filter(c=>c.type==='file');assert.equal(files.length,2);assert(files.some(c=>c.bytes.toString()===text));assert(files.some(c=>c.filename==='产出.txt'));assert.equal(f.app.outbound.list().transfers.filter(x=>x.status==='accepted').length,3);});
test('真实报告API重登记不能绕过首次hash',async t=>{const f=fixture(t);await f.configure();const report=await f.app.api('report.export',{format:'html',type:'daily'});fs.appendFileSync(report.path,'篡改');await assert.rejects(f.app.api('report.sendFile',{id:report.id}),/内容或位置已改变/);assert.equal(f.calls.length,0);});
test('修改来源配置清除旧覆盖成功状态和检查点，旧任务保留',async t=>{const f=fixture(t);const s=await f.app.api('source.save',{platform:'email',name:'合成来源',enabled:true,scope:['INBOX'],config:{host:'imap.invalid',user:'old@example.invalid'}});f.app.store.put('sources',{...s,status:'connected',lastSuccessAt:'2026-10-25T00:00:00Z',checkpoint:{uid:10,uidValidity:'same'},coverage:{mode:'imap'}});const task=f.app.store.createTask({title:'保留的原任务',sourceId:s.id});const changed=await f.app.api('source.save',{...s,config:{...s.config,user:'new@example.invalid'}});assert.equal(changed.status,'configured');assert.equal(changed.lastSuccessAt,null);assert.equal(Object.keys(changed.checkpoint).length,0);assert.equal(f.app.store.get('tasks',task.id).title,task.title);});
test('微信离线key仅存独立vault绑定封套，API与SQLite不回显，轮换使旧检查点失效',async t=>{const f=fixture(t);const account=path.join(f.dir,'fake-account');fs.mkdirSync(path.join(account,'db_storage'),{recursive:true});const key='a'.repeat(64);const params={platform:'wechat',name:'离线假账号',enabled:true,scope:['12345@chatroom'],config:{collector:{kind:'wechat-export',authorized:true,accountId:'wxid_test001',dbDir:account,scriptPath:path.join(f.dir,'cli.py'),executable:'fake-python.exe'}},wechatKeys:JSON.stringify({'contact/contact.db':key})};const source=await f.app.api('source.save',params);const sealed=JSON.parse(f.credential.get('source-wechat:'+source.id));assert.equal(sealed.accountId,'wxid_test001');assert.equal(sealed.keys['contact/contact.db'],key);assert(!JSON.stringify(source).includes(key));assert(!f.app.store.db.prepare('SELECT json FROM sources WHERE id=?').get(source.id).json.includes(key));const bootstrap=await f.app.api('bootstrap');assert.equal(bootstrap.sources[0].hasCredential,true);assert(!JSON.stringify(bootstrap).includes(key));f.app.store.put('sources',{...source,status:'connected',checkpoint:{old:'cursor'},lastSuccessAt:'2026-10-25T00:00:00Z'});const changed=await f.app.api('source.save',{...params,id:source.id,wechatKeys:JSON.stringify({'contact/contact.db':'b'.repeat(64)})});assert.notEqual(changed.config.credentialRevision,source.config.credentialRevision);assert.equal(changed.lastSuccessAt,null);assert.equal(Object.keys(changed.checkpoint).length,0);await f.app.api('source.remove',{id:source.id});assert.equal(f.credential.has('source-wechat:'+source.id),false);});
test('main默认可信公钥无需粘贴，设置重启保留显式custom并可切回项目默认',async t=>{const f=fixture(t);const defaults=f.app.settings().updates;assert.equal(defaults.sourceMode,'project-default');assert.equal(defaults.channel,'stable');assert.match(defaults.publicKey,/BEGIN PUBLIC KEY/);const customKey=crypto.generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});await f.app.api('settings.save',{updates:{sourceMode:'custom',owner:'test-owner',repo:'test-workboard',publicKey:customKey,channel:'preview',previewTag:'v0.3.1'}});f.reopen();assert.equal(f.app.settings().updates.owner,'test-owner');assert.equal(f.app.settings().updates.publicKey,customKey);await f.app.api('settings.save',{updates:{sourceMode:'project-default',channel:'stable',previewTag:''}});assert.equal(f.app.settings().updates.keyId,defaults.keyId);assert.equal(f.app.settings().updates.owner,'liruiqi250-hub');});
test('main读取遗留坏custom不崩溃不抹值，更新检查在联网前受控拒绝',async t=>{const f=fixture(t);f.app.store.setSetting('settings',{updates:{owner:'legacy-owner',repo:'legacy-board',publicKey:'legacy-invalid-key'}});f.reopen();const settings=f.app.settings();assert.equal(settings.updates.sourceMode,'custom');assert.equal(settings.updates.publicKey,'legacy-invalid-key');assert(settings.updates.configurationError);const b=await f.app.api('bootstrap');assert.equal(b.settings.updates.publicKey,'legacy-invalid-key');await assert.rejects(f.app.api('update.check'),/自定义更新来源配置无效/);await f.app.api('settings.save',{name:'仍可修改与更新无关的设置'});assert.equal(f.app.settings().updates.publicKey,'legacy-invalid-key');});
test('main只在显式独立数据目录和非默认端口开放预览安装测试',async t=>{const isolatedLocal=fs.mkdtempSync(path.join(os.tmpdir(),'workboard-test-local-'));const f=fixture(t,{LOCALAPPDATA:isolatedLocal,BOARD_PREVIEW_UPDATE_TEST:'1',BOARD_PORT:'18338'});assert.equal(f.app.previewUpdateTest,true);assert.equal((await f.app.api('bootstrap')).update.allowPreviewInstall,true);assert.throws(()=>fixture(t,{LOCALAPPDATA:isolatedLocal,BOARD_PREVIEW_UPDATE_TEST:'1',BOARD_PORT:'18327'}),/独立数据目录和非18327/);const defaultPath=path.join(isolatedLocal,'PersonalWorkboard');assert.throws(()=>fixture(t,{LOCALAPPDATA:isolatedLocal,BOARD_PREVIEW_UPDATE_TEST:'1',BOARD_PORT:'18338',BOARD_DATA_DIR:defaultPath}),/独立数据目录和非18327/);});
test('main预览测试不接受默认数据目录的联接别名',t=>{const base=fs.mkdtempSync(path.join(os.tmpdir(),'workboard-preview-alias-'));const standard=path.join(base,'PersonalWorkboard');fs.mkdirSync(standard);const alias=path.join(base,'alias');try{fs.symlinkSync(standard,alias,process.platform==='win32'?'junction':'dir');}catch{return t.skip('当前平台不允许创建隔离测试链接');}assert.throws(()=>fixture(t,{LOCALAPPDATA:base,BOARD_PREVIEW_UPDATE_TEST:'1',BOARD_PORT:'18338',BOARD_DATA_DIR:alias}),/独立数据目录和非18327/);});

test('邮箱单一文件夹和TLS在后端也强制，空范围不会自动扩大',async t=>{
 const f=fixture(t);const input={platform:'email',name:'合成邮箱',enabled:true,scope:['INBOX'],config:{host:'imap.example.invalid',user:'synthetic@example.invalid',mailbox:'INBOX',secure:true},password:'synthetic-only'};
 const saved=await f.app.api('source.save',input);assert.equal(saved.config.secure,true);assert.equal(saved.scope[0],saved.config.mailbox);
 await assert.rejects(f.app.api('source.save',{...input,scope:['INBOX','Other']}),/只能读取一个文件夹/);
 await assert.rejects(f.app.api('source.save',{...input,config:{...input.config,secure:false}}),/SSL\/TLS/);
 await assert.rejects(f.app.api('source.save',{...input,scope:['Other']}),/范围必须/);
 const blank=await f.app.api('source.save',{platform:'email',name:'未接入合成',enabled:true,scope:[],config:{}});assert.equal(blank.scope.length,0);
});

test('天气启用需本人明确同意，设置只保存最后位置；立即整理空来源不触发发送',async t=>{
 const f=fixture(t);assert.equal(f.app.settings().weather.enabled,false);assert.equal((await f.app.api('weather.current')).status,'disabled');
 await assert.rejects(f.app.api('settings.save',{weather:{enabled:true,consent:false}}),/先同意/);
 const settings=await f.app.api('settings.save',{weather:{enabled:true,consent:true,autoLocate:true,location:{name:'合成公开位置',lat:39.9000123,lon:116.4000456,mode:'geolocation'}}});assert.equal(settings.weather.location.lat,39.9);assert.equal(settings.weather.location.lon,116.4);
 const job=await f.app.api('intake.start');assert.equal(job.status,'completed');assert.equal(job.results.length,0);assert.equal((await f.app.api('intake.status')).id,job.id);assert.equal(f.calls.length,0);
});

test('Codex 分析设置默认关闭，启用需严格同意，切换保留原服务配置和密钥',async t=>{
 const f=fixture(t);assert.equal(f.app.settings().ai.mode,'rules');assert.equal(f.app.settings().ai.codexConsent,false);
 await f.app.api('settings.save',{ai:{mode:'local',baseUrl:'http://127.0.0.1:11434/v1',model:'原模型'},aiKey:'合成旧密钥'});
 for(const ai of [{mode:'codex'},{mode:'codex',codexConsent:false},{mode:'codex',codexConsent:'true'},{mode:'other'},null,[]])await assert.rejects(f.app.api('settings.save',{ai}),/确认允许|授权设置无效|分析方式|格式不正确/);
 assert.equal(f.app.settings().ai.mode,'local');
 await f.app.api('settings.save',{ai:{mode:'codex',codexConsent:true}});
 assert.equal(f.app.settings().ai.baseUrl,'http://127.0.0.1:11434/v1');assert.equal(f.app.settings().ai.model,'原模型');assert.equal(f.credential.get('ai-key'),'合成旧密钥');
 f.reopen();assert.equal(f.app.settings().ai.mode,'codex');assert.equal(f.app.settings().ai.codexConsent,true);
 await f.app.api('settings.save',{ai:{mode:'rules',codexConsent:false}});assert.equal(f.app.settings().ai.codexConsent,false);
 assert.equal(f.calls.length,0,'保存设置不能触发模型或消息发送');assert.equal(f.analysisCancels,3,'AI设置改变时同步取消在途分析');
});

test('Codex 检测和固定示例 API 不改变当前模式，不访问遥控任务或真实来源',async t=>{
 const f=fixture(t);const before=JSON.stringify(f.app.settings());
 const status=await f.app.api('analysis.codexStatus');assert.equal(status.available,true);assert.equal(status.loggedIn,true);
 await assert.rejects(f.app.api('analysis.codexTest',{consent:'true',text:'不接受用户文本',prompt:'不接受命令'}),/示例分析授权/);
 const result=await f.app.api('analysis.codexTest',{consent:true,text:'不接受用户文本',prompt:'不接受命令'});assert.equal(result.ok,true);assert.equal(result.proposal.title,'合成示例');
 assert.equal(JSON.stringify(f.app.settings()),before);assert.deepEqual(f.calls.map(x=>x.type),['analysis-status','analysis-test']);assert.equal(f.app.store.all('tasks').length,0);assert.equal(f.app.store.all('sources').length,0);
});
