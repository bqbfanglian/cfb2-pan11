import { AwsClient } from 'aws4fetch';
import { XMLParser } from 'fast-xml-parser';
import { Env, HttpError, isDemo, MiB, Prefix } from './common';
import { decryptCredentials } from './bucket-secrets';

export interface Bucket {
  id: string;
  quota: number;
  priority: number;
  writable: boolean;
  name: string;
  region: string;
  keyId: string;
  applicationKey: string;
}

export interface Part { number: number; etag: string; bytes: number }
export interface ObjectInfo { bytes: number; version: string }
type Data = ReadableStream | Uint8Array;

interface Store {
  probe(): Promise<void>;
  head(key: string): Promise<ObjectInfo | null>;
  put(key: string, data: Data): Promise<void>;
  get(key: string, version: string, range?: { start: number; end: number }): Promise<Response>;
  remove(key: string, version: string): Promise<void>;
  start(key: string): Promise<string>;
  parts(key: string, uploadId: string): Promise<Part[]>;
  putPart(key: string, uploadId: string, part: number, bytes: number, data: Data): Promise<void>;
  complete(key: string, uploadId: string, parts: Part[]): Promise<void>;
  abort(key: string, uploadId: string): Promise<void>;
}

const xml = new XMLParser({ parseTagValue: false, processEntities: false });
const asArray = <T,>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];

export function configuredBuckets(env: Env): Bucket[] {
  if (isDemo(env)) {
    return [
      { id: 'demo-a', quota: 1024 * MiB, priority: 1 },
      { id: 'demo-b', quota: 1024 * MiB, priority: 2 },
    ].map(bucket => ({ ...bucket, writable: true, name: bucket.id, region: '', keyId: '', applicationKey: '' }));
  }
  let list: Bucket[];
  try { list = JSON.parse(env.B2_BUCKETS || '[]'); }
  catch { throw new HttpError(503, 'B2 存储配置格式无效'); }
  if (!Array.isArray(list) || list.some(bucket => !bucket ||
    typeof bucket.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(bucket.id) ||
    typeof bucket.name !== 'string' || !/^[a-zA-Z0-9-]{6,50}$/.test(bucket.name) ||
    typeof bucket.region !== 'string' || !/^[a-z0-9-]+-\d+$/.test(bucket.region) ||
    typeof bucket.keyId !== 'string' || !bucket.keyId || typeof bucket.applicationKey !== 'string' || !bucket.applicationKey ||
    typeof bucket.writable !== 'boolean' || !Number.isSafeInteger(bucket.priority) ||
    !Number.isSafeInteger(bucket.quota) || bucket.quota <= 0) || new Set(list.map(bucket => bucket.id)).size !== list.length) {
    throw new HttpError(503, '请配置有效的 B2 存储桶');
  }
  return list.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

class B2Store implements Store {
  private client: AwsClient;

  constructor(private bucket: Bucket) {
    this.client = new AwsClient({ accessKeyId: bucket.keyId, secretAccessKey: bucket.applicationKey, service: 's3', region: bucket.region });
  }

  private url(key: string, query: Record<string, string>) {
    const url = new URL(`https://s3.${this.bucket.region}.backblazeb2.com/${this.bucket.name}/${key}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  private async send(method: string, key: string, query: Record<string, string> = {}, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await fetch(await this.client.sign(this.url(key, query), { ...init, method, redirect: 'manual' }));
    } catch {
      throw new HttpError(502, '暂时无法连接存储桶，请重试');
    }
    if (response.ok || response.status === 404 || response.status === 416) return response;
    await response.body?.cancel();
    throw new HttpError(502, `存储桶请求失败（B2 ${response.status}）`);
  }

  async head(key: string) {
    const response = await this.send('HEAD', key);
    if (response.status === 404) return null;
    const version = response.headers.get('x-amz-version-id');
    const size = response.headers.get('content-length');
    if (!response.ok || !version || size === null || !/^\d+$/.test(size)) throw new HttpError(502, '无法确认 B2 对象版本或大小');
    return { bytes: Number(size), version };
  }

  async probe() {
    const response = await this.send('GET', '', { 'list-type': '2', prefix: Prefix, 'max-keys': '1' }, { signal: AbortSignal.timeout(8000) });
    await response.body?.cancel();
    if (!response.ok) throw new HttpError(502, 'B2 存储桶暂时不可写');
  }

  async put(key: string, data: Data) {
    const result = await this.send('PUT', key, {}, {
      body: data,
      headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'application/octet-stream' },
    });
    await result.body?.cancel();
    if (!result.ok) throw new HttpError(502, 'B2 未接受上传');
  }

  get(key: string, version: string, range?: { start: number; end: number }) {
    return this.send('GET', key, { versionId: version }, { headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {} });
  }

  async remove(key: string, version: string) {
    const result = await this.send('DELETE', key, { versionId: version });
    await result.body?.cancel();
    if (!result.ok && result.status !== 404) throw new HttpError(502, 'B2 删除失败');
  }

  async start(key: string) {
    const response = await this.send('POST', key, { uploads: '' }, {
      headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(502, 'B2 无法创建分片上传');
    }
    const id = xml.parse(await response.text()).InitiateMultipartUploadResult?.UploadId;
    if (!response.ok || typeof id !== 'string' || !id) throw new HttpError(502, 'B2 无法创建分片上传');
    return id;
  }

  async parts(key: string, uploadId: string) {
    const response = await this.send('GET', key, { uploadId, 'max-parts': '1000' });
    const list = xml.parse(await response.text()).ListPartsResult;
    if (!response.ok || !list || list.IsTruncated === 'true') throw new HttpError(502, '无法取得 B2 分片列表');
    return asArray<{ PartNumber: string; ETag: string; Size: string }>(list.Part).map(part => ({
      number: Number(part.PartNumber), etag: String(part.ETag).replace(/&quot;/g, '"'), bytes: Number(part.Size),
    }));
  }

  async putPart(key: string, uploadId: string, part: number, _bytes: number, data: Data) {
    const response = await this.send('PUT', key, { uploadId, partNumber: String(part) }, {
      body: data,
      headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'application/octet-stream' },
    });
    await response.body?.cancel();
    if (!response.ok) throw new HttpError(502, 'B2 未接受分片');
  }

  async complete(key: string, uploadId: string, parts: Part[]) {
    const list = parts.map(part => {
      if (!/^"?[a-zA-Z0-9+/_=-]+"?$/.test(part.etag)) throw new HttpError(502, 'B2 分片 ETag 格式无效');
      return `<Part><PartNumber>${part.number}</PartNumber><ETag>${part.etag}</ETag></Part>`;
    }).join('');
    const response = await this.send('POST', key, { uploadId }, {
      headers: { 'content-type': 'application/xml' }, body: `<CompleteMultipartUpload>${list}</CompleteMultipartUpload>`,
    });
    if (!xml.parse(await response.text()).CompleteMultipartUploadResult || !response.ok) {
      throw new HttpError(502, 'B2 未完成分片合并，请重试');
    }
  }

  async abort(key: string, uploadId: string) {
    const response = await this.send('DELETE', key, { uploadId });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) throw new HttpError(502, 'B2 无法取消分片上传');
  }
}

class DemoStore implements Store {
  constructor(private db: D1Database, private r2: R2Bucket, private id: string) {}

  private key(key: string) { return `${this.id}/${key}`; }

  async probe() { await this.r2.head(this.key(Prefix)); }

  async head(key: string) {
    const object = await this.r2.head(this.key(key));
    return object ? { bytes: object.size, version: object.version } : null;
  }

  async put(key: string, data: Data) { await this.r2.put(this.key(key), data); }

  async get(key: string, version: string, range?: { start: number; end: number }) {
    const object = await this.r2.get(this.key(key), range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
    if (!object || object.version !== version) {
      await object?.body.cancel();
      return new Response(null, { status: 404 });
    }
    return new Response(object.body, { status: range ? 206 : 200 });
  }

  async remove(key: string, version: string) {
    if ((await this.head(key))?.version === version) await this.r2.delete(this.key(key));
  }

  async start(key: string) {
    return (await this.r2.createMultipartUpload(this.key(key))).uploadId;
  }

  async parts(_key: string, uploadId: string) {
    const { results } = await this.db.prepare('SELECT part_number AS number, etag, bytes FROM demo_parts WHERE upload_id = ?').bind(uploadId).all<Part>();
    return results;
  }

  async putPart(key: string, uploadId: string, part: number, bytes: number, data: Data) {
    const { etag } = await this.r2.resumeMultipartUpload(this.key(key), uploadId).uploadPart(part, data);
    await this.db.prepare(`INSERT INTO demo_parts VALUES (?, ?, ?, ?)
      ON CONFLICT (upload_id, part_number) DO UPDATE SET etag = excluded.etag, bytes = excluded.bytes`)
      .bind(uploadId, part, etag, bytes).run();
  }

  async complete(key: string, uploadId: string, parts: Part[]) {
    await this.r2.resumeMultipartUpload(this.key(key), uploadId).complete(parts.map(part => ({ partNumber: part.number, etag: part.etag })));
    await this.db.prepare('DELETE FROM demo_parts WHERE upload_id = ?').bind(uploadId).run();
  }

  async abort(key: string, uploadId: string) {
    await this.r2.resumeMultipartUpload(this.key(key), uploadId).abort();
    await this.db.prepare('DELETE FROM demo_parts WHERE upload_id = ?').bind(uploadId).run();
  }
}

export function bucketStore(env: Env, bucket: Bucket): Store {
  if (isDemo(env)) return new DemoStore(env.DB, env.DEMO_STORE!, bucket.id);
  return new B2Store(bucket);
}

export async function store(env: Env, id: string): Promise<Store> {
  const configured = configuredBuckets(env).find(item => item.id === id);
  if (configured) return bucketStore(env, configured);
  const bucket = await env.DB.prepare(`SELECT bucket_id AS id, name, region, quota, priority, credentials FROM bucket_settings
    WHERE bucket_id = ? AND removed = 0 AND credentials IS NOT NULL`)
    .bind(id).first<Omit<Bucket, 'keyId' | 'applicationKey' | 'writable'> & { credentials: string }>();
  if (!bucket) throw new HttpError(503, '文件所在的存储桶未配置');
  return bucketStore(env, { ...bucket, ...await decryptCredentials(env, id, bucket.credentials), writable: true });
}
