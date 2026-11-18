import { body, Entry, Env, exactBody, folder, HttpError, idOf, json, MaxBytes, nameOf, now, numberOf, PartBytes, Prefix, uniqueName, UploadLifetime } from './common';
import { ObjectInfo, Part, store } from './storage';
import { availableBucket, candidateArguments, chooseBucket, suspendBucket } from './scheduler';

interface Upload {
  id: string;
  parent_id: string;
  name: string;
  bucket_id: string;
  object_key: string;
  bytes: number;
  multipart: number;
  multipart_id: string | null;
  state: 'open' | 'done' | 'cancelled' | 'cleaned';
  expires_at: number;
  lock_token: string | null;
  write_started: number;
}

export async function beginUpload(env: Env, request: Request) {
  const input = await body(request);
  const name = nameOf(input.name);
  const parentId = idOf(input.parentId ?? 'root');
  const bytes = numberOf(input.bytes, 0, MaxBytes, '单文件上限为 1 GiB');
  if (!await folder(env.DB, parentId)) throw new HttpError(404, '目标文件夹不存在');
  if (await env.DB.prepare('SELECT id FROM entries WHERE parent_id = ? AND name = ? AND deleted_at IS NULL').bind(parentId, name).first()) {
    throw new HttpError(409, '这个目录里已有同名项目');
  }
  const id = crypto.randomUUID();
  const multipart = bytes > PartBytes;
  const expiresAt = now() + UploadLifetime;
  const reserved = await env.DB.prepare(`${chooseBucket} INSERT INTO uploads
    (id, parent_id, name, bucket_id, object_key, bytes, multipart, state, expires_at, write_started)
    SELECT ?, ?, ?, target.id, ?, ?, ?, 'open', ?, 0 FROM target
    WHERE EXISTS (SELECT 1 FROM entries WHERE id = ? AND kind = 'folder' AND deleted_at IS NULL)
    RETURNING id`)
    .bind(...candidateArguments(env, bytes), id, parentId, name, Prefix + id, bytes, Number(multipart), expiresAt, parentId).first();
  if (!reserved) throw new HttpError(409, '当前没有满足容量要求的可用存储，或目标文件夹已移除');
  return json({ id, multipart, partBytes: PartBytes, expiresAt }, 201);
}

function findUpload(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM uploads WHERE id = ?').bind(id).first<Upload>();
}

function requireOpen(upload: Upload | null): Upload {
  if (!upload) throw new HttpError(404, '上传会话不存在');
  if (upload.state !== 'open' || upload.expires_at <= now()) throw new HttpError(410, '上传会话已结束或过期');
  return upload;
}

async function withUpload<T>(db: D1Database, id: string, run: (upload: Upload) => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const time = now();
  const upload = await db.prepare(`UPDATE uploads SET lock_token = ?, lease_until = ?
    WHERE id = ? AND state = 'open' AND expires_at > ? AND lease_until <= ? RETURNING *`)
    .bind(token, time + 300, id, time, time).first<Upload>();
  if (!upload) {
    requireOpen(await findUpload(db, id));
    throw new HttpError(409, '上传会话正在处理，请稍后重试');
  }
  try {
    return await run(upload);
  } finally {
    await db.prepare('UPDATE uploads SET lock_token = NULL, lease_until = 0 WHERE id = ? AND lock_token = ?').bind(id, token).run();
  }
}

function partSize(upload: Upload, number: number) {
  const total = Math.ceil(upload.bytes / PartBytes);
  numberOf(number, 1, total, '无效的分片号');
  return number === total ? upload.bytes - PartBytes * (total - 1) : PartBytes;
}

function validParts(upload: Upload, parts: Part[]) {
  return parts.filter(part => Number.isInteger(part.number) && part.number >= 1 && part.number <= Math.ceil(upload.bytes / PartBytes)
    && part.bytes === partSize(upload, part.number)).sort((a, b) => a.number - b.number);
}

async function prepareTarget(env: Env, initial: Upload): Promise<{ upload: Upload; backend: Awaited<ReturnType<typeof store>> }> {
  if (initial.write_started || initial.multipart_id) return { upload: initial, backend: await store(env, initial.bucket_id) };
  const lock = initial.lock_token;
  const tried = new Set<string>();
  for (let upload: Upload | null = initial; upload;) {
    const { bucket_id: bucketId, object_key: key } = upload;
    tried.add(bucketId);
    if (await availableBucket(env, bucketId)) {
      let multipartId: string | null = null;
      let backend: Awaited<ReturnType<typeof store>> | null = null;
      try {
        const target = await store(env, bucketId);
        if (upload.multipart) multipartId = await target.start(key);
        else await target.probe();
        backend = target;
      } catch (error) {
        if (!(error instanceof HttpError) || ![502, 503].includes(error.status)) throw error;
        await suspendBucket(env.DB, bucketId);
      }
      if (backend) {
        const saved = await env.DB.prepare(`UPDATE uploads SET write_started = 1, multipart_id = ? WHERE id = ? AND lock_token = ?
          AND NOT EXISTS (SELECT 1 FROM bucket_settings WHERE bucket_id = uploads.bucket_id AND (paused = 1 OR removed = 1)) RETURNING *`)
          .bind(multipartId, upload.id, lock).first<Upload>();
        if (saved) return { upload: saved, backend };
        if (multipartId) await backend.abort(key, multipartId).catch(() => undefined);
      }
    }
    upload = await env.DB.prepare(`${chooseBucket} UPDATE uploads SET bucket_id = (SELECT id FROM target)
      WHERE id = ? AND lock_token = ? AND write_started = 0 AND EXISTS (SELECT 1 FROM target)
      RETURNING *`).bind(...candidateArguments(env, upload.bytes, tried), upload.id, lock).first<Upload>();
  }
  throw new HttpError(503, '存储暂时不可用，请稍后重新选择原文件继续上传');
}

async function finalize(env: Env, upload: Upload, object: ObjectInfo | null) {
  if (!object || object.bytes !== upload.bytes) throw new HttpError(409, '存储对象尚未完成，或大小不匹配');
  const timestamp = now();
  const [insert] = await uniqueName(() => env.DB.batch([
    env.DB.prepare(`INSERT INTO entries (id, parent_id, name, kind, bucket_id, object_key, version_id, bytes, created_at, updated_at)
      SELECT u.id, u.parent_id, u.name, 'file', u.bucket_id, u.object_key, ?, u.bytes, ?, ?
      FROM uploads u JOIN entries p ON p.id = u.parent_id AND p.kind = 'folder' AND p.deleted_at IS NULL
      WHERE u.id = ? AND u.state = 'open' AND u.lock_token = ?`)
      .bind(object.version, timestamp, timestamp, upload.id, upload.lock_token),
    env.DB.prepare(`UPDATE uploads SET state = 'done'
      WHERE id = ? AND lock_token = ? AND EXISTS (SELECT 1 FROM entries WHERE id = ?)`)
      .bind(upload.id, upload.lock_token, upload.id),
  ]));
  if (!insert.meta.changes) throw new HttpError(409, '上传会话状态已变化，请重试');
  return json({ id: upload.id, done: true });
}

export async function uploadRoute(env: Env, request: Request, id: string, action?: string, number?: string) {
  const method = request.method;
  if (method === 'GET' && !action) {
    const current = await findUpload(env.DB, id);
    if (current?.state === 'done') return json({ id, done: true });
    const upload = requireOpen(current);
    const backend = upload.write_started ? await store(env, upload.bucket_id) : null;
    const completed = backend && await backend.head(upload.object_key);
    const parts = backend && !completed && upload.multipart_id ? validParts(upload, await backend.parts(upload.object_key, upload.multipart_id)) : [];
    return json({ id, multipart: !!upload.multipart, expiresAt: upload.expires_at, partBytes: PartBytes,
      completed: !!completed, parts: parts.map(part => part.number) });
  }
  if (method === 'DELETE' && !action) {
    const result = await env.DB.prepare("UPDATE uploads SET state = 'cancelled' WHERE id = ? AND state = 'open' AND lease_until <= ?")
      .bind(id, now()).run();
    if (!result.meta.changes) {
      const current = await findUpload(env.DB, id);
      if (!current || current.state === 'done') throw new HttpError(404, '可取消的上传不存在');
      if (current.state === 'open') throw new HttpError(409, '上传正在处理，请稍后取消');
    }
    return new Response(null, { status: 204 });
  }
  if (method === 'PUT' && action === 'part') {
    return withUpload(env.DB, id, async initial => {
      if (!initial.multipart) throw new HttpError(400, '此文件使用普通上传');
      const sequence = Number(number);
      const bytes = partSize(initial, sequence);
      const { upload, backend } = await prepareTarget(env, initial);
      if (!upload.multipart_id) throw new HttpError(409, '分片会话不可用，请重新上传');
      await backend.putPart(upload.object_key, upload.multipart_id, sequence, bytes, exactBody(request, bytes));
      return new Response(null, { status: 204 });
    });
  }
  if ((method === 'PUT' && action === 'object') || (method === 'POST' && action === 'complete')) {
    if ((await findUpload(env.DB, id))?.state === 'done') return json({ id, done: true });
    return withUpload(env.DB, id, async initial => {
      if (action === 'object' && initial.multipart) throw new HttpError(400, '此文件需要分片上传');
      if (action === 'complete' && !initial.write_started) throw new HttpError(409, '请先上传文件内容');
      const { upload, backend } = await prepareTarget(env, initial);
      const existing = initial.write_started ? await backend.head(upload.object_key) : null;
      if (existing) return finalize(env, upload, existing);
      if (action === 'object') {
        await backend.put(upload.object_key, exactBody(request, upload.bytes));
      } else {
        if (!upload.multipart_id) throw new HttpError(409, '请先上传文件内容');
        const parts = validParts(upload, await backend.parts(upload.object_key, upload.multipart_id));
        if (parts.length !== Math.ceil(upload.bytes / PartBytes) || parts.some((part, index) => part.number !== index + 1)) {
          throw new HttpError(409, '还有分片未上传完成');
        }
        await backend.complete(upload.object_key, upload.multipart_id, parts);
      }
      return finalize(env, upload, await backend.head(upload.object_key));
    });
  }
  throw new HttpError(404, '上传接口不存在');
}

export async function cleanup(env: Env) {
  const timestamp = now();
  const db = env.DB;
  await db.prepare(`UPDATE uploads SET state = 'cancelled'
    WHERE id IN (SELECT id FROM uploads WHERE state = 'open' AND expires_at <= ? AND lease_until <= ? LIMIT 20)`)
    .bind(timestamp, timestamp).run();
  const uploads = await db.prepare("SELECT * FROM uploads WHERE state = 'cancelled' AND lease_until <= ? ORDER BY expires_at LIMIT 4")
    .bind(timestamp).all<Upload>();
  const entries = await db.prepare("SELECT * FROM entries WHERE deleted_at IS NOT NULL AND kind = 'file' AND cleanup_after <= ? ORDER BY deleted_at LIMIT 4")
    .bind(timestamp).all<Entry>();
  for (const upload of uploads.results) {
    try {
      if (upload.write_started) {
        const backend = await store(env, upload.bucket_id);
        if (upload.multipart_id) await backend.abort(upload.object_key, upload.multipart_id);
        const object = await backend.head(upload.object_key);
        if (object) await backend.remove(upload.object_key, object.version);
      }
      await db.prepare("UPDATE uploads SET state = 'cleaned' WHERE id = ? AND state = 'cancelled'").bind(upload.id).run();
    } catch {
      await db.prepare("UPDATE uploads SET lease_until = ? WHERE id = ? AND state = 'cancelled'").bind(timestamp + 3600, upload.id).run();
      console.warn('upload cleanup failed', upload.id, upload.bucket_id);
    }
  }
  for (const entry of entries.results) {
    try {
      await (await store(env, entry.bucket_id!)).remove(entry.object_key!, entry.version_id!);
      await db.prepare('DELETE FROM entries WHERE id = ? AND deleted_at IS NOT NULL').bind(entry.id).run();
    } catch {
      await db.prepare('UPDATE entries SET cleanup_after = ? WHERE id = ?').bind(timestamp + 3600, entry.id).run();
      console.warn('file cleanup failed', entry.id, entry.bucket_id);
    }
  }
  await db.batch([
    db.prepare(`DELETE FROM entries WHERE id IN (SELECT f.id FROM entries f
      WHERE f.kind = 'folder' AND f.deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entries c WHERE c.parent_id = f.id) LIMIT 20)`),
    db.prepare("DELETE FROM uploads WHERE expires_at < ? AND state IN ('done', 'cleaned')").bind(timestamp - 7 * UploadLifetime),
    db.prepare('DELETE FROM share_attempts WHERE window < ?').bind(Math.floor(timestamp / 300) - 2),
  ]);
}
