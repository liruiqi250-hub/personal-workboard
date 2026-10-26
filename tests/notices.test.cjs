'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const notices = require('../scripts/frontend-notices.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-notices-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'workboard-notices-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const packages = [...notices.REQUIRED_PACKAGES, 'example-helper'].map(name => {
    const directory = path.join(root, 'node_modules', ...name.split('/'));
    fs.mkdirSync(path.join(directory, 'es'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.2.3', license: 'MIT' }));
    fs.writeFileSync(path.join(directory, 'LICENSE'), `Original fixture license for ${name}\r\nCopyright fixture author\r\n`);
    fs.writeFileSync(path.join(directory, 'es', 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(directory, 'es', 'index.js'), 'export const fixture = 1;');
    return { name, version: '1.2.3', root: directory };
  });
  const publicRoot = path.join(root, 'public');
  notices.writeNotices(publicRoot, notices.createNotices(root, packages));
  const manifestFile = path.join(publicRoot, 'third-party-licenses', 'manifest.json');
  function editManifest(edit) {
    const value = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    edit(value);
    fs.writeFileSync(manifestFile, JSON.stringify(value, null, 2) + '\n');
    // Also update the summary: the independent metadata/original checks must
    // reject a defect even when the readable summary agrees with the manifest.
    fs.writeFileSync(path.join(publicRoot, 'THIRD_PARTY_NOTICES.txt'), notices.renderSummary(value));
  }
  return { root, publicRoot, packages, manifestFile, editManifest };
}

test('逐字节保留原始许可，按真实包根定位并跳过无名称的内部 package.json', t => {
  const f = fixture(t);
  const pkg = f.packages.find(value => value.name === 'react');
  assert.equal(notices.packageForModule(path.join(pkg.root, 'es', 'index.js') + '?commonjs-proxy', f.root).root, pkg.root);
  const result = notices.validateNotices(f.publicRoot);
  assert.equal(result.packages, 5);
  assert.equal(result.originals, 5);
  const manifest = JSON.parse(fs.readFileSync(f.manifestFile, 'utf8'));
  for (const entry of manifest.entries) for (const file of entry.licenseFiles) assert.deepEqual(fs.readFileSync(path.join(f.publicRoot, file.path)), fs.readFileSync(path.join(f.root, file.sourcePath)));
  const before = fs.readFileSync(f.manifestFile);
  notices.writeNotices(f.publicRoot, notices.createNotices(f.root, f.packages));
  assert.deepEqual(fs.readFileSync(f.manifestFile), before, '相同模块输入应生成确定性声明');
});

test('构建记录只收集实际渲染模块，跨 chunk 去重', t => {
  const f = fixture(t);
  const first = path.join(f.packages[0].root, 'es', 'index.js');
  const second = path.join(f.packages[1].root, 'es', 'index.js');
  const packages = notices.collectRenderedPackages({
    a: { type: 'chunk', modules: { [first]: { renderedLength: 8 }, [second]: { renderedLength: 0 } } },
    b: { type: 'chunk', modules: { [first]: { renderedLength: 4 } } },
    c: { type: 'asset', source: 'asset' }
  }, f.root);
  assert.deepEqual(packages.map(value => value.name), [f.packages[0].name]);
});

test('虚拟前端运行时归属其构建器原件，未知的已渲染虚拟模块阻止构建', t => {
  const f = fixture(t);
  const directory = path.join(f.root, 'node_modules', 'rolldown');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"rolldown","version":"1.2.15","license":"MIT"}');
  fs.writeFileSync(path.join(directory, 'LICENSE'), 'Original runtime fixture license');
  fs.writeFileSync(path.join(directory, 'THIRD-PARTY-LICENSE'), 'Original bundled attribution fixture');
  const packages = notices.collectRenderedPackages({ runtime: { type: 'chunk', modules: { '\0rolldown/runtime.js': { renderedLength: 42 } } } }, f.root);
  assert.equal(packages[0].name, 'rolldown');
  const generated = notices.createNotices(f.root, [...f.packages, ...packages]);
  notices.writeNotices(f.publicRoot, generated);
  assert.equal(generated.manifest.entries.find(entry => entry.name === 'rolldown').licenseFiles.length, 2);
  assert.deepEqual(generated.manifest.renderedVirtualModules, [{ id: '\0rolldown/runtime.js', packageName: 'rolldown', packageVersion: '1.2.15' }]);
  assert.throws(() => notices.collectRenderedPackages({ unknown: { type: 'chunk', modules: { '\0unknown-runtime': { renderedLength: 1 } } } }, f.root), /无法确定.*虚拟模块/);
  f.editManifest(value => { value.renderedVirtualModules[0].packageName = 'react'; });
  assert.throws(() => notices.validateNotices(f.publicRoot), /虚拟运行时许可归属无效/);
});

test('删除汇总声明或原始许可副本均拒绝', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.publicRoot, 'THIRD_PARTY_NOTICES.txt'));
  assert.throws(() => notices.validateNotices(f.publicRoot), /缺少第三方声明原件/);
  notices.writeNotices(f.publicRoot, notices.createNotices(f.root, f.packages));
  const manifest = JSON.parse(fs.readFileSync(f.manifestFile, 'utf8'));
  fs.unlinkSync(path.join(f.publicRoot, manifest.entries[0].licenseFiles[0].path));
  assert.throws(() => notices.validateNotices(f.publicRoot), /缺少第三方声明原件/);
});

test('清单缺少一个实际依赖条目，汇总同步修改也不能通过', t => {
  const f = fixture(t);
  f.editManifest(value => { value.entries = value.entries.filter(entry => entry.name !== 'example-helper'); });
  assert.throws(() => notices.validateNotices(f.publicRoot), /未完整覆盖/);
});

test('缺少版本、许可来源或必需前端依赖均拒绝', t => {
  const f = fixture(t);
  f.editManifest(value => { delete value.entries[0].version; });
  assert.throws(() => notices.validateNotices(f.publicRoot), /版本不符/);
  notices.writeNotices(f.publicRoot, notices.createNotices(f.root, f.packages));
  f.editManifest(value => { delete value.entries[0].licenseFiles[0].sourceType; });
  assert.throws(() => notices.validateNotices(f.publicRoot), /来源类型/);
  notices.writeNotices(f.publicRoot, notices.createNotices(f.root, f.packages));
  f.editManifest(value => {
    value.entries = value.entries.filter(entry => entry.name !== 'react');
    value.renderedModulePackages = value.renderedModulePackages.filter(entry => entry.name !== 'react');
  });
  assert.throws(() => notices.validateNotices(f.publicRoot), /缺少必需前端依赖/);
});

test('原件内容被改、汇总删减或路径越界均拒绝', t => {
  const f = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(f.manifestFile, 'utf8'));
  fs.appendFileSync(path.join(f.publicRoot, manifest.entries[0].licenseFiles[0].path), 'changed');
  assert.throws(() => notices.validateNotices(f.publicRoot), /原件校验不符/);
  notices.writeNotices(f.publicRoot, notices.createNotices(f.root, f.packages));
  fs.appendFileSync(path.join(f.publicRoot, 'THIRD_PARTY_NOTICES.txt'), 'incomplete');
  assert.throws(() => notices.validateNotices(f.publicRoot), /汇总不完整/);
  f.editManifest(value => { value.entries[0].licenseFiles[0].path = '../outside.txt'; });
  assert.throws(() => notices.validateNotices(f.publicRoot), /元数据无效/);
});

test('未固定的包缺少许可原件时生成失败，不能使用通用许可替代', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.packages[0].root, 'LICENSE'));
  assert.throws(() => notices.createNotices(f.root, f.packages), /缺少许可证原件/);
});

test('固定版本的官方原件可离线重建，篡改固定 SHA 或来源元数据均拒绝', t => {
  const f = fixture(t);
  const name = '@ant-design/icons-svg';
  const directory = path.join(f.root, 'node_modules', '@ant-design', 'icons-svg');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '4.6.0', license: 'MIT' }));
  const pinned = notices.UPSTREAM_LICENSES[name + '@4.6.0'];
  const target = path.join(f.publicRoot, pinned.sourcePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '..', 'public', pinned.sourcePath), target);
  const packages = [...f.packages, { name, version: '4.6.0', root: directory }];
  notices.writeNotices(f.publicRoot, notices.createNotices(f.root, packages));
  assert.equal(notices.validateNotices(f.publicRoot).packages, 6);
  f.editManifest(value => { value.entries.find(entry => entry.name === name).licenseFiles[0].upstreamCommit = 'latest'; });
  assert.throws(() => notices.validateNotices(f.publicRoot), /来源未固定/);
  fs.appendFileSync(target, 'tampered');
  assert.throws(() => notices.createNotices(f.root, packages), /固定 SHA-256 不符/);
});

function sourcePackage(t) {
  const f = fixture(t);
  const names = [
    'package.json', 'package-lock.json', 'README.md', 'AGENTS.md', 'CHANGELOG.md', 'dist/index.html', 'dist/client.js',
    'docs/INSTALL_FOR_CODEX.md', 'docs/RELEASE_FOR_CODEX.md',
    ...['main', 'store', 'vault', 'extract', 'sources', 'updates', 'wechat', 'codex', 'reports', 'managed-codex-store', 'outbound', 'collectors', 'wechat-export-runner','update-protocol','update-trust','publisher-keys'].map(name => 'server/' + name + '.cjs'),
    ...['common.ps1', 'deploy.ps1', 'start.ps1', 'stop.ps1', 'diagnose.ps1', 'update.ps1', 'rollback.ps1', 'validate-package.cjs', 'package-policy.cjs', 'frontend-notices.cjs','sign-update.cjs', '启动看板.cmd', '停止看板.cmd'].map(name => 'scripts/' + name)
  ];
  for (const name of names) {
    const file = path.join(f.root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name === 'package.json' ? JSON.stringify({ name: 'personal-workboard', version: '0.3.1', dependencies: {} }) : name === 'dist/index.html' ? '<!doctype html><html lang="zh-CN"><title>许可验证夹具</title></html>' : 'isolated test fixture');
  }
  notices.writeNotices(path.join(f.root, 'dist'), notices.createNotices(f.root, f.packages));
  for(const directory of ['public','dist'])fs.copyFileSync(path.resolve(__dirname,'../public/update-trust.json'),path.join(f.root,directory,'update-trust.json'));
  function releaseManifest() {
    const entries = [];
    function walk(directory) {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (item.name === 'node_modules' || item.name === 'release-manifest.json') continue;
        const file = path.join(directory, item.name);
        if (item.isDirectory()) walk(file);
        else entries.push({ path: path.relative(f.root, file).split(path.sep).join('/'), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
      }
    }
    walk(f.root);
    // Frontend build dependencies are not needed in a minimal source package.
    const modules = path.join(f.root, 'node_modules');
    const savedModules = path.join(path.dirname(f.root), path.basename(f.root) + '-modules');
    fs.renameSync(modules, savedModules);
    t.after(() => {
      assert.ok(savedModules.startsWith(path.resolve(os.tmpdir()) + path.sep + 'workboard-notices-'));
      fs.rmSync(savedModules, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(f.root, 'release-manifest.json'), JSON.stringify({ schema: 1, kind: 'source', version: '0.3.1', files: entries }));
    return entries;
  }
  const entries = releaseManifest();
  function refreshManifest() {
    const current = entries.filter(entry => fs.existsSync(path.join(f.root, entry.path))).map(entry => ({ path: entry.path, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(f.root, entry.path))).digest('hex') }));
    fs.writeFileSync(path.join(f.root, 'release-manifest.json'), JSON.stringify({ schema: 1, kind: 'source', version: '0.3.1', files: current }));
  }
  return { ...f, refreshManifest };
}

test('发行验证器拒绝删掉声明的包，即使发行清单已重算', t => {
  const f = sourcePackage(t);
  const { validate } = require('../scripts/validate-package.cjs');
  assert.equal(validate(f.root).kind, 'source');
  fs.unlinkSync(path.join(f.publicRoot, 'THIRD_PARTY_NOTICES.txt'));
  f.refreshManifest();
  assert.throws(() => validate(f.root), /必需文件|第三方声明/);
});

test('发行验证器拒绝缺少实际依赖条目的包，即使两份声明与发行清单均重算', t => {
  const f = sourcePackage(t);
  const { validate } = require('../scripts/validate-package.cjs');
  f.editManifest(value => { value.entries = value.entries.filter(entry => entry.name !== 'example-helper'); });
  fs.copyFileSync(f.manifestFile, path.join(f.root, 'dist', 'third-party-licenses', 'manifest.json'));
  fs.copyFileSync(path.join(f.publicRoot, 'THIRD_PARTY_NOTICES.txt'), path.join(f.root, 'dist', 'THIRD_PARTY_NOTICES.txt'));
  f.refreshManifest();
  assert.throws(() => validate(f.root), /未完整覆盖/);
});
