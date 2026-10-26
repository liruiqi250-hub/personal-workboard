'use strict';
// 公开部署包只复制此处与 package-policy.cjs 明列的程序文件。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {roots,docs,allowed}=require('./package-policy.cjs');
const {validate}=require('./validate-package.cjs');
function validateNodeLicense(content) {
  // 保留 Node 官方完整许可证（含第三方声明），不能只附一段 MIT 摘录。
  if(typeof content!=='string'||content.length<50000||!/^Node\.js is licensed for use as follows:/m.test(content)||!content.includes('Permission is hereby granted, free of charge')||!content.includes('THE SOFTWARE IS PROVIDED "AS IS"')||!content.includes('Node.js contributors'))throw Error('Node 许可证内容或 MIT 许可段校验失败，不能分发内置运行时');
  return content;
}
async function getNodeLicense(nodeDirectory=path.dirname(process.execPath),version=process.versions.node) {
  for(const filename of ['LICENSE','LICENSE.txt']) {
    const candidate=path.join(nodeDirectory,filename);
    if(fs.existsSync(candidate))return validateNodeLicense(fs.readFileSync(candidate,'utf8'));
  }
  if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('当前 Node 不是可定位官方许可证的正式版本');
  const url=`https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`;
  const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`无法取得对应 Node 官方许可证（HTTP ${response.status}），不能分发内置运行时`);
  return validateNodeLicense(await response.text());
}
async function main() {
const root=path.resolve(__dirname,'..');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const args=new Set(process.argv.slice(2));
for(const arg of args)if(!['--source-only','--with-node-runtime'].includes(arg))throw Error('未知参数：'+arg);
if(Number(process.versions.node.split('.')[0])<24)throw Error('打包需要 Node 24 或以上版本');
if(!fs.existsSync(path.join(root,'dist/index.html')))throw Error('请先 npm run build，再执行打包');
const id=crypto.randomBytes(5).toString('hex');
const stage=path.join(root,'work','package',`personal-workboard-${pkg.version}-${id}`);
const release=path.join(root,'release');
fs.mkdirSync(stage,{recursive:true});fs.mkdirSync(release,{recursive:true});
function within(target,base) {if(target===base||!target.startsWith(base+path.sep))throw Error('操作路径越界');}
function copy(source,rel) {
  const target=path.join(stage,rel);within(target,stage);
  const stat=fs.lstatSync(source);if(stat.isSymbolicLink())throw Error('不打包链接：'+rel);
  if(stat.isDirectory())for(const name of fs.readdirSync(source))copy(path.join(source,name),rel+'/'+name);
  else {if(!allowed(rel))throw Error('公开白名单拒绝：'+rel);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}
}
for(const name of [...roots,...docs]) {
  const source=path.join(root,name);if(!fs.existsSync(source))throw Error('缺少公开发行文件：'+name);copy(source,name);
}
for(const name of ['dist','server','scripts','src','public','tests'])if(fs.existsSync(path.join(root,name)))copy(path.join(root,name),name);
if(!args.has('--source-only')) {
  // 在独立临时副本按 lockfile 安装生产依赖，不删改开发目录的 node_modules。
  const npmCli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
  if(!fs.existsSync(npmCli))throw Error('打包部署包需要所选 Node 附带 npm；或用 --source-only 生成源码包');
  const result=cp.spawnSync(process.execPath,[npmCli,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:stage,stdio:'inherit',windowsHide:true});
  if(result.status!==0)throw Error('临时部署目录安装生产依赖失败');
}
if(args.has('--with-node-runtime')) {
  if(process.platform!=='win32'||process.arch!=='x64')throw Error('内置运行时部署包仅支持 Windows x64');
  copy(process.execPath,'vendor/node/node.exe');
  const license=await getNodeLicense();
  const target=path.join(stage,'vendor/node/LICENSE');within(target,stage);
  fs.writeFileSync(target,license,'utf8');
}
const files=[];
function walk(dir) {for(const item of fs.readdirSync(dir,{withFileTypes:true})) {
  const file=path.join(dir,item.name),rel=path.relative(stage,file).split(path.sep).join('/');
  if(item.isSymbolicLink())throw Error('包中不允许符号链接：'+rel);
  if(item.isDirectory()){walk(file);continue;}
  if(!allowed(rel))throw Error('发行文件超出白名单：'+rel);
  if(!rel.startsWith('node_modules/')&&!rel.startsWith('vendor/')&&/\.(?:cjs|mjs|js|jsx|ts|tsx|md|json|html|css|ps1|cmd|svg)$/i.test(rel)) {
    const content=fs.readFileSync(file,'utf8');
    if(/(?:[A-Za-z]:[\\/]Users[\\/]|[A-Za-z]:[\\/]360MoveData[\\/]|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-proj-|sk-ant-)[A-Za-z0-9_-]{16,})/i.test(content))throw Error('发现疑似私人绝对路径或密钥，请人工核查：'+rel);
    if(/\b(?:threadId|conversationId|chatId)\s*[:=]\s*["'][0-9a-f]{8}-[0-9a-f-]{27,}["']/i.test(content))throw Error('发现疑似真实聊天标识：'+rel);
  }
  files.push({path:rel,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
}}walk(stage);files.sort((a,b)=>a.path.localeCompare(b.path));
const manifest={schema:1,name:pkg.name,version:pkg.version,kind:args.has('--source-only')?'source':'deployment',node:'>=24',platform:args.has('--with-node-runtime')?'win32-x64':'node24',createdAt:new Date().toISOString(),files};
fs.writeFileSync(path.join(stage,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
validate(stage);
const flavor=args.has('--source-only')?'source':args.has('--with-node-runtime')?'windows-x64':'deployment';
const zip=path.join(release,`personal-workboard-${pkg.version}-${flavor}.zip`);
if(fs.existsSync(zip))throw Error('同名发行包已存在。请保留旧包、递增版本号后重试，不覆盖已发版本');
if(process.platform==='win32') {
  // 路径通过环境变量传递，避免中文路径和引号进入 shell 拼接。
  const script="$ErrorActionPreference='Stop'; Compress-Archive -Path (Join-Path $env:BOARD_PACKAGE_STAGE '*') -DestinationPath $env:BOARD_PACKAGE_ZIP -CompressionLevel Optimal";
  const result=cp.spawnSync('powershell.exe',['-NoProfile','-Command',script],{env:{...process.env,BOARD_PACKAGE_STAGE:stage,BOARD_PACKAGE_ZIP:zip},stdio:'inherit',windowsHide:true});
  if(result.status!==0)throw Error('系统 Compress-Archive 打包失败；临时目录保留可诊断');
} else throw Error('当前发行打包脚本使用 Windows PowerShell Compress-Archive，请在 Windows 执行');
const digest=crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
fs.writeFileSync(zip+'.sha256',digest+'  '+path.basename(zip)+'\n');
console.log(JSON.stringify({version:pkg.version,file:path.relative(root,zip).split(path.sep).join('/'),sha256:digest,files:files.length,kind:manifest.kind},null,2));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={getNodeLicense,validateNodeLicense};
