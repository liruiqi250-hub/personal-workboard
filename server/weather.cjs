'use strict';
const VERSION=require('../package.json').version;
const fs=require('node:fs'),path=require('node:path');
const MET_URL='https://api.met.no/weatherapi/locationforecast/2.0/compact';
const USER_AGENT=`PersonalWorkboard/${VERSION} https://github.com/liruiqi250-hub/personal-workboard`;
const ATTRIBUTION={provider:'MET Norway',url:'https://www.met.no/',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',dataKind:'数值天气预报，非现场观测'};
const GEOCODER={provider:'GeoNames 本机地名索引',url:'https://www.geonames.org/',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',localSearch:true};
const DEFAULT_WEATHER=Object.freeze({enabled:false,consent:false,autoLocate:false,location:null});
const clone=value=>JSON.parse(JSON.stringify(value));
function point(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.name!=='string'||!value.name.trim()||value.name.length>180||/[\u0000-\u001f]/.test(value.name))throw Error('请选择有效的天气位置');
 if(typeof value.lat!=='number'||typeof value.lon!=='number'||!Number.isFinite(value.lat)||!Number.isFinite(value.lon)||Math.abs(value.lat)>90||Math.abs(value.lon)>180)throw Error('天气位置的经纬度无效');
 if(!['manual','geolocation'].includes(value.mode))throw Error('天气定位方式无效');
 return{name:value.name.trim().slice(0,180),lat:Number(value.lat.toFixed(4)),lon:Number(value.lon.toFixed(4)),mode:value.mode};
}
function normalizeWeatherSettings(previous,input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('天气设置格式不正确');
 const merged={...DEFAULT_WEATHER,...previous};
 for(const key of ['enabled','consent','autoLocate'])if(Object.hasOwn(input,key)){if(typeof input[key]!=='boolean')throw Error('天气开关与位置授权必须明确选择');merged[key]=input[key];}
 if(Object.hasOwn(input,'location'))merged.location=input.location===null?null:point(input.location);
 else if(merged.location)merged.location=point(merged.location);
 if(merged.enabled&&!merged.consent)throw Error('请先同意向天气服务发送所选位置');
 return{enabled:merged.enabled,consent:merged.consent,autoLocate:merged.autoLocate,location:merged.location};
}
const symbols={clearsky:'晴',fair:'晴间多云',partlycloudy:'局部多云',cloudy:'阴',fog:'雾',lightrain:'小雨',rain:'雨',heavyrain:'大雨',lightrainshowers:'小阵雨',rainshowers:'阵雨',heavyrainshowers:'强阵雨',lightsnow:'小雪',snow:'雪',heavysnow:'大雪',lightsleet:'小雨夹雪',sleet:'雨夹雪',heavysleet:'大雨夹雪',lightsnowshowers:'小阵雪',snowshowers:'阵雪',heavysnowshowers:'强阵雪',lightssleetshowers:'小阵雨夹雪',sleetshowers:'阵雨夹雪'};
function conditionLabel(code){if(typeof code!=='string'||code.length>100)return'天气状态未提供';const base=code.replace(/_(?:day|night|polartwilight)$/,'');if(base.includes('thunder'))return'雷阵雨或雷阵雪';return symbols[base]||'天气状态未提供';}
function parseForecast(data,instant){
 const properties=data?.properties,series=properties?.timeseries;
 if(data?.type!=='Feature'||!Array.isArray(series)||!series.length||series.length>1000)throw Error('天气服务返回的数据格式不正确');
 const issued=Date.parse(properties.meta?.updated_at);if(!Number.isFinite(issued)||issued>instant+10*60000||instant-issued>48*3600000)throw Error('天气服务未提供可用的近期预报');
 const candidates=series.filter(x=>Number.isFinite(Date.parse(x?.time))).sort((a,b)=>Math.abs(Date.parse(a.time)-instant)-Math.abs(Date.parse(b.time)-instant));
 const selected=candidates[0];if(!selected||Math.abs(Date.parse(selected.time)-instant)>6*3600000)throw Error('天气服务未提供当前时段的预报');
 const details=selected.data?.instant?.details,temperature=details?.air_temperature;
 if(typeof temperature!=='number'||!Number.isFinite(temperature)||temperature< -100||temperature>70)throw Error('天气温度数据无效');
 const valid=(n,min,max)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max?n:null;
 const summary=selected.data?.next_1_hours?.summary||selected.data?.next_6_hours?.summary||selected.data?.next_12_hours?.summary;
 return{temperature,humidity:valid(details.relative_humidity,0,100),windSpeed:valid(details.wind_speed,0,150),condition:conditionLabel(summary?.symbol_code),forecastAt:new Date(selected.time).toISOString(),issuedAt:new Date(issued).toISOString()};
}
async function boundedJson(response,maxBytes){
 const length=Number(response.headers?.get?.('content-length'));if(length>maxBytes)throw Error('天气服务响应过大');
 let body='';
 if(response.body?.[Symbol.asyncIterator]){let bytes=0;const decoder=new TextDecoder();for await(const part of response.body){bytes+=part.byteLength;if(bytes>maxBytes){response.body.cancel?.().catch?.(()=>{});throw Error('天气服务响应过大');}body+=decoder.decode(part,{stream:true});}body+=decoder.decode();}
 else body=await response.text();
 if(Buffer.byteLength(body)>maxBytes)throw Error('天气服务响应过大');
 return JSON.parse(body);
}
function createWeather({getSettings,fetchImpl=fetch,now=()=>Date.now(),timeoutMs=10000,places}={}){
 if(typeof getSettings!=='function')throw Error('Weather requires settings');
 let cache=null,active=null,placeIndex=null,stopped=false;
 const config=()=>({...DEFAULT_WEATHER,...getSettings().weather});
 const fingerprint=value=>JSON.stringify(value);
 const expiry=response=>{const value=Date.parse(response.headers?.get?.('expires'));return Number.isFinite(value)?Math.max(now()+60000,Math.min(value,now()+6*3600000)):now()+20*60000;};
 const base=()=>({attribution:ATTRIBUTION,geocoder:GEOCODER});
 function request(url,{headers={},signal}={}){return fetchImpl(url,{method:'GET',redirect:'error',headers:{'User-Agent':USER_AGENT,Accept:'application/json',...headers},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});}
 async function current(){
  if(stopped)return{...base(),status:'error',message:'本机服务正在停止，请稍后重新打开。'};
  const selected=config();
  if(!selected.enabled||!selected.consent){active?.controller.abort();return{...base(),status:'disabled',message:'天气未开启，可先设置位置与联网授权。'};}
  if(!selected.location)return{...base(),status:'needs_location',message:'尚未取得位置，请允许一次定位或手动选择城市／区县。'};
  let location;try{location=point(selected.location);}catch{return{...base(),status:'needs_location',message:'保存的位置无效，请重新设置天气位置。'};}
  const key=`${location.lat},${location.lon}`,stamp=fingerprint(selected);
  if(cache?.key===key&&cache.expiresAt>now()){
   try{return{...base(),status:'ready',location,...parseForecast(cache.data,now()),fetchedAt:cache.weather.fetchedAt,cached:true,message:'使用本机缓存的近期预报。'};}catch{cache.expiresAt=0;}
  }
  if(active?.key===key&&active.stamp===stamp)return active.promise;
  active?.controller.abort();const controller=new AbortController(),job={key,stamp,controller,promise:null};
  job.promise=Promise.resolve().then(async()=>{
   try{
    const url=new URL(MET_URL);url.searchParams.set('lat',String(location.lat));url.searchParams.set('lon',String(location.lon));
    const previous=cache?.key===key?cache:null;const headers={};if(previous?.lastModified)headers['If-Modified-Since']=previous.lastModified;
    const response=await request(url,{headers,signal:controller.signal});
    let data;
    if(response.status===304&&previous)data=previous.data;
    else{if(!response.ok)throw Error('weather unavailable');data=await boundedJson(response,1024*1024);}
    const weather={...parseForecast(data,now()),fetchedAt:new Date(now()).toISOString()};
    if(controller.signal.aborted||fingerprint(config())!==stamp)return{...base(),status:'disabled',message:'天气位置或授权已改变，本次请求已停止。'};
    const modified=response.headers?.get?.('last-modified');cache={key,data,weather,expiresAt:expiry(response),lastModified:typeof modified==='string'&&modified.length<100&&!/[\r\n]/.test(modified)&&Number.isFinite(Date.parse(modified))?modified:previous?.lastModified||''};
    return{...base(),status:'ready',location,...clone(weather),cached:response.status===304,message:response.status===203?'天气提供方提示此接口需要后续升级。':''};
   }catch{
    if(controller.signal.aborted||fingerprint(config())!==stamp)return{...base(),status:'disabled',message:'天气位置或授权已改变，本次请求已停止。'};
    if(cache?.key===key&&now()-Date.parse(cache.weather.fetchedAt)<24*3600000)return{...base(),status:'stale',location,...clone(cache.weather),cached:true,message:'暂时无法更新，以下是上次缓存的预报，请留意更新时间。'};
    return{...base(),status:'error',location,message:'天气暂时不可用，请检查网络后重试；看板其它功能可继续使用。'};
   }finally{if(active===job)active=null;}
  });active=job;return job.promise;
 }
 async function search({query}={}){
  if(stopped)throw Error('本机服务正在停止，请稍后重新打开。');
  if(typeof query!=='string'||query.trim().length<2||query.trim().length>80||/[\r\n@/\\]|https?:|\d{6,}|号楼|单元|\d室/.test(query))throw Error('只填写城市或区县名称，例如“自贡市自流井区”，不要填写家庭地址或个人信息');
  const compact=text=>text.toLowerCase().replace(/[\s·,，.()（）-]/g,'');
  const simplified=text=>compact(text).replace(/特别行政区|自治区|自治州|自治县|地区|省|市|县|区/g,'');
  if(!placeIndex){try{const rows=places||JSON.parse(fs.readFileSync(path.join(__dirname,'../public/china-places.json'),'utf8')).places;if(!Array.isArray(rows)||rows.length>20000)throw Error('invalid');placeIndex=rows.map(row=>{const location=point({name:row.label||row.name,lat:row.lat,lon:row.lon,mode:'manual'});return{...location,administrative:typeof row.code==='string'&&row.code.startsWith('ADM'),aliases:[...new Set([row.name,row.label,...(Array.isArray(row.aliases)?row.aliases:[])].filter(x=>typeof x==='string'))].map(compact)};});}catch{throw Error('本机地名索引暂不可用，请使用浏览器定位或手动经纬度。');}}
  const term=compact(query.trim()),simple=simplified(query.trim()),seen=new Set();const results=placeIndex.map(item=>{const exact=item.aliases.includes(term),contains=item.aliases.some(x=>x.includes(term)),loose=simple.length>=2&&item.aliases.some(x=>simplified(x).includes(simple));return{item,score:exact?3:contains?2:loose?1:0};}).filter(x=>x.score).sort((a,b)=>b.score-a.score||Number(b.item.administrative)-Number(a.item.administrative)||a.item.name.length-b.item.name.length).filter(({item})=>{if(seen.has(item.name))return false;seen.add(item.name);return true;}).slice(0,8).map(({item})=>({name:item.name,lat:item.lat,lon:item.lon,mode:'manual'}));
  return{results,geocoder:GEOCODER,message:results.length?'查找在本机完成；请选择正确的省市区县。':'本机索引未找到，可补充省市名称，或改用浏览器定位。'};
 }
 return{current,search,cancelActive(){active?.controller.abort();},stop(){stopped=true;active?.controller.abort();}};
}
module.exports={createWeather,normalizeWeatherSettings,DEFAULT_WEATHER,parseForecast,conditionLabel,point,ATTRIBUTION,GEOCODER,MET_URL,USER_AGENT};
