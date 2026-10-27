'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WechatClient, VAULT_KEY, trustedBase } = require('../server/wechat.cjs');
const { CodexController } = require('../server/codex.cjs');

async function until(predicate) {
  const limit = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > limit) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function memoryVault(initial) {
  const values = new Map(initial ? [[VAULT_KEY, JSON.stringify(initial)]] : []); const writes = [];
  return { values, writes, async get(key) { return values.get(key); },
    async set(key, value) { writes.push({ key, value }); values.set(key, value); }, async delete(key) { values.delete(key); } };
}
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const lifecycleNotification = url => /\/ilink\/bot\/msg\/notify(?:start|stop)$/.test(url);
function waiting(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
}
const credentials = () => ({ token: 'VERY_SECRET_BOT_TOKEN', owner: 'owner-12345', botId: 'bot-67890',
  base: 'https://ilinkai.weixin.qq.com', cursor: '', contextToken: '', seen: [] });

test('微信二维码按需生成；扫码结果只在本机确认后加密绑定，UI不含凭据', async t => {
  const vault = memoryVault(); const calls = []; const messages = [];
  const client = WechatClient({ vault, pollDelayMs: 1, onMessage: value => messages.push(value),
    qrToDataURL: async value => { assert.equal(value, 'https://weixin.qq.com/qr/value'); return 'data:image/png;base64,AA=='; },
    fetch: async (url, options) => {
      calls.push({ url, options, body: options.body && JSON.parse(options.body) });
      if (url.includes('get_bot_qrcode')) return json({ qrcode: 'qr-secret', qrcode_img_content: 'https://weixin.qq.com/qr/value' });
      if (url.includes('get_qrcode_status')) return json({ status: 'confirmed', bot_token: 'VERY_SECRET_BOT_TOKEN',
        ilink_bot_id: 'bot-67890', ilink_user_id: 'owner-12345', baseurl: 'https://ilinkai.weixin.qq.com' });
      if (lifecycleNotification(url)) return json({ ret: 0 });
      return waiting(options.signal);
    } });
  t.after(() => client.disconnect());
  await client.start(); assert.equal(calls.length, 0, 'start must never create QR automatically');
  await client.connect(); await until(() => client.status().status === 'awaiting_confirmation');
  assert.equal(vault.writes.length, 0); assert.equal(client.status().connected, false);
  assert.equal(client.status().controllerBound, false); assert.equal(messages.length, 0);
  const view = JSON.stringify(client.status());
  assert.ok(!view.includes('VERY_SECRET') && !view.includes('owner-12345') && !view.includes('qr-secret'));
  assert.equal(calls[0].options.method, 'POST');
  assert.match(calls[0].url, /get_bot_qrcode\?bot_type=3$/); assert.deepEqual(calls[0].body, { local_token_list: [] });
  assert.ok(!calls[0].options.headers.Authorization);
  assert.equal(calls[1].options.method, 'GET'); assert.ok(!calls[1].options.headers.AuthorizationType);
  await client.confirm(); assert.equal(client.status().connected, true); assert.equal(client.status().controllerBound, true);
  assert.equal(JSON.parse(vault.values.get(VAULT_KEY)).owner, 'owner-12345');
});

test('微信仅处理绑定本人私聊，持久化游标及去重，回复使用上下文且只证明服务器接受', async t => {
  const vault = memoryVault(credentials()); const calls = []; const messages = []; let polls = 0;
  const owner = { from_user_id: 'owner-12345', message_type: 1, message_id: '90071992547409931234',
    context_token: 'PRIVATE_CONTEXT', item_list: [{ type: 1, text_item: { text: '/codex 帮我检查' } }] };
  const client = WechatClient({ vault, pollDelayMs: 1, onMessage: value => messages.push(value),
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body); calls.push({ url, options, body });
      if (lifecycleNotification(url)) return json({ ret: 0 });
      if (url.endsWith('getupdates')) {
        polls++;
        if (polls === 1) return json({ ret: 0, msgs: [{ ...owner, from_user_id: 'stranger' }, { ...owner, group_id: 'group' },
          { ...owner, message_type: 2 }, owner, owner], get_updates_buf: 'CURSOR_NEXT' });
        return waiting(options.signal);
      }
      if (url.endsWith('sendmessage')) return json({ ret: 0 });
      throw new Error('unexpected route');
    } });
  t.after(() => client.disconnect());
  await client.start(); await until(() => messages.length === 1 && polls === 2);
  assert.equal(messages[0].verifiedOwner, true); assert.equal(messages[0].id, '90071992547409931234');
  const stored = JSON.parse(vault.values.get(VAULT_KEY));
  assert.equal(stored.cursor, 'CURSOR_NEXT'); assert.deepEqual(stored.seen, [owner.message_id]);
  assert.equal(calls.filter(value => value.url.endsWith('getupdates'))[1].body.get_updates_buf, 'CURSOR_NEXT');
  assert.equal(client.status().receiving, true); assert.equal(client.status().textSendVerified, false);
  await assert.rejects(client.sendText({ to: 'stranger', text: 'do not send' }), /只能发送/);
  const sent = await client.sendText({ text: '执行已接受', clientId: 'my-exact-send-id' });
  assert.equal(sent.deliveryStatus, 'server_accepted'); assert.equal(sent.readStatus, 'unknown');
  const send = calls.find(value => value.url.endsWith('sendmessage'));
  assert.equal(send.body.msg.to_user_id, 'owner-12345'); assert.equal(send.body.msg.context_token, 'PRIVATE_CONTEXT');
  assert.equal(send.body.msg.message_type, 2); assert.equal(send.body.msg.item_list[0].text_item.text, '执行已接受');
  assert.equal(send.options.headers.Authorization, 'Bearer VERY_SECRET_BOT_TOKEN');
  assert.equal(client.status().textSendVerified, true);
  await assert.rejects(client.sendFile({ path: 'report.pdf' }), /尚未实现/);
});

function numericWireMessage(rawId, overrides = {}) {
  const fields = { from_user_id: 'owner-12345', message_type: 1, context_token: 'NUMERIC_CONTEXT_SECRET',
    item_list: [{ type: 1, text_item: { text: '相同正文的不同消息' } }], ...overrides };
  return '{"message_id":' + rawId + ',' + JSON.stringify(fields).slice(1);
}
function wireUpdates(messages, cursor) {
  return new Response('{"ret":0,"msgs":[' + messages.join(',') + '],"get_updates_buf":' + JSON.stringify(cursor) + '}',
    { headers: { 'content-type': 'application/json' } });
}

test('微信原始数字64位消息ID不丢失不碰撞，重启后持久去重仍保留新消息', async t => {
  const vault = memoryVault(credentials()); const firstMessages = []; let firstPolls = 0;
  const firstIds = ['9007199254740992', '9007199254740993'];
  const first = WechatClient({ vault, pollDelayMs: 1, onMessage: value => firstMessages.push(value),
    fetch: async (url, options) => {
      if (lifecycleNotification(url)) return json({ ret: 0 });
      assert.ok(url.endsWith('getupdates'), '此测试只允许内存模拟的收取请求');
      if (++firstPolls === 1) return wireUpdates([
        numericWireMessage(firstIds[0], { from_user_id: 'stranger' }),
        numericWireMessage(firstIds[0], { group_id: 'synthetic-group' }),
        numericWireMessage(firstIds[0], { message_type: 2 }),
        numericWireMessage(firstIds[0]), numericWireMessage(firstIds[1]), numericWireMessage(firstIds[0])
      ], 'NUMERIC_CURSOR_1');
      return waiting(options.signal);
    } });
  t.after(() => first.disconnect());
  await first.start(); await until(() => firstPolls === 2);
  assert.deepEqual(firstMessages.map(value => value.id), firstIds, '相邻wire整数必须各处理一次，不能丢弃或因Number舍入碰撞');
  assert.ok(firstMessages.every(value => value.verifiedOwner && value.senderId === 'owner-12345'));
  let stored = JSON.parse(vault.values.get(VAULT_KEY));
  assert.deepEqual(stored.seen, firstIds); assert.equal(stored.cursor, 'NUMERIC_CURSOR_1');
  assert.equal(stored.contextToken, 'NUMERIC_CONTEXT_SECRET'); assert.ok(first.status().lastReceiveAt);
  await first.stop();

  const secondMessages = []; let secondPolls = 0; const nextId = '9007199254740994';
  const restarted = WechatClient({ vault, pollDelayMs: 1, onMessage: value => secondMessages.push(value),
    fetch: async (url, options) => {
      if (lifecycleNotification(url)) return json({ ret: 0 });
      assert.ok(url.endsWith('getupdates'));
      if (++secondPolls === 1) {
        assert.equal(JSON.parse(options.body).get_updates_buf, 'NUMERIC_CURSOR_1');
        return wireUpdates([...firstIds.map(id => numericWireMessage(id)), numericWireMessage(nextId)], 'NUMERIC_CURSOR_2');
      }
      return waiting(options.signal);
    } });
  t.after(() => restarted.disconnect());
  await restarted.start(); await until(() => secondPolls === 2);
  assert.deepEqual(secondMessages.map(value => value.id), [nextId], '重启重放旧ID不得再次执行，同正文新ID必须继续接收');
  stored = JSON.parse(vault.values.get(VAULT_KEY));
  assert.deepEqual(stored.seen, [...firstIds, nextId]); assert.equal(stored.cursor, 'NUMERIC_CURSOR_2');
});

test('微信wire解析仅无损保留ID整数，协议数值与字符串正文保持原样', async t => {
  const content = '正文中的 "message_id":9007199254740993 和转义字符 \\ 不能改写';
  const raw = '{"ret":0,"message_type":1,"create_time_ms":1792972800000,"ready":true,' +
    '"message_id":9007199254740993,"item":{"msg_id":18446744073709551615},"safe":{"message_id":42},' +
    '"alreadyString":{"message_id":"000042"},"text":' + JSON.stringify(content) + '}';
  const client = WechatClient({ vault: memoryVault(), fetch: async () => new Response(raw) });
  t.after(() => client.disconnect());
  const value = await client.request('https://ilinkai.weixin.qq.com', 'ilink/bot/getupdates');
  assert.equal(value.message_id, '9007199254740993'); assert.equal(value.item.msg_id, '18446744073709551615');
  assert.equal(value.safe.message_id, '42'); assert.equal(value.alreadyString.message_id, '000042');
  assert.equal(value.ret, 0); assert.equal(value.message_type, 1); assert.equal(value.create_time_ms, 1792972800000);
  assert.equal(value.ready, true); assert.equal(value.text, content);
});

test('微信入站诊断按最新完成轮次计数，区分过滤原因且不泄漏正文ID和token', async t => {
  const vault = memoryVault(credentials()); const messages = []; let polls = 0; let finishSecondPoll;
  const bodySecret = 'INBOUND_DIAGNOSTIC_BODY_SECRET';
  const valid = { item_list: [{ type: 1, text_item: { text: bodySecret } }] };
  const client = WechatClient({ vault, pollDelayMs: 1, onMessage: value => messages.push(value.id),
    fetch: async (url, options) => {
      if (lifecycleNotification(url)) return json({ ret: 0 });
      assert.ok(url.endsWith('getupdates'));
      if (++polls === 1) return wireUpdates([
        numericWireMessage('9007199254740992', { ...valid, from_user_id: 'DIAGNOSTIC_STRANGER_SECRET' }),
        numericWireMessage('9007199254740992', { ...valid, group_id: 'DIAGNOSTIC_GROUP_SECRET' }),
        numericWireMessage('9007199254740992', { ...valid, message_type: 2 }),
        numericWireMessage('9007199254740992', { ...valid, delete_time_ms: 1 }),
        numericWireMessage('9007199254740992', { item_list: [{ type: 1, text_item: { text: '   ' } }] }),
        numericWireMessage('1e30', valid),
        numericWireMessage('9007199254740992', valid), numericWireMessage('9007199254740993', valid),
        numericWireMessage('9007199254740992', valid)
      ], 'DIAGNOSTIC_CURSOR_SECRET');
      if (polls === 2) return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        options.signal.addEventListener('abort', abort, { once: true });
        finishSecondPoll = () => {
          options.signal.removeEventListener('abort', abort);
          resolve(wireUpdates([], 'DIAGNOSTIC_CURSOR_2_SECRET'));
        };
      });
      return waiting(options.signal);
    } });
  t.after(() => client.disconnect());
  assert.equal(client.status().lastInboundDiagnostics, null, '尚无完成轮次时不伪造诊断计数');
  assert.equal(client.status().lastNonEmptyInboundDiagnostics, null);
  await client.start(); await until(() => polls === 2);
  assert.deepEqual(messages, ['9007199254740992', '9007199254740993']);
  const diagnostics = client.status().lastInboundDiagnostics;
  assert.deepEqual(diagnostics, { received: 9, accepted: 2, ignored: {
    otherSender: 1, group: 1, nonUser: 1, deleted: 1, invalidText: 1, unsafeMessageId: 1, duplicate: 1
  } });
  const nonEmpty = structuredClone(client.status().lastNonEmptyInboundDiagnostics);
  assert.equal(typeof nonEmpty.at, 'string'); assert.ok(Number.isFinite(Date.parse(nonEmpty.at)));
  const { at: nonEmptyAt, ...nonEmptyCounts } = nonEmpty;
  assert.deepEqual(nonEmptyCounts, diagnostics, '最近非空诊断须保留该完成轮次的计数与时间');
  const visible = JSON.stringify(client.status());
  for (const secret of [bodySecret, '9007199254740992', '9007199254740993', 'NUMERIC_CONTEXT_SECRET',
    'DIAGNOSTIC_CURSOR_SECRET', 'DIAGNOSTIC_STRANGER_SECRET', 'DIAGNOSTIC_GROUP_SECRET', 'VERY_SECRET_BOT_TOKEN']) {
    assert.ok(!visible.includes(secret), '诊断及公开status不能暴露合成敏感值');
  }
  finishSecondPoll(); await until(() => polls === 3);
  assert.deepEqual(client.status().lastInboundDiagnostics, { received: 0, accepted: 0, ignored: {
    otherSender: 0, group: 0, nonUser: 0, deleted: 0, invalidText: 0, unsafeMessageId: 0, duplicate: 0
  } }, '新完成空轮次应替换上轮计数，不能累计或伪装仍有新消息');
  assert.deepEqual(client.status().lastNonEmptyInboundDiagnostics, nonEmpty, '空轮次不能清除或改写最近非空诊断');
  await client.stop();
});

test('微信生命周期通知使用标准POST和动态版本头，通知失败仍可收取且停止幂等', async t => {
  const vault = memoryVault(credentials()); const calls = []; let polls = 0;
  const client = WechatClient({ vault, pollDelayMs: 1, fetch: async (url, options) => {
    calls.push({ url, options, body: options.body && JSON.parse(options.body) });
    if (lifecycleNotification(url)) return json({ ret: 123 }); // Both lifecycle notices can fail without stopping cleanup.
    assert.ok(url.endsWith('getupdates'));
    if (++polls === 1) return json({ ret: 0, msgs: [], get_updates_buf: 'LIFECYCLE_CURSOR' });
    return waiting(options.signal);
  } });
  t.after(() => client.disconnect());
  await client.start(); await until(() => polls === 2);
  assert.equal(client.status().receiving, true, '启动通知被拒绝仍应继续真实轮询流程');
  await client.start();
  await client.stop(); await client.stop();
  assert.equal(client.status().receiving, false);
  const notifications = calls.filter(value => lifecycleNotification(value.url));
  assert.deepEqual(notifications.map(value => value.url.split('/').at(-1)), ['notifystart', 'notifystop']);
  const version = require('../package.json').version;
  const [major, minor, patch] = version.split('.').map(Number);
  const encoded = String(((major & 255) << 16) | ((minor & 255) << 8) | (patch & 255));
  for (const call of notifications) {
    assert.equal(call.options.method, 'POST'); assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers['iLink-App-Id'], 'bot');
    assert.equal(call.options.headers['iLink-App-ClientVersion'], encoded);
    assert.equal(call.options.headers.Authorization, 'Bearer VERY_SECRET_BOT_TOKEN');
    assert.deepEqual(call.body, { base_info: { channel_version: version, bot_agent: `PersonalWorkboard/${version}` } });
  }
});

test('微信启动通知迟响应不能在停止后开启轮询，停止通知使用独立signal且有界', async t => {
  const vault = memoryVault(credentials()); let finishStartNotice; let startSignal; let stopSignal; let stopNoticeCount = 0; let polls = 0;
  const client = WechatClient({ vault, fetch: async (url, options) => {
    if (url.endsWith('/msg/notifystart')) {
      startSignal = options.signal;
      return new Promise(resolve => { finishStartNotice = () => resolve(json({ ret: 0 })); }); // Deliberately ignore abort, emulate a late fetch completion.
    }
    if (url.endsWith('/msg/notifystop')) {
      stopNoticeCount++; stopSignal = options.signal;
      assert.equal(stopSignal.aborted, false, '停止通知不能复用已取消的接收代次signal');
      return waiting(options.signal); // It must be aborted by the independent lifecycle timeout.
    }
    if (url.endsWith('getupdates')) { polls++; return waiting(options.signal); }
    throw Error('unexpected route');
  } });
  t.after(() => client.disconnect());
  const starting = client.start(); await until(() => typeof finishStartNotice === 'function');
  const beganStop = Date.now(); await client.stop();
  assert.equal(stopNoticeCount, 1); assert.notEqual(stopSignal, startSignal);
  assert.equal(startSignal.aborted, true); assert.equal(stopSignal.aborted, true);
  assert.ok(Date.now() - beganStop < 6500, '独立停止通知应在5秒上限附近退出');
  finishStartNotice(); await starting;
  assert.equal(polls, 0, '已停止代次收到迟响应后不得恢复poll'); assert.equal(client.status().receiving, false);
  await client.stop(); assert.equal(stopNoticeCount, 1, '重复停止不得再次提交通知');
});

test('微信start等待停止通知时并发disconnect不空解引用，也不重新启动轮询', async t => {
  const vault = memoryVault(credentials()); let polls = 0; let startNotices = 0; let stopNotices = 0; let finishStopNotice;
  const client = WechatClient({ vault, fetch: async (url, options) => {
    if (url.endsWith('/msg/notifystart')) { startNotices++; return json({ ret: 0 }); }
    if (url.endsWith('/msg/notifystop')) {
      stopNotices++;
      return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        options.signal.addEventListener('abort', abort, { once: true });
        finishStopNotice = () => {
          options.signal.removeEventListener('abort', abort);
          resolve(json({ ret: 0 }));
        };
      });
    }
    assert.ok(url.endsWith('getupdates')); polls++;
    return waiting(options.signal); // Initial poll is still in flight, so receiving remains false.
  } });
  t.after(() => client.disconnect());
  await client.start(); await until(() => polls === 1);
  assert.equal(client.status().receiving, false);
  const restarting = client.start(); await until(() => typeof finishStopNotice === 'function');
  const disconnecting = client.disconnect();
  finishStopNotice();
  const results = await Promise.allSettled([restarting, disconnecting]);
  assert.ok(results.every(value => value.status === 'fulfilled'), '并发断开使凭据失效时，迟到的start应安全返回');
  assert.equal(polls, 1); assert.equal(startNotices, 1); assert.equal(stopNotices, 1);
  assert.equal(client.status().connected, false); assert.equal(client.status().controllerBound, false);
  assert.equal(client.status().receiving, false); assert.equal(vault.values.size, 0);
});

test('微信错误不伪造接入，未建立本人会话不能发送，凭据地址不能跳转到任意站点', async t => {
  assert.throws(() => trustedBase('http://ilinkai.weixin.qq.com'), /HTTPS/);
  assert.throws(() => trustedBase('https://weixin.qq.com.evil.test'), /HTTPS/);
  assert.throws(() => trustedBase('https://user:pass@ilinkai.weixin.qq.com'), /HTTPS/);
  const vault = memoryVault(credentials());
  const client = WechatClient({ vault, fetch: async () => json({ ret: -14 }) });
  t.after(() => client.disconnect());
  await client.start(); await until(() => client.status().status === 'error');
  assert.equal(client.status().connected, false); assert.equal(client.status().receiving, false);
  await assert.rejects(client.sendText('hello'), /建立可回复会话|本人绑定/);
  await client.disconnect(); assert.equal(vault.values.size, 0); assert.equal(client.status().controllerBound, false);
});

function fakeCodex() {
  const instances = []; const requests = []; let counter = 0;
  function spawn(executable, args, options) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    child.kill = () => { if (child.exitCode == null) { child.exitCode = 0; child.stdout.end(); child.emit('exit', 0); } return true; };
    child.send = value => child.stdout.write(`${JSON.stringify(value)}\n`);
    let buffer = '';
    child.stdin = new Writable({ write(chunk, encoding, done) {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const position = buffer.indexOf('\n'); const line = buffer.slice(0, position); buffer = buffer.slice(position + 1);
        if (!line) continue;
        const req = JSON.parse(line); requests.push(req);
        if (!req.method || req.id == null) continue;
        let result = {};
        if (req.method === 'account/read') result = { account: { type: 'chatgpt' } };
        else if (req.method === 'thread/start') result = { cwd: req.params.cwd, thread: { id: `managed-${++counter}`, cwd: req.params.cwd } };
        else if (req.method === 'thread/resume') result = { cwd: req.params.cwd, thread: { id: req.params.threadId, cwd: req.params.cwd } };
        else if (req.method === 'turn/start') result = { turn: { id: `turn-${++counter}`, status: 'inProgress' } };
        queueMicrotask(() => {
          if (child.exitCode == null) { child.beforeReply?.(req, result); child.send({ id: req.id, result }); }
        });
      }
      done();
    }, final(done) { child.kill(); done(); } });
    instances.push({ child, executable, args, options });
    if (args[0] === '--version') queueMicrotask(() => { child.stdout.write('codex-cli 0.164.0-alpha.11.1\n'); child.kill(); });
    return child;
  }
  return { spawn, instances, requests, get app() { return instances.find(value => value.args[0] === 'app-server')?.child; } };
}
function setupCodex(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-bridge-test-'));
  const fake = fakeCodex(); const output = []; const approvals = [];
  const settings = { wechatRemoteEnabled: true, allowedProjects: [dir] };
  const client = CodexController({ getSettings: () => settings, spawn: fake.spawn, executable: 'test-codex.exe',
    onOutput: value => output.push(value), onApproval: value => approvals.push(value), requestTimeoutMs: 3000, ...overrides });
  t.after(async () => { await client.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { client, fake, dir, output, approvals, settings };
}

test('Codex status仅版本及初始化/只读账号检查，不执行AI任务；子进程禁止shell、Hooks及full-access', async t => {
  const { client, fake } = setupCodex(t);
  const status = await client.status();
  assert.equal(status.available, true); assert.equal(status.protocolReady, true);
  assert.equal(status.version, 'codex-cli 0.164.0-alpha.11.1');
  assert.deepEqual(fake.requests.map(value => value.method), ['initialize', 'initialized', 'account/read']);
  assert.equal(fake.instances[0].options.shell, false); assert.equal(fake.instances[1].options.shell, false);
  const args = fake.instances[1].args.join(' ');
  assert.match(args, /--disable hooks/); assert.match(args, /approval_policy="on-request"/);
  assert.match(args, /sandbox_mode="workspace-write"/); assert.doesNotMatch(args, /danger-full-access|--yolo/);
  assert.deepEqual(client.listThreads(), []);
});

test('Codex只允许本机授权目录与遥控开关，重复ID只执行一次，不读取现有聊天', async t => {
  const { client, fake, dir, settings } = setupCodex(t);
  settings.wechatRemoteEnabled = false;
  assert.throws(() => client.run({ prompt: '任务', cwd: dir }), /尚未开启/);
  settings.wechatRemoteEnabled = true;
  assert.throws(() => client.run({ prompt: '任务', cwd: os.tmpdir() }), /不在本机已授权/);
  const first = client.run({ prompt: '检查项目', cwd: dir, requestId: 'wx-msg-1' });
  const duplicate = client.run({ prompt: '检查项目', cwd: dir, requestId: 'wx-msg-1' });
  const [a, b] = await Promise.all([first, duplicate]); assert.deepEqual(a, b);
  assert.equal(fake.requests.filter(value => value.method === 'thread/start').length, 1);
  assert.equal(fake.requests.filter(value => value.method === 'turn/start').length, 1);
  assert.equal(client.listThreads().length, 1);
  assert.throws(() => client.run({ prompt: '不同内容', cwd: dir, requestId: 'wx-msg-1' }), /重复请求 ID/);
  assert.throws(() => client.resume({ threadId: 'desktop-original', prompt: '不要读取' }), /只能继续/);
  await assert.rejects(client.interrupt({ threadId: 'desktop-original' }), /只能停止/);
  assert.ok(!fake.requests.some(value => ['thread/list', 'thread/read'].includes(value.method)));
  const start = fake.requests.find(value => value.method === 'thread/start');
  assert.equal(start.params.sandbox, 'workspace-write'); assert.equal(start.params.approvalPolicy, 'on-request');
  const turn = fake.requests.find(value => value.method === 'turn/start');
  assert.equal(turn.params.sandboxPolicy.type, 'workspaceWrite'); assert.equal(turn.params.sandboxPolicy.networkAccess, false);
});

test('Codex审批绑定精确RPC/会话/轮次且不可重放；完成回调返回实际文字', async t => {
  const { client, fake, dir, approvals, output } = setupCodex(t);
  const run = await client.run({ prompt: '处理文件', cwd: dir, requestId: 'wx-msg-2' });
  fake.app.send({ id: 'server-exact-id', method: 'item/commandExecution/requestApproval', params: {
    threadId: run.threadId, turnId: run.turnId, itemId: 'item-1', command: 'git status', cwd: dir, reason: '请求本次执行' } });
  await until(() => approvals.length === 1); const approval = approvals[0];
  assert.match(approval.code, /^[0-9A-F]{8}$/);
  await assert.rejects(client.approve({ code: approval.code, decision: 'accept', turnId: 'old-turn' }), /不匹配/);
  await assert.rejects(client.approve({ code: approval.code, decision: 'acceptForSession' }), /只能明确/);
  await client.approve({ code: approval.code, decision: 'accept', threadId: run.threadId, turnId: run.turnId });
  const response = fake.requests.find(value => value.id === 'server-exact-id' && value.result);
  assert.deepEqual(response.result, { decision: 'accept' });
  await assert.rejects(client.approve({ code: approval.code, decision: 'accept' }), /已使用/);
  fake.app.send({ method: 'item/completed', params: { threadId: run.threadId, turnId: run.turnId,
    item: { type: 'agentMessage', id: 'final', text: '已检查文件，结果正常。' } } });
  fake.app.send({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed', error: null } } });
  await until(() => output.some(value => value.type === 'completed'));
  assert.equal(output.find(value => value.type === 'completed').text, '已检查文件，结果正常。');
  const resumed = await client.resume({ threadId: run.threadId, prompt: '继续检查', requestId: 'wx-msg-3' });
  assert.equal(resumed.threadId, run.threadId); assert.notEqual(resumed.turnId, run.turnId);
  await assert.rejects(client.interrupt({ threadId: run.threadId, turnId: run.turnId }), /已过期/);
  await client.interrupt({ threadId: run.threadId, turnId: resumed.turnId, requestId: 'wx-stop-1' });
  const interrupt = fake.requests.find(value => value.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: run.threadId, turnId: resumed.turnId });
});

test('Codex未知请求和外部会话不可审批，已关闭遥控仍可拒绝已有请求', async t => {
  const { client, fake, dir, approvals, settings } = setupCodex(t);
  const run = await client.run({ prompt: '测试审批', cwd: dir });
  fake.app.send({ id: 800, method: 'item/commandExecution/requestApproval', params: { threadId: 'other-chat', turnId: run.turnId } });
  fake.app.send({ id: 801, method: 'item/fileChange/requestApproval', params: { threadId: run.threadId, turnId: run.turnId, itemId: 'patch-1' } });
  await until(() => approvals.length === 1);
  assert.equal(fake.requests.find(value => value.id === 800).error.code, -32601);
  settings.wechatRemoteEnabled = false;
  await assert.rejects(client.approve({ code: approvals[0].code, decision: 'accept' }), /尚未开启/);
  await client.approve({ code: approvals[0].code, decision: 'decline' });
  assert.deepEqual(fake.requests.find(value => value.id === 801 && value.result).result, { decision: 'decline' });
});

test('Codex任务在turn/start响应前完成时保留终态，同一完成通知不重复回传', async t => {
  const { client, fake, dir, output } = setupCodex(t);
  await client.status();
  fake.app.beforeReply = (req, result) => {
    if (req.method !== 'turn/start') return;
    const threadId = req.params.threadId; const turn = { id: result.turn.id, status: 'completed' };
    fake.app.send({ method: 'turn/started', params: { threadId, turn } });
    fake.app.send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', text: '快速完成' } } });
    fake.app.send({ method: 'turn/completed', params: { threadId, turn } });
    fake.app.send({ method: 'turn/completed', params: { threadId, turn } });
  };
  const result = await client.run({ prompt: '快速任务', cwd: dir, requestId: 'fast' });
  assert.equal(result.status, 'completed'); assert.equal(client.listThreads()[0].turnId, null);
  assert.equal(output.filter(event => event.type === 'completed').length, 1);
  assert.equal(output.find(event => event.type === 'completed').text, '快速完成');
});

test('Codex权限审批只授予已展示的请求且限本轮；过期码自动拒绝', async t => {
  const { client, fake, dir, approvals } = setupCodex(t, { approvalTimeoutMs: 40 });
  const run = await client.run({ prompt: '请求权限', cwd: dir });
  const permissions = { network: { enabled: true } };
  fake.app.send({ id: 'permissions-1', method: 'item/permissions/requestApproval', params: {
    threadId: run.threadId, turnId: run.turnId, itemId: 'permissions-item', cwd: dir, permissions } });
  await until(() => approvals.length === 1);
  await client.approve({ code: approvals[0].code, decision: 'accept' });
  assert.deepEqual(fake.requests.find(value => value.id === 'permissions-1' && value.result).result,
    { permissions, scope: 'turn' });
  fake.app.send({ id: 'expires-1', method: 'item/commandExecution/requestApproval', params: {
    threadId: run.threadId, turnId: run.turnId, itemId: 'expiry-item', command: 'test' } });
  await until(() => approvals.length === 2);
  await until(() => fake.requests.some(value => value.id === 'expires-1' && value.result));
  assert.deepEqual(fake.requests.find(value => value.id === 'expires-1' && value.result).result, { decision: 'decline' });
  await assert.rejects(client.approve({ code: approvals[1].code, decision: 'accept' }), /已过期/);
});

test('微信收到数字验证码要求时仍需本机最终确认；空发送回执不能伪报成功', async t => {
  const vault = memoryVault(); const qrQueries = [];
  const client = WechatClient({ vault, pollDelayMs: 1, qrToDataURL: async () => 'data:image/png;base64,AA==',
    fetch: async (url, options) => {
      if (url.includes('get_bot_qrcode')) return json({ qrcode: 'qr-verify', qrcode_img_content: 'qr-content' });
      if (url.includes('get_qrcode_status')) {
        qrQueries.push(url);
        if (!url.includes('verify_code=123456')) return json({ status: 'need_verifycode' });
        return json({ status: 'confirmed', bot_token: 'secret', ilink_bot_id: 'bot', ilink_user_id: 'owner-12345' });
      }
      if (lifecycleNotification(url)) return json({ ret: 0 });
      return waiting(options.signal);
    } });
  t.after(() => client.disconnect());
  await client.connect(); await until(() => client.status().status === 'need_verifycode');
  await assert.rejects(client.confirm({ verifyCode: 'wrong' }), /数字验证码/);
  await client.confirm({ verifyCode: '123456' });
  await until(() => client.status().status === 'awaiting_confirmation');
  assert.equal(vault.writes.length, 0); assert.equal(client.status().controllerBound, false);
  await client.confirm(); assert.equal(client.status().controllerBound, true);
  assert.ok(qrQueries.some(value => value.includes('verify_code=123456')));
  client.credentials.contextToken = 'test-context';
  client.fetch = async () => new Response('');
  await assert.rejects(client.sendText('hello'), /响应格式无法确认/);
  assert.equal(client.status().textSendVerified, false);
});
