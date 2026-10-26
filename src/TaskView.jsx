import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, Dropdown, Empty, Form, Input, Modal, Select, Segmented, Space, Tag, Tooltip } from 'antd';
import { PlusOutlined, SearchOutlined, CheckOutlined, MoreOutlined, UnorderedListOutlined, AppstoreOutlined, UndoOutlined, DeleteOutlined, CalendarOutlined, LinkOutlined, EditOutlined } from '@ant-design/icons';
import { localDate, statuses, statusColors, sourceLabels, dateLabel } from './api.js';

export default function TaskView({ data, run, busy, todayOnly, coverage, onSetup }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('active');
  const [view, setView] = useState('list');
  const [editing, setEditing] = useState(null);
  const [reschedule, setReschedule] = useState(null);
  const [due, setDue] = useState('');
  const [lastDone, setLastDone] = useState(null);
  const [form] = Form.useForm();
  const today = localDate();
  useEffect(() => { setFilter('active'); setQuery(''); }, [todayOnly]);
  const tasks = useMemo(() => data.tasks.filter(task => {
    if (filter === 'trash' ? !task.deletedAt : task.deletedAt) return false;
    if (filter === 'active' && task.status === 'done') return false;
    if (!['active', 'all', 'trash'].includes(filter) && task.status !== filter) return false;
    if (todayOnly && filter !== 'trash' && filter !== 'done' && task.dueDate && task.dueDate > today) return false;
    return `${task.title} ${task.notes || ''}`.toLowerCase().includes(query.toLowerCase());
  }).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.priority - b.priority), [data.tasks, filter, todayOnly, query, today]);
  const openEdit = task => { setEditing(task || {}); form.setFieldsValue({ title: '', notes: '', dueDate: today, status: 'todo', priority: 2, sourceId: '', sourceRef: '', sourceText: '', ...task }); };
  const save = async () => { const values = await form.validateFields(); const r = await run(editing.id ? 'task.patch' : 'task.create', { ...values, ...(editing.id ? { id: editing.id } : {}), example: editing.example || false }, editing.id ? '任务已保存' : '任务已添加'); if (r) setEditing(null); };
  const complete = async task => { const r = await run('task.patch', { id: task.id, status: task.status === 'done' ? 'todo' : 'done' }, task.status === 'done' ? '已恢复为待开始' : '已完成，可撤销'); if (r && task.status !== 'done') setLastDone(task); };
  const trashCount = data.tasks.filter(t => t.deletedAt).length;
  const TaskItem = ({ task, board = false }) => {
    const source = data.sources.find(s => s.id === task.sourceId);
    const overdue = task.dueDate && task.dueDate < today && task.status !== 'done';
    const menu = [{ key: 'edit', label: '编辑任务', icon: <EditOutlined /> }, { key: 'due', label: '更改日期', icon: <CalendarOutlined /> }, { type: 'divider' }, { key: 'delete', label: '移入回收站', icon: <DeleteOutlined />, danger: true }];
    return <article className={`task-row ${board ? 'task-board-item' : ''} ${task.status === 'done' ? 'task-done' : ''}`}>
      {filter !== 'trash' && <Tooltip title={task.status === 'done' ? '撤销完成' : '标记完成'}><Checkbox checked={task.status === 'done'} onChange={() => complete(task)} aria-label={`${task.status === 'done' ? '撤销完成' : '完成'}：${task.title}`} /></Tooltip>}
      <div className="task-content"><button className="task-title" onClick={() => openEdit(task)}>{task.title}</button><div className="task-meta">
        {!board && <Tag color={statusColors[task.status]}>{statuses[task.status]}</Tag>}{task.example && <Tag color="purple">示例</Tag>}
        {task.priority === 1 && <span className="important-label">优先处理</span>}
        <span className={overdue ? 'overdue-label' : ''}><CalendarOutlined /> {task.dueDate ? overdue ? `已逾期 · ${task.dueDate}` : task.dueDate === today ? '今天' : task.dueDate : '未设日期'}</span>
        <span><LinkOutlined /> {source?.name || (task.sourceId ? '原来源' : '手动记录')}</span>
      </div>{task.notes && <p className="task-note">{task.notes}</p>}</div>
      {filter === 'trash' ? <Button icon={<UndoOutlined />} onClick={() => run('task.restore', { id: task.id }, '任务已恢复')}>恢复</Button> : <div className="task-actions"><Select size="small" value={task.status} aria-label={`更改 ${task.title} 的状态`} options={Object.entries(statuses).map(([value, label]) => ({ value, label }))} onChange={status => run('task.patch', { id: task.id, status }, '状态已更新')} /><Dropdown menu={{ items: menu, onClick: ({ key }) => key === 'edit' ? openEdit(task) : key === 'due' ? (setReschedule(task), setDue(task.dueDate || today)) : run('task.delete', { id: task.id }, '已移入回收站，可恢复') }} trigger={['click']}><Button type="text" icon={<MoreOutlined />} aria-label={`${task.title} 的更多操作`} /></Dropdown></div>}
    </article>;
  };
  return <>
    <div className="page-heading"><div><h1>{todayOnly ? '今天要做' : '全部任务'}</h1><p>{todayOnly ? '先处理今天、逾期和未定日期的事，给工作留一点余地。' : '所有事项都在这里，保留消息依据，持续跟进每一步。'}</p></div><Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit()} size="large">添加任务</Button></div>
    {coverage === 0 && <div className="source-notice"><CloudNotice /><span>消息来源尚无成功读取记录，当前可手动记录任务。</span><Button type="link" onClick={onSetup}>选择消息来源</Button></div>}
    {lastDone && <Alert className="top-alert" type="success" showIcon closable onClose={() => setLastDone(null)} title={`已完成：${lastDone.title}`} action={<Button type="link" icon={<UndoOutlined />} onClick={async () => { const r = await run('task.patch', { id: lastDone.id, status: lastDone.status }, '已撤销完成'); if (r) setLastDone(null); }}>撤销</Button>} />}
    <section className="content-panel task-panel" aria-label="任务工作区"><div className="task-toolbar"><div className="task-filters"><Select value={filter} onChange={setFilter} aria-label="筛选任务状态" options={[{ value: 'active', label: '未完成' }, { value: 'all', label: '全部状态' }, ...Object.entries(statuses).map(([value, label]) => ({ value, label })), { value: 'trash', label: `回收站${trashCount ? `（${trashCount}）` : ''}` }]} /><Input prefix={<SearchOutlined />} placeholder="搜索任务" value={query} onChange={e => setQuery(e.target.value)} allowClear aria-label="搜索任务" /></div><Segmented value={view} onChange={setView} options={[{ value: 'list', label: '清单', icon: <UnorderedListOutlined /> }, { value: 'board', label: '看板', icon: <AppstoreOutlined /> }]} /></div>
      <div className="task-count">{filter === 'trash' ? '回收站中的任务可以恢复' : `${tasks.length} 件${todayOnly ? '当前范围内的' : ''}事项`}</div>
      {tasks.length === 0 ? <div className="empty-task"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>{query ? '没有找到匹配的任务' : filter === 'done' ? '还没有已完成的任务' : filter === 'trash' ? '回收站是空的' : '这里还没有待办事项'}</strong><p>{query ? '换个关键词，或切换筛选范围。' : filter === 'trash' ? '移入回收站的任务会保留，随时可以恢复。' : '可以先记下一件要做的事，再逐步连接消息来源。'}</p></>} />{!query && filter !== 'trash' && <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit()}>添加第一件事</Button>}</div>
        : view === 'list' || filter === 'trash' ? <div className="task-list">{tasks.map(task => <TaskItem key={task.id} task={task} />)}</div> : <div className="kanban">{Object.entries(statuses).map(([status, label]) => <section className="kanban-column" key={status}><h2>{label}<span>{tasks.filter(t => t.status === status).length}</span></h2>{tasks.filter(t => t.status === status).map(task => <TaskItem key={task.id} task={task} board />)}{!tasks.some(t => t.status === status) && <p className="column-empty">暂无事项</p>}</section>)}</div>}
    </section>
    <Modal open={editing !== null} title={editing?.id ? '编辑任务' : '添加任务'} okText="保存任务" cancelText="取消" onCancel={() => setEditing(null)} onOk={save} confirmLoading={busy.startsWith('task.')} width={620} destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark="optional"><Form.Item label="要做什么" name="title" rules={[{ required: true, whitespace: true, message: '请写下具体要做的事' }, { max: 200, message: '标题最多 200 字' }]}><Input placeholder="例如：核对客户确认后的报价单" autoFocus maxLength={200} /></Form.Item><div className="form-grid"><Form.Item label="计划日期" name="dueDate"><Input type="date" /></Form.Item><Form.Item label="当前状态" name="status"><Select options={Object.entries(statuses).map(([value, label]) => ({ value, label }))} /></Form.Item></div><Form.Item label="优先级" name="priority"><Select options={[{ value: 1, label: '优先处理' }, { value: 2, label: '正常安排' }, { value: 3, label: '稍后处理' }]} /></Form.Item><Form.Item label="补充说明" name="notes"><Input.TextArea rows={3} placeholder="记录要求、下一步，或需要等待谁的回复" /></Form.Item>
        <Collapse ghost items={[{ key: 'source', label: '消息依据（可选）', children: <><Form.Item label="来源" name="sourceId"><Select disabled={!!editing?.id} allowClear options={data.sources.map(s => ({ value: s.id, label: `${sourceLabels[s.platform]} · ${s.name}` }))} /></Form.Item><Form.Item label="来源位置或链接" name="sourceRef"><Input readOnly={!!editing?.id} /></Form.Item><Form.Item label="原文摘录" name="sourceText"><Input.TextArea rows={3} readOnly={!!editing?.id} /></Form.Item>{editing?.id && <p className="muted">原始消息依据只读。补充说明请写在任务备注，关联有误可到消息来源中更正。<br />创建于 {dateLabel(editing.createdAt)} · 更新于 {dateLabel(editing.updatedAt)}</p>}</> }]} />
      </Form>
    </Modal>
    <Modal open={!!reschedule} title="更改计划日期" okText="保存日期" cancelText="取消" onCancel={() => setReschedule(null)} onOk={async () => { const r = await run('task.patch', { id: reschedule.id, dueDate: due }, '计划日期已更改'); if (r) setReschedule(null); }} confirmLoading={busy === 'task.patch'}><p>{reschedule?.title}</p><label className="field-label" htmlFor="reschedule-date">新的计划日期</label><Input id="reschedule-date" type="date" value={due} onChange={e => setDue(e.target.value)} /><Button type="link" onClick={() => setDue('')}>暂不设日期</Button></Modal>
  </>;
}
function CloudNotice() { return <LinkOutlined className="notice-icon" />; }
