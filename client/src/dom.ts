// Tiny DOM helpers. Text is always inserted as text nodes, never as HTML, so player
// nicknames can't inject markup.

import { bindAttr, LocalizedAttr } from './i18n.ts';

type Child = Node | string | number | null | undefined | false | Child[];
/** A LocalizedAttr (from `L()` in i18n.ts) keeps the attribute in the current language. */
type AttrValue = string | number | boolean | null | undefined | LocalizedAttr | ((ev: never) => void);
type Attrs = Record<string, AttrValue>;

function applyAttrs(el: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (value instanceof LocalizedAttr) {
      bindAttr(el, key, value.key, value.params);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function appendChildren(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

export function replaceChildren(el: Element, ...children: Child[]): void {
  el.textContent = '';
  appendChildren(el, children);
}

export function flagImg(code: string, cls = 'flag', ratio: '4x3' | '1x1' = '4x3'): HTMLImageElement {
  return h('img', { class: cls, src: `/flags/${ratio}/${code}.svg`, alt: '', loading: 'lazy', draggable: 'false' });
}

let toastHost: HTMLElement | null = null;
/** Phones: toasts sit under the top bar, compact, at most two at a time. */
const PHONE_TOASTS = typeof matchMedia === 'function' ? matchMedia('(max-width: 900px)') : null;

function dismissToast(el: HTMLElement, dir: 'up' | 'left' | 'right' | null = null): void {
  if (el.classList.contains('leaving')) return;
  if (dir) el.dataset.out = dir;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 250);
}

/** Tap a toast to dismiss it; swipe it sideways (or up, on phones) to throw it away. */
function bindToastGestures(el: HTMLElement): void {
  let start: { id: number; x: number; y: number } | null = null;
  let dx = 0;
  let dy = 0;
  el.addEventListener('pointerdown', (ev) => {
    start = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
    dx = dy = 0;
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      /* synthetic pointer */
    }
  });
  el.addEventListener('pointermove', (ev) => {
    if (!start || ev.pointerId !== start.id) return;
    dx = ev.clientX - start.x;
    dy = Math.min(0, ev.clientY - start.y);
    if (Math.hypot(dx, dy) < 6) return;
    el.classList.add('dragging');
    el.style.transform = Math.abs(dx) >= -dy ? `translateX(${dx}px)` : `translateY(${dy}px)`;
    el.style.opacity = String(Math.max(0.2, 1 - Math.max(Math.abs(dx) / 160, -dy / 60)));
  });
  const end = (ev: PointerEvent): void => {
    if (!start || ev.pointerId !== start.id) return;
    start = null;
    el.classList.remove('dragging');
    const moved = Math.hypot(dx, dy);
    if (ev.type === 'pointercancel' && moved < 6) {
      el.style.transform = '';
      el.style.opacity = '';
      return;
    }
    if (moved < 6) dismissToast(el);
    else if (Math.abs(dx) > 56) dismissToast(el, dx < 0 ? 'left' : 'right');
    else if (dy < -24) dismissToast(el, 'up');
    else {
      el.style.transform = '';
      el.style.opacity = '';
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

export function toast(message: string, kind: 'error' | 'info' | 'good' = 'info', ms = 2200, lead?: Node | null): void {
  toastHost ??= document.getElementById('toasts');
  if (!toastHost) return;
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('span', { class: 'toast-mark', 'aria-hidden': 'true' }, lead ?? null), h('span', { class: 'toast-text' }, message));
  bindToastGestures(el);
  toastHost.appendChild(el);
  const max = PHONE_TOASTS?.matches ? 2 : 4;
  const live = [...toastHost.children].filter((c) => !c.classList.contains('leaving')) as HTMLElement[];
  for (const old of live.slice(0, Math.max(0, live.length - max))) old.remove();
  setTimeout(() => dismissToast(el), ms);
}

/** Removes every toast at once (e.g. when the end screen opens). */
export function clearToasts(): void {
  toastHost ??= document.getElementById('toasts');
  for (const el of [...(toastHost?.children ?? [])]) dismissToast(el as HTMLElement);
}

// ---- transient layers: popovers, menus, sheets that must not outlive their screen ----

const transient = new Set<() => void>();

/** Registers a closer for an open popover/sheet; returns the unregister function. */
export function onCloseTransient(close: () => void): () => void {
  transient.add(close);
  return () => transient.delete(close);
}

/** Closes every open transient layer (screen change, game end). */
export function closeTransient(): void {
  for (const close of [...transient]) {
    transient.delete(close);
    try {
      close();
    } catch {
      /* a layer already gone */
    }
  }
}
