import React, { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, ConfigProvider, Form, Input, Modal, Select, Space, Steps, Tag } from 'antd';
import { CheckCircleOutlined, PlusOutlined, ExperimentOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { isDesktop, localDate, sourceLabels } from './api.js';
import { useUnsavedDraft } from './DraftGuard.jsx';

const steps = ['认识你', '选择来源', '第一件事', '安排日报', '准备好了'];
export default function Onboarding({ open, onClose, data, run, busy, navigate, modal }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState('email');
  const [sourceName, setSourceName] = useState('');
  const [scope, setScope] = useState('');
  const [title, setTitle] = useState('');
  const [daily, setDaily] = useState(false);
  const [time, setTime] = useState('18:00');
  const [created, setCreated] = useState(false);
  const draft = useUnsavedDraft('onboarding', '首次设置');
  useEffect(() => { if (open) { setStep(Math.max(0, Math.min(4, data.settings.onboardingStep || 0))); setName(data.settings.name || ''); setDaily(!!data.settings.dailyEnabled); setTime(data.settings.reportTime || '18:00'); setSourceName(''); setScope(''); setTitle(''); setCreated(false); setPlatform('email'); draft.resetDraft(); } }, [open]);
  const persist = async next => { if (!isDesktop()) { setStep(next); draft.resetDraft(); return true; } const r = await run('settings.save', { onboardingStep: next }, ''); if (r) { setStep(next); draft.resetDraft(); } return !!r; };
  const next = async () => {
    if (busy) return;
    if (step === 1 && scope.trim() && !sourceName.trim()) { modal.warning({ title: '请先给消息来源起个名字', content: '读取范围还没有保存。填写来源名称后再继续，或清空范围后跳过。', okText: '返回填写' }); return; }
    if (step === 0 && isDesktop()) { if (!await run('settings.save', { name: name.trim() }, '')) return; }
    if (step === 1 && sourceName.trim() && isDesktop()) {
      if (!await run('source.save', { name: sourceName.trim(), platform, enabled: true, scope: scope.split('\n').map(x => x.trim()).filter(Boolean), config: { pollMinutes: 15 } }, '来源范围已保存，连接参数可在消息来源中补充')) return;
      setSourceName('');
      setScope('');
    }
    if (step === 2 && title.trim() && !created && isDesktop()) { if (!await run('task.create', { title: title.trim(), status: 'todo', dueDate: localDate(), priority: 2, example: false }, '第一件事已添加')) return; setCreated(true); }
    if (step === 3 && isDesktop()) { if (!await run('settings.save', { dailyEnabled: daily, reportTime: time || '18:00' }, '日报安排已保存')) return; }
    if (step < 4) await persist(step + 1);
    else { if (!isDesktop() || await run('settings.save', { onboardingComplete: true, onboardingStep: 4 }, '首次设置已完成')) { draft.resetDraft(); onClose(); navigate('today'); } }
  };
  const later = async () => {
    if (busy) return;
    const close = async () => { if (isDesktop() && !await run('settings.save', { onboardingStep: step }, '设置进度已保存')) return; draft.resetDraft(); onClose(); };
    if (draft.dirtyRef.current) { modal.confirm({ title: '首次设置还有未保存的内容', content: '稍后继续会保留已经保存的步骤；当前未保存的输入将被放弃。', okText: '放弃本步并稍后继续', cancelText: '返回继续填写', autoFocusButton: 'cancel', okButtonProps: { danger: true }, onOk: close }); return; }
    await close();
  };
  const previous = () => {
    if (busy) return;
    const back = () => {
      if (step === 0) setName(data.settings.name || '');
      if (step === 1) { setSourceName(''); setScope(''); setPlatform('email'); }
      if (step === 2) { setTitle(''); setCreated(false); }
      if (step === 3) { setDaily(!!data.settings.dailyEnabled); setTime(data.settings.reportTime || '18:00'); }
      return persist(step - 1);
    };
    if (draft.dirtyRef.current) { modal.confirm({ title: '本步内容尚未保存', content: '返回上一步会放弃本步尚未保存的输入，已保存的内容不受影响。', okText: '放弃本步并返回', cancelText: '返回继续填写', autoFocusButton: 'cancel', okButtonProps: { danger: true }, onOk: back }); return; }
    back();
  };
  const examples = async () => {
    if (busy) return;
    for (const task of [{ title: '核对任务卡，试着完成并撤销', status: 'todo' }, { title: '等待同事确认材料（示例）', status: 'waiting' }, { title: '整理今天的工作报告（示例）', status: 'doing' }]) { if (!await run('task.create', { ...task, notes: '这是你主动生成的体验事项，可编辑或移入回收站。', dueDate: localDate(), priority: 2, example: true }, '')) return; }
    if (await run('settings.save', { onboardingComplete: true, onboardingStep: 4 }, '已创建 3 件明确标注的示例事项')) { draft.resetDraft(); onClose(); navigate('today'); }
  };
  return <ConfigProvider componentDisabled={!!busy}><Modal open={open} closable={!busy} keyboard={!busy} title="用几分钟，安排好自己的工作" width={760} onCancel={later} maskClosable={false} footer={<div className="wizard-footer"><Button type="text" onClick={later}>稍后继续</Button><Space>{step > 0 && <Button onClick={previous}>上一步</Button>}<Button type="primary" onClick={next} loading={!!busy} icon={step === 4 ? <CheckCircleOutlined /> : <ArrowRightOutlined />}>{step === 4 ? '进入我的看板' : '保存并继续'}</Button></Space></div>}>
    <Steps current={step} size="small" items={steps.map(title => ({ title }))} className="onboarding-steps" />
    <div className="wizard-body">
      {step === 0 && <><h2>你好，从你的称呼开始</h2><p>这是一份属于你自己的工作清单。任务和配置保存在运行服务的这台电脑，消息来源由你选择。</p><label className="field-label" htmlFor="wizard-name">希望报告怎样称呼你</label><Input id="wizard-name" value={name} onChange={e => { setName(e.target.value); draft.markDirty(); }} placeholder="输入姓名或常用称呼，也可以稍后填写" maxLength={60} size="large" /><div className="wizard-explanation"><h3>你可以用它做什么</h3><p>记录和跟进任务，核对消息依据，导出日报周报，再按需连接本人的微信助手。</p></div></>}
      {step === 1 && <><h2>先选择一个常用消息来源</h2><p>这里只保存名称和范围，连接参数可以稍后到“消息来源”继续配置。留空也能先用手动清单。</p><Form layout="vertical"><div className="form-grid"><Form.Item label="来源类型"><Select value={platform} onChange={value => { setPlatform(value); draft.markDirty(); }} options={Object.entries(sourceLabels).map(([value, label]) => ({ value, label }))} /></Form.Item><Form.Item label="给来源起个名字"><Input value={sourceName} onChange={e => { setSourceName(e.target.value); draft.markDirty(); }} placeholder="例如：工作邮箱" /></Form.Item></div><Form.Item label="指定读取范围" extra="每行一个邮箱、群或联系人，不会默认读取全部。"><Input.TextArea rows={3} value={scope} onChange={e => { setScope(e.target.value); draft.markDirty(); }} /></Form.Item></Form><Alert type="info" showIcon title="未实际读取成功前保持待配置" description="微信、钉钉可先使用本机导出 JSON 文件；微信 Bot 扫码连接不会获得读取群历史的权限。" /></>}
      {step === 2 && <><h2>写下今天要做的第一件事</h2><p>用一个清楚的动作开始，例如“核对客户确认后的报价单”。这件事会保存为真实手动任务。</p><label className="field-label" htmlFor="wizard-task">今天要做什么</label><Input id="wizard-task" value={title} onChange={e => { setTitle(e.target.value); setCreated(false); draft.markDirty(); }} placeholder="输入一件具体的工作，也可以跳过" maxLength={200} size="large" />{created && <Alert className="top-alert" showIcon type="success" title="这件事已保存" />}<div className="wizard-explanation"><h3>完成状态由你确认</h3><p>可更改日期、状态，标记完成后也能撤销。“收到”“安排了”等消息不会自动完成任务。</p></div></>}
      {step === 3 && <><h2>让每天的工作留下记录</h2><p>报告可以预览并导出 PDF 或 Word。定时推送需要先连接并确认本人的微信。</p><Checkbox checked={daily} onChange={e => { setDaily(e.target.checked); draft.markDirty(); }}>启用工作日定时推送到本人微信</Checkbox><div className="wizard-time"><label className="field-label" htmlFor="wizard-time">计划推送时间</label><Input id="wizard-time" type="time" value={time} onChange={e => { setTime(e.target.value); draft.markDirty(); }} /></div><Alert type="warning" showIcon title="本机服务需要保持运行" description="休眠、关机、断网或服务停止时无法按时执行。生成报告、保存文件与发送到微信分别显示状态。" /></>}
      {step === 4 && <><div className="wizard-ready"><CheckCircleOutlined /><h2>你的工作看板准备好了</h2></div><p>可以先手动记录，消息连接和微信设置都能从左侧导航继续。你也可以重新打开这份向导。</p><ul className="ready-list"><li>今天要做：跟进今天、逾期和未定日期的事项。</li><li>消息来源：补充连接参数，保存范围并检测。</li><li>日报周报：预览核对，再导出到本机目录。</li></ul><div className="example-option"><div><h3>想先熟悉操作？<Tag color="purple">可选体验</Tag></h3><p>主动创建 3 件带“示例”标记的事项，随时可以删除。</p></div><Button icon={<ExperimentOutlined />} onClick={examples} loading={!!busy}>生成示例体验</Button></div></>}
    </div>
  </Modal></ConfigProvider>;
}
