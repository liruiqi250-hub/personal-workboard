'use strict';

// Pure report generation shared by the local Web server and export handlers.
// No browser, network, Electron, database or account access is performed here.
const fs = require('node:fs/promises');
const path = require('node:path');

const DAY = 86_400_000;
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
const STATUS = { inbox: '待确认', todo: '待办', doing: '进行中', waiting: '等待回复', done: '已完成', unknown: '历史状态待核对' };
const PLATFORMS = { wechat: '微信', email: '邮箱', dingtalk: '钉钉', manual: '手工录入' };
const COUNTING_NOTE = '期间完成按实际完成事件统计，同一任务去重；截至仍完成另列。进行中、等待回复、逾期等分类可能重叠，不可直接相加。未记录工时，不推算工时或工作量。';

function cleanText(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '\uFFFD');
}

function escapeHtml(value) {
  return cleanText(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function instant(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value).trim();
  // Time-zone-free timestamps in the application's records mean Beijing time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T00:00:00+08:00';
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) text = text.replace(' ', 'T') + '+08:00';
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function beijingDate(ms) { return new Date(ms + BEIJING_OFFSET).toISOString().slice(0, 10); }
function beijingTime(ms) { return new Date(ms + BEIJING_OFFSET).toISOString().replace('T', ' ').slice(0, 19) + '（北京时间）'; }
function dateStart(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new RangeError('报告日期必须为有效的 YYYY-MM-DD。');
  const ms = instant(date);
  if (ms === null || beijingDate(ms) !== date) throw new RangeError('报告日期不是有效的日历日期。');
  return ms;
}
function addDays(date, days) { return beijingDate(dateStart(date) + days * DAY); }
function snapshot(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return undefined; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value === null ? null : undefined;
}
function eventType(value) { return String(value ?? '').toLowerCase().replace(/^task[.:_-]/, '').replace(/[_-]/g, '.'); }
function isType(event, names) { return names.includes(event.kind); }
function isCreation(event) { return isType(event, ['create', 'created']); }
function completion(event) {
  if (isCreation(event) || event.before?.status === 'done') return false;
  if (event.after?.status) return event.after.status === 'done';
  return isType(event, ['complete', 'completed', 'done']);
}
function reopening(event) {
  if (event.after?.status === 'done') return false;
  return (event.before?.status === 'done' && event.after?.status && event.after.status !== 'done') || isType(event, ['reopen', 'reopened']);
}
function normalizeEvents(events) {
  return events.map((event, index) => ({
    ...event, index, ms: instant(event.at), kind: eventType(event.type), before: snapshot(event.before), after: snapshot(event.after),
  })).filter(event => event.ms !== null).map(event => ({ ...event, taskId: String(event.taskId ?? event.after?.id ?? event.before?.id ?? '') }))
    .filter(event => event.taskId).sort((a, b) => a.ms - b.ms || a.index - b.index);
}

function applyForward(state, event) {
  if (event.after && typeof event.after === 'object') return { ...state, ...event.after };
  if (isCreation(event)) return { ...state, id: event.taskId, createdAt: new Date(event.ms).toISOString() };
  if (completion(event)) return { ...state, status: 'done', completedAt: new Date(event.ms).toISOString() };
  if (reopening(event)) return { ...state, status: event.after?.status || 'todo', completedAt: null };
  if (isType(event, ['delete', 'deleted'])) return { ...state, deletedAt: new Date(event.ms).toISOString() };
  if (isType(event, ['restore', 'restored'])) return { ...state, deletedAt: null };
  return state;
}

// Rewind from the stored task using all later before snapshots, then replay the
// available timeline. Full before/after snapshots provide exact reproduction.
function taskAtCutoff(current, events, cutoff) {
  let state = current ? { ...current } : null;
  const gaps = [];
  if (!current) {
    const first = events[0];
    state = first?.before ? { ...first.before } : null;
    for (const event of events) {
      if (event.ms > cutoff) break;
      state = applyForward(state, event);
    }
  } else {
    for (const event of [...events].reverse()) {
      if (event.ms <= cutoff) continue;
      if (isCreation(event)) { state = null; continue; }
      if (event.before && state) state = { ...state, ...event.before };
      else if (state) {
        // Date fields can prove deletion timing, but cannot prove an earlier status.
        if (isType(event, ['delete', 'deleted'])) state.deletedAt = null;
        else if (isType(event, ['restore', 'restored'])) state.deletedAt = new Date(event.ms).toISOString();
        else { state.status = 'unknown'; gaps.push('截至时刻后的变更缺少 before 快照，历史状态待核对'); }
      }
    }
    if (state) {
      const preceding = events.filter(event => event.ms <= cutoff);
      const last = preceding.at(-1);
      // The latest event is the authority when a caller's task snapshot is stale.
      if (last) state = applyForward(state, last);
      const updated = instant(current.updatedAt);
      if (updated !== null && updated > cutoff && !events.some(event => event.ms > cutoff)) {
        state.status = 'unknown';
        gaps.push('记录在截至时刻后更新，但没有相应变更事件，不能确认历史状态');
      }
    }
  }
  if (!state) return { state: null, gaps };
  const created = instant(state.createdAt) ?? events.find(isCreation)?.ms;
  if (created !== null && created !== undefined && created > cutoff) return { state: null, gaps: [] };
  if (created !== null && created !== undefined && !state.createdAt) state.createdAt = new Date(created).toISOString();
  if (created === null || created === undefined) gaps.push('缺少有效创建时间，无法确认期间新增口径');
  if (instant(state.deletedAt) > cutoff) state.deletedAt = null;
  if (!STATUS[state.status]) { state.status = 'unknown'; gaps.push('任务状态缺失或无法识别，需核对'); }
  return { state, gaps };
}

function coverage(sources, start, cutoff, generatedAt) {
  const items = sources.map(source => {
    const platform = PLATFORMS[source.platform] || cleanText(source.platform) || '其他来源';
    const name = cleanText(source.name || platform);
    const success = instant(source.lastSuccessAt);
    const through = instant(source.readThroughAt ?? source.coverageEndAt);
    const from = instant(source.coverageStartAt);
    let status, detail, gap = false;
    if (source.platform === 'manual') {
      status = source.enabled === false ? '已停用' : '手工录入';
      detail = '仅包含已登记到看板的任务，不证明外部消息已完整读取。';
    } else if (source.enabled === false) {
      status = '已停用'; gap = true; detail = '当前来源已停用，本期外部消息读取覆盖待核对。';
    } else if (!source.status || source.status === 'unconfigured') {
      status = '未接入'; gap = true; detail = '未完成配置或授权，不能据此判断本期没有工作。';
    } else if (source.status === 'error') {
      status = '读取异常'; gap = true; detail = cleanText(source.lastError || '读取失败，原因待核对') + '；期间读取可能存在缺口。';
    } else if (source.status !== 'connected') {
      status = '待验证'; gap = true; detail = '已配置，但尚未验证成功读取；不能据此判断没有工作。';
    } else if (success === null || success > generatedAt) {
      status = '读取待核对'; gap = true; detail = '显示已连接，但没有可核实的成功读取时间。';
    } else if (from !== null && through !== null && from <= start && through >= cutoff) {
      status = '有覆盖记录'; detail = `已记录读取范围 ${beijingTime(from)} 至 ${beijingTime(through)}；报告仍仅统计已入库任务。`;
    } else {
      status = '部分覆盖'; gap = true;
      detail = `最近成功读取：${beijingTime(success)}；未提供覆盖整个统计区间的读取水位，尚未读取的消息可能未纳入。`;
    }
    const scope = Array.isArray(source.scope) && source.scope.length ? source.scope.map(cleanText).join('、') : source.platform === 'manual' ? '已登记任务' : '范围未登记';
    return { sourceId: cleanText(source.id), title: name, platform, status, detail, scope, gap };
  });
  for (const [key, platform] of Object.entries(PLATFORMS)) {
    if (key !== 'manual' && !sources.some(source => source.platform === key)) {
      items.push({ sourceId: '', title: platform, platform, status: '未接入', detail: '尚未配置此类来源；未接入不等于本期没有工作。', scope: '未配置', gap: true });
    }
  }
  return items;
}

function renderItem(item) {
  if (item.detail !== undefined) return `<li><strong>${escapeHtml(item.title)}</strong><span class="tag">${escapeHtml(item.status)}</span><p>${escapeHtml(item.detail)}</p>${item.scope ? `<p class="meta">范围：${escapeHtml(item.scope)}</p>` : ''}</li>`;
  const details = [
    `任务编号：${item.taskId}`, `截至状态：${item.statusLabel}`, `来源：${item.sourceName}`,
    item.dueDate && `到期日：${item.dueDate}`, item.completionTimes?.length && `期间完成事件：${item.completionTimes.map(value => beijingTime(instant(value))).join('；')}`,
    item.reopenedAt && `重新打开：${beijingTime(instant(item.reopenedAt))}`, item.deletedAt && '截至时刻已删除',
  ].filter(Boolean).join(' ｜ ');
  return `<li><strong>${escapeHtml(item.title)}</strong>${item.reopenedAt && item.status !== 'done' ? '<span class="tag">已重新打开</span>' : ''}<p class="meta">${escapeHtml(details)}</p>${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ''}${item.evidence?.length ? `<p class="meta">依据：${escapeHtml(item.evidence.join('；'))}</p>` : ''}</li>`;
}

function renderHtml(report) {
  const { stats } = report;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(report.title)}</title>
<style>@page{size:A4;margin:18mm 17mm}*{box-sizing:border-box}html{background:#fff;color:#202b36;font-family:"Microsoft YaHei","PingFang SC",sans-serif;font-size:10.5pt}body{margin:0 auto;max-width:180mm;line-height:1.7;overflow-wrap:anywhere}h1{font-size:23pt;line-height:1.35;margin:0 0 8mm;color:#172c43}h2{font-size:14pt;line-height:1.4;margin:7mm 0 2mm;break-after:avoid}p{margin:1.5mm 0;white-space:pre-wrap}.meta,.hint{font-size:9pt;color:#526273}.intro{padding-bottom:4mm;border-bottom:1px solid #bcc9d5}.metrics{display:flex;flex-wrap:wrap;gap:3mm;margin:5mm 0}.metric{border:1px solid #c8d2db;border-radius:2mm;padding:2mm 3mm;min-width:29mm}.metric b{display:block;font-size:17pt;color:#172c43}.tag{display:inline-block;border:1px solid #8398ad;border-radius:2mm;font-size:8pt;padding:0 1.5mm;margin-left:2mm}ul{padding-left:5mm;margin:2mm 0}li{padding:2mm 0;border-bottom:1px solid #e0e5ea;break-inside:avoid}footer{margin-top:8mm;padding-top:3mm;border-top:1px solid #bcc9d5;font-size:8.5pt;color:#526273}@media screen{body{padding:24px;max-width:850px}}@media print{body{max-width:none}a{color:inherit;text-decoration:none}.metrics{break-inside:avoid}}</style></head>
<body><header class="intro"><h1>${escapeHtml(report.title)}</h1><p>统计区间：${escapeHtml(report.startDate)} 至 ${escapeHtml(report.endDate)}</p><p>数据截至：${escapeHtml(beijingTime(instant(report.cutoffAt)))}</p><p class="meta">生成时间：${escapeHtml(beijingTime(instant(report.generatedAt)))}</p></header>
<div class="metrics">${[['期间新增', stats.created], ['期间完成任务', stats.completed], ['截至仍完成', stats.currentlyDone], ['截至未结', stats.open], ['期间重新打开', stats.reopened]].map(([label, value]) => `<div class="metric">${escapeHtml(label)}<b>${value}</b></div>`).join('')}</div>
<p>${escapeHtml(report.summary)}</p><p class="hint">${escapeHtml(COUNTING_NOTE)}</p>
${report.sections.map(section => `<section><h2>${escapeHtml(section.title)}（${section.items.length}）</h2><p class="hint">${escapeHtml(section.description)}</p>${section.items.length ? `<ul>${section.items.map(renderItem).join('')}</ul>` : `<p class="meta">${escapeHtml(section.emptyText)}</p>`}</section>`).join('\n')}
<footer>个人待办事项看板｜任务与事件记录生成；外部来源覆盖及历史缺口见正文。示例数据不纳入正式统计。此报告不代表消息已发送、对方已接收或已阅读。</footer></body></html>`;
}

function buildReport({ tasks = [], events = [], sources = [], type = 'daily', date, name = '', now = new Date() } = {}) {
  if (!['daily', 'weekly'].includes(type)) throw new RangeError('报告类型只能为 daily 或 weekly。');
  if (!Array.isArray(tasks) || !Array.isArray(events) || !Array.isArray(sources)) throw new TypeError('任务、事件和来源必须为数组。');
  const generated = instant(now);
  if (generated === null) throw new RangeError('报告生成时间无效。');
  date = date ?? beijingDate(generated);
  const selected = dateStart(date);
  const weekday = new Date(selected + BEIJING_OFFSET).getUTCDay();
  const startDate = type === 'weekly' ? addDays(date, -(weekday + 6) % 7) : date;
  const endDate = type === 'weekly' ? addDays(startDate, 6) : date;
  const start = dateStart(startDate), endExclusive = dateStart(addDays(endDate, 1));
  const cutoff = Math.min(generated, endExclusive - 1);
  const inPeriod = ms => ms !== null && ms >= start && ms <= cutoff;
  const normalized = normalizeEvents(events);
  const timelines = new Map();
  for (const event of normalized) {
    if (!timelines.has(event.taskId)) timelines.set(event.taskId, []);
    timelines.get(event.taskId).push(event);
  }
  const sourceMap = new Map(sources.map(source => [String(source.id), source]));
  const taskMap = new Map(tasks.map(task => [String(task.id), task]));
  const ids = new Set([...taskMap.keys(), ...timelines.keys()]);
  const rows = [], historyItems = [];
  let excludedExamples = 0;
  for (const id of ids) {
    const timeline = timelines.get(id) || [];
    const { state, gaps } = taskAtCutoff(taskMap.get(id), timeline, cutoff);
    if (!state) continue;
    if (state.example === true || taskMap.get(id)?.example === true) { excludedExamples++; continue; }
    const completions = timeline.filter(event => inPeriod(event.ms) && completion(event));
    const reopens = timeline.filter(event => inPeriod(event.ms) && reopening(event));
    const lastCompletion = timeline.filter(event => event.ms <= cutoff && completion(event)).at(-1);
    const lastReopen = timeline.filter(event => event.ms <= cutoff && reopening(event)).at(-1);
    const currentlyReopened = state.status !== 'done' && lastReopen && (!lastCompletion || lastReopen.ms >= lastCompletion.ms);
    const source = sourceMap.get(String(state.sourceId));
    const evidence = [...gaps];
    if (state.status === 'done' && !lastCompletion) {
      evidence.push('当前记录为已完成，但缺少完成事件；不计入期间完成');
      gaps.push('当前记录为已完成，但缺少完成事件；完成发生的时间无法核实，不计入期间完成');
    }
    if (completions.length) evidence.push(`完成事件 ${completions.length} 次；任务去重计 1 项`);
    if (state.sourceRef) evidence.push(`来源记录：${cleanText(state.sourceRef)}`);
    const row = {
      taskId: id, title: cleanText(state.title || '未命名任务'), status: state.status, statusLabel: STATUS[state.status],
      notes: cleanText(state.notes), sourceId: cleanText(state.sourceId), sourceName: cleanText(source?.name || (state.sourceId ? '来源已移除或未登记' : '手工录入 / 来源未登记')),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(state.dueDate || '') ? state.dueDate : '',
      createdAt: state.createdAt || null, completedAt: state.completedAt || null, deletedAt: state.deletedAt || null,
      completionTimes: completions.map(event => new Date(event.ms).toISOString()),
      reopenedAt: currentlyReopened ? new Date(lastReopen.ms).toISOString() : null,
      reopenedDuringPeriod: reopens.length > 0, evidence,
    };
    rows.push(row);
    if (gaps.length) historyItems.push({ title: row.title, taskId: id, status: '待核对', detail: `任务编号 ${id}：${gaps.join('；')}。相关状态不可当作已核实成果。` });
  }
  const active = rows.filter(row => !row.deletedAt);
  const open = active.filter(row => !['done', 'unknown'].includes(row.status));
  const periodCompleted = rows.filter(row => row.completionTimes.length);
  const created = rows.filter(row => inPeriod(instant(row.createdAt)));
  const reopened = rows.filter(row => row.reopenedDuringPeriod);
  const dueDay = beijingDate(cutoff);
  const sortRows = items => [...items].sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.title.localeCompare(b.title, 'zh-CN') || a.taskId.localeCompare(b.taskId));
  const doing = open.filter(row => row.status === 'doing');
  const waiting = open.filter(row => row.status === 'waiting');
  const overdue = open.filter(row => row.dueDate && row.dueDate < dueDay);
  const confirm = active.filter(row => ['inbox', 'unknown'].includes(row.status));
  const planStart = addDays(endDate, 1), planEnd = type === 'weekly' ? addDays(planStart, 6) : planStart;
  const plans = open.filter(row => row.dueDate >= planStart && row.dueDate <= planEnd);
  const sourceItems = coverage(sources, start, cutoff, generated);
  const invalidEvents = events.length - normalized.length;
  if (invalidEvents) historyItems.push({ title: '事件格式缺口', status: '待核对', detail: `${invalidEvents} 条事件缺少有效任务编号或时间，未用于统计；需核对原始记录。` });
  const stats = {
    total: active.length, created: created.length, completed: periodCompleted.length,
    completionEvents: periodCompleted.reduce((sum, row) => sum + row.completionTimes.length, 0),
    currentlyDone: active.filter(row => row.status === 'done').length,
    completedAndStillDone: periodCompleted.filter(row => !row.deletedAt && row.status === 'done').length,
    open: open.length, doing: doing.length, waiting: waiting.length, overdue: overdue.length,
    confirmation: confirm.length, unknown: active.filter(row => row.status === 'unknown').length,
    reopened: reopened.length, planned: plans.length, deleted: rows.filter(row => row.deletedAt).length,
    excludedExamples, sourceGaps: sourceItems.filter(item => item.gap).length, historyGaps: historyItems.length,
  };
  const makeSection = (key, title, description, items, emptyText = '已纳入的任务记录中未找到符合本分类的事项；不据此推断未接入来源没有工作。') => ({ key, title, description, items: sortRows(items), emptyText });
  const sections = [
    makeSection('completed', type === 'weekly' ? '本周完成事件' : '当日完成事件', '按期间完成事件列出，任务去重；后续重新打开或删除仍保留事件事实，并标明截至状态。', periodCompleted),
    makeSection('created', '期间新增', '按创建时间统计；包含随后完成或删除的任务，不能与完成和未结直接相加。', created),
    makeSection('open', '截至未结事项', '跨日未结任务持续列出；仅排除截至已完成、已删除及历史状态待核对的任务。', open),
    makeSection('doing', '当前进行中', '截至时刻状态为进行中；可能同时属于逾期或计划。', doing),
    makeSection('waiting', '等待回复与阻碍', '仅列已明确登记为等待回复的任务；具体阻碍见任务备注，不从沉默推断原因。', waiting),
    makeSection('overdue', '逾期事项', `已登记到期日早于 ${dueDay} 且截至未结；到期日当天不按全天逾期处理。`, overdue),
    makeSection('reopened', '期间重新打开', '本期发生过完成后重新打开的事件；再次完成时，截至状态会显示为已完成。', reopened),
    makeSection('plan', type === 'weekly' ? '下周已有安排' : '明日已有安排', `仅根据已登记到期日列出 ${planStart}${planEnd === planStart ? '' : ' 至 ' + planEnd} 的未结任务；不自动编造计划。`, plans, '没有登记在该日期范围内的到期事项；后续安排仍需本人补充。'),
    makeSection('confirmation', '需要确认的问题', '待确认任务以及缺少可靠历史状态的任务，均不当作已核实完成成果。', confirm),
    { key: 'sources', title: '纳入来源与读取缺口', description: '只汇总已入库的任务；连接状态和最近读取时间不能自动证明整个区间读取完整。', items: sourceItems, emptyText: '尚未配置来源；不能据此判断本期没有工作。' },
    { key: 'history', title: '历史记录核对', description: '历史状态依赖完整任务事件；缺少快照时保留待核对说明。', items: historyItems, emptyText: '本次计算未发现可识别的历史快照缺口；这不构成外部消息完整性证明。' },
  ];
  if (excludedExamples) sections.push({ key: 'examples', title: '示例数据说明', description: '示例任务已从所有正式统计和事项分类中排除。', items: [{ title: '排除示例任务', status: '不纳入统计', detail: `本次排除 ${excludedExamples} 项示例任务；这些内容不代表真实工作成果。` }], emptyText: '' });
  const label = type === 'weekly' ? '周报' : '日报';
  const safeName = cleanText(name).trim();
  const summary = `${startDate}${endDate === startDate ? '' : ' 至 ' + endDate}：已登记期间新增 ${stats.created} 项，发生完成事件的任务 ${stats.completed} 项（${stats.completionEvents} 次事件），其中截至仍完成 ${stats.completedAndStillDone} 项；截至未结 ${stats.open} 项，历史状态待核对 ${stats.unknown} 项。${cutoff < start ? '所选统计区间尚未开始，本报告不包含该区间未来记录。' : ''}${stats.sourceGaps ? `存在 ${stats.sourceGaps} 项来源接入或读取覆盖缺口，不能将缺失数据解释为没有工作。` : '来源覆盖情况见正文。'}`;
  const report = { type, startDate, endDate, cutoffAt: new Date(cutoff).toISOString(), stats, sections, summary,
    title: `${safeName ? safeName + ' · ' : ''}工作${label}`, name: safeName, generatedAt: new Date(generated).toISOString() };
  report.html = renderHtml(report);
  return report;
}

async function exportDocx(report, filePath) {
  if (!report || !Array.isArray(report.sections)) throw new TypeError('请先生成有效报告，再导出 Word。');
  if (typeof filePath !== 'string' || !filePath.trim() || path.extname(filePath).toLowerCase() !== '.docx') throw new TypeError('Word 保存路径必须为 .docx 文件。');
  const destination = path.resolve(filePath);
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Footer, PageNumber } = require('docx');
  const paragraph = (text, options = {}) => new Paragraph({ ...options, children: [new TextRun(cleanText(text))] });
  const children = [
    paragraph(report.title || '工作报告', { heading: HeadingLevel.TITLE }),
    paragraph(`统计区间：${report.startDate} 至 ${report.endDate}`),
    paragraph(`数据截至：${beijingTime(instant(report.cutoffAt))}`),
    paragraph(`生成时间：${beijingTime(instant(report.generatedAt || report.cutoffAt))}`),
    paragraph(report.summary), paragraph(COUNTING_NOTE),
  ];
  for (const section of report.sections) {
    children.push(paragraph(`${section.title}（${section.items.length}）`, { heading: HeadingLevel.HEADING_1, keepNext: true }));
    children.push(paragraph(section.description));
    if (!section.items.length) children.push(paragraph(section.emptyText));
    for (const item of section.items) {
      children.push(paragraph(item.title, { heading: HeadingLevel.HEADING_2, keepNext: true }));
      if (item.detail !== undefined) {
        children.push(paragraph(`${item.status}：${item.detail}`));
        if (item.scope) children.push(paragraph(`范围：${item.scope}`));
      } else {
        children.push(paragraph(`任务编号：${item.taskId} ｜ 截至状态：${item.statusLabel}${item.reopenedAt && item.status !== 'done' ? '（已重新打开）' : ''} ｜ 来源：${item.sourceName}`));
        if (item.dueDate) children.push(paragraph(`到期日：${item.dueDate}`));
        if (item.completionTimes?.length) children.push(paragraph(`期间完成事件：${item.completionTimes.map(value => beijingTime(instant(value))).join('；')}`));
        if (item.reopenedAt) children.push(paragraph(`重新打开：${beijingTime(instant(item.reopenedAt))}`));
        if (item.deletedAt) children.push(paragraph('截至时刻已删除。'));
        for (const line of cleanText(item.notes).split(/\r?\n/)) if (line) children.push(paragraph(line));
        if (item.evidence?.length) children.push(paragraph(`依据：${item.evidence.join('；')}`));
      }
    }
  }
  const document = new Document({
    creator: '个人待办事项看板', title: report.title || '工作报告', description: report.summary,
    styles: {
      default: { document: { run: { font: { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Microsoft YaHei' }, size: 21 }, paragraph: { spacing: { after: 100, line: 330 } } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { size: 42, bold: true, color: '172C43' }, paragraph: { spacing: { after: 300 } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 28, bold: true, color: '172C43' }, paragraph: { outlineLevel: 0, spacing: { before: 280, after: 120 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 23, bold: true }, paragraph: { outlineLevel: 1, spacing: { before: 160, after: 80 } } },
      ],
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1020, right: 964, bottom: 1020, left: 964 } } },
      footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun('个人待办事项看板｜第 '), new TextRun({ children: [PageNumber.CURRENT] }), new TextRun(' 页')] })] }) },
      children,
    }],
  });
  const buffer = await Packer.toBuffer(document);
  let handle;
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    handle = await fs.open(destination, 'wx');
    await handle.writeFile(buffer);
    await handle.sync();
    const stat = await handle.stat();
    if (stat.size !== buffer.length) throw Object.assign(new Error('Word 文件写入不完整。'), { code: 'EIO' });
    await handle.close();
    handle = null;
    return destination;
  } catch (error) {
    // Only remove a file this call created. Existing revisions are never replaced.
    if (handle) { await handle.close().catch(() => {}); await fs.unlink(destination).catch(() => {}); }
    const advice = error.code === 'EEXIST' ? '该文件已存在，请使用新的修订号或保存名称。'
      : ['EACCES', 'EPERM', 'EBUSY'].includes(error.code) ? '请关闭占用该文件的程序，或选择有写入权限的文件夹。'
      : error.code === 'ENOSPC' ? '磁盘空间不足，请清理空间或选择其他磁盘。' : '请检查保存目录是否有效、磁盘空间及写入权限。';
    throw Object.assign(new Error(`Word 导出失败：${advice} ${error.message}`, { cause: error }), { code: error.code });
  }
}

module.exports = { buildReport, exportDocx };
