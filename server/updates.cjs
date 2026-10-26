'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveUpdateSettings } = require('./update-trust.cjs');
const { verifyManifest, serializePayload } = require('./update-protocol.cjs');
const MAX_ARCHIVE_BYTES = 400 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_RELEASE_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function isNewer(a, b) {
  const parse = v => { const m = String(v).match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/); return m ? m.slice(1, 4).map(Number) : null; };
  const aa = parse(a), bb = parse(b);
  if (!aa || !bb) return false;
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i];
  return false;
}
function assertHttps(url, hosts) {
  let parsed;
  try { parsed = new URL(url); } catch { throw Error('更新资产 URL 无效'); }
  if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname) || parsed.username || parsed.password || parsed.port || parsed.hash) throw Error('更新下载仅允许受控 GitHub HTTPS 主机');
  return parsed;
}
function assetUrl(settings, tag, name) { return `https://github.com/${settings.owner}/${settings.repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`; }
function selectAsset(release, settings, name) {
  if (!Array.isArray(release.assets)) return null;
  const matches = release.assets.filter(asset => asset && asset.name === name);
  if (!matches.length) return null;
  if (matches.length !== 1) throw Error('GitHub 发布资产名称重复');
  const asset = matches[0];
  if (asset.browser_download_url !== assetUrl(settings, release.tag_name, name)) throw Error('更新资产不属于所选仓库、tag 或文件名');
  assertHttps(asset.browser_download_url, DOWNLOAD_HOSTS);
  if (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || asset.size < 0)) throw Error('GitHub 发布资产大小无效');
  return { name, url: asset.browser_download_url, size: asset.size };
}
async function boundedFetch(fetchImpl, initialUrl, { limit, timeout, api = false, allow404 = false }) {
  const signal = AbortSignal.timeout(timeout);
  let current = String(initialUrl);
  for (let redirects = 0; redirects <= 5; redirects++) {
    assertHttps(current, api ? new Set(['api.github.com']) : DOWNLOAD_HOSTS);
    const response = await fetchImpl(current, { redirect: 'manual', signal, headers: { Accept: api ? 'application/vnd.github+json' : 'application/octet-stream', 'Accept-Encoding': 'identity', 'User-Agent': 'PersonalWorkboard' } });
    if (response.redirected || (response.url && response.url !== current)) throw Error('更新下载发生未受控重定向');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 5) throw Error('更新下载重定向次数超限');
      const location = response.headers.get('location');
      if (!location) throw Error('更新下载重定向缺少目标');
      current = new URL(location, current).href;
      continue;
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw Error(api ? '暂时无法读取 GitHub 发布版本，请稍后重试' : '更新清单或更新包下载失败');
    const declared = response.headers.get('content-length');
    const encoded = ![null, '', 'identity'].includes(response.headers.get('content-encoding'));
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw Error('更新下载超出大小限制');
    let size = 0; const parts = [];
    if (!response.body) throw Error('更新下载内容为空');
    for await (const part of response.body) {
      if (signal.aborted) throw Error('更新下载超时');
      const bytes = Buffer.from(part); size += bytes.length;
      if (size > limit) throw Error('更新下载超出大小限制');
      parts.push(bytes);
    }
    // Native fetch decompresses encoded responses while retaining their wire Content-Length.
    if (declared !== null && !encoded && size !== Number(declared)) throw Error('更新下载实际字节数与响应大小不一致');
    return Buffer.concat(parts);
  }
  throw Error('更新下载重定向次数超限');
}
function assertNoLinks(target) {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('更新目录或文件不能是路径链接');
  }
}

function createUpdates({ version, dataDir, getSettings, backup, fetchImpl = fetch, persistence, allowPreviewInstall = false, trust }) {
  const memory = { schema: 1, ledgers: {}, verified: null };
  const storage = persistence || { load: () => memory, save: value => Object.assign(memory, clone(value)) };
  let book = storage.load() || { schema: 1, ledgers: {}, verified: null };
  if (book.schema !== 1 || !book.ledgers || typeof book.ledgers !== 'object' || Array.isArray(book.ledgers)) throw Error('更新持久账本格式无效，请保留文件并由维护人员核对');
  book = clone(book);
  let busy = false, selection = null;
  let state = { status: 'unconfigured', currentVersion: version, verified: false, canDownload: false, canInstall: false };
  const settings = () => resolveUpdateSettings(getSettings(), trust);
  function requireConfigured(value = settings()) {
    if (value.configurationError) {
      selection = null;
      state = { ...base(value), status: 'unconfigured', verified: false, canDownload: false, canInstall: false, installReady: false, configurationError: value.configurationError, message: value.configurationError };
      throw Error(value.configurationError);
    }
    return value;
  }
  const snapshot = value => JSON.stringify(value);
  const ledgerKey = value => digest(JSON.stringify([value.owner, value.repo, value.channel, value.keyId]));
  function save(next) { const result = storage.save(clone(next)); if (result && typeof result.then === 'function') throw Error('更新持久账本必须同步提交'); book = clone(next); }
  function reload() {
    const saved = storage.load();
    if (saved && (saved.schema !== 1 || !saved.ledgers || typeof saved.ledgers !== 'object' || Array.isArray(saved.ledgers))) throw Error('更新持久账本格式无效');
    if (saved) book = clone(saved);
  }
  function base(value) { return { currentVersion: version, sourceMode: value.sourceMode, owner: value.owner, repo: value.repo, channel: value.channel, previewTag: value.previewTag, keyId: value.keyId, fingerprint: value.fingerprint, allowPreviewInstall: !!allowPreviewInstall }; }
  function assertSettings(expected) {
    if (snapshot(settings()) !== expected) { selection = null; state = { ...state, status: 'invalidated', verified: false, canDownload: false, canInstall: false, installReady: false, message: '更新来源、通道或公钥已改变，请重新检查更新' }; throw Error(state.message); }
  }
  function recordPath(record) {
    if (!/^[0-9a-f-]{36}$/.test(record.ticketId)) throw Error('更新安装票据无效');
    const file = path.join(path.resolve(dataDir, 'updates'), `workboard-${record.ticketId}.zip`);
    if (record.file !== file) throw Error('已核验更新文件路径与票据不一致');
    return file;
  }
  function verifyFile(record) {
    const file = recordPath(record); assertNoLinks(file);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size !== record.bytes || digest(fs.readFileSync(file)) !== record.sha256) throw Error('更新文件校验未通过，不能准备安装');
    return file;
  }
  function validateRecord(record, value) {
    if (record.snapshot !== snapshot(value)) throw Error('已核验更新的设置已失效');
    if (!['downloaded', 'preparing', 'consumed', 'failed'].includes(record.phase)) throw Error('更新安装票据状态无效');
    const ledger = book.ledgers[ledgerKey(value)];
    const payload = verifyManifest(record.manifest, value.publicKey, { owner: value.owner, repo: value.repo, channel: value.channel, keyId: value.keyId });
    if (value.channel === 'preview' && payload.tag !== value.previewTag) throw Error('已核验预览文件与当前 tag 不一致');
    if (!ledger || ledger.sequence !== payload.sequence || ledger.manifestDigest !== record.manifestDigest || ledger.ticketId !== record.ticketId || digest(serializePayload(payload)) !== record.manifestDigest || record.sha256 !== payload.sha256 || record.bytes !== payload.bytes) throw Error('已核验更新与持久账本不匹配');
    recordPath(record);
    return payload;
  }
  function verifiedState(record, value) {
    const canInstall = isNewer(record.manifest.version, version) && (value.channel !== 'preview' || allowPreviewInstall);
    return { ...record.display, ...base(value), version: record.manifest.version, tag: record.manifest.tag, status: 'downloaded', verified: true, canDownload: true, canInstall, file: record.file, sha256: record.sha256, bytes: record.bytes, ticketId: record.ticketId, sequence: record.manifest.sequence, message: canInstall ? '签名、来源和更新文件已核验，可备份并准备安装' : !isNewer(record.manifest.version, version) ? '当前或更旧版本仅供验证下载，不允许安装或降级' : '普通主服务仅可验证预览下载；安装需要明确隔离的预览测试实例' };
  }
  function restoreRecord(value) {
    const record = book.verified;
    if (!record || record.snapshot !== snapshot(value)) return false;
    validateRecord(record, value);
    if (record.phase !== 'downloaded') {
      state = { ...record.display, ...base(value), status: record.phase === 'preparing' ? 'install_interrupted' : `install_${record.phase}`, verified: false, canDownload: false, canInstall: false, installReady: false, message: '此更新票据已占用或消费；请先人工核对上次安装结果，不能自动重复安装' };
      return true;
    }
    verifyFile(record); state = verifiedState(record, value); return true;
  }
  try { const value = settings(); if (value.configurationError) state = { ...base(value), ...state, status: 'unconfigured', configurationError: value.configurationError, message: value.configurationError }; else restoreRecord(value); } catch (error) { state = { ...state, status: 'invalidated', message: error.message }; }
  async function exclusive(action) {
    if (busy) throw Error('更新操作正在执行，请等待完成');
    busy = true; try { return await action(); } catch (error) { if (state.status === 'downloaded') state = { ...state, status: 'invalidated', verified: false, canInstall: false, canDownload: false, message: error.message }; throw error; } finally { busy = false; }
  }
  async function check() { return exclusive(async () => {
    selection = null;
    const value = requireConfigured(), expectedSnapshot = snapshot(value);
    state = { ...base(value), status: 'checking', verified: false, canDownload: false, canInstall: false };
    if (value.channel === 'preview' && !value.previewTag) { state = { ...state, status: 'unconfigured', message: '预览通道需要明确指定 previewTag' }; return clone(state); }
    const endpoint = value.channel === 'preview' ? `tags/${encodeURIComponent(value.previewTag)}` : 'latest';
    const raw = await boundedFetch(fetchImpl, `https://api.github.com/repos/${value.owner}/${value.repo}/releases/${endpoint}`, { limit: MAX_RELEASE_BYTES, timeout: 20000, api: true, allow404: true });
    assertSettings(expectedSnapshot);
    if (!raw) { state = { ...state, status: 'unconfigured', url: `https://github.com/${value.owner}/${value.repo}/releases`, message: `仓库已配置，未取得可用的${value.channel === 'preview' ? '指定预览' : '正式'} Release` }; return clone(state); }
    const release = JSON.parse(raw.toString('utf8'));
    if (release.draft !== false || typeof release.prerelease !== 'boolean' || (value.channel === 'stable' ? release.prerelease : !release.prerelease)) throw Error(value.channel === 'stable' ? '检测结果不是正式发布版本' : '指定版本不是预览发布版本');
    if (typeof release.tag_name !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name)) throw Error('发布版本 tag 无效');
    if (value.channel === 'preview' && release.tag_name !== value.previewTag) throw Error('预览 Release 与指定 tag 不一致');
    const target = release.tag_name.slice(1), releaseUrl = `https://github.com/${value.owner}/${value.repo}/releases/tag/${encodeURIComponent(release.tag_name)}`;
    if (release.html_url !== releaseUrl) throw Error('Release 不属于所选仓库与 tag');
    const manifest = selectAsset(release, value, 'update-manifest.json');
    if (manifest?.size > MAX_MANIFEST_BYTES) throw Error('更新清单超出大小限制');
    const newer = isNewer(target, version);
    state = { ...base(value), status: newer ? 'available' : value.channel === 'preview' ? 'verification_available' : 'current', version: target, tag: release.tag_name, notes: typeof release.body === 'string' ? release.body : '', publishedAt: release.published_at, url: releaseUrl, manifestUrl: manifest?.url || null, verified: false, canDownload: !!manifest && !!value.publicKey && (newer || value.channel === 'preview'), canInstall: false };
    if (!value.publicKey) state.message = '当前来源尚未配置可信签名公钥，不能下载或安装';
    else if (!manifest) state.message = '此 Release 尚无签名更新清单，不能自动更新';
    selection = { value, snapshot: expectedSnapshot, release: clone(release), manifest, display: clone(state) };
    return clone(state);
  }); }
  async function download() { return exclusive(async () => {
    requireConfigured();
    reload();
    if (state.status === 'downloaded') { assertSettings(book.verified.snapshot); validateRecord(book.verified, settings()); verifyFile(book.verified); return clone(state); }
    if (!selection || !['available', 'verification_available', 'install_failed'].includes(state.status)) throw Error('目前没有可用的新版本或预览验证下载，请重新检查更新');
    const selected = selection; assertSettings(selected.snapshot);
    const value = selected.value;
    if (!selected.manifest || !value.publicKey) throw Error('此版本尚未配置签名更新包，不能自动安装');
    const raw = await boundedFetch(fetchImpl, selected.manifest.url, { limit: MAX_MANIFEST_BYTES, timeout: 30000 });
    assertSettings(selected.snapshot);
    if (selected.manifest.size !== undefined && selected.manifest.size !== raw.length) throw Error('清单大小与实际 GitHub 资产不一致');
    const manifest = JSON.parse(raw.toString('utf8'));
    const payload = verifyManifest(manifest, value.publicKey, { owner: value.owner, repo: value.repo, channel: value.channel, version: state.version, tag: selected.release.tag_name, keyId: value.keyId });
    if (payload.bytes > MAX_ARCHIVE_BYTES) throw Error('更新包超出 400 MB 限制');
    const archive = selectAsset(selected.release, value, payload.assetName);
    if (!archive || archive.url !== payload.url) throw Error('更新清单 URL 必须精确匹配实际 Release ZIP 资产');
    if (archive.size !== undefined && archive.size !== payload.bytes) throw Error('更新包大小与实际 GitHub 资产不一致');
    const manifestDigest = digest(serializePayload(payload)), key = ledgerKey(value), prior = book.ledgers[key];
    if (prior && payload.sequence <= prior.sequence) {
      if (payload.sequence === prior.sequence && manifestDigest === prior.manifestDigest && book.verified?.phase === 'downloaded' && book.verified.snapshot === selected.snapshot && book.verified.ticketId === prior.ticketId) { validateRecord(book.verified, value); verifyFile(book.verified); state = verifiedState(book.verified, value); return clone(state); }
      if (payload.sequence === prior.sequence && manifestDigest === prior.manifestDigest && book.verified?.phase === 'failed' && book.verified.failureStage === 'backup' && book.verified.snapshot === selected.snapshot && book.verified.ticketId === prior.ticketId) {
        const failed = book.verified; validateRecord(failed, value); verifyFile(failed);
        const ticketId = crypto.randomUUID(), file = path.join(path.resolve(dataDir, 'updates'), `workboard-${ticketId}.zip`);
        fs.copyFileSync(failed.file, file, fs.constants.COPYFILE_EXCL);
        const record = { ...failed, phase: 'downloaded', ticketId, file };
        delete record.failureStage; delete record.failedAt; delete record.claimedAt;
        verifyFile(record);
        save({ ...book, attempts: [...(book.attempts || []), failed], ledgers: { ...book.ledgers, [key]: { sequence: payload.sequence, manifestDigest, ticketId } }, verified: record });
        state = verifiedState(record, value); return clone(state);
      }
      throw Error('更新清单 sequence 已使用或回退，不能重放安装票据');
    }
    const bytes = await boundedFetch(fetchImpl, archive.url, { limit: MAX_ARCHIVE_BYTES, timeout: 300000 });
    assertSettings(selected.snapshot);
    if (bytes.length !== payload.bytes || digest(bytes) !== payload.sha256) throw Error('更新文件校验未通过：SHA256 或字节数不一致');
    reload();
    const latest = book.ledgers[key];
    if (latest && payload.sequence <= latest.sequence) throw Error('下载期间更新清单 sequence 已被登记，请重新检查以恢复原票据');
    const dir = path.resolve(dataDir, 'updates'); assertNoLinks(dir); fs.mkdirSync(dir, { recursive: true });
    const ticketId = crypto.randomUUID(), file = path.join(dir, `workboard-${ticketId}.zip`); fs.writeFileSync(file, bytes, { flag: 'wx' });
    const record = { phase: 'downloaded', ticketId, file, sha256: payload.sha256, bytes: payload.bytes, manifest: clone(manifest), manifestDigest, snapshot: selected.snapshot, display: selected.display };
    save({ ...book, ledgers: { ...book.ledgers, [key]: { sequence: payload.sequence, manifestDigest, ticketId } }, verified: record });
    state = verifiedState(record, value); return clone(state);
  }); }
  async function prepareInstall() { return exclusive(async () => {
    requireConfigured();
    if (!persistence || typeof persistence.load !== 'function' || typeof persistence.save !== 'function') throw Error('安装需要可同步提交的持久更新账本，请由维护人员修复配置');
    reload();
    const record = book.verified;
    if (!record || record.phase !== 'downloaded' || !state.verified || state.status !== 'downloaded') throw Error('请先下载并验证更新包；已占用的安装票据不能重复使用');
    assertSettings(record.snapshot);
    const value = settings(); validateRecord(record, value);
    if (!isNewer(record.manifest.version, version)) throw Error('当前或更旧版本只可验证下载，不允许安装或降级');
    if (value.channel === 'preview' && !allowPreviewInstall) throw Error('普通主服务禁止安装预览版，请使用明确隔离的预览测试实例');
    const claimed = { ...record, phase: 'preparing', claimedAt: new Date().toISOString() };
    save({ ...book, verified: claimed });
    state = { ...state, status: 'preparing', verified: false, canDownload: false, canInstall: false, installReady: false };
    let failureStage = 'file-before-backup';
    try {
      verifyFile(claimed);
      failureStage = 'backup';
      const saved = await backup();
      failureStage = 'after-backup';
      assertSettings(claimed.snapshot); verifyFile(claimed);
      save({ ...book, verified: { ...claimed, phase: 'consumed', consumedAt: new Date().toISOString() } });
      state = { ...verifiedState(claimed, value), status: 'prepared', canDownload: false, canInstall: false, backup: saved, message: '更新包已验证且数据已备份，一次性安装票据已消费，请执行本机替换与重启。', installReady: true };
      return clone(state);
    } catch (error) {
      try { save({ ...book, verified: { ...claimed, phase: 'failed', failureStage, failedAt: new Date().toISOString() } }); } catch { /* Persisted preparing also prevents automatic retry. */ }
      state = { ...state, status: 'install_failed', verified: false, canDownload: false, canInstall: false, installReady: false, message: error.message }; throw error;
    }
  }); }
  function status() {
    try { requireConfigured(); } catch (error) { if (!state.configurationError) state = { ...state, status: 'invalidated', verified: false, canDownload: false, canInstall: false, message: error.message }; }
    if (book.verified && state.verified) try { assertSettings(book.verified.snapshot); } catch { /* Return invalidation status. */ }
    return clone(state);
  }
  return { check, download, prepareInstall, status };
}
module.exports = { createUpdates, isNewer, MAX_ARCHIVE_BYTES };
