'use strict';
const crypto=require('node:crypto');
const MAX_UPDATE_BYTES=400*1024*1024;
const VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HEX=/^[a-f0-9]{64}$/;
const FIELDS=['schema','algorithm','owner','repo','channel','version','tag','assetName','platform','url','sha256','bytes','keyId','sequence','createdAt'];
function fail(message){throw Error('更新清单无效：'+message);}
function repository(owner,repo){if(typeof owner!=='string'||!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)||typeof repo!=='string'||!/^[A-Za-z0-9_.-]{1,100}$/.test(repo)||['.','..'].includes(repo))fail('仓库名称格式不正确');return {owner,repo};}
function manifestAssetUrl({owner,repo,tag,assetName}){repository(owner,repo);if(typeof tag!=='string'||!/^v\d+\.\d+\.\d+$/.test(tag)||typeof assetName!=='string'||!/^[A-Za-z0-9_.-]+$/.test(assetName))fail('发行标签或资产名称不正确');return `https://github.com/${owner}/${repo}/releases/download/${tag}/${assetName}`;}
function keyObject(value,isPrivate=false){
 let key;try{key=value&&typeof value==='object'&&value.asymmetricKeyType?value:(isPrivate?crypto.createPrivateKey(value):crypto.createPublicKey(value));if(!isPrivate&&key.type==='private')key=crypto.createPublicKey(key);}catch{throw Error('发布签名密钥格式不可用');}
 if(key.asymmetricKeyType!=='ed25519'||isPrivate&&key.type!=='private'||!isPrivate&&key.type!=='public')throw Error('发布签名只支持 Ed25519 密钥');return key;
}
function publicKeyInfo(value){const key=keyObject(value);const der=key.export({type:'spki',format:'der'}),keyId=crypto.createHash('sha256').update(der).digest('hex');return {publicKey:key.export({type:'spki',format:'pem'}).toString(),keyId,fingerprint:'SHA256:'+keyId};}
function validatePayload(input,expected={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==FIELDS.length||Object.keys(input).some(key=>!FIELDS.includes(key)))fail('字段不完整或包含未支持字段');
 if(input.schema!==1||input.algorithm!=='Ed25519')fail('签名协议版本不支持');repository(input.owner,input.repo);
 if(!['stable','preview'].includes(input.channel))fail('发布通道不支持');
 if(typeof input.version!=='string'||!VERSION.test(input.version)||input.version.split('.').some(part=>!Number.isSafeInteger(Number(part))))fail('版本号须为三段数字');
 if(input.tag!=='v'+input.version||input.assetName!==`personal-workboard-${input.version}-windows-x64.zip`||input.platform!=='win32-x64')fail('版本、标签、平台或资产名称不匹配');
 if(input.url!==manifestAssetUrl(input))fail('资产地址不属于清单声明的仓库和标签');
 if(typeof input.sha256!=='string'||!HEX.test(input.sha256)||typeof input.keyId!=='string'||!HEX.test(input.keyId))fail('文件或公钥指纹格式不正确');
 if(!Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>MAX_UPDATE_BYTES)fail('更新文件大小超出限制');
 if(!Number.isSafeInteger(input.sequence)||input.sequence<1)fail('发布序号须为正整数');
 if(typeof input.createdAt!=='string'||input.createdAt.length>32||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.createdAt)||Number.isNaN(Date.parse(input.createdAt))||new Date(input.createdAt).toISOString()!==input.createdAt)fail('签发时间格式不正确');
 for(const field of FIELDS)if(Object.hasOwn(expected,field)&&input[field]!==expected[field])fail('与当前选择的来源或实际发行资产不一致（'+field+'）');
 if(expected.maxBytes!==undefined&&input.bytes>expected.maxBytes)fail('更新文件大小超过调用限制');
 return Object.fromEntries(FIELDS.map(field=>[field,input[field]]));
}
function createManifestPayload(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!FIELDS.includes(key)))fail('不支持的签发参数');
 const version=input.version,tag=input.tag||'v'+version,assetName=input.assetName||`personal-workboard-${version}-windows-x64.zip`;
 return validatePayload({schema:input.schema??1,algorithm:input.algorithm||'Ed25519',owner:input.owner,repo:input.repo,channel:input.channel||'stable',version,tag,assetName,platform:input.platform||'win32-x64',url:input.url||manifestAssetUrl({...input,tag,assetName}),sha256:input.sha256,bytes:input.bytes,keyId:input.keyId,sequence:input.sequence,createdAt:input.createdAt||new Date().toISOString()});
}
function serializePayload(input){return JSON.stringify(validatePayload(input));}
function signManifest(input,privateKey){const payload=validatePayload(input),key=keyObject(privateKey,true);if(publicKeyInfo(key).keyId!==payload.keyId)fail('签名私钥与清单公钥指纹不匹配');const signature=crypto.sign(null,Buffer.from(serializePayload(payload),'utf8'),key).toString('base64');return {...payload,signature};}
function verifyManifest(manifest,publicKey,expected={}){
 if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||Object.keys(manifest).length!==FIELDS.length+1||!Object.hasOwn(manifest,'signature'))fail('签名字段缺失或结构不正确');
 const {signature,...raw}=manifest,payload=validatePayload(raw,expected),info=publicKeyInfo(publicKey);
 if(payload.keyId!==info.keyId)throw Error('发布公钥指纹不匹配，已停止更新');
 if(typeof signature!=='string'||signature.length!==88||!/^[A-Za-z0-9+/]{86}==$/.test(signature))throw Error('更新签名格式不正确');
 const bytes=Buffer.from(signature,'base64');if(bytes.length!==64||bytes.toString('base64')!==signature||!crypto.verify(null,Buffer.from(serializePayload(payload),'utf8'),keyObject(publicKey),bytes))throw Error('更新签名验证未通过，已停止更新');
 return payload;
}
module.exports={MAX_UPDATE_BYTES,FIELDS,repository,manifestAssetUrl,publicKeyInfo,validatePayload,createManifestPayload,serializePayload,signManifest,verifyManifest};
