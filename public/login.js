const form = document.getElementById('login-form');
const password = document.getElementById('password');
const errorMessage = document.getElementById('login-error');
document.getElementById('login-demo').hidden = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const next = new URLSearchParams(location.search).get('next') ?? '';
const destination = next === '/admin' || next.startsWith('/admin?') ? next : '/admin';

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  errorMessage.hidden = true;
  try {
    const result = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    if (!result.ok) {
      const failure = await result.json().catch(() => ({}));
      throw new Error(failure.error ?? '暂时无法登录，请稍后重试');
    }
    location.replace(destination);
  } catch (error) {
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
    password.focus();
    password.select();
  } finally { button.disabled = false; }
});
