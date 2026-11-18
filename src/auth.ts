import { base64url } from 'jose';
import { body, Env, HttpError, isDemo, json, now } from './common';

const demoPassword = 'cfb2-demo-password';
const sessionLifetime = 12 * 60 * 60;
const attemptWindow = 300;
const encoder = new TextEncoder();

function configuredPassword(env: Env) {
  const password = isDemo(env) ? demoPassword : env.ADMIN_PASSWORD;
  if (!password || password.length < 16 || password.length > 128) {
    throw new HttpError(503, '请在 Worker 设置中配置 16 至 128 个字符的 ADMIN_PASSWORD');
  }
  return password;
}

function hash(value: string) {
  return crypto.subtle.digest('SHA-256', encoder.encode(value));
}

async function digest(value: string) {
  return base64url.encode(new Uint8Array(await hash(value)));
}

function cookieName(env: Env) {
  return isDemo(env) ? 'cfb2_admin' : '__Host-cfb2_admin';
}

function cookie(env: Env, value: string, lifetime: number) {
  const secure = isDemo(env) ? '' : '; Secure';
  return `${cookieName(env)}=${value}; Path=/; Max-Age=${lifetime}; HttpOnly; SameSite=Strict${secure}`;
}

function sessionToken(env: Env, request: Request) {
  const prefix = `${cookieName(env)}=`;
  const value = request.headers.get('Cookie')?.split(/;\s*/).find(item => item.startsWith(prefix))?.slice(prefix.length);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function sessionDigest(token: string, password: string) {
  return digest(`session:${token}:${password}`);
}

export async function isAdmin(env: Env, request: Request) {
  const token = sessionToken(env, request);
  if (!token) return false;
  const key = await sessionDigest(token, configuredPassword(env));
  const session = await env.DB.prepare('SELECT 1 FROM admin_sessions WHERE digest = ? AND expires_at > ?')
    .bind(key, now()).first();
  return !!session;
}

export async function login(env: Env, request: Request) {
  const expected = configuredPassword(env);
  const { password } = await body(request);
  if (typeof password !== 'string' || !password || password.length > 128) throw new HttpError(400, '请输入管理员密码');

  const ip = request.headers.get('CF-Connecting-IP') ?? 'loopback';
  const requester = await digest(`login:${ip}:${expected}`);
  const window = Math.floor(now() / attemptWindow);
  const result = await env.DB.prepare(`INSERT INTO admin_login_attempts (requester, window, attempts) VALUES (?, ?, 1)
    ON CONFLICT (requester, window) DO UPDATE SET attempts = attempts + 1 WHERE attempts < 8`)
    .bind(requester, window).run();
  if (!result.meta.changes) throw new HttpError(429, '尝试次数过多，请稍后再试');

  const [actualHash, expectedHash] = await Promise.all([hash(password), hash(expected)]);
  if (!crypto.subtle.timingSafeEqual(actualHash, expectedHash)) throw new HttpError(401, '管理员密码错误');

  const token = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const statements = [env.DB.prepare('INSERT INTO admin_sessions (digest, expires_at) VALUES (?, ?)')
    .bind(await sessionDigest(token, expected), now() + sessionLifetime)];
  const previous = sessionToken(env, request);
  if (previous) statements.push(env.DB.prepare('DELETE FROM admin_sessions WHERE digest = ?').bind(await sessionDigest(previous, expected)));
  statements.push(env.DB.prepare('DELETE FROM admin_login_attempts WHERE requester = ? AND window = ?').bind(requester, window));
  await env.DB.batch(statements);
  return json({ authenticated: true }, 200, { 'Set-Cookie': cookie(env, token, sessionLifetime) });
}

export async function logout(env: Env, request: Request) {
  const token = sessionToken(env, request);
  if (token) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE digest = ?').bind(await sessionDigest(token, configuredPassword(env))).run();
  }
  return new Response(null, { status: 204, headers: { 'Set-Cookie': cookie(env, '', 0) } });
}

export function cleanAdminAuth(db: D1Database, timestamp: number) {
  return db.batch([
    db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(timestamp),
    db.prepare('DELETE FROM admin_login_attempts WHERE window < ?').bind(Math.floor(timestamp / attemptWindow) - 1),
  ]);
}
