import { base64url } from 'jose';
import { Env, HttpError, isDemo } from './common';

interface Credentials { keyId: string; applicationKey: string }

const encoder = new TextEncoder();

async function encryptionKey(env: Env) {
  const secret = encoder.encode(isDemo(env) ? 'local-demo-bucket-secret-only-for-loopback' : env.SHARE_SECRET ?? '');
  if (secret.length < 32) throw new HttpError(503, '请先配置至少 32 字节的 SHARE_SECRET');
  const master = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('cfb2-pan'), info: encoder.encode('bucket-credentials-v1'),
  }, master, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptCredentials(env: Env, id: string, credentials: Credentials) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) },
    await encryptionKey(env), encoder.encode(JSON.stringify(credentials)));
  return `${base64url.encode(iv)}.${base64url.encode(new Uint8Array(encrypted))}`;
}

export async function decryptCredentials(env: Env, id: string, stored: string): Promise<Credentials> {
  const key = await encryptionKey(env);
  try {
    const [iv, data] = stored.split('.');
    const json = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64url.decode(iv), additionalData: encoder.encode(id) },
      key, base64url.decode(data));
    const credentials = JSON.parse(new TextDecoder().decode(json)) as Credentials;
    if (!credentials.keyId || !credentials.applicationKey) throw new Error();
    return credentials;
  } catch { throw new HttpError(503, '无法解锁存储桶密钥，请检查 SHARE_SECRET'); }
}
