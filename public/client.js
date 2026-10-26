(() => {
  let token = null;
  async function call(method, payload = {}) {
    if (!token) { const r = await fetch('/api/session', { credentials: 'same-origin' }); if (!r.ok) throw new Error('本机服务尚未连接，请按启动说明重新打开'); token = (await r.json()).token; }
    const response = await fetch('/api/call', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Board-Token': token }, body: JSON.stringify({ method, payload }) });
    if (response.status === 403) { token = null; return { ok: false, error: '本机连接已刷新，请重新打开页面' }; }
    return response.json();
  }
  window.board = Object.freeze({ call });
})();
