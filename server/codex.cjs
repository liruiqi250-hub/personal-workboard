'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn: nodeSpawn } = require('node:child_process');
const { randomBytes, randomUUID, createHash } = require('node:crypto');

function findCodexExecutable(env = process.env, platform = process.platform) {
  const names = platform === 'win32' ? ['codex.exe'] : ['codex'];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
      if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
    }
  }
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const bin = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    if (fs.existsSync(bin)) {
      const candidates = fs.readdirSync(bin, { withFileTypes: true }).filter(item => item.isDirectory())
        .map(item => path.join(bin, item.name, 'codex.exe')).filter(candidate => fs.existsSync(candidate));
      candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (candidates.length) return candidates[0];
    }
  }
  return null;
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyOf = id => `${typeof id}:${String(id)}`;
const boundedText = (value, limit = 16000) => typeof value === 'string' ? value.slice(0, limit) : '';
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const copy = value => JSON.parse(JSON.stringify(value));
const ACTIVE_STATUSES = new Set(['starting', 'running', 'inProgress', 'waiting_approval', 'resuming']);
const MAX_RESULT_CHARS = 8 * 1024 * 1024;
const retiredTurn = (thread, id) => id && (id === thread.lastCompletedTurnId || id === thread.uncertainTurnId || thread.retiredTurnIds?.includes(id));
const retire = (thread, id) => {
  thread.retiredTurnIds ||= [];
  if (id && !thread.retiredTurnIds.includes(id)) thread.retiredTurnIds.push(id);
};
const deepFreeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};
// Deliberately support a bounded subset of the locally verified approval schema.
// Unsupported requests are refused, never shortened into an apparently smaller grant.
function approvalSnapshot(method, params, fallbackCwd) {
  const fail = () => { throw new Error('审批请求过长或含本版本不支持的字段/格式，已拒绝；请在本机核对完整请求并处理'); };
  const object = (value, keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail();
  };
  const text = (value, limit, required = false, pathText = false) => {
    if (value == null && !required) return;
    if (typeof value !== 'string' || value.length > limit || required && !value.length ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
        pathText && /[\r\n\t]/u.test(value)) fail();
  };
  const list = (value, validate) => {
    if (value == null) return;
    if (!Array.isArray(value) || value.length > 32) fail();
    for (const entry of value) validate(entry);
  };
  const optionalObject = (value, keys, validate) => { if (value != null) { object(value, keys); validate(value); } };
  let serialized;
  try { serialized = JSON.stringify(params); } catch { fail(); }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 16 * 1024) fail();
  const p = JSON.parse(serialized);
  const common = ['threadId', 'turnId', 'itemId', 'startedAtMs', 'reason'];
  const command = method === 'item/commandExecution/requestApproval';
  const permissions = method === 'item/permissions/requestApproval';
  object(p, [...common, ...(command ? ['command', 'cwd', 'kind', 'approvalId', 'environmentId', 'commandActions',
    'networkApprovalContext', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments'] :
    permissions ? ['cwd', 'environmentId', 'permissions'] : ['grantRoot'])]);
  text(p.threadId, 512, true); text(p.turnId, 512, true); text(p.itemId, 512);
  text(p.reason, 2000); text(p.cwd, 2000, false, true); text(p.grantRoot, 2000, false, true);
  text(p.cwd ?? fallbackCwd, 2000, true, true);
  if (!path.isAbsolute(p.cwd ?? fallbackCwd)) fail();
  text(p.approvalId, 512); text(p.environmentId, 512);
  if (p.startedAtMs != null && (!Number.isSafeInteger(p.startedAtMs) || p.startedAtMs < 0)) fail();
  // These request forms can imply terminal input, another environment, or a session-wide
  // grant. The remote interface only offers a single explicit request in the local turn.
  if (p.environmentId || p.grantRoot || p.kind != null && p.kind !== 'command' ||
      p.proposedExecpolicyAmendment != null || p.proposedNetworkPolicyAmendments != null) fail();
  if (command) {
    text(p.command, 8000);
    optionalObject(p.networkApprovalContext, ['host', 'protocol'], network => {
      text(network.host, 2000, true);
      if (/\s/u.test(network.host)) fail();
      if (!['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(network.protocol)) fail();
    });
    if (!p.command && !p.networkApprovalContext) fail();
    list(p.commandActions, action => {
      object(action, ['type', 'command', 'name', 'path', 'query']);
      if (!['read', 'listFiles', 'search', 'unknown'].includes(action.type)) fail();
      text(action.command, 8000, true); text(action.name, 512); text(action.path, 2000, false, true); text(action.query, 2000);
      if (action.type === 'read') { text(action.name, 512, true); text(action.path, 2000, true, true); }
    });
  }
  if (permissions) {
    text(p.cwd, 2000, true, true);
    object(p.permissions, ['network', 'fileSystem']);
    optionalObject(p.permissions.network, ['enabled'], network => {
      if (network.enabled != null && typeof network.enabled !== 'boolean') fail();
    });
    optionalObject(p.permissions.fileSystem, ['entries', 'globScanMaxDepth', 'read', 'write'], fileSystem => {
      if (fileSystem.globScanMaxDepth != null && (!Number.isSafeInteger(fileSystem.globScanMaxDepth) || fileSystem.globScanMaxDepth < 1)) fail();
      for (const mode of ['read', 'write']) list(fileSystem[mode], entry => text(entry, 2000, true, true));
      list(fileSystem.entries, entry => {
        object(entry, ['access', 'path']);
        if (!['read', 'write', 'deny'].includes(entry.access)) fail();
        object(entry.path, ['type', 'path', 'pattern', 'value']);
        if (entry.path.type === 'path') {
          if ('pattern' in entry.path || 'value' in entry.path) fail(); text(entry.path.path, 2000, true, true);
        } else if (entry.path.type === 'glob_pattern') {
          if ('path' in entry.path || 'value' in entry.path) fail(); text(entry.path.pattern, 2000, true, true);
        } else if (entry.path.type === 'special') {
          if ('path' in entry.path || 'pattern' in entry.path) fail();
          const special = entry.path.value; object(special, ['kind', 'path', 'subpath']);
          if (!['root', 'minimal', 'project_roots', 'tmpdir', 'slash_tmp', 'unknown'].includes(special.kind)) fail();
          text(special.path, 2000, special.kind === 'unknown', true); text(special.subpath, 2000, false, true);
          if (special.kind !== 'unknown' && 'path' in special || !['unknown', 'project_roots'].includes(special.kind) && 'subpath' in special) fail();
        } else fail();
      });
    });
  }
  return deepFreeze(p);
}

class Controller {
  constructor({ getSettings = () => ({}), onOutput = () => {}, onApproval = () => {},
    spawn = nodeSpawn, executable, requestTimeoutMs = 30000, approvalTimeoutMs = 10 * 60 * 1000,
    resolveProject = value => fs.realpathSync.native(value), now = Date.now, persistence } = {}) {
    this.getSettings = getSettings; this.onOutput = onOutput; this.onApproval = onApproval;
    this.spawn = spawn; this.executable = executable; this.requestTimeoutMs = requestTimeoutMs;
    this.approvalTimeoutMs = approvalTimeoutMs; this.resolveProject = resolveProject; this.now = now;
    this.child = null; this.reader = null; this.initializing = null; this.sequence = 0;
    this.pending = new Map(); this.managed = new Map(); this.approvals = new Map();
    this.requests = new Map(); this.version = ''; this.protocolReady = false; this.lastError = '';
    this.startingEvents = new Map();
    this.authenticated = null; this.stopping = false; this.processGeneration = 0; this.lifecycle = 0;
    this.persistence = persistence; this.persistenceFault = ''; this.lastThreadId = null;
    if (persistence && (typeof persistence.load !== 'function' || typeof persistence.save !== 'function')) {
      throw new Error('Codex 持久存储必须提供同步 load/save');
    }
    this.restore();
  }
  restore() {
    if (!this.persistence) return;
    const state = this.persistence.load();
    if (state && typeof state.then === 'function') throw new Error('Codex 持久存储 load 必须同步返回');
    if (state == null) return;
    if (state.schemaVersion !== 1 || state.owner !== 'personal-workboard' || !Array.isArray(state.threads) || !Array.isArray(state.requests)) {
      throw new Error('Codex 受管会话存储格式无效，已停止恢复');
    }
    let changed = false;
    for (const saved of state.threads) {
      if (!saved || typeof saved.id !== 'string' || !saved.id || typeof saved.cwd !== 'string' || !path.isAbsolute(saved.cwd) || this.managed.has(saved.id)) {
        throw new Error('Codex 受管会话存储含无效 ID 或目录，已停止恢复');
      }
      const thread = copy(saved);
      retire(thread, thread.lastCompletedTurnId); retire(thread, thread.uncertainTurnId);
      if (thread.activeTurnId || thread.starting || thread.resuming || ACTIVE_STATUSES.has(thread.status)) {
        thread.uncertainTurnId = thread.activeTurnId || thread.uncertainTurnId || null;
        retire(thread, thread.activeTurnId);
        thread.status = 'needs_review'; thread.activeTurnId = null; thread.starting = false; thread.resuming = false;
        changed = true;
      }
      this.managed.set(thread.id, thread);
    }
    for (const saved of state.requests) {
      if (!saved || typeof saved.id !== 'string' || !saved.id || typeof saved.fingerprint !== 'string' || this.requests.has(saved.id)) {
        throw new Error('Codex 请求账本含无效记录，已停止恢复');
      }
      this.requests.set(saved.id, { ...copy(saved), recovered: true });
    }
    this.lastThreadId = this.managed.has(state.lastThreadId) ? state.lastThreadId : null;
    if (changed) this.persist();
  }
  persist() {
    if (this.persistenceFault) throw new Error(this.persistenceFault);
    if (!this.persistence) return;
    const state = { schemaVersion: 1, owner: 'personal-workboard', lastThreadId: this.lastThreadId,
      threads: [...this.managed.values()].map(copy), requests: [...this.requests].map(([id, entry]) => ({
        id, fingerprint: entry.fingerprint, state: entry.state, createdAt: entry.createdAt,
        updatedAt: entry.updatedAt, threadId: entry.threadId || null, turnId: entry.turnId || null,
      })) };
    try {
      const result = this.persistence.save(state);
      if (result && typeof result.then === 'function') throw new Error('save 必须同步完成');
    } catch {
      this.persistenceFault = 'Codex 受管状态持久化失败，已阻止继续提交任务；请在本机检查数据目录后重启';
      throw new Error(this.persistenceFault);
    }
  }
  saveThread(thread) {
    thread.updatedAt = new Date(this.now()).toISOString();
    this.persist();
  }
  verifyReturnedProject(result, thread) {
    if (result?.thread?.id !== thread.id) throw new Error('Codex 返回的会话 ID 与请求不一致');
    const values = [result.cwd, result.thread?.cwd].filter(value => value != null);
    if (!values.length) throw new Error('Codex 未返回可核对的会话项目目录，已拒绝继续');
    for (const value of values) {
      if (typeof value !== 'string' || !path.isAbsolute(value) || !samePath(this.project(value), thread.cwd)) {
        throw new Error('Codex 返回的会话项目目录与受管记录不一致');
      }
    }
    this.project(thread.cwd);
  }
  emit(event) {
    try { Promise.resolve(this.onOutput({ at: new Date(this.now()).toISOString(), ...event })).catch(() => {}); } catch {}
  }
  async versionCheck() {
    const executable = this.executable || findCodexExecutable();
    if (!executable) throw new Error('未找到本机 Codex 可执行文件，请先安装或更新 Codex');
    this.executable = executable;
    this.version = await new Promise((resolve, reject) => {
      const proc = this.spawn(executable, ['--version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; const timer = setTimeout(() => { proc.kill(); reject(new Error('Codex 版本检测超时')); }, 10000);
      proc.stdout?.on('data', chunk => { output = (output + chunk.toString()).slice(0, 1024); });
      proc.stderr?.resume();
      proc.once('error', () => { clearTimeout(timer); reject(new Error('本机 Codex 无法启动')); });
      proc.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error('Codex 版本检测失败')); });
    });
    return this.version;
  }
  write(message) {
    if (!this.child || !this.child.stdin?.writable) throw new Error('Codex 本机连接已断开');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(keyOf(id)); reject(new Error(`Codex ${method} 请求超时`)); }, this.requestTimeoutMs);
      this.pending.set(keyOf(id), { resolve, reject, timer, method });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(keyOf(id)); reject(error); }
    });
  }
  async ensureReady() {
    if (this.protocolReady && this.child) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.open(this.lifecycle).finally(() => { this.initializing = null; });
    return this.initializing;
  }
  async open(lifecycle) {
    if (!this.version) await this.versionCheck();
    if (lifecycle !== this.lifecycle) throw new Error('Codex 初始化已由本机停止');
    this.stopping = false;
    const generation = ++this.processGeneration;
    // All config overrides are scoped to this child process. Existing config.toml is never edited.
    const args = ['app-server', '--listen', 'stdio://', '--disable', 'hooks',
      '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="on-request"',
      '-c', 'approvals_reviewer="user"', '-c', 'sandbox_workspace_write.network_access=false'];
    const child = this.spawn(this.executable, args, { shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stderr?.resume(); // Never forward global configuration or credential-bearing diagnostics.
    child.stdin?.on('error', () => {});
    this.reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on('line', line => {
      if (generation !== this.processGeneration) return;
      if (line.length > 4 * 1024 * 1024) { this.failConnection('Codex 协议消息过大'); child.kill(); return; }
      let message;
      try { message = JSON.parse(line); } catch { this.failConnection('Codex 返回了无法解析的本机协议消息'); child.kill(); return; }
      try { this.receive(message); } catch (error) {
        const affected = this.managed.get(message.params?.threadId);
        if (affected && !affected.activeTurnId && !affected.starting) {
          affected.status = 'needs_review';
          this.emit({ type: 'error', threadId: affected.id, text: this.persistenceFault || error.message });
        }
        this.failConnection(this.persistenceFault || error.message || 'Codex 本机协议处理失败'); child.kill();
      }
    });
    child.once('error', () => { if (generation === this.processGeneration) this.failConnection('Codex 本机进程启动失败'); });
    child.once('exit', () => {
      if (generation !== this.processGeneration) return;
      this.failConnection(this.stopping ? '' : 'Codex 本机进程已退出'); this.child = null;
    });
    try {
      await this.request('initialize', { clientInfo: { name: 'personal_workboard',
        title: '个人待办事项看板', version: require('../package.json').version } });
      this.write({ method: 'initialized', params: {} });
      this.protocolReady = true; this.lastError = '';
    } catch (error) { child.kill(); throw error; }
  }
  failConnection(reason) {
    this.protocolReady = false; this.lastError = reason;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason || 'Codex 已停止')); }
    this.pending.clear();
    for (const approval of this.approvals.values()) clearTimeout(approval.timer);
    this.approvals.clear();
    this.startingEvents.clear();
    for (const thread of this.managed.values()) {
      if (thread.activeTurnId || thread.starting || thread.resuming) {
        thread.uncertainTurnId = thread.activeTurnId || thread.uncertainTurnId || null;
        retire(thread, thread.activeTurnId);
        thread.status = 'needs_review'; thread.activeTurnId = null; thread.starting = false; thread.resuming = false;
        this.emit({ type: 'error', threadId: thread.id, text: reason || 'Codex 连接已停止，未完成任务' });
      }
    }
    try { this.persist(); } catch (error) { this.lastError = error.message; }
  }
  receive(message) {
    // The protocol may emit before turn/start replies. Never infer the new turn ID from
    // an unsolicited approval or completion; replay only after the response confirms it.
    const startingThread = this.managed.get(message.params?.threadId);
    const queue = startingThread && this.startingEvents.get(startingThread.id);
    if (message.method && queue && startingThread.starting && !startingThread.activeTurnId) {
      queue.characters += JSON.stringify(message).length;
      if (queue.messages.length >= 512 || queue.characters > 16 * 1024 * 1024) throw new Error('Codex 启动轮次通知超过缓冲上限，请在本机核对');
      queue.messages.push(message); return;
    }
    if (message.method && message.id != null) return this.serverRequest(message);
    if (message.id != null) {
      const pending = this.pending.get(keyOf(message.id));
      if (!pending) return;
      this.pending.delete(keyOf(message.id)); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Codex ${pending.method} 失败：${boundedText(message.error.message, 1000)}`));
      else pending.resolve(message.result);
      return;
    }
    const p = message.params || {};
    const thread = this.managed.get(p.threadId);
    if (!thread) return; // Existing desktop chats are neither read nor controlled.
    if (message.method === 'turn/started') {
      const turnId = p.turn?.id;
      if (turnId && (thread.starting || thread.activeTurnId === turnId) && thread.lastCompletedTurnId !== turnId) {
        if (retiredTurn(thread, turnId)) return;
        thread.activeTurnId = turnId; thread.status = 'running'; this.saveThread(thread);
      }
    } else if (message.method === 'item/agentMessage/delta') {
      if (!thread.activeTurnId || p.turnId !== thread.activeTurnId) return;
      this.emit({ type: 'delta', threadId: thread.id, turnId: p.turnId, text: typeof p.delta === 'string' ? p.delta : '' });
    } else if (message.method === 'item/completed') {
      if (!thread.activeTurnId && !thread.starting || !p.turnId || retiredTurn(thread, p.turnId)) return;
      if (thread.activeTurnId && p.turnId !== thread.activeTurnId) return;
      if (!thread.activeTurnId) thread.activeTurnId = p.turnId;
      if (p.item?.type === 'agentMessage') {
        const text = this.recordMessage(thread, p.item);
        this.saveThread(thread);
        this.emit({ type: 'message', threadId: thread.id, turnId: p.turnId, text });
      } else if (p.item?.type === 'fileChange') {
        this.recordArtifacts(thread, p.item, p.turnId); this.saveThread(thread);
      }
    } else if (message.method === 'turn/completed') {
      const turn = p.turn || {};
      if (typeof turn.id !== 'string' || !turn.id) return;
      if (thread.activeTurnId && turn.id && thread.activeTurnId !== turn.id) return;
      if (!thread.activeTurnId && !thread.starting || thread.lastCompletedTurnId === turn.id) return;
      if (retiredTurn(thread, turn.id)) return;
      for (const item of turn.items || []) {
        if (item.type === 'agentMessage') this.recordMessage(thread, item);
        if (item.type === 'fileChange') this.recordArtifacts(thread, item, turn.id);
      }
      thread.lastCompletedTurnId = turn.id;
      retire(thread, turn.id);
      thread.status = turn.status || 'completed'; thread.activeTurnId = null; thread.starting = false;
      thread.updatedAt = new Date(this.now()).toISOString();
      this.clearApprovals(thread.id, turn.id);
      const previousResult = thread.result;
      thread.result = { threadId: thread.id, cwd: thread.cwd, turnId: turn.id, status: thread.status,
        text: thread.lastOutput || '', artifacts: copy(thread.artifacts || []),
        error: boundedText(turn.error?.message, 3000), completedAt: thread.updatedAt };
      try { this.saveThread(thread); } catch (error) { thread.result = previousResult; throw error; }
      this.emit({ type: 'completed', threadId: thread.id, turnId: turn.id, status: thread.status,
        cwd: thread.cwd, text: thread.lastOutput || '', artifacts: copy(thread.artifacts || []),
        error: boundedText(turn.error?.message, 3000) });
    } else if (message.method === 'serverRequest/resolved') {
      for (const [code, approval] of this.approvals) {
        if (keyOf(approval.rpcId) === keyOf(p.requestId)) { clearTimeout(approval.timer); this.approvals.delete(code); }
      }
    } else if (message.method === 'error') {
      this.emit({ type: 'error', threadId: thread.id, turnId: p.turnId,
        text: boundedText(p.error?.message || p.message, 3000) || 'Codex 执行发生错误' });
    }
  }
  recordMessage(thread, item) {
    const text = typeof item.text === 'string' ? item.text : '';
    thread.messages ||= [];
    const id = item.id || 'unidentified-agent-message';
    const existing = thread.messages.find(entry => entry.id === id);
    if (existing) existing.text = text; else thread.messages.push({ id, text });
    thread.lastOutput = thread.messages.map(entry => entry.text).join('\n\n');
    if (thread.lastOutput.length > MAX_RESULT_CHARS) throw new Error('Codex 本轮完整结果超过 8 Mi 字符，无法完整登记，请在本机核对');
    return text;
  }
  recordArtifacts(thread, item, turnId) {
    if (item.status !== 'completed' || !Array.isArray(item.changes)) return;
    thread.artifacts ||= [];
    for (const change of item.changes) {
      if (!['add', 'update', 'delete'].includes(change.kind?.type) || typeof change.path !== 'string' || !change.path) continue;
      const outputPath = change.kind?.move_path || change.path;
      if (typeof outputPath !== 'string' || outputPath.includes('\0')) continue;
      const filename = path.isAbsolute(outputPath) ? path.normalize(outputPath) : path.resolve(thread.cwd, outputPath);
      const relative = path.relative(thread.cwd, filename);
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) continue;
      if (change.kind.type === 'delete') {
        thread.artifacts = thread.artifacts.filter(entry => !samePath(entry.path, filename)); continue;
      }
      if (change.kind.move_path) {
        const originalPath = path.resolve(thread.cwd, change.path);
        thread.artifacts = thread.artifacts.filter(entry => !samePath(entry.path, originalPath));
      }
      if (!thread.artifacts.some(entry => samePath(entry.path, filename))) thread.artifacts.push({
        path: filename, threadId: thread.id, turnId, itemId: item.id || '',
        kind: change.kind.type, source: 'fileChange', status: 'completed',
      });
    }
  }
  serverRequest({ id, method, params: p = {} }) {
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'];
    const thread = this.managed.get(p?.threadId);
    if (!thread || !p.turnId || (!thread.activeTurnId && !thread.starting) ||
        (thread.activeTurnId && thread.activeTurnId !== p.turnId) || !supported.includes(method)) {
      this.write({ id, error: { code: -32601, message: 'This client requires a managed thread and a supported explicit approval.' } });
      if (thread) this.emit({ type: 'error', threadId: thread.id, text: 'Codex 请求了本版本不支持的交互，未自动批准；请在本机处理或停止本次任务' });
      return;
    }
    if (retiredTurn(thread, p.turnId)) {
      this.write({ id, error: { code: -32601, message: 'An old turn cannot restore approval requests.' } }); return;
    }
    try {
      if (typeof id !== 'string' && !Number.isSafeInteger(id) || typeof id === 'string' && (!id || id.length > 512)) throw new Error('审批 RPC ID 格式不受支持');
      p = approvalSnapshot(method, p, thread.cwd);
    } catch (error) {
      this.write({ id, error: { code: -32602, message: 'Unsupported or oversized approval request. Handle the full request locally.' } });
      this.emit({ type: 'error', threadId: thread.id, turnId: p?.turnId, text: error.message });
      return;
    }
    if (!thread.activeTurnId) thread.activeTurnId = p.turnId;
    if ([...this.approvals.values()].some(entry => keyOf(entry.rpcId) === keyOf(id))) return;
    let code; do { code = randomBytes(4).toString('hex').toUpperCase(); } while (this.approvals.has(code));
    const approval = { code, rpcId: id, method, threadId: p.threadId, turnId: p.turnId,
      itemId: p.itemId, params: p, expiresAt: this.now() + this.approvalTimeoutMs };
    approval.timer = setTimeout(() => {
      if (!this.approvals.has(code)) return;
      try { this.resolveApproval(approval, false); } catch { /* The disconnected server cannot accept a decision. */ }
      this.emit({ type: 'approval_expired', threadId: p.threadId, turnId: p.turnId, text: `审批码 ${code} 已过期，本次请求已拒绝` });
    }, this.approvalTimeoutMs);
    approval.timer.unref?.(); this.approvals.set(code, approval);
    thread.status = 'waiting_approval'; this.saveThread(thread);
    const event = deepFreeze({ code, requestId: id, threadId: p.threadId, turnId: p.turnId, itemId: p.itemId,
      type: method, reason: p.reason || '', command: p.command || '',
      cwd: p.cwd ?? thread.cwd, grantRoot: p.grantRoot || '',
      network: p.networkApprovalContext || null,
      permissions: method === 'item/permissions/requestApproval' ? p.permissions : null,
      expiresAt: new Date(approval.expiresAt).toISOString(),
      request: p,
      instructions: `仅本次请求：/同意 ${code} 或 /拒绝 ${code}；不接受全会话永久放行` });
    try { Promise.resolve(this.onApproval(event)).catch(() => {}); } catch {}
  }
  clearApprovals(threadId, turnId) {
    for (const [code, entry] of this.approvals) {
      if (entry.threadId === threadId && (!turnId || entry.turnId === turnId)) {
        clearTimeout(entry.timer); this.approvals.delete(code);
      }
    }
  }
  remoteSettings() {
    const settings = this.getSettings() || {};
    if (settings.wechatRemoteEnabled !== true) throw new Error('本机尚未开启微信遥控 Codex');
    if (!Array.isArray(settings.allowedProjects) || !settings.allowedProjects.length) throw new Error('请先在本机选择允许 Codex 操作的项目目录');
    return settings;
  }
  project(requested) {
    const settings = this.remoteSettings();
    const chosen = requested || (settings.allowedProjects.length === 1 ? settings.allowedProjects[0] : '');
    if (typeof chosen !== 'string' || !path.isAbsolute(chosen)) throw new Error('请明确选择一个本机已授权的项目绝对路径');
    let cwd;
    try { cwd = this.resolveProject(chosen); } catch { throw new Error('所选项目目录不存在或无法读取'); }
    const allowed = settings.allowedProjects.some(value => {
      try { return typeof value === 'string' && path.isAbsolute(value) && samePath(this.resolveProject(value), cwd); } catch { return false; }
    });
    if (!allowed) throw new Error('项目目录不在本机已授权列表中，请先在本机添加');
    if (!fs.statSync(cwd).isDirectory()) throw new Error('授权项目必须是文件夹');
    return cwd;
  }
  validatePrompt(prompt) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 50000) throw new Error('Codex 任务文字须为 1 至 50000 字');
    return prompt.trim();
  }
  onceRequest(requestId, input, action) {
    if (this.persistenceFault) throw new Error(this.persistenceFault);
    const key = String(requestId || randomUUID()); const fingerprint = digest(input);
    if (key.length > 500) throw new Error('请求 ID 超过 500 字，已拒绝执行');
    const existing = this.requests.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('重复请求 ID 对应了不同内容，已拒绝执行');
      if (existing.recovered || !existing.promise) throw new Error('该请求 ID 已持久登记，重启后不自动重放；请先核对结果，再用新请求明确继续');
      return existing.promise;
    }
    if (this.requests.size >= 20000) throw new Error('Codex 持久请求账本已达 20000 条，请在本机维护归档后继续');
    const entry = { fingerprint, state: 'reserved', createdAt: new Date(this.now()).toISOString() };
    this.requests.set(key, entry);
    this.persist();
    const promise = Promise.resolve().then(action).then(result => {
      entry.state = 'accepted'; entry.threadId = result.threadId; entry.turnId = result.turnId;
      entry.updatedAt = new Date(this.now()).toISOString(); this.persist(); return result;
    }, error => {
      entry.state = 'failed'; entry.updatedAt = new Date(this.now()).toISOString();
      if (!this.persistenceFault) this.persist(); throw error;
    });
    entry.promise = promise;
    return promise;
  }
  async status() {
    if (this.persistenceFault) return { status: 'unavailable', available: false, protocolReady: this.protocolReady,
      version: this.version, authenticated: this.authenticated, managedThreads: this.managed.size, lastError: this.persistenceFault };
    try {
      await this.ensureReady();
      // Read-only login state; this creates no thread and starts no AI turn.
      try { const result = await this.request('account/read', { refreshToken: false }); this.authenticated = Boolean(result?.account); }
      catch { this.authenticated = null; }
      return { status: 'available', available: true, protocolReady: true, version: this.version,
        authenticated: this.authenticated, managedThreads: this.managed.size, lastError: '',
        sandbox: 'workspace-write', approvalPolicy: 'on-request', hooksEnabled: false };
    } catch (error) {
      this.lastError = error.message;
      return { status: 'unavailable', available: false, protocolReady: false, version: this.version,
        authenticated: this.authenticated, managedThreads: this.managed.size, lastError: this.lastError };
    }
  }
  listThreads() {
    return [...this.managed.values()].map(thread => ({ id: thread.id, threadId: thread.id,
      cwd: thread.cwd, title: thread.title, status: thread.status, turnId: thread.activeTurnId,
      createdAt: thread.createdAt, updatedAt: thread.updatedAt, hasResult: Boolean(thread.result),
      lastCompletedTurnId: thread.lastCompletedTurnId || null, needsReview: thread.status === 'needs_review' }));
  }
  getLastThreadId() { return this.lastThreadId; }
  getResult(threadId) { const thread = this.managed.get(threadId); return thread?.result ? copy(thread.result) : null; }
  run({ prompt, text, cwd, projectPath, requestId } = {}) {
    const task = this.validatePrompt(prompt ?? text); const project = this.project(cwd || projectPath);
    return this.onceRequest(requestId, { type: 'run', task, project }, async () => {
      await this.ensureReady(); this.project(project);
      const result = await this.request('thread/start', { cwd: project, sandbox: 'workspace-write',
        approvalPolicy: 'on-request', approvalsReviewer: 'user', serviceName: 'personal-workboard',
        config: { 'features.hooks': false, 'sandbox_workspace_write.network_access': false } });
      const threadId = result?.thread?.id;
      if (typeof threadId !== 'string' || !threadId) throw new Error('Codex 未返回新建会话 ID');
      if (this.managed.has(threadId)) throw new Error('Codex 新建会话 ID 已存在，已拒绝接管');
      const thread = { id: threadId, cwd: project, title: task.slice(0, 60), status: 'starting',
        starting: true, activeTurnId: null, lastOutput: '', createdAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString() };
      this.managed.set(threadId, thread); this.lastThreadId = threadId; this.saveThread(thread);
      // thread/start has now been durably registered. No turn is submitted before this save.
      try {
        this.verifyReturnedProject(result, thread);
        return await this.startTurn(thread, task, requestId);
      } catch (error) {
        thread.starting = false; thread.status = 'needs_review';
        if (!this.persistenceFault) this.saveThread(thread); throw error;
      }
    });
  }
  resume({ threadId, prompt, text, requestId } = {}) {
    const task = this.validatePrompt(prompt ?? text); this.remoteSettings();
    const thread = this.managed.get(threadId);
    if (!thread) throw new Error('只能继续本看板创建并管理的 Codex 会话');
    this.project(thread.cwd);
    return this.onceRequest(requestId, { type: 'resume', threadId, task }, async () => {
      if (thread.activeTurnId || thread.starting || thread.resuming) throw new Error('此 Codex 会话仍在执行，请先停止或等待完成');
      thread.resuming = true; thread.status = 'resuming'; this.saveThread(thread);
      try {
        await this.ensureReady(); this.project(thread.cwd);
        const result = await this.request('thread/resume', { threadId, cwd: thread.cwd, sandbox: 'workspace-write',
          approvalPolicy: 'on-request', approvalsReviewer: 'user', excludeTurns: true,
          config: { 'features.hooks': false, 'sandbox_workspace_write.network_access': false } });
        this.verifyReturnedProject(result, thread);
        const serverStatus = result.thread?.status;
        if (serverStatus?.type === 'active' || serverStatus === 'active' || serverStatus === 'inProgress') {
          throw new Error('Codex 服务端会话仍在运行，请先在本机核对，未提交新任务');
        }
        thread.resuming = false; this.lastThreadId = threadId; this.saveThread(thread);
        return await this.startTurn(thread, task, requestId);
      } catch (error) { thread.starting = false; thread.resuming = false; thread.status = 'needs_review';
        if (!this.persistenceFault) this.saveThread(thread); throw error; }
    });
  }
  async startTurn(thread, text, requestId) {
    const completedBeforeStart = thread.lastCompletedTurnId;
    this.project(thread.cwd); thread.lastOutput = ''; thread.messages = []; thread.artifacts = []; thread.starting = true;
    thread.status = 'starting'; this.saveThread(thread);
    const early = { messages: [], characters: 0 }; this.startingEvents.set(thread.id, early);
    try {
      const result = await this.request('turn/start', { threadId: thread.id, cwd: thread.cwd,
        approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [thread.cwd], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true },
        input: [{ type: 'text', text, text_elements: [] }],
        ...(requestId ? { clientUserMessageId: String(requestId) } : {}) });
      if (typeof result?.turn?.id !== 'string' || !result.turn.id) throw new Error('Codex 未返回实际任务轮次 ID');
      if (result.turn.id === completedBeforeStart || retiredTurn(thread, result.turn.id) && thread.lastCompletedTurnId !== result.turn.id) {
        throw new Error('Codex 返回了旧执行轮次 ID，已停止继续');
      }
      if (thread.lastCompletedTurnId !== result.turn.id) {
        thread.activeTurnId = result.turn.id; thread.status = result.turn.status || 'running';
      }
      thread.starting = false;
      this.startingEvents.delete(thread.id);
      this.saveThread(thread);
      for (const event of early.messages) this.receive(event);
      this.saveThread(thread);
      return { accepted: true, threadId: thread.id, turnId: result.turn.id, status: thread.status,
        completionVia: 'onOutput' };
    } catch (error) {
      this.startingEvents.delete(thread.id);
      for (const event of early.messages) {
        retire(thread, event.params?.turnId || event.params?.turn?.id);
        if (event.id != null) {
          try { this.write({ id: event.id, error: { code: -32601, message: 'The turn was not confirmed. No approval was granted.' } }); } catch {}
        }
      }
      retire(thread, thread.activeTurnId);
      thread.uncertainTurnId = thread.activeTurnId || thread.uncertainTurnId || null;
      thread.starting = false; thread.activeTurnId = null; thread.status = 'needs_review';
      this.clearApprovals(thread.id);
      if (!this.persistenceFault) this.saveThread(thread); throw error;
    }
  }
  async interrupt({ threadId, turnId, requestId } = {}) {
    const thread = this.managed.get(threadId);
    if (!thread) throw new Error('只能停止本看板管理的 Codex 会话');
    const activeTurnId = thread.activeTurnId;
    if (!activeTurnId) throw new Error('该会话当前没有可停止的执行轮次');
    if (turnId && turnId !== activeTurnId) throw new Error('停止指令的轮次 ID 已过期');
    return this.onceRequest(requestId, { type: 'interrupt', threadId, turnId: activeTurnId }, async () => {
      if (!this.protocolReady) throw new Error('Codex 连接已断开，无法确认停止结果');
      await this.request('turn/interrupt', { threadId, turnId: activeTurnId });
      this.clearApprovals(threadId, activeTurnId);
      thread.status = 'interrupt_requested'; this.saveThread(thread);
      return { requested: true, threadId, turnId: activeTurnId, status: 'interrupt_requested' };
    });
  }
  resolveApproval(entry, accepted) {
    this.approvals.delete(entry.code); clearTimeout(entry.timer);
    const result = entry.method === 'item/permissions/requestApproval'
      ? { permissions: accepted ? entry.params.permissions : {}, scope: 'turn' }
      : { decision: accepted ? 'accept' : 'decline' };
    const thread = this.managed.get(entry.threadId);
    if (thread && accepted) { thread.status = 'running'; this.saveThread(thread); }
    this.write({ id: entry.rpcId, result });
    if (thread && !accepted && !this.persistenceFault) { thread.status = 'running'; this.saveThread(thread); }
  }
  async approve({ code, decision, threadId, turnId } = {}) {
    const normalized = String(code || '').trim().toUpperCase(); const entry = this.approvals.get(normalized);
    if (!entry) throw new Error('审批码无效、已使用或已过期');
    if (!['accept', 'decline', 'approve', 'deny'].includes(decision)) throw new Error('审批只能明确选择同意本次或拒绝本次');
    const accepted = decision === 'accept' || decision === 'approve';
    if (threadId && threadId !== entry.threadId || turnId && turnId !== entry.turnId) throw new Error('审批码与会话或轮次不匹配');
    if (this.now() >= entry.expiresAt) { this.resolveApproval(entry, false); throw new Error('审批码已过期，本次请求已拒绝'); }
    const thread = this.managed.get(entry.threadId);
    if (!thread || !thread.activeTurnId || thread.activeTurnId !== entry.turnId) throw new Error('审批对应的任务已结束');
    // A disabled remote switch can always refuse or stop; it can never grant new execution.
    if (accepted) this.project(thread.cwd);
    this.resolveApproval(entry, accepted);
    return { resolved: true, code: normalized, threadId: entry.threadId, turnId: entry.turnId,
      decision: accepted ? 'accept' : 'decline', scope: 'single_request' };
  }
  async stop() {
    this.stopping = true; ++this.lifecycle;
    for (const entry of [...this.approvals.values()]) {
      try { this.resolveApproval(entry, false); } catch {}
    }
    const child = this.child;
    this.failConnection('');
    if (!child) return { stopped: true };
    this.reader?.close();
    try { child.stdin.end(); } catch {}
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.exitCode != null) { clearTimeout(timer); resolve(); }
    });
    if (this.child === child) this.child = null;
    return { stopped: true };
  }
}
function CodexController(options) { return new Controller(options); }
module.exports = { CodexController, findCodexExecutable };
