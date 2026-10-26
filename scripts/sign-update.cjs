#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { OWNER, REPO, checkedAbsolute, createPublisherKeys } = require('../server/publisher-keys.cjs');
const { MAX_UPDATE_BYTES, createManifestPayload, verifyManifest } = require('../server/update-protocol.cjs');

const HELP = `本项目维护者更新签名工具（仅 Windows 当前用户 DPAPI）
node scripts/sign-update.cjs init [--key-dir 绝对目录]
node scripts/sign-update.cjs public [--key-dir 绝对目录]
node scripts/sign-update.cjs sign --zip ZIP绝对路径 --version 0.3.1 --tag v0.3.1 --channel preview --sequence 1 --output-dir 绝对目录 [--created-at ISO时间] [--key-dir 绝对目录]
密钥只绑定 ${OWNER}/${REPO}。不导入或导出私钥，不自动发布。
`;
const ALL_FLAGS = new Set(['key-dir', 'zip', 'version', 'tag', 'channel', 'sequence', 'output-dir', 'created-at']);
const sameFile = (a, b) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const ZIP_IDENTITY_SCRIPT = `
$ErrorActionPreference='Stop'; $archive=$null
try {
  [Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $request=ConvertFrom-Json ([Console]::In.ReadToEnd())
  $archive=[IO.Compression.ZipFile]::OpenRead($request.file)
  if($archive.Entries.Count -gt 100000){throw 'invalid'}
  $targets=@{}
  foreach($entry in $archive.Entries){
    if($entry.FullName.Length -gt 1024){throw 'invalid'}
    $name=$entry.FullName.Replace('\\','/')
    if($name -ieq 'package.json' -or $name -ieq 'release-manifest.json'){
      if($entry.FullName -cne $name -or $name -cnotin @('package.json','release-manifest.json') -or $targets.ContainsKey($name)){throw 'invalid'}
      $targets[$name]=$entry
    }
  }
  if($targets.Count -ne 2){throw 'invalid'}
  function Read-BoundedJson($entry,$limit){
    if($entry.Length -lt 1 -or $entry.Length -gt $limit){throw 'invalid'}
    $stream=$entry.Open(); $memory=New-Object IO.MemoryStream
    try {
      $buffer=New-Object byte[] 65536; $total=0
      while(($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0){
        $total+=$count; if($total -gt $limit){throw 'invalid'}; $memory.Write($buffer,0,$count)
      }
      if($total -ne $entry.Length){throw 'invalid'}
      $encoding=New-Object Text.UTF8Encoding($false,$true)
      $text=$encoding.GetString($memory.ToArray()).TrimStart([char]0xfeff)
      return (ConvertFrom-Json $text)
    } finally { $stream.Dispose(); $memory.Dispose() }
  }
  $package=Read-BoundedJson $targets['package.json'] 262144
  $manifest=Read-BoundedJson $targets['release-manifest.json'] 4194304
  $safe=@{packageName=$package.name;packageVersion=$package.version;manifestSchema=$manifest.schema;manifestName=$manifest.name;manifestVersion=$manifest.version;kind=$manifest.kind;platform=$manifest.platform}
  [Console]::Out.Write(($safe | ConvertTo-Json -Compress -Depth 3))
} catch { [Console]::Error.Write('invalid archive identity'); exit 1 }
finally { if($null -ne $archive){$archive.Dispose()} }
`;

function readZipIdentity(file, version) {
  if (process.platform !== 'win32') throw Error('ZIP 包内身份核验需要 Windows .NET ZipArchive；不会跳过核验签发');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ZIP_IDENTITY_SCRIPT], {
    input: JSON.stringify({ file }), encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024,
  });
  if (result.error || result.status !== 0) throw Error('ZIP 包内身份文件缺失、重复、过大或格式无效，未签发');
  let identity;
  try { identity = JSON.parse(result.stdout); } catch { throw Error('ZIP 包内身份核验没有返回有效结果，未签发'); }
  if (identity.packageName !== 'personal-workboard' || identity.packageVersion !== version || identity.manifestSchema !== 1 || identity.manifestName !== 'personal-workboard' || identity.manifestVersion !== version || identity.kind !== 'deployment' || identity.platform !== 'win32-x64') throw Error('ZIP 包内名称、版本、部署类型或平台与签发声明不匹配，未签发');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (['--help', '-h', 'help'].includes(command)) return { command: 'help', options: {} };
  if (!['init', 'public', 'sign'].includes(command)) throw Error('请显式选择 init、public 或 sign；运行 --help 查看格式');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]?.startsWith('--') ? rest[index].slice(2) : '';
    const value = rest[index + 1];
    if (!ALL_FLAGS.has(name) || options[name] !== undefined || typeof value !== 'string' || value.startsWith('--') || value.includes('\0')) throw Error('参数格式、重复参数或不支持的选项；运行 --help 查看格式');
    if (command !== 'sign' && name !== 'key-dir') throw Error('init/public 只接受 --key-dir；不接受密钥内容');
    options[name] = value;
  }
  if (command === 'sign') {
    if (['zip', 'version', 'tag', 'channel', 'sequence', 'output-dir'].some(name => !options[name])) throw Error('sign 必须明确指定 ZIP、版本、tag、通道、序号和输出目录');
    if (!/^[1-9]\d*$/.test(options.sequence) || !Number.isSafeInteger(Number(options.sequence))) throw Error('签名序号必须为正的安全整数');
  }
  return { command, options };
}

function readZipDigest(inputFile, version, { checkIdentity = true } = {}) {
  const file = checkedAbsolute(inputFile, 'ZIP 文件');
  if (path.basename(file) !== `personal-workboard-${version}-windows-x64.zip`) throw Error('ZIP 文件名必须与本项目、声明版本和 windows-x64 一致');
  let descriptor;
  try { descriptor = fs.openSync(file, 'r'); } catch { throw Error('无法安全读取指定 ZIP 文件'); }
  try {
    const before = fs.fstatSync(descriptor);
    const current = fs.lstatSync(file);
    if (!before.isFile() || current.isSymbolicLink() || !sameFile(before, current) || before.size < 22 || before.size > MAX_UPDATE_BYTES) throw Error('ZIP 文件大小、类型或位置无效');
    const first = Buffer.alloc(4);
    if (fs.readSync(descriptor, first, 0, first.length, 0) !== 4 || !['504b0304', '504b0506'].includes(first.toString('hex'))) throw Error('指定文件没有有效的 ZIP 文件头');
    if (checkIdentity) readZipIdentity(file, version);
    const digest = crypto.createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    let count;
    while ((count = fs.readSync(descriptor, chunk, 0, chunk.length, bytes)) !== 0) {
      bytes += count;
      if (bytes > MAX_UPDATE_BYTES) throw Error('ZIP 文件超过允许大小');
      digest.update(chunk.subarray(0, count));
    }
    checkedAbsolute(file, 'ZIP 文件');
    if (bytes !== before.size || !sameFile(before, fs.fstatSync(descriptor)) || !sameFile(before, fs.lstatSync(file))) throw Error('读取期间 ZIP 文件已经改变，请重新核对');
    return { bytes, sha256: digest.digest('hex'), assetName: path.basename(file) };
  } finally { fs.closeSync(descriptor); }
}

function saveManifest(outputDir, manifest) {
  const dir = checkedAbsolute(outputDir, '签名输出目录');
  if (dir === path.parse(dir).root || (fs.existsSync(dir) && !fs.statSync(dir).isDirectory())) throw Error('请指定独立的签名输出目录');
  fs.mkdirSync(dir, { recursive: true });
  checkedAbsolute(dir, '签名输出目录');
  const file = checkedAbsolute(path.join(dir, 'update-manifest.json'), '签名输出文件');
  const content = JSON.stringify(manifest, null, 2) + '\n';
  try { fs.writeFileSync(file, content, { flag: 'wx' }); } catch (error) {
    if (error.code !== 'EEXIST') throw Error('签名清单保存失败，未覆盖已有文件');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 || fs.readFileSync(file, 'utf8') !== content) throw Error('输出目录已有不同内容的 update-manifest.json，未覆盖');
  }
  checkedAbsolute(file, '签名输出文件');
  return file;
}

async function signArchive(options, keys, now = () => new Date().toISOString()) {
  const info = await keys.getPublic();
  const archive = readZipDigest(options.zip, options.version);
  const payload = createManifestPayload({ owner: OWNER, repo: REPO, channel: options.channel, version: options.version, tag: options.tag,
    ...archive, keyId: info.keyId, sequence: Number(options.sequence), createdAt: options['created-at'] || now() });
  const manifest = await keys.sign(payload);
  verifyManifest(manifest, info.publicKey, { owner: OWNER, repo: REPO, channel: options.channel, version: options.version, tag: options.tag, assetName: archive.assetName });
  const after = readZipDigest(options.zip, options.version, { checkIdentity: false });
  if (after.sha256 !== archive.sha256 || after.bytes !== archive.bytes) throw Error('签名期间 ZIP 文件已经改变，未保存清单');
  const manifestPath = saveManifest(options['output-dir'], manifest);
  return { ...info, manifestPath, version: payload.version, tag: payload.tag, channel: payload.channel, sequence: payload.sequence, sha256: payload.sha256, bytes: payload.bytes };
}

async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, createKeys = createPublisherKeys, now } = {}) {
  try {
    const { command, options } = parseArgs(argv);
    if (command === 'help') { stdout.write(HELP); return 0; }
    const keys = createKeys({ keyDir: options['key-dir'] });
    const result = command === 'init' ? await keys.init() : command === 'public' ? await keys.getPublic() : await signArchive(options, keys, now);
    stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (error) {
    // Only our public error messages are printed. Never print stacks, causes or DPAPI output.
    const safe = typeof error.message === 'string' && !/PRIVATE KEY|protectedPrivateKey|ciphertext|-----BEGIN/i.test(error.message) ? error.message : '发布签名操作失败，请在本机核对输入；未输出密钥内容';
    stderr.write('发布签名失败：' + safe + '\n');
    return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { parseArgs, readZipDigest, saveManifest, signArchive, main };
