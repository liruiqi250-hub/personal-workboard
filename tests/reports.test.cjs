'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { buildReport, exportDocx } = require('../server/reports.cjs');

const baseTask = (id, overrides = {}) => ({
  id, title: `任务 ${id}`, notes: '', status: 'todo', dueDate: '', priority: 2,
  sourceId: 'manual', createdAt: '2026-10-25T08:00:00+08:00', updatedAt: '2026-10-25T08:00:00+08:00',
  completedAt: null, deletedAt: null, example: false, ...overrides,
});
const manual = { id: 'manual', platform: 'manual', name: '手工登记', enabled: true, status: 'connected' };
const report = (input = {}) => buildReport({ type: 'daily', date: '2026-10-26', now: '2026-10-26T20:00:00+08:00', sources: [manual], ...input });
const section = (result, key) => result.sections.find(item => item.key === key);
const completeEvent = (task, at, beforeStatus = 'todo') => ({ taskId: task.id, type: 'task.completed', at, before: { ...task, status: beforeStatus, completedAt: null }, after: { ...task, status: 'done', completedAt: at, updatedAt: at } });

// Read the central directory and inflate actual DOCX entries with native Node.
// This checks content rather than merely accepting a filename or a PK prefix.
function zipEntries(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'DOCX 必须具有 ZIP 结束记录');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const contentAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const compressed = buffer.subarray(contentAt, contentAt + size);
    assert.ok(method === 0 || method === 8);
    entries.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-report-test-'));
  t.after(async () => {
    // This directory is exclusively created by this test; do not recursively delete.
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file));
    await fs.rmdir(directory);
  });
  return directory;
}

test('北京时间日界限：UTC 16:00 属于次日，未来记录和次日完成不计入', () => {
  const before = baseTask('before', { createdAt: '2026-10-25T15:59:59.999Z' });
  const atStart = baseTask('start', { createdAt: '2026-10-25T16:00:00.000Z', updatedAt: '2026-10-25T16:00:00.000Z' });
  const after = baseTask('future', { createdAt: '2026-10-26T16:00:00.000Z', updatedAt: '2026-10-26T16:00:00.000Z' });
  const result = report({ tasks: [before, atStart, after], now: '2026-10-30T12:00:00Z' });
  assert.equal(result.cutoffAt, '2026-10-26T15:59:59.999Z');
  assert.equal(result.stats.created, 1);
  assert.equal(result.stats.total, 2);
  assert.deepEqual(section(result, 'created').items.map(item => item.taskId), ['start']);
  assert.doesNotMatch(result.html, /任务 future/);
});

test('不带时区的应用时间按北京时间解释，不依赖服务器时区', () => {
  const modulePath = require.resolve('../server/reports.cjs');
  const script = `const {buildReport}=require(${JSON.stringify(modulePath)});const r=buildReport({date:'2026-10-26',now:'2026-10-26T01:00:00',tasks:[{id:'x',title:'时区任务',status:'todo',createdAt:'2026-10-26T00:00:00',updatedAt:'2026-10-26T00:00:00'}]});process.stdout.write(JSON.stringify({cutoffAt:r.cutoffAt,created:r.stats.created}));`;
  const outputs = ['UTC', 'America/Los_Angeles', 'Asia/Shanghai'].map(TZ => {
    const child = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  });
  assert.equal(new Set(outputs).size, 1);
  assert.deepEqual(JSON.parse(outputs[0]), { cutoffAt: '2026-10-25T17:00:00.000Z', created: 1 });
});

test('跨日未结保留，等待回复和逾期可重叠，合计按任务去重', () => {
  const old = baseTask('carry', { status: 'waiting', dueDate: '2026-10-25' });
  const result = report({ tasks: [old] });
  assert.equal(result.stats.created, 0);
  assert.equal(result.stats.open, 1);
  assert.equal(result.stats.waiting, 1);
  assert.equal(result.stats.overdue, 1);
  assert.equal(section(result, 'open').items[0].taskId, 'carry');
  assert.match(result.html, /分类可能重叠，不可直接相加/);
  assert.match(result.html, /未记录工时，不推算工时或工作量/);
});

test('完成后重新打开：保留期间完成事件，截至状态不算已完成', () => {
  const task = baseTask('reopened', { status: 'doing', updatedAt: '2026-10-26T11:00:00+08:00' });
  const completed = completeEvent(task, '2026-10-26T09:00:00+08:00');
  const reopen = { taskId: task.id, type: 'reopened', at: '2026-10-26T11:00:00+08:00', before: completed.after, after: { ...task, status: 'doing', completedAt: null } };
  const result = report({ tasks: [task], events: [completed, reopen] });
  assert.equal(result.stats.completed, 1);
  assert.equal(result.stats.completionEvents, 1);
  assert.equal(result.stats.currentlyDone, 0);
  assert.equal(result.stats.completedAndStillDone, 0);
  assert.equal(result.stats.open, 1);
  assert.equal(result.stats.reopened, 1);
  assert.equal(section(result, 'completed').items[0].status, 'doing');
  assert.match(result.html, /已重新打开/);
});

test('历史截止快照：截止之后的重新打开不改变截止之前已完成状态', () => {
  const task = baseTask('cutoff', { status: 'todo', updatedAt: '2026-10-27T09:00:00+08:00' });
  const completed = completeEvent(task, '2026-10-26T17:00:00+08:00');
  const reopen = { taskId: task.id, type: 'task.reopened', at: '2026-10-27T09:00:00+08:00', before: completed.after, after: task };
  const result = report({ tasks: [task], events: [completed, reopen], now: '2026-10-28T12:00:00+08:00' });
  assert.equal(result.stats.currentlyDone, 1);
  assert.equal(result.stats.reopened, 0);
  assert.equal(result.stats.historyGaps, 0);
  assert.equal(section(result, 'completed').items[0].status, 'done');
  assert.equal(section(result, 'completed').items[0].reopenedAt, null);
});

test('完成、重新打开、再次完成：任务去重且保留两次完成事件', () => {
  const task = baseTask('twice', { status: 'done', updatedAt: '2026-10-26T16:00:00+08:00' });
  const first = completeEvent(task, '2026-10-26T09:00:00+08:00');
  const reopened = { taskId: task.id, type: 'updated', at: '2026-10-26T12:00:00+08:00', before: first.after, after: { ...task, status: 'doing', completedAt: null } };
  const second = completeEvent(task, '2026-10-26T16:00:00+08:00', 'doing');
  const doneEdit = { taskId: task.id, type: 'updated', at: '2026-10-26T17:00:00+08:00', before: second.after, after: { ...second.after, notes: '补充说明' } };
  const result = report({ tasks: [task], events: [first, reopened, second, doneEdit] });
  assert.equal(result.stats.completed, 1);
  assert.equal(result.stats.completionEvents, 2);
  assert.equal(result.stats.currentlyDone, 1);
  assert.equal(result.stats.reopened, 1);
  assert.equal(section(result, 'completed').items[0].completionTimes.length, 2);
  assert.equal(section(result, 'reopened').items[0].status, 'done');
});

test('示例任务排除全部正式统计，不冒充真实成果', () => {
  const task = baseTask('sample', { example: true, status: 'done', createdAt: '2026-10-26T08:00:00+08:00', updatedAt: '2026-10-26T09:00:00+08:00' });
  const result = report({ tasks: [task], events: [completeEvent(task, '2026-10-26T09:00:00+08:00')] });
  assert.equal(result.stats.created, 0);
  assert.equal(result.stats.completed, 0);
  assert.equal(result.stats.currentlyDone, 0);
  assert.equal(result.stats.excludedExamples, 1);
  assert.equal(section(result, 'completed').items.length, 0);
  assert.match(result.html, /不代表真实工作成果/);
  assert.doesNotMatch(result.html, /任务 sample/);
});

test('未接入和只有已连接标记的来源明确显示读取缺口', () => {
  const result = report({ sources: [{ id: 'mail', platform: 'email', name: '工作邮箱', enabled: true, status: 'connected' }] });
  assert.equal(result.stats.sourceGaps, 3);
  const coverage = section(result, 'sources').items;
  assert.equal(coverage.find(item => item.platform === '邮箱').status, '读取待核对');
  assert.equal(coverage.find(item => item.platform === '微信').status, '未接入');
  assert.match(result.summary, /不能将缺失数据解释为没有工作/);
  assert.match(result.html, /没有可核实的成功读取时间/);
  assert.doesNotMatch(result.html, /今天没有工作/);
});

test('已记录区间水位才能注明覆盖，读取异常保留具体原因', () => {
  const result = report({ sources: [
    { id: 'mail', platform: 'email', name: '工作邮箱', enabled: true, status: 'connected', lastSuccessAt: '2026-10-26T20:00:00+08:00', coverageStartAt: '2026-10-25T00:00:00+08:00', readThroughAt: '2026-10-26T20:00:00+08:00' },
    { id: 'wx', platform: 'wechat', name: '工作微信', enabled: true, status: 'error', lastError: '需要本人扫码' },
  ] });
  assert.equal(section(result, 'sources').items.find(item => item.sourceId === 'mail').status, '有覆盖记录');
  assert.equal(result.stats.sourceGaps, 2);
  assert.match(result.html, /需要本人扫码/);
});

test('名称、任务、备注、来源与编号特殊字符只作为文字输出', () => {
  const payload = '<script>alert("注入")</script>&\'中文';
  const result = report({ name: payload, tasks: [baseTask(payload, { title: payload, notes: payload, sourceId: payload })], sources: [{ id: payload, platform: 'manual', name: payload, enabled: true }] });
  assert.ok(result.title.includes(payload));
  assert.ok(result.html.includes('&lt;script&gt;alert(&quot;注入&quot;)&lt;/script&gt;&amp;&#39;中文'));
  assert.doesNotMatch(result.html, /<script|<iframe|<img|<link\b|href=|src=/i);
  assert.match(result.html, /@page\{size:A4/);
  assert.match(result.html, /default-src 'none'/);
});

test('周报采用北京时间周一至周日，当前周截至 now，不包含未来完成', () => {
  const task = baseTask('future-completion', { status: 'done', createdAt: '2026-10-26T08:00:00+08:00', updatedAt: '2026-10-28T10:00:00+08:00' });
  const event = completeEvent(task, '2026-10-28T10:00:00+08:00');
  const result = report({ type: 'weekly', date: '2026-10-28', now: '2026-10-27T12:00:00+08:00', tasks: [task], events: [event] });
  assert.equal(result.startDate, '2026-10-26');
  assert.equal(result.endDate, '2026-11-01');
  assert.equal(result.cutoffAt, '2026-10-27T04:00:00.000Z');
  assert.equal(result.stats.completed, 0);
  assert.equal(result.stats.open, 1);
  assert.equal(report({ type: 'weekly', date: '2026-11-01' }).startDate, '2026-10-26');
  assert.equal(report({ type: 'weekly', date: '2026-11-02' }).startDate, '2026-11-02');
});

test('明日和下周安排仅使用已登记到期日，已完成事项不充作计划', () => {
  const tomorrow = baseTask('tomorrow', { dueDate: '2026-10-27' });
  const nextWeek = baseTask('next-week', { dueDate: '2026-11-04' });
  const done = baseTask('done', { dueDate: '2026-10-27', status: 'done' });
  const daily = report({ tasks: [tomorrow, nextWeek, done] });
  assert.deepEqual(section(daily, 'plan').items.map(item => item.taskId), ['tomorrow']);
  const weekly = report({ type: 'weekly', tasks: [tomorrow, nextWeek, done] });
  assert.deepEqual(section(weekly, 'plan').items.map(item => item.taskId), ['next-week']);
});

test('没有完成事件时不从当前 done 或 completedAt 编造期间完成', () => {
  const result = report({ tasks: [baseTask('no-event', { status: 'done', completedAt: '2026-10-26T10:00:00+08:00', updatedAt: '2026-10-26T10:00:00+08:00' })] });
  assert.equal(result.stats.completed, 0);
  assert.equal(result.stats.currentlyDone, 1);
  assert.equal(section(result, 'completed').items.length, 0);
  assert.match(result.html, /完成发生的时间无法核实/);
});

test('导入为 done 的创建快照不等同于真实完成事件', () => {
  const task = baseTask('import-done', { status: 'done', createdAt: '2026-10-26T10:00:00+08:00', updatedAt: '2026-10-26T10:00:00+08:00' });
  const result = report({ tasks: [task], events: [{ taskId: task.id, type: 'created', at: task.createdAt, before: null, after: task }] });
  assert.equal(result.stats.created, 1);
  assert.equal(result.stats.currentlyDone, 1);
  assert.equal(result.stats.completed, 0);
});

test('截止之后修改标题和到期日，报告恢复此前完整快照字段', () => {
  const before = baseTask('history-fields', { title: '原始事项', dueDate: '2026-10-25' });
  const after = { ...before, title: '后续重命名', dueDate: '2026-10-29', updatedAt: '2026-10-27T10:00:00+08:00' };
  const event = { taskId: before.id, type: 'updated', at: after.updatedAt, before, after };
  const result = report({ tasks: [after], events: [event], now: '2026-10-28T12:00:00+08:00' });
  assert.equal(result.stats.overdue, 1);
  const row = section(result, 'open').items[0];
  assert.equal(row.title, '原始事项');
  assert.equal(row.dueDate, '2026-10-25');
  assert.doesNotMatch(result.html, /后续重命名/);
});

test('历史变更缺少快照时标为待核对，不把当前 done 套用到过去', () => {
  const task = baseTask('unknown', { status: 'done', updatedAt: '2026-10-28T10:00:00+08:00', completedAt: '2026-10-28T10:00:00+08:00' });
  const result = report({ tasks: [task], now: '2026-10-29T12:00:00+08:00' });
  assert.equal(result.stats.unknown, 1);
  assert.equal(result.stats.currentlyDone, 0);
  assert.equal(result.stats.historyGaps, 1);
  assert.equal(section(result, 'confirmation').items[0].status, 'unknown');
  assert.match(result.html, /不能确认历史状态/);
});

test('删除后的任务不算当前未结，删除前发生的完成事件保留', () => {
  const task = baseTask('deleted', { status: 'done', deletedAt: '2026-10-26T15:00:00+08:00', updatedAt: '2026-10-26T15:00:00+08:00' });
  const completion = completeEvent(task, '2026-10-26T10:00:00+08:00');
  completion.before.deletedAt = null; completion.after.deletedAt = null;
  const deletion = { taskId: task.id, type: 'deleted', at: task.deletedAt, before: completion.after, after: task };
  const result = report({ tasks: [task], events: [completion, deletion] });
  assert.equal(result.stats.total, 0);
  assert.equal(result.stats.completed, 1);
  assert.equal(result.stats.currentlyDone, 0);
  assert.equal(result.stats.deleted, 1);
  assert.match(result.html, /截至时刻已删除/);
});

test('仅有事件快照仍可回查任务，缺少无效事件不静默吞掉', () => {
  const task = baseTask('events-only', { status: 'done' });
  const result = report({ tasks: [], events: [completeEvent(task, '2026-10-26T10:00:00+08:00'), { taskId: 'bad', type: 'completed', at: 'invalid' }] });
  assert.equal(result.stats.completed, 1);
  assert.equal(result.stats.currentlyDone, 1);
  assert.equal(result.stats.historyGaps, 1);
  assert.match(result.html, /1 条事件缺少有效任务编号或时间/);
});

test('拒绝无效日期、类型与时间；未来区间不产生未来任务', () => {
  for (const date of ['2026-02-30', '2026-13-01', '26-10-26', 'invalid']) assert.throws(() => report({ date }), /报告日期/);
  assert.throws(() => report({ type: 'month' }), /报告类型/);
  assert.throws(() => report({ now: 'invalid' }), /生成时间/);
  const result = report({ date: '2026-11-10', tasks: [baseTask('future', { createdAt: '2026-11-10T08:00:00+08:00' })] });
  assert.equal(result.stats.total, 0);
  assert.match(result.summary, /统计区间尚未开始/);
});

test('Word 真正写入可编辑 DOCX ZIP，中文和特殊字符、A4 与可回查内容完整', async t => {
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, '日报_2026-10-26_R01.docx');
  const payload = '<script>中文 & 测试</script>';
  const result = report({ name: payload, tasks: [baseTask('word-task', { title: '客户方案核对', notes: '第一行\n第二行\u0000控制字符' })] });
  assert.equal(await exportDocx(result, destination), destination);
  const buffer = await fs.readFile(destination);
  assert.equal(buffer.readUInt32LE(0), 0x04034b50);
  const zip = zipEntries(buffer);
  assert.ok(zip.has('[Content_Types].xml'));
  assert.ok(zip.has('word/styles.xml'));
  const document = zip.get('word/document.xml').toString('utf8');
  assert.match(document, /客户方案核对/);
  assert.match(document, /word-task/);
  assert.match(document, /&lt;script&gt;中文 &amp; 测试&lt;\/script&gt;/);
  assert.match(document, /w:w="11906" w:h="16838"/);
  assert.match(document, /第一行/);
  assert.match(document, /第二行�控制字符/);
  assert.doesNotMatch(document, /w:documentProtection|\u0000/);
  const relationships = zip.get('word/_rels/document.xml.rels').toString('utf8');
  assert.doesNotMatch(relationships, /TargetMode="External"/);
});

test('Word 默认不覆盖已有修订，写入失败反馈真实错误', async t => {
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, '已存在.docx');
  const original = Buffer.from('保留原文件');
  await fs.writeFile(destination, original);
  await assert.rejects(exportDocx(report(), destination), error => error.code === 'EEXIST' && /新的修订号/.test(error.message));
  assert.deepEqual(await fs.readFile(destination), original);
  const blocker = path.join(directory, '不是目录');
  await fs.writeFile(blocker, 'blocker');
  await assert.rejects(exportDocx(report(), path.join(blocker, '失败.docx')), /Word 导出失败/);
  await assert.rejects(exportDocx(report(), path.join(directory, '错误.pdf')), /\.docx/);
});
