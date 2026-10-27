const formatter=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'numeric',day:'numeric',weekday:'long',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export function formatClock(value=new Date()){
 const parts=Object.fromEntries(formatter.formatToParts(value).map(part=>[part.type,part.value]));
 const date=`${parts.year}年${parts.month}月${parts.day}日`,time=`${parts.hour}:${parts.minute}:${parts.second}`;
 return{date,weekday:parts.weekday,time,full:`${date} ${parts.weekday} ${time}`};
}
export function weatherTimestamp(value){const date=new Date(value);return value&&!Number.isNaN(date.getTime())?formatClock(date).full:'尚无记录';}
export function locateOnce(geolocation=globalThis.navigator?.geolocation){
 if(typeof geolocation?.getCurrentPosition!=='function')return Promise.reject(new Error('这个浏览器暂不支持定位，请手动选择城市／区县。'));
 return new Promise((resolve,reject)=>{
  geolocation.getCurrentPosition(position=>{
   const lat=position?.coords?.latitude,lon=position?.coords?.longitude;
   if(typeof lat!=='number'||typeof lon!=='number'||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return reject(new Error('浏览器没有返回有效位置，请手动选择城市／区县。'));
   resolve({name:'当前位置（浏览器定位）',lat:Number(lat.toFixed(4)),lon:Number(lon.toFixed(4)),mode:'geolocation'});
  },error=>reject(new Error(error?.code===1?'浏览器未允许定位。可以在地址栏管理权限，或改用手动选择城市／区县。':error?.code===3?'定位等待超时，请重试或手动选择城市／区县。':'暂时无法取得位置，请重试或手动选择城市／区县。')),{enableHighAccuracy:true,timeout:12000,maximumAge:30*60000});
 });
}
