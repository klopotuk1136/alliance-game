// Profiles in the browser: your own profile (state + editor), avatars, the top-bar user
// menu, public profile cards for other players, and the one-time "set up your profile"
// hint after registration. Everything here is optional: the game never waits for it.

import { BIO_MAX, DISPLAY_NAME_MAX, parseBio, parseDisplayName, parseTelegram, telegramUrl } from '../../shared/profile.ts';
import type { MyProfile, PublicProfile, UserInfo } from '../../shared/protocol.ts';
import { api } from './api.ts';
import { AvatarCropper, loadImageFile } from './avatar-crop.ts';
import { flagImg, h, onCloseTransient, replaceChildren, toast } from './dom.ts';
import { ratingBadges } from './leaderboard.ts';
import { logout, navigate } from './nav.ts';
import { bellIcon, openNotifySettings } from './notify-panel.ts';
import { icon, MenuButton, type Label } from './ui.ts';
import { errorText } from './errors.ts';
import { fmtDate, L, lang, onLang, setLang, t, T } from './i18n.ts';

const PHONE = '(max-width: 640px)';
const HINT_KEY = 'alliance.profileHint';

// ------------------------------------------------------------------ my profile state

let mine: MyProfile | null = null;
const listeners = new Set<() => void>();

export function setMyProfile(p: MyProfile | null | undefined, user: UserInfo): void {
  mine = p ?? { username: user.username, displayName: null, bio: null, telegram: null, avatarUrl: null, joinedAt: 0, games: 0, wins: 0, rating: 1000, ratedGames: 0, winPoints: 0, updatedAt: null };
  publicCache.delete(mine.username.toLowerCase());
  for (const fn of [...listeners]) fn();
}

export function myProfile(): MyProfile | null {
  return mine;
}

/** Calls `fn` on every change of your profile while `el` is in the page. */
function whileMounted(el: Element, fn: () => void): void {
  const run = (): void => {
    if (!el.isConnected) {
      listeners.delete(run);
      return;
    }
    fn();
  };
  listeners.add(run);
}

export function shownName(p: { displayName: string | null; username: string }): string {
  return p.displayName ?? p.username;
}

// ------------------------------------------------------------------ avatars

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[1]].map((w) => [...w][0]) : [...(words[0] ?? '?')].slice(0, 2);
  return letters.join('').toUpperCase() || '?';
}

/** A round avatar: the picture, or initials on a dark brass-ringed disc. Decorative (alt=""). */
export function avatarEl(url: string | null | undefined, name: string, size: 'xs' | 'sm' | 'md' | 'lg' | 'xl' = 'sm'): HTMLElement {
  return h(
    'span',
    { class: `avatar ${size} ${url ? 'has-img' : 'initials'}`, 'aria-hidden': 'true' },
    url ? h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }) : initials(name),
  );
}

// ------------------------------------------------------------------ layers (modal / popover / sheet)

export interface Layer {
  close(): void;
  panel: HTMLElement;
}

const layers: Layer[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hidden && el.offsetParent !== null);
}

/**
 * A dialog over the page. Desktop: a centred modal, or a popover next to `anchor`.
 * Phone: always a bottom sheet. Focus stays inside; Esc, the backdrop or close() dismiss it.
 */
export function openLayer(o: { label: Label; content: HTMLElement; kind: 'modal' | 'popover'; anchor?: HTMLElement | null; cls?: string; onClose?: () => void; initialFocus?: HTMLElement | null }): Layer {
  const phone = matchMedia(PHONE).matches;
  const kind = phone ? 'sheet' : o.kind;
  const returnTo = document.activeElement as HTMLElement | null;
  const backdrop = h('div', { class: `pf-backdrop ${kind}` });
  const panel = h(
    'div',
    { class: `pf-layer ${kind} ${o.cls ?? ''}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-label': o.label, tabindex: '-1' },
    kind === 'sheet' ? h('div', { class: 'pf-grab', 'aria-hidden': 'true' }) : null,
    o.content,
  );
  let closed = false;
  let offTransient: () => void = () => undefined;
  const layer: Layer = {
    panel,
    close() {
      if (closed) return;
      closed = true;
      offTransient();
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      panel.classList.remove('in');
      backdrop.classList.remove('in');
      window.removeEventListener('resize', place);
      const done = (): void => {
        panel.remove();
        backdrop.remove();
      };
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
      else setTimeout(done, 180);
      if (!layers.length) document.documentElement.classList.remove('pf-locked');
      o.onClose?.();
      if (returnTo && returnTo.isConnected) returnTo.focus({ preventScroll: true });
    },
  };
  const place = (): void => {
    if (kind !== 'popover' || !o.anchor) return;
    const r = o.anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = panel.offsetWidth;
    const ph = panel.offsetHeight;
    const m = 10;
    let left = r.left;
    left = Math.max(m, Math.min(left, vw - m - w));
    const below = r.bottom + 8;
    const top = below + ph <= vh - m ? below : Math.max(m, r.top - 8 - ph);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };
  backdrop.addEventListener('click', () => layer.close());
  panel.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      layer.close();
      return;
    }
    if (ev.key !== 'Tab') return;
    const f = focusables(panel);
    if (!f.length) {
      ev.preventDefault();
      panel.focus();
      return;
    }
    const first = f[0];
    const last = f[f.length - 1];
    if (ev.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  });
  document.body.append(backdrop, panel);
  if (kind !== 'popover') document.documentElement.classList.add('pf-locked');
  layers.push(layer);
  offTransient = onCloseTransient(() => layer.close());
  place();
  window.addEventListener('resize', place);
  requestAnimationFrame(() => {
    panel.classList.add('in');
    backdrop.classList.add('in');
  });
  const coarse = matchMedia('(pointer: coarse)').matches;
  const target = o.initialFocus && !coarse ? o.initialFocus : panel;
  target.focus({ preventScroll: true });
  return layer;
}

// ------------------------------------------------------------------ top bar menu

/** Avatar + display name in the top bar; opens a menu with Profile and Log out. */
export function userMenu(user: UserInfo, compact = false): HTMLElement {
  const menu = new MenuButton<'profile' | 'leaderboard' | 'notify' | 'lang' | 'logout'>({
    trigger: [],
    label: L('auth.account'),
    cls: `ghost small user-menu ${compact ? 'compact' : ''}`,
    minWidth: 200,
    options: () => [
      { value: 'profile', label: t('pf.menuProfile'), lead: () => icon('user') },
      { value: 'leaderboard', label: t('lb.title'), lead: () => icon('crown') },
      { value: 'notify', label: t('nt.menu'), lead: () => bellIcon() },
      // The other language, by its own name (the top bar also has the EN / RU switch).
      { value: 'lang', label: lang() === 'ru' ? 'English' : 'Русский', hint: lang() === 'ru' ? 'EN' : 'RU', lead: () => icon('globe') },
      { value: 'logout', label: t('pf.menuLogout'), lead: () => icon('logout') },
    ],
    onPick: (v) => {
      if (v === 'profile') openProfileEditor(user);
      else if (v === 'leaderboard') navigate('/leaderboard');
      else if (v === 'notify') openNotifySettings(null);
      else if (v === 'lang') setLang(lang() === 'ru' ? 'en' : 'ru');
      else logout();
    },
  });
  const render = (): void => {
    const p = mine ?? { username: user.username, displayName: null, avatarUrl: null };
    const name = shownName(p);
    replaceChildren(
      menu.el,
      avatarEl(p.avatarUrl, name, 'sm'),
      compact ? null : h('span', { class: 'user-menu-name' }, name),
      compact ? null : icon('chevron', 'user-menu-caret'),
    );
    menu.el.setAttribute('aria-label', t('pf.accountOf', { name }));
    menu.el.title = t('pf.signedInAs', { username: user.username });
  };
  render();
  whileMounted(menu.el, render);
  onLang(() => {
    if (menu.el.isConnected) render();
  });
  return menu.el;
}

// ------------------------------------------------------------------ public profile card

const publicCache = new Map<string, { at: number; p: Promise<PublicProfile> }>();

function fetchPublic(username: string): Promise<PublicProfile> {
  const key = username.toLowerCase();
  const hit = publicCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.p;
  const p = api<{ profile: PublicProfile }>('GET', `/api/users/${encodeURIComponent(username)}/profile`).then((r) => r.profile);
  p.catch(() => publicCache.delete(key));
  publicCache.set(key, { at: Date.now(), p });
  return p;
}


function telegramButton(handle: string, cls = 'btn secondary'): HTMLAnchorElement {
  return h(
    'a',
    { class: `${cls} tg-link`, href: telegramUrl(handle), target: '_blank', rel: 'noopener noreferrer' },
    icon('send'),
    h('span', null, `@${handle}`),
    icon('external', 'tg-ext'),
  );
}

export interface PlayerContext {
  /** Room nickname and flag, shown as "in this room". */
  nickname?: string;
  flag?: string;
  /** The viewer's own account, to offer "Edit profile". */
  me?: UserInfo;
}

/** Opens a player's public profile: a popover by `anchor` (desktop) or a bottom sheet (phone). */
export function openPublicProfile(username: string, anchor: HTMLElement | null, ctx: PlayerContext = {}): void {
  const body = h('div', { class: 'pf-card', 'aria-busy': 'true' }, h('div', { class: 'pf-card-loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), T('pf.loading')));
  let offLang: () => void = () => undefined;
  const layer = openLayer({ label: L('lb.profileOf', { name: ctx.nickname ?? username }), content: body, kind: 'popover', anchor, cls: 'pf-pop', onClose: () => offLang() });
  const isMe = !!ctx.me && ctx.me.username.toLowerCase() === username.toLowerCase();
  const source: Promise<PublicProfile> = isMe && mine ? Promise.resolve(mine) : fetchPublic(username);
  source.then(
    (p) => {
      offLang();
      offLang = onLang(() => paint(p, false));
      paint(p, true);
    },
    (err: Error) => {
      body.removeAttribute('aria-busy');
      replaceChildren(body, h('p', { class: 'form-error', role: 'alert' }, err.message), h('button', { class: 'btn ghost small', type: 'button', onclick: () => layer.close() }, T('common.close')));
    },
  );
  function paint(p: PublicProfile, focus: boolean): void {
    {
      const name = shownName(p);
      const closeBtn = h('button', { class: 'btn ghost small pf-x', type: 'button', 'aria-label': t('common.close'), onclick: () => layer.close() }, icon('close'));
      const stats: string[] = [];
      if (p.joinedAt) stats.push(t('pf.joined', { date: fmtDate(p.joinedAt, { month: 'long', year: 'numeric' }) }));
      stats.push(t('unit.games', { n: p.games }));
      if (p.wins) stats.push(t('unit.wins', { n: p.wins }));
      const roomLine =
        ctx.flag || (ctx.nickname && ctx.nickname !== name)
          ? h('p', { class: 'pf-room' }, ctx.flag ? h('span', { class: 'seal' }, flagImg(ctx.flag)) : null, h('span', null, h('span', { class: 'muted' }, t('pf.inRoomAs'), ' '), h('strong', null, ctx.nickname ?? name)))
          : null;
      body.removeAttribute('aria-busy');
      replaceChildren(
        body,
        closeBtn,
        h(
          'div',
          { class: 'pf-card-head' },
          avatarEl(p.avatarUrl, name, 'lg'),
          h('div', { class: 'pf-card-id' }, h('h2', { class: 'pf-card-name display' }, name), h('span', { class: 'pf-handle' }, `@${p.username}`)),
        ),
        roomLine,
        p.bio ? h('p', { class: 'pf-bio' }, p.bio) : h('p', { class: 'pf-bio empty' }, isMe ? t('pf.noBioMe') : t('pf.noBio')),
        ratingBadges(p),
        h('p', { class: 'pf-stats' }, stats.join('  ·  ')),
        h(
          'div',
          { class: 'pf-card-actions' },
          p.telegram ? telegramButton(p.telegram) : null,
          isMe && ctx.me
            ? h(
                'button',
                {
                  class: 'btn ghost',
                  type: 'button',
                  onclick: () => {
                    layer.close();
                    openProfileEditor(ctx.me!);
                  },
                },
                icon('user'),
                t('pf.edit'),
              )
            : null,
        ),
      );
      if (focus) (body.querySelector<HTMLElement>('.tg-link') ?? closeBtn).focus({ preventScroll: true });
    }
  }
}

/** Makes `el` open the player's profile on click / Enter. */
export function profileTrigger(el: HTMLElement, username: string | undefined, ctx: PlayerContext): HTMLElement {
  if (!username) return el;
  el.classList.add('pf-trigger');
  el.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openPublicProfile(username, el, ctx);
  });
  return el;
}

/** A player's name as a button that opens their profile. */
export function playerNameButton(p: { nickname: string; username?: string; flag?: string }, me: UserInfo, cls = 'player-name'): HTMLElement {
  if (!p.username) return h('span', { class: cls }, p.nickname);
  const btn = h(
    'button',
    { class: `${cls} pf-name`, type: 'button', title: L('pf.viewTitle', { username: p.username }), 'aria-label': L('pf.viewAria', { name: p.nickname }) },
    h('span', { class: 'pf-name-text' }, p.nickname),
  );
  return profileTrigger(btn, p.username, { nickname: p.nickname, flag: p.flag, me });
}

/**
 * The flag seal of a player list row, with the player's avatar pinned to it as a small
 * portrait (the flag stays the main identity). Clicking it opens the profile too; the name
 * button next to it is the keyboard path, so the seal itself is not focusable.
 */
export function playerSeal(p: { nickname: string; flag: string; username?: string; avatar?: string }, me: UserInfo): HTMLElement {
  const seal = h('span', { class: `seal ${p.avatar ? 'with-avatar' : ''}`.trim() }, flagImg(p.flag), p.avatar ? avatarEl(p.avatar, p.nickname, 'xs') : null);
  if (p.username) {
    const username = p.username;
    seal.classList.add('pf-trigger');
    seal.addEventListener('click', () => openPublicProfile(username, seal, { nickname: p.nickname, flag: p.flag, me }));
  }
  return seal;
}

// ------------------------------------------------------------------ editor

let editorOpen = false;

/** The profile editor: a large modal (a full-height sheet on phones). */
export function openProfileEditor(user: UserInfo): void {
  if (editorOpen) return;
  editorOpen = true;
  dismissProfileHint();
  const start: MyProfile = mine ?? { username: user.username, displayName: null, bio: null, telegram: null, avatarUrl: null, joinedAt: 0, games: 0, wins: 0, rating: 1000, ratedGames: 0, winPoints: 0, updatedAt: null };
  /** Avatar plan: keep, replace with the cropper's result, or remove. */
  let avatarPlan: 'keep' | 'new' | 'remove' = 'keep';
  let cropper: AvatarCropper | null = null;
  let busy = false;

  const error = h('p', { class: 'form-error', role: 'alert' });
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/*', hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
  const avatarBox = h('div', { class: 'pf-avatar-box' });
  const avatarActions = h('div', { class: 'pf-avatar-actions' });

  const nameInput = h('input', { id: 'pf-name', maxlength: DISPLAY_NAME_MAX * 2, autocomplete: 'nickname', placeholder: user.username, spellcheck: 'false' });
  nameInput.value = start.displayName ?? '';
  const nameCount = h('span', { class: 'pf-count num', 'aria-live': 'off' });
  const nameErr = h('p', { class: 'pf-field-msg', id: 'pf-name-msg' });

  const bioInput = h('textarea', { id: 'pf-bio', rows: 4, maxlength: BIO_MAX + 50, placeholder: L('pf.bioPlaceholder') });
  bioInput.value = start.bio ?? '';
  const bioCount = h('span', { class: 'pf-count num', id: 'pf-bio-count' });
  const bioErr = h('p', { class: 'pf-field-msg' });

  const tgInput = h('input', { id: 'pf-tg', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: L('pf.tgPlaceholder'), inputmode: 'url', 'aria-describedby': 'pf-tg-msg' });
  tgInput.value = start.telegram ? `@${start.telegram}` : '';
  const tgMsg = h('p', { class: 'pf-field-msg', id: 'pf-tg-msg', 'aria-live': 'polite' });

  const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, icon('check'), T('pf.save'));
  const cancelBtn = h('button', { class: 'btn ghost', type: 'button' }, T('common.cancel'));
  const closeBtn = h('button', { class: 'btn ghost small pf-x', type: 'button', 'aria-label': L('common.close') }, icon('close'));
  let lastError: unknown = null;
  const paintError = (): void => {
    error.textContent = lastError === null ? '' : typeof lastError === 'string' ? t('pf.fixFields') : (lastError as Error).message;
  };

  function renderAvatar(): void {
    const name = parseDisplayName(nameInput.value);
    const label = name.ok && name.value ? name.value : user.username;
    if (avatarPlan === 'new' && cropper) {
      replaceChildren(avatarBox, cropper.el);
      replaceChildren(
        avatarActions,
        h('p', { class: 'pf-crop-hint muted' }, t('pf.cropHint')),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => fileInput.click() }, icon('camera'), t('pf.anotherPhoto')),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => discardCrop() }, t('pf.undo')),
      );
      return;
    }
    const url = avatarPlan === 'remove' ? null : start.avatarUrl;
    replaceChildren(avatarBox, avatarEl(url, label, 'xl'));
    replaceChildren(
      avatarActions,
      h('button', { class: 'btn secondary small', type: 'button', onclick: () => fileInput.click() }, icon('camera'), url ? t('pf.changePhoto') : t('pf.uploadPhoto')),
      url ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => ((avatarPlan = 'remove'), renderAvatar()) }, icon('trash'), t('pf.remove')) : null,
      avatarPlan === 'remove' && start.avatarUrl ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => ((avatarPlan = 'keep'), renderAvatar()) }, t('pf.undo')) : null,
      h('p', { class: 'pf-crop-hint muted' }, t('pf.photoHint')),
    );
  }

  function discardCrop(): void {
    cropper?.destroy();
    cropper = null;
    avatarPlan = 'keep';
    renderAvatar();
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const img = await loadImageFile(file);
      cropper?.destroy();
      cropper = new AvatarCropper(img);
      avatarPlan = 'new';
      renderAvatar();
      avatarBox.querySelector<HTMLElement>('.crop-stage')?.focus({ preventScroll: true });
    } catch (err) {
      toast((err as Error).message, 'error', 3200);
    }
  });

  function validate(): boolean {
    const n = parseDisplayName(nameInput.value);
    const len = [...nameInput.value.trim()].length;
    nameCount.textContent = `${len}/${DISPLAY_NAME_MAX}`;
    nameCount.classList.toggle('over', len > DISPLAY_NAME_MAX);
    nameErr.textContent = n.ok ? (n.value ? '' : t('pf.nameEmpty', { username: user.username })) : errorText(n.error);
    nameErr.classList.toggle('bad', !n.ok);
    nameInput.setAttribute('aria-invalid', String(!n.ok));

    const b = parseBio(bioInput.value);
    const blen = [...bioInput.value.trim()].length;
    bioCount.textContent = `${blen}/${BIO_MAX}`;
    bioCount.classList.toggle('over', blen > BIO_MAX);
    bioErr.textContent = b.ok ? '' : errorText(b.error);
    bioErr.classList.toggle('bad', !b.ok);
    bioInput.setAttribute('aria-invalid', String(!b.ok));

    const tg = parseTelegram(tgInput.value);
    tgInput.setAttribute('aria-invalid', String(!tg.ok));
    tgMsg.classList.toggle('bad', !tg.ok);
    if (!tg.ok) replaceChildren(tgMsg, errorText(tg.error));
    else if (tg.value) replaceChildren(tgMsg, icon('check', 'ok-mark'), t('pf.opens'), ' ', h('a', { href: telegramUrl(tg.value), target: '_blank', rel: 'noopener noreferrer', class: 'tg-preview' }, `t.me/${tg.value}`, icon('external', 'tg-ext')));
    else replaceChildren(tgMsg, t('pf.tgOptional'));
    return n.ok && b.ok && tg.ok;
  }
  for (const el of [nameInput, bioInput, tgInput]) el.addEventListener('input', () => validate());
  nameInput.addEventListener('input', () => {
    if (avatarPlan !== 'new') renderAvatar();
  });

  async function save(): Promise<void> {
    if (busy) return;
    lastError = null;
    paintError();
    if (!validate()) {
      lastError = 'fix';
      paintError();
      return;
    }
    busy = true;
    saveBtn.disabled = true;
    saveBtn.classList.add('busy');
    try {
      let latest: MyProfile | null = null;
      if (avatarPlan === 'new' && cropper) {
        const blob = await cropper.export();
        latest = (await api<{ profile: MyProfile }>('POST', '/api/profile/avatar', blob)).profile;
      } else if (avatarPlan === 'remove') {
        latest = (await api<{ profile: MyProfile }>('DELETE', '/api/profile/avatar')).profile;
      }
      const n = parseDisplayName(nameInput.value);
      const b = parseBio(bioInput.value);
      const tg = parseTelegram(tgInput.value);
      const changes: Record<string, string | null> = {};
      if (n.ok && n.value !== start.displayName) changes.displayName = n.value;
      if (b.ok && b.value !== start.bio) changes.bio = b.value;
      if (tg.ok && tg.value !== start.telegram) changes.telegram = tg.value;
      if (Object.keys(changes).length) latest = (await api<{ profile: MyProfile }>('PATCH', '/api/profile', changes)).profile;
      if (latest) setMyProfile(latest, user);
      toast(latest ? t('pf.saved') : t('pf.nothing'), 'good', 2200, latest ? icon('check') : null);
      layer.close();
    } catch (err) {
      lastError = err;
      paintError();
    } finally {
      busy = false;
      saveBtn.disabled = false;
      saveBtn.classList.remove('busy');
    }
  }

  const form = h(
    'form',
    { class: 'pf-editor', novalidate: true },
    h(
      'header',
      { class: 'pf-editor-head' },
      h('div', null, h('p', { class: 'eyebrow' }, T('pf.dossier')), h('h2', { class: 'pf-editor-title display', id: 'pf-title' }, T('pf.yourProfile'))),
      closeBtn,
    ),
    h(
      'div',
      { class: 'pf-editor-body' },
      h('section', { class: 'pf-avatar-col', 'aria-label': L('pf.picture') }, avatarBox, avatarActions, fileInput, ratingBadges(start)),
      h(
        'div',
        { class: 'pf-fields' },
        h(
          'div',
          { class: 'pf-field' },
          h('div', { class: 'pf-label-row' }, h('label', { class: 'field-label', for: 'pf-name' }, T('pf.displayName')), nameCount),
          nameInput,
          nameErr,
          h('p', { class: 'pf-login-note' }, icon('lock'), h('span', null, h('strong', null, `@${user.username}`), ' ', T('pf.loginNote'))),
        ),
        h(
          'div',
          { class: 'pf-field' },
          h('div', { class: 'pf-label-row' }, h('label', { class: 'field-label', for: 'pf-bio' }, T('pf.about')), bioCount),
          bioInput,
          bioErr,
        ),
        h('div', { class: 'pf-field' }, h('label', { class: 'field-label', for: 'pf-tg' }, 'Telegram'), h('div', { class: 'pf-tg-input' }, icon('send'), tgInput), tgMsg),
      ),
    ),
    h('footer', { class: 'pf-editor-foot' }, error, h('div', { class: 'pf-editor-buttons' }, cancelBtn, saveBtn)),
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void save();
  });
  bioInput.setAttribute('aria-describedby', 'pf-bio-count');

  renderAvatar();
  validate();
  const offLang = onLang(() => {
    renderAvatar();
    validate();
    paintError();
  });
  const layer = openLayer({
    label: L('pf.yourProfile'),
    content: form,
    kind: 'modal',
    cls: 'pf-modal',
    initialFocus: nameInput,
    onClose: () => {
      offLang();
      editorOpen = false;
      cropper?.destroy();
    },
  });
  layer.panel.setAttribute('aria-labelledby', 'pf-title');
  layer.panel.removeAttribute('aria-label');
  closeBtn.addEventListener('click', () => layer.close());
  cancelBtn.addEventListener('click', () => layer.close());
}

// ------------------------------------------------------------------ first-run hint

/** Remembers (per browser) that this account was just created, for the hint on the home screen. */
export function markNewAccount(username: string): void {
  try {
    localStorage.setItem(HINT_KEY, username.toLowerCase());
  } catch {
    // no storage: no hint
  }
}

function dismissProfileHint(): void {
  try {
    localStorage.removeItem(HINT_KEY);
  } catch {
    // ignore
  }
}

/** A dismissible "Set up your profile" card, shown once after registration; null otherwise. */
export function profileHint(user: UserInfo): HTMLElement | null {
  let flagged = false;
  try {
    flagged = localStorage.getItem(HINT_KEY) === user.username.toLowerCase();
  } catch {
    return null;
  }
  const p = mine;
  if (!flagged || (p && (p.displayName || p.avatarUrl || p.bio || p.telegram))) return null;
  const card = h(
    'section',
    { class: 'card pf-hint', 'aria-label': L('pf.setUpTitle') },
    avatarEl(null, user.username, 'md'),
    h(
      'div',
      { class: 'pf-hint-text' },
      h('strong', null, T('pf.setUpTitle')),
      h('span', { class: 'muted' }, T('pf.setUpText')),
    ),
    h(
      'div',
      { class: 'pf-hint-actions' },
      h(
        'button',
        {
          class: 'btn secondary small',
          type: 'button',
          onclick: () => {
            card.remove();
            openProfileEditor(user);
          },
        },
        T('pf.setUp'),
      ),
      h(
        'button',
        {
          class: 'btn ghost small',
          type: 'button',
          'aria-label': L('pf.dismiss'),
          title: L('pf.notNow'),
          onclick: () => {
            dismissProfileHint();
            card.remove();
          },
        },
        icon('close'),
      ),
    ),
  );
  return card;
}
