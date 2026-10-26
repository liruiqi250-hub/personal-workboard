export const isDesktop = () => typeof window.board?.call === 'function';
export async function api(method, payload = {}) {
  if (!isDesktop()) throw new Error('当前是界面预览，未连接本机服务。请先运行本机启动入口，再打开提供的 localhost 地址。');
  const result = await window.board.call(method, payload);
  if (!result?.ok) throw new Error(typeof result?.error === 'string' ? result.error : result?.error?.message || '操作未完成，请稍后重试。');
  return result.data;
}
export const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const dateLabel = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录';
export const statuses = { inbox: '待确认', todo: '待开始', doing: '进行中', waiting: '等待回复', done: '已完成' };
export const sourceLabels = { wechat: '微信', email: '邮箱', dingtalk: '钉钉', manual: '手动记录' };
export const statusColors = { inbox: 'gold', todo: 'default', doing: 'cyan', waiting: 'orange', done: 'green' };
