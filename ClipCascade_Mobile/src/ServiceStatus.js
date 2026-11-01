// A stopped service cannot advertise an active connection or pending downloads.
export function serviceStatus(flags) {
  const running = flags.wsIsRunning === 'true';
  const message = flags.wsStatusMessage || '';
  return {
    running: String(running),
    message: !running && message.startsWith('✅ Connected') ? '' : message,
    p2pMessage: running && flags.server_mode === 'P2P'
      ? flags.p2pStatusMessage || '' : '',
    filesAvailable: running && flags.filesAvailableToDownload === 'true',
  };
}
