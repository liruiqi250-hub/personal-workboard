import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Progress, Space, Tag } from 'antd';
import { SyncOutlined } from '@ant-design/icons';
import { api, isDesktop, sourceLabels } from './api.js';
import './source-setup.css';

const active = job => ['running', 'cancelling'].includes(job?.status);
const resultLabels = { pending: ['等待整理', 'default'], running: ['正在整理', 'processing'], success: ['本轮已整理', 'success'], failed: ['整理失败', 'error'], skipped: ['本轮未读取', 'warning'], cancelled: ['已取消', 'default'], interrupted: ['待核对', 'warning'] };

export function useIntake({ run, onComplete, hasEnabledSources }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const startLock = useRef(false);
  const lastStartAt = useRef(-Infinity);
  const cancelLock = useRef(false);
  const alive = useRef(true);
  const latestJob = useRef(null);
  const completed = useRef(new Set());
  const queryEpoch = useRef(0);
  const callback = useRef(onComplete);
  callback.current = onComplete;
  const receive = useCallback(next => {
    if (!alive.current) return;
    latestJob.current = next;
    setJob(next);
    if (next?.id && !active(next) && !completed.current.has(next.id)) {
      completed.current.add(next.id);
      if (completed.current.size > 50) completed.current.delete(completed.current.values().next().value);
      Promise.resolve(callback.current?.()).catch(() => {});
    }
  }, []);
  const running = active(job);
  useEffect(() => {
    alive.current = true;
    let current = true;
    let timer;
    const poll = async () => {
      const epoch = queryEpoch.current;
      try { const next = await api('intake.status'); if (current && alive.current && epoch === queryEpoch.current) { receive(next); setError(''); } }
      catch { if (current && alive.current && active(latestJob.current)) setError('暂时无法读取整理进度，已入库的内容会保留。请稍后重试连接，勿重复开始。'); }
      finally { if (current && alive.current) timer = setTimeout(poll, active(latestJob.current) ? 1200 : 10000); }
    };
    if (isDesktop()) poll();
    return () => { current = false; alive.current = false; clearTimeout(timer); };
  }, [receive, running]);
  const start = async () => {
    if (startLock.current || active(latestJob.current)) return;
    const now = performance.now();
    if (now - lastStartAt.current < 750) return;
    if (!hasEnabledSources) { setError('还没有启用的消息来源。先添加邮箱或钉钉等来源，保存本人账号和读取范围，再检测连接。'); return; }
    lastStartAt.current = now;
    startLock.current = true; queryEpoch.current++; setStarting(true); setError('');
    try {
      const next = await run('intake.start', {}, '', false);
      if (next) receive(next);
      else if (alive.current) setError('本次没有开始新的整理。请查看操作提示，再检查来源配置。');
    } finally { startLock.current = false; if (alive.current) setStarting(false); }
  };
  const cancel = async () => {
    if (cancelLock.current || !active(latestJob.current)) return;
    cancelLock.current = true; queryEpoch.current++; setCancelling(true);
    try { const next = await run('intake.cancel', {}, '', false); if (next) receive(next); }
    finally { cancelLock.current = false; if (alive.current) setCancelling(false); }
  };
  return { job, error, starting, cancelling, start, cancel, running };
}

export function IntakeButton({ intake, busy }) {
  return <Button size="large" icon={<SyncOutlined spin={intake.running} />} loading={intake.starting} disabled={intake.running || !!busy || !isDesktop()} onClick={intake.start}>{intake.running ? '正在整理' : '立即整理'}</Button>;
}

export function IntakeSummary({ intake, onSetup }) {
  const { job, error } = intake;
  if (!job && !error) return null;
  const rows = job?.results || [];
  const finished = rows.filter(row => !['pending', 'running'].includes(row.status)).length;
  const failed = rows.some(row => row.status === 'failed');
  return <section className="content-panel intake-summary" aria-label="本轮消息整理进度" aria-live="polite">
    <div className="section-heading"><div><h2>{intake.running ? job?.status === 'cancelling' ? '正在停止本轮整理' : '正在整理已授权来源' : job?.status === 'interrupted' ? '上次整理中断，请核对来源结果' : job ? '本轮整理已结束' : '先配置消息来源'}</h2><p>只读取已启用、已配置且授权范围明确的来源，沿用所选分析方式；不会发送日报或微信消息。</p></div>{intake.running && <Button disabled={intake.cancelling || job?.status === 'cancelling'} loading={intake.cancelling} onClick={intake.cancel}>取消本轮</Button>}</div>
    {error && <Alert type="warning" showIcon title={error} className="top-alert" />}
    {rows.length > 0 && <><p className="muted">已处理 {finished} / {rows.length} 个来源</p><Progress percent={Math.round(finished / rows.length * 100)} showInfo={false} status={intake.running ? 'active' : failed ? 'exception' : 'normal'} />
      <div className="intake-result-list">{rows.map(row => { const [label, color] = resultLabels[row.status] || ['待核对', 'default']; const counts = row.counts || {}; return <article className="intake-result-row" key={row.sourceId}><div><Space wrap><strong>{row.name || '消息来源'}</strong><span className="muted">{sourceLabels[row.platform] || row.platform}</span><Tag color={color}>{label}</Tag></Space>{(row.status === 'success' || Object.values(counts).some(value => Number(value) > 0)) && <p>读取 {counts.received || 0} 条，新增 {counts.created || 0} 件，更新 {counts.updated || 0} 件，跳过重复 {counts.duplicates || 0} 条。</p>}{row.message && <p className={row.status === 'failed' ? 'error-text' : 'muted'}>{row.message}</p>}</div></article>; })}</div></>}
    {(!rows.length || rows.some(row => ['failed', 'skipped'].includes(row.status))) && <Button type="link" onClick={onSetup}>进入消息来源检查配置</Button>}
  </section>;
}
