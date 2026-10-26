const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
function isNewer(a,b){const parse=v=>{const m=String(v).match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/);return m?m.slice(1,4).map(Number):null;};const aa=parse(a),bb=parse(b);if(!aa||!bb)return false;for(let i=0;i<3;i++){if(aa[i]!==bb[i])return aa[i]>bb[i];}return false;}
function createUpdates({version,dataDir,getSettings,backup,fetchImpl=fetch}) {
 let state={status:'unconfigured',currentVersion:version,message:'更新目标仓库已提供；签名公钥和可安装正式 Release 仍需发布方配置'};
 async function check(){const {owner,repo,publicKey}=getSettings().updates||{};if(!owner||!repo){state={status:'unconfigured',currentVersion:version,message:'尚未绑定 GitHub 公开发布仓库'};return state;}
  if(!/^[\w.-]+$/.test(owner)||!/^[\w.-]+$/.test(repo))throw Error('GitHub 仓库名称格式不正确');
  const res=await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases/latest`,{headers:{Accept:'application/vnd.github+json','User-Agent':'PersonalWorkboard'},signal:AbortSignal.timeout(20000)});if(res.status===404){state={status:'unconfigured',currentVersion:version,canDownload:false,verified:false,url:`https://github.com/${owner}/${repo}/releases`,message:'仓库已配置，未取得可用的正式 Release；签名公钥和可安装版本尚未就绪'};return state;}if(!res.ok)throw Error('暂时无法读取 GitHub 正式发布版本，请稍后重试');
  const release=await res.json();if(release.prerelease||release.draft)throw Error('检测结果不是正式发布版本');const target=String(release.tag_name||'').replace(/^v/,'');
  const manifest=release.assets?.find(a=>a.name==='update-manifest.json');
  state={status:isNewer(target,version)?'available':'current',currentVersion:version,version:target,notes:release.body||'',publishedAt:release.published_at,url:release.html_url,manifestUrl:manifest?.browser_download_url||null,verified:false,canDownload:!!manifest&&!!publicKey};return state;
 }
 async function download(){if(state.status==='downloaded')return state;if(state.status!=='available')throw Error('目前没有需要下载的正式新版本');const settings=getSettings().updates||{};if(!state.manifestUrl||!settings.publicKey)throw Error('此版本尚未配置签名更新包，不能自动安装。可以查看 GitHub 发布说明。');
  const response=await fetchImpl(state.manifestUrl,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('更新清单下载失败');const m=await response.json();const {signature,...payload}=m;
  if(payload.version!==state.version)throw Error('更新清单版本与正式发布不一致');const canonical=JSON.stringify(payload);if(!crypto.verify(null,Buffer.from(canonical),settings.publicKey,Buffer.from(signature||'','base64')))throw Error('更新签名验证未通过，已停止下载');
  const url=new URL(payload.url);if(url.protocol!=='https:'||!['github.com','objects.githubusercontent.com','release-assets.githubusercontent.com'].includes(url.hostname))throw Error('更新包必须来自 GitHub HTTPS 发布资产');
  const r=await fetchImpl(url,{signal:AbortSignal.timeout(300000)});if(!r.ok)throw Error('更新包下载失败');const limit=400*1024*1024;if(Number(r.headers.get('content-length'))>limit)throw Error('更新包超出 400 MB 限制');let size=0;const parts=[];for await(const part of r.body){size+=part.length;if(size>limit)throw Error('更新包超出大小限制');parts.push(part);}const bytes=Buffer.concat(parts);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==payload.sha256)throw Error('更新文件校验未通过，已保留当前程序');const dir=path.join(dataDir,'updates');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,`workboard-${state.version}.zip`);fs.writeFileSync(file,bytes);state={...state,status:'downloaded',verified:true,file,sha256:payload.sha256};return state;
 }
 async function prepareInstall(){if(!state.verified||!state.file)throw Error('请先下载并验证更新包');const saved=await backup();return {...state,backup:saved,message:'更新包已验证且数据已备份，请由 Codex 按仓库更新指南执行本机替换与重启。',installReady:true};}
 return {check,download,prepareInstall,status:()=>state};
}
module.exports={createUpdates,isNewer};
