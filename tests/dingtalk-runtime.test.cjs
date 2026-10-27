'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {compatibleHelp,assertPackage,VERSION,ZIP_SHA,EXE_SHA}=require('../server/dingtalk-runtime.cjs');
test('官方钉钉工具兼容性需准确版本、时间范围分页和只读登录能力',()=>{
 const chat='--start --end --page-all --no-reactions';assert.equal(VERSION,'1.0.65');assert.match(ZIP_SHA,/^[a-f0-9]{64}$/);assert.match(EXE_SHA,/^[a-f0-9]{64}$/);
 assert(compatibleHelp('dws 1.0.65',chat,'--readonly'));
 for(const absent of ['--start','--end','--page-all','--no-reactions'])assert.equal(compatibleHelp('1.0.65',chat.replace(absent,''),'--readonly'),false);
 assert.equal(compatibleHelp('1.0.64',chat,'--readonly'),false);assert.equal(compatibleHelp('11.0.65',chat,'--readonly'),false);assert.equal(compatibleHelp('1.0.65',chat,'refresh login'),false);
});
test('工具原包缺失或大小/hash不符时拒绝，不执行、不覆盖原文件',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workboard-dws-pin-'));t.after(()=>{const rel=path.relative(os.tmpdir(),dir);assert(rel.startsWith('workboard-dws-pin-')&&!rel.includes(path.sep));fs.rmSync(dir,{recursive:true});});
 const file=path.join(dir,'invalid.zip');fs.writeFileSync(file,'synthetic invalid artifact');assert.throws(()=>assertPackage(file),/大小或SHA/);assert.equal(fs.readFileSync(file,'utf8'),'synthetic invalid artifact');assert.throws(()=>assertPackage(path.join(dir,'missing.zip')));
});
