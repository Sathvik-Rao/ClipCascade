/* CCB1 codec. Keep the browser copy byte-for-byte identical (tested). */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('buffer').Buffer);
  else root.ClipCascadeBinary = factory(null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(NodeBuffer) {
  'use strict';
  const FORMAT = 'ccb1';
  const CONTENT_TYPE = 'application/octet-stream';
  const bytes = value => value instanceof Uint8Array ? value :
    ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
  const utf8 = value => new TextEncoder().encode(value);
  const text = value => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(value);
  function concat(parts) {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }
  function fromBase64(value) {
    if (typeof value !== 'string') throw new Error('Invalid Base64');
    // Android's existing file reader uses Base64.DEFAULT (76 columns plus LF).
    value = value.replace(/\s+/g, '');
    if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) throw new Error('Invalid Base64');
    const padding = value.indexOf('=');
    if (padding >= 0 && (padding < value.length - 2 || !/^={1,2}$/.test(value.slice(padding)))) throw new Error('Invalid Base64');
    return NodeBuffer ? new Uint8Array(NodeBuffer.from(value, 'base64')) : Uint8Array.from(atob(value), c => c.charCodeAt(0));
  }
  function toBase64(value) {
    if (NodeBuffer) return NodeBuffer.from(value).toString('base64');
    let result = '';
    for (let i = 0; i < value.length; i += 8192) result += String.fromCharCode(...value.subarray(i, i + 8192));
    return btoa(result);
  }
  function pack(header, payload) {
    const encoded = utf8(JSON.stringify(header));
    if (encoded.length > 65536) throw new Error('Binary header too large');
    const prefix = new Uint8Array(8);
    prefix.set([67, 67, 66, 49]);
    new DataView(prefix.buffer).setUint32(4, encoded.length);
    return concat([prefix, encoded, bytes(payload)]);
  }
  function unpack(value) {
    const data = bytes(value);
    if (data.length < 8 || data[0] !== 67 || data[1] !== 67 || data[2] !== 66 || data[3] !== 49) throw new Error('Invalid binary frame');
    const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4);
    if (length > 65536 || length > data.length - 8) throw new Error('Invalid binary header length');
    const header = JSON.parse(text(data.subarray(8, 8 + length)));
    if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('Invalid binary header');
    return [header, data.subarray(8 + length)];
  }
  function originalContent(payload, kind) {
    if (kind === 'text') return payload;
    if (kind === 'image') return typeof payload === 'string' ? fromBase64(payload) : bytes(payload);
    if (kind !== 'files') throw new Error('Unsupported content type');
    return typeof payload === 'string' ? Object.fromEntries(Object.entries(JSON.parse(payload))
      .map(([name, value]) => [name, fromBase64(value)])) : payload;
  }
  function legacyContent(payload, kind) {
    if (kind === 'text' || typeof payload === 'string') return payload;
    if (kind === 'image') return toBase64(payload);
    return JSON.stringify(Object.fromEntries(Object.entries(payload).map(([name, value]) => [name, toBase64(value)])));
  }
  function contentParts(payload, kind) {
    payload = originalContent(payload, kind);
    if (kind === 'text') return [{type: kind, files: null}, [utf8(payload)]];
    if (kind === 'image') return [{type: kind, files: null}, [payload]];
    return [{type: kind, files: Object.entries(payload).map(([name, value]) => [name, value.length])}, Object.values(payload)];
  }
  async function encodeContent(payload, kind, encrypt = null, onRawSize = () => {}, checkCurrent = () => {}) {
    const [header, parts] = contentParts(payload, kind);
    const prefix = pack(header, new Uint8Array(0));
    const raw = new Uint8Array(prefix.length + parts.reduce((sum, part) => sum + part.length, 0));
    raw.set(prefix);
    let position = prefix.length;
    for (const part of parts) {
      for (let offset = 0; offset < part.length; offset += 1024 * 1024) {
        checkCurrent();
        const block = part.subarray(offset, offset + 1024 * 1024);
        raw.set(block, position);
        position += block.length;
        if (raw.length > 1024 * 1024) await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    checkCurrent();
    onRawSize(raw.length);
    return encrypt ? bytes(await encrypt(raw)) : raw;
  }
  async function decodeContent(raw, kind, decrypt = null, limit = null, original = false) {
    if (Number.isSafeInteger(limit) && limit >= 0 && raw.length > limit + 65536 + 64) throw new Error('Binary content exceeds receive limit');
    if (decrypt) raw = await decrypt(bytes(raw));
    const [header, content] = unpack(raw);
    if (header.type !== kind) throw new Error('Content type mismatch');
    if (Number.isSafeInteger(limit) && limit >= 0 && content.length > limit) throw new Error('Binary content exceeds receive limit');
    if (kind === 'text') return text(content);
    if (kind === 'image') return original ? content : toBase64(content);
    if (kind !== 'files' || !Array.isArray(header.files)) throw new Error('Invalid binary content');
    const result = Object.create(null);
    let offset = 0;
    for (const entry of header.files) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid file entry');
      const [name, length] = entry;
      if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\0]/.test(name) || Object.prototype.hasOwnProperty.call(result, name) || !Number.isSafeInteger(length) || length < 0 || length > content.length - offset) throw new Error('Invalid file entry');
      result[name] = original ? content.subarray(offset, offset + length) : toBase64(content.subarray(offset, offset + length));
      offset += length;
    }
    if (offset !== content.length) throw new Error('Trailing binary content');
    return original ? result : JSON.stringify(result);
  }
  const encodeFrame = (payload, kind, metadata, encrypted = false) => pack({type: kind, metadata, encrypted}, payload);
  function decodeFrame(data) {
    const [header, payload] = unpack(data);
    if (!['text', 'image', 'files'].includes(header.type) || typeof header.encrypted !== 'boolean') throw new Error('Invalid binary envelope');
    const meta = header.metadata;
    if (!Number.isSafeInteger(meta?.contentSizeBytes) || meta.contentSizeBytes < 0) throw new Error('Invalid binary content size');
    if (Object.prototype.hasOwnProperty.call(meta, 'totalFragments')) {
      if (!Number.isSafeInteger(meta.totalFragments) || !Number.isSafeInteger(meta.index)
          || meta.totalFragments < 1 || meta.totalFragments > 65536 || meta.index < 0 || meta.index >= meta.totalFragments
          || meta.isFragmented !== (meta.totalFragments > 1) || typeof meta.id !== 'string' || !meta.id
          || payload.length > 15360) throw new Error('Invalid binary fragments');
    }
    return {...header, payload, _cc_binary: true};
  }
  function fragments(data, size = 15360) {
    const result = [];
    for (let i = 0; i < data.length; i += size) result.push(data.subarray(i, i + size));
    return result.length ? result : [new Uint8Array(0)];
  }
  function recipients(plan) {
    if (plan?.format !== FORMAT || !Array.isArray(plan.recipients) || plan.recipients.length > 256) return null;
    if (!plan.recipients.every(peer => typeof peer.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(peer.id) && typeof peer.binary === 'boolean')) return null;
    if (new Set(plan.recipients.map(peer => peer.id)).size !== plan.recipients.length) return null;
    return {binary: plan.recipients.filter(p => p.binary).map(p => p.id), legacy: plan.recipients.filter(p => !p.binary).map(p => p.id)};
  }
  return {FORMAT, CONTENT_TYPE, bytes, concat, fromBase64, toBase64, pack, unpack, encodeContent, decodeContent, encodeFrame, decodeFrame, fragments, recipients, originalContent, legacyContent, contentParts};
});
