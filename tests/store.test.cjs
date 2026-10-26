'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createStore } = require('../server/store.cjs');
const { parseRecords } = require('../server/extract.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-store-test-'));
  let store = createStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, get store() { return store; }, reopen() { store.close(); store = createStore(dir); return store; } };
}
const source = (id, name = id) => ({ id, name, platform: 'wechat', scope: ['项目群'], enabled: true });
const message = (id, text, extras = {}) => ({ id, text, at: '2026-10-26T08:00:00+08:00', conversation: '项目群', ...extras });
const proposal = title => ({ isTask: true, title, dueDate: '', priority: 2 });
const legacyMessage = (line, text) => message(`text-${line}-${createHash('sha256').update(text).digest('hex').slice(0,16)}`, text);
const canonicalMessages = text => parseRecords(text).map(m => message(m.id, m.text));

test('SQLite 关闭重开后保留任务、来源范围、设置、消息与审计记录', t => {
  const f = fixture(t); const s = source('wx', '工作微信');
  f.store.put('sources', s);
  f.store.setSetting('settings', { name: '中文使用者', ai: { mode: 'rules' }, allowedProjects: ['D:\\工作'] });
  const result = f.store.importMessage(s, message('m-1', '请核对中文图纸'), proposal('核对中文图纸'));
  f.store.log('source.sync', { sourceId: s.id, success: true });
  f.store.put('reports', { id: 'report-1', revision: 1, path: '报告.docx' });
  f.store.put('deliveries', { id: 'delivery-1', reportId: 'report-1', status: 'unknown' });
  const reopened = f.reopen();
  assert.equal(reopened.get('tasks', result.taskId).title, '核对中文图纸');
  assert.deepEqual(reopened.get('sources', 'wx').scope, ['项目群']);
  assert.equal(reopened.getSetting('settings').name, '中文使用者');
  assert.equal(reopened.getSetting('missing', 'fallback'), 'fallback');
  assert.equal(reopened.messages()[0].taskId, result.taskId);
  assert.equal(reopened.events()[0].type, 'created');
  assert.equal(reopened.all('activity')[0].kind, 'source.sync');
  assert.equal(reopened.get('reports', 'report-1').revision, 1);
  assert.equal(reopened.get('deliveries', 'delivery-1').status, 'unknown');
});

test('完成、修改已完成任务和重开分别保留可回查的状态快照', t => {
  const { store } = fixture(t);
  const task = store.createTask({ title: '核对交付清单', notes: '原始备注' });
  const done = store.patchTask(task.id, { status: 'done' });
  assert.ok(done.completedAt);
  const edited = store.patchTask(task.id, { notes: '补充验收记录' });
  assert.equal(edited.completedAt, done.completedAt);
  const reopened = store.patchTask(task.id, { status: 'doing' });
  assert.equal(reopened.completedAt, null);
  const events = store.events();
  assert.deepEqual(events.map(e => e.type), ['created', 'completed', 'updated', 'reopened']);
  assert.equal(events[1].before.status, 'todo');
  assert.equal(events[1].after.status, 'done');
  assert.equal(events[3].before.notes, '补充验收记录');
  assert.equal(events[3].after.status, 'doing');
});

test('删除与撤销删除保留原任务和事件，不抹去完成记录', t => {
  const { store } = fixture(t);
  const task = store.createTask({ title: '保存验收资料' });
  store.patchTask(task.id, { status: 'done' });
  const removed = store.deleted(task.id); assert.ok(removed.deletedAt);
  const restored = store.deleted(task.id, true);
  assert.equal(restored.deletedAt, null); assert.equal(restored.status, 'done');
  assert.deepEqual(store.events().map(e => e.type), ['created', 'completed', 'deleted', 'restored']);
});

test('同一来源消息重复导入只产生一个任务，重启后依然去重', t => {
  const f = fixture(t); const s = source('wx'); const m = message('stable-id', '请发送图纸');
  const first = f.store.importMessage(s, m, proposal('发送图纸'));
  const again = f.store.importMessage(s, m, proposal('不同的 AI 建议'));
  assert.deepEqual(again, { duplicate: true, taskId: first.taskId });
  assert.equal(f.store.all('tasks').length, 1); assert.equal(f.store.events().length, 1);
  assert.equal(f.reopen().importMessage(s, m, proposal('再次整理')).duplicate, true);
  assert.equal(f.store.messages().length, 1);
});

test('忽略的收到消息也保留去重水位，不能稍后被重复解释成新任务', t => {
  const { store } = fixture(t); const s = source('wx'); const m = message('ack', '收到');
  assert.equal(store.importMessage(s, m, { isTask: false }).action, 'ignored');
  assert.equal(store.importMessage(s, m, proposal('错误任务')).duplicate, true);
  assert.equal(store.all('tasks').length, 0); assert.equal(store.messages()[0].taskId, null);
});

test('跨来源相同标题和相同消息编号不会自动合并，明确指定任务才关联', t => {
  const { store } = fixture(t); const wx = source('wx', '项目微信'); const mail = source('mail', '工作邮箱');
  const first = store.importMessage(wx, message('1', '请核对报价'), proposal('核对报价'));
  const independent = store.importMessage(mail, message('1', '请核对报价'), proposal('核对报价'));
  assert.notEqual(first.taskId, independent.taskId);
  const linked = store.importMessage(mail, message('2', '补充：请核对税率'), proposal('核对税率'), first.taskId);
  assert.equal(linked.taskId, first.taskId); assert.equal(linked.action, 'updated');
  assert.equal(store.all('tasks').length, 2);
  assert.deepEqual(store.get('tasks', first.taskId).links.map(l => [l.sourceId, l.ref]), [['wx', '1'], ['mail', '2']]);
});

test('精确回复关系可更新原任务，文字完成或收到不能自动完成任务', t => {
  const { store } = fixture(t); const s = source('wx');
  const first = store.importMessage(s, message('1', '请明天发图纸'), { ...proposal('发送图纸'), dueDate: '2026-10-27' });
  const update = store.importMessage(s, message('2', '收到，安排了，已经完成', { replyTo: '1' }), { isTask: false });
  assert.equal(update.taskId, first.taskId); assert.equal(update.action, 'updated');
  const task = store.get('tasks', first.taskId);
  assert.equal(task.status, 'inbox'); assert.equal(task.completedAt, null); assert.equal(task.dueDate, '2026-10-27');
  assert.equal(task.links.length, 2); assert.equal(store.events().filter(e => e.type === 'completed').length, 0);
});

test('关联到不存在的任务拒绝写入，并允许之后用正确目标重试', t => {
  const { store } = fixture(t); const s = source('wx'); const m = message('retry', '请核对资料');
  assert.throws(() => store.importMessage(s, m, proposal('核对资料'), 'missing'), /任务不存在/);
  assert.equal(store.messages().length, 0); assert.equal(store.all('tasks').length, 0);
  const target = store.createTask({ title: '现有工作' });
  assert.equal(store.importMessage(s, m, proposal('核对资料'), target.id).taskId, target.id);
});

test('纠正错误关联会移动证据且移除旧任务自动附加的消息备注', t => {
  const { store } = fixture(t); const s = source('mail', '工作邮箱');
  const oldTask = store.createTask({ title: '旧事项', notes: '本人原始备注' });
  const target = store.createTask({ title: '正确事项', notes: '正确事项备注' });
  store.importMessage(s, message('wrong-link', '这条证据属于正确事项'), { isTask: false }, oldTask.id);
  const saved = store.messages()[0]; store.relink(saved.id, target.id);
  assert.equal(store.messages()[0].taskId, target.id);
  assert.equal(store.get('tasks', oldTask.id).links.length, 0);
  assert.equal(store.get('tasks', oldTask.id).notes, '本人原始备注');
  assert.equal(store.get('tasks', target.id).links[0].text, '这条证据属于正确事项');
  assert.equal(store.all('activity').at(-1).kind, 'association.corrected');
});

test('重复纠错到当前任务是幂等操作，不重复追加同一证据', t => {
  const { store } = fixture(t); const s = source('wx');
  const task = store.createTask({ title: '正确任务' });
  store.importMessage(s, message('evidence', '请核对附件'), { isTask: false }, task.id);
  const saved = store.messages()[0];
  store.relink(saved.id, task.id); store.relink(saved.id, task.id);
  assert.equal(store.get('tasks', task.id).links.length, 1);
});

test('备份包含 WAL 中最新任务，可用独立数据库打开验证', t => {
  const { store, dir } = fixture(t);
  const task = store.createTask({ title: '刚创建尚未关闭的任务' });
  const backupDir = path.join(dir, 'backup'); fs.mkdirSync(backupDir);
  const backupFile = path.join(backupDir, 'workboard.sqlite');
  assert.equal(store.backup(backupFile), backupFile);
  const restored = createStore(backupDir);
  try { assert.equal(restored.get('tasks', task.id).title, task.title); assert.equal(restored.events().length, 1); }
  finally { restored.close(); }
});

test('旧版真实消息升级后重启、头插和重排均命中原卡，保留旧消息与证据', t => {
  const f = fixture(t); const s = source('upgrade-wx');
  const old = [legacyMessage(0, '请核对旧图纸'), legacyMessage(1, '请发送旧报价')];
  const original = old.map(m => f.store.importMessage(s, m, proposal(m.text)));
  const snapshots = original.map(v => f.store.get('tasks', v.taskId));
  const oldRows = f.store.db.prepare('SELECT id,ref,json,taskId FROM messages ORDER BY id').all();
  const store = f.reopen();
  const upgraded = canonicalMessages(old.map(m => m.text).join('\n')).map(m => store.importMessage(s, m, proposal(m.text)));
  assert.deepEqual(upgraded.map(v => [v.duplicate, v.taskId]), original.map(v => [true, v.taskId]));
  const inserted = canonicalMessages('请提交新增资料\n' + old.map(m => m.text).join('\n')).map(m => store.importMessage(s, m, proposal(m.text)));
  assert.deepEqual(inserted.map(v => v.duplicate), [false, true, true]);
  const reordered = canonicalMessages('请发送旧报价\n请提交新增资料\n请核对旧图纸').map(m => store.importMessage(s, m, proposal(m.text)));
  assert.ok(reordered.every(v => v.duplicate)); assert.equal(store.all('tasks').length, 3);
  for (let i = 0; i < original.length; i++) assert.deepEqual(store.get('tasks', original[i].taskId), snapshots[i]);
  for (const oldRow of oldRows) assert.deepEqual(store.db.prepare('SELECT id,ref,json,taskId FROM messages WHERE id=?').get(oldRow.id), oldRow);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM message_aliases').get().n, 2);
  assert.equal(f.reopen().importMessage(s, canonicalMessages(old[0].text)[0], proposal('再次启动')).taskId, original[0].taskId);
});

test('旧版同文多条按数值行号各自映射，新同文才新增，来源隔离且不采信伪hash', t => {
  const { store } = fixture(t); const s = source('repeat-wx'); const text = '请核对相同的旧图纸';
  const later = store.importMessage(s, legacyMessage(10, text), proposal('后出现的旧任务'));
  const earlier = store.importMessage(s, legacyMessage(2, text), proposal('先出现的旧任务'));
  const parsed = canonicalMessages([text, text, text].join('\n'));
  const first = store.importMessage(s, parsed[0], proposal(text));
  const second = store.importMessage(s, parsed[1], proposal(text));
  assert.deepEqual([first.taskId, second.taskId], [earlier.taskId, later.taskId]);
  assert.equal(first.duplicate, true); assert.equal(second.duplicate, true); assert.notEqual(first.taskId, second.taskId);
  const third = store.importMessage(s, parsed[2], proposal(text)); assert.equal(third.action, 'created');
  assert.equal(store.importMessage(s, parsed[2], proposal(text)).duplicate, true);
  assert.equal(store.all('tasks').length, 3, '两张既有同文卡应独立保留');
  assert.equal(store.importMessage(source('other-wx'), parsed[0], proposal(text)).action, 'created');
  const badSource = source('bad-legacy'); const badText = '请核对伪旧编号';
  const bad = store.importMessage(badSource, message('text-0-0000000000000000', badText), proposal(badText));
  const valid = store.importMessage(badSource, canonicalMessages(badText)[0], proposal(badText));
  assert.equal(valid.action, 'created'); assert.notEqual(valid.taskId, bad.taskId);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sourceId=?').get(badSource.id).n, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM message_aliases WHERE sourceId=?').get(badSource.id).n, 0);
});

test('身份迁移与导入失败整体回滚，重试及晚到旧格式记录会补齐别名', t => {
  const { store } = fixture(t); const s = source('rollback-wx'); const text = '请核对迁移前图纸';
  const old = store.importMessage(s, legacyMessage(0, text), proposal(text));
  const aliases = () => store.db.prepare('SELECT COUNT(*) AS n FROM message_aliases WHERE sourceId=?').get(s.id).n;
  const markers = () => store.db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'text-occurrence-aliases-v1:%'").get().n;
  store.db.exec("CREATE TRIGGER fail_message_import BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'injected migration rollback'); END");
  const newMessage = canonicalMessages('请提交迁移后新增资料')[0];
  assert.throws(() => store.importMessage(s, newMessage, proposal(newMessage.text)), /injected migration rollback/);
  assert.equal(aliases(), 0); assert.equal(markers(), 0); assert.equal(store.all('tasks').length, 1);
  assert.equal(store.messages().length, 1); assert.equal(store.events().length, 1);
  store.db.exec('DROP TRIGGER fail_message_import');
  assert.equal(store.importMessage(s, newMessage, proposal(newMessage.text)).action, 'created');
  assert.equal(aliases(), 1); assert.equal(markers(), 1);
  assert.equal(store.importMessage(s, canonicalMessages(text)[0], proposal(text)).taskId, old.taskId);
  const lateLegacy = store.importMessage(s, legacyMessage(5, text), proposal('晚到的旧格式同文'));
  assert.equal(markers(), 0, '新旧格式混用时必须使来源迁移标记失效');
  const second = canonicalMessages(text + '\n' + text)[1];
  assert.deepEqual(store.importMessage(s, second, proposal(text)), { duplicate: true, taskId: lateLegacy.taskId });
  assert.equal(aliases(), 2); assert.equal(markers(), 1); assert.equal(store.all('tasks').length, 3);
  assert.equal(store.importMessage(s, legacyMessage(5, text), proposal(text)).duplicate, true);
  assert.equal(markers(), 0, '重复旧格式导入也应失效，避免遗漏后续旧记录');
});

test('canonical replyTo可关联旧消息，纠错后别名实时跟随message当前任务', t => {
  const { store } = fixture(t); const s = source('reply-wx'); const text = '请核对有回复的旧图纸';
  const old = store.importMessage(s, legacyMessage(0, text), proposal(text));
  const oldRow = store.messages()[0]; const canonical = canonicalMessages(text)[0];
  const reply = store.importMessage(s, message('normal-reply', '收到补充资料', { replyTo: canonical.id }), { isTask: false });
  assert.equal(reply.taskId, old.taskId); assert.equal(reply.action, 'updated');
  const target = store.createTask({ title: '纠错后的正确任务' }); store.relink(oldRow.id, target.id);
  assert.deepEqual(store.importMessage(s, canonical, proposal(text)), { duplicate: true, taskId: target.id });
  const nextReply = store.importMessage(s, message('reply-after-correction', '后续证据', { replyTo: canonical.id }), { isTask: false });
  assert.equal(nextReply.taskId, target.id); assert.equal(nextReply.action, 'updated');
  assert.equal(store.get('tasks', target.id).links.length, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sourceId=?').get(s.id).n, 3);
});
