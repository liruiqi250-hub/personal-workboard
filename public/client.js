(() => {
  let token = null;
  let sessionPromise = null;
  async function session() {
    if (token) return token;
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error('本机服务尚未连接，请按启动说明重新打开');
        const data = await response.json();
        if (!/^[a-f0-9]{64}$/.test(data?.token || '')) throw new Error('本机连接验证未完成，请稍后重试');
        token = data.token;
        return token;
      })().finally(() => { sessionPromise = null; });
    }
    return sessionPromise;
  }
  async function call(method, payload = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const submittedToken = await session();
      const response = await fetch('/api/call', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Board-Token': submittedToken }, body: JSON.stringify({ method, payload }) });
      if (response.status !== 403) return response.json();
      const result = await response.json().catch(() => null);
      if (token === submittedToken) token = null;
      // Explicit rejection precedes business execution. Never retry an unknown outcome.
      if (attempt === 0 && result?.errorCode === 'SESSION_EXPIRED') continue;
      return { ok: false, error: '本机连接验证未完成，当前输入已保留；请稍后重试或核对本机服务。' };
    }
  }
  window.board = Object.freeze({ call });
})();
