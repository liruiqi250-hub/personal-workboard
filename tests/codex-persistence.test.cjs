'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { CodexController } = require('../server/codex.cjs');
const { createStore } = require('../server/store.cjs');
const { createManagedCodexStore, MANAGED_CODEX_KEY } = require('../server/managed-codex-store.cjs');

async function until(predicate) {
  const limit = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > limit) throw new Error('等待离线协议事件超时');
    await new Promise(resolve => setTimeout(resolve, 3));
  }
}
function fakeCodex() {
  const requests = []; const apps = []; const threadDirs = new Map(); let sequence = 0;
  const fake = { requests, apps, beforeReply: null, response: null,
    get app() { return apps.at(-1); },
    spawn(executable, args, options) {
      assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
      child.kill = () => { if (child.exitCode == null) { child.exitCode = 0; child.stdout.end(); child.emit('exit', 0); } return true; };
      child.send = value => { if (child.exitCode == null) child.stdout.write(JSON.stringify(value) + '\n'); };
      let buffer = '';
      child.stdin = new Writable({ write(chunk, encoding, done) {
        buffer += chunk.toString();
        while (buffer.includes('\n')) {
          const position = buffer.indexOf('\n'); const line = buffer.slice(0, position); buffer = buffer.slice(position + 1);
          if (!line) continue;
          const req = JSON.parse(line); requests.push(req);
          if (!req.method || req.id == null) continue;
          let result = {};
          if (req.method === 'thread/start') {
            const id = `managed-${++sequence}`; threadDirs.set(id, req.params.cwd);
            result = { cwd: req.params.cwd, thread: { id, cwd: req.params.cwd, status: { type: 'idle' } } };
          } else if (req.method === 'thread/resume') {
            result = { cwd: threadDirs.get(req.params.threadId), thread: { id: req.params.threadId,
              cwd: threadDirs.get(req.params.threadId), status: { type: 'idle' } } };
          } else if (req.method === 'turn/start') result = { turn: { id: `turn-${++sequence}`, status: 'inProgress' } };
          else if (req.method === 'account/read') throw new Error('持久化验证不应访问真实账号接口');
          if (fake.response) result = fake.response(req, result);
          queueMicrotask(() => { fake.beforeReply?.(req, result); child.send({ id: req.id, result }); });
        }
        done();
      }, final(done) { child.kill(); done(); } });
      if (args[0] === '--version') queueMicrotask(() => { child.stdout.write('codex-cli offline-fixture\n'); child.kill(); });
      else apps.push(child);
      return child;
    },
    complete(run, items = []) {
      this.app.send({ method: 'turn/completed', params: { threadId: run.threadId,
        turn: { id: run.turnId, status: 'completed', items } } });
    },
  };
  return fake;
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-codex-persistence-'));
  const project = path.join(dir, 'project'); const other = path.join(dir, 'other');
  fs.mkdirSync(project); fs.mkdirSync(other);
  const fake = fakeCodex(); const clients = []; const stores = new Set();
  const settings = { wechatRemoteEnabled: true, allowedProjects: [project] };
  let store = createStore(path.join(dir, 'data')); stores.add(store);
  function open(overrides = {}) {
    const events = []; const approvals = [];
    const client = CodexController({ getSettings: () => settings, spawn: fake.spawn, executable: 'offline-codex.exe',
      persistence: createManagedCodexStore(store), onOutput: value => events.push(value),
      onApproval: value => approvals.push(value), requestTimeoutMs: 1000, ...overrides });
    clients.push(client); return { client, events, approvals };
  }
  async function restart(current, overrides) {
    await current.stop(); store.close(); stores.delete(store);
    store = createStore(path.join(dir, 'data')); stores.add(store);
    return open(overrides);
  }
  t.after(async () => {
    // Stop before closing SQLite so lifecycle state can still be committed.
    for (const client of clients.reverse()) if (client.child) await client.stop();
    for (const value of stores) value.close();
    const resolved = fs.realpathSync(dir);
    assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { dir, project, other, fake, settings, open, restart, get store() { return store; } };
}
const call = action => Promise.resolve().then(action);

test('真实 SQLite 重开后仅恢复本组件会话、结果、最近ID；明确继续验证同ID同cwd', async t => {
  const f = fixture(t); const first = f.open();
  const run = await first.client.run({ prompt: '只测试离线协议', cwd: f.project, requestId: 'wx-first' });
  const text = '完整结果。'.repeat(25000);
  f.fake.complete(run, [{ type: 'agentMessage', id: 'answer', text }]);
  await until(() => first.events.some(event => event.type === 'completed'));
  const second = await f.restart(first.client);
  assert.equal(second.client.getLastThreadId(), run.threadId);
  assert.equal(second.client.getResult(run.threadId).text, text);
  assert.equal(second.client.getResult(run.threadId).cwd, fs.realpathSync(f.project));
  assert.equal(second.client.getResult('desktop-chat'), null);
  assert.equal(second.client.listThreads()[0].status, 'completed');
  const before = f.fake.requests.length;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.fake.requests.length, before, '构造及恢复不创建 app-server 或提交原任务');
  const resumed = await second.client.resume({ threadId: run.threadId, prompt: '明确继续', requestId: 'wx-next' });
  assert.equal(resumed.threadId, run.threadId); assert.notEqual(resumed.turnId, run.turnId);
  assert.equal(f.fake.requests.filter(req => req.method === 'thread/start').length, 1);
  assert.ok(!f.fake.requests.some(req => ['thread/list', 'thread/read', 'account/read'].includes(req.method)));
});

test('审批状态跨重启为待核对，不重发、不恢复旧审批和旧轮通知', async t => {
  const f = fixture(t); const first = f.open();
  const run = await first.client.run({ prompt: '审批测试', cwd: f.project, requestId: 'wx-approval' });
  f.fake.app.send({ id: 'old-rpc', method: 'item/commandExecution/requestApproval', params: {
    threadId: run.threadId, turnId: run.turnId, command: 'fixture-command' } });
  await until(() => first.approvals.length === 1);
  const code = first.approvals[0].code;
  // Capture a crash image while the turn and approval are active, then restore it after orderly fixture cleanup.
  const crashImage = f.store.getSetting(MANAGED_CODEX_KEY);
  await first.client.stop(); f.store.setSetting(MANAGED_CODEX_KEY, crashImage);
  const second = f.open();
  assert.equal(second.client.listThreads()[0].status, 'needs_review');
  assert.equal(second.client.listThreads()[0].turnId, null);
  assert.equal(second.client.approvals.size, 0);
  await assert.rejects(second.client.approve({ code, decision: 'accept' }), /已使用或已过期/);
  await second.client.ensureReady();
  const turnCount = f.fake.requests.filter(req => req.method === 'turn/start').length;
  f.fake.app.send({ id: 'old-rpc', method: 'item/commandExecution/requestApproval', params: { threadId: run.threadId, turnId: run.turnId } });
  f.fake.app.send({ method: 'item/agentMessage/delta', params: { threadId: run.threadId, turnId: run.turnId, delta: '旧文字' } });
  f.fake.complete(run, [{ type: 'agentMessage', id: 'old-answer', text: '不能复活' }]);
  await until(() => f.fake.requests.some(req => req.id === 'old-rpc' && req.error));
  assert.equal(second.events.length, 1, '只允许报告旧审批被拒绝，不回传旧完成/正文');
  assert.equal(second.events[0].type, 'error');
  assert.equal(f.fake.requests.filter(req => req.method === 'turn/start').length, turnCount);
  assert.equal(second.client.getResult(run.threadId), null);
});

test('请求账本跨 Controller 拒绝相同和改写ID重放；同进程仍去重', async t => {
  const f = fixture(t); const first = f.open(); const input = { prompt: '去重', cwd: f.project, requestId: 'wx-dedup' };
  const [one, two] = await Promise.all([first.client.run(input), first.client.run(input)]);
  assert.equal(one.turnId, two.turnId); f.fake.complete(one);
  await until(() => first.client.listThreads()[0].status === 'completed');
  const second = await f.restart(first.client); const before = f.fake.requests.length;
  await assert.rejects(call(() => second.client.run(input)), /不自动重放/);
  await assert.rejects(call(() => second.client.run({ ...input, prompt: '改写' })), /不同内容/);
  assert.equal(f.fake.requests.length, before);
});

test('授权撤回或移除目录后拒绝持久会话续接；陌生桌面ID始终拒绝', async t => {
  const f = fixture(t); const first = f.open(); const run = await first.client.run({ prompt: '新建', cwd: f.project });
  const second = await f.restart(first.client); const before = f.fake.requests.length;
  f.settings.wechatRemoteEnabled = false;
  await assert.rejects(call(() => second.client.resume({ threadId: run.threadId, prompt: '继续' })), /尚未开启/);
  f.settings.wechatRemoteEnabled = true; f.settings.allowedProjects = [f.other];
  await assert.rejects(call(() => second.client.resume({ threadId: run.threadId, prompt: '继续' })), /不在本机已授权/);
  await assert.rejects(call(() => second.client.resume({ threadId: 'desktop-original', prompt: '继续' })), /只能继续/);
  assert.equal(f.fake.requests.length, before);
});

test('thread/resume 返回陌生ID、错误目录、缺目录或活动会话时不提交新turn', async t => {
  const f = fixture(t); const first = f.open(); const run = await first.client.run({ prompt: '新建', cwd: f.project });
  const second = await f.restart(first.client);
  const turnCount = () => f.fake.requests.filter(req => req.method === 'turn/start').length;
  const before = turnCount();
  const cases = [
    [result => ({ ...result, thread: { ...result.thread, id: 'desktop-original' } }), /ID 与请求不一致/],
    [result => ({ ...result, cwd: f.other, thread: { ...result.thread, cwd: f.other } }), /授权|目录/],
    [result => ({ thread: { id: result.thread.id } }), /未返回可核对/],
    [result => ({ ...result, thread: { ...result.thread, status: { type: 'active', activeFlags: [] } } }), /仍在运行/],
  ];
  for (let index = 0; index < cases.length; index++) {
    const [mutate, pattern] = cases[index];
    f.fake.response = (req, result) => req.method === 'thread/resume' ? mutate(result) : result;
    await assert.rejects(second.client.resume({ threadId: run.threadId, prompt: '继续', requestId: `bad-${index}` }), pattern);
    assert.equal(turnCount(), before);
  }
});

test('续接响应期间撤回授权也阻止turn/start', async t => {
  const f = fixture(t); const first = f.open(); const run = await first.client.run({ prompt: '新建', cwd: f.project });
  const second = await f.restart(first.client); const before = f.fake.requests.filter(req => req.method === 'turn/start').length;
  f.fake.beforeReply = req => { if (req.method === 'thread/resume') f.settings.wechatRemoteEnabled = false; };
  await assert.rejects(second.client.resume({ threadId: run.threadId, prompt: '继续', requestId: 'withdraw-during-resume' }), /尚未开启/);
  assert.equal(f.fake.requests.filter(req => req.method === 'turn/start').length, before);
});

test('threadId 必须在 turn/start 前落盘；请求预留或会话保存失败都阻止turn', async t => {
  for (const failStage of ['reserve', 'thread', 'pre-turn']) {
    const f = fixture(t); const adapter = createManagedCodexStore(f.store);
    let threadSaves = 0;
    const first = f.open({ persistence: {
      load: adapter.load,
      save: state => {
        if (state.threads.length) threadSaves++;
        if (failStage === 'reserve' || failStage === 'thread' && threadSaves === 1 || failStage === 'pre-turn' && threadSaves === 2) throw new Error('模拟磁盘满');
        adapter.save(state);
      },
    } });
    await assert.rejects(call(() => first.client.run({ prompt: '不要提交', cwd: f.project, requestId: failStage })), /持久化失败/);
    assert.equal(f.fake.requests.filter(req => req.method === 'turn/start').length, 0);
    assert.equal(f.fake.requests.filter(req => req.method === 'thread/start').length, failStage === 'reserve' ? 0 : 1);
    await assert.rejects(call(() => first.client.run({ prompt: '仍不能提交', cwd: f.project, requestId: failStage + '-again' })), /持久化失败/);
  }
});

test('真实SQLite中的ID已保存后才写turn/start，并完整保存多个消息而不截断', async t => {
  const f = fixture(t); const first = f.open();
  f.fake.beforeReply = req => {
    if (req.method === 'turn/start') {
      const saved = f.store.getSetting(MANAGED_CODEX_KEY);
      assert.ok(saved.threads.some(thread => thread.id === req.params.threadId && path.isAbsolute(thread.cwd)));
      assert.ok(saved.requests.some(entry => entry.id === 'ordered' && entry.state === 'reserved'));
    }
  };
  const run = await first.client.run({ prompt: '保存顺序', cwd: f.project, requestId: 'ordered' });
  const long = '中'.repeat(130000);
  f.fake.complete(run, [{ type: 'agentMessage', id: 'a', text: '第一段' }, { type: 'agentMessage', id: 'b', text: long }]);
  await until(() => first.events.some(event => event.type === 'completed'));
  assert.equal(first.client.getResult(run.threadId).text, '第一段\n\n' + long);
  assert.equal(first.events.find(event => event.type === 'completed').text, '第一段\n\n' + long);
});

test('artifacts只来自本轮成功新增或更新补丁；文字文件名、删除、失败、外轮与越界不登记', async t => {
  const f = fixture(t); const first = f.open(); const run = await first.client.run({ prompt: '本轮产物', cwd: f.project });
  const change = (filename, kind = 'add') => ({ path: filename, kind: { type: kind }, diff: 'fixture' });
  const patch = (id, status, changes) => ({ id, type: 'fileChange', status, changes });
  f.fake.app.send({ method: 'item/completed', params: { threadId: run.threadId, turnId: 'foreign-turn',
    item: patch('foreign', 'completed', [change('foreign.pdf')]) } });
  f.fake.complete(run, [
    { type: 'agentMessage', id: 'final', text: '另有 C:\\private\\secret.pdf，不能解析为产物' },
    patch('new', 'completed', [change('new.pdf'), change('changed.docx', 'update'), change('deleted.pdf', 'delete'), change('../outside.pdf')]),
    patch('bad', 'failed', [change('failed.pdf')]),
    { type: 'commandExecution', id: 'command', status: 'completed', aggregatedOutput: 'created guessed.pdf' },
  ]);
  await until(() => first.events.some(event => event.type === 'completed'));
  const result = first.client.getResult(run.threadId);
  assert.deepEqual(result.artifacts.map(value => path.basename(value.path)), ['new.pdf', 'changed.docx']);
  assert.ok(result.artifacts.every(value => value.turnId === run.turnId && value.source === 'fileChange'));
  const second = await f.restart(first.client);
  assert.deepEqual(second.client.getResult(run.threadId).artifacts, result.artifacts);
});

test('恢复格式错误和异步持久层明确拒绝，不能静默丢弃账本', t => {
  const f = fixture(t);
  assert.throws(() => f.open({ persistence: { load: () => ({ schemaVersion: 0 }), save() {} } }), /格式无效/);
  assert.throws(() => f.open({ persistence: { load: () => Promise.resolve(null), save() {} } }), /同步/);
  const first = f.open({ persistence: { load: () => null, save: () => Promise.resolve() } });
  assert.throws(() => first.client.run({ prompt: '测试', cwd: f.project }), /持久化失败/);
  assert.equal(f.fake.requests.length, 0);
});

test('崩溃快照中的 starting、running 和 resuming 均只恢复为待核对，旧审批字段不载入', async t => {
  const f = fixture(t); const first = f.open();
  const run = await first.client.run({ prompt: '崩溃快照', cwd: f.project, requestId: 'crash' });
  const snapshot = f.store.getSetting(MANAGED_CODEX_KEY); await first.client.stop();
  for (const status of ['starting', 'running', 'resuming']) {
    const state = structuredClone(snapshot);
    Object.assign(state.threads[0], { status, starting: status === 'starting', resuming: status === 'resuming' });
    state.approvals = [{ code: 'OLD', rpcId: 1 }];
    f.store.setSetting(MANAGED_CODEX_KEY, state);
    const before = f.fake.requests.length; const restored = f.open();
    assert.equal(restored.client.listThreads()[0].status, 'needs_review');
    assert.equal(restored.client.approvals.size, 0);
    assert.equal(f.fake.requests.length, before);
    await assert.rejects(restored.client.approve({ code: 'OLD', decision: 'accept' }), /审批码无效/);
  }
  assert.equal(first.client.getLastThreadId(), run.threadId);
});

test('历史轮次的完成和审批在下一轮等待响应时也不能复活', async t => {
  const f = fixture(t); const first = f.open();
  const older = await first.client.run({ prompt: '第一轮', cwd: f.project });
  f.fake.complete(older, [{ type: 'agentMessage', id: 'first', text: '第一轮结果' }]);
  await until(() => first.client.getResult(older.threadId));
  f.fake.beforeReply = (req, result) => {
    if (req.method !== 'turn/start') return;
    f.fake.app.send({ method: 'turn/started', params: { threadId: older.threadId, turn: { id: 'unconfirmed-older-turn' } } });
    f.fake.app.send({ id: 'unknown-old-rpc', method: 'item/commandExecution/requestApproval', params: {
      threadId: older.threadId, turnId: 'unconfirmed-older-turn', command: '旧轮次未记录也不能复活' } });
    f.fake.app.send({ id: 'retired-rpc', method: 'item/commandExecution/requestApproval', params: {
      threadId: older.threadId, turnId: older.turnId, command: '不得复活' } });
    f.fake.app.send({ method: 'item/completed', params: { threadId: older.threadId, turnId: older.turnId,
      item: { id: 'stale', type: 'agentMessage', text: '旧任务输出' } } });
    f.fake.complete(older, [{ type: 'agentMessage', id: 'stale-final', text: '旧任务完成' }]);
  };
  const next = await first.client.resume({ threadId: older.threadId, prompt: '第二轮', requestId: 'second' });
  assert.notEqual(next.turnId, older.turnId);
  assert.equal(first.approvals.length, 0);
  assert.equal(f.fake.requests.find(req => req.id === 'retired-rpc').error.code, -32601);
  assert.equal(f.fake.requests.find(req => req.id === 'unknown-old-rpc').error.code, -32601);
  assert.equal(first.client.getResult(older.threadId).text, '第一轮结果');
  assert.equal(first.events.filter(event => event.type === 'completed').length, 1);
});

test('完成结果保存失败时不发 completed，不把未落盘正文当已登记结果回传', async t => {
  const f = fixture(t); const adapter = createManagedCodexStore(f.store); let fail = false;
  const first = f.open({ persistence: { load: adapter.load, save: state => {
    if (fail) throw new Error('模拟结果落盘失败'); adapter.save(state);
  } } });
  const run = await first.client.run({ prompt: '结果保存失败', cwd: f.project, requestId: 'completion-save-fail' });
  fail = true;
  f.fake.complete(run, [{ type: 'agentMessage', id: 'result', text: '尚未落盘' }]);
  await until(() => first.client.persistenceFault);
  assert.equal(first.events.filter(event => event.type === 'completed').length, 0);
  assert.equal(first.client.getResult(run.threadId), null);
  assert.ok(first.events.some(event => event.type === 'error' && /持久化失败/.test(event.text)));
  assert.equal((await first.client.status()).available, false);
  assert.match((await first.client.status()).lastError, /持久化失败/);
});

test('turn/start响应前的本轮审批缓冲到实际ID确认后，落盘失败不授予执行', async t => {
  const f = fixture(t); const adapter = createManagedCodexStore(f.store); let fail = false;
  const first = f.open({ persistence: { load: adapter.load, save: state => {
    if (fail) throw new Error('模拟审批前磁盘故障'); adapter.save(state);
  } } });
  f.fake.beforeReply = (req, result) => {
    if (req.method !== 'turn/start') return;
    f.fake.app.send({ id: 'early-approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: req.params.threadId, turnId: result.turn.id, command: 'fixture-command' } });
    assert.equal(first.approvals.length, 0, '拿到真实turn ID之前不能生成可批准审批码');
  };
  const run = await first.client.run({ prompt: '早到审批', cwd: f.project });
  assert.equal(first.approvals.length, 1); assert.equal(first.approvals[0].turnId, run.turnId);
  fail = true;
  await assert.rejects(first.client.approve({ code: first.approvals[0].code, decision: 'accept' }), /持久化失败/);
  assert.ok(!f.fake.requests.some(req => req.id === 'early-approval' && req.result?.decision === 'accept'));
});

test('8156字符命令的隐藏尾部不会被截断展示后授权，明确拒绝且不创建审批码', async t => {
  const f = fixture(t); const first = f.open();
  const run = await first.client.run({ prompt: '审批截断回归，无真实命令', cwd: f.project });
  const hidden = '; HIDDEN_TAIL_OPERATION'; const command = 'x'.repeat(8156 - hidden.length) + hidden;
  assert.equal(command.length, 8156);
  f.fake.app.send({ id: 'oversized-command', method: 'item/commandExecution/requestApproval', params: {
    threadId: run.threadId, turnId: run.turnId, itemId: 'long', command, cwd: f.project, reason: '仅测试协议' } });
  await until(() => f.fake.requests.some(req => req.id === 'oversized-command'));
  assert.equal(first.approvals.length, 0); assert.equal(first.client.approvals.size, 0);
  assert.equal(f.fake.requests.find(req => req.id === 'oversized-command').error.code, -32602);
  assert.ok(first.events.some(event => /已拒绝.*本机/.test(event.text)));
  assert.ok(!f.fake.requests.some(req => req.id === 'oversized-command' && req.result?.decision === 'accept'));
});

test('审批决策字段超长、类型不符、未知字段或不支持的授权范围全部拒绝', async t => {
  const f = fixture(t); const first = f.open();
  const run = await first.client.run({ prompt: '审批边界，无真实命令', cwd: f.project });
  const commandMethod = 'item/commandExecution/requestApproval';
  const fileMethod = 'item/fileChange/requestApproval'; const permissionsMethod = 'item/permissions/requestApproval';
  const common = { threadId: run.threadId, turnId: run.turnId, itemId: 'item', reason: '展示整个请求' };
  const cases = [
    [commandMethod, { command: ['fixture'] }],
    [commandMethod, { command: 123 }],
    [commandMethod, { command: null }],
    [commandMethod, { command: 'fixture', reason: 'x'.repeat(2001) }],
    [commandMethod, { command: 'fixture', reason: { hidden: 'operation' } }],
    [commandMethod, { command: 'fixture', cwd: 'x'.repeat(2001) }],
    [commandMethod, { command: 'fixture', cwd: { path: f.project } }],
    [commandMethod, { command: 'fixture', cwd: f.project + '\nHIDDEN' }],
    [fileMethod, { grantRoot: 'x'.repeat(2001) }],
    [fileMethod, { grantRoot: [f.project] }],
    [fileMethod, { grantRoot: f.other }],
    [commandMethod, { command: 'fixture', networkApprovalContext: 'https://example.test' }],
    [commandMethod, { command: 'fixture', networkApprovalContext: { host: 'x'.repeat(2001), protocol: 'https' } }],
    [commandMethod, { command: 'fixture', networkApprovalContext: { host: 123, protocol: 'https' } }],
    [commandMethod, { command: 'fixture', networkApprovalContext: { host: 'example.test', protocol: 'unknown' } }],
    [commandMethod, { command: 'fixture', networkApprovalContext: { host: 'example.test', protocol: 'https', hidden: true } }],
    [permissionsMethod, { cwd: f.project, permissions: 'all' }],
    [permissionsMethod, { cwd: f.project, permissions: { network: { enabled: 'true' } } }],
    [permissionsMethod, { cwd: f.project, permissions: { network: { enabled: true, hidden: true } } }],
    [permissionsMethod, { cwd: f.project, permissions: { fileSystem: { write: 'all' } } }],
    [permissionsMethod, { cwd: f.project, permissions: { fileSystem: { read: ['x'.repeat(2001)] } } }],
    [permissionsMethod, { cwd: f.project, permissions: { fileSystem: { write: Array(33).fill(f.project) } } }],
    [permissionsMethod, { cwd: f.project, permissions: { fileSystem: { write: Array(10).fill('中'.repeat(600)) } } }],
    [permissionsMethod, { cwd: f.project, permissions: { fileSystem: { entries: [{ access: 'admin', path: { type: 'path', path: f.project } }] } } }],
    [commandMethod, { command: 'fixture', environmentId: 'another-environment' }],
    [commandMethod, { command: 'fixture', kind: 'writeStdin' }],
    [commandMethod, { command: 'fixture', proposedExecpolicyAmendment: ['permit-future'] }],
    [commandMethod, { command: 'fixture', proposedNetworkPolicyAmendments: [{ action: 'allow', host: 'example.test' }] }],
    [commandMethod, { command: 'fixture', hiddenPolicy: 'allow-future' }],
  ];
  for (let index = 0; index < cases.length; index++) {
    const [method, fields] = cases[index]; const id = `unsupported-approval-${index}`;
    f.fake.app.send({ id, method, params: { ...common, ...fields } });
    await until(() => f.fake.requests.some(req => req.id === id));
    const response = f.fake.requests.find(req => req.id === id);
    assert.equal(response.error?.code, -32602, `case ${index} 必须明确拒绝`);
    assert.equal(first.approvals.length, 0, `case ${index} 不得创建可批准码`);
    assert.equal(first.client.approvals.size, 0);
  }
});

test('合法审批完整展示原请求且不可变；单次批准使用同一RPC和完全一致的权限', async t => {
  const f = fixture(t); const first = f.open();
  const run = await first.client.run({ prompt: '完整审批一致性，无真实命令', cwd: f.project });
  const command = 'C'.repeat(7999) + ';';
  const commandRequest = { threadId: run.threadId, turnId: run.turnId, itemId: 'command-item',
    command, cwd: f.project, reason: 'R'.repeat(2000), networkApprovalContext: { host: 'example.test', protocol: 'https' } };
  f.fake.app.send({ id: 'exact-command-rpc', method: 'item/commandExecution/requestApproval', params: commandRequest });
  await until(() => first.approvals.length === 1);
  const shown = first.approvals[0];
  assert.equal(shown.command, command); assert.equal(shown.reason, commandRequest.reason); assert.equal(shown.cwd, f.project);
  assert.deepEqual(shown.network, commandRequest.networkApprovalContext); assert.deepEqual(shown.request, commandRequest);
  assert.throws(() => { shown.command = 'OTHER'; }, TypeError);
  assert.throws(() => { shown.request.command = 'OTHER'; }, TypeError);
  await first.client.approve({ code: shown.code, decision: 'accept', threadId: run.threadId, turnId: run.turnId });
  assert.deepEqual(f.fake.requests.find(req => req.id === 'exact-command-rpc').result, { decision: 'accept' });
  const permissions = { network: { enabled: true }, fileSystem: {
    read: [f.project], write: [path.join(f.project, 'output')], globScanMaxDepth: 2,
    entries: [{ access: 'read', path: { type: 'path', path: f.project } }],
  } };
  const permissionRequest = { threadId: run.threadId, turnId: run.turnId, itemId: 'permission-item',
    cwd: f.project, reason: '所有权限字段完整展示', permissions };
  f.fake.app.send({ id: 'exact-permissions-rpc', method: 'item/permissions/requestApproval', params: permissionRequest });
  await until(() => first.approvals.length === 2);
  const shownPermission = first.approvals[1];
  assert.deepEqual(shownPermission.permissions, permissions); assert.deepEqual(shownPermission.request, permissionRequest);
  assert.throws(() => { shownPermission.permissions.fileSystem.write.push(f.other); }, TypeError);
  assert.throws(() => { shownPermission.request.permissions.network.enabled = false; }, TypeError);
  await first.client.approve({ code: shownPermission.code, decision: 'accept' });
  assert.deepEqual(f.fake.requests.find(req => req.id === 'exact-permissions-rpc').result, { permissions, scope: 'turn' });
});
