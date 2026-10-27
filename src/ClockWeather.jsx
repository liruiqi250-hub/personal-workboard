import React, { useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Checkbox, Collapse, Form, Input, InputNumber, Modal, Radio, Select, Space, Tag } from 'antd';
import { CloudOutlined, EnvironmentOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { api, isDesktop } from './api.js';
import { useUnsavedDraft } from './DraftGuard.jsx';
import { formatClock, locateOnce, weatherTimestamp } from './weather-utils.mjs';
import './weather.css';

const defaults={enabled:false,consent:false,autoLocate:false,location:null};
export default function ClockWeather({data,run,busy=''}){
 const {modal}=AntApp.useApp();const [clock,setClock]=useState(()=>new Date());
 const [weather,setWeather]=useState(null),[fetching,setFetching]=useState(false),[open,setOpen]=useState(false),[localBusy,setLocalBusy]=useState('');
 const [query,setQuery]=useState(''),[results,setResults]=useState([]),[selected,setSelected]=useState(null),[locationMode,setLocationMode]=useState('geolocation'),[locationError,setLocationError]=useState('');
 const [latitude,setLatitude]=useState(null),[longitude,setLongitude]=useState(null);const [form]=Form.useForm();
 const draft=useUnsavedDraft('weather-settings','天气位置设置');const generation=useRef(0),reading=useRef(false);
 const saved={...defaults,...data.settings?.weather};const signature=JSON.stringify(saved);const consent=Form.useWatch('consent',form);
 const locked=!!localBusy||!!busy;
 useEffect(()=>{const timer=setInterval(()=>setClock(new Date()),1000);return()=>clearInterval(timer);},[]);
 useEffect(()=>()=>{generation.current++;},[]);
 const loadWeather=async()=>{
  if(!isDesktop()||(reading.current?.signature===signature&&reading.current?.id===generation.current))return;const current=++generation.current;reading.current={signature,id:current};setFetching(true);
  try{const result=await api('weather.current');if(generation.current===current)setWeather(result);}
  catch{if(generation.current===current)setWeather({status:'error',message:'天气连接暂时不可用，检查网络后可重试；看板其它功能不受影响。'});}
  finally{if(reading.current?.id===current)reading.current=false;if(generation.current===current)setFetching(false);}
 };
 useEffect(()=>{
  generation.current++;setWeather(null);setFetching(false);
  if(!saved.enabled||!saved.consent){setWeather({status:'disabled',message:'设置位置后可显示当地天气预报。'});return;}
  loadWeather();const timer=setInterval(()=>{if(!document.hidden)loadWeather();},5*60000);return()=>{generation.current++;clearInterval(timer);};
 },[signature]);
 const openSettings=()=>{
  if(locked)return;form.setFieldsValue({enabled:saved.enabled,consent:saved.consent});setSelected(saved.location);setLocationMode(!saved.location||saved.autoLocate?'geolocation':'manual');setQuery(saved.location?.mode==='manual'?saved.location.name:'');setResults([]);setLocationError('');setLatitude(saved.location?.lat??null);setLongitude(saved.location?.lon??null);draft.resetDraft();setOpen(true);
 };
 const closeSettings=()=>{
  if(locked)return;const close=()=>{draft.resetDraft();setOpen(false);};
  if(draft.dirtyRef.current){modal.confirm({title:'天气设置还没有保存',content:'返回继续修改，或明确放弃这次位置与开关修改。',okText:'放弃修改',cancelText:'返回继续修改',autoFocusButton:'cancel',okButtonProps:{danger:true},onOk:close});return;}
  close();
 };
 const getLocation=async()=>{
  if(locked)return null;if(form.getFieldValue('consent')!==true){setLocationError('请先勾选位置与天气服务授权，再使用浏览器定位。');return null;}
  setLocalBusy('locating');setLocationError('');
  try{const result=await locateOnce();setSelected(result);setLatitude(result.lat);setLongitude(result.lon);draft.markDirty();return result;}
  catch(error){setLocationError(error.message);return null;}finally{setLocalBusy('');}
 };
 const findPlace=async()=>{
  if(locked)return;setLocalBusy('searching');setLocationError('');
  try{const result=await api('weather.search',{query});setResults(result.results||[]);if(!result.results?.length)setLocationError(result.message||'本机索引没有找到，请补充省市名称，或改用浏览器定位。');}
  catch(error){setLocationError(error.message);}finally{setLocalBusy('');}
 };
 const saveSettings=async()=>{
  if(locked)return;let location=selected;const value=form.getFieldsValue();
  if(value.enabled&&!value.consent){setLocationError('请先同意向 MET Norway 发送所选坐标来获取天气。');return;}
  if(value.enabled&&!location&&locationMode==='geolocation'){location=await getLocation();if(!location)return;}
  if(value.enabled&&!location){setLocationError('请先查找并选择城市／区县，或使用浏览器定位。');return;}
  setLocalBusy('saving');
  try{const result=await run('settings.save',{weather:{enabled:!!value.enabled,consent:!!value.consent,autoLocate:locationMode==='geolocation',location:location||null}},'天气设置已保存');if(result){draft.resetDraft();setOpen(false);}}
  finally{setLocalBusy('');}
 };
 const manualCoordinates=()=>{
  if(locked)return;const name=query.trim();if(!name||!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180){setLocationError('请填写位置名称和有效的经纬度。');return;}
  setSelected({name,lat:Number(latitude.toFixed(4)),lon:Number(longitude.toFixed(4)),mode:'manual'});setLocationError('');draft.markDirty();
 };
 const time=formatClock(clock),ready=['ready','stale'].includes(weather?.status),weatherName=weather?.location?.name||saved.location?.name||'';
 return <div className="clock-weather">
  <time className="full-clock" dateTime={clock.toISOString()} aria-label={time.full}><span>{time.date}</span><span>{time.weekday}</span><span className="full-clock-time">{time.time}</span></time>
  <div className="weather-line"><Button type="text" className="weather-entry" icon={<CloudOutlined />} onClick={openSettings} disabled={!!busy} loading={fetching} title={ready?`${weatherName} · ${weather.condition} ${weather.temperature}℃ · 点击修改位置`:'设置天气位置'}><span className="weather-entry-text">{ready?`${weatherName} · ${weather.condition} ${Math.round(weather.temperature)}℃`:fetching?'正在读取天气…':weather?.status==='needs_location'?'请选择天气位置':saved.enabled?'天气暂不可用 · 设置':'天气未开启 · 设置'}</span></Button>{ready&&<><Button type="link" size="small" disabled={!!busy} onClick={openSettings}>修改位置</Button><span className="weather-summary-meta">{weather.status==='stale'?'缓存预报':'天气预报'} · 校验 {weatherTimestamp(weather.fetchedAt)}</span></>}{weather?.status==='error'&&<span className="weather-summary-meta">请求失败，可稍后重试</span>}</div>
  <Modal open={open} forceRender title="天气与位置" onCancel={closeSettings} onOk={saveSettings} okText="保存天气设置" cancelText="取消" confirmLoading={!!localBusy} okButtonProps={{disabled:!!busy}} cancelButtonProps={{disabled:locked}} closable={!locked} keyboard={!locked} maskClosable={false} width={650} className="weather-settings-modal" styles={{body:{maxHeight:'calc(100vh - 220px)',overflowY:'auto'}}}>
   <Form form={form} layout="vertical" disabled={locked} onValuesChange={changed=>{if(changed.consent===false)form.setFieldValue('enabled',false);draft.markDirty();}}>
    <Form.Item name="enabled" valuePropName="checked"><Checkbox>在顶部显示当地天气预报</Checkbox></Form.Item>
    <Alert type="info" showIcon title="位置由你决定，只保存最后一次选择" description={<><p>城市／区县名称在本机查找，不发送给第三方。开启天气后，所选坐标会发送至 <a href="https://www.met.no/" target="_blank" rel="noreferrer">MET Norway</a> 获取预报。坐标最多保留四位小数，不保存定位轨迹。</p><p>精确定位使用浏览器正常权限，只读取一次；已保存位置会继续复用，重新定位由你主动操作。</p></>} />
    <Form.Item name="consent" valuePropName="checked" className="weather-consent"><Checkbox>我已阅读 <a href="https://docs.api.met.no/doc/TermsOfService.html" target="_blank" rel="noreferrer">服务条款</a>，同意将所选坐标发送至 MET Norway 获取天气</Checkbox></Form.Item>
    <Form.Item label="怎样选择位置"><Radio.Group value={locationMode} onChange={event=>{setLocationMode(event.target.value);setSelected(null);setLocationError('');draft.markDirty();}} disabled={locked} options={[{value:'geolocation',label:'浏览器精确定位（一次）'},{value:'manual',label:'手动选择城市／区县'}]} /></Form.Item>
    {locationMode==='geolocation'?<div className="weather-location-method"><Button icon={<EnvironmentOutlined />} onClick={getLocation} disabled={locked||!consent} loading={localBusy==='locating'}>{selected?.mode==='geolocation'?'重新定位一次':'获取当前位置'}</Button><p className="muted">首次会由浏览器询问定位权限；拒绝、超时或电脑不支持时，可切换手动选择。</p></div>:<>
     <Form.Item label="城市或区县" extra="使用随程序提供的 GeoNames 索引，只在本机查找；重名时请核对省市。"><Space.Compact className="weather-search"><Input aria-label="天气城市或区县" value={query} onChange={event=>{setQuery(event.target.value);setSelected(null);setResults([]);draft.markDirty();}} onPressEnter={findPlace} placeholder="例如：自贡市自流井区" maxLength={80} disabled={locked} /><Button icon={<SearchOutlined />} onClick={findPlace} loading={localBusy==='searching'} disabled={locked}>本机查找</Button></Space.Compact></Form.Item>
     {!!results.length&&<Form.Item label="选择正确的位置"><Select aria-label="天气位置查找结果" placeholder="核对省市区县后选择" value={null} disabled={locked} options={results.map((item,index)=>({value:index,label:item.name}))} onChange={index=>{setSelected(results[index]);setLatitude(results[index].lat);setLongitude(results[index].lon);setLocationError('');draft.markDirty();}} /></Form.Item>}
     <Collapse ghost items={[{key:'coordinates',label:'高级：已有经纬度时手动填写',children:<><p className="muted">索引未覆盖的位置，也可以填写名称及经纬度。纬度范围 -90～90，经度范围 -180～180。</p><div className="weather-coordinate-fields"><Form.Item label="纬度"><InputNumber aria-label="天气纬度" value={latitude} min={-90} max={90} precision={4} disabled={locked} onChange={value=>{setLatitude(value);draft.markDirty();}} /></Form.Item><Form.Item label="经度"><InputNumber aria-label="天气经度" value={longitude} min={-180} max={180} precision={4} disabled={locked} onChange={value=>{setLongitude(value);draft.markDirty();}} /></Form.Item></div><Button onClick={manualCoordinates} disabled={locked}>使用这组经纬度</Button></>}]} />
    </>}
    {selected&&<div className="weather-selected"><strong>已选位置：{selected.name}</strong><p>{selected.mode==='geolocation'?'浏览器定位':'地名中心或手动坐标'} · 纬度 {selected.lat}，经度 {selected.lon}</p></div>}
    {locationError&&<Alert className="weather-feedback" type="warning" showIcon title="位置尚需确认" description={locationError} action={locationMode==='geolocation'?<Button size="small" disabled={locked} onClick={()=>{setLocationMode('manual');setSelected(null);draft.markDirty();}}>改用手动选择</Button>:undefined} />}
   </Form>
   <div className="weather-preview"><div className="weather-preview-heading"><h3>当前天气预报</h3><Button icon={<ReloadOutlined />} disabled={!saved.enabled||locked||fetching} onClick={loadWeather} loading={fetching}>刷新天气</Button></div>{ready?<><p><strong>{weatherName} · {weather.condition} {weather.temperature}℃</strong> {weather.status==='stale'&&<Tag color="orange">缓存，更新失败</Tag>}</p><p>{weather.humidity!==null&&`湿度 ${weather.humidity}%`}{weather.windSpeed!==null&&` · 风速 ${weather.windSpeed} m/s`}</p><p className="muted">对应预报时刻：{weatherTimestamp(weather.forecastAt)}<br />提供方发布时间：{weatherTimestamp(weather.issuedAt)}<br />本机获取／校验时间：{weatherTimestamp(weather.fetchedAt)}</p></>:<p className="muted">{weather?.message||'保存并开启天气后，请稍候读取。'}</p>}{weather?.status==='stale'&&<Alert type="warning" showIcon title={weather.message} />}</div>
   <p className="weather-attribution">天气：<a href="https://www.met.no/" target="_blank" rel="noreferrer">MET Norway</a>，<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>；已整理为中文和当前时段摘要，属于数值预报，不是气象站实测。<br />本机地名：<a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a>，CC BY 4.0；按行政地名筛选，可能有缺失、旧名或重名。</p>
  </Modal>
 </div>;
}
