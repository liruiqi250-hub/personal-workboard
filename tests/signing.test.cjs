'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { OWNER, REPO, KEY_FILE, checkedAbsolute, checkedKeyDir, createPublisherKeys } = require('../server/publisher-keys.cjs');
const { createManifestPayload, verifyManifest } = require('../server/update-protocol.cjs');
const { parseArgs, readZipDigest, signArchive, main } = require('../scripts/sign-update.cjs');
const CREATED = '2026-10-26T01:02:03.000Z';
const PROJECT = path.resolve(__dirname, '..');

function archiveEntries(version = '0.3.1') {
  return [['package.json', JSON.stringify({ name: 'personal-workboard', version })], ['release-manifest.json', JSON.stringify({ schema: 1, name: 'personal-workboard', version, kind: 'deployment', platform: 'win32-x64', files: [] })]];
}

// A complete stored ZIP with local headers, CRC32, central directory and EOCD.
// Test identity files are real archive entries, not fabricated PK header bytes.
function zipBytes(entries = archiveEntries()) {
  const local = []; const central = []; let offset = 0;
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const [entryName, content] of entries) {
    const name = Buffer.from(entryName); const bytes = Buffer.from(content); const checksum = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + bytes.length;
  }
  const directoryBytes = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}

function fixture(t, override = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-publisher-test-签名-'));
  t.after(() => { checkedAbsolute(dir); fs.rmSync(dir, { recursive: true, force: true }); });
  const keyDir = path.join(dir, 'keys');
  const sealed = new Map();
  const protectImpl = async (value, decode = false) => {
    if (decode) { if (!sealed.has(value)) throw Error('unavailable'); return sealed.get(value); }
    const token = crypto.randomBytes(96).toString('base64'); sealed.set(token, value); return token;
  };
  const options = { keyDir, projectRoot: PROJECT, protectImpl, now: () => CREATED, ...override };
  const bytes = zipBytes();
  const zip = path.join(dir, 'personal-workboard-0.3.1-windows-x64.zip'); fs.writeFileSync(zip, bytes);
  const signOptions = { zip, version: '0.3.1', tag: 'v0.3.1', channel: 'preview', sequence: '1', 'created-at': CREATED, 'output-dir': path.join(dir, 'metadata') };
  return { dir, keyDir, file: path.join(keyDir, KEY_FILE), bytes, zip, protectImpl, options, keys: createPublisherKeys(options), signOptions };
}

test('显式 init 以排他封套保存，重复 init 复读同一项目密钥且只返回公钥元数据', async t => {
  const f = fixture(t); assert.equal(fs.existsSync(f.keyDir), false);
  const first = await f.keys.init(); const original = fs.readFileSync(f.file, 'utf8');
  const envelope = JSON.parse(original);
  assert.equal(first.owner, OWNER); assert.equal(first.repo, REPO); assert.equal(first.protection, 'windows-dpapi-current-user');
  assert.match(first.publicKey, /^-----BEGIN PUBLIC KEY-----/); assert.match(first.keyId, /^[a-f0-9]{64}$/); assert.equal(first.fingerprint, 'SHA256:' + first.keyId);
  assert.equal(typeof envelope.protectedPrivateKey, 'string'); assert.doesNotMatch(original, /PRIVATE KEY/);
  const reopened = createPublisherKeys(f.options);
  assert.deepEqual(await reopened.init(), first); assert.deepEqual(await reopened.getPublic(), first); assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  const output = JSON.stringify(first);
  assert.doesNotMatch(output, /PRIVATE KEY|protectedPrivateKey|ciphertext/); assert.equal(output.includes(envelope.protectedPrivateKey), false);
  assert.deepEqual(Object.keys(f.keys).sort(), ['getPublic', 'init', 'sign']);
});

test('public/sign 不存在的密钥明确失败且不自动创建目录或密钥', async t => {
  const f = fixture(t);
  await assert.rejects(f.keys.getPublic(), /显式运行 init/);
  await assert.rejects(f.keys.sign({}), /显式运行 init/);
  assert.equal(fs.existsSync(f.keyDir), false);
});

test('密钥拒绝项目内、相对目录、目录联接及链接祖先', async t => {
  const f = fixture(t);
  assert.throws(() => createPublisherKeys({ keyDir: path.join(PROJECT, 'work', 'publisher-forbidden') }), /项目目录之外/);
  assert.throws(() => createPublisherKeys({ keyDir: 'relative-keys' }), /绝对路径/);
  const target = path.join(f.dir, 'target'); fs.mkdirSync(target);
  const link = path.join(f.dir, 'linked'); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createPublisherKeys({ keyDir: path.join(link, 'child') }), /链接|联接/);
  fs.unlinkSync(link);
  assert.equal(fs.existsSync(path.join(target, 'child')), false);
});

test('Windows 设备、NT、UNC、根相对和尾部别名在文件操作前拒绝，不创建目录或初始化', { skip: process.platform !== 'win32' }, () => {
  const target = path.join(PROJECT, 'review-only-no-create');
  assert.equal(fs.existsSync(target), false);
  const variants = [
    '\\\\?\\' + target, '\\\\.\\' + target, '\\??\\' + target, '\\\\??\\' + target,
    '\\Device\\HarddiskVolume1\\review-only-no-create', '\\GLOBAL??\\' + target,
    '\\\\localhost\\C$\\review-only-no-create', '\\\\server\\share\\review-only-no-create',
    '//?/' + target.replaceAll('\\', '/'), '\\review-only-no-create',
    path.join(PROJECT + '.', 'review-only-no-create'), path.join(PROJECT + ' ', 'review-only-no-create'),
    path.join(os.tmpdir(), 'NUL', 'review-only-no-create'), path.join(os.tmpdir(), 'review-only-no-create:stream'),
  ];
  for (const value of variants) {
    assert.throws(() => checkedAbsolute(value), /本机盘符|保留设备|别名/);
    assert.throws(() => checkedKeyDir(value), /本机盘符|保留设备|别名/);
    assert.throws(() => createPublisherKeys({ keyDir: value }), /本机盘符|保留设备|别名/);
  }
  assert.equal(fs.existsSync(target), false);
});

test('真实既存祖先先 canonical 后比较项目边界，8.3 类别名不能绕过且不创建目标', t => {
  const externalAncestor = path.resolve(os.tmpdir());
  const targetName = 'workboard-review-only-alias-no-create';
  const target = path.join(externalAncestor, targetName);
  const canonicalTarget = path.join(fs.realpathSync.native(PROJECT), targetName);
  assert.equal(fs.existsSync(target), false); assert.equal(fs.existsSync(canonicalTarget), false);
  const nativeRealpath = fs.realpathSync.native;
  // A deterministic existing-ancestor alias fixture. This Windows volume has
  // 8.3 names disabled, so emulate only realpath's long-name result, not mkdir.
  const mock = t.mock.method(fs.realpathSync, 'native', value => path.resolve(value).toLowerCase() === externalAncestor.toLowerCase() ? nativeRealpath(PROJECT) : nativeRealpath(value));
  try {
    assert.equal(checkedAbsolute(target), canonicalTarget);
    assert.throws(() => checkedKeyDir(target), /项目目录之外/);
    assert.throws(() => createPublisherKeys({ keyDir: target }), /项目目录之外/);
  } finally { mock.mock.restore(); }
  assert.equal(fs.existsSync(target), false); assert.equal(fs.existsSync(canonicalTarget), false);
});

test('已有错误用途或仓库绑定的封套被拒绝，不会重新生成或覆盖', async t => {
  const f = fixture(t); await f.keys.init();
  const original = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  for (const change of [{ owner: 'another-owner' }, { repo: 'another-project' }, { purpose: 'another-purpose' }]) {
    const changed = JSON.stringify({ ...original, ...change }); fs.writeFileSync(f.file, changed);
    await assert.rejects(f.keys.init(), /绑定不匹配/); assert.equal(fs.readFileSync(f.file, 'utf8'), changed);
  }
});

test('DPAPI 保护失败不落盘，解密失败及公钥替换均不输出底层私钥错误', async t => {
  const f = fixture(t);
  const fail = createPublisherKeys({ ...f.options, protectImpl: async () => { throw Error('-----BEGIN ' + 'PRIVATE KEY----- DO-NOT-PRINT'); } });
  await assert.rejects(fail.init(), error => /DPAPI 保护失败/.test(error.message) && !error.message.includes('DO-NOT-PRINT'));
  assert.equal(fs.existsSync(f.file), false);
  await f.keys.init();
  await assert.rejects(fail.getPublic(), error => /当前 Windows 用户/.test(error.message) && !error.message.includes('DO-NOT-PRINT'));
  const changed = JSON.parse(fs.readFileSync(f.file, 'utf8')); changed.keyId = '0'.repeat(64); fs.writeFileSync(f.file, JSON.stringify(changed));
  await assert.rejects(f.keys.getPublic(), /当前 Windows 用户/);
});

test('损坏、未知字段、超长和启动后替换成目录联接的密钥封套均拒绝覆盖', async t => {
  const f = fixture(t); await f.keys.init(); const original = fs.readFileSync(f.file, 'utf8');
  for (const changed of ['{broken', JSON.stringify({ ...JSON.parse(original), privateKey: 'forbidden' }), 'a'.repeat(33 * 1024)]) {
    fs.writeFileSync(f.file, changed); await assert.rejects(f.keys.init()); assert.equal(fs.readFileSync(f.file, 'utf8'), changed);
  }
  fs.writeFileSync(f.file, original);
  const moved = path.join(f.dir, 'moved-keys'); fs.renameSync(f.keyDir, moved);
  fs.symlinkSync(moved, f.keyDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.keys.getPublic(), /链接|联接/); await assert.rejects(f.keys.init(), /链接|联接/);
  assert.equal(fs.readFileSync(path.join(moved, KEY_FILE), 'utf8'), original); fs.unlinkSync(f.keyDir);
});

test('签名从真实 ZIP 实读 hash/bytes，清单可验签且兼容旧客户端 JSON.stringify', async t => {
  const f = fixture(t); const info = await f.keys.init();
  const result = await signArchive(f.signOptions, f.keys);
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  const payload = verifyManifest(manifest, info.publicKey, { owner: OWNER, repo: REPO, version: '0.3.1', channel: 'preview' });
  assert.equal(payload.bytes, f.bytes.length); assert.equal(payload.sha256, crypto.createHash('sha256').update(f.bytes).digest('hex'));
  const { signature, ...legacyPayload } = manifest;
  assert.equal(crypto.verify(null, Buffer.from(JSON.stringify(legacyPayload)), info.publicKey, Buffer.from(signature, 'base64')), true);
  assert.deepEqual(await signArchive(f.signOptions, f.keys), result);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY|protectedPrivateKey/);
});

test('不同版本、通道、tag、序号、文件名、非 ZIP 和已有不同清单拒绝签名输出', async t => {
  const f = fixture(t); await f.keys.init();
  for (const change of [{ version: '0.3.2' }, { channel: 'unknown' }, { tag: 'v0.3.2' }, { sequence: '0' }]) {
    await assert.rejects(signArchive({ ...f.signOptions, ...change }, f.keys));
    assert.equal(fs.existsSync(f.signOptions['output-dir']), false);
  }
  fs.writeFileSync(f.zip, Buffer.from('not a real zip archive at all'));
  assert.throws(() => readZipDigest(f.zip, '0.3.1'), /ZIP 文件头/);
  fs.writeFileSync(f.zip, f.bytes);
  const result = await signArchive(f.signOptions, f.keys);
  const original = fs.readFileSync(result.manifestPath, 'utf8');
  await assert.rejects(signArchive({ ...f.signOptions, sequence: '2' }, f.keys), /已有不同内容/);
  assert.equal(fs.readFileSync(result.manifestPath, 'utf8'), original);
});

test('空 ZIP、目标 entry 重复、身份 JSON 过大或损坏均不能签发且不回显文件内容', async t => {
  const f = fixture(t); await f.keys.init();
  const variants = [
    zipBytes([]),
    zipBytes([...archiveEntries(), archiveEntries()[0]]),
    zipBytes([...archiveEntries(), ['PACKAGE.JSON', '{}']]),
    zipBytes([['package.json', ' '.repeat(262145)], archiveEntries()[1]]),
    zipBytes([archiveEntries()[0], ['release-manifest.json', ' '.repeat(4194305)]]),
    zipBytes([['package.json', '{broken DO-NOT-ECHO-ARCHIVE-CONTENT'], archiveEntries()[1]]),
  ];
  for (const bytes of variants) {
    fs.writeFileSync(f.zip, bytes);
    await assert.rejects(signArchive(f.signOptions, f.keys), error => /身份文件/.test(error.message) && !error.message.includes('DO-NOT-ECHO'));
    assert.equal(fs.existsSync(f.signOptions['output-dir']), false);
  }
});

test('包内名称、版本、发行类型、平台不符均拒绝，旧版本重命名为新版本 ZIP 也不能签', async t => {
  const f = fixture(t); await f.keys.init();
  const defaults = archiveEntries().map(([name, text]) => [name, JSON.parse(text)]);
  const variants = [
    [0, { name: 'another-project' }], [0, { version: '0.3.2' }],
    [1, { name: 'another-project' }], [1, { version: '0.3.2' }], [1, { kind: 'source' }], [1, { platform: 'node24' }],
  ];
  for (const [index, change] of variants) {
    fs.writeFileSync(f.zip, zipBytes(defaults.map(([name, value], current) => [name, JSON.stringify(current === index ? { ...value, ...change } : value)])));
    await assert.rejects(signArchive(f.signOptions, f.keys), /包内名称、版本、部署类型或平台/);
    assert.equal(fs.existsSync(f.signOptions['output-dir']), false);
  }
  fs.writeFileSync(f.zip, f.bytes);
  const renamed = path.join(f.dir, 'personal-workboard-0.3.2-windows-x64.zip'); fs.copyFileSync(f.zip, renamed);
  await assert.rejects(signArchive({ ...f.signOptions, zip: renamed, version: '0.3.2', tag: 'v0.3.2' }, f.keys), /包内名称、版本、部署类型或平台/);
  assert.equal(fs.existsSync(f.signOptions['output-dir']), false);
});

test('ZIP 或输出目录经过目录联接时拒绝读取和写入，输出目录必须显式绝对指定', async t => {
  const f = fixture(t); await f.keys.init();
  const linked = path.join(f.dir, 'linked-dir'); fs.symlinkSync(f.dir, linked, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(signArchive({ ...f.signOptions, zip: path.join(linked, path.basename(f.zip)) }, f.keys), /链接|联接/);
    await assert.rejects(signArchive({ ...f.signOptions, 'output-dir': path.join(linked, 'out') }, f.keys), /链接|联接/);
    await assert.rejects(signArchive({ ...f.signOptions, 'output-dir': 'relative' }, f.keys), /绝对路径/);
    await assert.rejects(signArchive({ ...f.signOptions, 'output-dir': undefined }, f.keys), /绝对路径/);
    assert.equal(fs.existsSync(path.join(f.dir, 'out')), false);
  } finally { fs.unlinkSync(linked); }
});

test('解密签名期间 ZIP 内容被替换时不保存清单', async t => {
  const f = fixture(t); await f.keys.init();
  const changingKeys = { getPublic: f.keys.getPublic, sign: async payload => {
    const result = await f.keys.sign(payload);
    const changed = Buffer.from(f.bytes); changed[21] = 1; fs.writeFileSync(f.zip, changed); return result;
  } };
  await assert.rejects(signArchive(f.signOptions, changingKeys), /签名期间 ZIP 文件已经改变/);
  assert.equal(fs.existsSync(f.signOptions['output-dir']), false);
});

test('公钥指纹和仓库绑定必须与清单相同，签名接口没有私钥导入路径', async t => {
  const f = fixture(t); const info = await f.keys.init();
  const payload = createManifestPayload({ owner: OWNER, repo: REPO, version: '0.3.1', channel: 'preview', sha256: 'a'.repeat(64), bytes: 22, keyId: info.keyId, sequence: 1, createdAt: CREATED });
  await assert.rejects(f.keys.sign({ ...payload, owner: 'other-owner' }), /绑定不匹配/);
  await assert.rejects(f.keys.sign({ ...payload, keyId: 'b'.repeat(64) }), /绑定不匹配/);
  for (const argv of [['init', '--private-key', 'value'], ['sign', '--owner', 'other'], ['init', '--key-dir', 'a', '--key-dir', 'b'], ['sign', '--sequence', '1']]) assert.throws(() => parseArgs(argv));
});

test('CLI init/public 仅输出安全元数据，错误不输出底层 cause 或私钥', async t => {
  const f = fixture(t); let output = ''; let errors = '';
  const streams = { stdout: { write: value => { output += value; } }, stderr: { write: value => { errors += value; } }, createKeys: () => f.keys };
  assert.equal(await main(['init'], streams), 0); const first = JSON.parse(output); output = '';
  assert.equal(await main(['public'], streams), 0); assert.deepEqual(JSON.parse(output), first);
  assert.doesNotMatch(output + errors, /PRIVATE KEY|protectedPrivateKey|ciphertext/);
  assert.equal(output.includes(JSON.parse(fs.readFileSync(f.file, 'utf8')).protectedPrivateKey), false);
  assert.equal(await main(['public'], { ...streams, createKeys: () => { throw Object.assign(Error('-----BEGIN ' + 'PRIVATE KEY-----'), { cause: 'DO-NOT-PRINT' }); } }), 1);
  assert.doesNotMatch(errors, /PRIVATE KEY|DO-NOT-PRINT/);
});

test('真实 Windows DPAPI 临时密钥 CLI 初始化、复读、签名及输出保密验证', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
  const f = fixture(t); const script = path.join(PROJECT, 'scripts', 'sign-update.cjs');
  const invoke = args => spawnSync(process.execPath, [script, ...args, '--key-dir', f.keyDir], { cwd: PROJECT, encoding: 'utf8', windowsHide: true, timeout: 12000 });
  const first = invoke(['init']); assert.equal(first.status, 0, first.stderr); const original = fs.readFileSync(f.file, 'utf8');
  const again = invoke(['init']); assert.equal(again.status, 0, again.stderr); assert.equal(again.stdout, first.stdout); assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  const pub = invoke(['public']); assert.equal(pub.status, 0, pub.stderr); assert.equal(pub.stdout, first.stdout);
  const signed = invoke(['sign', '--zip', f.zip, '--version', '0.3.1', '--tag', 'v0.3.1', '--channel', 'preview', '--sequence', '1', '--created-at', CREATED, '--output-dir', f.signOptions['output-dir']]);
  assert.equal(signed.status, 0, signed.stderr);
  const info = JSON.parse(pub.stdout); const result = JSON.parse(signed.stdout); const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(verifyManifest(manifest, info.publicKey).sha256, crypto.createHash('sha256').update(f.bytes).digest('hex'));
  const cipher = JSON.parse(original).protectedPrivateKey;
  for (const result of [first, again, pub, signed]) { assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY|protectedPrivateKey|ciphertext/); assert.equal((result.stdout + result.stderr).includes(cipher), false); }
  assert.doesNotMatch(original, /PRIVATE KEY/);
});
