'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const q = value => "'" + value.replaceAll("'", "''") + "'";
const windowsOnly = { skip: process.platform !== 'win32' };

function powershell(script, env = {}) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, shell: false, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20000,
  });
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-update-start-'));
  const program = path.join(base, 'program');
  const data = path.join(base, 'test-data');
  fs.mkdirSync(path.join(program, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(program, 'dist', 'index.html'), '<!doctype html>');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, program, data };
}
function common(program) {
  return `. ${q(path.join(root, 'scripts', 'common.ps1'))}\n$script:BoardRoot=${q(program)}\n`;
}
function context(data, port = 19362, explicit = true) {
  return `$context=[pscustomobject]@{Root=$script:BoardRoot;DataDir=${q(data)};Port=${port};Url='http://127.0.0.1:${port}';DataDirExplicit=$${explicit};PreviewUpdateTest=$false}\n`;
}
function startMocks(preview) {
  return `
function Get-BoardNode { return 'fixture-node.exe' }
function Test-BoardPort { param([int]$Port) return $false }
function Start-Sleep { param([int]$Milliseconds) }
$script:healthRead=0
function Get-BoardOwnedHealth { param($Context) $script:healthRead++; if($script:healthRead -eq 1){return $null}; return [pscustomobject]@{version='0.3.2';previewUpdateTest=$${preview}} }
function Start-Process {
  param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError,[switch]$PassThru)
  $script:childFlag=$env:BOARD_PREVIEW_UPDATE_TEST
  $script:childData=$env:BOARD_DATA_DIR
  $script:childPort=$env:BOARD_PORT
  $script:childWindow=$WindowStyle
  $process=[pscustomobject]@{HasExited=$false}; $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}; return $process
}
`;
}

test('预览测试启动要求显式独立目录和非默认端口，拒绝前不访问运行服务', windowsOnly, t => {
  const f = fixture(t);
  const cases = [
    { data: f.data, port: 19362, explicit: false },
    { data: f.data, port: 18327, explicit: true },
    { data: path.join(process.env.LOCALAPPDATA, 'PersonalWorkboard'), port: 19362, explicit: true },
  ];
  for (const value of cases) {
    const script = common(f.program) + context(value.data, value.port, value.explicit) + `
$script:healthRead=$false
function Get-BoardOwnedHealth { param($Context) $script:healthRead=$true; throw 'unexpected-service-access' }
try { Start-BoardService $context -PreviewUpdateTest; exit 3 } catch { if($script:healthRead){exit 4}; [Console]::Out.Write('REJECTED') }
`;
    const result = powershell(script);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'REJECTED');
    assert.equal(fs.existsSync(value.data === f.data ? f.data : path.join(f.base, 'unused')), false);
  }
});

test('start.ps1实际命令入口绑定预览开关，并在缺少独立目录时拒绝', windowsOnly, () => {
  const result = powershell(`try { & ${q(path.join(root, 'scripts', 'start.ps1'))} -PreviewUpdateTest -Port 19362; exit 3 } catch { [Console]::Out.Write('REJECTED:' + $_.Exception.Message) }`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('REJECTED:'));
  assert.ok(result.stdout.includes('-DataDir'));
});

test('普通启动剥离继承的预览变量，显式测试启动只向子进程设置1并恢复原环境', windowsOnly, t => {
  const f = fixture(t);
  for (const preview of [false, true]) {
    const script = common(f.program) + context(f.data) + startMocks(preview) + `
Start-BoardService $context -PreviewUpdateTest:$${preview}
[Console]::Out.Write('RESULT:' + (@{childFlag=$script:childFlag;parentFlag=$env:BOARD_PREVIEW_UPDATE_TEST;childData=$script:childData;childPort=$script:childPort;childWindow=$script:childWindow} | ConvertTo-Json -Compress))
`;
    const result = powershell(script, { BOARD_PREVIEW_UPDATE_TEST: '1' });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout.split('RESULT:')[1]);
    assert.equal(data.childFlag ?? null, preview ? '1' : null);
    assert.equal(data.parentFlag, '1');
    assert.equal(data.childData, f.data);
    assert.equal(data.childPort, '19362');
    assert.equal(data.childWindow, 'Hidden');
  }
});

test('普通与预览服务不能互相复用，启动回执也必须匹配请求模式', windowsOnly, t => {
  const f = fixture(t);
  for (const requested of [false, true]) {
    const script = common(f.program) + context(f.data) + `
function Get-BoardOwnedHealth { param($Context) return [pscustomobject]@{version='0.3.2';previewUpdateTest=$${!requested}} }
function Start-Process { throw 'unexpected-process-start' }
try { Start-BoardService $context -PreviewUpdateTest:$${requested}; exit 3 } catch { if($_.Exception.Message -eq 'unexpected-process-start'){exit 4}; [Console]::Out.Write('REJECTED') }
`;
    const result = powershell(script);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'REJECTED');
  }
  const receiptScript = common(f.program) + context(f.data) + startMocks(false) + `
try { Start-BoardService $context -PreviewUpdateTest; exit 3 } catch { [Console]::Out.Write('REJECTED') }
`;
  const result = powershell(receiptScript);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('REJECTED'));
});

test('已核对服务的预览模式必须在health与service.json一致，并保留给维护重启', windowsOnly, t => {
  const f = fixture(t);
  fs.mkdirSync(f.data, { recursive: true });
  const meta = { port: 19362, version: '0.3.2', instanceId: 'fixture-instance', previewUpdateTest: true };
  fs.writeFileSync(path.join(f.data, 'service.json'), JSON.stringify(meta));
  const liveHealth = `$script:health=[pscustomobject]@{ok=$true;service='personal-workboard';version='0.3.2';instanceId='fixture-instance';previewUpdateTest=$true}\nfunction Get-BoardHealth { param($Context) return $script:health }\n`;
  const script = common(f.program) + context(f.data) + liveHealth + `
$null=Get-BoardOwnedHealth $context
if($context.PreviewUpdateTest -ne $true){exit 3}
` + startMocks(true) + `
Start-BoardService $context
[Console]::Out.Write('RESULT:' + $script:childFlag)
`;
  const result = powershell(script);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('RESULT:')[1], '1');
  const mismatch = powershell(common(f.program) + context(f.data) + liveHealth + `
$script:health.previewUpdateTest=$false
try { $null=Get-BoardOwnedHealth $context; exit 3 } catch { [Console]::Out.Write('REJECTED') }
`);
  assert.equal(mismatch.status, 0, mismatch.stderr);
  assert.equal(mismatch.stdout.trim(), 'REJECTED');
});

test('旧版未记录预览模式按普通服务核对，字符串标志不被当成授权', windowsOnly, t => {
  const f = fixture(t);
  fs.mkdirSync(f.data, { recursive: true });
  const meta = { port: 19362, version: '0.3.1', instanceId: 'legacy-instance' };
  fs.writeFileSync(path.join(f.data, 'service.json'), JSON.stringify(meta));
  const liveHealth = `$script:health=[pscustomobject]@{ok=$true;service='personal-workboard';version='0.3.1';instanceId='legacy-instance'}\nfunction Get-BoardHealth { param($Context) return $script:health }\n`;
  const legacy = powershell(common(f.program) + context(f.data) + liveHealth + `$null=Get-BoardOwnedHealth $context; if($context.PreviewUpdateTest -ne $false){exit 3}; [Console]::Out.Write('ORDINARY')`);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(legacy.stdout.trim(), 'ORDINARY');
  fs.writeFileSync(path.join(f.data, 'service.json'), JSON.stringify({ ...meta, previewUpdateTest: 'true' }));
  const invalid = powershell(common(f.program) + context(f.data) + liveHealth + `try { $null=Get-BoardOwnedHealth $context; exit 3 } catch { [Console]::Out.Write('REJECTED') }`);
  assert.equal(invalid.status, 0, invalid.stderr);
  assert.equal(invalid.stdout.trim(), 'REJECTED');
});

test('启动脚本显式传递关闭值，PowerShell文件保留UTF8 BOM与宿主模块修复', () => {
  for (const name of ['start.ps1', 'common.ps1']) {
    const bytes = fs.readFileSync(path.join(root, 'scripts', name));
    assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf', `${name} 应使用 UTF-8 BOM`);
  }
  const start = fs.readFileSync(path.join(root, 'scripts', 'start.ps1'), 'utf8');
  assert.ok(start.includes('-PreviewUpdateTest:$PreviewUpdateTest'));
  const commonText = fs.readFileSync(path.join(root, 'scripts', 'common.ps1'), 'utf8');
  assert.ok(commonText.includes("@('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Archive')"));
});
