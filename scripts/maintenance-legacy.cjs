'use strict';
// Reconstruct an immutable, complete old program from a legacy split move.
// Never moves, deletes or rewrites the live program, saved program or data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_LIMIT = 100000;
const MANIFEST_LIMIT = 4 * 1024 * 1024;
const ROOT_FILES = new Set(['.gitignore', 'package.json', 'package-lock.json', 'index.html', 'vite.config.mjs', 'README.md', 'AGENTS.md', 'CHANGELOG.md', 'release-manifest.json']);
const DIRECTORIES = ['dist', 'server', 'scripts', 'src', 'public', 'tests', 'node_modules', 'vendor/node'];
const DOC_FILES = ['docs/INSTALL_FOR_CODEX.md', 'docs/RELEASE_FOR_CODEX.md'];
const ENTRIES = new Set([...DIRECTORIES, ...DOC_FILES, ...ROOT_FILES]);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HASH = /^[a-f0-9]{64}$/;
const folded = value => process.platform === 'win32' ? value.toLowerCase() : value;
const same = (a, b) => folded(a) === folded(b);
const fail = message => { throw Error('旧更新恢复：' + message); };

function checkedPath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) fail(label + '必须为本机绝对路径');
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(value)) fail(label + '不接受设备、UNC或根相对路径');
    for (const part of value.slice(3).split(/[\\/]+/).filter(Boolean)) {
      if (part === '.' || part === '..' || /[. ]$/.test(part) || part.includes(':') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) fail(label + '含路径别名或保留名称');
    }
  }
  const absolute = path.resolve(value), parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) fail(label + '不能通过链接或联接');
    if (i < parts.length - 1 && !stat.isDirectory()) fail(label + '的祖先不是目录');
  }
  return absolute;
}

function within(target, base, label, allowEqual = false) {
  const relative = path.relative(base, target);
  if ((!relative && !allowEqual) || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail(label + '超出指定边界');
  return target;
}

function isWithin(target, base) {
  const relative = path.relative(base, target);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function exists(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function regularFile(file, label, limit = Infinity) {
  checkedPath(file, label);
  const stat = exists(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size < 0 || stat.size > limit) fail(label + '不存在、类型不符或过大');
  return stat;
}

function directory(file, label) {
  checkedPath(file, label);
  const stat = exists(file);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail(label + '不是常规目录');
}

function hashFile(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) fail('哈希输入不是常规文件');
    const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let count, offset = 0;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, offset)) > 0) { digest.update(buffer.subarray(0, count)); offset += count; }
    const after = fs.fstatSync(descriptor);
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || before.dev !== after.dev) fail('文件在读取期间改变，保留现场');
    return digest.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

function readJson(file, label, limit = MANIFEST_LIMIT) {
  regularFile(file, label, limit);
  const bytes = fs.readFileSync(file);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); }
  catch { fail(label + '不是有效UTF-8 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + '必须为对象');
  return { value, bytes };
}

function programPath(relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || relative.includes('\\') || relative.includes(':') || relative.includes('\0') || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('发行清单含非法路径');
  if (/(?:^|\/)(?:\.env(?:\..*)?|private|work|oversight|verification|\.git|credentials\.dpapi\.json|service\.json)(?:\/|$)/i.test(relative) || /\.dpapi\.json$/i.test(relative)) fail('发行清单含资料或凭据路径');
  if (!ROOT_FILES.has(relative) && !DOC_FILES.includes(relative) && !DIRECTORIES.some(dir => relative.startsWith(dir + '/'))) fail('发行清单超出程序条目');
  return relative;
}

function parseManifest(file, label) {
  const parsed = readJson(file, label), manifest = parsed.value;
  if (manifest.schema !== 1 || manifest.name !== 'personal-workboard' || !VERSION.test(manifest.version || '') || manifest.kind !== 'deployment' || !['win32-x64', 'node24'].includes(manifest.platform) || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > FILE_LIMIT) fail(label + '身份、版本或类型无效');
  const files = new Map(), foldedNames = new Set();
  for (const item of manifest.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(label + '文件条目无效');
    const relative = programPath(item.path);
    if (relative === 'release-manifest.json' || typeof item.sha256 !== 'string' || !HASH.test(item.sha256) || foldedNames.has(relative.toLowerCase())) fail(label + '文件重复、大小写冲突或哈希无效');
    foldedNames.add(relative.toLowerCase()); files.set(relative, { path: relative, sha256: item.sha256 });
  }
  for (const required of ['package.json', 'package-lock.json', 'server/main.cjs', 'scripts/common.ps1', 'scripts/start.ps1', 'scripts/stop.ps1', 'scripts/update.ps1', 'scripts/rollback.ps1', 'dist/index.html']) if (!files.has(required)) fail(label + '缺少必需程序文件');
  if (manifest.platform === 'win32-x64') for (const name of ['vendor/node/node.exe', 'vendor/node/LICENSE']) if (!files.has(name)) fail(label + '缺少运行时');
  return { ...parsed, manifest, files, sha256: crypto.createHash('sha256').update(parsed.bytes).digest('hex') };
}

function fileAt(base, relative, label) {
  const target = checkedPath(path.resolve(base, relative), label);
  within(target, base, label);
  return target;
}

function inventory(base, label, scoped = false) {
  directory(base, label);
  const output = [], lower = new Set();
  function walk(file, relative) {
    checkedPath(file, label);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fail(label + '包含链接');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) walk(path.join(file, name), relative ? relative + '/' + name : name);
      return;
    }
    if (!stat.isFile()) fail(label + '包含特殊文件');
    if (output.length >= FILE_LIMIT || relative.length > 1024) fail(label + '文件数或名称超限');
    const key = relative.toLowerCase();
    if (lower.has(key)) fail(label + '含大小写路径冲突');
    lower.add(key);
    output.push({ path: relative, size: stat.size, sha256: hashFile(file), file });
  }
  if (scoped) {
    for (const entry of ENTRIES) {
      let spellingParent = base;
      for (const part of entry.split('/')) {
        const parentStat = exists(spellingParent);
        if (!parentStat) break;
        if (!parentStat.isDirectory()) fail(label + '条目的祖先不是目录');
        const names = fs.readdirSync(spellingParent);
        if (!names.includes(part) && names.some(name => name.toLowerCase() === part.toLowerCase())) fail(label + '含程序条目大小写别名');
        spellingParent = path.join(spellingParent, part);
        if (!exists(spellingParent)) break;
      }
      const target = fileAt(base, entry, label);
      if (exists(target)) walk(target, entry);
    }
  } else walk(base, '');
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

function manifestEntries(parsed) {
  const map = new Map(parsed.files);
  map.set('release-manifest.json', { path: 'release-manifest.json', sha256: parsed.sha256 });
  return map;
}

function validateIncoming(incoming) {
  const parsed = parseManifest(path.join(incoming, 'release-manifest.json'), '目标发行清单');
  const expected = manifestEntries(parsed), actual = inventory(incoming, '目标发行目录');
  if (actual.length !== expected.size) fail('目标发行目录有缺失或额外文件');
  for (const item of actual) if (!expected.has(item.path) || expected.get(item.path).sha256 !== item.sha256) fail('目标发行目录有未知内容或大小写冲突');
  const pkg = readJson(path.join(incoming, 'package.json'), '目标package.json', 1024 * 1024).value;
  if (pkg.name !== 'personal-workboard' || pkg.version !== parsed.manifest.version) fail('目标包名称或版本不符');
  return parsed;
}

function newer(a, b) {
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i];
  return false;
}

function verifyDataSnapshot(snapshot, data) {
  const absolute = checkedPath(snapshot, '旧数据快照');
  within(absolute, path.join(data, 'backups'), '旧数据快照');
  directory(absolute, '旧数据快照');
  const database = fileAt(absolute, 'workboard.sqlite', '旧数据快照数据库');
  regularFile(database, '旧数据快照数据库');
  const fd = fs.openSync(database, 'r');
  try {
    const header = Buffer.alloc(16);
    if (fs.readSync(fd, header, 0, 16, 0) !== 16 || !header.equals(Buffer.from('SQLite format 3\0', 'binary'))) fail('旧数据库快照格式无效');
  } finally { fs.closeSync(fd); }
  const files = inventory(absolute, '旧数据快照').map(({ path: relative, size, sha256 }) => ({ path: relative, size, sha256 }));
  return { path: absolute, files };
}

function copyVerified(source, destination, expected, root) {
  regularFile(source, '旧程序原件');
  if (hashFile(source) !== expected.sha256) fail('旧原件在复制前改变');
  within(checkedPath(destination, '新快照文件'), root, '新快照文件');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  checkedPath(path.dirname(destination), '新快照父目录');
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  if (hashFile(destination) !== expected.sha256 || fs.statSync(destination).size !== expected.size || hashFile(source) !== expected.sha256) fail('快照复制校验失败，保留部分副本和旧现场');
}

function reconstructLegacy(request, _helpers) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('请求无效');
  const program = checkedPath(request.programDir, '程序目录'), previous = checkedPath(request.previousDir, '旧回退目录'), incoming = checkedPath(request.incomingDir, '目标发行目录'), data = checkedPath(request.dataDir, '数据目录'), destination = checkedPath(request.destinationDir, '新旧程序快照目录');
  const programRoot = path.parse(program).root;
  if (same(program, programRoot) || same(data, path.parse(data).root)) fail('不能使用磁盘根目录');
  if (isWithin(data, program) || isWithin(program, data)) fail('数据与程序目录必须互相独立');
  for (const broad of [process.env.USERPROFILE, process.env.LOCALAPPDATA, process.env.APPDATA, process.env.WINDIR, process.env.PROGRAMFILES].filter(Boolean)) if (same(program, path.resolve(broad)) || same(data, path.resolve(broad))) fail('不能使用用户或系统资料根目录');
  const previousBase = path.join(program, '.workboard-previous');
  within(previous, previousBase, '旧回退目录');
  if (!same(path.dirname(previous), previousBase)) fail('旧回退目录必须是上一程序目录的直接子目录');
  within(incoming, path.join(program, '.workboard-updates'), '目标发行目录');
  within(destination, previousBase, '新快照目录');
  if (path.basename(destination) !== 'program' || !same(path.dirname(path.dirname(destination)), previousBase) || same(path.dirname(destination), previous)) fail('新快照必须位于独立的新回退事务');
  if (!Number.isInteger(request.port) || request.port < 1024 || request.port > 65535) fail('端口无效');
  directory(program, '程序目录'); directory(data, '数据目录'); directory(previous, '旧回退目录'); directory(incoming, '目标发行目录');
  const saved = fileAt(previous, 'program', '旧程序保留目录'); directory(saved, '旧程序保留目录');
  if (exists(destination)) { directory(destination, '新快照目录'); if (fs.readdirSync(destination).length) fail('新快照目录不是空目录；保留旧尝试并使用新的事务目录'); }
  const meta = readJson(path.join(previous, 'update-metadata.json'), '旧维护记录', 1024 * 1024).value;
  if (meta.schema !== undefined || !['prepared', 'needs-rollback', 'installed'].includes(meta.state) || !VERSION.test(meta.fromVersion || '') || !VERSION.test(meta.toVersion || '') || !newer(meta.toVersion, meta.fromVersion) || typeof meta.packageSha256 !== 'string' || !HASH.test(meta.packageSha256)) fail('旧维护记录身份或状态无效');
  if (!same(checkedPath(meta.dataDir, '记录数据目录'), data) || meta.port !== request.port) fail('旧维护记录的数据目录或端口不符');
  if (request.expectedSha256 !== undefined && request.expectedSha256 !== meta.packageSha256) fail('目标ZIP校验值与旧记录不符');
  for (const key of ['moved', 'installed']) {
    if (!Array.isArray(meta[key]) || meta[key].some(entry => typeof entry !== 'string' || !ENTRIES.has(entry)) || new Set(meta[key]).size !== meta[key].length) fail('旧记录程序条目无效');
  }
  const next = validateIncoming(incoming);
  if (next.manifest.version !== meta.toVersion) fail('已验证目标发行版本与旧记录不符');
  const oldCandidates = [];
  for (const [base, label] of [[saved, '保留的旧发行清单'], [program, '现场发行清单']]) {
    const file = path.join(base, 'release-manifest.json');
    if (!exists(file)) continue;
    const parsed = parseManifest(file, label);
    if (parsed.manifest.version === meta.fromVersion) oldCandidates.push({ ...parsed, file });
    else if (base === saved || parsed.manifest.version !== meta.toVersion || parsed.sha256 !== next.sha256) fail('发行清单出现未知或冲突版本');
  }
  if (!oldCandidates.length) fail('缺少可确认fromVersion的原始旧发行清单');
  const old = oldCandidates[0];
  if (oldCandidates.some(candidate => !candidate.bytes.equals(old.bytes))) fail('同版旧发行清单内容冲突');
  const oldExpected = manifestEntries(old), newExpected = manifestEntries(next);
  const savedFiles = inventory(saved, '保留的旧程序'), liveFiles = inventory(program, '现场程序', true);
  const savedMap = new Map(savedFiles.map(item => [item.path, item])), liveMap = new Map(liveFiles.map(item => [item.path, item]));
  for (const item of savedFiles) if (!oldExpected.has(item.path) || oldExpected.get(item.path).sha256 !== item.sha256) fail('保留的旧程序出现未知文件或内容冲突');
  for (const item of liveFiles) {
    const oldHash = oldExpected.get(item.path)?.sha256, newHash = newExpected.get(item.path)?.sha256;
    if (item.sha256 !== oldHash && item.sha256 !== newHash) fail('现场程序出现未知文件或内容冲突，不能猜测覆盖');
  }
  const plan = [], sources = [];
  for (const [relative, expected] of oldExpected) {
    const savedItem = savedMap.get(relative), liveItem = liveMap.get(relative);
    const chosen = savedItem?.sha256 === expected.sha256 ? savedItem : liveItem?.sha256 === expected.sha256 ? liveItem : null;
    if (!chosen) fail('无法凑齐完整旧程序原件：' + relative);
    plan.push({ ...chosen, path: relative });
    sources.push({ path: relative, source: chosen === savedItem ? 'saved' : 'live' });
  }
  const oldPackage = plan.find(item => item.path === 'package.json');
  const pkg = readJson(oldPackage.file, '旧package.json', 1024 * 1024).value;
  if (pkg.name !== 'personal-workboard' || pkg.version !== meta.fromVersion) fail('旧包名称或版本与原清单不符');
  const dataSnapshot = verifyDataSnapshot(meta.dataBackupDir, data);
  // All conflicts, completeness and data bindings are checked before writes.
  fs.mkdirSync(destination, { recursive: true }); checkedPath(destination, '新快照目录');
  for (const item of plan) copyVerified(item.file, path.join(destination, item.path), item, destination);
  const result = inventory(destination, '重建旧快照');
  if (result.length !== plan.length) fail('重建快照文件数不符');
  const built = new Map(result.map(item => [item.path, item]));
  for (const item of plan) if (built.get(item.path)?.sha256 !== item.sha256 || built.get(item.path)?.size !== item.size) fail('重建快照未完整验证');
  return { fromVersion: meta.fromVersion, toVersion: meta.toVersion, packageSha256: meta.packageSha256, oldManifest: old.manifest, oldManifestBytes: Buffer.from(old.bytes),
    dataSnapshot: dataSnapshot.path, dataSnapshotFiles: dataSnapshot.files, legacyPreviousDir: previous,
    files: result.map(({ path: relative, size, sha256 }) => ({ path: relative, size, sha256 })), sources,
    destinationDir: destination, completeVerifiedOldProgram: true, legacySourceUnmodified: true };
}

module.exports = { reconstructLegacy };
