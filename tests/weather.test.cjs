'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWeather,normalizeWeatherSettings,DEFAULT_WEATHER,parseForecast,USER_AGENT}=require('../server/weather.cjs');
const start=Date.parse('2026-10-27T05:16:28Z');
const location={name:'合成城市',lat:39.9042345,lon:116.4074456,mode:'manual'};
const forecast=()=>({type:'Feature',properties:{meta:{updated_at:'2026-10-27T04:00:00Z'},timeseries:[5,6,7].map(hour=>({time:`2026-10-27T0${hour}:00:00Z`,data:{instant:{details:{air_temperature:20+hour,relative_humidity:65,wind_speed:3}},next_1_hours:{summary:{symbol_code:'cloudy'}}}}))}});
const response=(data,{status=200,headers={}}={})=>({status,ok:status>=200&&status<300,headers:{get:key=>headers[key.toLowerCase()]||null},text:async()=>JSON.stringify(data)});
function setup(fetchImpl,options={}){let settings={weather:{...DEFAULT_WEATHER,enabled:true,consent:true,location:{...location}}},time=start;const weather=createWeather({getSettings:()=>settings,fetchImpl,now:()=>time,...options});return{weather,set(value){settings={weather:{...settings.weather,...value}};},advance(ms){time+=ms;},get settings(){return settings;}};}

test('天气设置严格校验授权和坐标，仅保留最后位置且最多四位小数',()=>{
 const saved=normalizeWeatherSettings(DEFAULT_WEATHER,{enabled:true,consent:true,autoLocate:false,location});assert.equal(saved.location.lat,39.9042);assert.equal(saved.location.lon,116.4074);assert.deepEqual(Object.keys(saved).sort(),['autoLocate','consent','enabled','location']);
 assert.equal(normalizeWeatherSettings(saved,{enabled:false}).location.name,'合成城市');
 for(const value of [null,[],{enabled:'true'},{enabled:true},{location:{...location,lat:999}},{location:{...location,lat:'39.9'}},{location:{...location,name:'x\ny'}},{location:{...location,mode:'tracking'}}])assert.throws(()=>normalizeWeatherSettings(DEFAULT_WEATHER,value));
});

test('未开启、未授权和未选择位置不向天气提供方发送请求',async()=>{
 let count=0;const f=setup(async()=>{count++;return response(forecast());});f.set({enabled:false});assert.equal((await f.weather.current()).status,'disabled');f.set({enabled:true,consent:false});assert.equal((await f.weather.current()).status,'disabled');f.set({consent:true,location:null});assert.equal((await f.weather.current()).status,'needs_location');assert.equal(count,0);
});

test('天气只请求固定HTTPS提供方，真实UA、四位坐标、超时信号与缓存生效',async()=>{
 const calls=[];const f=setup(async(url,options)=>{calls.push({url,options});return response(forecast(),{headers:{expires:new Date(start+3600000).toUTCString()}});});
 const result=await f.weather.current();assert.equal(result.status,'ready');assert.equal(result.temperature,25);assert.equal(result.condition,'阴');assert.equal(result.attribution.dataKind,'数值天气预报，非现场观测');assert.equal(calls.length,1);const url=new URL(calls[0].url);assert.equal(url.origin,'https://api.met.no');assert.equal(url.searchParams.get('lat'),'39.9042');assert.equal(url.searchParams.get('lon'),'116.4074');assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers['User-Agent'],USER_AGENT);assert.match(USER_AGENT,/github\.com\/liruiqi250-hub\/personal-workboard/);assert(calls[0].options.signal instanceof AbortSignal);assert(!('Authorization'in calls[0].options.headers));
 const cached=await f.weather.current();assert.equal(cached.cached,true);assert.equal(calls.length,1);
});

test('相同位置的在途天气请求合并，不重复请求提供方',async()=>{
 let finish,count=0;const f=setup(()=>{count++;return new Promise(resolve=>{finish=resolve;});});const first=f.weather.current(),second=f.weather.current();await Promise.resolve();assert.equal(count,1);finish(response(forecast()));assert.equal((await first).status,'ready');assert.equal((await second).status,'ready');assert.equal(count,1);
});

test('缓存内按当前时段重新选择预报，304校验后不会一直显示旧小时',async()=>{
 let count=0;const f=setup(async()=>{count++;return count===1?response(forecast(),{headers:{expires:new Date(start+60000).toUTCString(),'last-modified':'Tue, 27 Oct 2026 04:00:00 GMT'}}):response(null,{status:304,headers:{expires:new Date(start+4*3600000).toUTCString()}});});
 assert.equal((await f.weather.current()).temperature,25);f.advance(55*60000);const newer=await f.weather.current();assert.equal(newer.temperature,26);assert.equal(newer.cached,true);assert.equal(count,2);f.advance(60*60000);assert.equal((await f.weather.current()).temperature,27);assert.equal(count,2);
});

test('网络失败显示陈旧标记和原校验时间，不把缓存冒充新天气',async()=>{
 let count=0;const f=setup(async()=>{if(++count>1)throw Error('SYNTHETIC_PRIVATE_DIAGNOSTIC');return response(forecast(),{headers:{expires:new Date(start+60000).toUTCString()}});});const first=await f.weather.current();f.advance(2*60000);const stale=await f.weather.current();assert.equal(stale.status,'stale');assert.equal(stale.fetchedAt,first.fetchedAt);assert.match(stale.message,/上次缓存/);assert(!JSON.stringify(stale).includes('PRIVATE_DIAGNOSTIC'));
});

test('坏数据、过大响应和同步请求异常不污染缓存，也不阻断下一次重试',async()=>{
 let count=0;const f=setup(()=>{count++;if(count===1)throw Error('sync');if(count===2)return Promise.resolve(response(null,{headers:{'content-length':String(2*1024*1024)}}));return Promise.resolve(response(forecast()));});
 assert.equal((await f.weather.current()).status,'error');assert.equal((await f.weather.current()).status,'error');assert.equal((await f.weather.current()).status,'ready');assert.equal(count,3);
 for(const data of [null,{},forecast().properties, {...forecast(),properties:{meta:{updated_at:'2026-01-01'},timeseries:[]}}])assert.throws(()=>parseForecast(data,start));
});

test('定位或授权在请求中改变时不接收旧结果，旧点不写到新点缓存',async()=>{
 let finish,signal;const f=setup((_,options)=>{signal=options.signal;return new Promise(resolve=>{finish=resolve;});});const pending=f.weather.current();await Promise.resolve();f.set({consent:false});f.weather.cancelActive();assert.equal(signal.aborted,true);finish(response(forecast()));assert.equal((await pending).status,'disabled');assert.equal((await f.weather.current()).status,'disabled');
});

test('有界天气超时失败只影响天气，停止后不再联网',async()=>{
 let count=0;const f=setup((_,{signal})=>{count++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true}));},{timeoutMs:10});const keep=setTimeout(()=>{},1000);try{assert.equal((await f.weather.current()).status,'error');}finally{clearTimeout(keep);}f.weather.stop();assert.equal((await f.weather.current()).status,'error');await assert.rejects(f.weather.search({query:'自贡市'}),/停止/);assert.equal(count,1);
});

test('城市区县名称仅用GeoNames本机索引查找，不要求联网或外发同意',async()=>{
 let count=0;const f=setup(()=>{count++;throw Error('must not connect');},{places:[{name:'自流井区',label:'四川省 · 自贡市 · 自流井区',aliases:['Ziliujing'],lat:29.335,lon:104.773},{name:'长宁区',label:'上海市 · 长宁区',aliases:['Changning'],lat:31.22,lon:121.42}]});f.set({enabled:false,consent:false});const found=await f.weather.search({query:'自贡自流井'});assert.equal(found.results.length,1);assert.equal(found.results[0].name,'四川省 · 自贡市 · 自流井区');assert.equal(found.geocoder.localSearch,true);assert.equal((await f.weather.search({query:'Ziliujing'})).results.length,1);assert.equal(count,0);await assert.rejects(f.weather.search({query:'person@example.com'}),/城市或区县/);
});

test('随包GeoNames索引与元数据hash一致，具有来源、许可和可用中文区县',async()=>{
 const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const raw=fs.readFileSync(path.join(__dirname,'../public/china-places.json'));const meta=JSON.parse(fs.readFileSync(path.join(__dirname,'../public/china-places-meta.json'),'utf8'));const data=JSON.parse(raw);
 assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),meta.datasetSha256);assert.equal(raw.length,meta.datasetBytes);assert.equal(data.places.length,meta.count);assert(data.places.length>1000);assert.equal(meta.license,'CC BY 4.0');assert.equal(meta.source,'https://download.geonames.org/export/dump/CN.zip');assert.equal(meta.localSearch,true);assert(data.places.some(x=>x.name==='自流井区'));for(const row of data.places){assert(Number.isFinite(row.lat)&&Math.abs(row.lat)<=90);assert(Number.isFinite(row.lon)&&Math.abs(row.lon)<=180);assert.equal(Number(row.lat.toFixed(4)),row.lat);assert.equal(Number(row.lon.toFixed(4)),row.lon);}
 const lookup=createWeather({getSettings:()=>({}),fetchImpl:()=>{throw Error('not allowed');}});const actual=await lookup.search({query:'自贡市自流井区'});assert.equal(actual.results.length,1);assert.match(actual.results[0].name,/四川省.*自贡市.*自流井区/);
});

test('完整时钟使用北京时间，年份星期秒数来自传入时刻而非硬编码',async()=>{
 const {formatClock}=await import('../src/weather-utils.mjs');assert.equal(formatClock(new Date('2026-10-27T05:16:28Z')).full,'2026年10月27日 星期二 13:16:28');assert.equal(formatClock(new Date('2026-10-27T05:16:29Z')).time,'13:16:29');assert.equal(formatClock(new Date('2026-12-31T16:00:00Z')).full,'2027年1月1日 星期五 00:00:00');
});

test('浏览器定位只读一次，高精度及缓存参数明确，不使用追踪接口',async()=>{
 const {locateOnce}=await import('../src/weather-utils.mjs');let count=0;const result=await locateOnce({getCurrentPosition(success,error,options){count++;assert.equal(options.enableHighAccuracy,true);assert.equal(options.maximumAge,1800000);assert.equal(options.timeout,12000);success({coords:{latitude:39.904234,longitude:116.407445}});},watchPosition(){throw Error('must not watch');}});assert.equal(count,1);assert.equal(result.lat,39.9042);assert.equal(result.lon,116.4074);assert.equal(result.mode,'geolocation');
 for(const code of [1,2,3])await assert.rejects(locateOnce({getCurrentPosition(success,error){error({code});}}),/定位|位置/);await assert.rejects(locateOnce({}),/不支持/);
});
