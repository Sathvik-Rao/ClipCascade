export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function tooLargeMessage(size: number, maxSize: number): string {
  return `Too large to sync: ${formatBytes(size)} (server limit ${formatBytes(maxSize)})`;
}
