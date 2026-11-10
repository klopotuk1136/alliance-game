import type { AuthResponse } from '../../shared/protocol.ts';
import { api, setToken } from './api.ts';
import { h, replaceChildren } from './dom.ts';
import { markNewAccount } from './profile.ts';
import { logo } from './ui.ts';
import { L, onLang, t, T } from './i18n.ts';
import { langSwitch } from './lang-switch.ts';

/** Login / sign-up screen. Calls `done` once a token is stored. */
export function showAuth(app: HTMLElement, done: () => void, roomCode: string | null): () => void {
  let mode: 'login' | 'register' = 'login';
  const error = h('p', { class: 'form-error', role: 'alert' });
  const username = h('input', { name: 'username', autocomplete: 'username', required: true, maxlength: 20, autocapitalize: 'off', spellcheck: 'false' });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, maxlength: 200 });
  const submit = h('button', { class: 'btn primary wide', type: 'submit' });
  const tabLogin = h('button', { class: 'tab active', type: 'button', role: 'tab', 'aria-selected': 'true' }, T('auth.logIn'));
  const tabRegister = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'false' }, T('auth.createAccount'));
  const hint = h('p', { class: 'hint' });
  let lastError: unknown = null;
  const paintError = (): void => {
    error.textContent = lastError ? (lastError as Error).message : '';
  };

  function setMode(m: typeof mode): void {
    mode = m;
    tabLogin.classList.toggle('active', m === 'login');
    tabRegister.classList.toggle('active', m === 'register');
    tabLogin.setAttribute('aria-selected', String(m === 'login'));
    tabRegister.setAttribute('aria-selected', String(m === 'register'));
    submit.textContent = t(m === 'login' ? 'auth.logIn' : 'auth.createAccount');
    password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    hint.textContent = m === 'register' ? t('auth.registerHint') : '';
  }
  function switchMode(m: typeof mode): void {
    setMode(m);
    lastError = null;
    paintError();
  }
  setMode('login');
  tabLogin.addEventListener('click', () => switchMode('login'));
  tabRegister.addEventListener('click', () => switchMode('register'));

  const form = h(
    'form',
    { class: 'auth-form' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, T('auth.username')), username),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, T('auth.password')), password),
    hint,
    error,
    submit,
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    lastError = null;
    paintError();
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
      lastError = err;
      paintError();
    } finally {
      submit.disabled = false;
    }
  });

  replaceChildren(
    app,
    h(
      'main',
      { class: 'auth-wrap' },
      langSwitch('auth-lang'),
      h(
        'div',
        { class: 'card auth-card framed' },
        h(
          'div',
          { class: 'auth-brand' },
          logo(),
          h('p', { class: 'tagline' }, T('auth.tagline1'), h('br'), h('em', null, T('auth.tagline2'))),
        ),
        roomCode ? h('p', { class: 'invite' }, h('span', { class: 'eyebrow' }, T('auth.invitation')), T('auth.inviteText')) : null,
        h('div', { class: 'tabs', role: 'tablist', 'aria-label': L('auth.account') }, tabLogin, tabRegister),
        form,
      ),
      h('p', { class: 'auth-foot' }, T('auth.foot')),
    ),
  );
  username.focus();
  const offLang = onLang(() => {
    setMode(mode);
    paintError();
  });
  return offLang;
}
