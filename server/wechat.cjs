'use strict';

// Direct implementation of Tencent's iLink protocol. Evidence: docs/verification/wechat-files-protocol-v0.3.0.md.
const { randomUUID, randomBytes, createHash, createCipheriv } = require('node:crypto');
const API_BASE = 'https://ilinkai.weixin.qq.com';
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const VAULT_KEY = 'wechat.personal-bot.v1';
const CHANNEL_VERSION = require('../package.json').version;
// Local resource policy, not a claim about Tencent's server-side limit.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILENAME_BYTES = 240;
const mask = value => !value ? '' : String(value).length < 6 ? '***' : `${String(value).slice(0, 2)}***${String(value).slice(-2)}`;

function trustedBase(value) {
  const url = new URL(value || API_BASE);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))) {
    throw new Error('微信服务器地址不在腾讯微信 HTTPS 域名范围内');
  }
  return url.origin;
}
function trustedUploadUrl(value) {
  const url = new URL(value);
  trustedBase(url.href);
  if (url.hash) throw new Error('微信文件上传地址不能包含片段');
  return url.href;
}
function validateFilename(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[. ]$/.test(value) ||
      /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) ||
      value === '.' || value === '..' || Buffer.byteLength(value, 'utf8') > MAX_FILENAME_BYTES) {
    throw new Error('微信文件名无效：须为不含路径和控制字符的普通文件名，UTF-8 不超过 240 字节');
  }
  return value;
}
function fileError(message, details, code = 'WECHAT_FILE_FAILED') {
  return Object.assign(new Error(message), { name: 'WechatFileError', code, ...details });
}
function safeError(error) {
  if (error?.code === 'SESSION_EXPIRED') return '微信登录已失效，请在本机重新扫码';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return '微信请求已取消或超时';
  if (/^微信|^本版本|^请先|^只能|^文字|^二维码/.test(error?.message || '')) return error.message;
  return '微信连接请求失败，请检查网络后重试';
}
function delay(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

class Client {
  constructor({ vault, getSettings = () => ({}), onMessage = () => {}, onStatus = () => {},
    fetch: fetchImpl = globalThis.fetch, qrToDataURL, pollDelayMs = 1000, now = Date.now,
    mediaTimeoutMs = 60000 } = {}) {
    if (!vault || !['get', 'set', 'delete'].every(key => typeof vault[key] === 'function')) {
      throw new Error('微信凭据需要注入加密 vault.get/set/delete');
    }
    this.vault = vault; this.getSettings = getSettings; this.onMessage = onMessage;
    this.onStatus = onStatus; this.fetch = fetchImpl; this.now = now;
    this.qrToDataURL = qrToDataURL || ((value, options) => require('qrcode').toDataURL(value, options));
    this.pollDelayMs = pollDelayMs; this.credentials = null; this.pending = null;
    this.mediaTimeoutMs = Number.isFinite(mediaTimeoutMs) && mediaTimeoutMs > 0 ? Math.min(mediaTimeoutMs, 120000) : 60000;
    this.qr = null; this.controller = null; this.background = null; this.generation = 0;
    this.vaultQueue = Promise.resolve();
    this.state = { status: 'unconfigured', connected: false, receiving: false, ownerMasked: '',
      controllerBound: false, qrDataUrl: '', lastPollAt: '', lastReceiveAt: '', lastSendAt: '',
      lastError: '', textSendVerified: false, fileSendSupported: true, fileSendVerified: false };
  }
  status() { return { ...this.state, remoteEnabled: this.getSettings()?.wechatRemoteEnabled === true }; }
  emit(patch) {
    Object.assign(this.state, patch);
    try { this.onStatus(this.status()); } catch { /* UI observer cannot stop network cleanup. */ }
    return this.status();
  }
  async request(base, endpoint, { method = 'POST', body, token, signal, timeoutMs = 40000 } = {}) {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) abort.abort();
    const timer = setTimeout(cancel, timeoutMs);
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '768' };
    if (method === 'POST') {
      Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    try {
      const response = await this.fetch(`${trustedBase(base)}/${endpoint}`, {
        method, headers, body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
        signal: abort.signal, redirect: 'error'
      });
      if (!response.ok) throw Object.assign(new Error(`微信服务器 HTTP ${response.status}`), {
        httpStatus: response.status, apiRejected: response.status >= 400 && response.status < 500
      });
      const raw = await response.text();
      if (raw.length > 2 * 1024 * 1024) throw new Error('微信服务器响应过大');
      const result = JSON.parse(raw);
      if (result.ret === -14 || result.errcode === -14) {
        const error = new Error('微信登录已失效，请在本机重新扫码'); error.code = 'SESSION_EXPIRED'; error.apiRejected = true; throw error;
      }
      if ((result.ret != null && result.ret !== 0) || (result.errcode != null && result.errcode !== 0)) {
        throw Object.assign(new Error('微信服务器拒绝了请求'), { code: 'API_REJECTED', apiRejected: true });
      }
      return result;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  baseInfo() { return { channel_version: CHANNEL_VERSION, bot_agent: `PersonalWorkboard/${CHANNEL_VERSION}` }; }
  mutateVault(action) {
    const operation = this.vaultQueue.then(action);
    this.vaultQueue = operation.catch(() => {});
    return operation;
  }
  async saveCredentials() {
    const auth = this.credentials;
    if (auth) await this.mutateVault(() => auth === this.credentials ? this.vault.set(VAULT_KEY, JSON.stringify(auth)) : undefined);
  }
  async connect() {
    if (this.credentials) return this.status();
    await this.stop();
    const generation = ++this.generation;
    const controller = new AbortController(); this.controller = controller;
    this.pending = null; this.qr = null;
    this.emit({ status: 'connecting', connected: false, controllerBound: false, lastError: '', qrDataUrl: '' });
    try {
      const response = await this.request(API_BASE, 'ilink/bot/get_bot_qrcode?bot_type=3', {
        body: { local_token_list: [] }, signal: controller.signal
      });
      if (!response.qrcode || !response.qrcode_img_content) throw new Error('二维码响应缺少必要字段');
      const qrDataUrl = await this.qrToDataURL(response.qrcode_img_content, { width: 280, margin: 2 });
      if (generation !== this.generation || controller.signal.aborted) return this.status();
      if (!/^data:image\/png;base64,/.test(qrDataUrl)) throw new Error('二维码编码失败');
      this.qr = { value: response.qrcode, base: API_BASE, startedAt: this.now(), verifyCode: '' };
      this.emit({ status: 'awaiting_scan', qrDataUrl });
      this.background = this.pollQr(generation, controller.signal).catch(error => {
        if (generation === this.generation && !controller.signal.aborted) this.emit({ status: 'error', lastError: safeError(error) });
      });
      return this.status();
    } catch (error) {
      if (generation === this.generation) this.emit({ status: 'error', lastError: safeError(error) });
      throw new Error(safeError(error));
    }
  }
  async pollQr(generation, signal) {
    while (!signal.aborted && generation === this.generation && this.qr) {
      if (this.now() - this.qr.startedAt > 5 * 60 * 1000) {
        this.qr = null; this.emit({ status: 'expired', qrDataUrl: '', lastError: '二维码已过期，请点击重新连接' }); return;
      }
      if (this.state.status === 'need_verifycode' && !this.qr.verifyCode) { await delay(this.pollDelayMs, signal); continue; }
      const query = new URLSearchParams({ qrcode: this.qr.value });
      if (this.qr.verifyCode) query.set('verify_code', this.qr.verifyCode);
      const response = await this.request(this.qr.base, `ilink/bot/get_qrcode_status?${query}`, { method: 'GET', signal });
      if (signal.aborted || generation !== this.generation) return;
      if (response.status === 'confirmed') {
        if (![response.bot_token, response.ilink_bot_id, response.ilink_user_id].every(x => typeof x === 'string' && x)) {
          throw new Error('微信扫码结果缺少凭据或本人标识，请重新扫码');
        }
        this.pending = { token: response.bot_token, botId: response.ilink_bot_id,
          owner: response.ilink_user_id, base: trustedBase(response.baseurl), cursor: '', contextToken: '', seen: [] };
        this.qr = null;
        this.emit({ status: 'awaiting_confirmation', ownerMasked: mask(this.pending.owner), qrDataUrl: '',
          connected: false, controllerBound: false });
        return;
      }
      if (response.status === 'scaned_but_redirect' && response.redirect_host) {
        this.qr.base = trustedBase(`https://${response.redirect_host}`);
      } else if (response.status === 'expired' || response.status === 'verify_code_blocked') {
        this.qr = null; this.emit({ status: response.status, qrDataUrl: '', lastError: '二维码已失效，请在本机重新连接' }); return;
      } else if (response.status === 'binded_redirect') {
        this.qr = null; this.emit({ status: 'error', qrDataUrl: '', lastError: '微信提示已绑定，但本机没有有效凭据，请重新连接' }); return;
      } else if (response.status === 'need_verifycode') {
        this.qr.verifyCode = ''; this.emit({ status: 'need_verifycode' });
      } else this.emit({ status: response.status === 'scaned' ? 'scanned' : 'awaiting_scan' });
      await delay(this.pollDelayMs, signal);
    }
  }
  // Called only by the local UI confirmation route; never by an inbound WeChat command.
  async confirm({ verifyCode } = {}) {
    if (this.state.status === 'need_verifycode' && this.qr) {
      if (!/^\d{4,12}$/.test(String(verifyCode || ''))) throw new Error('请先输入手机微信显示的数字验证码');
      this.qr.verifyCode = String(verifyCode); return this.status();
    }
    if (!this.pending) throw new Error('请先完成本机二维码扫描，再确认本人绑定');
    const pending = this.pending;
    await this.mutateVault(() => {
      if (pending !== this.pending) throw new Error('微信绑定状态已改变，请重新确认');
      return this.vault.set(VAULT_KEY, JSON.stringify(pending));
    });
    if (pending !== this.pending) throw new Error('微信绑定状态已改变，请重新确认');
    this.credentials = pending; this.pending = null;
    await this.start(); return this.status();
  }
  async start() {
    if (this.credentials && this.state.receiving && this.controller && !this.controller.signal.aborted) return this.status();
    if (!this.credentials) {
      await this.vaultQueue;
      const raw = await this.vault.get(VAULT_KEY);
      if (!raw) return this.status();
      try {
        const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!saved.token || !saved.owner || !saved.botId) throw new Error();
        saved.base = trustedBase(saved.base); saved.seen = Array.isArray(saved.seen) ? saved.seen.slice(-1000) : [];
        this.credentials = saved;
      } catch { this.emit({ status: 'error', lastError: '微信加密凭据无效，请重新连接' }); return this.status(); }
    }
    await this.stop();
    const generation = ++this.generation; const controller = new AbortController(); this.controller = controller;
    this.emit({ status: 'connected', connected: true, controllerBound: true,
      ownerMasked: mask(this.credentials.owner), qrDataUrl: '', receiving: false, lastError: '' });
    this.background = this.pollMessages(generation, controller.signal).catch(error => {
      if (generation === this.generation && !controller.signal.aborted) {
        this.emit({ status: 'error', receiving: false, connected: error.code !== 'SESSION_EXPIRED',
          controllerBound: error.code !== 'SESSION_EXPIRED', lastError: safeError(error) });
      }
    });
    return this.status();
  }
  async pollMessages(generation, signal) {
    let errors = 0;
    while (!signal.aborted && generation === this.generation && this.credentials) {
      const auth = this.credentials;
      try {
        const result = await this.request(auth.base, 'ilink/bot/getupdates', { token: auth.token, signal,
          body: { get_updates_buf: auth.cursor || '', base_info: this.baseInfo() } });
        if (signal.aborted || generation !== this.generation) return;
        errors = 0;
        this.emit({ status: 'connected', receiving: true, lastPollAt: new Date(this.now()).toISOString(), lastError: '' });
        let changed = false;
        for (const msg of Array.isArray(result.msgs) ? result.msgs : []) {
          if (msg.from_user_id !== auth.owner || msg.group_id || msg.message_type !== 1 || msg.delete_time_ms) continue;
          const text = (Array.isArray(msg.item_list) ? msg.item_list : [])
            .filter(item => item.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item.text).join('\n');
          if (!text.trim() || text.length > 50000 || (typeof msg.message_id === 'number' && !Number.isSafeInteger(msg.message_id))) continue;
          const id = String(msg.message_id || msg.client_id || createHash('sha256').update(JSON.stringify(msg)).digest('hex'));
          if (auth.seen.includes(id)) continue;
          if (typeof msg.context_token === 'string' && msg.context_token) auth.contextToken = msg.context_token;
          // Persist before dispatch: if the process dies during a remote task, the same
          // message cannot execute again after restart. Failed dispatch needs a new user command.
          auth.seen.push(id); auth.seen = auth.seen.slice(-1000);
          await this.saveCredentials();
          if (signal.aborted || generation !== this.generation) return;
          await this.onMessage({ id, messageId: id, senderId: auth.owner, verifiedOwner: true, text,
            receivedAt: new Date(this.now()).toISOString(), source: 'wechat-personal-bot' });
          if (signal.aborted || generation !== this.generation) return;
          changed = true;
          this.emit({ lastReceiveAt: new Date(this.now()).toISOString() });
        }
        if (typeof result.get_updates_buf === 'string' && result.get_updates_buf && result.get_updates_buf !== auth.cursor) {
          auth.cursor = result.get_updates_buf; changed = true;
        }
        if (changed) await this.saveCredentials();
        await delay(this.pollDelayMs, signal);
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return;
        if (error.code === 'SESSION_EXPIRED') throw error;
        this.emit({ status: 'error', receiving: false, lastError: safeError(error) });
        await delay(Math.min(30000, 1000 * (2 ** Math.min(errors++, 5))), signal);
      }
    }
  }
  async sendText(input, options = {}) {
    const payload = typeof input === 'string' ? { ...options, text: input } : (input || {});
    const auth = this.credentials;
    if (!auth || !this.state.controllerBound) throw new Error('请先在本机确认微信本人绑定');
    if (payload.to && payload.to !== auth.owner) throw new Error('只能发送给本机已确认绑定的本人');
    if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4000) throw new Error('文字长度须为 1 至 4000 字，请分段发送');
    if (!auth.contextToken) throw new Error('请先由绑定本人向微信助手发送一条消息，以建立可回复会话');
    const clientId = payload.clientId || randomUUID();
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(clientId)) throw new Error('微信发送请求标识无效');
    const generation = this.generation;
    const response = await this.request(auth.base, 'ilink/bot/sendmessage', { token: auth.token,
      signal: this.controller?.signal, body: {
      msg: { from_user_id: '', to_user_id: auth.owner, client_id: clientId,
        message_type: 2, message_state: 2, context_token: auth.contextToken,
        item_list: [{ type: 1, text_item: { text: payload.text } }] }, base_info: this.baseInfo()
    } });
    if (response.ret !== 0) throw new Error('微信服务器未明确确认接收，不能标记发送成功');
    if (generation === this.generation && auth === this.credentials) this.emit({ lastSendAt: new Date(this.now()).toISOString(), textSendVerified: true });
    return { accepted: true, clientId, deliveryStatus: 'server_accepted', readStatus: 'unknown' };
  }
  async sendFile(input = {}) {
    const payload = input && typeof input === 'object' ? input : {};
    const clientId = payload.clientId ?? randomUUID();
    const details = { clientId, phase: 'validation', accepted: false, uploaded: false,
      uploadStatus: 'not_started', deliveryStatus: 'not_sent', readStatus: 'unknown' };
    try {
      // A path is deliberately not dereferenced. Legacy callers receive an explicit error.
      if (payload.path != null || payload.filePath != null) throw new Error('本版本尚未实现按磁盘路径直接发送；请传入已授权文件的 Buffer 字节和文件名');
      if (typeof clientId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(clientId)) throw new Error('微信发送请求标识无效');
      if (!Buffer.isBuffer(payload.bytes)) throw new Error('微信文件必须提供 Buffer 字节，不能传入磁盘路径');
      if (payload.bytes.length < 1 || payload.bytes.length > MAX_FILE_BYTES) throw new Error('微信文件大小须为 1 字节至 20 MiB');
      details.filename = validateFilename(payload.filename);
      // Snapshot once before awaiting: mutation by the caller cannot change hashed/encrypted content.
      const bytes = Buffer.from(payload.bytes);
      details.size = bytes.length;
      details.sha256 = createHash('sha256').update(bytes).digest('hex');
      details.md5 = createHash('md5').update(bytes).digest('hex');
      if (payload.onProgress != null && typeof payload.onProgress !== 'function') throw new Error('微信文件进度回调无效');
      const auth = this.credentials;
      if (!auth || !this.state.controllerBound || !auth.token || !auth.owner) throw new Error('请先在本机确认微信本人绑定');
      if (payload.to != null && payload.to !== auth.owner) throw new Error('只能发送给本机已确认绑定的本人');
      if (!auth.contextToken) throw new Error('请先由绑定本人向微信助手发送一条消息，以建立可回复会话');
      const generation = this.generation;
      const signal = this.controller?.signal;
      const assertBinding = () => {
        if (signal?.aborted || generation !== this.generation || auth !== this.credentials || !this.state.controllerBound) {
          throw new Error('微信本人绑定或连接状态已改变，文件发送已停止');
        }
      };
      const progress = async phase => {
        details.phase = phase;
        if (payload.onProgress) {
          try {
            await payload.onProgress({ phase, uploadStatus: details.uploadStatus,
              sha256: details.sha256, size: details.size, clientId });
          } catch {
            throw fileError('微信文件阶段记录失败，已停止后续发送', details, 'WECHAT_FILE_PROGRESS_FAILED');
          }
        }
        assertBinding();
      };
      assertBinding();
      const aeskey = randomBytes(16);
      const filekey = randomBytes(16).toString('hex');
      const cipher = createCipheriv('aes-128-ecb', aeskey, null);
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      details.phase = 'get_upload_url';
      const upload = await this.request(auth.base, 'ilink/bot/getuploadurl', { token: auth.token, signal,
        timeoutMs: 15000, body: { filekey, media_type: 3, to_user_id: auth.owner,
          rawsize: bytes.length, rawfilemd5: details.md5, filesize: ciphertext.length,
          no_need_thumb: true, aeskey: aeskey.toString('hex'), base_info: this.baseInfo() } });
      assertBinding();
      const full = typeof upload.upload_full_url === 'string' ? upload.upload_full_url.trim() : '';
      const param = typeof upload.upload_param === 'string' ? upload.upload_param : '';
      if (!full && !param) throw new Error('微信文件上传参数缺少必要字段');
      const uploadUrl = trustedUploadUrl(full || `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(filekey)}`);
      await progress('uploading');
      const abort = new AbortController();
      const cancel = () => abort.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) abort.abort();
      const timer = setTimeout(cancel, this.mediaTimeoutMs);
      let downloadParam;
      try {
        details.uploaded = null; details.uploadStatus = 'unknown';
        const response = await this.fetch(uploadUrl, { method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(ciphertext),
          signal: abort.signal, redirect: 'error' });
        if (response.status >= 400 && response.status < 500) {
          details.uploaded = false; details.uploadStatus = 'rejected';
          throw new Error('微信文件 CDN 明确拒绝上传');
        }
        if (response.status !== 200) throw new Error('微信文件 CDN 上传结果不明');
        downloadParam = response.headers.get('x-encrypted-param');
        if (!downloadParam || !downloadParam.trim() || downloadParam.length > 64 * 1024) throw new Error('微信文件上传响应缺少有效下载引用，上传结果不明');
        details.uploaded = true; details.uploadStatus = 'server_accepted';
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      }
      await progress('uploaded');
      await progress('sending');
      // This is the only message submission. An unknown outcome is never retried here.
      details.accepted = null; details.deliveryStatus = 'unknown';
      const response = await this.request(auth.base, 'ilink/bot/sendmessage', { token: auth.token, signal,
        timeoutMs: 15000, body: { msg: { from_user_id: '', to_user_id: auth.owner, client_id: clientId,
          message_type: 2, message_state: 2, context_token: auth.contextToken,
          item_list: [{ type: 4, file_item: { file_name: details.filename, len: String(bytes.length),
            media: { encrypt_query_param: downloadParam,
              // Official sender encodes the UTF-8 hex string, not the raw key bytes.
              aes_key: Buffer.from(aeskey.toString('hex'), 'utf8').toString('base64'), encrypt_type: 1 } } }] },
          base_info: this.baseInfo() } });
      if (response.ret !== 0) throw new Error('微信服务器未明确确认文件消息，发送结果不明');
      details.accepted = true; details.deliveryStatus = 'server_accepted'; details.phase = 'accepted';
      if (generation === this.generation && auth === this.credentials) this.emit({
        lastSendAt: new Date(this.now()).toISOString(), fileSendVerified: true });
      if (typeof response.message_id === 'string') details.serverMessageId = response.message_id;
      return { ...details };
    } catch (error) {
      if (error?.name === 'WechatFileError') throw error;
      if (error?.apiRejected && details.phase === 'sending') {
        details.accepted = false; details.deliveryStatus = 'server_rejected';
      }
      if (error?.code === 'SESSION_EXPIRED') {
        await this.stop();
        this.emit({ status: 'error', connected: false, controllerBound: false,
          receiving: false, lastError: safeError(error) });
      }
      const message = details.deliveryStatus === 'unknown'
        ? '微信文件消息发送结果不明，请核对本人微信后决定；本机不会自动重发'
        : details.uploadStatus === 'unknown'
          ? '微信文件上传结果不明，尚未发送文件消息；本机不会自动重试'
          : safeError(error);
      throw fileError(message, details, error?.code || 'WECHAT_FILE_FAILED');
    }
  }
  async stop() {
    ++this.generation; this.controller?.abort(); this.controller = null;
    this.emit({ receiving: false });
    // Generation guards prevent a late response from restoring state after disconnect.
    this.background = null;
    return this.status();
  }
  async disconnect() {
    await this.stop(); this.credentials = null; this.pending = null; this.qr = null;
    await this.mutateVault(() => this.vault.delete(VAULT_KEY));
    return this.emit({ status: 'unconfigured', connected: false, controllerBound: false, ownerMasked: '',
      qrDataUrl: '', lastError: '', textSendVerified: false, fileSendVerified: false });
  }
}
function WechatClient(options) { return new Client(options); }
module.exports = { WechatClient, VAULT_KEY, trustedBase, MAX_FILE_BYTES, MAX_FILENAME_BYTES };
