// Tiny DOM helpers. Text is always inserted as text nodes, never as HTML, so player
// nicknames can't inject markup.

type Child = Node | string | number | null | undefined | false | Child[];
type AttrValue = string | number | boolean | null | undefined | ((ev: never) => void);
type Attrs = Record<string, AttrValue>;

function applyAttrs(el: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
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

export function toast(message: string, kind: 'error' | 'info' | 'good' = 'info', ms = 2200, lead?: Node | null): void {
  toastHost ??= document.getElementById('toasts');
  if (!toastHost) return;
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('span', { class: 'toast-mark', 'aria-hidden': 'true' }, lead ?? null), h('span', { class: 'toast-text' }, message));
  toastHost.appendChild(el);
  while (toastHost.children.length > 4) toastHost.firstElementChild?.remove();
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  }, ms);
}
