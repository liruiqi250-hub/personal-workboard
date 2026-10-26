import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode><ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#167d82', colorSuccess: '#2f7757', colorError: '#b53b42', colorText: '#172b32', colorTextSecondary: '#536971', colorBgLayout: '#f5f7f8', fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif', fontSize: 15, borderRadius: 8, controlHeight: 38 }, components: { Layout: { siderBg: '#ffffff', bodyBg: '#f5f7f8' }, Menu: { itemHeight: 46, itemSelectedBg: '#e8f3f2', itemSelectedColor: '#136e73' }, Button: { fontWeight: 500 } } }}><AntApp><App /></AntApp></ConfigProvider></React.StrictMode>
);
