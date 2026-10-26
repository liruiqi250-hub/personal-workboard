'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { reconstructLegacy } = require('../scripts/maintenance-legacy.cjs');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function put(base, relative, value) {
  const file = path.join(base, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file;
}
function tree(base) {
  const files = [];
  function walk(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) walk(file); else files.push({ path: path.relative(base, file).replaceAll('\\', '/'), sha256: sha(file) }); } }
  walk(base); return files.sort((a, b) => a.path.localeCompare(b.path));
}
function release(base, version) {
  const values = {
    'package.json': JSON.stringify({ name: 'personal-workboard', version }),
    'package-lock.json': JSON.stringify({ name: 'personal-workboard', version, lockfileVersion: 3 }),
    'server/main.cjs': '// main ' + version,
    'server/00-before.cjs': '// moved early ' + version,
    'server/10-locked.cjs': '// locked ' + version,
    'scripts/common.ps1': '# common ' + version,
    'scripts/start.ps1': '# start ' + version,
    'scripts/stop.ps1': '# stop ' + version,
    'scripts/update.ps1': '# update ' + version,
    'scripts/rollback.ps1': '# rollback ' + version,
    'dist/index.html': '<!doctype html><title>' + version + '</title>',
    'vendor/node/node.exe': 'synthetic node fixture, never executed',
    'vendor/node/LICENSE': 'synthetic fixture license',
    'README.md': '# README ' + version,
  };
  if (version === '0.3.3') values['scripts/maintenance.ps1'] = '# new maintenance';
  for (const [name, value] of Object.entries(values)) put(base, name, value);
  const manifest = { schema: 1, name: 'personal-workboard', version, kind: 'deployment', node: '>=24', platform: 'win32-x64', createdAt: '2026-10-27T00:00:00.000Z', files: tree(base) };
  put(base, 'release-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-legacy-recovery-test-'));
  const expectedPrefix = path.resolve(os.tmpdir()) + path.sep + 'workboard-legacy-recovery-test-';
  assert(path.resolve(base).startsWith(expectedPrefix));
  t.after(() => { assert(path.resolve(base).startsWith(expectedPrefix)); fs.rmSync(base, { recursive: true, force: true }); });
  const program = path.join(base, 'program'), data = path.join(base, 'data'); fs.mkdirSync(data);
  const old = release(program, '0.3.2'), original = new Map(tree(program).map(f => [f.path, f.sha256]));
  const previous = path.join(program, '.workboard-previous', 'legacy'), saved = path.join(previous, 'program'); fs.mkdirSync(saved, { recursive: true });
  const incoming = path.join(program, '.workboard-updates', 'trusted', 'incoming'); release(incoming, '0.3.3');
  // A directory move failed before moved[] was appended, after this child moved.
  const early = 'server/00-before.cjs'; put(saved, early, fs.readFileSync(path.join(program, early))); fs.unlinkSync(path.join(program, early));
  // An earlier file completed both old backup and new install.
  put(saved, 'README.md', fs.readFileSync(path.join(program, 'README.md'))); fs.copyFileSync(path.join(incoming, 'README.md'), path.join(program, 'README.md'));
  const snapshot = path.join(data, 'backups', 'before-update'); fs.mkdirSync(snapshot, { recursive: true });
  const db = new DatabaseSync(path.join(snapshot, 'workboard.sqlite')); db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,json TEXT); INSERT INTO tasks VALUES(\'old-task\',\'{"title":"合成任务"}\')'); db.close();
  put(snapshot, '报告/日报.html', '<p>合成报告</p>');
  const metadata = { state: 'needs-rollback', fromVersion: '0.3.2', toVersion: '0.3.3', dataDir: data, dataBackupDir: snapshot, port: 18341, packageSha256: '1'.repeat(64), moved: ['README.md'], installed: ['README.md'] };
  put(previous, 'update-metadata.json', JSON.stringify(metadata, null, 2));
  const destination = path.join(program, '.workboard-previous', 'recovered', 'program');
  const request = { programDir: program, previousDir: previous, incomingDir: incoming, dataDir: data, port: 18341, destinationDir: destination, expectedSha256: metadata.packageSha256 };
  function originalState() {
    const files = [];
    for (const relative of original.keys()) if (fs.existsSync(path.join(program, relative))) files.push({ location: 'live/' + relative, sha256: sha(path.join(program, relative)) });
    for (const item of tree(previous)) files.push({ location: 'previous/' + item.path, sha256: item.sha256 });
    for (const item of tree(snapshot)) files.push({ location: 'data-snapshot/' + item.path, sha256: item.sha256 });
    return files;
  }
  return { base, program, data, previous, saved, incoming, destination, request, snapshot, metadata, original, old, originalState, saveMetadata() { put(previous, 'update-metadata.json', JSON.stringify(metadata)); } };
}

test('旧moved遗漏目录时按完整原清单组合saved/live，原现场和数据不变', t => {
  const f = fixture(t), before = f.originalState();
  const result = reconstructLegacy(f.request);
  assert.equal(result.fromVersion, '0.3.2'); assert.equal(result.toVersion, '0.3.3');
  assert.equal(result.dataSnapshot, f.snapshot); assert.equal(result.completeVerifiedOldProgram, true);
  assert.equal(result.sources.find(s => s.path === 'server/00-before.cjs').source, 'saved');
  assert.equal(result.sources.find(s => s.path === 'server/main.cjs').source, 'live');
  assert.equal(result.sources.find(s => s.path === 'README.md').source, 'saved');
  assert.deepEqual(new Map(result.files.map(item => [item.path, item.sha256])), f.original);
  assert.deepEqual(new Map(tree(f.destination).map(item => [item.path, item.sha256])), f.original);
  assert.deepEqual(f.originalState(), before);
  assert(result.oldManifestBytes.equals(fs.readFileSync(path.join(f.program, 'release-manifest.json'))));
  assert(result.dataSnapshotFiles.some(item => item.path === 'workboard.sqlite'));
});

test('新destination可预建为空，非空快照与部分旧尝试绝不覆盖', t => {
  const f = fixture(t); fs.mkdirSync(f.destination, { recursive: true });
  reconstructLegacy(f.request);
  const before = tree(f.destination); assert.throws(() => reconstructLegacy(f.request), /不是空目录/); assert.deepEqual(tree(f.destination), before);
});

test('saved内容冲突即使live仍有正确原件也拒绝，写入前保留现场', t => {
  const f = fixture(t); put(f.saved, 'server/main.cjs', 'unknown saved content');
  const before = f.originalState(); assert.throws(() => reconstructLegacy(f.request), /保留的旧程序.*冲突/);
  assert(!fs.existsSync(f.destination)); assert.deepEqual(f.originalState(), before);
});

test('live未知修改即使saved完整也拒绝，不猜测覆盖用户修改', t => {
  const f = fixture(t); put(f.program, 'README.md', 'unknown local modification');
  const before = f.originalState(); assert.throws(() => reconstructLegacy(f.request), /现场程序.*冲突/); assert(!fs.existsSync(f.destination)); assert.deepEqual(f.originalState(), before);
});

test('只找到新版本内容不能当作旧原件，缺失旧文件即拒绝', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.saved, 'server/00-before.cjs')); put(f.program, 'server/00-before.cjs', fs.readFileSync(path.join(f.incoming, 'server/00-before.cjs')));
  assert.throws(() => reconstructLegacy(f.request), /无法凑齐完整旧程序原件/); assert(!fs.existsSync(f.destination));
});

test('同版旧manifest原始字节冲突拒绝，不能凭相同version二选一', t => {
  const f = fixture(t); put(f.saved, 'release-manifest.json', JSON.stringify(f.old));
  assert.throws(() => reconstructLegacy(f.request), /同版旧发行清单内容冲突/); assert(!fs.existsSync(f.destination));
});

test('目标包完整清单、身份和旧metadata SHA必须分别吻合', t => {
  const cases = [
    f => put(f.incoming, 'server/main.cjs', 'altered incoming'),
    f => put(f.incoming, 'unknown.txt', 'extra'),
    f => { f.request.expectedSha256 = '2'.repeat(64); },
    f => { f.metadata.toVersion = '0.3.4'; f.saveMetadata(); },
  ];
  for (const mutate of cases) { const f = fixture(t); mutate(f); assert.throws(() => reconstructLegacy(f.request)); assert(!fs.existsSync(f.destination)); }
});

test('旧metadata不靠moved补齐；未知条目、错误绑定和schema2拒绝', t => {
  const cases = [
    f => { f.metadata.moved.push('credentials.dpapi.json'); f.saveMetadata(); },
    f => { f.metadata.port = 18342; f.saveMetadata(); },
    f => { f.metadata.dataDir = f.base; f.saveMetadata(); },
    f => { f.metadata.schema = 2; f.saveMetadata(); },
  ];
  for (const mutate of cases) { const f = fixture(t); mutate(f); assert.throws(() => reconstructLegacy(f.request)); assert(!fs.existsSync(f.destination)); }
});

test('旧数据快照限DataDir/backups且必须为真实SQLite header', t => {
  const cases = [
    f => { f.metadata.dataBackupDir = path.join(f.base, 'foreign'); fs.mkdirSync(f.metadata.dataBackupDir); fs.copyFileSync(path.join(f.snapshot, 'workboard.sqlite'), path.join(f.metadata.dataBackupDir, 'workboard.sqlite')); f.saveMetadata(); },
    f => put(f.snapshot, 'workboard.sqlite', 'not sqlite'),
  ];
  for (const mutate of cases) { const f = fixture(t); mutate(f); assert.throws(() => reconstructLegacy(f.request), /旧数据快照|旧数据库/); assert(!fs.existsSync(f.destination)); }
});

test('现场和saved未知额外程序文件均拒绝，普通维护根目录不被当作程序', t => {
  for (const location of ['program', 'saved']) { const f = fixture(t); put(f[location], 'server/unknown.cjs', 'not attested'); assert.throws(() => reconstructLegacy(f.request), /未知文件/); assert(!fs.existsSync(f.destination)); }
  const f = fixture(t); put(f.program, '.workboard-updates/unrelated/log.txt', 'retained evidence'); reconstructLegacy(f.request); assert(fs.existsSync(path.join(f.program, '.workboard-updates/unrelated/log.txt')));
});

test('目的目录和incoming必须在指定维护边界，不能写回旧现场或资料目录', t => {
  const cases = [
    f => { f.request.destinationDir = path.join(f.previous, 'program'); },
    f => { f.request.destinationDir = path.join(f.data, 'program'); },
    f => { f.request.incomingDir = f.base; },
    f => { f.request.previousDir = f.base; },
  ];
  for (const mutate of cases) { const f = fixture(t); const before = f.originalState(); mutate(f); assert.throws(() => reconstructLegacy(f.request)); assert.deepEqual(f.originalState(), before); }
});

test('目录联接不能绕过source、数据快照或destination边界', t => {
  const f = fixture(t), target = path.join(f.base, 'unrelated'); fs.mkdirSync(target);
  const link = path.join(f.program, 'server', 'linked'); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => reconstructLegacy(f.request), /链接|联接/); assert(!fs.existsSync(f.destination));
});

test('旧清单BOM和排版逐字节保存而非重新序列化', t => {
  const f = fixture(t), file = path.join(f.program, 'release-manifest.json');
  fs.writeFileSync(file, '\ufeff' + fs.readFileSync(file, 'utf8'));
  const original = fs.readFileSync(file), result = reconstructLegacy(f.request);
  assert(result.oldManifestBytes.equals(original)); assert(fs.readFileSync(path.join(f.destination, 'release-manifest.json')).equals(original));
});

test('现场顶层程序目录或文件的大小写别名不能隐藏在scope枚举中', t => {
  const f = fixture(t), original = path.join(f.program, 'README.md'), temporary = path.join(f.program, 'renaming-readme');
  fs.renameSync(original, temporary); fs.renameSync(temporary, path.join(f.program, 'readme.md'));
  assert.throws(() => reconstructLegacy(f.request), /大小写别名/); assert(!fs.existsSync(f.destination));
});
