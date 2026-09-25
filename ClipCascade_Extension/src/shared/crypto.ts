// Interoperable with ClipCascade_Desktop/src/utils/cipher_manager.py:
// PBKDF2-HMAC-SHA256 key derivation and AES-256-GCM with a 16-byte nonce,
// serialized as {"nonce", "ciphertext", "tag"} with base64 values.
import { sha3_512 } from "js-sha3";
import { base64ToBytes, bytesToBase64 } from "./base64";

const NONCE_BYTES = 16; // pycryptodome's default GCM nonce length
const TAG_BYTES = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The value sent as the login password (the server never sees the raw password). */
export function sha3_512Hex(input: string): string {
  return sha3_512(input).toLowerCase();
}

/** Derives the 32-byte AES key exactly like the desktop and mobile clients. */
export async function deriveKey(
  username: string,
  password: string,
  salt: string,
  rounds: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(username + password + salt),
      iterations: rounds,
    },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export function importAesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: TAG_BYTES * 8 },
      key,
      encoder.encode(plaintext),
    ),
  );
  return JSON.stringify({
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(sealed.subarray(0, sealed.length - TAG_BYTES)),
    tag: bytesToBase64(sealed.subarray(sealed.length - TAG_BYTES)),
  });
}

/** Throws if the payload is not an encrypted envelope or fails authentication. */
export async function decrypt(key: CryptoKey, payload: string): Promise<string> {
  const { nonce, ciphertext, tag } = JSON.parse(payload) as Record<string, unknown>;
  if (typeof nonce !== "string" || typeof ciphertext !== "string" || typeof tag !== "string") {
    throw new Error("Payload is not an encrypted envelope");
  }
  const ct = base64ToBytes(ciphertext);
  const t = base64ToBytes(tag);
  const sealed = new Uint8Array(ct.length + t.length);
  sealed.set(ct);
  sealed.set(t, ct.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(nonce), tagLength: t.length * 8 },
    key,
    sealed,
  );
  return decoder.decode(plain);
}
