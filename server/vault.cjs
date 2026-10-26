const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
function protect(value,decode=false) {return new Promise((resolve,reject)=>{
  if(process.platform!=='win32')return reject(Error('当前凭据保护只支持 Windows；不会退回明文保存'));
  const script=`Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[Security.Cryptography.ProtectedData]::${decode?'Unprotect':'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='';let err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',()=>reject(Error('无法调用 Windows 凭据保护')));child.on('exit',code=>code===0?resolve(decode?Buffer.from(out.trim(),'base64').toString('utf8'):out.trim()):reject(Error('Windows 凭据保护暂时不可用')));child.stdin.end(decode?value:Buffer.from(value,'utf8').toString('base64'));
});}
function createVault(dir) {fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'credentials.dpapi.json');let values={};if(fs.existsSync(file))values=JSON.parse(fs.readFileSync(file,'utf8'));
  const persist=()=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(values),{mode:0o600});fs.renameSync(tmp,file);};
  return {async get(key){return values[key]?protect(values[key],true):null;},async set(key,value){values[key]=await protect(typeof value==='string'?value:JSON.stringify(value));persist();},async delete(key){delete values[key];persist();},has(key){return !!values[key];}};
}
module.exports={createVault,protect};
