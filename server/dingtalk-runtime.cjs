'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const VERSION='1.0.65',ZIP_SHA='db7cd21655ede7375676a349f44f5d9116fe28a8836276244341e109314407b7',EXE_SHA='7c42d3180e16a72fc55c1e8ba1a24dbafa506dbcb5c7e62d43633127c3ce05e3';
const URL='https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v1.0.65/dws-windows-amd64.zip';
const ZIP_BYTES=20603005;
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function checkedDirectory(base,relative){
 const target=path.resolve(base,relative),rel=path.relative(base,target);if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('工具目录边界无效');
 let current=base;for(const part of rel.split(path.sep)){current=path.join(current,part);if(fs.existsSync(current)){const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('工具目录含链接或不是目录，已保留现场');}else fs.mkdirSync(current);}
 return fs.realpathSync.native(target);
}
function compatibleHelp(version,chat,auth){return new RegExp('(?:^|[^0-9])'+VERSION.replaceAll('.','\\.')+'(?:$|[^0-9])').test(version)&&['--start','--end','--page-all','--no-reactions'].every(flag=>chat.includes(flag))&&auth.includes('--readonly');}
function command(executable,args,{cwd,input,timeout=15000}={}){return new Promise((resolve,reject)=>{
 const child=spawn(executable,args,{cwd,shell:false,windowsHide:true,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});let stdout='',size=0,failed=false;const timer=setTimeout(()=>{failed=true;child.kill();},timeout);
 child.stdout.on('data',part=>{size+=part.length;if(size>256*1024){failed=true;child.kill();}else stdout+=part.toString('utf8');});child.stderr.resume();child.stdin?.on('error',()=>{});if(input!==undefined)child.stdin.end(input);
 child.once('error',()=>{clearTimeout(timer);reject(Error('无法运行已核验的钉钉工具，请检查本机环境'));});child.once('close',code=>{clearTimeout(timer);code===0&&!failed?resolve(stdout):reject(Error('钉钉工具检测未完成，请检查网络或安装环境'));});
});}
const EXTRACT=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $p=ConvertFrom-Json ([Console]::In.ReadToEnd()); $z=[IO.Compression.ZipFile]::OpenRead($p.zip); try { $allowed=@('CHANGELOG.md','LICENSE','NOTICE','README.md','dws.exe'); if($z.Entries.Count -ne 5){throw 'entry count'}; $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); foreach($e in $z.Entries){if($e.FullName -cnotin $allowed -or -not $seen.Add($e.FullName) -or $e.Length -gt 60000000 -or (($e.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw 'entry rejected'}; $f=[IO.Path]::GetFullPath([IO.Path]::Combine($p.target,$e.FullName)); $b=[IO.Path]::GetFullPath($p.target).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar; if(-not $f.StartsWith($b,[StringComparison]::OrdinalIgnoreCase)){throw 'entry boundary'}; $s=$e.Open(); $o=[IO.File]::Open($f,[IO.FileMode]::CreateNew);try{$s.CopyTo($o)}finally{$o.Dispose();$s.Dispose()}} }finally{$z.Dispose()}`;
function createDingtalkRuntime({localAppData=process.env.LOCALAPPDATA,fetchImpl=fetch,packageFile}={}){
 let preparing=null;const root=()=>{if(process.platform!=='win32'||!localAppData||!path.isAbsolute(localAppData))throw Error('钉钉工具准备需要 Windows 本机用户目录');return fs.realpathSync.native(localAppData);};
 const tools=()=>checkedDirectory(root(),'PersonalWorkboardTools/dingtalk');
 const destination=()=>path.join(tools(),'v'+VERSION+'-windows-amd64');
 async function status(){
  const target=destination(),executable=path.join(target,'dws.exe');
  if(!fs.existsSync(target))return {installed:false,compatible:false,version:VERSION,path:'',message:'尚未准备钉钉工具。点击“准备官方工具”，核验后安装到本机独立工具目录。'};
  if(fs.lstatSync(target).isSymbolicLink()||!fs.existsSync(executable)||fs.lstatSync(executable).isSymbolicLink()||fs.statSync(executable).size!==52616192||digest(executable)!==EXE_SHA)throw Error('既有钉钉工具校验不符，已保留目录；请维护人员核对，不能覆盖未知文件');
  if(!fs.existsSync(path.join(target,'LICENSE'))||!fs.existsSync(path.join(target,'NOTICE')))throw Error('钉钉工具许可证资料缺失，请维护人员核对');
  const version=await command(executable,['--version'],{cwd:target}),chat=await command(executable,['chat','+chat-messages','--help'],{cwd:target}),auth=await command(executable,['auth','status','--help'],{cwd:target});
  const compatible=compatibleHelp(version,chat,auth);return {installed:true,compatible,version:VERSION,path:executable,loginChecked:false,message:compatible?'官方钉钉工具已准备，版本和只读命令兼容。尚未检查组织登录；请本人填写组织身份和会话范围，再检测连接。':'已安装工具的命令与本版不兼容，请维护人员核对。'};
 }
 async function prepare(){
  if(preparing)return preparing;
  preparing=(async()=>{
   const existing=await status();if(existing.installed)return existing;
   const base=tools(),target=destination(),stage=checkedDirectory(base,'.stage-'+crypto.randomBytes(8).toString('hex')),zip=path.join(stage,'official.zip');
   if(packageFile){assertPackage(packageFile);fs.copyFileSync(packageFile,zip,fs.constants.COPYFILE_EXCL);}
   else{
    let current=URL,response;for(let i=0;i<6;i++){const parsed=new global.URL(current);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(parsed.hostname))throw Error('官方工具下载地址不符合安全边界');response=await fetchImpl(current,{redirect:'manual',signal:AbortSignal.timeout(90000),headers:{'User-Agent':'PersonalWorkboard/'+require('../package.json').version}});if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location)throw Error('官方工具下载跳转无效');current=new global.URL(location,current).href;continue;}break;}
    if(!response?.ok||!response.body)throw Error('官方钉钉工具暂时无法下载，请稍后手动重试');const fd=fs.openSync(zip,'wx');let bytes=0;try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>ZIP_BYTES)throw Error('官方工具包大小超出预期');fs.writeSync(fd,Buffer.from(chunk));}}finally{fs.closeSync(fd);}assertPackage(zip);
   }
   await command('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',EXTRACT],{input:JSON.stringify({zip,target:stage}),timeout:60000});
   if(digest(path.join(stage,'dws.exe'))!==EXE_SHA)throw Error('钉钉可执行文件校验不符，已保留现场');
   fs.writeFileSync(path.join(stage,'installation.json'),JSON.stringify({version:VERSION,source:URL,zipSha256:ZIP_SHA,executableSha256:EXE_SHA,preparedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
   const stageRelative=path.relative(base,fs.realpathSync.native(stage)),targetRelative=path.relative(base,path.resolve(target));if(stageRelative.includes(path.sep)||targetRelative.includes(path.sep)||stageRelative.startsWith('..')||targetRelative.startsWith('..')||fs.existsSync(target))throw Error('工具最终目录冲突，已保留现场');
   fs.renameSync(stage,target);return status();
  })().finally(()=>{preparing=null;});return preparing;
 }
 return {status,prepare};
}
function assertPackage(file){if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size!==ZIP_BYTES||digest(file)!==ZIP_SHA)throw Error('官方钉钉工具包大小或SHA-256不符，已停止准备');}
module.exports={createDingtalkRuntime,compatibleHelp,assertPackage,VERSION,ZIP_SHA,EXE_SHA,ZIP_BYTES,URL};
