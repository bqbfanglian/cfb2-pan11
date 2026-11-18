import { Env, now } from './common';
import { configuredBuckets } from './storage';

export const chooseBucket = `WITH candidates AS (
  SELECT value ->> 'id' AS id, value ->> 'quota' AS quota, value ->> 'priority' AS priority
  FROM json_each(?)
  UNION ALL SELECT bucket_id, quota, priority FROM bucket_settings WHERE credentials IS NOT NULL
), projected AS (
  SELECT c.*, inputs.bytes
    + COALESCE((SELECT SUM(bytes) FROM entries WHERE bucket_id = c.id), 0)
    + COALESCE((SELECT SUM(bytes) FROM uploads WHERE bucket_id = c.id AND state IN ('open', 'cancelled')), 0) AS projected_bytes
  FROM candidates c CROSS JOIN (SELECT ? AS bytes) inputs
  LEFT JOIN bucket_health h ON h.bucket_id = c.id
  LEFT JOIN bucket_settings s ON s.bucket_id = c.id
  WHERE COALESCE(h.retry_at, 0) <= ? AND COALESCE(s.paused, 0) = 0 AND COALESCE(s.removed, 0) = 0
    AND c.id NOT IN (SELECT value FROM json_each(?))
), target AS (
  SELECT id FROM projected WHERE projected_bytes <= quota
  ORDER BY CAST(projected_bytes AS REAL) / quota, priority, id LIMIT 1
)`;

export function candidateArguments(env: Env, bytes: number, exclude?: ReadonlySet<string>) {
  const candidates = configuredBuckets(env).filter(bucket => bucket.writable)
    .map(({ id, quota, priority }) => ({ id, quota, priority }));
  return [JSON.stringify(candidates), bytes, now(), JSON.stringify(exclude ? [...exclude] : [])];
}

export async function summary(env: Env) {
  const buckets = JSON.stringify(configuredBuckets(env).map(({ id, quota }) => ({ id, quota })));
  const result = await env.DB.prepare(`SELECT
    COALESCE((SELECT SUM(quota) FROM bucket_settings WHERE credentials IS NOT NULL AND removed = 0), 0)
    + COALESCE((SELECT SUM(b.value ->> 'quota') FROM json_each(?) b
      LEFT JOIN bucket_settings s ON s.bucket_id = (b.value ->> 'id') WHERE COALESCE(s.removed, 0) = 0), 0) AS quota,
    COALESCE((SELECT SUM(bytes) FROM (
    SELECT bytes FROM entries WHERE kind = 'file'
    UNION ALL SELECT bytes FROM uploads WHERE state IN ('open', 'cancelled')
  )), 0) AS used`).bind(buckets).first<{ quota: number; used: number }>();
  return result ?? { quota: 0, used: 0 };
}

export async function availableBucket(env: Env, id: string) {
  const configured = configuredBuckets(env).find(bucket => bucket.id === id);
  return !!await env.DB.prepare(`SELECT 1 FROM (SELECT ? AS id) c
    LEFT JOIN bucket_settings s ON s.bucket_id = c.id LEFT JOIN bucket_health h ON h.bucket_id = c.id
    WHERE COALESCE(s.paused, 0) = 0 AND COALESCE(s.removed, 0) = 0 AND COALESCE(h.retry_at, 0) <= ?
    AND (? = 1 OR s.credentials IS NOT NULL)`).bind(id, now(), Number(configured?.writable === true)).first();
}

export function suspendBucket(db: D1Database, id: string) {
  return db.prepare(`INSERT INTO bucket_health (bucket_id, retry_at) VALUES (?, ?)
    ON CONFLICT (bucket_id) DO UPDATE SET retry_at = MAX(retry_at, excluded.retry_at)`)
    .bind(id, now() + 120).run();
}
