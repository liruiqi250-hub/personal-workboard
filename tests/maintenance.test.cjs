'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const engine = require('../scripts/maintenance-engine.cjs');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const json = (file, data) => write(file, JSON.stringify(data, null, 2) + '\n');
const clone = value => JSON.parse(JSON.stringify(value));
const engineFile = path.resolve(__dirname, '../scripts/maintenance-engine.cjs');
function cliEnvironment(extra = {}) {
  const env = { ...process.env }; delete env.BOARD_MAINTENANCE_TEST; delete env.BOARD_MAINTENANCE_TEST_HOOK_FILE;
  return { ...env, ...extra };
}
function cli(action, requestFile, outputFile) {
  return spawnSync(process.execPath, [engineFile, action, '--request', requestFile, '--output', outputFile], {
    windowsHide: true, shell: false, encoding: 'utf8', timeout: 30000, env: cliEnvironment(),
  });
}

function makeProgram(dir, version) {
  const content = {
    'package.json': JSON.stringify({ name: 'personal-workboard', version }),
    'package-lock.json': JSON.stringify({ name: 'personal-workboard', version, lockfileVersion: 3, packages: {} }),
    'dist/index.html': '<!doctype html><title>合成维护测试 ' + version + '</title>',
    'server/a.cjs': 'module.exports = ' + JSON.stringify('a-' + version) + ';\n',
    'server/main.cjs': 'module.exports = ' + JSON.stringify('main-' + version) + ';\n',
    'server/z.cjs': 'module.exports = ' + JSON.stringify('z-' + version) + ';\n',
    'scripts/start.ps1': '# 合成测试占位，不执行 ' + version + '\n',
    'scripts/common.ps1': '# 合成测试占位，不执行 ' + version + '\n',
    'scripts/stop.ps1': '# 合成测试占位，不执行 ' + version + '\n',
    'scripts/update.ps1': '# 合成测试占位，不执行 ' + version + '\n',
    'scripts/rollback.ps1': '# 合成测试占位，不执行 ' + version + '\n',
    'vendor/node/node.exe': 'synthetic placeholder, never executed',
    'vendor/node/LICENSE': 'synthetic fixture; no runtime redistribution',
    'README.md': '合成维护测试 ' + version + '\n',
  };
  for (const [file, bytes] of Object.entries(content)) write(path.join(dir, file), bytes);
  const files = Object.keys(content).sort().map(file => ({ path: file, sha256: sha(path.join(dir, file)) }));
  json(path.join(dir, 'release-manifest.json'), { schema: 1, name: 'personal-workboard', version, kind: 'deployment', platform: 'win32-x64', files });
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-maintenance-unit-'));
  const programDir = path.join(base, 'program'), dataDir = path.join(base, 'data');
  fs.mkdirSync(programDir); fs.mkdirSync(dataDir);
  makeProgram(programDir, '0.3.2');
  const incomingDir = path.join(programDir, '.workboard-updates', 'synthetic-incoming');
  makeProgram(incomingDir, '0.3.3');
  const database = new DatabaseSync(path.join(dataDir, 'workboard.sqlite'));
  database.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT); INSERT INTO tasks VALUES(\'before\',\'合成升级前任务\')'); database.close();
  write(path.join(dataDir, 'credentials.dpapi.json'), '{"fixture":true}\n');
  const dataSnapshot = path.join(dataDir, 'backups', 'before-update-fixture');
  fs.mkdirSync(dataSnapshot, { recursive: true });
  fs.copyFileSync(path.join(dataDir, 'workboard.sqlite'), path.join(dataSnapshot, 'workboard.sqlite'));
  fs.copyFileSync(path.join(dataDir, 'credentials.dpapi.json'), path.join(dataSnapshot, 'credentials.dpapi.json'));
  const request = { programDir, incomingDir, dataDir, dataSnapshot, port: 19373,
    expectedSha256: crypto.createHash('sha256').update('synthetic ZIP identity').digest('hex'), expectedVersion: '0.3.3', previewUpdateTest: false };
  const original = engine.inventory(programDir, { scope: 'program' });
  t.after(() => {
    // 仅本测试mkdtemp产生的目录；与真实程序/数据没有交集。
    const relative = path.relative(os.tmpdir(), base);
    assert(relative.startsWith('workboard-maintenance-unit-') && !relative.includes(path.sep));
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, programDir, incomingDir, dataDir, dataSnapshot, request, original,
    async prepare() { const result = await engine.run('prepare-update', request); return { ...request, previousDir: result.previousDir }; } };
}
function setTestHook(t, f, point, relative, action = 'fail-once') {
  const hook = path.join(f.base, 'hook.json');
  json(hook, { schema: 1, point, path: relative, action, release: false });
  const priorEnabled = process.env.BOARD_MAINTENANCE_TEST, priorHook = process.env.BOARD_MAINTENANCE_TEST_HOOK_FILE;
  process.env.BOARD_MAINTENANCE_TEST = '1'; process.env.BOARD_MAINTENANCE_TEST_HOOK_FILE = hook;
  t.after(() => {
    if (priorEnabled === undefined) delete process.env.BOARD_MAINTENANCE_TEST; else process.env.BOARD_MAINTENANCE_TEST = priorEnabled;
    if (priorHook === undefined) delete process.env.BOARD_MAINTENANCE_TEST_HOOK_FILE; else process.env.BOARD_MAINTENANCE_TEST_HOOK_FILE = priorHook;
  });
  return hook;
}

test('维护包检查逐文件hash、版本、额外程序文件和大小写重复路径均严格拒绝', async t => {
  const f = fixture(t), manifestFile = path.join(f.incomingDir, 'release-manifest.json'), original = read(manifestFile);
  assert.equal((await engine.run('inspect-package', { incomingDir: f.incomingDir, expectedVersion: '0.3.3' })).version, '0.3.3');
  await assert.rejects(engine.run('inspect-package', { incomingDir: f.incomingDir, expectedVersion: '0.3.4' }));
  const mainFile = path.join(f.incomingDir, 'server/main.cjs'), mainBytes = fs.readFileSync(mainFile);
  fs.appendFileSync(mainFile, 'unknown bytes');
  await assert.rejects(engine.run('inspect-package', { incomingDir: f.incomingDir }));
  fs.writeFileSync(mainFile, mainBytes);
  const extra = path.join(f.incomingDir, 'server/unknown.cjs'); write(extra, 'unknown');
  await assert.rejects(engine.run('inspect-package', { incomingDir: f.incomingDir })); fs.unlinkSync(extra);
  const duplicate = clone(original); duplicate.files.push({ path: 'SERVER/main.cjs', sha256: sha(mainFile) }); json(manifestFile, duplicate);
  await assert.rejects(engine.run('inspect-package', { incomingDir: f.incomingDir }));
  json(manifestFile, original);
  assert.deepEqual(engine.inventory(f.programDir, { scope: 'program' }), f.original);
});

test('prepare建立完整旧副本、数据密封和独立新stage，准备失败不替换当前文件', async t => {
  const f = fixture(t), request = await f.prepare(), meta = read(path.join(request.previousDir, 'update-metadata.json'));
  assert.equal(meta.schema, 2); assert.equal(meta.state, 'prepared');
  assert.deepEqual(engine.inventory(f.programDir, { scope: 'program' }), f.original);
  assert.deepEqual(engine.inventory(path.join(request.previousDir, 'program')), f.original);
  assert.deepEqual(engine.inventory(path.join(request.previousDir, 'stage')), engine.inventory(f.incomingDir));
  assert.equal(sha(path.join(meta.dataSnapshot.root, 'workboard.sqlite')), sha(path.join(f.dataSnapshot, 'workboard.sqlite')));
  const before = engine.inventory(f.programDir, { scope: 'program' });
  fs.appendFileSync(path.join(f.programDir, 'server/a.cjs'), 'unknown');
  await assert.rejects(engine.run('prepare-update', f.request));
  assert.equal(sha(path.join(f.programDir, 'server/main.cjs')), before.find(file => file.path === 'server/main.cjs').sha256);
});

test('动作完成记账前one-shot失败保留完整快照，随后rollback不依赖成功列表恢复', async t => {
  const f = fixture(t), request = await f.prepare();
  const hook = setTestHook(t, f, 'update.after-install', 'server/a.cjs');
  await assert.rejects(engine.run('apply-update', request));
  const observed = read(hook); assert.equal(observed.consumed, true); assert.equal(observed.observed.path, 'server/a.cjs');
  assert.equal(sha(path.join(f.programDir, 'server/a.cjs')), sha(path.join(f.incomingDir, 'server/a.cjs')));
  assert.deepEqual(engine.inventory(path.join(request.previousDir, 'program')), f.original);
  assert.deepEqual(engine.inventory(path.join(request.previousDir, 'stage')), engine.inventory(f.incomingDir));
  assert.equal(read(path.join(request.previousDir, 'update-metadata.json')).state, 'needs-rollback');
  await engine.run('prepare-rollback', request); await engine.run('apply-rollback', request);
  assert.deepEqual(engine.inventory(f.programDir, { scope: 'program' }), f.original);
});

test('更新原件已移至quarantine但未记账时，重试能完成且旧stage不消费', async t => {
  const f = fixture(t), request = await f.prepare();
  setTestHook(t, f, 'update.after-displace', 'server/a.cjs');
  await assert.rejects(engine.run('apply-update', request));
  assert.equal(fs.existsSync(path.join(f.programDir, 'server/a.cjs')), false);
  await engine.run('apply-update', request);
  assert.deepEqual(engine.inventory(f.programDir, { scope: 'program' }), engine.inventory(f.incomingDir));
  assert.deepEqual(engine.inventory(path.join(request.previousDir, 'program')), f.original);
});

test('未知当前内容拒绝rollback并保留冲突与完整旧快照', async t => {
  const f = fixture(t), request = await f.prepare(); await engine.run('apply-update', request);
  const conflict = path.join(f.programDir, 'server/main.cjs'); fs.appendFileSync(conflict, 'unknown'); const conflictHash = sha(conflict);
  const snapshot = engine.inventory(path.join(request.previousDir, 'program'));
  await assert.rejects(engine.run('prepare-rollback', request));
  assert.equal(sha(conflict), conflictHash);
  assert.deepEqual(engine.inventory(path.join(request.previousDir, 'program')), snapshot);
  assert.equal(read(path.join(request.previousDir, 'update-metadata.json')).beforeRollback, undefined);
});

test('正常schema2事务缺失旧程序文件且无写前日志证据时拒绝，其他文件原样保留', async t => {
  const f = fixture(t), request = await f.prepare();
  fs.unlinkSync(path.join(f.programDir, 'server/a.cjs'));
  const remaining = engine.inventory(f.programDir, { scope: 'program' });
  await assert.rejects(engine.run('apply-update', request));
  assert.deepEqual(engine.inventory(f.programDir, { scope: 'program' }), remaining);
  assert.deepEqual(engine.inventory(path.join(request.previousDir, 'program')), f.original);
  const journal = path.join(request.previousDir, 'journal');
  if (fs.existsSync(journal)) assert.deepEqual(fs.readdirSync(journal), []);
});

test('rollback动作后失败再重试复用首次程序/数据库快照，升级后新增任务仍可读', async t => {
  const f = fixture(t), request = await f.prepare(); await engine.run('apply-update', request);
  const currentDb = new DatabaseSync(path.join(f.dataDir, 'workboard.sqlite'));
  currentDb.exec("INSERT INTO tasks VALUES('after','合成升级后新增')"); currentDb.close();
  const prepared = await engine.run('prepare-rollback', request), firstHash = sha(path.join(prepared.beforeRollbackDataDir, 'workboard.sqlite'));
  const hook = setTestHook(t, f, 'rollback.after-install', 'server/a.cjs');
  await assert.rejects(engine.run('apply-rollback', request));
  assert.equal(read(hook).consumed, true);
  const again = await engine.run('prepare-rollback', request); assert.equal(again.beforeRollbackDataDir, prepared.beforeRollbackDataDir);
  assert.equal(sha(path.join(again.beforeRollbackDataDir, 'workboard.sqlite')), firstHash);
  await engine.run('apply-rollback', request);
  assert.deepEqual(engine.inventory(f.programDir, { scope: 'program' }), f.original);
  const beforeDb = new DatabaseSync(path.join(prepared.beforeRollbackDataDir, 'workboard.sqlite'), { readOnly: true });
  try { assert(beforeDb.prepare("SELECT id FROM tasks WHERE id='after'").get()); } finally { beforeDb.close(); }
  const restoredDb = new DatabaseSync(path.join(f.dataDir, 'workboard.sqlite'), { readOnly: true });
  try { assert.equal(restoredDb.prepare("SELECT id FROM tasks WHERE id='after'").get(), undefined); } finally { restoredDb.close(); }
  assert.equal(sha(path.join(prepared.beforeRollbackDataDir, 'workboard.sqlite')), firstHash);
});

test('数据库动作完成记账前失败仍可恢复，旧快照没有的当前凭据另存证据后移出', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.dataSnapshot, 'credentials.dpapi.json'));
  const request = await f.prepare(); await engine.run('apply-update', request);
  const currentDb = new DatabaseSync(path.join(f.dataDir, 'workboard.sqlite')); currentDb.exec("INSERT INTO tasks VALUES('after','合成新增')"); currentDb.close();
  const prepared = await engine.run('prepare-rollback', request);
  setTestHook(t, f, 'data.after-install', 'workboard.sqlite');
  await assert.rejects(engine.run('apply-rollback', request));
  await engine.run('prepare-rollback', request); await engine.run('apply-rollback', request);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'credentials.dpapi.json')), false);
  assert(fs.existsSync(path.join(prepared.beforeRollbackDataDir, 'credentials.dpapi.json')));
  assert.equal(sha(path.join(f.dataDir, 'workboard.sqlite')), sha(path.join(f.dataSnapshot, 'workboard.sqlite')));
});

test('维护故障hook缺双门、主端口或放在程序目录均拒绝且不替换', async t => {
  const f = fixture(t), request = await f.prepare();
  const oldEnabled = process.env.BOARD_MAINTENANCE_TEST, oldHook = process.env.BOARD_MAINTENANCE_TEST_HOOK_FILE;
  t.after(() => { if (oldEnabled === undefined) delete process.env.BOARD_MAINTENANCE_TEST; else process.env.BOARD_MAINTENANCE_TEST = oldEnabled; if (oldHook === undefined) delete process.env.BOARD_MAINTENANCE_TEST_HOOK_FILE; else process.env.BOARD_MAINTENANCE_TEST_HOOK_FILE = oldHook; });
  process.env.BOARD_MAINTENANCE_TEST = '1'; delete process.env.BOARD_MAINTENANCE_TEST_HOOK_FILE;
  await assert.rejects(engine.run('apply-update', request));
  const hook = path.join(f.base, 'valid-hook.json'); json(hook, { schema: 1, point: 'update.before-displace', action: 'fail-once' });
  process.env.BOARD_MAINTENANCE_TEST_HOOK_FILE = hook;
  await assert.rejects(engine.run('prepare-update', { ...f.request, port: 18327 }));
  process.env.BOARD_MAINTENANCE_TEST_HOOK_FILE = path.join(f.programDir, '.workboard-updates/hook.json');
  json(process.env.BOARD_MAINTENANCE_TEST_HOOK_FILE, { schema: 1, point: 'update.before-displace', action: 'fail-once' });
  await assert.rejects(engine.run('apply-update', request));
  assert.deepEqual(engine.inventory(f.programDir, { scope: 'program' }), f.original);
});

test('维护目录路径链接、数据/程序嵌套和snapshot越界在复制替换前拒绝', async t => {
  const f = fixture(t);
  await assert.rejects(engine.run('prepare-update', { ...f.request, dataDir: path.join(f.programDir, 'private-data') }));
  await assert.rejects(engine.run('prepare-update', { ...f.request, dataSnapshot: f.programDir }));
  const outside = path.join(f.base, 'outside-stage'); makeProgram(outside, '0.3.3');
  await assert.rejects(engine.run('prepare-update', { ...f.request, incomingDir: outside }));
  if (process.platform === 'win32') {
    const link = path.join(f.base, 'stage-junction'); fs.symlinkSync(f.incomingDir, link, 'junction');
    await assert.rejects(engine.run('inspect-package', { incomingDir: link }));
  }
  assert.deepEqual(engine.inventory(f.programDir, { scope: 'program' }), f.original);
});

test('维护CLI输出指向尚未安装的新程序文件时动作前拒绝且metadata不变', async t => {
  const f = fixture(t), request = await f.prepare(), requestFile = path.join(f.base, 'request.json'); json(requestFile, request);
  const metadata = path.join(request.previousDir, 'update-metadata.json'), metaHash = sha(metadata);
  const outputFile = path.join(f.programDir, 'server/new-module.cjs');
  const result = cli('apply-update', requestFile, outputFile);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(outputFile), false);
  assert.deepEqual(engine.inventory(f.programDir, { scope: 'program' }), f.original);
  assert.equal(sha(metadata), metaHash);
});

test('维护CLI输出不得进入incoming/data/previous/dataSnapshot保护树', async t => {
  const f = fixture(t), request = await f.prepare(), requestFile = path.join(f.base, 'request.json'); json(requestFile, request);
  const metadata = path.join(request.previousDir, 'update-metadata.json'), metaHash = sha(metadata);
  for (const directory of [f.incomingDir, f.dataDir, request.previousDir, f.dataSnapshot]) {
    const outputFile = path.join(directory, 'unexpected-output.json');
    const result = cli('apply-update', requestFile, outputFile);
    assert.equal(result.status, 1, directory + ': ' + result.stderr);
    assert.equal(fs.existsSync(outputFile), false);
    assert.equal(sha(metadata), metaHash);
    assert.deepEqual(engine.inventory(f.programDir, { scope: 'program' }), f.original);
  }
});

test('维护CLI合法外部全新回执成功，程序与保留stage逐文件一致', async t => {
  const f = fixture(t), request = await f.prepare(), requestFile = path.join(f.base, 'request.json'); json(requestFile, request);
  const outputFile = path.join(f.base, 'external-receipts', 'result.json');
  const result = cli('apply-update', requestFile, outputFile);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(outputFile).state, 'installed');
  assert.deepEqual(engine.inventory(f.programDir, { scope: 'program' }), engine.inventory(f.incomingDir));
  assert.deepEqual(engine.inventory(path.join(request.previousDir, 'program')), f.original);
});

test('维护CLI仅允许controller runner同目录且同编号request/response，错号动作前拒绝', async t => {
  const f = fixture(t), request = await f.prepare();
  const runner = path.join(f.programDir, '.workboard-updates', 'controller-cli-fixture', 'runner');
  const requestFile = path.join(runner, 'request-1.json'), outputFile = path.join(runner, 'response-1.json'); json(requestFile, request);
  const result = cli('apply-update', requestFile, outputFile);
  assert.equal(result.status, 0, result.stderr); assert.equal(read(outputFile).state, 'installed');
  const g = fixture(t), other = await g.prepare();
  const otherRunner = path.join(g.programDir, '.workboard-updates', 'controller-cli-fixture', 'runner');
  const otherRequest = path.join(otherRunner, 'request-1.json'), wrongOutput = path.join(otherRunner, 'response-2.json'); json(otherRequest, other);
  const metadata = path.join(other.previousDir, 'update-metadata.json'), metaHash = sha(metadata);
  const rejected = cli('apply-update', otherRequest, wrongOutput);
  assert.equal(rejected.status, 1, rejected.stderr); assert.equal(fs.existsSync(wrongOutput), false);
  assert.equal(sha(metadata), metaHash); assert.deepEqual(engine.inventory(g.programDir, { scope: 'program' }), g.original);
});

test('维护CLI运行期间外部输出被创建时最终拒绝且保留原回执内容', async t => {
  const f = fixture(t), request = await f.prepare(), requestFile = path.join(f.base, 'request.json'); json(requestFile, request);
  const hook = path.join(f.base, 'pause-hook.json'), outputFile = path.join(f.base, 'external-result.json');
  json(hook, { schema: 1, point: 'update.after-install', path: 'server/a.cjs', action: 'pause', release: false });
  const child = spawn(process.execPath, [engineFile, 'apply-update', '--request', requestFile, '--output', outputFile], {
    windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore'],
    env: cliEnvironment({ BOARD_MAINTENANCE_TEST: '1', BOARD_MAINTENANCE_TEST_HOOK_FILE: hook }),
  });
  const closed = new Promise((resolve, reject) => { child.once('exit', code => resolve(code)); child.once('error', reject); });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const deadline = Date.now() + 15000; let observed;
    while (Date.now() < deadline && child.exitCode === null) { const value = read(hook); if (value.observed) { observed = value; break; } await sleep(25); }
    assert(observed, '自建CLI未进入受门控pause hook');
    fs.writeFileSync(outputFile, 'created-during-run; preserve exactly\n', { flag: 'wx' }); const sentinelHash = sha(outputFile);
    json(hook, { ...observed, release: true });
    assert.equal(await closed, 1);
    assert.equal(sha(outputFile), sentinelHash);
    assert.deepEqual(engine.inventory(f.programDir, { scope: 'program' }), engine.inventory(f.incomingDir));
    assert.deepEqual(engine.inventory(path.join(request.previousDir, 'program')), f.original);
  } finally {
    if (child.exitCode === null) { child.kill(); await closed; }
  }
});
