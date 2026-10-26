'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const {createCollectors,runProcess,parseDwsLedger,normalizeWechat,validateWechatCredential}=require('../server/collectors.cjs');
function dws(overrides={}){return {id:'dt',platform:'dingtalk',enabled:true,scope:['cidFixedGroup=='],config:{collector:{kind:'dingtalk-dws',executable:'dws.exe',authorized:true,profile:'corp-test:user-test',startAt:'2026-10-25T00:00:00Z',...overrides}}};}
function processFake(handler){const calls=[];const spawnImpl=(exe,args,options)=>{calls.push({exe,args,options});const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.stdin=new PassThrough();p.kill=()=>{p.killed=true;queueMicrotask(()=>p.emit('close',null,'SIGTERM'));};queueMicrotask(()=>handler(p,exe,args,options));return p;};return {calls,spawnImpl};}
function finish(p,value,code=0){p.stdout.end(typeof value==='string'?value:JSON.stringify(value));p.emit('close',code,null);}
function standard(p,exe,args){if(args.includes('--version'))return finish(p,'dws v0.test');if(args.includes('--help'))return finish(p,'--start --end --page-all --no-reactions --readonly');if(args[0]==='auth')return finish(p,{success:true,authenticated:true,corp_id:'corp-test',user_id:'user-test'});}
const ledger=(messages=[],extra={})=>({messages,complete:true,hasMore:false,paginationKnown:true,failures:[],failedCount:0,...extra});
test('未安装、待本人授权、空范围与身份歧义分开，均不读取消息',async()=>{
 const fake=processFake(standard);const c=createCollectors({spawnImpl:fake.spawnImpl});
 assert.equal((await c.probe(dws({authorized:false}))).status,'needs_login');
 assert.equal((await c.probe(dws({authorized:'false'}))).status,'needs_login');
 assert.equal((await c.probe({...dws(),scope:[]})).status,'needs_scope');
 assert.equal((await c.probe({...dws(),scope:['项目群名']})).status,'needs_scope');
 assert.equal((await c.probe(dws({profile:'自动选默认账号'}))).status,'needs_login');
 assert.equal((await c.probe(dws({startAt:'2026-02-30T00:00:00Z'}))).status,'needs_scope');
 assert.equal(fake.calls.length,0);
 const absent=createCollectors({spawnImpl(){const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.stdin=new PassThrough();queueMicrotask(()=>p.emit('error',Object.assign(Error('absent'),{code:'ENOENT'})));return p;}});
 assert.equal((await absent.probe(dws())).status,'not_installed');
});
test('探测仅version/help和readonly登录态，旧版本不支持readonly时不能继续',async()=>{
 const fake=processFake(standard);assert.equal((await createCollectors({spawnImpl:fake.spawnImpl}).probe(dws())).status,'configured');
 assert.equal(fake.calls.length,4);assert.ok(fake.calls.every(c=>c.options.shell===false&&c.options.windowsHide));
 assert.ok(fake.calls.every(c=>!c.args.includes('--start')));assert.ok(fake.calls.at(-1).args.includes('--readonly'));
 const old=processFake((p,e,a)=>finish(p,a.includes('--version')?'old':'--start --end --page-all --no-reactions'));
 assert.equal((await createCollectors({spawnImpl:old.spawnImpl}).probe(dws())).status,'failure');
 assert.equal(old.calls.some(c=>c.args.includes('--readonly')),false);
});
test('拒绝Windows命令脚本与不匹配账号，不用shell:true兜底',async()=>{
 const fake=processFake(standard);const c=createCollectors({spawnImpl:fake.spawnImpl});
 assert.equal((await c.probe(dws({executable:'dws.cmd'}))).status,'failure');assert.equal(fake.calls.length,0);
 const wrong=processFake((p,e,a)=>a[0]==='auth'&&!a.includes('--help')?finish(p,{success:true,authenticated:true,corp_id:'other',user_id:'user-test'}):standard(p,e,a));
 assert.equal((await createCollectors({spawnImpl:wrong.spawnImpl}).probe(dws())).status,'needs_login');
});
test('钉钉限定稳定群ID与固定一天范围，参数数组保留字面字符，完整后给出候选检查点',async()=>{
 const fake=processFake((p,e,a)=>{if(a.includes('--start'))return finish(p,ledger([{messageId:'m1',conversationId:'cidFixedGroup==',text:'请核对图纸',createTime:'2026-10-25T10:00:00+08:00',senderId:'sender'}]));standard(p,e,a);});
 const out=await createCollectors({spawnImpl:fake.spawnImpl,now:()=>new Date('2026-10-26T09:00:00Z')}).collect(dws());
 assert.equal(out.records[0].conversation,'cidFixedGroup==');assert.match(out.records[0].id,/m1/);assert.equal(out.complete,true);
 const command=fake.calls.find(c=>c.args.includes('--start'));assert.ok(command.args.includes('--conversation-id'));assert.ok(command.args.includes('--no-reactions'));
 assert.equal(command.args[command.args.indexOf('--end')+1],'2026-10-26T00:00:00.000Z');assert.equal(out.checkpoint.committedThrough,'2026-10-26T00:00:00.000Z');
 assert.equal(out.coverage.mediaReviewed,false);assert.equal(out.coverage.platformDirect,true);
});
test('钉钉响应越出群范围或时间窗口失败，缺消息ID不能静默跳过',()=>{
 assert.throws(()=>parseDwsLedger(ledger([{messageId:'m1',conversationId:'cidOther',text:'请发送'}]),'cidFixedGroup==',{start:'2026-10-25T00:00:00Z',end:'2026-10-26T00:00:00Z'}),/范围/);
 assert.throws(()=>parseDwsLedger(ledger([{text:'缺编号',createTime:'2026-10-25T01:00:00Z'}]),'cidFixedGroup==',{start:'2026-10-25T00:00:00Z',end:'2026-10-26T00:00:00Z'}),/编号/);
 assert.throws(()=>parseDwsLedger(ledger([{messageId:'m',text:'请核对',createTime:'2026-10-27T01:00:00Z'}]),'cidFixedGroup==',{start:'2026-10-25T00:00:00Z',end:'2026-10-26T00:00:00Z'}),/时间/);
 assert.equal(parseDwsLedger(ledger([],{complete:undefined,paginationKnown:undefined}),'cidFixedGroup==').complete,false);
 assert.equal(parseDwsLedger(ledger([{messageId:'time-zone',text:'文字',createTime:'2026-10-25 10:00:00'}]),'cidFixedGroup==').records[0].at,'2026-10-25T02:00:00.000Z');
 assert.throws(()=>parseDwsLedger(ledger([{messageId:'empty-time',text:'文字',createTime:null}]),'cidFixedGroup=='),/时间/);
});
test('非零退出和分页partial保留已取得记录但不提供可前移检查点',async()=>{
 const fake=processFake((p,e,a)=>{if(a.includes('--start'))return finish(p,ledger([{messageId:'m',text:'请发送资料',createTime:'2026-10-25T10:00:00Z'}],{complete:false,hasMore:true,partial:true,failedCount:1,failures:[{stage:'read'}]}),7);standard(p,e,a);});
 const result=await createCollectors({spawnImpl:fake.spawnImpl,now:()=>new Date('2026-10-26T00:00:00Z')}).collect(dws());
 assert.equal(result.complete,false);assert.equal(result.records.length,1);assert.equal(result.checkpoint,undefined);assert.equal(result.collectorStatus,'partial');
});
test('子进程超时与AbortSignal均取消，外部取消之前不启动命令，输出有上限',async()=>{
 const hanging=processFake(()=>{});const ctrl=new AbortController();const pending=runProcess('fixed.exe',[],{spawnImpl:hanging.spawnImpl,signal:ctrl.signal,timeoutMs:1000});ctrl.abort();await assert.rejects(pending,/取消/);
 await assert.rejects(runProcess('fixed.exe',[],{spawnImpl:hanging.spawnImpl,timeoutMs:15}),/超时/);
 const before=hanging.calls.length;await assert.rejects(runProcess('fixed.exe',[],{spawnImpl:hanging.spawnImpl,signal:ctrl.signal}),/取消/);assert.equal(hanging.calls.length,before);
 const noisy=processFake(p=>finish(p,'a'.repeat(100)));await assert.rejects(runProcess('fixed.exe',[],{spawnImpl:noisy.spawnImpl,maxBytes:20}),/上限/);
});
test('微信规范化使用完整source_db:local_id，保留时区和独立媒体覆盖',()=>{
 const result=normalizeWechat({ok:true,accountId:'wxid_self',chats:[{username:'12345@chatroom',messages:[{source_db:'message/message_0.db',local_id:7,time:'2026-10-25T10:00:00+08:00',content:'请核对资料',type_code:1},{source_db:'message/message_1.db',local_id:7,time:'2026-10-25T11:00:00+08:00',content:'[图片]',type_code:3}]}]},['12345@chatroom'],'wxid_self');
 assert.notEqual(result[0].id,result[1].id);assert.equal(result[0].at,'2026-10-25T02:00:00.000Z');assert.equal(result[1].mediaReviewed,false);
 assert.throws(()=>normalizeWechat({ok:true,accountId:'other',chats:[]},['12345@chatroom'],'wxid_self'),/账号/);
 assert.throws(()=>normalizeWechat({ok:true,accountId:'wxid_self',chats:[{username:'not-authorized',messages:[]}]},['12345@chatroom'],'wxid_self'),/范围/);
});
test('微信和钉钉消息身份绑定明确采集账号，同会话同平台编号跨账号不碰撞',()=>{
 const scope=['12345@chatroom'];const makeWechat=accountId=>normalizeWechat({ok:true,accountId,chats:[{username:scope[0],messages:[{source_db:'message/message_0.db',local_id:7,time:'2026-10-25T10:00:00+08:00',content:'请核对图纸'}]}]},scope,accountId)[0];
 const wxA=makeWechat('wxid_owner_a'),wxB=makeWechat('wxid_owner_b');
 assert.notEqual(wxA.id,wxB.id,'同一来源重绑本人另一账号，local_id不可误判为重复');assert.equal(wxA.id,makeWechat('wxid_owner_a').id);
 const payload=ledger([{messageId:'same-platform-id',text:'请核对图纸',createTime:'2026-10-25T10:00:00+08:00'}]);
 const makeDws=profile=>parseDwsLedger(payload,'cidSameGroup==',undefined,profile).records[0];
 assert.notEqual(makeDws('corp-a:user-a').id,makeDws('corp-b:user-a').id,'明确企业身份须参与命名空间');
 assert.notEqual(makeDws('corp-a:user-a').id,makeDws('corp-a:user-b').id,'同企业另一本人登录账号应独立');
 assert.equal(makeDws('corp-a:user-a').id,makeDws('corp-a:user-a').id);
});
test('微信调用固定helper而不拼用户代码，probe只check，空范围不初始化工具',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workboard-wx-adapter-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const cli=path.join(dir,'cli.py');fs.writeFileSync(cli,'fixture only');
 const calls=[];const fake=processFake((p,e,args)=>{calls.push(args);if(args.includes('--check'))finish(p,{ok:true});else finish(p,{ok:true,accountId:'wxid_self',chats:[{username:'12345@chatroom',messages:[]}]});});
 const source={id:'wx',platform:'wechat',scope:['12345@chatroom'],config:{collector:{kind:'wechat-export',executable:'python.exe',scriptPath:cli,dbDir:path.join(dir,'account'),accountId:'wxid_self',authorized:true}}};
 const c=createCollectors({spawnImpl:fake.spawnImpl});assert.equal((await c.probe(source)).status,'needs_credential');assert.equal(calls.length,0);await assert.rejects(c.collect(source),e=>e.collectorStatus==='needs_credential');assert.equal(calls.length,0);
 assert.equal((await c.probe(source,{hasCredential:true})).status,'configured');assert.equal(calls.length,1);assert.ok(calls[0].includes('--check'));assert.equal(calls[0].includes('--collect'),false);
 fs.mkdirSync(source.config.collector.dbDir);const credential={schema:1,accountId:'wxid_self',accountDir:fs.realpathSync(source.config.collector.dbDir),keys:{'contact/contact.db':'ab'.repeat(32)}};
 const result=await c.collect(source,{credential});assert.equal(result.complete,true);assert.equal(calls.at(-1)[0],'-c');assert.equal(calls.at(-1)[1],require('../server/wechat-export-runner.cjs'));assert.equal(calls.at(-1).includes('--all'),false);assert.equal(calls.at(-1).join(' ').includes('ab'.repeat(32)),false,'密钥不能进入argv');
 assert.equal((await c.probe({...source,scope:[]})).status,'needs_scope');assert.equal(calls.length,3);
});
test('微信凭据封套绑定账号及真实目录，仅规范化已核实的逐库64/96hex，拒绝越界及回显',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workboard-wx-credential-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const source={config:{collector:{accountId:'wxid_self',dbDir:dir}}};
 const sealed={schema:1,accountId:'wxid_self',accountDir:fs.realpathSync(dir),keys:{'contact\\contact.db':'AB'.repeat(32),'message/message_0.db':'CD'.repeat(48)}};
 const result=validateWechatCredential(JSON.stringify(sealed),source);assert.equal(result.keys['contact/contact.db'],'ab'.repeat(32));assert.equal(result.keys['message/message_0.db'].length,96);assert.equal(Object.keys(result.keys).length,2);
 for(const raw of [null,{...sealed,accountId:'wxid_other'},{...sealed,accountDir:path.dirname(dir)},{...sealed,keys:{'../other.db':'ab'.repeat(32)}},{...sealed,keys:{'contact/contact.db':'AB'.repeat(32),'contact\\contact.db':'AB'.repeat(32)}},{...sealed,keys:{'contact/contact.db':'secret-not-a-key'}}])assert.throws(()=>validateWechatCredential(raw,source),e=>e.collectorStatus==='needs_credential'&&!e.message.includes('secret-not-a-key'));
});
test('微信helper拒绝降级快照时不返回完整结果或候选检查点',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workboard-wx-stamp-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const cli=path.join(dir,'cli.py');fs.writeFileSync(cli,'fixture only');
 const source={id:'wx',platform:'wechat',scope:['12345@chatroom'],config:{collector:{kind:'wechat-export',executable:'python.exe',scriptPath:cli,dbDir:dir,accountId:'wxid_self',authorized:true}}};
 let secretOnStdin=false;const fake=processFake((p,e,args)=>{if(args.includes('--check'))return finish(p,{ok:true});const request=JSON.parse(p.stdin.read().toString('utf8'));secretOnStdin=request.credential.keys['contact/contact.db']==='ab'.repeat(32);finish(p,{ok:false,status:'snapshot_incomplete'},1);});
 const credential={schema:1,accountId:'wxid_self',accountDir:fs.realpathSync(dir),keys:{'contact/contact.db':'ab'.repeat(32)}};
 await assert.rejects(createCollectors({spawnImpl:fake.spawnImpl}).collect(source,{credential}),e=>e.collectorStatus==='snapshot_incomplete'&&/快照/.test(e.message));assert.equal(secretOnStdin,true);assert.equal(fake.calls.some(call=>call.args.join(' ').includes('ab'.repeat(32))),false);
});
test('微信固定helper离线假模块验证零扫描/零缓存、精确账号、新分片缺钥阻断与严格快照',t=>{
 const {spawnSync}=require('node:child_process');const runner=require('../server/wechat-export-runner.cjs');
 const fixture=String.raw`
import sys, types, tempfile, pathlib, json, contextlib, os
ns={"__name__":"isolated_helper_test"}
exec(sys.stdin.buffer.read().decode('utf-8'),ns)
with tempfile.TemporaryDirectory(prefix="workboard-helper-test-") as temp:
    root=pathlib.Path(temp);account=root/"wxid_self_abcd";storage=account/"db_storage";(storage/"contact").mkdir(parents=True);(storage/"message").mkdir()
    (storage/"contact"/"contact.db").write_bytes(b"fixture-contact")
    (storage/"message"/"message_0.db").write_bytes(b"fixture-message")
    db_module=types.ModuleType("wechatauto.db");pkg=types.ModuleType("wechatauto");pkg.db=db_module
    sys.modules["wechatauto"]=pkg;sys.modules["wechatauto.db"]=db_module
    core=types.ModuleType("exporter_core");seen=[];cleanup=[];traps=[];closed=[];mode="good"
    db_module.STAMP_VERSION=3
    def forbidden(*args,**kwargs):traps.append("forbidden");raise AssertionError("upstream scan/cache entered")
    class Connection:
        def close(self):closed.append(True)
    class Base:
        WAL_HEADER_SZ=32;WAL_FRAME_SZ=4120
        def __init__(self,db_dir,account,workdir):
            self.account_dir=str(pathlib.Path(db_dir)/account)
            self.workdir=workdir;pathlib.Path(workdir).mkdir(exist_ok=True)
            assert db_module._find_account_dirs("ignored")==[self.account_dir]
            self._db_files=self._collect_db_files();self._keys={};self._load_or_extract_keys()
        def _collect_db_files(self):return [(str(file.relative_to(storage)),str(file),file.stat().st_size) for file in storage.rglob("*.db")]
        def _db_path(self,relative):return next(file for rel,file,_ in self._db_files if rel==relative)
        def _wal_path(self,relative):
            file=self._db_path(relative)+"-wal"
            return file if pathlib.Path(file).exists() else None
        def _key_works(self,relative):return bool(self._keys.get(relative))
        def _open(self,relative):return self._open_unlocked(relative)
        def _open_unlocked(self,relative):
            values=list(self._source_signature(relative));applied=0
            if mode=="negative":applied=-1
            if mode=="stale":values[0]-=1
            stamp=pathlib.Path(self.workdir)/(relative.replace(os.sep,"__")+".stamp")
            if mode=="missing":
                if stamp.exists():stamp.unlink()
            else:stamp.write_text(",".join(str(x) for x in [3,*values,applied]),encoding="utf-8")
            return Connection()
        def get_self_info(self):
            self._open(str(pathlib.Path("contact")/"contact.db")).close()
            return {"username":"wxid_self"}
    for name in ("_load_or_extract_keys","_refresh_db_files","extract_master_key","extract_keys","_all_key_candidates","_try_other_accounts","_select_account_by_keys","_load_key_cache","_stable_key_dirs","_stable_key_file","_auto_diagnose_key_failure","_save_keys","_find_weixin_pids"):setattr(Base,name,forbidden)
    core.WeChatDB=Base
    core._create_sensitive_workdir=lambda:root/"sensitive-only-this-run"
    core._upstream_sensitive_sandbox=lambda _:contextlib.nullcontext()
    core._cleanup_sensitive_workdir=lambda d:(cleanup.append(str(d)) or True,"")
    core.EmptyConversationError=type("EmptyConversationError",(ValueError,),{})
    def export(keyword,**kw):
        assert keyword is None and kw["contact"]["username"]=="12345@chatroom"
        assert kw["export_images"] is False and kw["export_files"] is False and kw["export_voices"] is False and kw["export_videos"] is False
        seen.append(kw["contact"]["username"])
        kw["db"]._refresh_db_files()
        for rel,_,_ in kw["db"]._db_files:kw["db"]._open(rel).close()
        file=pathlib.Path(kw["out_root"])/"parsed.json"
        file.write_text(json.dumps({"messages":[{"source_db":"message_0.db","local_id":1,"time":"2026-10-25 10:00:00","content":"sample"}]}),encoding="utf-8-sig")
        return {"json":str(file)}
    core._export_chat_impl=export;sys.modules["exporter_core"]=core
    credential={"schema":1,"accountId":"wxid_self","accountDir":str(account),"keys":{"contact/contact.db":"ab"*32,"message/message_0.db":"cd"*48}}
    request={"accountDir":str(account),"accountId":"wxid_self","scope":["12345@chatroom"],"credential":credential}
    try:ns["collect"](root,{**request,"credential":None})
    except ns["CredentialRequired"]:pass
    else:raise AssertionError("missing keys accepted")
    assert cleanup==[] and traps==[]
    result=ns["collect"](root,request)
    assert seen==["12345@chatroom"] and len(cleanup)==1 and result["ok"] is True
    assert "+" in result["chats"][0]["messages"][0]["time"] or "-" in result["chats"][0]["messages"][0]["time"][-6:]
    wrong={**request,"accountId":"wrong_user","credential":{**credential,"accountId":"wrong_user"}}
    try:ns["collect"](root,wrong)
    except ValueError:pass
    else:raise AssertionError("wrong account accepted")
    assert seen==["12345@chatroom"] and len(cleanup)==2
    for failure in ("negative","stale","missing"):
        mode=failure
        try:ns["collect"](root,request)
        except ns["SnapshotIncomplete"]:pass
        else:raise AssertionError("degraded snapshot accepted: "+failure)
    mode="good"
    wal=storage/"contact"/"contact.db-wal";wal.write_bytes(b"0"*(32+4120))
    try:ns["collect"](root,request)
    except ns["SnapshotIncomplete"]:pass
    else:raise AssertionError("unapplied WAL frames accepted")
    wal.unlink()
    (storage/"message"/"message_1.db").write_bytes(b"new-shard")
    try:ns["collect"](root,request)
    except ns["CredentialRequired"]:pass
    else:raise AssertionError("new shard missing keys accepted")
    assert traps==[],"no scan, key-cache or global fallback may run"
print("isolated helper passed")
`;
 const result=spawnSync('python',['-c',fixture],{input:runner,encoding:'utf8',shell:false,windowsHide:true,timeout:10000});
 if(result.error?.code==='ENOENT'){t.skip('本机无Python，helper动态样本待运行；JS边界仍已测');return;}
 assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/isolated helper passed/);
});
