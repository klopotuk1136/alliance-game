import type { AuthResponse } from '../../shared/protocol.ts';
import { api, setToken } from './api.ts';
import { h, replaceChildren } from './dom.ts';
import { markNewAccount } from './profile.ts';
import { logo } from './ui.ts';

/** Login / sign-up screen. Calls `done` once a token is stored. */
export function showAuth(app: HTMLElement, done: () => void, roomCode: string | null): () => void {
  let mode: 'login' | 'register' = 'login';
  const error = h('p', { class: 'form-error', role: 'alert' });
  const username = h('input', { name: 'username', autocomplete: 'username', required: true, maxlength: 20, autocapitalize: 'off', spellcheck: 'false' });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, maxlength: 200 });
  const submit = h('button', { class: 'btn primary wide', type: 'submit' }, 'Log in');
  const tabLogin = h('button', { class: 'tab active', type: 'button', role: 'tab', 'aria-selected': 'true' }, 'Log in');
  const tabRegister = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'false' }, 'Create account');
  const hint = h('p', { class: 'hint' });

  function setMode(m: typeof mode): void {
    mode = m;
    tabLogin.classList.toggle('active', m === 'login');
    tabRegister.classList.toggle('active', m === 'register');
    tabLogin.setAttribute('aria-selected', String(m === 'login'));
    tabRegister.setAttribute('aria-selected', String(m === 'register'));
    submit.textContent = m === 'login' ? 'Log in' : 'Create account';
    password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    hint.textContent = m === 'register' ? 'Username: 3–20 letters, digits, _ . -   Password: at least 6 characters.' : '';
    error.textContent = '';
  }
  tabLogin.addEventListener('click', () => setMode('login'));
  tabRegister.addEventListener('click', () => setMode('register'));

  const form = h(
    'form',
    { class: 'auth-form' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Username'), username),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Password'), password),
    hint,
    error,
    submit,
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      const res = await api<AuthResponse>('POST', mode === 'login' ? '/api/login' : '/api/register', {
        username: username.value.trim(),
        password: password.value,
      });
      setToken(res.token);
      if (mode === 'register') markNewAccount(res.user.username);
      done();
    } catch (err) {
      error.textContent = (err as Error).message;
    } finally {
      submit.disabled = false;
    }
  });

  replaceChildren(
    app,
    h(
      'main',
      { class: 'auth-wrap' },
      h(
        'div',
        { class: 'card auth-card framed' },
        h(
          'div',
          { class: 'auth-brand' },
          logo(),
          h('p', { class: 'tagline' }, 'Form alliances. Betray friends.', h('br'), h('em', null, 'Be the last country standing.')),
        ),
        roomCode ? h('p', { class: 'invite' }, h('span', { class: 'eyebrow' }, 'Invitation'), 'Log in or create an account to open the room you were invited to.') : null,
        h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Account' }, tabLogin, tabRegister),
        form,
      ),
      h('p', { class: 'auth-foot' }, 'Diplomacy and betrayal on a hex map'),
    ),
  );
  username.focus();
  return () => undefined;
}
