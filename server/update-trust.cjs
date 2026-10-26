'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { publicKeyInfo, repository } = require('./update-protocol.cjs');
const PROJECT_OWNER = 'liruiqi250-hub';
const PROJECT_REPO = 'personal-workboard';
const TRUST_FILE = path.resolve(__dirname, '../public/update-trust.json');

function readProjectTrust() {
  if (!fs.existsSync(TRUST_FILE)) return {};
  const trust = JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8'));
  if (trust.owner !== PROJECT_OWNER || trust.repo !== PROJECT_REPO) throw Error('内置更新信任的项目绑定不正确');
  return trust;
}

function normalizeUpdateSettings(input = {}, trustOverride) {
  const source = input?.updates || input || {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error('更新来源设置格式不正确');
  const trust = trustOverride === undefined ? readProjectTrust() : trustOverride;
  const enteredOwner = String(source.owner || '').trim(), enteredRepo = String(source.repo || '').trim(), enteredKey = String(source.publicKey || '').trim();
  if (source.sourceMode !== undefined && !['project-default', 'custom'].includes(source.sourceMode)) throw Error('更新来源模式无效');
  const defaultRepository = (!enteredOwner && !enteredRepo) || (enteredOwner === PROJECT_OWNER && enteredRepo === PROJECT_REPO);
  const sourceMode = source.sourceMode || (defaultRepository && !enteredKey ? 'project-default' : 'custom');
  const owner = sourceMode === 'project-default' ? PROJECT_OWNER : enteredOwner, repo = sourceMode === 'project-default' ? PROJECT_REPO : enteredRepo;
  repository(owner, repo);
  const channel = source.channel || 'stable';
  if (!['stable', 'preview'].includes(channel)) throw Error('更新通道无效');
  const previewTag = String(source.previewTag || '').trim();
  if (previewTag && !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(previewTag)) throw Error('预览版本 tag 格式不正确');
  const enteredPublicKey = sourceMode === 'project-default' ? String(trust?.publicKey || '').trim() : enteredKey;
  const info = enteredPublicKey ? publicKeyInfo(enteredPublicKey) : { publicKey: '', keyId: '', fingerprint: '' };
  if (sourceMode === 'project-default' && trust?.keyId && trust.keyId !== info.keyId) throw Error('内置更新公钥标识不匹配');
  if (sourceMode === 'project-default' && trust?.fingerprint && trust.fingerprint !== info.fingerprint) throw Error('内置更新公钥指纹不匹配');
  return { sourceMode, owner, repo, channel, previewTag, publicKey: info.publicKey, keyId: info.keyId, fingerprint: info.fingerprint };
}
function resolveUpdateSettings(input = {}, trustOverride) {
  const source = input?.updates || input || {};
  const owner = String(source.owner || '').trim(), repo = String(source.repo || '').trim(), publicKey = String(source.publicKey || '').trim();
  const defaultRepository = (!owner && !repo) || (owner === PROJECT_OWNER && repo === PROJECT_REPO);
  const sourceMode = source.sourceMode || (defaultRepository && !publicKey ? 'project-default' : 'custom');
  // Built-in trust is program authority: corruption must stay visible, never become a custom fallback.
  if (sourceMode === 'project-default') return normalizeUpdateSettings(source, trustOverride);
  try { return normalizeUpdateSettings(source, trustOverride); }
  catch (error) {
    return { sourceMode, owner: String(source.owner || ''), repo: String(source.repo || ''), channel: source.channel || 'stable', previewTag: String(source.previewTag || ''), publicKey: String(source.publicKey || ''), keyId: '', fingerprint: '', configurationError: `自定义更新来源配置无效：${error.message}` };
  }
}
module.exports = { PROJECT_OWNER, PROJECT_REPO, readProjectTrust, normalizeUpdateSettings, resolveUpdateSettings };
