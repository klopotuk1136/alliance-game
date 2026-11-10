// EN / RU toggle for the top bar (and the account menu). Switching re-renders text in
// place (see i18n.ts); every switch on the page follows the current language.

import { h } from './dom.ts';
import { L, lang, LANGS, onLang, setLang, t, type Lang } from './i18n.ts';

export function langSwitch(cls = ''): HTMLElement {
  const el = h('div', { class: `lang-switch ${cls}`.trim(), role: 'radiogroup', 'aria-label': L('lang.label') });
  const btns = new Map<Lang, HTMLButtonElement>();
  const paint = (): void => {
    for (const [l, b] of btns) {
      const on = l === lang();
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  LANGS.forEach((l, i) => {
    const b = h(
      'button',
      { class: 'lang-seg', type: 'button', role: 'radio', lang: l, title: l === 'en' ? 'English' : 'Русский', 'aria-label': l === 'en' ? 'English' : 'Русский' },
      t(l === 'en' ? 'lang.en' : 'lang.ru'),
    );
    b.addEventListener('click', () => setLang(l));
    b.addEventListener('keydown', (ev) => {
      const d = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      ev.preventDefault();
      const next = LANGS[(i + d + LANGS.length) % LANGS.length];
      setLang(next);
      btns.get(next)?.focus();
    });
    btns.set(l, b);
    el.appendChild(b);
  });
  paint();
  painters.set(el, paint);
  switches.add(new WeakRef(el));
  return el;
}

// Every switch repaints on a change (weakly held, so switches on screens that are gone are dropped).
const switches = new Set<WeakRef<HTMLElement>>();
const painters = new WeakMap<HTMLElement, () => void>();
onLang(() => {
  for (const ref of switches) {
    const el = ref.deref();
    if (el) painters.get(el)?.();
    else switches.delete(ref);
  }
});
