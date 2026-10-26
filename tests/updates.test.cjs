'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdates, isNewer, MAX_ARCHIVE_BYTES } = require('../server/updates.cjs');
const { createManifestPayload, signManifest, publicKeyInfo } = require('../server/update-protocol.cjs');
const { normalizeUpdateSettings, resolveUpdateSettings } = require('../server/update-trust.cjs');
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-update-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const info = publicKeyInfo(publicKey);
  const settings = { updates: { sourceMode: 'custom', owner: 'test-owner', repo: 'test-workboard', publicKey: info.publicKey, channel: options.channel || 'stable', previewTag: options.previewTag || '' } };
  const bytes = Buffer.from('isolated fake update archive');
  let payload, manifest, fetchedBytes = bytes, persisted = null, backups = 0, backupError = !!options.backupError, intercept = null, saveError = false;
  const calls = [], saves = [];
  const release = { tag_name: '', prerelease: settings.updates.channel === 'preview', draft: false, body: '中文版本更新记录', assets: [] };
  const sign = value => signManifest(createManifestPayload(value), privateKey);
  const rawSign = value => ({ ...value, signature: crypto.sign(null, Buffer.from(JSON.stringify(value)), privateKey).toString('base64') });
  function setTarget(version, sequence = 1) {
    payload = createManifestPayload({ owner: 'test-owner', repo: 'test-workboard', channel: settings.updates.channel, version, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), keyId: info.keyId, sequence, createdAt: '2026-10-26T00:00:00.000Z' });
    manifest = sign(payload);
    release.tag_name = payload.tag;
    release.html_url = `https://github.com/test-owner/test-workboard/releases/tag/${payload.tag}`;
    release.assets = [{ name: 'update-manifest.json', browser_download_url: `https://github.com/test-owner/test-workboard/releases/download/${payload.tag}/update-manifest.json` }, { name: payload.assetName, browser_download_url: payload.url, size: payload.bytes }];
  }
  setTarget(options.target || '1.3.0');
  const fetchImpl = async (urlValue, request) => {
    const url = String(urlValue); calls.push({ url, request });
    if (intercept) { const response = await intercept(url, request); if (response !== undefined) return response; }
    if (url.startsWith('https://api.github.com/')) return json(release);
    if (url.endsWith('/update-manifest.json')) return json(manifest);
    if (url === payload.url) return new Response(fetchedBytes, { headers: { 'content-length': String(fetchedBytes.length) } });
    throw Error('Unexpected mocked URL: ' + url);
  };
  const persistence = { load: () => copy(persisted), save: value => { if (saveError) throw Error('账本写入失败'); persisted = copy(value); saves.push(copy(value)); } };
  const create = (overrides = {}) => createUpdates({ version: options.current || '1.2.3', dataDir: dir, getSettings: () => settings, backup: async () => { backups++; if (backupError) throw Error('备份失败'); if (options.backup) return options.backup(); return { path: path.join(dir, 'before-update.sqlite'), credentialsIncluded: false }; }, fetchImpl, persistence, allowPreviewInstall: !!options.allowPreviewInstall, ...overrides });
  const updater = create();
  return { dir, updater, create, settings, release, bytes, info, sign, rawSign, calls, saves, setTarget, get payload() { return payload; }, get manifest() { return manifest; }, get backups() { return backups; }, get persisted() { return copy(persisted); }, setPersisted(value) { persisted = copy(value); }, setManifest(value) { manifest = value; }, setBytes(value) { fetchedBytes = value; }, intercept(value) { intercept = value; }, setBackupError(value) { backupError = value; }, setSaveError(value) { saveError = value; } };
}
async function downloaded(f) { await f.updater.check(); return f.updater.download(); }

test('正式版本号逐段比较，不能按字符串判断', () => {
  assert.equal(isNewer('v1.10.0', '1.9.9'), true);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.2.4', '1.2.3'), true);
  assert.equal(isNewer('v1.2.3', '1.2.3'), false);
  assert.equal(isNewer('1.2.2', '1.2.3'), false);
  for (const candidate of ['1.2.4-beta', '1.2', '1.2.4.1', '01.2.4', 'invalid', '../../9.9.9']) assert.equal(isNewer(candidate, '1.2.3'), false, candidate);
  assert.equal(isNewer('1.2.4+build.1', '1.2.3'), true);
});
test('默认来源和旧空公钥迁移，明确自定义公钥与其他仓库保留', t => {
  const f = fixture(t), trust = { owner: 'liruiqi250-hub', repo: 'personal-workboard', ...f.info };
  for (const old of [{}, { owner: trust.owner, repo: trust.repo, publicKey: '' }]) {
    const value = normalizeUpdateSettings(old, trust);
    assert.equal(value.sourceMode, 'project-default'); assert.equal(value.channel, 'stable'); assert.equal(value.keyId, f.info.keyId); assert.equal(value.publicKey, f.info.publicKey);
  }
  const custom = normalizeUpdateSettings({ owner: trust.owner, repo: trust.repo, publicKey: f.info.publicKey }, trust);
  assert.equal(custom.sourceMode, 'custom'); assert.equal(custom.publicKey, f.info.publicKey);
  const other = normalizeUpdateSettings({ owner: 'other', repo: 'other', publicKey: '' }, trust);
  assert.equal(other.sourceMode, 'custom'); assert.equal(other.owner, 'other'); assert.equal(other.publicKey, '');
  assert.equal(resolveUpdateSettings({ sourceMode: 'project-default', publicKey: 'network-key', owner: 'network', repo: 'network' }, trust).keyId, f.info.keyId);
});
test('未就绪的默认公钥保持空值；无效自定义设置不能注入 URL 或错误密钥', () => {
  assert.equal(normalizeUpdateSettings({}, {}).publicKey, '');
  for (const value of [{ owner: 'owner/../../evil', repo: 'repo' }, { owner: 'owner', repo: '..' }, { sourceMode: 'untrusted' }, { channel: 'other' }, { previewTag: '../../evil' }, { owner: 'owner', repo: 'repo', publicKey: 'fake-key' }]) assert.throws(() => normalizeUpdateSettings(value, {}));
});
test('内置公钥标识不符时拒绝；网络不参与默认公钥轮换', t => {
  const f = fixture(t);
  assert.throws(() => normalizeUpdateSettings({}, { publicKey: f.info.publicKey, keyId: '0'.repeat(64) }), /标识不匹配/);
  const before = normalizeUpdateSettings({}, { publicKey: f.info.publicKey });
  const rotated = publicKeyInfo(crypto.generateKeyPairSync('ed25519').publicKey);
  assert.equal(normalizeUpdateSettings({ ...before, publicKey: rotated.publicKey }, { publicKey: f.info.publicKey }).keyId, f.info.keyId);
  assert.equal(normalizeUpdateSettings(before, rotated).keyId, rotated.keyId);
});
test('遗留无效custom设置读取与重启保留原配置，显式保存严格拒绝，所有更新操作无副作用', async t => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' });
  for (const legacy of [{ owner: ' test-owner ', repo: 'test-workboard', publicKey: ' old invalid key\n' }, { sourceMode: 'custom', owner: 'test-owner', repo: '', publicKey: '' }, { owner: 'test-owner', repo: 'test-workboard', publicKey: rsa }]) {
    const value = resolveUpdateSettings(legacy, {});
    assert.equal(value.owner, legacy.owner); assert.equal(value.repo, legacy.repo); assert.equal(value.publicKey, legacy.publicKey); assert.equal(value.sourceMode, 'custom'); assert.equal(value.keyId, ''); assert.equal(value.fingerprint, ''); assert.match(value.configurationError, /配置无效/);
    assert.throws(() => normalizeUpdateSettings(legacy, {}));
    const f = fixture(t); f.settings.updates = { ...legacy };
    const restarted = f.create(); assert.equal(restarted.status().status, 'unconfigured'); assert.match(restarted.status().configurationError, /配置无效/);
    for (const operation of ['check', 'download', 'prepareInstall']) await assert.rejects(restarted[operation](), /配置无效/);
    assert.deepEqual(f.settings.updates, legacy); assert.equal(f.calls.length, 0); assert.equal(f.backups, 0); assert.equal(fs.existsSync(path.join(f.dir, 'updates')), false);
  }
  assert.throws(() => resolveUpdateSettings({ sourceMode: 'project-default' }, { publicKey: 'broken built-in key' }), /密钥格式/);
});
test('仓库没有正式Release时保留待配置，不声称最新版', async t => {
  const f = fixture(t); f.intercept(() => new Response('', { status: 404 }));
  const result = await f.updater.check(); assert.equal(result.status, 'unconfigured'); assert.equal(result.canDownload, false); assert.equal(result.verified, false); assert.match(result.message, /未取得.*Release/);
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/test-owner/test-workboard/releases/latest');
});
test('版本检查保留中文说明但没有验签，当前和更旧正式版不允许下载', async t => {
  const f = fixture(t); const result = await f.updater.check();
  assert.equal(result.status, 'available'); assert.equal(result.notes, '中文版本更新记录'); assert.equal(result.verified, false); assert.equal(result.canInstall, false); assert.equal(result.canDownload, true); assert.equal(result.fingerprint, f.info.fingerprint);
  for (const version of ['1.2.3', '1.1.0']) { f.setTarget(version); const before = f.calls.length; assert.equal((await f.updater.check()).status, 'current'); await assert.rejects(f.updater.download(), /可用.*版本/); assert.equal(f.calls.length, before + 1); }
  assert.equal(f.backups, 0); assert.equal(fs.existsSync(path.join(f.dir, 'updates')), false);
});
test('stable拒绝预发布和草稿；preview必须指定精确tag且必须为预发布', async t => {
  const f = fixture(t); f.release.prerelease = true; await assert.rejects(f.updater.check(), /正式发布/);
  f.release.prerelease = false; f.release.draft = true; await assert.rejects(f.updater.check(), /正式发布/);
  const p = fixture(t, { channel: 'preview' }); assert.equal((await p.updater.check()).status, 'unconfigured'); assert.equal(p.calls.length, 0);
  p.settings.updates.previewTag = 'v1.3.0'; p.release.prerelease = false; await assert.rejects(p.updater.check(), /预览发布/);
  p.release.prerelease = true; p.settings.updates.previewTag = 'v1.2.9'; await assert.rejects(p.updater.check(), /指定 tag/);
});
test('preview同版旧版可验证下载，但即使隔离开关也不能安装或降级', async t => {
  for (const target of ['1.2.3', '1.1.0']) {
    const f = fixture(t, { channel: 'preview', previewTag: 'v' + target, target, allowPreviewInstall: true });
    assert.equal((await f.updater.check()).status, 'verification_available');
    assert.equal(f.calls[0].url, `https://api.github.com/repos/test-owner/test-workboard/releases/tags/v${target}`);
    const result = await f.updater.download(); assert.equal(result.verified, true); assert.equal(result.canInstall, false);
    await assert.rejects(f.updater.prepareInstall(), /不允许安装|不允许.*降级/); assert.equal(f.backups, 0);
  }
});
test('普通主服务只能验证新版preview，明确隔离开关才允许准备安装', async t => {
  const f = fixture(t, { channel: 'preview', previewTag: 'v1.3.0' });
  assert.equal((await downloaded(f)).canInstall, false); await assert.rejects(f.updater.prepareInstall(), /普通主服务/); assert.equal(f.backups, 0);
  const isolated = fixture(t, { channel: 'preview', previewTag: 'v1.3.0', allowPreviewInstall: true });
  assert.equal((await downloaded(isolated)).canInstall, true); assert.equal((await isolated.updater.prepareInstall()).installReady, true);
});
test('签名错误不下载ZIP、不落盘、不备份', async t => {
  const f = fixture(t); await f.updater.check(); f.setManifest({ ...f.manifest, signature: Buffer.alloc(64).toString('base64') });
  await assert.rejects(f.updater.download(), /签名验证未通过/); assert.equal(f.calls.length, 2); assert.equal(fs.existsSync(path.join(f.dir, 'updates')), false); assert.equal(f.backups, 0);
  await assert.rejects(f.updater.prepareInstall(), /先下载并验证/);
});
test('清单所有绑定字段必须与协议、来源及实际Release一致', async t => {
  const cases = [ ['version', '9.9.9'], ['owner', 'other-owner'], ['repo', 'other-repo'], ['channel', 'preview'], ['tag', 'v9.9.9'], ['keyId', '0'.repeat(64)], ['platform', 'linux-x64'], ['assetName', 'evil.zip'], ['url', 'https://github.com/other/repo/releases/download/v1.3.0/file.zip'], ['bytes', 0], ['schema', 2], ['algorithm', 'none'], ['sequence', 0], ['extra', true] ];
  for (const [field, value] of cases) {
    const f = fixture(t); await f.updater.check(); f.setManifest(f.rawSign({ ...f.payload, [field]: value }));
    await assert.rejects(f.updater.download(), /更新清单|指纹|签名/, field); assert.equal(f.calls.length, 2, field); assert.equal(f.backups, 0); assert.equal(fs.existsSync(path.join(f.dir, 'updates')), false);
  }
});
test('错误公钥不能验证有效签名；缺公钥或清单时明确不能下载', async t => {
  const f = fixture(t); f.settings.updates.publicKey = publicKeyInfo(crypto.generateKeyPairSync('ed25519').publicKey).publicKey;
  await f.updater.check(); await assert.rejects(f.updater.download(), /清单|指纹/);
  f.settings.updates.publicKey = ''; assert.equal((await f.updater.check()).canDownload, false); await assert.rejects(f.updater.download(), /签名更新包/);
  f.release.assets = []; assert.equal((await f.updater.check()).manifestUrl, null);
});
test('Release地址、清单资产与ZIP都必须精确属于所选仓库及tag，不能只看主机', async t => {
  for (const target of ['html_url', 'manifest', 'archive', 'duplicate', 'missing']) {
    const f = fixture(t);
    if (target === 'html_url') { f.release.html_url = 'https://github.com/other/repo/releases/tag/v1.3.0'; await assert.rejects(f.updater.check(), /Release.*所选仓库/); continue; }
    if (target === 'manifest') { f.release.assets[0].browser_download_url = 'https://github.com/other/repo/releases/download/v1.3.0/update-manifest.json'; await assert.rejects(f.updater.check(), /资产不属于/); continue; }
    if (target === 'archive') f.release.assets[1].browser_download_url = 'https://github.com/test-owner/test-workboard/releases/download/v1.3.0/other.zip';
    if (target === 'duplicate') f.release.assets.push({ ...f.release.assets[1] });
    if (target === 'missing') f.release.assets.pop();
    await f.updater.check(); await assert.rejects(f.updater.download(), /资产|URL/); assert.equal(f.calls.length, 2); assert.equal(f.backups, 0);
  }
});
test('仅允许有界手动GitHub HTTPS重定向，拒绝越界主机、凭据、HTTP和自动跟随', async t => {
  for (const location of ['http://github.com/archive.zip', 'https://github.com.evil.test/file', 'https://other.example.test/file', 'https://user:pass@github.com/file', 'https://github.com:444/file', 'https://api.github.com/private']) {
    const f = fixture(t); await f.updater.check(); f.intercept(url => url.endsWith('update-manifest.json') ? new Response('', { status: 302, headers: { location } }) : undefined);
    await assert.rejects(f.updater.download(), /受控 GitHub HTTPS/); assert.equal(f.calls.length, 2); assert.equal(f.backups, 0);
  }
  const loop = fixture(t); await loop.updater.check(); loop.intercept(() => new Response('', { status: 302, headers: { location: 'https://github.com/redirect-loop' } })); await assert.rejects(loop.updater.download(), /次数超限/); assert.equal(loop.calls.length, 7);
  const auto = fixture(t); await auto.updater.check(); auto.intercept(() => ({ ok: true, status: 200, redirected: true })); await assert.rejects(auto.updater.download(), /未受控重定向/);
});
test('受控CDN跳转可完成下载，每一次请求都强制manual且有AbortSignal', async t => {
  const f = fixture(t); f.intercept((url, request) => { assert.equal(request.redirect, 'manual'); assert.ok(request.signal instanceof AbortSignal); if (url === f.payload.url) return new Response('', { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/controlled-download' } }); if (url.endsWith('/controlled-download')) return new Response(f.bytes); });
  assert.equal((await downloaded(f)).verified, true); assert.equal(f.calls.length, 4);
});
test('原生fetch解压保留线缆长度时仍按解压后内容限制，不误判GitHub gzip元数据', async t => {
  const f = fixture(t); f.intercept((url, request) => { assert.equal(request.headers['Accept-Encoding'], 'identity'); if (url.startsWith('https://api.')) return new Response(JSON.stringify(f.release), { headers: { 'content-encoding': 'gzip', 'content-length': '10' } }); });
  assert.equal((await f.updater.check()).status, 'available'); assert.equal((await f.updater.download()).verified, true);
});
test('清单、元数据、ZIP有大小界限，实际资产大小和内容长度也必须一致', async t => {
  const metadata = fixture(t); metadata.intercept(() => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })); await assert.rejects(metadata.updater.check(), /大小限制/);
  const manifest = fixture(t); await manifest.updater.check(); manifest.intercept(() => new Response('{}', { headers: { 'content-length': String(64 * 1024 + 1) } })); await assert.rejects(manifest.updater.download(), /大小限制/);
  const archive = fixture(t); archive.intercept(url => url === archive.payload.url ? new Response('small', { headers: { 'content-length': String(MAX_ARCHIVE_BYTES + 1) } }) : undefined); await archive.updater.check(); await assert.rejects(archive.updater.download(), /大小限制/);
  const wrongSize = fixture(t); wrongSize.release.assets[1].size++; await wrongSize.updater.check(); await assert.rejects(wrongSize.updater.download(), /大小.*不一致/); assert.equal(wrongSize.calls.length, 2);
  const wrongLength = fixture(t); wrongLength.intercept(url => url === wrongLength.payload.url ? new Response(wrongLength.bytes, { headers: { 'content-length': String(wrongLength.bytes.length + 1) } }) : undefined); await wrongLength.updater.check(); await assert.rejects(wrongLength.updater.download(), /字节数.*不一致/);
});
test('ZIP字节和哈希不符不得落盘或备份', async t => {
  for (const bytes of [Buffer.from('tampered archive'), Buffer.alloc(Buffer.byteLength('isolated fake update archive'))]) {
    const f = fixture(t); f.setBytes(bytes); await f.updater.check(); await assert.rejects(f.updater.download(), /文件校验未通过/); assert.equal(f.backups, 0); assert.equal(fs.existsSync(path.join(f.dir, 'updates')), false);
  }
});
test('检查、下载和安装前后均核对来源通道及公钥快照', async t => {
  for (const stage of ['check', 'manifest', 'archive']) {
    const f = fixture(t);
    f.intercept(url => { if ((stage === 'check' && url.startsWith('https://api.')) || (stage === 'manifest' && url.endsWith('update-manifest.json')) || (stage === 'archive' && url === f.payload.url)) f.settings.updates.channel = 'preview'; });
    if (stage === 'check') await assert.rejects(f.updater.check(), /已改变/); else { await f.updater.check(); await assert.rejects(f.updater.download(), /已改变/); }
    assert.equal(f.backups, 0); assert.equal(fs.existsSync(path.join(f.dir, 'updates')), false);
  }
  const f = fixture(t); await downloaded(f); f.settings.updates.publicKey = ''; assert.equal(f.updater.status().status, 'invalidated'); await assert.rejects(f.updater.prepareInstall(), /先下载并验证|已改变/); assert.equal(f.backups, 0);
});
test('有效更新落盘且持久登记；重复下载复用同一文件，重启恢复仍核验', async t => {
  const f = fixture(t); const result = await downloaded(f);
  assert.equal(result.status, 'downloaded'); assert.equal(result.verified, true); assert.equal(result.canInstall, true); assert.equal(path.dirname(result.file), path.join(f.dir, 'updates')); assert.deepEqual(fs.readFileSync(result.file), f.bytes); assert.equal(f.backups, 0);
  const calls = f.calls.length; assert.deepEqual(await f.updater.download(), result); assert.equal(f.calls.length, calls);
  const restarted = f.create(); assert.equal(restarted.status().ticketId, result.ticketId); assert.equal(restarted.status().verified, true);
  assert.equal(f.persisted.verified.phase, 'downloaded'); assert.equal(Object.values(f.persisted.ledgers)[0].sequence, 1);
});
test('安装准备先持久占用、重读文件再备份，只消费一次，重启不能重放', async t => {
  const f = fixture(t); const result = await downloaded(f); const prepared = await f.updater.prepareInstall();
  assert.equal(prepared.installReady, true); assert.equal(prepared.backup.credentialsIncluded, false); assert.equal(f.backups, 1); assert.equal(f.persisted.verified.phase, 'consumed'); assert.ok(f.saves.some(value => value.verified.phase === 'preparing')); assert.equal(prepared.ticketId, result.ticketId);
  await assert.rejects(f.updater.prepareInstall(), /票据|先下载/); const restarted = f.create(); assert.equal(restarted.status().status, 'install_consumed'); await assert.rejects(restarted.prepareInstall(), /票据/);
  await restarted.check(); await assert.rejects(restarted.download(), /重放/); assert.equal(f.backups, 1);
});
test('篡改下载文件在备份前被拒绝，篡改账本不得恢复信任', async t => {
  const f = fixture(t); const result = await downloaded(f); fs.writeFileSync(result.file, Buffer.alloc(f.bytes.length));
  await assert.rejects(f.updater.prepareInstall(), /文件校验/); assert.equal(f.backups, 0); assert.equal(f.persisted.verified.phase, 'failed');
  const g = fixture(t); await downloaded(g); const bad = g.persisted; bad.verified.sha256 = '0'.repeat(64); g.setPersisted(bad); assert.equal(g.create().status().status, 'invalidated');
});
test('备份失败不能自动重试；显式重新下载验签后新票据保留上次失败记录', async t => {
  const f = fixture(t, { backupError: true }); const first = await downloaded(f); await assert.rejects(f.updater.prepareInstall(), /备份失败/); assert.equal(f.persisted.verified.failureStage, 'backup');
  await assert.rejects(f.updater.prepareInstall(), /先下载|票据/); f.setBackupError(false); const renewed = await f.updater.download(); assert.notEqual(renewed.ticketId, first.ticketId); assert.equal(f.persisted.attempts.length, 1); assert.equal(f.persisted.attempts[0].ticketId, first.ticketId);
  assert.equal((await f.updater.prepareInstall()).installReady, true); assert.equal(f.backups, 2);
});
test('备份期间文件变化会失败且票据不能通过同清单重新生成', async t => {
  let file; const f = fixture(t, { backup: () => { fs.writeFileSync(file, Buffer.alloc(f.bytes.length)); return {}; } }); file = (await downloaded(f)).file;
  await assert.rejects(f.updater.prepareInstall(), /文件校验/); assert.equal(f.persisted.verified.failureStage, 'after-backup'); await assert.rejects(f.updater.download(), /重放/);
});
test('备份期间来源变化会失效；占用账本失败时不备份', async t => {
  const f = fixture(t, { backup: () => { f.settings.updates.channel = 'preview'; return {}; } }); await downloaded(f); await assert.rejects(f.updater.prepareInstall(), /已改变/); assert.equal(f.updater.status().installReady, false);
  const g = fixture(t); await downloaded(g); g.setSaveError(true); await assert.rejects(g.updater.prepareInstall(), /账本写入失败/); assert.equal(g.backups, 0); assert.equal(g.persisted.verified.phase, 'downloaded');
});
test('并发安装只备份一次；第二个运行时也重新读取持久票据', async t => {
  let resolveBackup; const wait = new Promise(resolve => { resolveBackup = resolve; });
  const f = fixture(t, { backup: () => wait }); await downloaded(f); const secondRuntime = f.create(); const installing = f.updater.prepareInstall();
  await assert.rejects(f.updater.prepareInstall(), /正在执行/); await assert.rejects(secondRuntime.prepareInstall(), /票据/); assert.equal(f.persisted.verified.phase, 'preparing'); assert.equal(f.backups, 1);
  resolveBackup({}); await installing;
});
test('没有持久提交能力不能准备安装；异步保存不能提前执行备份', async t => {
  const f = fixture(t); const withoutStorage = f.create({ persistence: undefined }); await withoutStorage.check(); await withoutStorage.download(); await assert.rejects(withoutStorage.prepareInstall(), /持久更新账本/); assert.equal(f.backups, 0);
  const g = fixture(t); await downloaded(g); const asynchronous = g.create({ persistence: { load: () => g.persisted, save: () => Promise.resolve() } }); await assert.rejects(asynchronous.prepareInstall(), /必须同步提交/); assert.equal(g.backups, 0);
});
test('更换隔离运行模式后恢复文件按当前模式报告，不能被旧显示快照覆盖', async t => {
  const f = fixture(t, { channel: 'preview', previewTag: 'v1.3.0' }); await downloaded(f);
  const isolated = f.create({ allowPreviewInstall: true }); assert.equal(isolated.status().allowPreviewInstall, true); assert.equal(isolated.status().canInstall, true);
  const updatedVersion = f.create({ version: '1.3.0' }); assert.equal(updatedVersion.status().currentVersion, '1.3.0'); assert.equal(updatedVersion.status().canInstall, false);
});
test('两个运行时同时下载同序号时只登记一个票据，另一个必须重新检查恢复', async t => {
  const f = fixture(t), second = f.create(); await f.updater.check(); await second.check();
  const results = await Promise.allSettled([f.updater.download(), second.download()]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1); assert.equal(results.filter(value => value.status === 'rejected').length, 1);
  const winner = results.find(value => value.status === 'fulfilled').value; const loser = results[0].status === 'rejected' ? f.updater : second;
  await loser.check(); assert.equal((await loser.download()).ticketId, winner.ticketId); assert.equal(fs.readdirSync(path.join(f.dir, 'updates')).length, 1);
});
test('链接更新目录不能写入外部目录；重复下载发现篡改后立即失去已核验状态', async t => {
  const f = fixture(t), elsewhere = path.join(f.dir, 'outside'); fs.mkdirSync(elsewhere); fs.symlinkSync(elsewhere, path.join(f.dir, 'updates'), 'junction');
  await f.updater.check(); await assert.rejects(f.updater.download(), /路径链接/); assert.deepEqual(fs.readdirSync(elsewhere), []);
  const g = fixture(t); const result = await downloaded(g); fs.writeFileSync(result.file, Buffer.alloc(g.bytes.length)); await assert.rejects(g.updater.download(), /文件校验/); assert.equal(g.updater.status().verified, false); assert.equal(g.updater.status().canInstall, false);
});
test('进程中断保留未知票据，不自动重复；旧sequence不能产生新安装，新sequence可继续', async t => {
  const f = fixture(t); await downloaded(f); const interrupted = f.persisted; interrupted.verified.phase = 'preparing'; f.setPersisted(interrupted);
  const restarted = f.create(); assert.equal(restarted.status().status, 'install_interrupted'); await restarted.check(); await assert.rejects(restarted.download(), /重放/); assert.equal(f.backups, 0);
  f.setTarget('1.3.0', 2); await restarted.check(); assert.equal((await restarted.download()).sequence, 2);
  f.setTarget('1.3.0', 1); await restarted.check(); await assert.rejects(restarted.download(), /重放/);
});
test('丢失已核验文件不能用旧清单重新创建票据', async t => {
  const f = fixture(t); const result = await downloaded(f); fs.unlinkSync(result.file); const restarted = f.create(); assert.equal(restarted.status().status, 'invalidated'); await restarted.check(); await assert.rejects(restarted.download(), /ENOENT/); assert.equal(f.backups, 0);
});
test('不完整部署包在替换当前程序前由必需文件校验拒绝', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-incomplete-package-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = { 'package.json': JSON.stringify({ name: 'personal-workboard', version: '0.2.3', dependencies: {} }), 'dist/index.html': '<!doctype html><html lang="zh-CN"><title>不完整测试包</title></html>', 'node_modules/test-dependency/package.json': '{"name":"test-dependency"}' };
  const entries = [];
  for (const [name, content] of Object.entries(files)) { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); entries.push({ path: name, sha256: crypto.createHash('sha256').update(content).digest('hex') }); }
  fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify({ schema: 1, kind: 'deployment', version: '0.2.3', files: entries }));
  assert.throws(() => require('../scripts/validate-package.cjs').validate(root, { updateMode: true }), /必需文件/);
});
