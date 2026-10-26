'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GENERATOR = 'personal-workboard/frontend-notices';
const REQUIRED_PACKAGES = ['@ant-design/icons', 'antd', 'react', 'react-dom'];
const MANIFEST_PATH = 'third-party-licenses/manifest.json';
const SUMMARY_PATH = 'THIRD_PARTY_NOTICES.txt';
const PACKAGE_NAME = /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VIRTUAL_MODULE_PACKAGES = {
  '\0vite/modulepreload-polyfill.js': 'vite',
  '\0vite/preload-helper.js': 'vite',
  '\0rolldown/runtime.js': 'rolldown'
};
// npm omitted these originals from the published package. The fixed commit is
// the gitHead of that exact npm version; its package.json was verified to match.
// These files are committed with the project, so builds never fetch a network
// license or silently substitute another release's terms.
const UPSTREAM_LICENSES = {
  '@ant-design/icons-svg@4.6.0': {
    sourcePath: 'third-party-license-sources/ant-design-icons-svg-4.6.0-LICENSE.txt',
    sha256: '5d367fb0a07340571542eb4ee8eb1add62d37b71bad6786a57c2e9a86bf76c70',
    upstreamCommit: '7f2516ac91226d2b41f93b35cb5197c8d94f7189',
    upstreamUrl: 'https://raw.githubusercontent.com/ant-design/ant-design-icons/7f2516ac91226d2b41f93b35cb5197c8d94f7189/LICENSE',
    upstreamPackageUrl: 'https://raw.githubusercontent.com/ant-design/ant-design-icons/7f2516ac91226d2b41f93b35cb5197c8d94f7189/packages/icons-svg/package.json',
    registryMetadataUrl: 'https://registry.npmjs.org/@ant-design%2ficons-svg/4.6.0'
  },
  'is-mobile@5.0.0': {
    sourcePath: 'third-party-license-sources/is-mobile-5.0.0-README.txt',
    sha256: '1f1f35b6a103d7b010f51a6d7d61e3e47dbc71db2c69cbb7c0ffd40c641b04e2',
    upstreamCommit: '2708dd8f07d91f354a46b8dff3053abb6b840067',
    upstreamUrl: 'https://raw.githubusercontent.com/juliangruber/is-mobile/2708dd8f07d91f354a46b8dff3053abb6b840067/README.md',
    upstreamPackageUrl: 'https://raw.githubusercontent.com/juliangruber/is-mobile/2708dd8f07d91f354a46b8dff3053abb6b840067/package.json',
    registryMetadataUrl: 'https://registry.npmjs.org/is-mobile/5.0.0'
  }
};
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const slash = value => value.split(path.sep).join('/');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const identity = value => `${value.name}@${value.version}`;

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes(':') && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..');
}
function confined(root, relative) {
  if (!safeRelative(relative)) throw Error('第三方声明路径无效：' + relative);
  root = path.resolve(root);
  const target = path.resolve(root, ...relative.split('/'));
  if (!target.startsWith(root + path.sep)) throw Error('第三方声明路径越界：' + relative);
  let current = root;
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('第三方声明目录不允许链接：' + current);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('第三方声明不允许链接：' + relative);
  }
  return target;
}
function readRegular(root, relative) {
  const file = confined(root, relative);
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw Error('缺少第三方声明原件：' + relative);
  return fs.readFileSync(file);
}

// Some packages have es/package.json files containing only a module type.
// Continue to the nearest package.json with a real name and version.
function packageForModule(moduleId, projectRoot) {
  if (typeof moduleId !== 'string') return null;
  const clean = moduleId.replace(/^\0/, '').split('?')[0];
  if (!path.isAbsolute(clean) || !/[\\/]node_modules[\\/]/.test(clean) || !fs.existsSync(clean)) return null;
  const modulesRoot = path.resolve(projectRoot, 'node_modules');
  const file = path.resolve(clean);
  if (!file.startsWith(modulesRoot + path.sep)) throw Error('前端模块不在本项目 node_modules 中：' + clean);
  let directory = fs.lstatSync(file).isDirectory() ? file : path.dirname(file);
  while (directory.startsWith(modulesRoot + path.sep)) {
    const packageJson = path.join(directory, 'package.json');
    if (fs.existsSync(packageJson)) {
      const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
      if (PACKAGE_NAME.test(pkg.name || '') && VERSION.test(pkg.version || '')) return { name: pkg.name, version: pkg.version, root: directory };
    }
    directory = path.dirname(directory);
  }
  throw Error('无法确定前端模块的依赖包：' + clean);
}

function collectRenderedPackages(bundle, projectRoot) {
  const packages = new Map();
  function register(pkg, virtualModuleId) {
    const id = identity(pkg);
    if (!packages.has(id)) packages.set(id, { ...pkg, virtualModuleIds: [] });
    if (virtualModuleId && !packages.get(id).virtualModuleIds.includes(virtualModuleId)) packages.get(id).virtualModuleIds.push(virtualModuleId);
  }
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== 'chunk') continue;
    const modules = Object.entries(chunk.modules || {});
    if (!modules.length && (chunk.moduleIds || []).length) throw Error('构建器未提供模块渲染明细，无法生成第三方声明');
    for (const [moduleId, detail] of modules) {
      if (detail && detail.renderedLength === 0) continue;
      if (moduleId.startsWith('\0') || !path.isAbsolute(moduleId)) {
        const runtimePackage = VIRTUAL_MODULE_PACKAGES[moduleId];
        if (!runtimePackage) throw Error('无法确定已渲染虚拟模块的许可归属：' + JSON.stringify(moduleId));
        const pkg = packageForModule(path.resolve(projectRoot, 'node_modules', runtimePackage, 'package.json'), projectRoot);
        if (!pkg || pkg.name !== runtimePackage) throw Error('缺少前端虚拟运行时的依赖包：' + runtimePackage);
        register(pkg, moduleId);
        continue;
      }
      const pkg = packageForModule(moduleId, projectRoot);
      if (pkg) register(pkg);
    }
  }
  if (!packages.size) throw Error('构建未提供实际第三方模块，拒绝生成空声明');
  return [...packages.values()].sort((a, b) => compare(identity(a), identity(b)));
}

function licenseSources(packageRoot) {
  const files = [];
  const nameMatch = /^(?:(?:third[-_. ]?party[-_. ]?)?(?:licen[cs]e|notice)|copying|copyright)(?:[._-].*)?$/i;
  const directoryMatch = /^(?:licen[cs]es?|notices?)$/i;
  function collect(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw Error('许可证原件不允许链接：' + file);
      if (item.isDirectory()) collect(file);
      else if (item.isFile()) files.push(file);
    }
  }
  for (const item of fs.readdirSync(packageRoot, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    if (!nameMatch.test(item.name) && !(item.isDirectory() && directoryMatch.test(item.name))) continue;
    const file = path.join(packageRoot, item.name);
    if (item.isSymbolicLink()) throw Error('许可证原件不允许链接：' + file);
    if (item.isDirectory()) collect(file);
    else if (item.isFile()) files.push(file);
  }
  return files.sort(compare);
}

function renderSummary(manifest) {
  const lines = [
    '个人待办事项看板：前端第三方软件声明',
    '',
    '本目录随附实际进入前端构建产物的第三方依赖的完整原始许可证及版权声明。',
    '各依赖适用其原件中的许可条款。本声明不为个人待办事项看板项目选择或授予整体许可证。',
    '原件为构建时已安装依赖中的逐字节副本；源路径用于追溯，不要求部署包保留前端 node_modules。',
    'Node 运行时与后端依赖的既有原始许可证继续随其目录提供。',
    '已知的 Vite 与 Rolldown 注入运行时按实际输出虚拟模块归属其包；未输出的构建工具不列入依赖数量。',
    '未知且有输出的虚拟模块会阻止构建，不能无声跳过许可归属。',
    '',
    `前端依赖数量：${manifest.entries.length}`,
    '机器可验证清单：' + MANIFEST_PATH,
    ''
  ];
  if (manifest.renderedVirtualModules.length) {
    lines.push('实际输出的第三方虚拟运行时：');
    for (const module of manifest.renderedVirtualModules) lines.push(`  ${JSON.stringify(module.id)} -> ${module.packageName}@${module.packageVersion}`);
    lines.push('');
  }
  for (const entry of manifest.entries) {
    lines.push(identity(entry), '包清单原件：' + entry.sourcePackageJson, '包声明许可：' + entry.license);
    for (const file of entry.licenseFiles) {
      lines.push('  随包完整原件：' + file.path, '  原件来源：' + file.sourcePath, '  来源类型：' + file.sourceType, '  SHA-256：' + file.sha256);
      if (file.sourceType === 'upstream-version-original') lines.push('  官方版本原件：' + file.upstreamUrl, '  官方版本包清单：' + file.upstreamPackageUrl, '  版本 gitHead 核对：' + file.registryMetadataUrl);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function createNotices(projectRoot, packages) {
  projectRoot = path.resolve(projectRoot);
  const copies = new Map();
  const entries = packages.map(pkg => {
    if (!PACKAGE_NAME.test(pkg.name || '') || !VERSION.test(pkg.version || '')) throw Error('第三方依赖元数据无效');
    const relativeRoot = slash(path.relative(projectRoot, pkg.root));
    if (!safeRelative(relativeRoot) || !relativeRoot.startsWith('node_modules/')) throw Error('许可证来源不在项目依赖目录');
    const sourcePackageJson = relativeRoot + '/package.json';
    const sourcePackage = JSON.parse(readRegular(projectRoot, sourcePackageJson).toString('utf8'));
    if (sourcePackage.name !== pkg.name || sourcePackage.version !== pkg.version) throw Error('依赖版本与实际模块不符：' + identity(pkg));
    const safeId = pkg.name.replace(/[^A-Za-z0-9._-]/g, '_') + '-' + pkg.version + '-' + digest(identity(pkg)).slice(0, 12);
    const licenseFiles = licenseSources(pkg.root).map((file, index) => {
      const sourcePath = slash(path.relative(projectRoot, file));
      const bytes = readRegular(projectRoot, sourcePath);
      if (!bytes.length) throw Error('许可证原件为空：' + sourcePath);
      const relative = `third-party-licenses/${safeId}-${index + 1}.txt`;
      copies.set(relative, bytes);
      return { sourceType: 'installed-package-original', sourcePath, path: relative, sha256: digest(bytes), bytes: bytes.length };
    });
    if (!licenseFiles.length) {
      const pinned = UPSTREAM_LICENSES[identity(pkg)];
      if (!pinned) throw Error('实际进入前端的依赖缺少许可证原件：' + pkg.root);
      const bytes = readRegular(path.join(projectRoot, 'public'), pinned.sourcePath);
      if (digest(bytes) !== pinned.sha256) throw Error('官方版本许可证原件与固定 SHA-256 不符：' + identity(pkg));
      const relative = `third-party-licenses/${safeId}-1.txt`;
      copies.set(relative, bytes);
      copies.set(pinned.sourcePath, bytes);
      licenseFiles.push({ sourceType: 'upstream-version-original', ...pinned, path: relative, bytes: bytes.length });
    }
    return { name: pkg.name, version: pkg.version, license: typeof sourcePackage.license === 'string' ? sourcePackage.license : JSON.stringify(sourcePackage.license || '原件所载条款'), sourcePackageJson, licenseFiles };
  }).sort((a, b) => compare(identity(a), identity(b)));
  const renderedVirtualModules = packages.flatMap(pkg => (pkg.virtualModuleIds || []).map(id => ({ id, packageName: pkg.name, packageVersion: pkg.version }))).sort((a, b) => compare(a.id, b.id));
  const manifest = { schema: 1, generator: GENERATOR, renderedModulePackages: entries.map(({ name, version }) => ({ name, version })), renderedVirtualModules, entries };
  copies.set(SUMMARY_PATH, Buffer.from(renderSummary(manifest), 'utf8'));
  copies.set(MANIFEST_PATH, Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'));
  return { manifest, copies };
}

function writeNotices(outputRoot, notices) {
  outputRoot = path.resolve(outputRoot);
  fs.mkdirSync(outputRoot, { recursive: true });
  const licenseDirectory = confined(outputRoot, 'third-party-licenses');
  if (fs.existsSync(licenseDirectory)) {
    // This directory is owned exclusively by this generator. Never remove a
    // directory recursively, and reject links or unexpected nested content.
    for (const item of fs.readdirSync(licenseDirectory, { withFileTypes: true })) {
      const relative = 'third-party-licenses/' + item.name;
      const file = confined(outputRoot, relative);
      if (!item.isFile() || !/^(?:manifest\.json|[A-Za-z0-9._-]+\.txt)$/.test(item.name)) throw Error('声明目录中存在非生成文件：' + relative);
      if (!notices.copies.has(relative)) fs.unlinkSync(file);
    }
  }
  for (const [relative, bytes] of notices.copies) {
    const file = confined(outputRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  return validateNotices(outputRoot);
}

function validateNotices(publicRoot) {
  const manifest = JSON.parse(readRegular(publicRoot, MANIFEST_PATH).toString('utf8'));
  if (manifest.schema !== 1 || manifest.generator !== GENERATOR || !Array.isArray(manifest.renderedModulePackages) || !manifest.renderedModulePackages.length || !Array.isArray(manifest.renderedVirtualModules) || !Array.isArray(manifest.entries)) throw Error('前端第三方声明清单格式无效');
  const rendered = new Map();
  for (const pkg of manifest.renderedModulePackages) {
    if (!PACKAGE_NAME.test(pkg.name || '') || !VERSION.test(pkg.version || '') || rendered.has(identity(pkg))) throw Error('实际前端依赖元数据无效或重复');
    rendered.set(identity(pkg), pkg);
  }
  const virtualModules = new Set();
  for (const module of manifest.renderedVirtualModules) {
    if (VIRTUAL_MODULE_PACKAGES[module.id] !== module.packageName || virtualModules.has(module.id) || !rendered.has(module.packageName + '@' + module.packageVersion)) throw Error('第三方虚拟运行时许可归属无效');
    virtualModules.add(module.id);
  }
  const registered = new Set();
  const paths = new Set([MANIFEST_PATH]);
  let originals = 0;
  for (const entry of manifest.entries) {
    const id = identity(entry);
    if (!PACKAGE_NAME.test(entry.name || '') || !VERSION.test(entry.version || '') || !rendered.has(id) || registered.has(id)) throw Error('第三方声明包缺失、重复或版本不符：' + id);
    registered.add(id);
    if (!safeRelative(entry.sourcePackageJson) || !entry.sourcePackageJson.startsWith('node_modules/') || !entry.sourcePackageJson.endsWith('/package.json') || typeof entry.license !== 'string' || !entry.license.trim() || !Array.isArray(entry.licenseFiles) || !entry.licenseFiles.length) throw Error('第三方声明缺少包元数据或许可原件：' + id);
    const sourceDirectory = entry.sourcePackageJson.slice(0, -'package.json'.length);
    for (const file of entry.licenseFiles) {
      if (!safeRelative(file.path) || !/^third-party-licenses\/[A-Za-z0-9._-]+\.txt$/.test(file.path) || paths.has(file.path) || !safeRelative(file.sourcePath) || !SHA256.test(file.sha256 || '') || !Number.isSafeInteger(file.bytes) || file.bytes < 1) throw Error('第三方许可原件元数据无效：' + id);
      if (file.sourceType === 'installed-package-original') {
        if (!file.sourcePath.startsWith(sourceDirectory)) throw Error('第三方许可原件不属于声明依赖：' + id);
      } else if (file.sourceType === 'upstream-version-original') {
        const pinned = UPSTREAM_LICENSES[id];
        if (!pinned || Object.entries(pinned).some(([key, value]) => file[key] !== value)) throw Error('官方版本许可来源未固定或不匹配：' + id);
        if (digest(readRegular(publicRoot, pinned.sourcePath)) !== pinned.sha256) throw Error('官方版本许可证原件校验不符：' + id);
      } else throw Error('第三方许可原件缺少可信来源类型：' + id);
      paths.add(file.path);
      const bytes = readRegular(publicRoot, file.path);
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw Error('第三方许可原件校验不符：' + file.path);
      originals++;
    }
  }
  if (registered.size !== rendered.size) throw Error('第三方声明未完整覆盖实际前端依赖');
  for (const name of REQUIRED_PACKAGES) if (![...rendered.values()].some(pkg => pkg.name === name)) throw Error('第三方声明缺少必需前端依赖：' + name);
  const expected = Buffer.from(renderSummary(manifest), 'utf8');
  if (!readRegular(publicRoot, SUMMARY_PATH).equals(expected)) throw Error('前端第三方汇总不完整或与原件清单不符');
  const directory = confined(publicRoot, 'third-party-licenses');
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = 'third-party-licenses/' + item.name;
    confined(publicRoot, relative);
    if (!item.isFile() || !paths.has(relative)) throw Error('第三方声明含未登记文件：' + relative);
  }
  return { packages: registered.size, originals, manifest: MANIFEST_PATH, summary: SUMMARY_PATH };
}

module.exports = { collectRenderedPackages, packageForModule, createNotices, writeNotices, validateNotices, renderSummary, REQUIRED_PACKAGES, UPSTREAM_LICENSES, VIRTUAL_MODULE_PACKAGES };
