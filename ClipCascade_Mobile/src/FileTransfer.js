import {fromBase64} from './BinaryProtocol';
import {base64ContentSize} from './TransferLimits';

// One URI stays one URI, even if it contains a comma.
export function fileUris(content) {
  const uris = Array.isArray(content) ? content : [content];
  if (uris.some(uri => typeof uri !== 'string' || !uri.trim())) {
    throw new Error('Invalid file URI');
  }
  return uris;
}

export async function encodeFiles(content, bridge, checkCurrent = () => {}, onSize = () => {}, raw = false) {
  checkCurrent();
  const uris = fileUris(content);
  const names = await Promise.all(uris.map(uri => bridge.getFileName(uri)));
  checkCurrent();
  const reserved = new Set(names.map(name => name.toLowerCase()));
  const used = new Set();
  const files = Object.create(null);
  let contentSizeBytes = 0;
  for (let i = 0; i < uris.length; i++) {
    checkCurrent();
    const name = names[i];
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    let number = 1;
    if (used.has(candidate.toLowerCase())) {
      do {
        candidate = `${stem} (${number++})${extension}`;
      } while (reserved.has(candidate.toLowerCase()) || used.has(candidate.toLowerCase()));
    }
    used.add(candidate.toLowerCase());
    files[candidate] = raw ? await readClipboardBytes(uris[i], bridge, checkCurrent) : await bridge.getFileAsBase64(uris[i]);
    checkCurrent();
    contentSizeBytes += raw ? files[candidate].length : base64ContentSize(files[candidate]);
  }
  onSize(contentSizeBytes);
  return raw ? files : JSON.stringify(files);
}

// Consume before attempting delivery: failures are reported, never replayed.
export async function deliverPendingShare(bridge, ready, send, onError, onBeginShare = () => {}) {
  // A connection opening during the native read must not revive a rejected share.
  const wasReady = ready();
  const share = await bridge.takePendingShare();
  if (!share) return false;
  try {
    if (share.expired) {
      throw new Error('Share expired during startup. Share it again.');
    }
    if (!wasReady || !ready()) {
      throw new Error('Share not sent: no connection is ready or another send is in progress. Wait until connected, then share it again.');
    }
    onBeginShare(share.clipboardBaselineRevision);
    if ((await send(share.content, share.type)) === false) {
      throw new Error('Share was interrupted. Share it again.');
    }
  } catch (error) {
    await onError(error);
  }
  return true;
}

// Read a URI once. The classic RN bridge requires bounded Base64 chunks;
// decode each immediately, retaining bytes instead of a legacy attachment string.
export async function readClipboardBytes(uri, bridge, checkCurrent = () => {}) {
  const id = await bridge.openClipboardBytes(uri);
  return readClipboardStream(id, bridge, checkCurrent);
}

export async function readClipboardStream(id, bridge, checkCurrent = () => {}) {
  try {
    const parts = [];
    while (true) {
      checkCurrent();
      const part = await bridge.readClipboardBytes(id);
      checkCurrent();
      if (!part.length) break;
      parts.push(fromBase64(part));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (let index = 0; index < parts.length; index++) {
      checkCurrent();
      result.set(parts[index], offset);
      offset += parts[index].length;
      parts[index] = null;
      if (index % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    checkCurrent();
    return result;
  } finally {
    await bridge.closeClipboardBytes(id);
  }
}
