// One URI stays one URI, even if it contains a comma.
export function fileUris(content) {
  const uris = Array.isArray(content) ? content : [content];
  if (uris.some(uri => typeof uri !== 'string' || !uri.trim())) {
    throw new Error('Invalid file URI');
  }
  return uris;
}

export async function encodeFiles(content, bridge) {
  const uris = fileUris(content);
  const names = await Promise.all(uris.map(uri => bridge.getFileName(uri)));
  const reserved = new Set(names.map(name => name.toLowerCase()));
  const used = new Set();
  const files = Object.create(null);
  for (let i = 0; i < uris.length; i++) {
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
    files[candidate] = await bridge.getFileAsBase64(uris[i]);
  }
  return JSON.stringify(files);
}

// Consume before attempting delivery: failures are reported, never replayed.
export async function deliverPendingShare(bridge, ready, send, onError) {
  const share = await bridge.takePendingShare();
  if (!share) return false;
  try {
    if (share.expired) {
      throw new Error('Share expired during startup. Share it again.');
    }
    if (!ready()) {
      throw new Error('No connection available or another send is in progress. Share it again when ready.');
    }
    if ((await send(share.content, share.type)) === false) {
      throw new Error('Share was interrupted. Share it again.');
    }
  } catch (error) {
    await onError(error);
  }
  return true;
}
