'use strict';
const roots = new Set(['.gitignore','package.json','package-lock.json','index.html','vite.config.mjs','README.md','AGENTS.md','CHANGELOG.md']);
const docs = new Set(['docs/INSTALL_FOR_CODEX.md','docs/RELEASE_FOR_CODEX.md']);
const server = new Set(['main.cjs','store.cjs','vault.cjs','extract.cjs','sources.cjs','updates.cjs','wechat.cjs','codex.cjs','reports.cjs','managed-codex-store.cjs','outbound.cjs','collectors.cjs','wechat-export-runner.cjs','update-protocol.cjs','update-trust.cjs','publisher-keys.cjs'].map(x=>'server/'+x));
const scripts = new Set(['common.ps1','deploy.ps1','start.ps1','stop.ps1','diagnose.ps1','update.ps1','rollback.ps1','maintenance.ps1','maintenance-engine.cjs','maintenance-legacy.cjs','package.cjs','package-policy.cjs','validate-package.cjs','frontend-notices.cjs','sign-update.cjs','启动看板.cmd','首次部署.cmd','停止看板.cmd'].map(x=>'scripts/'+x));
const tests = new Set(['bridge.test.cjs','reports.test.cjs','sources.test.cjs','store.test.cjs','updates.test.cjs','scheduler.test.cjs','codex-persistence.test.cjs','wechat-files.test.cjs','collectors.test.cjs','outbound.test.cjs','main-remote.test.cjs','ops-runtime.test.cjs','notices.test.cjs','update-protocol.test.cjs','signing.test.cjs','update-start.test.cjs','maintenance.test.cjs','maintenance-legacy.test.cjs'].map(x=>'tests/'+x));
const prefixes = ['dist/','src/','public/','node_modules/'];
function allowed(name) {
  const p=name.replace(/\\/g,'/');
  if(p.startsWith('/')||p.includes(':')||p.split('/').some(x=>x==='..'||x==='.'||x==='')) return false;
  if(/(?:^|\/)(?:\.env(?:\..*)?|private|work|oversight|verification|specs|plans|\.git|credentials\.dpapi\.json|service\.json)(?:\/|$)/i.test(p)) return false;
  if(/\.(?:sqlite(?:-wal|-shm)?|db|pem|pfx|key|log)$/i.test(p)) return false;
  if(/\.dpapi\.json$/i.test(p)) return false;
  return roots.has(p)||docs.has(p)||server.has(p)||scripts.has(p)||tests.has(p)||['vendor/node/node.exe','vendor/node/LICENSE'].includes(p)||prefixes.some(x=>p.startsWith(x));
}
module.exports={roots,docs,prefixes,allowed};
