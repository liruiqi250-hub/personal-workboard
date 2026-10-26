import React, { useCallback, useEffect, useState } from 'react';
import packageInfo from '../package.json';
import { Alert, App as AntApp, Button, Layout, Menu, Modal, Result, Space, Spin, Tag, Tooltip } from 'antd';
import { CalendarOutlined, CheckSquareOutlined, CloudSyncOutlined, FileTextOutlined, WechatOutlined, SettingOutlined, MenuFoldOutlined, MenuUnfoldOutlined, ReloadOutlined, QuestionCircleOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { api, isDesktop, localDate } from './api.js';
import TaskView from './TaskView.jsx';
import SourceView from './SourceView.jsx';
import ReportsView from './ReportsView.jsx';
import WechatView from './WechatView.jsx';
import SettingsView from './SettingsView.jsx';
import Onboarding from './Onboarding.jsx';

const initial = { version: packageInfo.version, tasks: [], sources: [], settings: {}, reports: [], deliveries: [], messages: [], connections: {}, update: {}, paths: {}, activity: [] };
const navigation = [
  { key: 'today', icon: <CalendarOutlined />, label: '今天要做' }, { key: 'tasks', icon: <CheckSquareOutlined />, label: '全部任务' },
  { key: 'sources', icon: <CloudSyncOutlined />, label: '消息来源' }, { key: 'reports', icon: <FileTextOutlined />, label: '日报周报' },
  { key: 'wechat', icon: <WechatOutlined />, label: '微信助手' }, { key: 'settings', icon: <SettingOutlined />, label: '我的设置' },
];

export default function App() {
  const { message, modal } = AntApp.useApp();
  const [data, setData] = useState(initial);
  const [page, setPage] = useState('today');
  const [loading, setLoading] = useState(isDesktop());
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState('');
  const [wizard, setWizard] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateResult, setUpdateResult] = useState(null);
  const reload = useCallback(async () => {
    if (!isDesktop()) { setLoading(false); return null; }
    try { const next = await api('bootstrap'); setData({ ...initial, ...next }); setError(''); return next; }
    catch (e) { setError(e.message); return null; } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    let alive = true;
    reload().then(async next => {
      if (!alive || !next) return;
      if (!next.settings?.onboardingComplete) setWizard(true);
      if (next.settings?.updates?.owner && next.settings?.updates?.repo) {
        try { const result = await api('update.check'); if (alive) { setUpdateResult(result); if (result?.available || result?.status === 'available') setUpdateOpen(true); } }
        catch (e) { if (alive) setUpdateResult({ status: 'error', message: e.message }); }
      }
    });
    return () => { alive = false; };
  }, [reload]);
  useEffect(() => {
    if (!isDesktop() || wizard || page === 'settings') return;
    const timer = setInterval(() => { if (!document.hidden) reload(); }, 30000);
    return () => clearInterval(timer);
  }, [page, wizard, reload]);
  const run = async (method, payload, success, refresh = true) => {
    setBusy(method);
    try { const result = await api(method, payload); if (result?.canceled || result?.cancelled) return null; if (refresh) await reload(); if (success) message.success(success); return result ?? {}; }
    catch (e) { message.error({ content: e.message, duration: 7 }); return null; } finally { setBusy(''); }
  };
  const checkUpdates = async () => { const result = await run('update.check', {}, '', false); if (result) { setUpdateResult(result); setUpdateOpen(true); } };
  const props = { data, run, busy, navigate: setPage, modal };
  const availableUpdate = updateResult?.available || updateResult?.status === 'available';
  const downloadedUpdate = updateResult?.status === 'downloaded';
  const updateUnconfigured = !data.settings.updates?.owner || !data.settings.updates?.repo || !data.settings.updates?.publicKey || updateResult?.status === 'unconfigured';
  const configuredCount = data.sources.filter(s => s.enabled && s.status === 'connected').length;
  const date = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  return <Layout className="app-shell">
    <Layout.Sider width={224} collapsedWidth={76} collapsed={collapsed} breakpoint="lg" onBreakpoint={setCollapsed} className="app-sidebar">
      <div className="brand"><div className="brand-symbol"><CheckSquareOutlined /></div>{!collapsed && <div><strong>个人工作看板</strong><span>把事情一件件做好</span></div>}</div>
      <Menu mode="inline" selectedKeys={[page]} items={navigation} onClick={({ key }) => setPage(key)} aria-label="主导航" />
      <div className="sidebar-bottom">{!collapsed && <div className="local-status"><span className={`status-dot ${isDesktop() ? 'online' : ''}`} /><span>{isDesktop() ? '个人资料保存在本机' : '界面预览'}</span></div>}<Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? '展开导航' : '收起导航'}>{!collapsed && '收起导航'}</Button></div>
    </Layout.Sider>
    <Layout className="main-layout"><header className="topbar"><span>{date}</span><Space size={8}><Tooltip title="继续首次设置"><Button type="text" icon={<QuestionCircleOutlined />} onClick={() => setWizard(true)} aria-label="使用向导" /></Tooltip><Button type="text" icon={<ArrowUpOutlined />} onClick={checkUpdates} loading={busy === 'update.check'}>检查更新</Button><Tag bordered={false}>V{data.version}</Tag></Space></header>
      <main className="workspace" id="main-content">
        {!isDesktop() && <Alert className="top-alert" type="warning" showIcon title="界面预览，未连接本机服务" description="任务、消息和设置尚未读取。请先运行本机启动入口，再打开提供的 localhost 地址。" />}
        {error && <Alert className="top-alert" type="error" showIcon title="本机数据读取失败" description={error} action={<Button onClick={() => { setLoading(true); reload(); }} icon={<ReloadOutlined />}>重试</Button>} />}
        {loading ? <div className="loading-state"><Spin size="large" /><p>正在读取本机资料…</p></div> : <>
          {!data.settings?.onboardingComplete && !wizard && page === 'today' && <div className="resume-banner"><div><strong>欢迎使用，先从一件小事开始</strong><p>跟着向导添加任务、选择消息来源，其他设置可以稍后再做。</p></div><Button onClick={() => setWizard(true)}>继续首次设置</Button></div>}
          {(page === 'today' || page === 'tasks') && <TaskView {...props} todayOnly={page === 'today'} coverage={configuredCount} onSetup={() => setPage('sources')} />}
          {page === 'sources' && <SourceView {...props} />}
          {page === 'reports' && <ReportsView {...props} />}
          {page === 'wechat' && <WechatView {...props} />}
          {page === 'settings' && <SettingsView {...props} checkUpdates={checkUpdates} />}
        </>}
      </main><footer className="app-footer"><span>个人待办事项看板 V{data.version}</span><span>任务依据可追溯 · 完成状态由你确认</span></footer>
    </Layout>
    <Onboarding open={wizard} onClose={() => setWizard(false)} {...props} />
    <Modal open={updateOpen} title="软件更新" onCancel={() => setUpdateOpen(false)} footer={<Space><Button onClick={() => setUpdateOpen(false)}>稍后</Button>{availableUpdate && <Button type="primary" loading={busy.startsWith('update.')} onClick={async () => { const r = await run('update.download', {}, ''); if (r) { setUpdateResult(r); modal.confirm({ title: '准备本机更新？', content: '下载文件已返回，下一步先备份本机数据，再显示实际更新结果。请按本机服务返回的说明完成替换与重启。', okText: '备份并准备更新', cancelText: '稍后', onOk: async () => { const prepared = await run('update.install', {}, ''); if (prepared) { setUpdateResult(prepared); modal.info({ title: '本机更新准备结果', content: prepared.message || '请核对本机服务返回的更新状态。', okText: '知道了' }); } } }); } }}>下载更新</Button>}</Space>}>
      <Result status={availableUpdate ? 'info' : updateUnconfigured ? 'warning' : downloadedUpdate ? 'info' : 'success'} title={availableUpdate ? `发现新版本 ${updateResult?.version || updateResult?.latestVersion || ''}` : downloadedUpdate ? '更新文件已下载并通过验证' : updateUnconfigured ? '更新服务待配置' : '本次检查未发现可用更新'} subTitle={updateResult?.message || updateResult?.reason || (availableUpdate ? '核对版本说明后下载。安装前会验证发布文件。' : '请在“我的设置 → 软件更新”配置正式 GitHub 发布仓库及签名公钥。')} />
      {updateResult?.notes && <div className="pre-wrap">{updateResult.notes}</div>}
    </Modal>
  </Layout>;
}
