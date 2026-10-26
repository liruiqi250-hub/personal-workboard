'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdates, isNewer } = require('../server/updates.cjs');

const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-update-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const settings = { updates: { owner: 'test-owner', repo: 'test-workboard', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) } };
  const bytes = Buffer.from('isolated fake update archive');
  const release = { tag_name: 'v1.3.0', prerelease: false, draft: false, html_url: 'https://github.com/test-owner/test-workboard/releases/tag/v1.3.0', body: '中文版本更新记录', assets: [{ name: 'update-manifest.json', browser_download_url: 'https://github.com/test-owner/test-workboard/releases/download/v1.3.0/update-manifest.json' }] };
  const payload = { version: '1.3.0', url: 'https://github.com/test-owner/test-workboard/releases/download/v1.3.0/workboard.zip', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const sign = value => ({ ...value, signature: crypto.sign(null, Buffer.from(JSON.stringify(value)), privateKey).toString('base64') });
  let manifest = sign(payload); let fetchedBytes = bytes; let backups = 0; const calls = [];
  const fetchImpl = async urlValue => {
    const url = String(urlValue); calls.push(url);
    if (url.startsWith('https://api.github.com/')) return json(release);
    if (url.endsWith('update-manifest.json')) return json(manifest);
    if (url === manifest.url) return new Response(fetchedBytes, { status: 200, headers: { 'content-length': String(fetchedBytes.length) } });
    throw new Error('Unexpected mocked URL: ' + url);
  };
  const updater = createUpdates({ version: '1.2.3', dataDir: dir, getSettings: () => settings,
    backup: async () => { backups++; if (options.backupError) throw Error('备份失败'); return { path: path.join(dir, 'before-update.sqlite'), credentialsIncluded: false }; }, fetchImpl });
  return { dir, updater, settings, release, payload, sign, calls, get backups() { return backups; }, setManifest(value) { manifest = value; }, setBytes(value) { fetchedBytes = value; } };
}

test('正式版本号按整数逐段比较，不能用字符串大小判断', () => {
  assert.equal(isNewer('v1.10.0', '1.9.9'), true);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.2.4', '1.2.3'), true);
  assert.equal(isNewer('v1.2.3', '1.2.3'), false);
  assert.equal(isNewer('1.2.2', '1.2.3'), false);
  for (const candidate of ['1.2.4-beta', '1.2', '1.2.4.1', '01.2.4', 'invalid', '../../9.9.9']) assert.equal(isNewer(candidate, '1.2.3'), false, candidate);
  assert.equal(isNewer('1.2.4+build.1', '1.2.3'), true);
});

test('尚未绑定更新仓库时不联网，仓库名称不能注入 URL 路径', async t => {
  const f = fixture(t); f.settings.updates = {};
  assert.equal((await f.updater.check()).status, 'unconfigured'); assert.equal(f.calls.length, 0);
  f.settings.updates = { owner: 'owner/../../evil', repo: 'repo' };
  await assert.rejects(f.updater.check(), /仓库名称格式/); assert.equal(f.calls.length, 0);
});

test('真实目标仓库尚无正式Release时保留待配置，不声称已是最新版',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workboard-release-pending-'));let calls=0;
 const updater=createUpdates({version:'0.3.0',dataDir:dir,getSettings:()=>({updates:{owner:'liruiqi250-hub',repo:'personal-workboard',publicKey:''}}),backup:async()=>{throw Error('不应备份');},fetchImpl:async url=>{calls++;assert.equal(url,'https://api.github.com/repos/liruiqi250-hub/personal-workboard/releases/latest');return new Response('',{status:404});}});
 const result=await updater.check();assert.equal(result.status,'unconfigured');assert.equal(result.canDownload,false);assert.equal(result.verified,false);assert.match(result.message,/未取得.*Release/);assert.equal(calls,1);
});

test('版本检查保留中文说明但不声称验签完成，旧版与当前版不显示可用升级', async t => {
  const f = fixture(t); const available = await f.updater.check();
  assert.equal(available.status, 'available'); assert.equal(available.version, '1.3.0');
  assert.equal(available.verified, false); assert.equal(available.canDownload, true); assert.equal(available.notes, '中文版本更新记录');
  f.release.tag_name = 'v1.2.3'; assert.equal((await f.updater.check()).status, 'current');
  f.release.tag_name = 'v1.1.0'; assert.equal((await f.updater.check()).status, 'current');
});

test('当前版本和更旧版本即使带签名清单也不允许下载为升级', async t => {
  const f = fixture(t);
  for (const version of ['1.2.3', '1.1.0']) {
    f.release.tag_name = 'v' + version;
    f.setManifest(f.sign({ ...f.payload, version }));
    const before = f.calls.length;
    assert.equal((await f.updater.check()).status, 'current');
    await assert.rejects(f.updater.download(), /新版本|可用更新|当前/);
    assert.equal(f.calls.length, before + 1, '只应请求发行版检查，不下载清单或资产');
  }
  assert.equal(fs.existsSync(path.join(f.dir, 'updates')), false); assert.equal(f.backups, 0);
});

test('草稿和预发布版本拒绝成为正式更新', async t => {
  const f = fixture(t); f.release.prerelease = true;
  await assert.rejects(f.updater.check(), /正式发布/);
  f.release.prerelease = false; f.release.draft = true;
  await assert.rejects(f.updater.check(), /正式发布/);
});

test('签名错误先行拒绝，不下载更新包、不创建文件、不调用备份', async t => {
  const f = fixture(t); await f.updater.check();
  f.setManifest({ ...f.sign(f.payload), signature: Buffer.alloc(64).toString('base64') });
  await assert.rejects(f.updater.download(), /签名验证未通过/);
  assert.equal(f.calls.length, 2); assert.equal(fs.existsSync(path.join(f.dir, 'updates')), false);
  assert.equal(f.updater.status().verified, false); assert.equal(f.backups, 0);
  await assert.rejects(f.updater.prepareInstall(), /先下载并验证/);
});

test('清单版本与发行版不一致即拒绝；缺少公钥或清单不能自动安装', async t => {
  const f = fixture(t); await f.updater.check();
  f.setManifest(f.sign({ ...f.payload, version: '9.9.9' }));
  await assert.rejects(f.updater.download(), /版本.*不一致/); assert.equal(f.calls.length, 2);
  f.settings.updates.publicKey = ''; await f.updater.check();
  assert.equal(f.updater.status().canDownload, false);
  await assert.rejects(f.updater.download(), /签名更新包/);
  f.release.assets = []; await f.updater.check(); assert.equal(f.updater.status().manifestUrl, null);
});

test('即使有效签名也只能下载 GitHub HTTPS 资产，禁止其他主机和明文协议', async t => {
  const f = fixture(t); await f.updater.check();
  for (const url of ['http://github.com/update.zip', 'https://github.com.evil.test/update.zip', 'https://other.example.test/update.zip']) {
    f.setManifest(f.sign({ ...f.payload, url }));
    await assert.rejects(f.updater.download(), /GitHub HTTPS/);
  }
  assert.equal(f.calls.length, 4); assert.equal(fs.existsSync(path.join(f.dir, 'updates')), false);
});

test('更新文件 SHA256 不匹配拒绝落盘并保留当前程序', async t => {
  const f = fixture(t); await f.updater.check(); f.setBytes(Buffer.from('tampered archive'));
  await assert.rejects(f.updater.download(), /文件校验未通过/);
  assert.equal(f.updater.status().verified, false); assert.equal(fs.existsSync(path.join(f.dir, 'updates')), false); assert.equal(f.backups, 0);
});

test('有效签名与文件哈希通过后保存实际字节，安装准备必须先成功备份', async t => {
  const f = fixture(t); await f.updater.check(); const downloaded = await f.updater.download();
  assert.equal(downloaded.status, 'downloaded'); assert.equal(downloaded.verified, true);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(downloaded.file)).digest('hex'), f.payload.sha256);
  assert.equal(path.dirname(downloaded.file), path.join(f.dir, 'updates'));
  assert.equal(f.backups, 0);
  const callsBeforeRetry = f.calls.length;
  assert.deepEqual(await f.updater.download(), downloaded);
  assert.equal(f.calls.length, callsBeforeRetry, '同一已验证更新重复点击无需再次联网');
  const prepared = await f.updater.prepareInstall();
  assert.equal(prepared.installReady, true); assert.equal(f.backups, 1);
  assert.equal(prepared.backup.credentialsIncluded, false); assert.match(prepared.message, /替换与重启/);
});

test('备份失败时安装准备失败，不返回安装已就绪', async t => {
  const f = fixture(t, { backupError: true }); await f.updater.check(); await f.updater.download();
  await assert.rejects(f.updater.prepareInstall(), /备份失败/); assert.equal(f.backups, 1);
  assert.equal(f.updater.status().installReady, undefined);
});

test('不完整部署包在替换当前程序之前被必需文件校验拒绝', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-incomplete-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ name: 'personal-workboard', version: '0.2.3', dependencies: {} }),
    'dist/index.html': '<!doctype html><html lang="zh-CN"><title>不完整测试包</title></html>',
    'node_modules/test-dependency/package.json': '{"name":"test-dependency"}',
  };
  const entries = [];
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
    entries.push({ path: name, sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify({ schema: 1, kind: 'deployment', version: '0.2.3', files: entries }));
  const { validate } = require('../scripts/validate-package.cjs');
  assert.throws(() => validate(root, { updateMode: true }), /必需文件/);
});
