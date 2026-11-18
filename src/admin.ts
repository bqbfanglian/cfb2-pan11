import { encryptCredentials } from './bucket-secrets';
import { body, Env, HttpError, json, MiB, now, numberOf, Prefix } from './common';
import { Bucket, bucketStore, configuredBuckets } from './storage';

interface BucketSettings {
  id: string;
  name: string | null;
  region: string | null;
  quota: number | null;
  priority: number | null;
  paused: number;
  removed: number;
}

type BucketMetadata = Pick<Bucket, 'id' | 'name' | 'region' | 'quota' | 'priority' | 'writable'>;
type Stats = { files: number; shares: number; uploads: number; cleanup: number };
type BucketUsage = { bucket_id: string; used: number; files: number; uploads: number };
type BucketHealth = { bucket_id: string; retry_at: number };
type PendingUpload = { id: string; name: string; bucket_id: string; bytes: number; expires_at: number };

async function visibleBuckets(env: Env) {
  const { results } = await env.DB.prepare('SELECT bucket_id AS id, name, region, quota, priority, paused, removed FROM bucket_settings')
    .all<BucketSettings>();
  const statuses = new Map(results.map(row => [row.id, row]));
  const list = new Map<string, BucketMetadata>();
  for (const { id, name, region, quota, priority, writable } of configuredBuckets(env)) list.set(id, { id, name, region, quota, priority, writable });
  for (const { id, name, region, quota, priority, removed } of results) {
    if (removed) list.delete(id);
    else if (name !== null && region !== null && quota !== null && priority !== null) list.set(id, { id, name, region, quota, priority, writable: true });
  }
  return [...list.values()].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
    .map(bucket => ({ ...bucket, paused: statuses.get(bucket.id)?.paused === 1 }));
}

export async function overview(env: Env) {
  const timestamp = now();
  const [buckets, results] = await Promise.all([
    visibleBuckets(env),
    env.DB.batch([
      env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM entries WHERE kind = 'file' AND deleted_at IS NULL) AS files,
        (SELECT COUNT(*) FROM shares s JOIN entries e ON e.id = s.file_id
          WHERE s.revoked_at IS NULL AND s.expires_at > ? AND e.deleted_at IS NULL) AS shares,
        (SELECT COUNT(*) FROM uploads WHERE state = 'open' AND expires_at > ?) AS uploads,
        (SELECT COUNT(*) FROM entries WHERE kind = 'file' AND deleted_at IS NOT NULL)
          + (SELECT COUNT(*) FROM uploads WHERE state = 'cancelled' OR (state = 'open' AND expires_at <= ?)) AS cleanup`)
        .bind(timestamp, timestamp, timestamp),
      env.DB.prepare(`SELECT bucket_id, SUM(bytes) AS used, SUM(files) AS files, SUM(uploads) AS uploads FROM (
        SELECT bucket_id, bytes, 1 AS files, 0 AS uploads FROM entries WHERE kind = 'file'
        UNION ALL SELECT bucket_id, bytes, 0 AS files, 1 AS uploads FROM uploads WHERE state IN ('open', 'cancelled')
      ) GROUP BY bucket_id`),
      env.DB.prepare('SELECT bucket_id, retry_at FROM bucket_health WHERE retry_at > ?').bind(timestamp),
      env.DB.prepare(`SELECT id, name, bucket_id, bytes, expires_at FROM uploads WHERE state = 'open' AND expires_at > ?
        ORDER BY expires_at DESC, id LIMIT 25`).bind(timestamp),
    ]),
  ]);
  const [stats, usage, health, uploads] = results as [D1Result<Stats>, D1Result<BucketUsage>, D1Result<BucketHealth>, D1Result<PendingUpload>];
  const occupied = new Map(usage.results.map(row => [row.bucket_id, row]));
  const retry = new Map(health.results.map(row => [row.bucket_id, row.retry_at]));
  return json({
    ...stats.results[0],
    quota: buckets.reduce((sum, bucket) => sum + bucket.quota, 0),
    used: usage.results.reduce((sum, row) => sum + Number(row.used), 0),
    buckets: buckets.map(bucket => {
      const taken = occupied.get(bucket.id);
      return { ...bucket, used: taken?.used ?? 0, files: taken?.files ?? 0, uploads: taken?.uploads ?? 0, retryAt: retry.get(bucket.id) ?? null };
    }),
    pending: uploads.results,
  });
}

export async function addBucket(env: Env, request: Request) {
  const input = await body(request);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const region = typeof input.region === 'string' ? input.region.trim().toLowerCase() : '';
  const keyId = typeof input.keyId === 'string' ? input.keyId.trim() : '';
  const applicationKey = typeof input.applicationKey === 'string' ? input.applicationKey.trim() : '';
  if (!/^[a-zA-Z0-9-]{6,50}$/.test(name) || !/^[a-z0-9-]{2,24}-\d{1,4}$/.test(region)) {
    throw new HttpError(400, '请填写 B2 桶名和 S3 区域，例如 us-west-004');
  }
  if (!/^\S{1,256}$/.test(keyId) || !/^\S{1,256}$/.test(applicationKey)) throw new HttpError(400, '请填写 B2 Key ID 和 Application Key');
  const quota = numberOf(input.quotaGiB, 1, 1048576, '配额须填写正整数 GiB') * 1024 * MiB;
  const priority = numberOf(input.priority ?? 1, 0, 999, '优先级须为 0 至 999 的整数');
  if ((await visibleBuckets(env)).some(bucket => bucket.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(409, '该存储桶已经接入');
  }

  const id = crypto.randomUUID();
  const credentials = await encryptCredentials(env, id, { keyId, applicationKey });
  const backend = bucketStore(env, { id, name, region, quota, priority, writable: true, keyId, applicationKey });
  try {
    await backend.probe();
    const testKey = `${Prefix}connection-check-${id}`;
    const testUpload = await backend.start(testKey);
    await backend.abort(testKey, testUpload);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 502) throw error;
    throw new HttpError(502, '存储桶验证失败，请检查桶名、区域和密钥的读写权限');
  }
  const saved = await env.DB.prepare(`INSERT INTO bucket_settings (bucket_id, name, region, quota, priority, credentials)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING RETURNING bucket_id`)
    .bind(id, name, region, quota, priority, credentials).first();
  if (!saved) throw new HttpError(409, '该存储桶已经接入');
  return json({ id }, 201);
}

export async function setBucketState(env: Env, request: Request, id: string) {
  const { paused } = await body(request);
  if (typeof paused !== 'boolean') throw new HttpError(400, '请选择暂停或恢复');
  const bucket = (await visibleBuckets(env)).find(bucket => bucket.id === id);
  if (!bucket) throw new HttpError(404, '找不到存储桶');
  if (!bucket.writable) throw new HttpError(409, '此桶在 Worker 中配置为只读');
  const saved = await env.DB.prepare(`INSERT INTO bucket_settings (bucket_id, paused) VALUES (?, ?)
    ON CONFLICT (bucket_id) DO UPDATE SET paused = excluded.paused WHERE removed = 0 RETURNING bucket_id`)
    .bind(id, Number(paused)).first();
  if (!saved) throw new HttpError(404, '找不到存储桶');
  return json({ id, paused });
}

export async function removeBucket(env: Env, id: string) {
  if (!(await visibleBuckets(env)).some(bucket => bucket.id === id)) throw new HttpError(404, '找不到存储桶');
  const saved = await env.DB.prepare(`INSERT INTO bucket_settings (bucket_id, removed)
    SELECT ?, 1 WHERE NOT EXISTS (SELECT 1 FROM entries WHERE bucket_id = ?)
      AND NOT EXISTS (SELECT 1 FROM uploads WHERE bucket_id = ? AND state IN ('open', 'cancelled'))
    ON CONFLICT (bucket_id) DO UPDATE SET removed = 1, paused = 0, name = NULL, region = NULL, quota = NULL,
      priority = NULL, credentials = NULL RETURNING bucket_id`).bind(id, id, id).first();
  if (!saved) throw new HttpError(409, '此桶仍有文件或待清理的上传，请先处理这些资源');
  return new Response(null, { status: 204 });
}
