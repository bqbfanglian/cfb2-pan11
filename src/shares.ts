import { base64url, jwtVerify, SignJWT } from 'jose';
import { body, Entry, Env, HttpError, idOf, isDemo, json, now, numberOf } from './common';
import { download } from './entries';

interface Share {
  id: string;
  file_id: string;
  digest: string;
  password_hash: string | null;
  password_salt: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

const encoder = new TextEncoder();
const grantLife = 3600;

function secret(env: Env) {
  const value = isDemo(env) ? 'local-demo-session-secret-only-for-loopback' : env.SHARE_SECRET;
  if (!value || encoder.encode(value).length < 32) throw new HttpError(503, '请先配置分享密钥');
  return encoder.encode(value);
}

async function signedValue(env: Env, input: string) {
  const key = await crypto.subtle.importKey('raw', secret(env), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url.encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(input))));
}

async function digest(token: string) {
  return base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}

async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: base64url.decode(salt), hash: 'SHA-256', iterations: 100000 }, key, 256));
}

async function link(env: Env, request: Request, id: string) {
  const shareHost = !isDemo(env) && env.SHARE_HOST?.trim().toLowerCase();
  const origin = shareHost ? `https://${shareHost}` : new URL(request.url).origin;
  return `${origin}/s/${await signedValue(env, `link:${id}`)}`;
}

export async function createShare(env: Env, request: Request) {
  const input = await body(request);
  const fileId = idOf(input.fileId);
  const days = numberOf(input.days ?? 7, 1, 365, '有效期须在 1 至 365 天之间');
  const password = input.password ?? '';
  if (typeof password !== 'string' || password.length > 128 || (password.length > 0 && password.length < 8)) {
    throw new HttpError(400, '分享密码须为 8 至 128 个字符');
  }
  const id = crypto.randomUUID();
  const timestamp = now();
  const salt = password ? base64url.encode(crypto.getRandomValues(new Uint8Array(16))) : null;
  const hash = salt ? base64url.encode(await passwordHash(password, salt)) : null;
  const expiresAt = timestamp + days * 86400;
  const token = await signedValue(env, `link:${id}`);
  const result = await env.DB.prepare(`INSERT INTO shares (id, digest, file_id, password_salt, password_hash, expires_at, created_at)
    SELECT ?, ?, id, ?, ?, ?, ? FROM entries WHERE id = ? AND kind = 'file' AND deleted_at IS NULL`)
    .bind(id, await digest(token), salt, hash, expiresAt, timestamp, fileId).run();
  if (!result.meta.changes) throw new HttpError(404, '要分享的文件不存在');
  return json({ id, url: await link(env, request, id), expiresAt }, 201);
}

export async function listShares(env: Env, request: Request, url: URL) {
  const offset = numberOf(Number(url.searchParams.get('offset') ?? 0), 0, 100000, '分页参数无效');
  const { results } = await env.DB.prepare(`SELECT s.id, s.digest, s.expires_at, s.revoked_at, s.created_at, e.name, e.deleted_at,
      s.password_hash IS NOT NULL AS protected FROM shares s JOIN entries e ON s.file_id = e.id
      ORDER BY s.created_at DESC, s.id DESC LIMIT 51 OFFSET ?`).bind(offset)
    .all<{ id: string; digest: string; name: string; expires_at: number; revoked_at: number | null; deleted_at: number | null; protected: number }>();
  const items = await Promise.all(results.slice(0, 50).map(async ({ digest: expected, ...share }) => {
    const active = !share.revoked_at && !share.deleted_at && share.expires_at > now();
    const candidate = active ? await link(env, request, share.id) : null;
    const token = candidate?.slice(candidate.lastIndexOf('/') + 1);
    return { ...share, active, url: token && await digest(token) === expected ? candidate : null };
  }));
  return json({ items, next: results.length > 50 ? offset + 50 : null });
}

export async function revokeShare(env: Env, id: string) {
  await env.DB.prepare('UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(now(), id).run();
  return new Response(null, { status: 204 });
}

async function activeShare(env: Env, token: string) {
  const row = await env.DB.prepare(`SELECT s.*, e.name, e.object_key, e.bucket_id, e.version_id, e.bytes
    FROM shares s JOIN entries e ON e.id = s.file_id
    WHERE s.digest = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND e.deleted_at IS NULL`)
    .bind(await digest(token), now()).first<Share & Pick<Entry, 'name' | 'object_key' | 'bucket_id' | 'version_id' | 'bytes'>>();
  if (!row) throw new HttpError(404, '分享链接已失效或不存在');
  return row;
}

async function unlocked(env: Env, share: Share, request: Request) {
  if (!share.password_hash) return true;
  const cookie = (request.headers.get('cookie') ?? '').split(/;\s*/).find(value => value.startsWith('b2_grant='))?.slice(9);
  if (!cookie) return false;
  try {
    await jwtVerify(cookie, secret(env), { algorithms: ['HS256'], issuer: 'cfb2-pan-share', subject: share.id, requiredClaims: ['exp'] });
    return true;
  } catch { return false; }
}

async function rateLimit(env: Env, request: Request, id: string) {
  const window = Math.floor(now() / 300);
  const ip = request.headers.get('cf-connecting-ip') ?? 'loopback';
  const key = await signedValue(env, `rate:${ip}`);
  const update = `INSERT INTO share_attempts (share_id, requester, window, attempts) VALUES (?, ?, ?, 1)
    ON CONFLICT (share_id, requester, window) DO UPDATE SET attempts = attempts + 1 WHERE attempts < ?`;
  const result = await env.DB.prepare(update).bind(id, key, window, 8).run();
  if (!result.meta.changes) throw new HttpError(429, '尝试次数过多，请稍后再试');
}

export async function publicShare(env: Env, request: Request, token: string, action: string) {
  const share = await activeShare(env, token);
  if (action === 'unlock' && request.method === 'POST') {
    if (!share.password_hash || !share.password_salt) return json({ unlocked: true });
    const { password } = await body(request);
    if (typeof password !== 'string' || password.length > 128 || !password) throw new HttpError(400, '请输入分享密码');
    await rateLimit(env, request, share.id);
    const actual = await passwordHash(password, share.password_salt);
    if (!crypto.subtle.timingSafeEqual(actual, base64url.decode(share.password_hash))) throw new HttpError(403, '分享密码错误');
    const maxAge = Math.min(grantLife, share.expires_at - now());
    if (maxAge <= 0) throw new HttpError(404, '分享链接已失效');
    const grant = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuer('cfb2-pan-share')
      .setSubject(share.id).setExpirationTime(now() + maxAge).sign(secret(env));
    const secure = isDemo(env) ? '' : '; Secure';
    return json({ unlocked: true }, 200, { 'Set-Cookie': `b2_grant=${grant}; Path=/s/${token}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}` });
  }
  const allowed = await unlocked(env, share, request);
  if (action === 'info' && request.method === 'GET') {
    return json(allowed ? { locked: false, name: share.name, bytes: share.bytes, expiresAt: share.expires_at } : { locked: true });
  }
  if (action === 'download' && ['GET', 'HEAD'].includes(request.method)) {
    if (!allowed) throw new HttpError(403, '此分享需要访问密码');
    return download(env, request, share);
  }
  throw new HttpError(404, '分享接口不存在');
}
