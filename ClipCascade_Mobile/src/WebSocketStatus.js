export function webSocketErrorMessage(event) {
  const detail = event?.message || event?.error?.message;
  return detail
    ? `❌ WebSocket Error: ${detail}`
    : '❌ WebSocket connection failed. Check network, TLS, session, and proxy WebSocket support; the server/proxy logs may show the cause.';
}

export function webSocketCloseMessage(event) {
  const code = event?.code;
  const reason =
    event?.reason ||
    (code === 1000
      ? 'Connection closed normally'
      : 'No close reason received. Check network and server/proxy logs.');
  return `⚠️ WebSocket Close${code != null ? ` (${code})` : ''}: ${reason}`;
}
