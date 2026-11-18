import { body, Entry, Env, folder, HttpError, idOf, json, nameOf, now, numberOf, uniqueName } from './common';
import { store } from './storage';

export async function listEntries(env: Env, url: URL) {
  const parent = idOf(url.searchParams.get('parent') ?? 'root');
  const offset = numberOf(Number(url.searchParams.get('offset') ?? 0), 0, 100000, '分页参数无效');
  const foldersOnly = url.searchParams.get('folders') === '1';
  const [path, page] = await env.DB.batch([
    env.DB.prepare(`WITH RECURSIVE path(id, name, parent_id, depth) AS (
      SELECT id, name, parent_id, 0 FROM entries WHERE id = ? AND deleted_at IS NULL AND kind = 'folder'
      UNION ALL SELECT e.id, e.name, e.parent_id, p.depth + 1 FROM entries e JOIN path p ON e.id = p.parent_id
    ) SELECT id, name FROM path ORDER BY depth DESC`).bind(parent),
    env.DB.prepare(`SELECT id, name, kind, bytes, updated_at FROM entries
      WHERE parent_id = ? AND deleted_at IS NULL AND (? = 0 OR kind = 'folder')
      ORDER BY kind DESC, name COLLATE NOCASE, id LIMIT 51 OFFSET ?`).bind(parent, Number(foldersOnly), offset),
  ]);
  if (!path.results.length) throw new HttpError(404, '文件夹不存在');
  return json({ path: path.results, items: page.results.slice(0, 50), next: page.results.length > 50 ? offset + 50 : null });
}

export async function createFolder(env: Env, request: Request) {
  const input = await body(request);
  const parent = idOf(input.parentId ?? 'root');
  const name = nameOf(input.name);
  const id = crypto.randomUUID();
  const timestamp = now();
  const result = await uniqueName(() => env.DB.prepare(`INSERT INTO entries (id, parent_id, name, kind, created_at, updated_at)
    SELECT ?, id, ?, 'folder', ?, ? FROM entries WHERE id = ? AND kind = 'folder' AND deleted_at IS NULL`)
    .bind(id, name, timestamp, timestamp, parent).run());
  if (!result.meta.changes) throw new HttpError(404, '目标文件夹不存在');
  return json({ id, name }, 201);
}

export async function editEntry(env: Env, request: Request, id: string) {
  if (id === 'root') throw new HttpError(400, '根目录不能修改');
  const input = await body(request);
  const name = input.name === undefined ? null : nameOf(input.name);
  const parent = input.parentId === undefined ? null : idOf(input.parentId);
  if (name === null && parent === null) throw new HttpError(400, '缺少要修改的内容');
  if (parent && !await folder(env.DB, parent)) throw new HttpError(404, '目标文件夹不存在');
  const result = await uniqueName(() => env.DB.prepare(`WITH RECURSIVE parents(id, parent_id) AS (
    SELECT id, parent_id FROM entries WHERE id = ? AND kind = 'folder' AND deleted_at IS NULL
    UNION ALL SELECT e.id, e.parent_id FROM entries e JOIN parents p ON e.id = p.parent_id
    ) UPDATE entries SET name = COALESCE(?, name), parent_id = COALESCE(?, parent_id), updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
        AND (? IS NULL OR (EXISTS (SELECT 1 FROM parents) AND NOT EXISTS (SELECT 1 FROM parents WHERE id = ?)))`)
    .bind(parent, name, parent, now(), id, parent, id).run());
  if (!result.meta.changes) throw new HttpError(409, '项目已移除，或不能移动到自身及子文件夹');
  return json({ id });
}

export async function deleteEntry(env: Env, id: string) {
  if (id === 'root') throw new HttpError(400, '根目录不能删除');
  const timestamp = now();
  const result = await env.DB.prepare(`UPDATE entries SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL
      AND (kind = 'file' OR (
        NOT EXISTS (SELECT 1 FROM entries c WHERE c.parent_id = ? AND c.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.parent_id = ? AND u.state = 'open' AND u.expires_at > ?)
      ))`).bind(timestamp, id, id, id, timestamp).run();
  if (!result.meta.changes) {
    const entry = await env.DB.prepare('SELECT kind FROM entries WHERE id = ? AND deleted_at IS NULL').bind(id).first();
    if (entry) throw new HttpError(409, '请先移走文件夹中的项目或取消正在进行的上传');
  }
  return new Response(null, { status: 204 });
}

function parseRange(value: string, bytes: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !bytes || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix > 0 ? { start: Math.max(bytes - suffix, 0), end: bytes - 1 } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), bytes - 1) : bytes - 1;
  return start < bytes && start <= end ? { start, end } : null;
}

export async function download(env: Env, request: Request, entry: Pick<Entry, 'name' | 'bytes' | 'bucket_id' | 'object_key' | 'version_id'>) {
  const rangeHeader = request.headers.get('range');
  const range = rangeHeader ? parseRange(rangeHeader, entry.bytes) : null;
  const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' });
  if (rangeHeader && !range) {
    headers.set('Content-Range', `bytes */${entry.bytes}`);
    return new Response(null, { status: 416, headers });
  }
  const quoted = entry.name.replace(/[^\x20-\x7E]|["\\]/g, '_').slice(0, 120);
  const encoded = encodeURIComponent(entry.name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  headers.set('Content-Disposition', `attachment; filename="${quoted}"; filename*=UTF-8''${encoded}`);
  headers.set('Content-Length', String(range ? range.end - range.start + 1 : entry.bytes));
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${entry.bytes}`);
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  const response = await (await store(env, entry.bucket_id!)).get(entry.object_key!, entry.version_id!, range ?? undefined);
  if (response.status !== status) {
    await response.body?.cancel();
    throw new HttpError(response.status === 404 ? 404 : 502, '存储对象暂时无法下载');
  }
  return new Response(response.body, { status, headers });
}
