const $ = id => document.getElementById(id);
const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const state = { view: 'overview', parent: 'root', next: null, shown: 0, generation: 0, uploading: false };
let dialogAction;
let toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, run) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', run);
  return node;
}

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  const order = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  return `${Number((bytes / 1024 ** (order + 1)).toFixed(1))} ${units[order]}`;
}

async function api(path, { method = 'GET', data, raw } = {}) {
  const response = await fetch(path, {
    method,
    headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: data === undefined ? raw : JSON.stringify(data),
  });
  if (!response.ok) {
    if (response.status === 401) location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    const failure = await response.json().catch(() => ({}));
    throw Object.assign(new Error(failure.error || `请求失败（${response.status}）`), { status: response.status });
  }
  return response.status === 204 ? null : response.json();
}

function notify(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
}

function errorAt(id, error) {
  $(id).textContent = error?.message ?? '';
  $(id).hidden = !error;
}

function driveHref(id) { return id === 'root' ? '/admin?view=files' : `/admin?view=files&folder=${id}`; }

function openView(event) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  history.pushState({}, '', event.currentTarget.href);
  void load();
}

function locationLink(text, href) {
  const node = element('a', '', text);
  node.href = href;
  node.addEventListener('click', openView);
  return node;
}

async function loadCapacity() {
  try {
    const { demo, used, quota } = await api('/api/storage');
    $('demo').hidden = !demo;
    const bar = element('progress');
    bar.max = quota || 1;
    bar.value = Math.min(used, quota);
    bar.setAttribute('aria-label', '网盘容量配额');
    $('storage-capacity').replaceChildren(element('span', '', quota ? `${fileSize(used)} / ${fileSize(quota)}` : '待接入存储桶'), bar);
  } catch (error) { $('storage-capacity').textContent = error.message; }
}

function breadcrumbs(path) {
  const nodes = [];
  for (const [index, crumb] of path.entries()) {
    if (index) nodes.push(element('span', 'crumb-separator', '/'));
    if (index === path.length - 1) {
      const current = element('span', '', crumb.name);
      current.setAttribute('aria-current', 'location');
      nodes.push(current);
    } else { nodes.push(locationLink(crumb.name, driveHref(crumb.id))); }
  }
  $('breadcrumbs').replaceChildren(...nodes);
}

function badgeIcon(kind) {
  const badge = element('span', `item-icon${kind === 'file' ? ' is-file' : ''}`);
  badge.setAttribute('aria-hidden', 'true');
  badge.append(element('span', `icon ${kind}`));
  return badge;
}

function iconControl(label, symbol, run, href) {
  const node = href ? element('a', 'icon-button', symbol) : button(symbol, 'icon-button', run);
  if (href) node.href = href;
  node.title = label;
  node.setAttribute('aria-label', label);
  return node;
}

function fileRow(item) {
  const row = element('tr');
  const name = element('div', 'item-name');
  const isFolder = item.kind === 'folder';
  const download = `/api/entries/${item.id}/download`;
  const title = isFolder ? locationLink(item.name, driveHref(item.id)) : element('a', '', item.name);
  if (!isFolder) title.href = download;
  name.append(badgeIcon(item.kind), title);
  row.insertCell().append(name);
  row.insertCell().textContent = isFolder ? '—' : fileSize(item.bytes);
  const changed = row.insertCell();
  changed.className = 'date-column';
  changed.textContent = date.format(item.updated_at * 1000);
  const actions = element('div', 'row-actions');
  if (!isFolder) actions.append(iconControl('下载', '↓', null, download), iconControl('创建分享', '↗', () => shareDialog(item)));
  const details = element('details');
  const summary = element('summary', 'icon-button', '⋯');
  summary.title = '更多操作';
  summary.setAttribute('aria-label', `${item.name}的更多操作`);
  const menu = element('div', 'row-menu');
  for (const [label, action] of [['重命名', renameDialog], ['移动', moveDialog], ['删除', deleteDialog]]) {
    menu.append(button(label, label === '删除' ? 'remove' : '', () => { details.open = false; action(item); }));
  }
  details.append(summary, menu);
  actions.append(details);
  row.insertCell().append(actions);
  return row;
}

function shareRow(item) {
  const row = element('tr');
  const name = element('div', 'item-name');
  name.append(badgeIcon('link'), element('span', '', item.name));
  row.insertCell().append(name);
  const status = item.active ? '有效' : item.revoked_at ? '已撤销' : item.deleted_at ? '文件已删除' : '已过期';
  row.insertCell().append(element('span', `status-pill${item.active ? '' : ' inactive'}`, status),
    element('small', 'share-policy', item.protected ? '有密码' : '公开链接'));
  const expiry = row.insertCell();
  expiry.className = 'date-column';
  expiry.textContent = date.format(item.expires_at * 1000);
  const actions = element('div', 'row-actions');
  if (item.url) actions.append(iconControl('复制分享链接', '⧉', () => copyLink(item.url)));
  if (item.active) actions.append(iconControl('撤销分享', '×', () => revokeDialog(item)));
  row.insertCell().append(actions);
  return row;
}

function metric(label, value) {
  const card = element('div', 'metric');
  card.append(element('span', 'metric-label', label), element('strong', 'metric-value', value));
  return card;
}

function bucketCard(bucket) {
  const card = element('article', 'managed-bucket');
  const title = element('div', 'bucket-title');
  title.append(element('h2', '', bucket.name), element('span', '', bucket.region || '本地存储'));
  const status = !bucket.writable ? '只读' : bucket.paused ? '已暂停' : bucket.retryAt ? '暂不可用' : '可写入';
  const header = element('div', 'bucket-header');
  header.append(title, element('span', `bucket-status${status === '可写入' ? ' ready' : ''}`, status));
  const bar = element('progress');
  bar.max = bucket.quota;
  bar.value = Math.min(bucket.used, bucket.quota);
  bar.setAttribute('aria-label', `${bucket.name} 容量`);
  const details = element('div', 'bucket-details');
  details.append(element('span', '', `${fileSize(bucket.used)} / ${fileSize(bucket.quota)}`),
    element('span', '', `对象 ${bucket.files} · 上传记录 ${bucket.uploads}`));
  const actions = element('div', 'bucket-actions');
  if (bucket.writable) {
    actions.append(button(bucket.paused ? '恢复分配' : '暂停分配', 'button secondary', () => {
      dialog(bucket.paused ? '恢复新上传分配' : '暂停新上传分配', [element('p', '', bucket.paused
        ? `恢复后，${bucket.name} 会重新参与后台选桶。`
        : `暂停后，新上传会使用其他可用桶。${bucket.name} 上的下载和已开始上传的续传可继续。`)],
      bucket.paused ? '恢复' : '暂停', async () => {
        await api(`/api/admin/buckets/${bucket.id}`, { method: 'PATCH', data: { paused: !bucket.paused } });
        await refreshStorage(bucket.paused ? '已恢复分配' : '已暂停分配');
      });
    }));
  }
  const remove = button('移除桶', 'button secondary remove-bucket', () => {
    dialog('移除存储桶', [element('p', '', `将「${bucket.name}」从网盘移除？Backblaze 上的桶会保留。`)], '移除', async () => {
      await api(`/api/admin/buckets/${bucket.id}`, { method: 'DELETE' });
      await refreshStorage('存储桶已移除');
    }, true);
  });
  remove.disabled = bucket.files > 0 || bucket.uploads > 0;
  actions.append(remove);
  card.append(header, details, bar, actions);
  if (remove.disabled) card.append(element('p', 'bucket-note', '文件和待清理上传处理完后可移除。'));
  if (bucket.retryAt && status === '暂不可用') card.append(element('p', 'bucket-note', `${date.format(bucket.retryAt * 1000)} 后可重新参与分配。`));
  return card;
}

function pendingRow(upload, names) {
  const row = element('article', 'pending-row');
  const info = element('div');
  info.append(element('strong', '', upload.name), element('small', 'muted', `${names.get(upload.bucket_id) ?? '存储桶未接入'} · ${fileSize(upload.bytes)} · ${date.format(upload.expires_at * 1000)} 到期`));
  row.append(info, button('取消上传', 'button secondary', () => {
    dialog('取消上传', [element('p', '', `取消「${upload.name}」的上传会话？已有分片会在定时清理时释放。`)], '取消上传', async () => {
      await api(`/api/uploads/${upload.id}`, { method: 'DELETE' });
      await refreshStorage('已取消上传');
    }, true);
  }));
  return row;
}

async function refreshStorage(message) {
  await load();
  void loadCapacity();
  notify(message);
}

async function loadAdminPanel(view, generation) {
  const isStorage = view === 'storage';
  const title = isStorage ? '存储桶' : '发布概览';
  breadcrumbs([{ name: title }]);
  $('page-title').textContent = title;
  $('summary').textContent = '加载中…';
  for (const id of ['dashboard-stats', 'bucket-list', 'pending-list']) $(id).replaceChildren();
  try {
    const stats = await api('/api/admin/overview');
    if (generation !== state.generation) return;
    if (!isStorage) {
      $('summary').textContent = stats.buckets.length ? `已接入 ${stats.buckets.length} 个存储桶` : '在「存储」中接入存储桶后即可上传';
      $('dashboard-stats').replaceChildren(metric('资源文件', stats.files), metric('有效分享', stats.shares),
        metric('未完成上传', stats.uploads), metric('已用容量', fileSize(stats.used)));
      return;
    }
    const names = new Map(stats.buckets.map(bucket => [bucket.id, bucket.name]));
    $('summary').textContent = `${stats.buckets.length} 个桶 · ${fileSize(stats.used)} / ${fileSize(stats.quota)}${stats.cleanup ? ` · ${stats.cleanup} 项待清理` : ''}`;
    $('bucket-list').replaceChildren(...(stats.buckets.length ? stats.buckets.map(bucketCard) : [element('p', 'panel-empty', '添加一个 Backblaze B2 私有桶即可开始上传。')]));
    $('pending-list').replaceChildren(...(stats.pending.length ? stats.pending.map(upload => pendingRow(upload, names)) : [element('p', 'panel-empty', '没有未完成的上传。')]));
    if (stats.uploads > stats.pending.length) $('pending-list').append(element('p', 'panel-empty', `显示最近 ${stats.pending.length} 条，共 ${stats.uploads} 条。`));
  } catch (error) {
    if (generation === state.generation) { $('summary').textContent = ''; errorAt('error', error); }
  }
}

async function load(append = false) {
  const generation = ++state.generation;
  const params = new URLSearchParams(location.search);
  const requested = params.get('view');
  state.view = ['files', 'shares', 'storage'].includes(requested) ? requested : 'overview';
  state.parent = params.get('folder') ?? 'root';
  const shares = state.view === 'shares';
  const files = state.view === 'files';
  const storage = state.view === 'storage';
  const offset = append ? state.next : 0;
  $('admin-navigation').querySelectorAll('[data-view]').forEach(node => node.setAttribute('aria-current', node.dataset.view === state.view ? 'page' : 'false'));
  $('file-actions').hidden = !files;
  $('add-bucket').hidden = !storage;
  $('dashboard-panel').hidden = state.view !== 'overview';
  $('storage-panel').hidden = !storage;
  $('table-card').hidden = !files && !shares;
  errorAt('error', null);
  if (!files && !shares) return loadAdminPanel(state.view, generation);
  $('col-size').textContent = shares ? '状态' : '大小';
  $('col-date').textContent = shares ? '到期时间' : '修改时间';
  $('more').disabled = true;
  if (!append) {
    state.shown = 0;
    $('rows').replaceChildren();
    $('empty').hidden = true;
    $('pager').hidden = true;
    $('page-title').textContent = shares ? '分享管理' : '资源管理';
    $('summary').textContent = '加载中…';
  }
  try {
    const data = await api(shares ? `/api/shares?offset=${offset}` : `/api/entries?parent=${encodeURIComponent(state.parent)}&offset=${offset}`);
    if (generation !== state.generation) return;
    const path = shares ? [{ name: '分享管理' }] : data.path.map(crumb => crumb.id === 'root' ? { ...crumb, name: '资源管理' } : crumb);
    breadcrumbs(path);
    $('page-title').textContent = path.at(-1).name;
    $('rows').append(...data.items.map(shares ? shareRow : fileRow));
    state.shown += data.items.length;
    state.next = data.next;
    $('summary').textContent = `${state.shown} ${shares ? '条分享' : '个项目'}${state.next === null ? '' : '已加载'}`;
    $('empty').hidden = state.shown > 0;
    $('empty-icon').className = `icon ${shares ? 'link' : 'folder'}`;
    $('empty-title').textContent = shares ? '还没有分享' : '文件夹为空';
    $('empty-text').textContent = shares ? '在文件列表中为文件创建分享链接。' : '把文件拖到这里，或从设备中选择文件。';
    $('empty-upload').hidden = shares;
    $('pager').hidden = state.next === null;
  } catch (error) {
    if (generation === state.generation) { $('summary').textContent = ''; errorAt('error', error); }
  } finally {
    if (generation === state.generation) $('more').disabled = false;
  }
}

function field(label, options) {
  const wrapper = element('label', 'field', label);
  const input = Object.assign(element('input'), options);
  wrapper.append(input);
  return { wrapper, input };
}

function addBucketDialog() {
  const name = field('桶名称', { required: true, minLength: 6, maxLength: 50, placeholder: 'Backblaze 中的 Bucket Name' });
  const region = field('S3 区域', { required: true, maxLength: 32, placeholder: '例如 us-west-004' });
  const keyId = field('Key ID', { required: true, maxLength: 256, autocomplete: 'off' });
  const key = field('Application Key', { type: 'password', required: true, maxLength: 256, autocomplete: 'new-password' });
  const quota = field('应用配额（GiB）', { type: 'number', value: '10', min: '1', max: '1048576', required: true });
  const priority = field('优先级（同占用率时使用）', { type: 'number', value: '1', min: '0', max: '999', required: true });
  const limits = element('div', 'paired-fields');
  limits.append(quota.wrapper, priority.wrapper);
  dialog('接入 B2 私有桶', [name.wrapper, region.wrapper, keyId.wrapper, key.wrapper, limits], '验证并添加', async () => {
    $('dialog-submit').textContent = '正在验证…';
    try {
      await api('/api/admin/buckets', { method: 'POST', data: { name: name.input.value, region: region.input.value,
        keyId: keyId.input.value, applicationKey: key.input.value, quotaGiB: Number(quota.input.value), priority: Number(priority.input.value) } });
      keyId.input.value = '';
      key.input.value = '';
      await refreshStorage('存储桶已接入');
    } finally { $('dialog-submit').textContent = '验证并添加'; }
  });
}

function dialog(title, content, submit, run, danger = false) {
  $('dialog-title').textContent = title;
  $('dialog-content').replaceChildren(...content);
  $('dialog-submit').textContent = submit;
  $('dialog-submit').className = `button ${danger ? 'danger' : 'primary'}`;
  $('dialog-submit').disabled = false;
  $('dialog-cancel').textContent = '取消';
  dialogAction = run;
  errorAt('dialog-error', null);
  if (!$('dialog').open) $('dialog').showModal();
  const input = $('dialog-content').querySelector('input');
  if (input) input.focus();
}

function newFolder() {
  const parentId = state.parent;
  const { wrapper, input } = field('文件夹名称', { maxLength: 255, required: true });
  dialog('新建文件夹', [wrapper], '创建', async () => {
    await api('/api/folders', { method: 'POST', data: { name: input.value, parentId } });
    void load();
    notify('文件夹已创建');
  });
}

function renameDialog(item) {
  const { wrapper, input } = field('新名称', { value: item.name, maxLength: 255, required: true });
  dialog('重命名', [wrapper], '保存', async () => {
    await api(`/api/entries/${item.id}`, { method: 'PATCH', data: { name: input.value } });
    void load();
    notify('名称已更新');
  });
  input.select();
}

function moveDialog(item) {
  const current = element('p', 'muted');
  const picker = element('div', 'picker');
  let target;
  let generation = 0;
  async function browse(id) {
    const run = ++generation;
    target = null;
    $('dialog-submit').disabled = true;
    picker.replaceChildren(element('span', 'muted', '正在读取文件夹…'));
    errorAt('dialog-error', null);
    try {
      const data = await api(`/api/entries?folders=1&parent=${id}`);
      if (run !== generation || !picker.isConnected) return;
      target = id;
      current.textContent = data.path.map(crumb => crumb.name).join(' / ');
      picker.replaceChildren();
      if (data.path.length > 1) picker.append(button('↑ 上一级', 'button secondary', () => browse(data.path.at(-2).id)));
      function addPage(page) {
        for (const child of page.items.filter(child => child.id !== item.id)) {
          picker.append(button(child.name, 'button secondary', () => browse(child.id)));
        }
        if (page.next !== null) {
          const more = button('加载更多文件夹', 'button secondary', async () => {
            more.disabled = true;
            try {
              const next = await api(`/api/entries?folders=1&parent=${id}&offset=${page.next}`);
              if (run === generation && picker.isConnected) { more.remove(); addPage(next); }
            } catch (error) { errorAt('dialog-error', error); more.disabled = false; }
          });
          picker.append(more);
        }
      }
      addPage(data);
      $('dialog-submit').disabled = id === state.parent;
    } catch (error) { if (run === generation && picker.isConnected) errorAt('dialog-error', error); }
  }
  dialog(`移动「${item.name}」`, [current, picker], '移动到这里', async () => {
    if (!target) return false;
    await api(`/api/entries/${item.id}`, { method: 'PATCH', data: { parentId: target } });
    void load();
    notify('已移动');
  });
  void browse('root');
}

function deleteDialog(item) {
  const message = item.kind === 'folder' ? `删除空文件夹「${item.name}」？` : `删除「${item.name}」？该文件的分享链接也会失效。`;
  dialog('删除项目', [element('p', '', message)], '删除', async () => {
    await api(`/api/entries/${item.id}`, { method: 'DELETE' });
    void load();
    void loadCapacity();
    notify('已删除');
  }, true);
}

function shareDialog(item) {
  const days = field('有效期（天）', { type: 'number', min: '1', max: '365', value: '7', required: true });
  const password = field('访问密码（可选）', { type: 'password', minLength: 8, maxLength: 128, autocomplete: 'new-password' });
  dialog(`分享「${item.name}」`, [days.wrapper, password.wrapper], '创建链接', async () => {
    const share = await api('/api/shares', { method: 'POST', data: { fileId: item.id, days: Number(days.input.value), password: password.input.value } });
    linkDialog(share.url);
    return false;
  });
}

function linkDialog(url) {
  const { wrapper, input } = field('分享链接', { value: url, readOnly: true });
  dialog('分享链接', [wrapper], '复制链接', async () => {
    try { await navigator.clipboard.writeText(url); notify('链接已复制'); }
    catch { input.select(); throw new Error('自动复制失败，已选中链接，可手动复制。'); }
  });
  $('dialog-cancel').textContent = '关闭';
  input.select();
}

async function copyLink(url) {
  try { await navigator.clipboard.writeText(url); notify('链接已复制'); }
  catch { linkDialog(url); }
}

function revokeDialog(item) {
  dialog('撤销分享', [element('p', '', `撤销「${item.name}」的此条分享？新下载请求会立即失效。`)], '撤销', async () => {
    await api(`/api/shares/${item.id}`, { method: 'DELETE' });
    void load();
    notify('分享已撤销');
  }, true);
}

function resumeKey(file, parentId) { return `cfb2-upload:${parentId}:${file.name}:${file.size}:${file.lastModified}`; }

function progress(value, message) {
  $('upload-progress').value = value;
  $('upload-percent').textContent = `${value}%`;
  $('upload-message').textContent = message;
}

async function uploadFile(file, parentId) {
  const key = resumeKey(file, parentId);
  let session;
  const saved = localStorage.getItem(key);
  if (saved) {
    try { session = await api(`/api/uploads/${saved}`); }
    catch (error) { if (error.status !== 404 && error.status !== 410) throw error; localStorage.removeItem(key); }
  }
  if (!session) {
    session = await api('/api/uploads', { method: 'POST', data: { parentId, name: file.name, bytes: file.size } });
    localStorage.setItem(key, session.id);
  }
  const path = `/api/uploads/${session.id}`;
  if (!session.done) {
    if (session.completed) await api(`${path}/complete`, { method: 'POST' });
    else if (!session.multipart) await api(`${path}/object`, { method: 'PUT', raw: file });
    else {
      const done = new Set(session.parts ?? []);
      const total = Math.ceil(file.size / session.partBytes);
      for (let number = 1; number <= total; number++) {
        if (!done.has(number)) {
          progress(Math.floor((number - 1) * 100 / total), `正在上传第 ${number} / ${total} 个分片`);
          const start = (number - 1) * session.partBytes;
          await api(`${path}/part/${number}`, { method: 'PUT', raw: file.slice(start, start + session.partBytes) });
        }
      }
      progress(99, '正在校验并合并分片…');
      await api(`${path}/complete`, { method: 'POST' });
    }
  }
  localStorage.removeItem(key);
}

async function uploadFiles(files) {
  if (!files.length || state.uploading || state.view !== 'files') return;
  state.uploading = true;
  $('upload').disabled = true;
  $('empty-upload').disabled = true;
  $('upload-status').hidden = false;
  const parentId = state.parent;
  let failed = 0;
  for (const [index, file] of files.entries()) {
    $('upload-title').textContent = `${file.name} · ${index + 1}/${files.length}`;
    progress(0, '正在准备上传…');
    try { await uploadFile(file, parentId); progress(100, '上传完成'); }
    catch (error) {
      failed++;
      errorAt('error', error);
      progress(0, error.message);
    }
  }
  state.uploading = false;
  $('upload').disabled = false;
  $('empty-upload').disabled = false;
  await load();
  void loadCapacity();
  if (failed) {
    $('upload-title').textContent = `${files.length - failed} 个已完成，${failed} 个失败`;
    $('upload-message').textContent += ' 重新选择失败的原文件以重试。';
  } else { notify(`${files.length} 个文件上传完成`); $('upload-status').hidden = true; }
}

document.querySelectorAll('#admin-navigation a, [data-admin-link]').forEach(node => node.addEventListener('click', openView));
$('add-bucket').addEventListener('click', addBucketDialog);
window.addEventListener('popstate', () => void load());
$('more').addEventListener('click', () => void load(true));
$('new-folder').addEventListener('click', newFolder);
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try {
    await api('/api/admin/logout', { method: 'POST' });
    location.replace('/login');
  } catch (error) { errorAt('error', error); }
  finally { $('logout').disabled = false; }
});
for (const id of ['upload', 'empty-upload']) $(id).addEventListener('click', () => $('upload-input').click());
$('upload-input').addEventListener('change', () => {
  void uploadFiles(Array.from($('upload-input').files));
  $('upload-input').value = '';
});
$('workspace').addEventListener('dragover', event => {
  if (state.view === 'files' && event.dataTransfer.types.includes('Files')) {
    event.preventDefault();
    $('workspace').classList.add('dragging');
  }
});
$('workspace').addEventListener('dragleave', event => {
  if (!$('workspace').contains(event.relatedTarget)) $('workspace').classList.remove('dragging');
});
$('workspace').addEventListener('drop', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  $('workspace').classList.remove('dragging');
  void uploadFiles(Array.from(event.dataTransfer.files));
});
for (const id of ['dialog-cancel', 'dialog-close']) $(id).addEventListener('click', () => $('dialog').close());
$('dialog-form').addEventListener('submit', async event => {
  event.preventDefault();
  const action = dialogAction;
  $('dialog-submit').disabled = true;
  $('dialog-cancel').disabled = true;
  $('dialog-close').disabled = true;
  errorAt('dialog-error', null);
  try {
    if (await action() !== false) $('dialog').close();
  } catch (error) { if (action === dialogAction) errorAt('dialog-error', error); }
  finally {
    $('dialog-submit').disabled = false;
    $('dialog-cancel').disabled = false;
    $('dialog-close').disabled = false;
  }
});
$('dialog').addEventListener('cancel', event => { if ($('dialog-cancel').disabled) event.preventDefault(); });
document.addEventListener('click', event => {
  document.querySelectorAll('details[open]').forEach(details => { if (!details.contains(event.target)) details.open = false; });
});
void loadCapacity();
void load();
