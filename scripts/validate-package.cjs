'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {allowed}=require('./package-policy.cjs');
function validate(root, { updateMode = false } = {}) {
  root=path.resolve(root);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'release-manifest.json'),'utf8'));
  if(manifest.schema!==1||!Array.isArray(manifest.files)||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version))throw Error('发行清单格式无效');
  const expected=new Set();
  for(const file of manifest.files) {
    const nextCode = updateMode && typeof file.path==='string' && (/^server\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.cjs$/.test(file.path)||/^tests\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.test\.cjs$/.test(file.path)||/^scripts\/[\p{L}\p{N}_-][\p{L}\p{N}_. -]*\.(?:cjs|ps1|cmd)$/u.test(file.path));
    if((!allowed(file.path)&&!nextCode)||expected.has(file.path)||!/^[a-f0-9]{64}$/i.test(file.sha256))throw Error('清单存在非法或重复路径：'+file.path);
    expected.add(file.path);
    const target=path.resolve(root,file.path);
    if(!target.startsWith(root+path.sep))throw Error('清单路径越界');
    const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink())throw Error('清单文件类型不允许：'+file.path);
    const digest=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    if(digest!==file.sha256.toLowerCase())throw Error('文件校验不符：'+file.path);
  }
  function walk(dir) { for(const item of fs.readdirSync(dir,{withFileTypes:true})) {
    const file=path.join(dir,item.name),rel=path.relative(root,file).split(path.sep).join('/');
    if(item.isSymbolicLink())throw Error('包中不允许链接：'+rel);
    if(item.isDirectory())walk(file);else if(rel!=='release-manifest.json'&&!expected.has(rel))throw Error('包中存在未登记文件：'+rel);
  }}walk(root);
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if(pkg.name!=='personal-workboard'||pkg.version!==manifest.version)throw Error('包名称或版本与清单不一致');
  if(!['source','deployment'].includes(manifest.kind))throw Error('发行包类型无效');
  if(updateMode&&manifest.kind!=='deployment')throw Error('本机更新需要完整部署包，不能使用源码包');
  const required=['package.json','package-lock.json','README.md','AGENTS.md','CHANGELOG.md','dist/index.html','dist/client.js','docs/INSTALL_FOR_CODEX.md','docs/RELEASE_FOR_CODEX.md',
    'scripts/frontend-notices.cjs','scripts/sign-update.cjs','scripts/maintenance.ps1','scripts/maintenance-engine.cjs','scripts/maintenance-legacy.cjs','public/THIRD_PARTY_NOTICES.txt','public/third-party-licenses/manifest.json','dist/THIRD_PARTY_NOTICES.txt','dist/third-party-licenses/manifest.json','public/update-trust.json','dist/update-trust.json',
    ...['main','store','vault','extract','sources','updates','wechat','codex','reports','managed-codex-store','outbound','collectors','wechat-export-runner','update-protocol','update-trust','publisher-keys'].map(x=>'server/'+x+'.cjs'),
    ...['common.ps1','deploy.ps1','start.ps1','stop.ps1','diagnose.ps1','update.ps1','rollback.ps1','validate-package.cjs','package-policy.cjs','启动看板.cmd','停止看板.cmd'].map(x=>'scripts/'+x)];
  if(manifest.kind==='deployment'){for(const dep of Object.keys(pkg.dependencies||{})){if(!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(dep))throw Error('依赖名称无效');required.push(`node_modules/${dep}/package.json`);}}
  if(manifest.platform==='win32-x64')required.push('vendor/node/node.exe','vendor/node/LICENSE');
  for(const file of required)if(!expected.has(file))throw Error('部署包缺少必需文件：'+file);
  const {validateNotices}=require('./frontend-notices.cjs');
  validateNotices(path.join(root,'public'));validateNotices(path.join(root,'dist'));
  const trustFile=path.join(root,'public/update-trust.json'),trust=JSON.parse(fs.readFileSync(trustFile,'utf8'));
  if(trust.schema!==1||trust.algorithm!=='Ed25519'||trust.owner!=='liruiqi250-hub'||trust.repo!=='personal-workboard'||typeof trust.publicKey!=='string'||!trust.publicKey.startsWith('-----BEGIN PUBLIC KEY-----')||JSON.stringify(trust).includes('PRIVATE KEY')||Object.hasOwn(trust,'protectedPrivateKey'))throw Error('默认更新信任格式或项目绑定不正确');
  const key=crypto.createPublicKey(trust.publicKey),keyId=crypto.createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
  if(key.asymmetricKeyType!=='ed25519'||keyId!==trust.keyId||trust.fingerprint!=='SHA256:'+keyId||!fs.readFileSync(trustFile).equals(fs.readFileSync(path.join(root,'dist/update-trust.json'))))throw Error('默认更新公钥未就绪、指纹不匹配或构建副本不一致');
  for(const file of expected)if(file==='public/THIRD_PARTY_NOTICES.txt'||file.startsWith('public/third-party-licenses/')||file.startsWith('public/third-party-license-sources/')){
    const copied='dist/'+file.slice('public/'.length);if(!expected.has(copied)||!fs.readFileSync(path.join(root,file)).equals(fs.readFileSync(path.join(root,copied))))throw Error('第三方完整声明在源码与构建副本中不一致：'+file);
  }
  const index=fs.readFileSync(path.join(root,'dist/index.html'),'utf8');
  for(const match of index.matchAll(/(?:src|href)="([^"]+)"/g)){if(/^(?:https?:|data:|#)/i.test(match[1]))continue;const target=path.posix.normalize(path.posix.join('dist',match[1].replace(/^\//,'')));if(!target.startsWith('dist/')||!expected.has(target))throw Error('构建页面引用的文件不存在：'+match[1]);}
  return {version:manifest.version,files:expected.size,kind:manifest.kind};
}
if(require.main===module){try{console.log(JSON.stringify(validate(process.argv[2],{updateMode:process.argv.includes('--update')})));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={validate};
