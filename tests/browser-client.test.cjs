'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/client.js'),'utf8');
const first='a'.repeat(64),second='b'.repeat(64);
const response=(status,data)=>({status,ok:status>=200&&status<300,json:async()=>data});
function client(fetch){const context={window:{},fetch};vm.runInNewContext(source,context);return context.window.board;}

test('浏览器并发请求共用一次无缓存会话读取',async()=>{
 let sessions=0,posts=0;const board=client(async(url,options)=>{if(url==='/api/session'){sessions++;assert.equal(options.cache,'no-store');await new Promise(setImmediate);return response(200,{token:first});}posts++;assert.equal(options.headers['X-Board-Token'],first);return response(200,{ok:true,data:posts});});
 const results=await Promise.all([board.call('bootstrap'),board.call('task.list'),board.call('source.list')]);assert.equal(sessions,1);assert.equal(posts,3);assert(results.every(x=>x.ok));
});

test('后台明确拒绝过期会话后只更新令牌重试一次，原请求内容保持相同',async()=>{
 let sessions=0,posts=0,executed=0;const bodies=[];const board=client(async(url,options)=>{if(url==='/api/session')return response(200,{token:++sessions===1?first:second});posts++;bodies.push(options.body);if(posts===1)return response(403,{ok:false,errorCode:'SESSION_EXPIRED'});assert.equal(options.headers['X-Board-Token'],second);executed++;return response(200,{ok:true,data:{saved:true}});});
 assert.equal((await board.call('task.create',{title:'合成未保存事项'})).ok,true);assert.equal(sessions,2);assert.equal(posts,2);assert.equal(executed,1);assert.equal(bodies[0],bodies[1]);
});

test('第二次令牌拒绝终止请求，不循环重放',async()=>{
 let sessions=0,posts=0;const board=client(async url=>url==='/api/session'?(sessions++,response(200,{token:sessions===1?first:second})):(posts++,response(403,{errorCode:'SESSION_EXPIRED'})));
 const result=await board.call('settings.save',{name:'合成'});assert.equal(result.ok,false);assert.match(result.error,/输入已保留/);assert.equal(sessions,2);assert.equal(posts,2);
});

test('网络失败的业务请求不自动重发',async()=>{
 let posts=0;const board=client(async url=>{if(url==='/api/session')return response(200,{token:first});posts++;throw Error('synthetic disconnect');});
 await assert.rejects(board.call('task.create',{title:'结果未知'}),/disconnect/);assert.equal(posts,1);
});

test('其它403、500与业务错误不自动重发',async()=>{
 for(const [status,body] of [[403,{error:'同源拒绝'}],[500,{ok:false,error:'server'}],[200,{ok:false,error:'业务校验失败'}]]){
  let posts=0,sessions=0;const board=client(async url=>url==='/api/session'?(sessions++,response(200,{token:first})):(posts++,response(status,body)));
  assert.equal((await board.call('settings.save',{name:'合成'})).ok,false);assert.equal(posts,1);assert.equal(sessions,1);
 }
});

test('不可解析的403不自动重发，异常令牌不提交业务请求',async()=>{
 let posts=0;const malformed=client(async url=>url==='/api/session'?response(200,{token:first}):(posts++,{status:403,json:async()=>{throw Error('bad JSON');}}));
 assert.equal((await malformed.call('task.create')).ok,false);assert.equal(posts,1);
 const invalid=client(async url=>{if(url==='/api/session')return response(200,{token:'invalid'});throw Error('must not post');});await assert.rejects(invalid.call('task.create'),/连接验证未完成/);
});

test('会话连接失败后本人可手动再试，不留失败Promise',async()=>{
 let sessions=0,posts=0;const board=client(async url=>{if(url==='/api/session'){if(++sessions===1)throw Error('synthetic offline');return response(200,{token:first});}posts++;return response(200,{ok:true});});
 await assert.rejects(board.call('task.create'),/offline/);assert.equal(posts,0);assert.equal((await board.call('task.create')).ok,true);assert.equal(sessions,2);assert.equal(posts,1);
});
