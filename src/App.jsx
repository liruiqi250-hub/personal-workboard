import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import ClockWeather from './ClockWeather.jsx';
import { createDraftRegistry, createRefreshGuard, createVersionMonitor } from './client-version.mjs';
import { DraftRegistryContext } from './DraftGuard.jsx';

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
  const [sourceRequest, setSourceRequest] = useState(null);
  const [loading, setLoading] = useState(isDesktop());
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState('');
  const operation = useRef(null);
  const [wizard, setWizard] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateResult, setUpdateResult] = useState(null);
  const [draftRegistry] = useState(createDraftRegistry);
  const intakeRefreshPending = useRef(false);
  const draftLabels = useSyncExternalStore(draftRegistry.subscribe, draftRegistry.getSnapshot);
  const [backend, setBackend] = useState({ version: '', connected: false });
  const backendVersion = backend.version || data.serverVersion || '';
  const clientMismatch = !!backendVersion && backendVersion !== packageInfo.version;
  const reload = useCallback(async () => {
    if (!isDesktop()) { setLoading(false); return null; }
    try { const next = await api('bootstrap'); setData({ ...initial, ...next, version: packageInfo.version, serverVersion: next.version }); setError(''); return next; }
    catch (e) { setError(e.message); return null; } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (!isDesktop()) return;
    const monitor = createVersionMonitor({ onState: setBackend });
    const check = () => { if (!document.hidden) monitor.check(); };
    check();
    const timer = setInterval(check, 30000);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(timer); window.removeEventListener('focus', check); window.removeEventListener('online', check); document.removeEventListener('visibilitychange', check); monitor.stop(); };
  }, []);
  useEffect(() => {
    const protect = event => { if (draftRegistry.getSnapshot().length) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [draftRegistry]);
  const refreshPage = useMemo(() => createRefreshGuard({
    registry: draftRegistry,
    reload: () => window.location.reload(),
    confirmDiscard: ({ labels, cancel, proceed }) => modal.confirm({ title: '还有未保存的内容', content: `${labels.join('、')}尚未保存。请返回页面保存后再刷新；选择“放弃并刷新”会丢弃这些未保存内容。`, okText: '放弃并刷新', cancelText: '返回继续编辑', autoFocusButton: 'cancel', okButtonProps: { danger: true }, onCancel: cancel, onOk: proceed }),
  }), [draftRegistry, modal]);
  const navigate = (key, request) => {
    if (operation.current) { message.info('当前操作正在完成，请稍后再切换页面。'); return; }
    if (key === page && !request) return;
    const applyNavigation = () => { setPage(key); if (key === 'sources') setSourceRequest(request ? { ...request, key: Date.now() } : null); };
    const labels = draftRegistry.getSnapshot();
    if (!labels.length) { applyNavigation(); return; }
    modal.confirm({ title: '离开前还有未保存的内容', content: `${labels.join('、')}尚未保存。返回继续编辑，或明确放弃后切换页面。`, okText: '放弃并离开', cancelText: '返回继续编辑', autoFocusButton: 'cancel', okButtonProps: { danger: true }, onOk: () => { draftRegistry.clearAll(); applyNavigation(); } });
  };
  useEffect(() => {
    let alive = true;
    reload().then(async next => {
      if (!alive || !next) return;
      if (!next.settings?.onboardingComplete) setWizard(true);
      if (next.settings?.updates?.owner && next.settings?.updates?.repo) {
        try { const result = await api('update.check'); if (alive) { setUpdateResult(result); if (result?.available || ['available', 'verification_available'].includes(result?.status)) setUpdateOpen(true); } }
        catch (e) { if (alive) setUpdateResult({ status: 'error', message: e.message }); }
      }
    });
    return () => { alive = false; };
  }, [reload]);
  useEffect(() => {
    if (!isDesktop() || wizard || page === 'settings' || draftLabels.length || clientMismatch) return;
    const timer = setInterval(() => { if (!document.hidden) reload(); }, 30000);
    return () => clearInterval(timer);
  }, [page, wizard, reload, draftLabels.length, clientMismatch]);
  const run = async (method, payload, success, refresh = true) => {
    if (operation.current) {
      if (!['source.cancel', 'codex.interrupt', 'intake.cancel'].includes(method)) { message.info('当前操作正在完成，请稍后再试。'); return null; }
      try { const result = await api(method, payload); if (success) message.success(success); return result ?? {}; }
      catch (e) { message.error({ content: e.message, duration: 7 }); return null; }
    }
    const request = Symbol(method);
    operation.current = request;
    setBusy(method);
    try { const result = await api(method, payload); if (result?.canceled || result?.cancelled) return null; if (method === 'settings.save') { setUpdateResult(null); setUpdateOpen(false); } if (refresh) await reload(); if (success) message.success(success); return result ?? {}; }
    catch (e) { message.error({ content: e.message, duration: 7 }); return null; } finally { if (operation.current === request) { operation.current = null; setBusy(''); } }
  };
  const intakeComplete = useCallback(() => {
    if (draftRegistry.getSnapshot().length) { intakeRefreshPending.current = true; return; }
    return reload();
  }, [draftRegistry, reload]);
  useEffect(() => {
    if (!draftLabels.length && intakeRefreshPending.current) { intakeRefreshPending.current = false; reload(); }
  }, [draftLabels.length, reload]);
  const checkUpdates = async () => { const result = await run('update.check', {}, '', false); if (result) { setUpdateResult(result); setUpdateOpen(true); } };
  const props = { data, run, busy, navigate, modal };
  const availableUpdate = !['downloaded', 'verified_only'].includes(updateResult?.status) && (updateResult?.available || ['available', 'verification_available'].includes(updateResult?.status));
  const downloadedUpdate = ['downloaded', 'verified_only'].includes(updateResult?.status);
  const verificationOnly = updateResult?.verificationOnly || ['verification_available', 'verified_only'].includes(updateResult?.status) || (downloadedUpdate && updateResult?.canInstall !== true);
  const canDownloadUpdate = availableUpdate && updateResult?.canDownload !== false;
  const canInstallUpdate = downloadedUpdate && updateResult?.canInstall === true;
  const updateUnconfigured = !data.settings.updates?.owner || !data.settings.updates?.repo || !data.settings.updates?.publicKey || updateResult?.status === 'unconfigured';
  const updateChannel = updateResult?.channel || data.settings.updates?.channel || 'stable';
  const updateFailed = updateResult?.status === 'error';
  const updateMessage = updateResult?.message || updateResult?.reason;
  const requestInstall = result => {
    if (result?.status !== 'downloaded' || result?.canInstall !== true) return;
    modal.confirm({ title: updateChannel === 'preview' ? '安装已验证的预览测试版？' : '安装已验证的更新？', content: '安装前会再次核对下载文件，并保留上一程序和对应数据快照。安装期间本机服务会重启，请先保存正在编辑的内容。', okText: '备份并安装更新', cancelText: '稍后', onOk: async () => { const prepared = await run('update.install', {}, ''); if (prepared) { setUpdateResult(prepared); modal.info({ title: '本机更新结果', content: prepared.message || '请核对本机服务返回的更新状态。', okText: '知道了' }); } } });
  };
  const downloadUpdate = async () => { if (!canDownloadUpdate) return; const result = await run('update.download', {}, ''); if (result) { setUpdateResult(result); if (result.canInstall === true) requestInstall(result); } };
  const configuredCount = data.sources.filter(s => s.enabled && s.status === 'connected').length;
  
  return <DraftRegistryContext.Provider value={draftRegistry}><Layout className="app-shell">
    <Layout.Sider width={224} collapsedWidth={76} collapsed={collapsed} breakpoint="lg" onBreakpoint={setCollapsed} className="app-sidebar">
      <div className="brand"><div className="brand-symbol"><CheckSquareOutlined /></div>{!collapsed && <div><strong>个人工作看板</strong><span>把事情一件件做好</span></div>}</div>
      <Menu mode="inline" selectedKeys={[page]} items={navigation} onClick={({ key }) => navigate(key)} aria-label="主导航" />
      <div className="sidebar-bottom">{!collapsed && <div className="local-status"><span className={`status-dot ${isDesktop() ? 'online' : ''}`} /><span>{isDesktop() ? '个人资料保存在本机' : '界面预览'}</span></div>}<Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? '展开导航' : '收起导航'}>{!collapsed && '收起导航'}</Button></div>
    </Layout.Sider>
    <Layout className="main-layout"><header className="topbar"><ClockWeather data={data} run={run} busy={busy} /><Space size={8}><Tooltip title="继续首次设置"><Button type="text" icon={<QuestionCircleOutlined />} disabled={!!busy} onClick={() => setWizard(true)} aria-label="使用向导" /></Tooltip><Button type="text" icon={<ArrowUpOutlined />} disabled={!!busy} onClick={checkUpdates} loading={busy === 'update.check'}>检查更新</Button><Tooltip title="当前页面加载的版本"><Tag bordered={false}>页面 V{packageInfo.version}</Tag></Tooltip></Space></header>
      <main className="workspace" id="main-content">
        {clientMismatch && <Alert className="top-alert client-update-notice" type="info" showIcon title="本机程序已切换版本，请刷新页面" description={<><p>当前页面 V{packageInfo.version}，本机程序 V{backendVersion}。</p><p>{draftLabels.length ? '还有未保存内容，请先保存后再刷新。检测不会清除正在填写的内容。' : '刷新后使用本机程序对应的新版界面。'}</p>{!backend.connected && <p>正在等待本机服务重新连接，连接恢复后可刷新。</p>}</>} action={<Button icon={<ReloadOutlined />} disabled={!backend.connected || !!busy} onClick={refreshPage}>刷新页面</Button>} />}
        {!isDesktop() && <Alert className="top-alert" type="warning" showIcon title="界面预览，未连接本机服务" description="任务、消息和设置尚未读取。请先运行本机启动入口，再打开提供的 localhost 地址。" />}
        {error && <Alert className="top-alert" type="error" showIcon title="本机数据读取失败" description={error} action={<Button disabled={!!busy} onClick={reload} icon={<ReloadOutlined />}>重试</Button>} />}
        {loading ? <div className="loading-state"><Spin size="large" /><p>正在读取本机资料…</p></div> : <>
          {!data.settings?.onboardingComplete && !wizard && page === 'today' && <div className="resume-banner"><div><strong>欢迎使用，先从一件小事开始</strong><p>跟着向导添加任务、选择消息来源，其他设置可以稍后再做。</p></div><Button onClick={() => setWizard(true)}>继续首次设置</Button></div>}
          {(page === 'today' || page === 'tasks') && <TaskView key={page} {...props} onIntakeComplete={intakeComplete} todayOnly={page === 'today'} coverage={configuredCount} onSetup={() => navigate('sources')} />}
          {page === 'sources' && <SourceView {...props} sourceRequest={sourceRequest} />}
          {page === 'reports' && <ReportsView {...props} />}
          {page === 'wechat' && <WechatView {...props} />}
          {page === 'settings' && <SettingsView {...props} checkUpdates={checkUpdates} />}
        </>}
      </main><footer className="app-footer"><span>个人待办事项看板 · 页面 V{packageInfo.version}</span><span>任务依据可追溯 · 完成状态由你确认</span></footer>
    </Layout>
    <Onboarding open={wizard} onClose={() => setWizard(false)} {...props} />
    <Modal open={updateOpen} title="软件更新" onCancel={() => setUpdateOpen(false)} footer={<Space wrap><Button onClick={() => setUpdateOpen(false)}>稍后</Button>{availableUpdate && <Button type="primary" disabled={!canDownloadUpdate} loading={busy.startsWith('update.')} onClick={downloadUpdate}>{verificationOnly ? '仅下载验证' : '下载并验证'}</Button>}{canInstallUpdate && <Button type="primary" loading={busy.startsWith('update.')} onClick={() => requestInstall(updateResult)}>备份并安装更新</Button>}</Space>}>
      <Space wrap><Tag>当前 V{data.version}</Tag><Tag color={updateChannel === 'preview' ? 'orange' : 'default'}>{updateChannel === 'preview' ? '预览测试通道' : '稳定版通道'}</Tag>{updateChannel === 'preview' && (updateResult?.previewTag || data.settings.updates?.previewTag) && <span className="pre-wrap">标签：{updateResult?.previewTag || data.settings.updates?.previewTag}</span>}</Space>
      <Result status={updateFailed ? 'error' : updateUnconfigured ? 'warning' : availableUpdate || downloadedUpdate ? 'info' : 'success'} title={updateFailed ? '检查更新失败' : updateUnconfigured ? '更新来源尚未就绪' : availableUpdate ? `${verificationOnly ? '可验证预览版本' : '发现新版本'} ${updateResult?.version || updateResult?.latestVersion || ''}` : downloadedUpdate ? verificationOnly ? '更新文件已验证，仅供核验' : '更新文件已下载并通过验证' : '本次检查未发现可用更新'} subTitle={updateMessage || (updateUnconfigured ? '请在“我的设置 → 软件更新”选择项目默认来源，或由维护人员配置已核对的自定义来源。' : availableUpdate ? '核对版本说明后下载，签名和文件校验通过后才会开放安装。' : '当前通道没有可安装的新版本。')} />
      {availableUpdate && !canDownloadUpdate && <Alert type="warning" showIcon title="此版本暂不能下载" description={updateMessage || '发布文件或可信签名尚未就绪，请维护人员核对发布资产后重新检查。'} />}
      {downloadedUpdate && !canInstallUpdate && <Alert type="info" showIcon title="本次验证不会安装更新" description={updateMessage || '较旧或相同版本预览仅供验签下载；安装较新预览版还需独立的预览测试启动模式。'} />}
      {updateResult?.notes && <div className="pre-wrap">{updateResult.notes}</div>}
    </Modal>
  </Layout></DraftRegistryContext.Provider>;
}
