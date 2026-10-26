'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { protect } = require('./vault.cjs');
const { publicKeyInfo, signManifest } = require('./update-protocol.cjs');

const OWNER = 'liruiqi250-hub';
const REPO = 'personal-workboard';
const PURPOSE = 'personal-workboard-update-signing';
const KEY_FILE = 'publisher-key.dpapi.json';
const MAX_ENVELOPE_BYTES = 32 * 1024;
const BINDING = Object.freeze({ schema: 1, purpose: PURPOSE, owner: OWNER, repo: REPO, algorithm: 'Ed25519' });
const projectDefault = path.resolve(__dirname, '..');

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function localAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw Error(label + '必须是绝对路径');
  // Do not accept alternate Win32/NT path namespaces, UNC shares, rooted paths
  // without a drive, or alternate data streams. They must never reach fs first.
  if (process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(value) || value.slice(2).includes(':'))) throw Error(label + '只支持本机盘符绝对路径，不支持 UNC、设备或 NT 路径');
  const resolved = path.resolve(value);
  if (process.platform === 'win32' && resolved.slice(3).split(path.sep).some(part => /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw Error(label + '不能包含 Windows 保留设备名称或尾部点号、空格别名');
  return resolved;
}

function actualLocalPath(value, label) {
  let actual;
  try { actual = fs.realpathSync.native(value); } catch { throw Error(label + '无法核验真实路径'); }
  // Node may return the ordinary local extended prefix for a long canonical
  // result. This is trusted fs output, never an accepted user-input namespace.
  if (process.platform === 'win32') actual = actual.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '');
  return localAbsolute(actual, label);
}

// Inspect every existing component and canonicalize the last existing ancestor.
// Missing suffixes are appended to that actual ancestor, so 8.3/other aliases
// cannot turn an in-project target into a textually unrelated "outside" path.
function checkedAbsolute(value, label = '路径') {
  const resolved = localAbsolute(value, label);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  let actual = actualLocalPath(current, label);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') return path.join(actual, ...parts.slice(index));
      throw Error(label + '无法安全检查');
    }
    if (stat.isSymbolicLink()) throw Error(label + '不能包含符号链接或目录联接');
    if (current !== resolved && !stat.isDirectory()) throw Error(label + '的上级必须是目录');
    actual = actualLocalPath(current, label);
  }
  return actual;
}

function checkedKeyDir(value, projectRoot = projectDefault) {
  const project = checkedAbsolute(projectRoot, '项目目录');
  const dir = checkedAbsolute(value, '密钥目录');
  if (isWithin(project, dir)) throw Error('发布者密钥目录必须位于项目目录之外');
  if (dir === path.parse(dir).root) throw Error('发布者密钥目录不能是磁盘根目录');
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw Error('发布者密钥目录不可用');
  return dir;
}

function defaultKeyDir(env = process.env) {
  if (!env.LOCALAPPDATA || !path.isAbsolute(env.LOCALAPPDATA)) throw Error('无法确定本机 LocalAppData，请显式指定项目外的绝对密钥目录');
  return path.join(env.LOCALAPPDATA, 'PersonalWorkboardPublisher', OWNER, REPO);
}

function assertBinding(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.entries(BINDING).some(([key, expected]) => value[key] !== expected)) {
    throw Error('发布者密钥的仓库或用途绑定不匹配');
  }
}

function publicMetadata(envelope) {
  return { ...BINDING, protection: 'windows-dpapi-current-user', publicKey: envelope.publicKey, keyId: envelope.keyId, fingerprint: envelope.fingerprint, createdAt: envelope.createdAt };
}

function readEnvelope(file) {
  checkedAbsolute(file, '密钥封套');
  const descriptor = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    const current = fs.lstatSync(file);
    if (!stat.isFile() || current.isSymbolicLink() || stat.ino !== current.ino || stat.dev !== current.dev || stat.size < 1 || stat.size > MAX_ENVELOPE_BYTES) throw Error('invalid');
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length !== stat.size || bytes.length > MAX_ENVELOPE_BYTES) throw Error('invalid');
    checkedAbsolute(file, '密钥封套');
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw Error('发布者密钥封套损坏或不安全，未覆盖原文件');
  } finally { fs.closeSync(descriptor); }
}

function createPublisherKeys({ keyDir, projectRoot = projectDefault, protectImpl = protect, now = () => new Date().toISOString() } = {}) {
  const dir = checkedKeyDir(keyDir || defaultKeyDir(), projectRoot);
  const file = path.join(dir, KEY_FILE);

  async function openKey() {
    checkedKeyDir(dir, projectRoot);
    let envelope;
    try { envelope = readEnvelope(file); } catch (error) {
      if (error.code === 'ENOENT') throw Error('本项目发布者密钥不存在，请维护者显式运行 init');
      throw Error('发布者密钥封套无法安全读取，未创建或覆盖密钥');
    }
    assertBinding(envelope);
    const envelopeFields = [...Object.keys(BINDING), 'publicKey', 'keyId', 'fingerprint', 'createdAt', 'protection', 'protectedPrivateKey'];
    if (Object.keys(envelope).sort().join(',') !== envelopeFields.sort().join(',') || envelope.protection !== 'windows-dpapi-current-user' || typeof envelope.protectedPrivateKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.protectedPrivateKey) || typeof envelope.createdAt !== 'string' || !Number.isFinite(Date.parse(envelope.createdAt))) throw Error('发布者密钥封套格式不受支持');
    let clear;
    let payload;
    let privateKey;
    let derived;
    try {
      clear = await protectImpl(envelope.protectedPrivateKey, true);
      payload = JSON.parse(clear);
      assertBinding(payload);
      if (typeof payload.privateKey !== 'string' || Object.keys(payload).sort().join(',') !== [...Object.keys(BINDING), 'privateKey', 'publicKey', 'keyId', 'fingerprint', 'createdAt'].sort().join(',')) throw Error('invalid');
      privateKey = crypto.createPrivateKey(payload.privateKey);
      if (privateKey.asymmetricKeyType !== 'ed25519') throw Error('invalid');
      derived = publicKeyInfo(crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }));
      if (['publicKey', 'keyId', 'fingerprint'].some(key => payload[key] !== derived[key] || envelope[key] !== derived[key]) || payload.createdAt !== envelope.createdAt) throw Error('invalid');
    } catch {
      throw Error('无法以当前 Windows 用户核验本项目发布者密钥，未输出私钥');
    } finally {
      if (payload) payload.privateKey = '';
      clear = undefined;
    }
    return { envelope, privateKey };
  }

  async function init() {
    checkedKeyDir(dir, projectRoot);
    if (fs.existsSync(file)) return publicMetadata((await openKey()).envelope);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    checkedKeyDir(dir, projectRoot);
    const generated = crypto.generateKeyPairSync('ed25519');
    const info = publicKeyInfo(generated.publicKey.export({ type: 'spki', format: 'pem' }));
    const createdAt = now();
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw Error('密钥创建时间无效');
    const sealed = { ...BINDING, ...info, createdAt, privateKey: generated.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    let protectedPrivateKey;
    try { protectedPrivateKey = await protectImpl(JSON.stringify(sealed)); } catch { throw Error('Windows 当前用户 DPAPI 保护失败，未写入发布者密钥'); } finally { sealed.privateKey = ''; }
    if (typeof protectedPrivateKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(protectedPrivateKey)) throw Error('Windows 当前用户 DPAPI 没有返回有效封套，未写入发布者密钥');
    const envelope = { ...BINDING, ...info, createdAt, protection: 'windows-dpapi-current-user', protectedPrivateKey };
    const bytes = JSON.stringify(envelope, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > MAX_ENVELOPE_BYTES) throw Error('密钥封套超过允许大小，未写入发布者密钥');
    checkedAbsolute(file, '密钥封套');
    try { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) {
      if (error.code === 'EEXIST') return publicMetadata((await openKey()).envelope);
      throw Error('无法排他保存发布者密钥，未覆盖已有文件');
    }
    return publicMetadata((await openKey()).envelope);
  }

  async function getPublic() { return publicMetadata((await openKey()).envelope); }

  async function sign(payload) {
    const { envelope, privateKey } = await openKey();
    if (payload.owner !== OWNER || payload.repo !== REPO || payload.keyId !== envelope.keyId) throw Error('签名清单与本项目发布密钥绑定不匹配');
    try { return signManifest(payload, privateKey); } catch { throw Error('更新清单格式或签名失败，未输出私钥'); }
  }

  return { init, getPublic, sign };
}

module.exports = { OWNER, REPO, PURPOSE, KEY_FILE, defaultKeyDir, checkedAbsolute, checkedKeyDir, createPublisherKeys };
