const $ = id => document.getElementById(id);
const path = location.pathname;
const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

async function request(action, options) {
  const result = await fetch(`${path}/${action}`, options);
  const data = await result.json();
  if (!result.ok) throw new Error(data.error ?? '暂时无法访问分享');
  return data;
}

function showError(error) {
  $('share-error').textContent = error.message;
  $('share-error').hidden = false;
}

async function showShare() {
  const share = await request('info');
  $('unlock-form').hidden = !share.locked;
  $('download').hidden = share.locked;
  if (share.locked) {
    $('share-meta').textContent = '此文件需要访问密码。';
  } else {
    $('share-title').textContent = share.name;
    const size = share.bytes >= 1024 * 1024 ? `${(share.bytes / (1024 * 1024)).toFixed(1)} MiB` : `${share.bytes.toLocaleString('zh-CN')} B`;
    $('share-meta').textContent = `${size} · ${date.format(share.expiresAt * 1000)} 到期`;
    $('download').href = `${path}/download`;
  }
}

$('unlock-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $('share-error').hidden = true;
  try {
    await request('unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) });
    $('password').value = '';
    await showShare();
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
});

showShare().catch(error => {
  $('share-meta').textContent = '';
  showError(error);
});
