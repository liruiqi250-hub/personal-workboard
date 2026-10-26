#!/usr/bin/env node
'use strict';
// Standalone runner: builtins only. Immutable snapshots are copied, never moved.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const PROGRAM_ENTRIES = ['dist','server','scripts','src','public','tests','node_modules','vendor/node','docs/INSTALL_FOR_CODEX.md','docs/RELEASE_FOR_CODEX.md','.gitignore','README.md','AGENTS.md','CHANGELOG.md','package.json','package-lock.json','index.html','vite.config.mjs','release-manifest.json'];
const DATA_FILES = ['workboard.sqlite','workboard.sqlite-wal','workboard.sqlite-shm','credentials.dpapi.json','restore-next-start.sqlite'];
const DATA_EXCLUDED = new Set(['backups','logs','print','service.json']);
const HEX = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw Error('无法检查维护文件'); } };
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function within(root, file, allowEqual = false) { const relative = path.relative(root, file); return allowEqual && relative === '' || relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
function requireWithin(root, file) { if (!within(root, file)) throw Error('维护路径超出预期边界'); return file; }
function checkedPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw Error('维护路径必须为绝对路径');
  if (process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(value) || value.slice(2).includes(':'))) throw Error('维护路径拒绝 UNC 或设备命名空间');
  const resolved = path.resolve(value); const parsed = path.parse(resolved); const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  if (parts.some(part => /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw Error('维护路径包含设备名或别名');
  let current = parsed.root;
  function canonical(ancestor) {
    let actual; try { actual = fs.realpathSync.native(ancestor); } catch { throw Error('维护真实路径不可用'); }
    if (process.platform === 'win32') actual = actual.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '');
    if (process.platform === 'win32' && !/^[A-Za-z]:\\/.test(actual)) throw Error('维护真实路径不是本机路径');
    return path.resolve(actual);
  }
  for (const [index, part] of parts.entries()) {
    const parent = current;
    current = path.join(current, part);
    if (!exists(current)) return path.join(canonical(parent), ...parts.slice(index));
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory()) throw Error('维护路径拒绝链接、联接或类型冲突');
  }
  return canonical(current);
}
function relativeName(name) {
  if (typeof name !== 'string' || name.length > 1024 || name.includes('\\') || name.includes(':') || name.startsWith('/') || name.includes('\0') || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw Error('维护清单含非法路径');
  return name;
}
function inProgramScope(name) { return PROGRAM_ENTRIES.some(entry => name === entry || name.startsWith(entry + '/')); }
function hashFile(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(descriptor); if (!before.isFile()) throw Error('维护文件类型无效');
    const hash = crypto.createHash('sha256'); const chunk = Buffer.alloc(1024 * 1024); let count; let size = 0;
    while ((count = fs.readSync(descriptor, chunk, 0, chunk.length, size)) > 0) { size += count; hash.update(chunk.subarray(0, count)); }
    const after = fs.fstatSync(descriptor); const current = fs.lstatSync(file);
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== current.ino || before.dev !== current.dev || current.isSymbolicLink()) throw Error('维护读取期间文件已改变');
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}
function sha256(value) { return hashFile(checkedPath(value)); }
function fileInfo(file, name) { const actual = checkedPath(file); const stat = fs.lstatSync(actual); if (!stat.isFile()) throw Error('维护目标必须是普通文件'); return { path: relativeName(name), sha256: hashFile(actual), size: stat.size }; }
function inventory(root, options = {}) {
  root = checkedPath(root); if (!fs.statSync(root).isDirectory()) throw Error('维护目录不存在');
  const files = []; const names = new Set();
  function visit(name) {
    relativeName(name); const file = requireWithin(root, path.join(root, name));
    const key = name.toLowerCase(); if (names.has(key)) throw Error('快照包含大小写重复路径'); names.add(key);
    const stat = fs.lstatSync(file); if (stat.isSymbolicLink()) throw Error('快照不接受链接');
    if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) visit(name + '/' + child);
    else {
      if (!stat.isFile()) throw Error('快照包含不支持的文件类型');
      files.push({ path: name, sha256: hashFile(file), size: stat.size });
    }
  }
  if (options.scope === 'program') {
    for (const entry of PROGRAM_ENTRIES) {
      let parent = root;
      for (const part of entry.split('/')) {
        if (!exists(parent)) break;
        const aliases = fs.readdirSync(parent).filter(name => name.toLowerCase() === part.toLowerCase());
        if (aliases.length > 1 || aliases.length === 1 && aliases[0] !== part) throw Error('现程序作用域存在大小写别名');
        parent = path.join(parent, part);
      }
      if (exists(path.join(root, entry))) visit(entry);
    }
  }
  else for (const entry of fs.readdirSync(root).sort()) if (!options.exclude?.has(entry.toLowerCase())) visit(entry);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function readJson(file, limit = 16 * 1024 * 1024) {
  file = checkedPath(file); const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size < 2 || stat.size > limit) throw Error('维护 JSON 文件大小或类型无效');
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; } catch { throw Error('维护 JSON 格式无效，未输出文件正文'); }
}
function atomicJson(file, value) {
  file = checkedPath(file); fs.mkdirSync(path.dirname(file), { recursive: true }); checkedPath(path.dirname(file));
  const temp = checkedPath(file + '.tmp-' + crypto.randomUUID()); const descriptor = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  checkedPath(file); fs.renameSync(temp, file);
}
function fileListSeal(files) { return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'); }
function validateFiles(files) {
  if (!Array.isArray(files) || files.length > 100000) throw Error('快照清单格式无效'); const seen = new Set();
  for (const file of files) { relativeName(file.path); const key = file.path.toLowerCase(); if (seen.has(key) || !HEX.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw Error('快照清单包含重复路径或无效哈希'); seen.add(key); }
  return files;
}
function compareFiles(actual, expected) {
  validateFiles(expected); const wanted = new Map(expected.map(file => [file.path, file]));
  if (actual.length !== expected.length || actual.some(file => { const next = wanted.get(file.path); return !next || next.sha256 !== file.sha256 || next.size !== file.size; })) throw Error('完整快照逐文件校验失败，未开始替换');
}
function makeSeal(root, files) { return { root: checkedPath(root), files: validateFiles(files), digest: fileListSeal(files) }; }
function verifySeal(seal, options = {}) {
  if (!seal || seal.digest !== fileListSeal(validateFiles(seal.files))) throw Error('快照密封清单损坏');
  compareFiles(inventory(seal.root, options), seal.files); return seal;
}
function readManifest(root, { expectedVersion, scope = 'all' } = {}) {
  root = checkedPath(root); const manifestFile = path.join(root, 'release-manifest.json'); const manifest = readJson(manifestFile);
  if (manifest.schema !== 1 || manifest.name !== 'personal-workboard' || manifest.kind !== 'deployment' || manifest.platform !== 'win32-x64' || !VERSION.test(manifest.version) || expectedVersion && manifest.version !== expectedVersion || !Array.isArray(manifest.files)) throw Error('部署包名称、版本、平台或类型无效');
  const listed = validateFiles(manifest.files.map(entry => {
    const file = requireWithin(root, checkedPath(path.join(root, relativeName(entry.path))));
    return { path: entry.path, sha256: entry.sha256, size: fs.lstatSync(file).size };
  }));
  if (listed.some(file => file.path === 'release-manifest.json' || !inProgramScope(file.path))) throw Error('部署清单包含不允许的程序路径');
  const files = [...listed, fileInfo(manifestFile, 'release-manifest.json')].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const required of ['package.json','package-lock.json','dist/index.html','server/main.cjs','scripts/common.ps1','scripts/start.ps1','scripts/stop.ps1','scripts/update.ps1','scripts/rollback.ps1','vendor/node/node.exe','vendor/node/LICENSE']) if (!files.some(file => file.path === required)) throw Error('部署包缺少启动或维护核心文件');
  compareFiles(inventory(root, scope === 'program' ? { scope: 'program' } : {}), files);
  const pkg = readJson(path.join(root, 'package.json'), 256 * 1024); if (pkg.name !== 'personal-workboard' || pkg.version !== manifest.version) throw Error('程序 package 与发行版本不一致');
  return { version: manifest.version, manifest, manifestBytes: fs.readFileSync(manifestFile), manifestSha256: sha256(manifestFile), files };
}
function copyFileVerified(source, destination, expected) {
  source = checkedPath(source); destination = checkedPath(destination);
  const stat = fs.lstatSync(source); const digest = hashFile(source); const required = typeof expected === 'string' ? { sha256: expected, size: stat.size } : expected || { sha256: digest, size: stat.size };
  if (required.sha256 !== digest || required.size !== undefined && required.size !== stat.size) throw Error('复制前源文件与快照不一致');
  fs.mkdirSync(path.dirname(destination), { recursive: true }); checkedPath(path.dirname(destination));
  if (exists(destination)) { if (hashFile(destination) !== digest || fs.statSync(destination).size !== stat.size) throw Error('快照目标已存在不同内容'); return; }
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  const descriptor = fs.openSync(destination, 'r+'); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  if (hashFile(destination) !== digest || fs.statSync(destination).size !== stat.size || hashFile(source) !== digest) throw Error('复制后文件校验失败');
}
function copyInventory(source, destination, files) { fs.mkdirSync(checkedPath(destination), { recursive: true }); for (const file of files) copyFileVerified(path.join(source, file.path), path.join(destination, file.path), file); compareFiles(inventory(destination), files); }
function sqliteHeader(dir) {
  const file = checkedPath(path.join(dir, 'workboard.sqlite')); const descriptor = fs.openSync(file, 'r');
  try { const bytes = Buffer.alloc(16); if (fs.readSync(descriptor, bytes, 0, 16, 0) !== 16 || bytes.toString('binary') !== 'SQLite format 3\0') throw Error('数据库快照缺少有效 SQLite 文件头'); } finally { fs.closeSync(descriptor); }
}
function greater(a, b) { const left = a.split('.').map(Number); const right = b.split('.').map(Number); for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index]; return false; }
function context(request) {
  const programDir = checkedPath(request.programDir); const dataDir = checkedPath(request.dataDir); const port = request.port;
  if (programDir === path.parse(programDir).root || dataDir === path.parse(dataDir).root || within(programDir, dataDir, true) || within(dataDir, programDir, true) || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('程序、数据目录或端口边界无效');
  if (!fs.statSync(programDir).isDirectory() || !fs.statSync(dataDir).isDirectory()) throw Error('维护目录必须已存在');
  return { programDir, dataDir, port };
}
function previousPath(ctx, value) { const base = checkedPath(path.join(ctx.programDir, '.workboard-previous')); const target = requireWithin(base, checkedPath(value)); if (!same(path.dirname(target), base)) throw Error('previous 必须为指定程序维护目录的直接子目录'); return target; }
function dataSnapshotPath(ctx, value) { return requireWithin(checkedPath(path.join(ctx.dataDir, 'backups')), checkedPath(value)); }
function metadataFile(previous) { return path.join(previous, 'update-metadata.json'); }
function saveMeta(previous, meta) { meta.updatedAt = new Date().toISOString(); atomicJson(metadataFile(previous), meta); }
function loadTransaction(request) {
  const ctx = context(request); const previous = previousPath(ctx, request.previousDir); const meta = readJson(metadataFile(previous));
  if (meta.schema !== 2 || !/^[A-Za-z0-9-]+$/.test(meta.id) || !same(meta.programDir, ctx.programDir) || !same(meta.dataDir, ctx.dataDir) || meta.port !== ctx.port || !VERSION.test(meta.fromVersion) || !VERSION.test(meta.toVersion)) throw Error('维护事务绑定不匹配');
  if (!same(checkedPath(meta.programSnapshot.root), path.join(previous, 'program')) || !same(checkedPath(meta.incomingSnapshot.root), path.join(previous, 'stage')) || !same(dataSnapshotPath(ctx, meta.dataSnapshot.root), meta.dataBackupDir)) throw Error('维护快照绑定无效');
  verifySeal(meta.programSnapshot); verifySeal(meta.incomingSnapshot); verifySeal(meta.dataSnapshot); sqliteHeader(meta.dataSnapshot.root);
  for (const [seal, version] of [[meta.programSnapshot, meta.fromVersion], [meta.incomingSnapshot, meta.toVersion]]) {
    if (seal.files.some(file => !inProgramScope(file.path))) throw Error('程序快照包含未知作用域');
    const manifest = readJson(path.join(seal.root, 'release-manifest.json'));
    const pkg = readJson(path.join(seal.root, 'package.json'), 256 * 1024);
    if (manifest.schema !== 1 || manifest.name !== 'personal-workboard' || manifest.version !== version || manifest.kind !== 'deployment' || manifest.platform !== 'win32-x64' || pkg.name !== 'personal-workboard' || pkg.version !== version) throw Error('快照程序身份绑定无效');
  }
  if (meta.beforeRollback && (!same(checkedPath(meta.beforeRollback.program.root), path.join(previous, 'before-rollback', 'program')) || !same(dataSnapshotPath(ctx, meta.beforeRollback.data.root), path.join(ctx.dataDir, 'backups', 'before-rollback-' + meta.id)))) throw Error('首次恢复前快照根绑定无效');
  return { ...ctx, previous, meta };
}
function allowedCurrent(ctx, meta) {
  const known = new Map(); for (const file of [...meta.programSnapshot.files, ...meta.incomingSnapshot.files]) { const key = file.path.toLowerCase(); if (!known.has(key)) known.set(key, { path: file.path, hashes: new Set() }); if (known.get(key).path !== file.path) throw Error('新旧清单存在大小写别名'); known.get(key).hashes.add(file.sha256 + ':' + file.size); }
  const current = inventory(ctx.programDir, { scope: 'program' });
  for (const file of current) { const entry = known.get(file.path.toLowerCase()); if (!entry || entry.path !== file.path || !entry.hashes.has(file.sha256 + ':' + file.size)) throw Error('现程序包含未知内容或额外文件，未替换'); }
  const oldNames = new Set(meta.programSnapshot.files.map(file => file.path));
  const previous = ctx.previous || path.join(ctx.programDir, '.workboard-previous', meta.id);
  for (const entry of known.values()) {
    const file = checkedPath(path.join(ctx.programDir, entry.path));
    if (exists(file)) { if (!fs.lstatSync(file).isFile()) throw Error('程序目标存在类型冲突'); continue; }
    // Absence is valid for not-yet-installed new files, or is backed by a
    // durable displacement/removal intent. Arbitrarily missing old files fail.
    if (!oldNames.has(entry.path) && !['installed','updated'].includes(meta.state)) continue;
    if (meta.legacyPreviousDir && ['needs-rollback','rollback-prepared','rolling-back','rollback-failed'].includes(meta.state) && Array.isArray(meta.legacyAbsentPaths) && meta.legacyAbsentPaths.includes(entry.path)) continue;
    let justified = false;
    for (const phase of ['update','rollback']) {
      const log = journalPath({ ...ctx, previous }, phase, entry.path);
      if (!exists(log)) continue;
      const operation = readJson(log, 65536);
      if (operation.id !== meta.id || operation.phase !== phase || operation.path !== entry.path || operation.state === 'complete' && operation.desiredSha256 !== null) continue;
      if (operation.original) {
        const saved = requireWithin(path.join(previous, 'quarantine', phase), checkedPath(operation.quarantine));
        if (!exists(saved) || sha256(saved) !== operation.original.sha256 || fs.statSync(saved).size !== operation.original.size) continue;
      }
      justified = true;
    }
    if (!justified) throw Error('现程序存在无写前日志依据的缺失文件，未替换');
  }
  return current;
}
function validateTestContext(ctx) {
  const enabled = process.env.BOARD_MAINTENANCE_TEST; const hook = process.env.BOARD_MAINTENANCE_TEST_HOOK_FILE;
  if (!enabled && !hook) return null;
  if (enabled !== '1' || !hook || !ctx) throw Error('维护测试环境缺少显式双门授权');
  const temp = checkedPath(os.tmpdir()); const file = checkedPath(hook);
  if (ctx.port === 18327 || !within(temp, ctx.programDir) || !within(temp, ctx.dataDir) || !within(temp, file) || within(ctx.programDir, file, true) || within(ctx.dataDir, file, true)) throw Error('维护故障注入只允许独立 TEMP 和非默认端口');
  return file;
}
async function hookAt(ctx, point, name) {
  const file = validateTestContext(ctx); if (!file) return;
  const config = readJson(file, 65536);
  if (config.schema !== 1 || !['pause','fail-once'].includes(config.action)) throw Error('维护测试 hook 格式无效');
  if (config.consumed || config.point !== point || config.path && config.path !== name) return;
  config.consumed = true; config.observed = { point, path: name, id: ctx.meta.id, pid: process.pid, at: new Date().toISOString() }; atomicJson(file, config);
  if (config.action === 'fail-once') throw Error('维护测试 one-shot 故障已触发');
  const deadline = Date.now() + 120000;
  while (readJson(file, 65536).release !== true) { if (Date.now() > deadline) throw Error('维护测试暂停等待超时'); await new Promise(resolve => setTimeout(resolve, 25)); }
}
function journalPath(ctx, phase, name) { return path.join(ctx.previous, 'journal', phase + '-' + crypto.createHash('sha256').update(name).digest('hex') + '.json'); }
async function replaceOne(ctx, phase, name, desired, sourceRoot, allowedHash) {
  relativeName(name); const target = requireWithin(phase === 'data' ? ctx.dataDir : ctx.programDir, checkedPath(path.join(phase === 'data' ? ctx.dataDir : ctx.programDir, name)));
  const desiredHash = desired ? desired.sha256 : null;
  if (exists(target) && sha256(target) === desiredHash && fs.statSync(target).size === desired.size) return;
  const journalFile = journalPath(ctx, phase, name); let operation;
  if (exists(journalFile)) operation = readJson(journalFile, 65536);
  else {
    const current = exists(target) ? fileInfo(target, name) : null;
    if (current && allowedHash && !allowedHash.has(current.sha256 + ':' + current.size)) throw Error('替换前目标出现未知内容');
    operation = { schema: 1, id: ctx.meta.id, phase, path: name, desiredSha256: desiredHash, original: current, quarantine: path.join(ctx.previous, 'quarantine', phase, crypto.randomUUID(), name), state: 'intent' };
    atomicJson(journalFile, operation);
  }
  if (operation.id !== ctx.meta.id || operation.phase !== phase || operation.path !== name || operation.desiredSha256 !== desiredHash) throw Error('写前日志绑定不匹配');
  const quarantine = requireWithin(path.join(ctx.previous, 'quarantine', phase), checkedPath(operation.quarantine));
  await hookAt(ctx, phase + '.before-displace', name);
  if (exists(target)) {
    const current = fileInfo(target, name);
    if (allowedHash && !allowedHash.has(current.sha256 + ':' + current.size)) throw Error('替换目标出现未预期内容');
    if (!operation.original || current.sha256 !== operation.original.sha256 || current.size !== operation.original.size || exists(quarantine)) throw Error('原文件与写前日志或证据位置冲突');
    fs.mkdirSync(path.dirname(quarantine), { recursive: true }); checkedPath(path.dirname(quarantine)); fs.renameSync(target, quarantine);
    await hookAt(ctx, phase + '.after-displace', name);
    operation.state = 'displaced'; atomicJson(journalFile, operation);
  } else if (operation.original) {
    if (!exists(quarantine) || sha256(quarantine) !== operation.original.sha256 || fs.statSync(quarantine).size !== operation.original.size) throw Error('写前日志原件缺失，保留现场');
  }
  if (desired) {
    const source = requireWithin(sourceRoot, checkedPath(path.join(sourceRoot, name))); const temporary = checkedPath(path.join(ctx.previous, 'temporary', phase + '-' + crypto.randomUUID()));
    copyFileVerified(source, temporary, desired); fs.mkdirSync(path.dirname(target), { recursive: true }); checkedPath(path.dirname(target));
    if (exists(target)) throw Error('安装目标出现并发冲突'); fs.renameSync(temporary, target);
    await hookAt(ctx, phase + '.after-install', name);
    if (sha256(target) !== desired.sha256 || fs.statSync(target).size !== desired.size) throw Error('安装后文件哈希不符');
  }
  operation.state = 'complete'; atomicJson(journalFile, operation);
}
function knownHashMap(meta) { const result = new Map(); for (const file of [...meta.programSnapshot.files, ...meta.incomingSnapshot.files]) { if (!result.has(file.path)) result.set(file.path, new Set()); result.get(file.path).add(file.sha256 + ':' + file.size); } return result; }
function failureState(ctx, state, message) { ctx.meta.state = state; ctx.meta.lastFailure = { at: new Date().toISOString(), message }; try { saveMeta(ctx.previous, ctx.meta); } catch {} }
function captureData(ctx) { sqliteHeader(ctx.dataDir); return inventory(ctx.dataDir, { exclude: DATA_EXCLUDED }); }
async function prepareUpdate(request) {
  const ctx = context(request); validateTestContext(ctx);
  const incoming = requireWithin(checkedPath(path.join(ctx.programDir, '.workboard-updates')), checkedPath(request.incomingDir));
  const old = readManifest(ctx.programDir, { scope: 'program' }); const next = readManifest(incoming, { expectedVersion: request.expectedVersion });
  if (!greater(next.version, old.version) || !HEX.test(request.expectedSha256)) throw Error('更新必须严格升版并提供可信包哈希');
  const dataRoot = dataSnapshotPath(ctx, request.dataSnapshot); sqliteHeader(dataRoot); const dataFiles = inventory(dataRoot);
  const id = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + crypto.randomUUID(); const previous = previousPath(ctx, path.join(ctx.programDir, '.workboard-previous', id));
  fs.mkdirSync(previous, { recursive: true });
  const meta = { schema: 2, id, state: 'preparing', programDir: ctx.programDir, dataDir: ctx.dataDir, port: ctx.port, fromVersion: old.version, toVersion: next.version, packageSha256: request.expectedSha256, previewUpdateTest: request.previewUpdateTest === true, dataBackupDir: dataRoot, createdAt: new Date().toISOString(), journalDir: path.join(previous, 'journal'), programSnapshot: makeSeal(path.join(previous, 'program'), old.files), incomingSnapshot: makeSeal(path.join(previous, 'stage'), next.files), dataSnapshot: makeSeal(dataRoot, dataFiles) };
  saveMeta(previous, meta);
  try {
    copyInventory(ctx.programDir, meta.programSnapshot.root, old.files); copyInventory(incoming, meta.incomingSnapshot.root, next.files);
    verifySeal(meta.programSnapshot); verifySeal(meta.incomingSnapshot); verifySeal(meta.dataSnapshot);
    compareFiles(inventory(ctx.programDir, { scope: 'program' }), old.files);
    meta.state = 'prepared'; saveMeta(previous, meta);
  } catch { meta.state = 'preparation-failed'; saveMeta(previous, meta); throw Error('更新快照准备失败，当前程序未替换'); }
  return { previousDir: previous, fromVersion: old.version, toVersion: next.version };
}
async function applyUpdate(request) {
  const ctx = loadTransaction(request); validateTestContext(ctx); allowedCurrent(ctx, ctx.meta);
  if (!['prepared','applying','needs-rollback'].includes(ctx.meta.state)) throw Error('当前维护事务不允许更新应用');
  ctx.meta.state = 'applying'; saveMeta(ctx.previous, ctx.meta);
  try {
    const wanted = new Map(ctx.meta.incomingSnapshot.files.map(file => [file.path, file])); const known = knownHashMap(ctx.meta);
    for (const name of [...known.keys()].sort()) await replaceOne(ctx, 'update', name, wanted.get(name), ctx.meta.incomingSnapshot.root, known.get(name));
    compareFiles(inventory(ctx.programDir, { scope: 'program' }), ctx.meta.incomingSnapshot.files); ctx.meta.state = 'installed'; saveMeta(ctx.previous, ctx.meta);
    return { previousDir: ctx.previous, fromVersion: ctx.meta.fromVersion, toVersion: ctx.meta.toVersion, state: ctx.meta.state };
  } catch { failureState(ctx, 'needs-rollback', '程序替换未完成，完整旧快照保留'); throw Error('程序替换未完成；可用同一 previous 恢复，完整快照未消费'); }
}
async function prepareRollback(request) {
  const ctx = loadTransaction(request); validateTestContext(ctx); const current = allowedCurrent(ctx, ctx.meta);
  if (!['prepared','applying','needs-rollback','installed','updated','rollback-prepared','rolling-back','rollback-failed','rolled-back'].includes(ctx.meta.state)) throw Error('当前事务不能恢复');
  if (!ctx.meta.beforeRollback) {
    const beforeData = dataSnapshotPath(ctx, path.join(ctx.dataDir, 'backups', 'before-rollback-' + ctx.meta.id)); const beforeProgram = path.join(ctx.previous, 'before-rollback', 'program');
    if (exists(beforeData) || exists(beforeProgram)) throw Error('首次恢复前快照位置存在未知内容');
    ctx.meta.beforeRollback = { complete: false, program: makeSeal(beforeProgram, current), data: makeSeal(beforeData, captureData(ctx)) }; saveMeta(ctx.previous, ctx.meta);
  }
  const before = ctx.meta.beforeRollback;
  if (!same(checkedPath(before.program.root), path.join(ctx.previous, 'before-rollback', 'program')) || !same(dataSnapshotPath(ctx, before.data.root), path.join(ctx.dataDir, 'backups', 'before-rollback-' + ctx.meta.id))) throw Error('恢复前快照绑定无效');
  if (!before.complete) {
    copyInventory(ctx.programDir, before.program.root, before.program.files); copyInventory(ctx.dataDir, before.data.root, before.data.files);
    verifySeal(before.program); verifySeal(before.data); before.complete = true;
  } else { verifySeal(before.program); verifySeal(before.data); }
  ctx.meta.state = 'rollback-prepared'; saveMeta(ctx.previous, ctx.meta);
  return { previousDir: ctx.previous, fromVersion: ctx.meta.fromVersion, toVersion: ctx.meta.toVersion, beforeRollbackDataDir: before.data.root, beforeRollbackProgramDir: before.program.root };
}
async function applyRollback(request) {
  const ctx = loadTransaction(request); validateTestContext(ctx); allowedCurrent(ctx, ctx.meta);
  if (!ctx.meta.beforeRollback?.complete) throw Error('必须先完整保存首次恢复前程序与数据');
  verifySeal(ctx.meta.beforeRollback.program); verifySeal(ctx.meta.beforeRollback.data);
  const before = ctx.meta.beforeRollback;
  const dataKnown = new Map(); for (const file of [...ctx.meta.dataSnapshot.files, ...before.data.files]) if (DATA_FILES.includes(file.path)) { if (!dataKnown.has(file.path)) dataKnown.set(file.path, new Set()); dataKnown.get(file.path).add(file.sha256 + ':' + file.size); }
  for (const name of DATA_FILES) { const file = path.join(ctx.dataDir, name); if (exists(file)) { const current = fileInfo(file, name); if (!dataKnown.get(name)?.has(current.sha256 + ':' + current.size)) throw Error('当前数据与首次恢复前快照或旧快照不符，未开始恢复'); } }
  ctx.meta.state = 'rolling-back'; saveMeta(ctx.previous, ctx.meta);
  try {
    const wanted = new Map(ctx.meta.programSnapshot.files.map(file => [file.path, file])); const known = knownHashMap(ctx.meta);
    for (const name of [...known.keys()].sort()) await replaceOne(ctx, 'rollback', name, wanted.get(name), ctx.meta.programSnapshot.root, known.get(name));
    const oldData = new Map(ctx.meta.dataSnapshot.files.map(file => [file.path, file]));
    for (const name of DATA_FILES) await replaceOne(ctx, 'data', name, oldData.get(name), ctx.meta.dataSnapshot.root, dataKnown.get(name) || new Set());
    compareFiles(inventory(ctx.programDir, { scope: 'program' }), ctx.meta.programSnapshot.files);
    for (const name of DATA_FILES) { const target = path.join(ctx.dataDir, name); const expected = oldData.get(name); if (expected ? !exists(target) || sha256(target) !== expected.sha256 || fs.statSync(target).size !== expected.size : exists(target)) throw Error('恢复后数据校验失败'); }
    verifySeal(ctx.meta.programSnapshot); verifySeal(ctx.meta.dataSnapshot); verifySeal(before.data); ctx.meta.state = 'rolled-back'; saveMeta(ctx.previous, ctx.meta);
    return { previousDir: ctx.previous, version: ctx.meta.fromVersion, state: 'rolled-back', beforeRollbackDataDir: before.data.root };
  } catch { failureState(ctx, 'rollback-failed', '恢复未完成，可释放冲突后使用原快照重试'); throw Error('恢复未完成；首次恢复前数据与完整旧快照保留，可重试'); }
}
async function importLegacy(request) {
  const ctx = context(request); validateTestContext(ctx); const legacyPrevious = previousPath(ctx, request.previousDir); const incoming = requireWithin(checkedPath(path.join(ctx.programDir, '.workboard-updates')), checkedPath(request.incomingDir));
  const legacyMeta = readJson(metadataFile(legacyPrevious));
  if (!HEX.test(request.expectedSha256) || legacyMeta.packageSha256 !== request.expectedSha256) throw Error('legacy 失败事务与可信 ZIP 哈希不匹配');
  const next = readManifest(incoming); const id = 'legacy-' + crypto.randomUUID(); const previous = previousPath(ctx, path.join(ctx.programDir, '.workboard-previous', id)); fs.mkdirSync(previous, { recursive: true });
  const modulePath = checkedPath(path.join(__dirname, 'maintenance-legacy.cjs'));
  const legacy = require(modulePath).reconstructLegacy({ ...ctx, previousDir: legacyPrevious, incomingDir: incoming, expectedSha256: request.expectedSha256, destinationDir: path.join(previous, 'program') }, { checkedPath, readManifest, inventory, copyFileVerified, sha256 });
  const result = await legacy; const dataRoot = dataSnapshotPath(ctx, result.dataSnapshot); sqliteHeader(dataRoot);
  if (result.toVersion !== next.version || !VERSION.test(result.fromVersion) || !same(checkedPath(result.legacyPreviousDir), legacyPrevious)) throw Error('legacy 重建结果绑定不匹配');
  const oldSeal = makeSeal(path.join(previous, 'program'), result.files); verifySeal(oldSeal); const stageSeal = makeSeal(path.join(previous, 'stage'), next.files); copyInventory(incoming, stageSeal.root, stageSeal.files);
  const currentPaths = new Set(inventory(ctx.programDir, { scope: 'program' }).map(file => file.path));
  const legacyAbsentPaths = [...new Set([...oldSeal.files, ...stageSeal.files].map(file => file.path))].filter(name => !currentPaths.has(name));
  const meta = { schema: 2, id, state: 'needs-rollback', programDir: ctx.programDir, dataDir: ctx.dataDir, port: ctx.port, fromVersion: result.fromVersion, toVersion: result.toVersion, packageSha256: readJson(metadataFile(legacyPrevious)).packageSha256, previewUpdateTest: request.previewUpdateTest === true, dataBackupDir: dataRoot, createdAt: new Date().toISOString(), legacyPreviousDir: legacyPrevious, legacyAbsentPaths, journalDir: path.join(previous, 'journal'), programSnapshot: oldSeal, incomingSnapshot: stageSeal, dataSnapshot: makeSeal(dataRoot, inventory(dataRoot)) };
  verifySeal(meta.incomingSnapshot); verifySeal(meta.dataSnapshot); saveMeta(previous, meta); allowedCurrent(ctx, meta);
  return { previousDir: previous, fromVersion: meta.fromVersion, toVersion: meta.toVersion };
}
async function run(action, request) {
  if (action === 'inspect-package') { if (process.env.BOARD_MAINTENANCE_TEST_HOOK_FILE || process.env.BOARD_MAINTENANCE_TEST) throw Error('包检查不接受故障注入环境'); const info = readManifest(request.incomingDir, { expectedVersion: request.expectedVersion }); return { version: info.version, manifestSha256: info.manifestSha256 }; }
  if (action === 'prepare-update') return prepareUpdate(request);
  if (action === 'apply-update') return applyUpdate(request);
  if (action === 'prepare-rollback') return prepareRollback(request);
  if (action === 'apply-rollback') return applyRollback(request);
  if (action === 'import-legacy') return importLegacy(request);
  if (action === 'mark-running') { const ctx = loadTransaction(request); validateTestContext(ctx); if (request.mode === 'updated' && ctx.meta.state === 'installed') { compareFiles(inventory(ctx.programDir, { scope: 'program' }), ctx.meta.incomingSnapshot.files); ctx.meta.state = 'updated'; } else if (request.mode === 'rolled-back' && ctx.meta.state === 'rolled-back') compareFiles(inventory(ctx.programDir, { scope: 'program' }), ctx.meta.programSnapshot.files); else throw Error('启动回执与维护状态不一致'); ctx.meta.runningVerifiedAt = new Date().toISOString(); saveMeta(ctx.previous, ctx.meta); return { state: ctx.meta.state, version: request.mode === 'updated' ? ctx.meta.toVersion : ctx.meta.fromVersion }; }
  throw Error('未知维护动作');
}
function checkedOutput(requestFile, outputFile, request) {
  requestFile = checkedPath(requestFile); outputFile = checkedPath(outputFile);
  if (same(requestFile, outputFile) || exists(outputFile)) throw Error('维护回执必须使用新的独立文件');
  for (const field of ['dataDir','incomingDir','previousDir','dataSnapshot']) {
    if (request[field] !== undefined && within(checkedPath(request[field]), outputFile, true)) throw Error('维护回执不得写入数据、暂存或快照目录');
  }
  if (request.programDir !== undefined) {
    const program = checkedPath(request.programDir);
    if (within(program, outputFile, true)) {
      const parts = path.relative(program, outputFile).split(path.sep);
      const response = /^response-([1-9]\d*)\.json$/.exec(parts[3] || '');
      if (parts.length !== 4 || parts[0] !== '.workboard-updates' || !/^controller-[A-Za-z0-9-]+$/.test(parts[1]) || parts[2] !== 'runner' || !response || !same(path.dirname(requestFile), path.dirname(outputFile)) || path.basename(requestFile) !== 'request-' + response[1] + '.json') throw Error('程序内回执仅允许维护 runner 的对应 response 文件');
    }
  }
  return outputFile;
}
function exclusiveOutput(file, result) {
  file = checkedPath(file); fs.mkdirSync(path.dirname(file), { recursive: true }); checkedPath(path.dirname(file));
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(result, null, 2) + '\n'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 5 || argv[1] !== '--request' || argv[3] !== '--output') throw Error('用法：ACTION --request 绝对JSON --output 绝对JSON');
    const requestFile = checkedPath(argv[2]); const request = readJson(requestFile);
    const outputFile = checkedOutput(requestFile, argv[4], request);
    const result = await run(argv[0], request);
    const finalOutput = checkedOutput(requestFile, outputFile, request);
    if (!same(finalOutput, outputFile)) throw Error('维护回执真实位置已改变');
    exclusiveOutput(outputFile, result); return 0;
  } catch { process.stderr.write('维护操作失败；现有快照与现场保留，请核对事务记录后重试。\n'); return 1; }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { run, main, checkedPath, readManifest, inventory, copyFileVerified, sha256, PROGRAM_ENTRIES, DATA_FILES };
