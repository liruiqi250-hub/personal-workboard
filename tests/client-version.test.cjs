'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const moduleReady = import('../src/client-version.mjs');
const health = version => ({ ok: true, service: 'personal-workboard', host: '127.0.0.1', version });
const response = value => ({ ok: true, text: async () => JSON.stringify(value) });

test('版本检测核验服务身份与版本格式，升级和回退版本都可识别', async () => {
  const { healthVersion } = await moduleReady;
  for (const version of ['0.3.7', '0.3.6', '0.3.8-preview.1']) assert.equal(healthVersion(health(version)), version);
  for (const value of [null, {}, { ...health('0.3.7'), ok: false }, { ...health('0.3.7'), service: 'other' }, { ...health('0.3.7'), host: '0.0.0.0' }, health('<script>'), health('0.3')]) assert.equal(healthVersion(value), null);
});

test('探测只读无缓存health，不读取业务数据；重复事件共用在途探测', async () => {
  const { createVersionMonitor } = await moduleReady;
  let finish; const calls = []; const states = [];
  const monitor = createVersionMonitor({ fetchImpl: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); }, onState: state => states.push(state) });
  const first = monitor.check(); const second = monitor.check(); assert.equal(first, second);
  await Promise.resolve(); assert.equal(calls.length, 1); assert.equal(calls[0][0], '/health'); assert.equal(calls[0][1].cache, 'no-store'); assert.equal(calls[0][1].method, 'GET');
  finish(response(health('0.3.8'))); assert.equal(await first, '0.3.8'); assert.deepEqual(states, [{ version: '0.3.8', connected: true }]); monitor.stop();
});

test('断网、坏JSON、异服务和过大响应不覆盖上次已核验版本', async () => {
  const { createVersionMonitor } = await moduleReady;
  let current = response(health('0.3.8')); const states = [];
  const monitor = createVersionMonitor({ fetchImpl: async () => { if (current instanceof Error) throw current; return current; }, onState: value => states.push(value) });
  await monitor.check();
  for (const value of [new Error('network'), { ok: false }, { ok: true, text: async () => '{' }, response({ ...health('0.3.9'), service: 'other' }), { ok: true, text: async () => 'x'.repeat(16385) }]) { current = value; assert.equal(await monitor.check(), null); assert.deepEqual(states.at(-1), { version: '0.3.8', connected: false }); }
  current = response(health('0.3.7')); assert.equal(await monitor.check(), '0.3.7'); assert.deepEqual(states.at(-1), { version: '0.3.7', connected: true }); monitor.stop();
});

test('超时主动取消探测，即使迟到返回也不更新；停止后无回调和新请求', async () => {
  const { createVersionMonitor } = await moduleReady;
  let expire; let finish; let signal; const states = [];
  const monitor = createVersionMonitor({ fetchImpl: (_, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); }, onState: value => states.push(value), setTimer: fn => { expire = fn; return 1; }, clearTimer: () => {} });
  const pending = monitor.check(); await Promise.resolve(); expire(); assert.equal(await pending, null); assert.equal(signal.aborted, true); finish(response(health('0.3.9'))); await Promise.resolve(); assert.deepEqual(states, [{ version: '', connected: false }]);
  const second = monitor.check(); await Promise.resolve(); monitor.stop(); assert.equal(await second, null); assert.equal(await monitor.check(), null); assert.equal(states.length, 1);
});

test('草稿登记只保存标签，保存/取消/卸载可清除，不会因重复登记误清其它表单', async () => {
  const { createDraftRegistry } = await moduleReady; const registry = createDraftRegistry(); let changes = 0;
  const unsubscribe = registry.subscribe(() => changes++); const initial = registry.getSnapshot(); registry.set('settings', '个人设置', true); registry.set('settings', '个人设置', true); registry.set('task', '任务编辑', true);
  assert.deepEqual(registry.getSnapshot(), ['个人设置', '任务编辑']); assert.equal(changes, 2); assert.deepEqual(initial, []); registry.set('task', '任务编辑', false); assert.deepEqual(registry.getSnapshot(), ['个人设置']); registry.clearAll(); assert.deepEqual(registry.getSnapshot(), []); unsubscribe(); registry.set('source', '消息来源', true); assert.equal(changes, 4);
});

test('未保存时刷新须明确确认：取消和重复点击均不刷新，明确放弃后才清标记刷新', async () => {
  const { createDraftRegistry, createRefreshGuard } = await moduleReady; const registry = createDraftRegistry(); let confirmation; let reloads = 0;
  const request = createRefreshGuard({ registry, confirmDiscard: value => { confirmation = value; }, reload: () => reloads++ });
  registry.set('settings', '个人设置', true); assert.equal(request(), 'confirmation-required'); assert.equal(request(), 'pending'); assert.equal(reloads, 0); confirmation.cancel(); assert.deepEqual(registry.getSnapshot(), ['个人设置']);
  confirmation.proceed(); assert.equal(reloads, 0);
  request(); confirmation.proceed(); confirmation.proceed(); assert.equal(reloads, 1); assert.deepEqual(registry.getSnapshot(), []); assert.equal(request(), 'refreshed'); assert.equal(reloads, 2);
});
