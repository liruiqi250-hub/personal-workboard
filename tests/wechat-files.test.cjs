'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createDecipheriv } = require('node:crypto');
const { WechatClient, VAULT_KEY, MAX_FILE_BYTES, MAX_FILENAME_BYTES } = require('../server/wechat.cjs');

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const hash = (algorithm, value) => createHash(algorithm).update(value).digest('hex');
function waiting(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function setup(t, handler, overrides = {}) {
  const auth = { token: 'FILE_TEST_SECRET', owner: 'owner-file-test', botId: 'bot-file-test',
    base: 'https://ilinkai.weixin.qq.com', contextToken: 'CONTEXT_SECRET', cursor: '', seen: [] };
  const vault = { async get(key) { assert.equal(key, VAULT_KEY); return JSON.stringify(auth); },
    async set() {}, async delete() {} };
  const calls = [];
  const client = WechatClient({ vault, ...overrides, fetch: async (url, options) => {
    if (url.endsWith('getupdates')) return waiting(options.signal);
    const call = { url, options, body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body };
    calls.push(call);
    if (handler) return handler(call, calls);
    if (url.endsWith('getuploadurl')) return json({ upload_param: 'UPLOAD+/= param' });
    if (url.includes('/c2c/upload?')) return new Response('', { headers: { 'x-encrypted-param': 'DOWNLOAD+/= param' } });
    if (url.endsWith('sendmessage')) return json({ ret: 0, message_id: '90071992547409931234' });
    throw new Error(`Unexpected mock route: ${url}`);
  } });
  await client.start();
  t.after(() => client.disconnect());
  return { client, calls, auth };
}
function checkError(expected) {
  return error => {
    assert.equal(error.name, 'WechatFileError');
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(error[key], value, key);
    assert.equal(error.readStatus, 'unknown');
    assert.ok(!JSON.stringify(error).includes('FILE_TEST_SECRET'));
    return true;
  };
}

test('文件协议字段、密文字节、MD5/SHA256、PKCS7边界和官方hex文本Base64编码精确一致', async t => {
  const { client, calls } = await setup(t);
  const bytes = Buffer.from('1234567890abcdef'); // Exact AES block requires a whole additional padding block.
  const progress = [];
  const result = await client.sendFile({ bytes, filename: '报告_中文.pdf', clientId: 'file-exact-1',
    onProgress: async value => progress.push(value) });
  assert.equal(calls.length, 3);
  const [parameters, upload, sent] = calls;
  assert.equal(parameters.options.method, 'POST');
  assert.equal(parameters.options.headers.Authorization, 'Bearer FILE_TEST_SECRET');
  assert.equal(parameters.options.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(parameters.body.media_type, 3);
  assert.equal(parameters.body.to_user_id, 'owner-file-test');
  assert.equal(parameters.body.rawsize, 16);
  assert.equal(parameters.body.rawfilemd5, hash('md5', bytes));
  assert.equal(parameters.body.filesize, 32);
  assert.equal(parameters.body.no_need_thumb, true);
  assert.match(parameters.body.filekey, /^[0-9a-f]{32}$/);
  assert.match(parameters.body.aeskey, /^[0-9a-f]{32}$/);
  assert.deepEqual(parameters.body.base_info, { channel_version: require('../package.json').version, bot_agent: `PersonalWorkboard/${require('../package.json').version}` });
  assert.equal(upload.url, `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=UPLOAD%2B%2F%3D%20param&filekey=${parameters.body.filekey}`);
  assert.equal(upload.options.method, 'POST');
  assert.equal(upload.options.redirect, 'error');
  assert.deepEqual(upload.options.headers, { 'Content-Type': 'application/octet-stream' });
  const ciphertext = Buffer.from(upload.body);
  assert.equal(ciphertext.length, 32);
  assert.notDeepEqual(ciphertext.subarray(0, bytes.length), bytes);
  const decrypt = createDecipheriv('aes-128-ecb', Buffer.from(parameters.body.aeskey, 'hex'), null);
  assert.deepEqual(Buffer.concat([decrypt.update(ciphertext), decrypt.final()]), bytes);
  const msg = sent.body.msg;
  assert.equal(msg.client_id, 'file-exact-1');
  assert.equal(msg.from_user_id, '');
  assert.equal(msg.to_user_id, 'owner-file-test');
  assert.equal(msg.context_token, 'CONTEXT_SECRET');
  assert.equal(msg.message_type, 2);
  assert.equal(msg.message_state, 2);
  assert.equal(msg.item_list.length, 1);
  assert.equal(msg.item_list[0].type, 4);
  assert.deepEqual(msg.item_list[0].file_item, { file_name: '报告_中文.pdf', len: '16', media: {
    encrypt_query_param: 'DOWNLOAD+/= param',
    aes_key: Buffer.from(parameters.body.aeskey, 'utf8').toString('base64'), encrypt_type: 1 } });
  assert.equal(Buffer.from(msg.item_list[0].file_item.media.aes_key, 'base64').length, 32);
  assert.equal(result.accepted, true);
  assert.equal(result.uploaded, true);
  assert.equal(result.uploadStatus, 'server_accepted');
  assert.equal(result.deliveryStatus, 'server_accepted');
  assert.equal(result.readStatus, 'unknown');
  assert.equal(result.sha256, hash('sha256', bytes));
  assert.equal(result.md5, hash('md5', bytes));
  assert.equal(result.serverMessageId, '90071992547409931234');
  assert.equal(client.status().fileSendSupported, true);
  assert.equal(client.status().fileSendVerified, true);
  assert.deepEqual(progress.map(value => value.phase), ['uploading', 'uploaded', 'sending']);
  for (const item of progress) {
    assert.deepEqual(Object.keys(item).sort(), ['clientId', 'phase', 'sha256', 'size', 'uploadStatus']);
    assert.equal(item.sha256, result.sha256);
    assert.equal(item.size, bytes.length);
    assert.equal(item.clientId, result.clientId);
  }
  const publicView = JSON.stringify({ result, progress, status: client.status() });
  assert.ok(!publicView.includes('FILE_TEST_SECRET') && !publicView.includes('CONTEXT_SECRET'));
  assert.ok(!publicView.includes(parameters.body.aeskey) && !publicView.includes('DOWNLOAD'));
});

test('完整CDN上传URL优先，PDF/DOCX/HTML/已登记结果文字均使用普通文件，调用期间Buffer变化不改变发送内容', async t => {
  let original;
  const { client, calls } = await setup(t, async call => {
    if (call.url.endsWith('getuploadurl')) { original.fill(0); return json({
      upload_full_url: ' https://novac2c.cdn.weixin.qq.com/c2c/upload?full=1 ', upload_param: 'IGNORE' }); }
    if (call.url.includes('?full=1')) return new Response('', { headers: { 'x-encrypted-param': 'D' } });
    return json({ ret: 0 });
  });
  for (const filename of ['报告.pdf', '报告.docx', '报告.html', '本轮Codex完整结果.txt']) {
    original = Buffer.from('你好，工作结果'); const expected = Buffer.from(original);
    const result = await client.sendFile({ bytes: original, filename });
    const [parameters, upload, sent] = calls.slice(-3);
    assert.equal(upload.url, 'https://novac2c.cdn.weixin.qq.com/c2c/upload?full=1');
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(parameters.body.aeskey, 'hex'), null);
    assert.deepEqual(Buffer.concat([decipher.update(upload.body), decipher.final()]), expected);
    assert.equal(result.sha256, hash('sha256', expected));
    assert.equal(sent.body.msg.item_list[0].type, 4);
    assert.equal(sent.body.msg.item_list[0].file_item.file_name, filename);
  }
});

test('无本人绑定、其他收件人和缺本人上下文均在网络提交前拒绝', async t => {
  const { client, calls } = await setup(t);
  const input = { bytes: Buffer.from('body'), filename: '报告.pdf' };
  await assert.rejects(client.sendFile({ ...input, to: 'someone-else' }), /只能发送/);
  await assert.rejects(client.sendFile({ ...input, to: '' }), /只能发送/);
  const context = client.credentials.contextToken;
  client.credentials.contextToken = '';
  await assert.rejects(client.sendFile(input), /建立可回复会话/);
  client.credentials.contextToken = context;
  client.state.controllerBound = false;
  await assert.rejects(client.sendFile(input), /本人绑定/);
  assert.equal(calls.length, 0);
});

test('仅Buffer、文件名、非空大小和clientId校验，不读取path；20MiB是本软件上限', async t => {
  const { client, calls } = await setup(t);
  assert.equal(MAX_FILE_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_FILENAME_BYTES, 240);
  const input = { bytes: Buffer.from('body'), filename: '报告.pdf' };
  const invalid = [
    { ...input, bytes: 'C:\\secret.txt' }, { ...input, bytes: new Uint8Array(2) },
    { ...input, bytes: Buffer.alloc(0) }, { ...input, bytes: Buffer.alloc(MAX_FILE_BYTES + 1) },
    { ...input, clientId: 'bad id' }, { ...input, clientId: '' },
    { ...input, filename: '../secret.pdf' }, { ...input, filename: 'C:\\secret.pdf' },
    { ...input, filename: '报告\n.pdf' }, { ...input, filename: '报告.pdf ' },
    { ...input, filename: 'NUL.txt' }, { ...input, filename: 'a'.repeat(241) },
    { ...input, filename: '中'.repeat(81) }, { ...input, filename: 'bad?.pdf' },
    { ...input, filename: '报告\u202eexe.pdf' }, { ...input, onProgress: true }
  ];
  for (const value of invalid) await assert.rejects(client.sendFile(value), checkError({
    phase: 'validation', accepted: false, uploaded: false, deliveryStatus: 'not_sent' }));
  await assert.rejects(client.sendFile({ path: 'C:\\private\\secret.pdf' }), /尚未实现按磁盘路径/);
  assert.equal(calls.length, 0);
});

test('恶意上传完整URL、非HTTPS、带凭据/端口/片段和无参数响应均不会上传', async t => {
  for (const upload of [
    { upload_full_url: 'https://weixin.qq.com.evil.test/upload' },
    { upload_full_url: 'http://novac2c.cdn.weixin.qq.com/c2c/upload' },
    { upload_full_url: 'https://user:pass@novac2c.cdn.weixin.qq.com/upload' },
    { upload_full_url: 'https://novac2c.cdn.weixin.qq.com:444/upload' },
    { upload_full_url: 'https://novac2c.cdn.weixin.qq.com/upload#fragment' }, {}
  ]) {
    const { client, calls } = await setup(t, () => json(upload));
    await assert.rejects(client.sendFile({ bytes: Buffer.from('body'), filename: '报告.pdf' }),
      checkError({ phase: 'get_upload_url', accepted: false, uploaded: false, uploadStatus: 'not_started', deliveryStatus: 'not_sent' }));
    assert.equal(calls.length, 1);
    await client.stop();
  }
});

test('上传HTTP4xx明确拒绝；5xx、缺下载头和断网为上传不明，均不调用sendmessage也不自动重试', async t => {
  const cases = [
    { response: () => new Response('', { status: 403 }), uploaded: false, uploadStatus: 'rejected' },
    { response: () => new Response('', { status: 503 }), uploaded: null, uploadStatus: 'unknown' },
    { response: () => new Response('', { status: 200 }), uploaded: null, uploadStatus: 'unknown' },
    { response: () => { throw new Error('network secret URL'); }, uploaded: null, uploadStatus: 'unknown' }
  ];
  for (const scenario of cases) {
    const { client, calls } = await setup(t, call => call.url.endsWith('getuploadurl')
      ? json({ upload_param: 'U' }) : scenario.response());
    await assert.rejects(client.sendFile({ bytes: Buffer.from('body'), filename: '报告.pdf', clientId: 'upload-failure' }),
      checkError({ phase: 'uploading', clientId: 'upload-failure', accepted: false, uploaded: scenario.uploaded,
        uploadStatus: scenario.uploadStatus, deliveryStatus: 'not_sent', sha256: hash('sha256', 'body') }));
    assert.equal(calls.length, 2);
    assert.ok(!calls.some(call => call.url.endsWith('sendmessage')));
    assert.equal(client.status().fileSendVerified, false);
    await client.stop();
  }
});

test('文件消息明确ret错误/HTTP4xx为拒绝，超时/断网/5xx/缺ret/坏JSON为发送不明，已上传状态保留且不重发', async t => {
  const cases = [
    { response: () => json({ ret: 7, errmsg: 'reject' }), accepted: false, deliveryStatus: 'server_rejected' },
    { response: () => new Response('', { status: 401 }), accepted: false, deliveryStatus: 'server_rejected' },
    { response: () => new Response('', { status: 503 }), accepted: null, deliveryStatus: 'unknown' },
    { response: () => json({}), accepted: null, deliveryStatus: 'unknown' },
    { response: () => new Response('bad JSON'), accepted: null, deliveryStatus: 'unknown' },
    { response: () => { throw new Error('network'); }, accepted: null, deliveryStatus: 'unknown' },
    { response: () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); }, accepted: null, deliveryStatus: 'unknown' }
  ];
  for (const scenario of cases) {
    const { client, calls } = await setup(t, call => {
      if (call.url.endsWith('getuploadurl')) return json({ upload_param: 'U' });
      if (call.url.includes('/c2c/upload?')) return new Response('', { headers: { 'x-encrypted-param': 'D' } });
      return scenario.response();
    });
    await assert.rejects(client.sendFile({ bytes: Buffer.from('body'), filename: '报告.pdf' }), checkError({
      phase: 'sending', accepted: scenario.accepted, deliveryStatus: scenario.deliveryStatus,
      uploaded: true, uploadStatus: 'server_accepted' }));
    assert.equal(calls.filter(call => call.url.endsWith('sendmessage')).length, 1);
    assert.equal(client.status().fileSendVerified, false);
    await client.stop();
  }
});

test('上传参数阶段认证失效不上传，状态明确变为待本人重新登录', async t => {
  const { client, calls } = await setup(t, () => json({ ret: -14 }));
  await assert.rejects(client.sendFile({ bytes: Buffer.from('body'), filename: '报告.pdf' }), checkError({
    code: 'SESSION_EXPIRED', phase: 'get_upload_url', accepted: false, uploaded: false, deliveryStatus: 'not_sent' }));
  assert.equal(calls.length, 1);
  assert.equal(client.status().controllerBound, false);
  assert.equal(client.status().connected, false);
});

test('上传确认和发送前进度必须持久成功；回调失败不发送消息，断开绑定也停止', async t => {
  for (const phase of ['uploading', 'uploaded', 'sending']) {
    const { client, calls } = await setup(t);
    await assert.rejects(client.sendFile({ bytes: Buffer.from('body'), filename: '报告.pdf',
      onProgress: async value => { if (value.phase === phase) throw new Error('database private path'); } }), checkError({
      code: 'WECHAT_FILE_PROGRESS_FAILED', phase, accepted: false, deliveryStatus: 'not_sent',
      uploaded: phase === 'uploading' ? false : true,
      uploadStatus: phase === 'uploading' ? 'not_started' : 'server_accepted' }));
    assert.ok(!calls.some(call => call.url.endsWith('sendmessage')));
    assert.equal(calls.length, phase === 'uploading' ? 1 : 2);
    await client.stop();
  }
  const { client, calls } = await setup(t);
  await assert.rejects(client.sendFile({ bytes: Buffer.from('body'), filename: '报告.pdf',
    onProgress: async value => { if (value.phase === 'uploaded') await client.disconnect(); } }), checkError({
    phase: 'uploaded', accepted: false, uploaded: true, deliveryStatus: 'not_sent' }));
  assert.equal(calls.length, 2);
});

test('上传传输受超时AbortSignal约束，未知结果不重复上传', async t => {
  const { client, calls } = await setup(t, call => call.url.endsWith('getuploadurl')
    ? json({ upload_param: 'U' }) : waiting(call.options.signal), { mediaTimeoutMs: 10 });
  await assert.rejects(client.sendFile({ bytes: Buffer.from('body'), filename: '报告.pdf' }), checkError({
    phase: 'uploading', accepted: false, uploaded: null, uploadStatus: 'unknown', deliveryStatus: 'not_sent' }));
  assert.equal(calls.length, 2);
});
