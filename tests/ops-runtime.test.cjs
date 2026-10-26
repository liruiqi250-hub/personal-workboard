'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawnSync}=require('node:child_process');
test('Node继承PowerShell7模块路径后，WindowsPowerShell仍加载宿主自带校验和解压命令',{skip:process.platform!=='win32'},()=>{
 const root=path.resolve(__dirname,'..');const q=value=>"'"+value.replaceAll("'","''")+"'";
 const script=`. ${q(path.join(root,'scripts/common.ps1'))}; $h=Get-FileHash -LiteralPath ${q(path.join(root,'package.json'))} -Algorithm SHA256; $c=Get-Command Expand-Archive; if(-not $c){exit 2}; [Console]::Out.Write($h.Hash)`;
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,shell:false,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim().toLowerCase(),crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'package.json'))).digest('hex'));
});
