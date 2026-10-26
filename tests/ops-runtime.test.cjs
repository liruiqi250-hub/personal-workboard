'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawnSync}=require('node:child_process');
test('Node继承PowerShell7模块路径后，WindowsPowerShell仍加载宿主自带校验和解压命令',{skip:process.platform!=='win32'},()=>{
 const root=path.resolve(__dirname,'..');const q=value=>"'"+value.replaceAll("'","''")+"'";
 const script=`. ${q(path.join(root,'scripts/common.ps1'))}; $h=Get-FileHash -LiteralPath ${q(path.join(root,'package.json'))} -Algorithm SHA256; $c=Get-Command Expand-Archive; if(-not $c){exit 2}; [Console]::Out.Write($h.Hash)`;
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,shell:false,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim().toLowerCase(),crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'package.json'))).digest('hex'));
});

test('WindowsPowerShell严格读取无BOM和BOM中文JSON，错误不回显正文',{skip:process.platform!=='win32'},t=>{
 const os=require('node:os');const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'workboard-json-encoding-'));
 t.after(()=>{const relative=path.relative(os.tmpdir(),dir);assert(relative.startsWith('workboard-json-encoding-')&&!relative.includes(path.sep));fs.rmSync(dir,{recursive:true,force:true});});
 const q=value=>"'"+value.replaceAll("'","''")+"'";
 const value={name:'程序替换未完成，完整旧快照保留',path:'报告/日报_中文.docx'},expected=Buffer.from(value.name,'utf8').toString('base64');
 for(const bom of [false,true]){
  const file=path.join(dir,bom?'bom.json':'plain.json');fs.writeFileSync(file,(bom?'\ufeff':'')+JSON.stringify(value));
  const script=`. ${q(path.join(root,'scripts/common.ps1'))}; $boardJson=Read-BoardJson ${q(file)}; [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($boardJson.name)))`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,shell:false,encoding:'utf8'});assert.equal(result.status,0);assert.equal(result.stdout.trim(),expected);
 }
 const secret='SYNTHETIC_BODY_MUST_NOT_BE_ECHOED',invalid=path.join(dir,'invalid.json');fs.writeFileSync(invalid,'{"private":"'+secret+'"');
 const script=`. ${q(path.join(root,'scripts/common.ps1'))}; try{Read-BoardJson ${q(invalid)};exit 2}catch{[Console]::Out.Write($_.Exception.Message);exit 0}`;
 const rejected=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,shell:false,encoding:'utf8'});assert.equal(rejected.status,0);assert(!rejected.stdout.includes(secret));assert(!rejected.stderr.includes(secret));assert(rejected.stdout.length<300);
});
