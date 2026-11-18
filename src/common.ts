export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_MODE?: string;
  DEMO_STORE?: R2Bucket;
  ADMIN_HOST?: string;
  SHARE_HOST?: string;
  ADMIN_PASSWORD?: string;
  B2_BUCKETS?: string;
  SHARE_SECRET?: string;
}

export interface Entry {
  id: string;
  parent_id: string | null;
  name: string;
  kind: 'folder' | 'file';
  bucket_id: string | null;
  object_key: string | null;
  version_id: string | null;
  bytes: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const now = () => Math.floor(Date.now() / 1000);
export const MiB = 1024 * 1024;
export const MaxBytes = 1024 * MiB;
export const PartBytes = 16 * MiB;
export const Prefix = 'cfb2-pan/';
export const UploadLifetime = 24 * 60 * 60;

export function json(value: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(value, { status, headers });
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, '请提交 JSON 数据');
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(await new Response(limitStream(request.body, 8192)).arrayBuffer()));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'JSON 格式无效或内容过长');
  }
}

function limitStream(stream: ReadableStream | null, max: number) {
  if (!stream) throw new HttpError(400, '缺少请求内容');
  let received = 0;
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > max) throw new HttpError(413, '请求内容过大');
      controller.enqueue(chunk);
    },
  }));
}

export function exactBody(request: Request, bytes: number): ReadableStream | Uint8Array {
  if (request.headers.get('content-length') !== String(bytes)) {
    throw new HttpError(400, '请求体大小与上传记录不符');
  }
  if (!bytes) return new Uint8Array();
  const stream = new FixedLengthStream(bytes);
  void limitStream(request.body, bytes).pipeTo(stream.writable).catch(() => undefined);
  return stream.readable;
}

export function nameOf(value: unknown) {
  const name = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  if (!name || name === '.' || name === '..' || /[/\\\p{Cc}\p{Cs}]/u.test(name) || new TextEncoder().encode(name).length > 255) {
    throw new HttpError(400, '请输入有效的文件名或文件夹名');
  }
  return name;
}

export function idOf(value: unknown) {
  if (typeof value === 'string' && (value === 'root' || /^[a-f0-9-]{36}$/.test(value))) return value;
  throw new HttpError(400, '文件或目录 ID 无效');
}

export function numberOf(value: unknown, min: number, max: number, message: string) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max) return value;
  throw new HttpError(400, message);
}

export function isDemo(env: Env) {
  return env.APP_MODE === 'demo' && !!env.DEMO_STORE;
}

export function folder(db: D1Database, id: string) {
  return db.prepare("SELECT id, name, parent_id FROM entries WHERE id = ? AND kind = 'folder' AND deleted_at IS NULL")
    .bind(id).first<Pick<Entry, 'id' | 'name' | 'parent_id'>>();
}

export function file(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM entries WHERE id = ? AND kind = 'file' AND deleted_at IS NULL").bind(id).first<Entry>();
}

export async function uniqueName<T>(write: () => Promise<T>) {
  try {
    return await write();
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed: entries.parent_id, entries.name')) {
      throw new HttpError(409, '这个目录里已有同名项目');
    }
    throw error;
  }
}
