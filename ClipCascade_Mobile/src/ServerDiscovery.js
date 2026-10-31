// Authentication and transport configuration have separate lifetimes.
export async function discoverServer(saved, fetchRequest = fetch, signal) {
  const base = saved.server_url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Unsupported server URL protocol');
  const request = async path => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort);
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetchRequest(base + path, {
        method: 'GET', credentials: 'include', signal: controller.signal,
        headers: {'Cache-Control': 'no-cache'},
      });
      if (!response.ok) {
        const error = new Error(`Server discovery failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
  let mode;
  try {
    ({mode} = await request('/server-mode'));
  } catch (error) {
    if (error.status === 404 && ['P2P', 'P2S'].includes(saved.server_mode) && saved.websocket_url) {
      return saved;
    }
    throw error;
  }
  if (!['P2P', 'P2S'].includes(mode)) {
    throw new Error(`Unsupported server mode: ${mode}`);
  }
  let stun = '';
  let maxsize = -1;
  if (mode === 'P2P') {
    ({url: stun} = await request('/stun-url'));
    if (typeof stun !== 'string') throw new Error('Invalid server STUN URL');
  } else {
    ({maxsize} = await request('/max-size'));
    if (!Number.isSafeInteger(maxsize) || maxsize < 0) {
      throw new Error('Invalid server clipboard size limit');
    }
  }
  const endpoint = mode === 'P2P' ? '/p2psignaling' : '/clipsocket';
  return {
    ...saved,
    server_mode: mode,
    websocket_url: base.replace(/^http/, 'ws') + endpoint,
    stun_url: stun,
    maxsize: String(maxsize),
  };
}
