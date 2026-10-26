'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store.cjs');
const { createSources } = require('../server/sources.cjs');
const { ruleExtract, extract, parseRecords, shanghaiDate } = require('../server/extract.cjs');
const {normalizeWechat,parseDwsLedger}=require('../server/collectors.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-source-test-'));
  const store = createStore(dir); const vaultCalls = [];
  const vault = { async get(key) { vaultCalls.push(key); return null; } };
  const settings = { ai: { mode: 'rules' } };
  const sources = createSources({ store, vault, getSettings: () => settings });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, sources, settings, vaultCalls };
}
function source(overrides = {}) { return { id: 'wx', platform: 'wechat', name: '工作微信', enabled: true, scope: ['项目 A'], config: {}, ...overrides }; }
const row = (id, conversation = '项目 A', text = '请核对生产图纸') => ({ id, conversation, text, at: '2026-10-26T08:00:00+08:00' });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function within(promise, milliseconds = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('延期 AI 测试未进入预期请求')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function pauseLocalAI(t, settings) {
  const entered = deferred(); const response = deferred(); let calls = 0;
  settings.ai = { mode: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'isolated-test' };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(String(url), 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(options.method, 'POST');
    entered.resolve();
    return response.promise;
  });
  return { entered: entered.promise, get calls() { return calls; }, release() { response.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"isTask":true,"title":"延期后返回的旧任务","dueDate":"","priority":2}' } }] }))); } };
}

test('规则提取不把收到、好的、已安排或谢谢当待办，不凭普通工作描述编日期', () => {
  for (const text of ['收到', '收到！', '好的。', '好', '已安排', '安排了', '谢谢', 'OK', 'ok']) assert.equal(ruleExtract(text).isTask, false, text);
  assert.equal(ruleExtract('').isTask, false);
  const result = ruleExtract('请核对生产图纸');
  assert.equal(result.isTask, true); assert.equal(result.dueDate, '');
  assert.equal(ruleExtract('请尽快发送报价').priority, 3);
});

test('明确日期按真实日历验证；今天明天采用北京时间跨日', () => {
  assert.equal(ruleExtract('请在2026年11月2日发送报价').dueDate, '2026-11-02');
  assert.equal(ruleExtract('请在2028/2/29发送报价').dueDate, '2028-02-29');
  assert.equal(ruleExtract('请在2026-02-30发送报价').dueDate, '');
  assert.equal(ruleExtract('请在2026-13-01发送报价').dueDate, '');
  const now = new Date('2026-10-26T16:30:00Z');
  assert.equal(shanghaiDate(now), '2026-10-27');
  assert.equal(ruleExtract('请今天核对图纸', now).dueDate, '2026-10-27');
  assert.equal(ruleExtract('请明天核对图纸', now).dueDate, '2026-10-28');
});

test('历史消息相对期限以原消息北京时间计算，不套用整理当天', async t => {
  const f = fixture(t); const s = source(); f.store.put('sources', s);
  const result = await f.sources.ingest(s, [{ id: 'historical', conversation: '项目 A', text: '请明天提交图纸', at: '2026-09-01T18:00:00Z' }]);
  assert.equal(result.created, 1);
  assert.equal(f.store.all('tasks')[0].dueDate, '2026-09-03', '原消息为北京时间 9月2日，明天应为9月3日');
});

test('来源消息缺少或含无效时间时不为相对期限猜测日期', async t => {
  const f = fixture(t); const s = source(); f.store.put('sources', s);
  await f.sources.ingest(s, [
    { id: 'unknown-time', conversation: '项目 A', text: '请明天提交图纸' },
    { id: 'invalid-time', conversation: '项目 A', text: '请今天核对资料', at: 'invalid' },
  ]);
  assert.deepEqual(f.store.all('tasks').map(task => task.dueDate), ['', '']);
});

test('记录解析支持平台消息编号、秒级时间和明确回复关系，不丢失中文', () => {
  const parsed = parseRecords(JSON.stringify({ records: [{ message_id: '90071992547409931234', content: '请发送中文资料', timestamp: 1792972800, chat_name: '项目 A', inReplyTo: 'old-id' }] }));
  assert.equal(parsed[0].id, '90071992547409931234');
  assert.equal(parsed[0].conversation, '项目 A'); assert.equal(parsed[0].replyTo, 'old-id');
  assert.equal(parsed[0].at, new Date(1792972800 * 1000).toISOString());
  assert.equal(parsed[0].text, '请发送中文资料');
  assert.deepEqual(parseRecords('收到\n\n请核对资料').map(m => m.text), ['收到', '请核对资料']);
  assert.throws(() => parseRecords('{"messages":"不是数组"}'), /消息数组/);
});

test('纯文本消息标识不随头插不同文本或空行改变，同文多次出现仍有独立标识', () => {
  const first = parseRecords('请核对原图纸\n请发送原报价');
  const prepended = parseRecords('请提交新增资料\n\n请核对原图纸\n请发送原报价');
  assert.deepEqual(prepended.slice(1).map(m => m.id), first.map(m => m.id));
  const repeated = parseRecords('请核对相同图纸\n请核对相同图纸');
  assert.notEqual(repeated[0].id, repeated[1].id);
  const repeatedAfterInsert = parseRecords('不同的新增消息\n请核对相同图纸\n请核对相同图纸');
  assert.deepEqual(repeatedAfterInsert.slice(1).map(m => m.id), repeated.map(m => m.id));
  assert.deepEqual(parseRecords('  请核对原图纸  \n\n 请发送原报价\n').map(m => m.id), first.map(m => m.id));
});

test('纯文本头插和重复导入只新增真实新行，同文重复行分别保留且不反复建卡', async t => {
  const f = fixture(t); f.store.put('sources', source());
  const original = '请核对原图纸\n请发送原报价';
  assert.equal((await f.sources.importText('wx', original)).created, 2);
  const changed = '请提交新增资料\n' + original;
  const inserted = await f.sources.importText('wx', changed);
  assert.equal(inserted.created, 1); assert.equal(inserted.duplicates, 2);
  const unchanged = await f.sources.importText('wx', changed);
  assert.equal(unchanged.created, 0); assert.equal(unchanged.duplicates, 3);
  const repeated = await f.sources.importText('wx', changed + '\n请核对原图纸');
  assert.equal(repeated.created, 1); assert.equal(repeated.duplicates, 3);
  const repeatAgain = await f.sources.importText('wx', changed + '\n请核对原图纸');
  assert.equal(repeatAgain.created, 0); assert.equal(repeatAgain.duplicates, 4);
  assert.equal(f.store.all('tasks').length, 4);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 4);
});

test('导出来源严格过滤未选择范围，且不把本机导出标为平台直接连接', async t => {
  const f = fixture(t); const file = path.join(f.dir, 'export.json');
  fs.writeFileSync(file, JSON.stringify([row('a'), row('b', '未选择群'), row('ack', '项目 A', '收到')]));
  f.store.put('sources', source({ config: { importPath: file } }));
  assert.equal((await f.sources.test('wx')).status, 'configured');
  assert.equal(f.store.get('sources', 'wx').lastSuccessAt, undefined);
  const result = await f.sources.sync('wx');
  assert.deepEqual(result, { received: 3, created: 1, updated: 0, ignored: 1, duplicates: 0, filtered: 1 });
  assert.equal(f.store.all('tasks').length, 1); assert.equal(f.vaultCalls.length, 0);
  const saved = f.store.get('sources', 'wx');
  assert.equal(saved.status, 'connected'); assert.ok(saved.lastSuccessAt);
  assert.equal(saved.coverage.mode, 'local-export'); assert.equal(saved.coverage.platformDirect, false);
  assert.match(saved.coverage.media, /不在本次覆盖/);
  const repeat = await f.sources.sync('wx');
  assert.equal(repeat.duplicates, 2); assert.equal(repeat.created, 0); assert.equal(f.store.all('tasks').length, 1);
});

test('2001 条导出处理尾部并让出事件循环，追加与重复整理恰好导入一次', async t => {
  const f = fixture(t); const file = path.join(f.dir, 'large-export.json');
  // 大多数记录属于未授权群，仍必须完整扫描，尾部两条是真实授权任务。
  const records = Array.from({ length: 1999 }, (_, i) => row('outside-' + i, '未选择群', '收到'));
  records.push(row('tail-2000', '项目 A', '请核对第2000条图纸'), row('tail-2001', '项目 A', '请核对第2001条图纸'));
  fs.writeFileSync(file, JSON.stringify(records));
  f.store.put('sources', source({ config: { importPath: file } }));
  let yielded = false; const immediate = setImmediate(() => { yielded = true; });
  t.after(() => clearImmediate(immediate));
  const first = await f.sources.sync('wx');
  assert.equal(yielded, true, '大批量整理应让出事件循环，不能持续阻塞界面');
  assert.deepEqual(first, { received: 2001, created: 2, updated: 0, ignored: 0, duplicates: 0, filtered: 1999 });
  assert.deepEqual(f.store.all('tasks').map(task => task.sourceRef), ['tail-2000', 'tail-2001']);
  assert.equal(f.store.get('sources', 'wx').lastCounts.received, 2001);
  records.push(row('tail-2002', '项目 A', '请核对追加图纸'));
  fs.writeFileSync(file, JSON.stringify(records));
  const appended = await f.sources.sync('wx');
  assert.deepEqual(appended, { received: 2002, created: 1, updated: 0, ignored: 0, duplicates: 2, filtered: 1999 });
  const repeated = await f.sources.sync('wx');
  assert.deepEqual(repeated, { received: 2002, created: 0, updated: 0, ignored: 0, duplicates: 3, filtered: 1999 });
  assert.equal(f.store.all('tasks').length, 3);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 3);
});

test('缺少会话范围的导出消息不绕过已选群限制', async t => {
  const f = fixture(t); const s = source(); f.store.put('sources', s);
  const result = await f.sources.ingest(s, [row('unknown', '')]);
  assert.equal(result.filtered, 1); assert.equal(result.created, 0);
  assert.equal(f.store.all('tasks').length, 0); assert.equal(f.store.messages().length, 0);
});

test('自动整理只运行启用且到期的来源，停用源不读文件、不尝试邮箱凭据', async t => {
  const f = fixture(t); const file = path.join(f.dir, 'active.json');
  fs.writeFileSync(file, JSON.stringify([row('active')]));
  f.store.put('sources', source({ config: { importPath: file, pollMinutes: 5 } }));
  f.store.put('sources', source({ id: 'disabled', platform: 'email', enabled: false, scope: ['INBOX'], config: {} }));
  f.store.put('sources', source({ id: 'not-due', lastAttemptAt: new Date().toISOString(), config: { importPath: path.join(f.dir, 'never-read.json'), pollMinutes: 60 } }));
  await f.sources.tick();
  assert.equal(f.store.all('tasks').length, 1); assert.equal(f.vaultCalls.length, 0);
  assert.equal(f.store.get('sources', 'disabled').lastAttemptAt, undefined);
  assert.equal(f.store.get('sources', 'not-due').status, undefined);
  assert.equal(f.store.all('activity').filter(v => v.kind === 'source.sync').length, 1);
  await f.sources.tick();
  assert.equal(f.store.all('activity').filter(v => v.kind === 'source.sync').length, 1);
});

test('停用源常规同步跳过，用户明确手动强制同步仍受来源范围限制', async t => {
  const f = fixture(t); const file = path.join(f.dir, 'manual.json');
  fs.writeFileSync(file, JSON.stringify([row('manual')]));
  f.store.put('sources', source({ enabled: false, config: { importPath: file } }));
  assert.deepEqual(await f.sources.sync('wx'), { skipped: true });
  assert.equal(f.store.all('tasks').length, 0);
  assert.equal((await f.sources.sync('wx', { force: true })).created, 1);
  f.store.put('sources', source({ id: 'unscoped', scope: [], config: { importPath: file } }));
  await assert.rejects(f.sources.sync('unscoped', { force: true }), /选择.*范围/);
  await assert.rejects(f.sources.importText('unscoped', '请核对资料'), /选择来源范围/);
});

test('读取失败保留上次真实成功时间，记录本次异常且不伪报新数据', async t => {
  const f = fixture(t); const previous = '2026-10-25T09:00:00.000Z';
  f.store.put('sources', source({ status: 'connected', lastSuccessAt: previous, config: { importPath: path.join(f.dir, 'missing.json') } }));
  await assert.rejects(f.sources.sync('wx'), /ENOENT/);
  const saved = f.store.get('sources', 'wx');
  assert.equal(saved.status, 'error'); assert.equal(saved.lastSuccessAt, previous); assert.match(saved.lastError, /ENOENT/);
  assert.ok(saved.lastAttemptAt); assert.equal(f.store.all('tasks').length, 0);
  assert.equal(f.store.all('activity')[0].success, false);
});

for (const change of ['停用', '更改范围', '删除']) {
  test(`整理在 AI 返回前${change}来源会停止入库，失败收尾不覆盖新设置或复活来源`, async t => {
    const f = fixture(t); const file = path.join(f.dir, 'pending-export.json');
    fs.writeFileSync(file, JSON.stringify([row('pending-old-source')]));
    f.store.put('sources', source({ status: 'configured', lastSuccessAt: '2026-10-25T09:00:00.000Z', config: { importPath: file } }));
    const ai = pauseLocalAI(t, f.settings);
    const pending = f.sources.sync('wx'); pending.catch(() => {});
    try {
      await within(ai.entered);
      let expected;
      if (change === '删除') f.store.db.prepare('DELETE FROM sources WHERE id=?').run('wx');
      else {
        expected = { ...f.store.get('sources', 'wx'), status: 'configured', lastError: '新配置尚待重新整理', ...(change === '停用' ? { enabled: false } : { scope: ['项目 B'] }) };
        f.store.put('sources', expected);
      }
      ai.release();
      await assert.rejects(pending, /来源已停用、删除或范围已改变/);
      assert.equal(ai.calls, 1); assert.equal(f.store.all('tasks').length, 0);
      assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
      assert.equal(f.store.events().length, 0);
      if (change === '删除') assert.equal(f.store.get('sources', 'wx'), null, '异步收尾不得重建已删除来源');
      else assert.deepEqual(f.store.get('sources', 'wx'), expected, '旧同步结果不得覆盖新设置或写入错误状态');
      const activity = f.store.all('activity');
      assert.equal(activity.filter(v => v.kind === 'source.sync' && v.success === true).length, 0);
      assert.equal(activity.filter(v => v.kind === 'source.sync' && v.success === false).length, 1);
    } finally { ai.release(); await pending.catch(() => {}); }
  });
}

test('来源快照已过期时在调用 AI 前拒绝导入旧范围数据', async t => {
  const f = fixture(t); const stale = source();
  f.store.put('sources', source({ scope: ['项目 B'] }));
  const ai = pauseLocalAI(t, f.settings);
  await assert.rejects(f.sources.ingest(stale, [row('old-snapshot')]), /来源已停用、删除或范围已改变/);
  assert.equal(ai.calls, 0); assert.equal(f.store.all('tasks').length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
});

test('手动指定现有任务时保留跨来源证据，重复导入不重复追加', async t => {
  const f = fixture(t); const task = f.store.createTask({ title: '现有工作' });
  f.store.put('sources', source({ id: 'mail-export', platform: 'email', scope: ['INBOX'] }));
  const text = JSON.stringify([row('mail-1', 'INBOX', '补充的邮件证据')]);
  const first = await f.sources.importText('mail-export', text, task.id);
  const second = await f.sources.importText('mail-export', text, task.id);
  assert.equal(first.updated, 1); assert.equal(second.duplicates, 1);
  assert.equal(f.store.all('tasks').length, 1); assert.equal(f.store.get('tasks', task.id).links.length, 1);
  assert.equal(f.vaultCalls.length, 0, '导出文本导入不应尝试真实邮箱');
});

test('在线 AI 必须 HTTPS 与已保存密钥，本地 AI 限制回环地址，错误发生在网络请求前', async () => {
  let fetched = 0; const fetchImpl = async () => { fetched++; throw Error('不能联网'); };
  const vault = { async get() { return ''; } };
  await assert.rejects(extract('请核对', { ai: { mode: 'cloud', baseUrl: 'http://api.example.test/v1' } }, vault, fetchImpl), /HTTPS/);
  await assert.rejects(extract('请核对', { ai: { mode: 'cloud', baseUrl: 'https://api.example.test/v1' } }, vault, fetchImpl), /密钥/);
  await assert.rejects(extract('请核对', { ai: { mode: 'local', baseUrl: 'http://192.168.1.50/v1' } }, vault, fetchImpl), /本机地址/);
  assert.equal(fetched, 0);
});

test('AI 无明确期限不得编造日期，无效日历日期不能落库', async () => {
  const settings = { ai: { mode: 'cloud', baseUrl: 'https://api.example.test/v1', model: 'test-model' } };
  const vault = { async get() { return 'test-secret'; } };
  const respond = result => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
  const base = { isTask: true, title: '核对资料', priority: 2, notes: '' };
  const invented = await extract('请核对资料', settings, vault, respond({ ...base, dueDate: '2026-12-01' }));
  assert.equal(invented.dueDate, '');
  const impossible = await extract('请在2026-02-30核对资料', settings, vault, respond({ ...base, dueDate: '2026-02-30' }));
  assert.equal(impossible.dueDate, '');
});

test('AI 返回与原文不符的绝对期限时以原文明示日期为准', async () => {
  const settings = { ai: { mode: 'cloud', baseUrl: 'https://api.example.test/v1', model: 'test-model' } };
  const vault = { async get() { return 'test-secret'; } };
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isTask: true, title: '核对资料', dueDate: '2026-12-01', priority: 2 }) } }] }));
  const result = await extract('请在2026年10月27日核对资料', settings, vault, fetchImpl);
  assert.equal(result.dueDate, '2026-10-27');
});

test('AI 返回非布尔任务状态时拒绝，HTTP 异常不能伪报已完成提取', async () => {
  const settings = { ai: { mode: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'test' } };
  const vault = { async get() { return null; } };
  await assert.rejects(extract('请核对资料', settings, vault, async () => new Response('{}', { status: 503 })), /请求失败/);
  await assert.rejects(extract('请核对资料', settings, vault, async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"isTask":"true"}' } }] }))), /格式不正确/);
});

function collected(records,{complete=true,checkpoint={adapter:'dingtalk-dws',committedThrough:'2026-10-26T00:00:00Z'}}={}){
  return {records,complete,...(complete?{checkpoint}:{}),platformCollectedAt:'2026-10-26T01:00:00Z',fileProcessedAt:'2026-10-26T01:00:01Z',coverage:{mode:'dingtalk-dws',platformDirect:true,mediaReviewed:false}};
}
function directSource(overrides={}){return source({platform:'dingtalk',config:{collector:{kind:'dingtalk-dws',authorized:true}},...overrides});}
test('重复的已入库待办及非任务消息在AI前跳过，完整空增量保存no_new',async t=>{
  const f=fixture(t);const s=directSource();f.store.put('sources',s);
  const records=[row('task'),row('non-task','项目 A','今日工作进度平稳')];
  f.store.importMessage(s,records[0],{isTask:true,title:'已有卡片'});f.store.importMessage(s,records[1],{isTask:false});
  let calls=0;f.settings.ai={mode:'local',baseUrl:'http://127.0.0.1:11434/v1',model:'test'};
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('重复消息不应发给AI');});
  const sources=createSources({store:f.store,vault:{get:async()=>null},getSettings:()=>f.settings,collectors:{collect:async()=>collected(records)}});
  const result=await sources.sync(s.id);assert.equal(calls,0);assert.equal(result.duplicates,2);assert.equal(result.collectorStatus,'no_new');
  const saved=f.store.get('sources',s.id);assert.equal(saved.platformCollectedAt,'2026-10-26T01:00:00Z');assert.equal(saved.fileProcessedAt,'2026-10-26T01:00:01Z');assert.equal(saved.collectorStatus,'no_new');
});
test('部分采集保存取得的消息，不前移检查点、不刷新完整成功时间，重试去重后提交',async t=>{
  const f=fixture(t);const checkpoint={committedThrough:'2026-10-24T00:00:00Z'};const lastSuccessAt='2026-10-24T01:00:00Z';const s=directSource({checkpoint,lastSuccessAt});f.store.put('sources',s);
  let complete=false;const records=[row('first'),row('second')];
  const collectors={collect:async()=>collected(records.slice(0,complete?2:1),{complete})};
  const sources=createSources({store:f.store,vault:{get:async()=>null},getSettings:()=>f.settings,collectors});
  const partial=await sources.sync(s.id);assert.equal(partial.collectorStatus,'partial');assert.equal(partial.created,1);
  let saved=f.store.get('sources',s.id);assert.deepEqual(saved.checkpoint,checkpoint);assert.equal(saved.lastSuccessAt,lastSuccessAt);assert.equal(saved.status,'partial');
  complete=true;const retry=await sources.sync(s.id);assert.equal(retry.created,1);assert.equal(retry.duplicates,1);assert.equal(retry.complete,true);assert.equal(f.store.all('tasks').length,2);
  saved=f.store.get('sources',s.id);assert.equal(saved.checkpoint.committedThrough,'2026-10-26T00:00:00Z');assert.notEqual(saved.lastSuccessAt,lastSuccessAt);
});
test('平台取得后AI断网不提交检查点；关闭并重建SQLite实例重放时已落库消息不重复AI或建卡',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workboard-collector-restart-'));let store=createStore(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const old={committedThrough:'2026-10-24T00:00:00Z'};const s=directSource({checkpoint:old});store.put('sources',s);
  const records=[row('persisted-before-failure'),row('retry-after-network')];let calls=0;
  const settings={ai:{mode:'local',baseUrl:'http://127.0.0.1:11434/v1',model:'test'}};
  t.mock.method(globalThis,'fetch',async()=>{calls++;if(calls===2)throw Error('模拟网络中断');return new Response(JSON.stringify({choices:[{message:{content:'{"isTask":true,"title":"核对资料","priority":2}'}}]}));});
  const make=()=>createSources({store,vault:{get:async()=>null},getSettings:()=>settings,collectors:{collect:async()=>collected(records)}});
  await assert.rejects(make().sync(s.id),/网络中断/);assert.deepEqual(store.get('sources',s.id).checkpoint,old);assert.equal(store.all('tasks').length,1);assert.equal(store.get('sources',s.id).platformCollectedAt,'2026-10-26T01:00:00Z');
  store.close();store=createStore(dir);const retry=await make().sync(s.id);
  assert.equal(calls,3,'持久第一条在重启后不再调用AI');assert.equal(retry.duplicates,1);assert.equal(retry.created,1);assert.equal(store.all('tasks').length,2);
});
test('完整采集后入库失败仍保留旧检查点；取消正在采集的来源不写新检查点',async t=>{
  const f=fixture(t);const old={committedThrough:'2026-10-24T00:00:00Z'};const s=directSource({checkpoint:old});f.store.put('sources',s);
  const original=f.store.importMessage;f.store.importMessage=()=>{throw Error('模拟入库失败');};
  const ready=createSources({store:f.store,vault:{get:async()=>null},getSettings:()=>f.settings,collectors:{collect:async()=>collected([row('x')])}});
  await assert.rejects(ready.sync(s.id),/入库失败/);assert.deepEqual(f.store.get('sources',s.id).checkpoint,old);f.store.importMessage=original;
  const entered=deferred();const waiting=createSources({store:f.store,vault:{get:async()=>null},getSettings:()=>f.settings,collectors:{collect:async(s,{signal})=>{entered.resolve();await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Object.assign(Error('本次采集已取消'),{collectorStatus:'cancelled'})),{once:true});});}}});
  const pending=waiting.sync(s.id);await within(entered.promise);assert.equal(waiting.cancel(s.id),true);await assert.rejects(pending,/取消/);assert.equal(f.store.get('sources',s.id).collectorStatus,'cancelled');assert.deepEqual(f.store.get('sources',s.id).checkpoint,old);
});
test('本机文件整理只刷新fileProcessedAt，不冒充新的平台采集时间',async t=>{
  const f=fixture(t);const file=path.join(f.dir,'local.json');fs.writeFileSync(file,JSON.stringify([row('file-row')]));
  f.store.put('sources',source({config:{importPath:file},platformCollectedAt:'2026-10-20T00:00:00Z'}));
  await f.sources.sync('wx');const saved=f.store.get('sources','wx');assert.ok(saved.fileProcessedAt);assert.equal(saved.platformCollectedAt,'2026-10-20T00:00:00Z');assert.equal(saved.coverage.platformDirect,false);
});
for(const platform of ['wechat','dingtalk'])test(`${platform}同来源重绑本人另一账号后平台编号重合仍入库，SQLite重启后原账号重放继续去重`,async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workboard-account-rebind-'));let store=createStore(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  let aiCalls=0;const settings={ai:{mode:'local',baseUrl:'http://127.0.0.1:11434/v1',model:'isolated-rebind-test'}};
  t.mock.method(globalThis,'fetch',async()=>{aiCalls++;return new Response(JSON.stringify({choices:[{message:{content:'{"isTask":true,"title":"核对账号对应图纸","priority":2}'}}]}));});
  const identities=platform==='wechat'?['wxid_owner_a','wxid_owner_b']:['corp-a:user-a','corp-b:user-a'];
  const scope=[platform==='wechat'?'12345@chatroom':'cidSameGroup=='];
  const sourceFor=identity=>source({id:'same-persistent-source',platform,scope,checkpoint:{},config:{collector:{kind:platform==='wechat'?'wechat-export':'dingtalk-dws',authorized:true,...(platform==='wechat'?{accountId:identity}:{profile:identity})}}});
  const recordsFor=s=>platform==='wechat'?normalizeWechat({ok:true,accountId:s.config.collector.accountId,chats:[{username:scope[0],messages:[{source_db:'message/message_0.db',local_id:7,time:'2026-10-25T10:00:00+08:00',content:'请核对这个账号的图纸'}]}]},scope,s.config.collector.accountId):parseDwsLedger({messages:[{messageId:'same-platform-id',text:'请核对这个账号的图纸',createTime:'2026-10-25T10:00:00+08:00'}],complete:true,hasMore:false,paginationKnown:true},scope[0],undefined,s.config.collector.profile).records;
  const make=()=>createSources({store,vault:{get:async()=>null},getSettings:()=>settings,collectors:{collect:async s=>collected(recordsFor(s))}});
  const first=sourceFor(identities[0]);store.put('sources',first);assert.equal((await make().sync(first.id)).created,1);
  store.put('sources',sourceFor(identities[1]));const rebound=await make().sync(first.id);
  assert.equal(rebound.created,1,'清理检查点后不同账号消息应形成独立证据');assert.equal(rebound.duplicates,0);assert.equal(aiCalls,2);
  const refs=store.messages().map(message=>message.ref);assert.equal(new Set(refs).size,2);assert.equal(store.all('tasks').length,2);
  store.close();store=createStore(dir);
  store.put('sources',sourceFor(identities[1]));assert.equal((await make().sync(first.id)).duplicates,1);
  store.put('sources',sourceFor(identities[0]));assert.equal((await make().sync(first.id)).duplicates,1);
  assert.equal(aiCalls,2,'切换回来且SQLite重开后仍须在AI前持久去重');assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,2);assert.equal(store.all('tasks').length,2);
});
test('微信密钥缺失或快照不完整均不更新成功时间与检查点，probe只查询vault存在性',async t=>{
 const f=fixture(t);const previous='2026-10-24T00:00:00Z';const checkpoint={lastFullCollectionAt:previous};
 const s=source({scope:['12345@chatroom'],lastSuccessAt:previous,checkpoint,config:{collector:{kind:'wechat-export',executable:'python.exe',scriptPath:path.join(f.dir,'cli.py'),dbDir:f.dir,accountId:'wxid_self',authorized:true}}});f.store.put('sources',s);
 let decrypts=0;const vault={has:key=>{assert.equal(key,'source-wechat:wx');return false;},get:async key=>{assert.equal(key,'source-wechat:wx');decrypts++;return null;}};
 const sources=createSources({store:f.store,vault,getSettings:()=>f.settings});assert.equal((await sources.test(s.id)).status,'needs_credential');assert.equal(decrypts,0);
 await assert.rejects(sources.sync(s.id),e=>e.collectorStatus==='needs_credential');assert.equal(decrypts,1);
 let saved=f.store.get('sources',s.id);assert.equal(saved.lastSuccessAt,previous);assert.deepEqual(saved.checkpoint,checkpoint);
 const incomplete=createSources({store:f.store,vault,getSettings:()=>f.settings,collectors:{collect:async()=>{throw Object.assign(Error('快照不完整'),{collectorStatus:'snapshot_incomplete'});}}});
 await assert.rejects(incomplete.sync(s.id),/快照/);saved=f.store.get('sources',s.id);assert.equal(saved.lastSuccessAt,previous);assert.deepEqual(saved.checkpoint,checkpoint);assert.equal(saved.collectorStatus,'snapshot_incomplete');assert.equal(f.store.all('tasks').length,0);
});
