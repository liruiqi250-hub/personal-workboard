'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { shanghaiDate } = require('../server/extract.cjs');

const mainFile = path.resolve(__dirname, '../server/main.cjs');
const requireMain = createRequire(mainFile);

// Run the actual HTTP routes, scheduler, reports and SQLite store. Only external
// account adapters are replaced; importing main must not touch a user's account,
// register process signal handlers, or open the normal 18327 service/data folder.
function loadRuntime(dir, port, adapter) {
  const module = { exports: {} };
  const runtimeRequire = name => {
    if (name === '../server/wechat.cjs') return { WechatClient: function () {
      return { status: () => ({ status: 'unconfigured' }),
        sendText: async payload => { adapter.calls.push(payload); return adapter.send(payload); },
        stop() {} };
    } };
    if (name === '../server/codex.cjs') return { CodexController: function () {
      return { status: () => ({ status: 'unavailable', available: false }),
        listThreads: () => [], stop() {} };
    } };
    if (name === './vault.cjs') return { createVault: () => ({
      has: () => false, get: async () => null,
      set: async () => { throw Error('离线调度测试不允许写账号凭据'); }, delete: async () => {},
    }) };
    return requireMain(name);
  };
  runtimeRequire.main = null;
  const runtimeProcess = { env: { ...process.env, BOARD_DATA_DIR: dir, BOARD_PORT: String(port) },
    platform: process.platform, pid: process.pid, on() {},
    exit(code) { throw Error(`隔离服务意外请求退出：${code}`); } };
  const context = vm.createContext({ console, Buffer, URL, fetch, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval });
  const run = new vm.Script(`(function(require,module,exports,__filename,__dirname,process){\n${fs.readFileSync(mainFile, 'utf8')}\n})`,
    { filename: mainFile }).runInContext(context);
  run(runtimeRequire, module, module.exports, mainFile, path.dirname(mainFile), runtimeProcess);
  return module.exports;
}

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function fixture(t, { listen = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-scheduler-test-'));
  const port = listen ? await freePort() : 1;
  const adapter = { calls: [], send: async () => ({ accepted: true, messageId: 'offline-only' }) };
  let runtime = loadRuntime(dir, port, adapter);
  async function close() {
    if (!runtime) return;
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
    runtime.store.close(); runtime = null;
  }
  async function start() {
    await new Promise((resolve, reject) => { runtime.server.once('error', reject); runtime.server.listen(port, '127.0.0.1', resolve); });
  }
  if (listen) await start();
  const f = { dir, port, adapter, key: 'daily-attempt-' + shanghaiDate(),
    get app() { return runtime; },
    get job() { return runtime.store.getSetting(f.key, null); },
    async reopen() { await close(); runtime = loadRuntime(dir, port, adapter); if (listen) await start(); },
    async configure(extra = {}) { return runtime.api('settings.save', { dailyEnabled: true,
      reportTime: '00:00', workdays: [0, 1, 2, 3, 4, 5, 6], ...extra }); },
    async request(url, { method = 'GET', token, payload, origin } = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: url, method,
          headers: { Connection: 'close', ...(payload ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { 'X-Board-Token': token } : {}), ...(origin ? { Origin: origin } : {}) } }, res => {
          const parts = []; res.on('data', part => parts.push(part));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
            body: Buffer.concat(parts) }));
        });
        req.once('error', reject); req.end(payload ? JSON.stringify(payload) : undefined);
      });
    },
    async token() { return JSON.parse((await f.request('/api/session')).body).token; },
    async call(method, payload = {}, token) {
      const response = await f.request('/api/call', { method: 'POST', token: token || await f.token(),
        payload: { method, payload } });
      return { ...response, json: JSON.parse(response.body) };
    },
  };
  t.after(async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return f;
}

test('日报目录故障写入 generation_failed，反复 tick 和重启后可恢复且只生成发送一次', async t => {
  const f = await fixture(t); const reportDir = path.join(f.dir, 'scheduled');
  await f.configure({ reportDir });
  fs.rmdirSync(reportDir); fs.writeFileSync(reportDir, '目录故障模拟');
  await f.app.tick();
  assert.equal(f.job.state, 'generation_failed');
  assert.ok(f.job.message); assert.equal(f.app.store.all('reports').length, 0);
  assert.equal(f.adapter.calls.length, 0);
  await f.reopen(); assert.equal(f.job.state, 'generation_failed');
  await f.app.tick(); assert.equal(f.job.state, 'generation_failed');
  fs.unlinkSync(reportDir); fs.mkdirSync(reportDir);
  await f.app.api('report.retryDaily');
  assert.equal(f.job.state, 'accepted');
  assert.equal(f.app.store.all('reports').length, 1); assert.equal(f.adapter.calls.length, 1);
  assert.ok(fs.existsSync(f.app.store.get('reports', f.job.reportId).path));
  await f.app.tick(); await f.reopen(); await f.app.tick();
  assert.equal(f.job.state, 'accepted'); assert.equal(f.adapter.calls.length, 1);
  assert.equal(f.app.store.all('reports').length, 1);
});

test('日报先保存 generated 状态再发送，并发 tick 不创建第二份报告或重复发送', async t => {
  const f = await fixture(t); await f.configure();
  let finish; let reached; const sending = new Promise(resolve => { reached = resolve; });
  f.adapter.send = () => { reached(); return new Promise(resolve => { finish = resolve; }); };
  const pending = f.app.tick(); await sending;
  assert.equal(f.job.state, 'generated'); assert.ok(f.job.reportId);
  assert.equal(f.app.store.all('reports').length, 1);
  assert.equal(f.app.store.all('deliveries')[0].status, 'sending');
  await f.app.tick(); assert.equal(f.adapter.calls.length, 1);
  finish({ accepted: true }); await pending;
  assert.equal(f.job.state, 'accepted'); assert.equal(f.app.store.all('reports').length, 1);
});

test('发送失败保留 needs_confirmation 与 unknown，重启不自动重发，本人核对后复用原报告', async t => {
  const f = await fixture(t); await f.configure();
  f.adapter.send = async () => { throw Error('离线模拟：微信返回前连接中断'); };
  await f.app.tick();
  assert.equal(f.job.state, 'needs_confirmation'); const reportId = f.job.reportId;
  const delivery = f.app.store.all('deliveries')[0]; assert.equal(delivery.status, 'unknown');
  await f.app.tick(); await f.reopen(); await f.app.tick();
  assert.equal(f.job.state, 'needs_confirmation'); assert.equal(f.adapter.calls.length, 1);
  await assert.rejects(f.app.api('report.retryDaily'), /核对|重复/);
  assert.equal(f.adapter.calls.length, 1);
  await f.app.api('delivery.resolve', { id: delivery.id, decision: 'not_received' });
  f.adapter.send = async () => ({ accepted: true });
  await f.app.api('report.retryDaily');
  assert.equal(f.job.state, 'accepted'); assert.equal(f.job.reportId, reportId);
  assert.equal(f.app.store.all('reports').length, 1);
  assert.equal(f.app.store.all('deliveries').length, 2); assert.equal(f.adapter.calls.length, 2);
  await f.app.tick(); await f.reopen(); await f.app.tick();
  assert.equal(f.adapter.calls.length, 2);
});

test('重启恢复已生成未发送的报告，复用报告文件而非再次生成新修订', async t => {
  const f = await fixture(t); await f.configure();
  const report = await f.app.saveReport({ type: 'daily', format: 'html' });
  f.app.store.setSetting(f.key, { at: new Date().toISOString(), state: 'generated', reportId: report.id });
  await f.reopen(); await f.app.tick();
  assert.equal(f.job.state, 'accepted'); assert.equal(f.job.reportId, report.id);
  assert.equal(f.app.store.all('reports').length, 1); assert.equal(f.adapter.calls.length, 1);
});

test('生成中断超过恢复窗口可重试，刚开始的 generating 状态不会被并发重建', async t => {
  const f = await fixture(t); await f.configure();
  f.app.store.setSetting(f.key, { at: new Date().toISOString(), state: 'generating' });
  await f.reopen(); await f.app.tick();
  assert.equal(f.job.state, 'generating'); assert.equal(f.adapter.calls.length, 0);
  f.app.store.setSetting(f.key, { at: new Date(Date.now() - 11 * 60_000).toISOString(), state: 'generating' });
  await f.reopen(); await f.app.tick();
  assert.equal(f.job.state, 'accepted'); assert.equal(f.app.store.all('reports').length, 1);
  assert.equal(f.adapter.calls.length, 1);
});

test('发送中崩溃后的遗留 sending 必须可明确核对，不能自动重发或永久无恢复出口', async t => {
  const f = await fixture(t); await f.configure();
  const report = await f.app.saveReport({ type: 'daily', format: 'html' });
  f.app.store.setSetting(f.key, { at: new Date().toISOString(), state: 'generated', reportId: report.id });
  f.app.store.put('deliveries', { id: 'crash-in-send', reportId: report.id, date: report.endDate,
    revision: report.revision, createdAt: new Date().toISOString(), status: 'sending', scheduled: true });
  await f.reopen(); await f.app.tick();
  assert.equal(f.job.state, 'needs_confirmation'); assert.equal(f.adapter.calls.length, 0);
  await assert.rejects(f.app.api('report.retryDaily'), /核对|重复/);
  await f.app.api('delivery.resolve', { id: 'crash-in-send', decision: 'not_received' });
  await f.app.api('report.retryDaily');
  assert.equal(f.job.state, 'accepted'); assert.equal(f.job.reportId, report.id);
  assert.equal(f.app.store.all('reports').length, 1); assert.equal(f.adapter.calls.length, 1);
});

test('真实 HTTP API 重启后保留任务、范围、设置、报告下载和已接受日报锁，旧 token 失效', async t => {
  const f = await fixture(t, { listen: true });
  const token = await f.token();
  const task = (await f.call('task.create', { title: '隔离 HTTP 重启测试', status: 'waiting' }, token)).json;
  const source = (await f.call('source.save', { name: '隔离手动来源', platform: 'manual',
    scope: ['本人范围'], enabled: false }, token)).json;
  assert.equal(task.ok, true); assert.equal(source.ok, true);
  await f.configure({ name: '离线测试员' });
  const exported = (await f.call('report.export', { type: 'daily', format: 'docx' }, token)).json;
  assert.equal(exported.ok, true); const report = exported.data;
  const before = await f.request(report.downloadUrl); assert.equal(before.status, 200);
  assert.equal(before.body.subarray(0, 2).toString(), 'PK');
  await f.app.tick(); assert.equal(f.job.state, 'accepted');
  await f.reopen();
  const boot = (await f.call('bootstrap')).json; assert.equal(boot.ok, true);
  assert.ok(boot.data.tasks.some(row => row.id === task.data.id));
  assert.equal(boot.data.sources.find(row => row.id === source.data.id).scope[0], '本人范围');
  assert.equal(boot.data.settings.name, '离线测试员');
  assert.ok(boot.data.reports.some(row => row.id === report.id));
  assert.equal(boot.data.schedule.daily.state, 'accepted');
  const after = await f.request(report.downloadUrl); assert.equal(after.status, 200);
  assert.equal(createHash('sha256').update(after.body).digest('hex'), createHash('sha256').update(before.body).digest('hex'));
  assert.equal((await f.call('bootstrap', {}, token)).status, 403);
  const outside = await f.request('/api/call', { method: 'POST', token: await f.token(),
    origin: 'https://outside.invalid', payload: { method: 'task.create', payload: { title: '必须拒绝' } } });
  assert.equal(outside.status, 403);
  await f.app.tick(); assert.equal(f.adapter.calls.length, 1);
  const retry = await f.call('report.retryDaily'); assert.equal(retry.json.ok, false);
  assert.equal(f.adapter.calls.length, 1);
});
