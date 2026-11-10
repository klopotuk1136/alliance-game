// Tiny typed i18n: EN + RU dictionaries (client/src/locales), `t(key, params)`,
// Russian plurals via Intl.PluralRules, dates/times via Intl in the current language.
//
// Switching the language never rebuilds a screen: text made with `T()` / `L()` updates
// in place, and views that render text from state subscribe with `onLang()` and re-render
// their text (the 3D board, inputs and open panels are left alone).

import { en, type Key, type Msg } from './locales/en.ts';
import { ru } from './locales/ru.ts';

export type { Key } from './locales/en.ts';
export type Lang = 'en' | 'ru';
export type Params = Record<string, string | number>;

export const LANGS: Lang[] = ['en', 'ru'];
const DICTS: Record<Lang, Record<Key, Msg>> = { en, ru };
const STORE_KEY = 'alliance.lang';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === 'en' || saved === 'ru') return saved;
  } catch {
    /* storage blocked */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.languages?.[0] ?? navigator.language ?? '' : '';
  return nav.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

let current: Lang = initialLang();
const plural: Record<Lang, Intl.PluralRules> = { en: new Intl.PluralRules('en'), ru: new Intl.PluralRules('ru') };

export function lang(): Lang {
  return current;
}

/** BCP 47 tag for Intl formatters. */
export function locale(): string {
  return current === 'ru' ? 'ru-RU' : 'en-GB';
}

function fill(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Translate `key`. A plural message picks its form from `params.n`. */
export function t(key: Key, params?: Params): string {
  const msg = DICTS[current][key] ?? DICTS.en[key] ?? key;
  if (typeof msg === 'string') return fill(msg, params);
  const n = Number(params?.n ?? 0);
  const form = plural[current].select(n) as keyof typeof msg;
  return fill(msg[form] ?? msg.other, params);
}

/** True when `key` exists in the dictionary (for keys built from data, e.g. `phase.${x}`). */
export function has(key: string): key is Key {
  return Object.prototype.hasOwnProperty.call(en, key);
}

// ---- live text --------------------------------------------------------------------------

interface Live {
  ref: WeakRef<Node>;
  apply(node: Node): void;
}
const live = new Set<Live>();
let sinceSweep = 0;

function track(node: Node, apply: (node: Node) => void): void {
  apply(node);
  live.add({ ref: new WeakRef(node), apply });
  if (++sinceSweep > 400) {
    sinceSweep = 0;
    for (const l of live) if (!l.ref.deref()) live.delete(l);
  }
}

/** A text node that follows the language. `params` may be a function for values read at render time. */
export function T(key: Key, params?: Params | (() => Params)): Text {
  const node = document.createTextNode('');
  track(node, (n) => {
    n.textContent = t(key, typeof params === 'function' ? params() : params);
  });
  return node;
}

/** Sets `el`'s text to `key` and keeps it in sync with the language. */
export function bindText<E extends Element>(el: E, key: Key, params?: Params | (() => Params)): E {
  track(el, (n) => {
    n.textContent = t(key, typeof params === 'function' ? params() : params);
  });
  return el;
}

/** Keeps an attribute (title, aria-label, placeholder…) in sync with the language. */
export function bindAttr<E extends Element>(el: E, attr: string, key: Key, params?: Params | (() => Params)): E {
  track(el, (n) => {
    (n as Element).setAttribute(attr, t(key, typeof params === 'function' ? params() : params));
  });
  return el;
}

/** Marker for `h()` attributes: `h('button', { title: L('game.close') })`. */
export class LocalizedAttr {
  constructor(
    readonly key: Key,
    readonly params?: Params | (() => Params),
  ) {}
}
export function L(key: Key, params?: Params | (() => Params)): LocalizedAttr {
  return new LocalizedAttr(key, params);
}

// ---- switching --------------------------------------------------------------------------

const listeners = new Set<(l: Lang) => void>();

/** Called after every language switch; returns an unsubscribe function. */
export function onLang(fn: (l: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let titleKey: Key = 'app.title';
let titleParams: Params | undefined;
/** Unseen alerts while the tab was hidden: "(3) Alliance" (notify.ts). */
let titleBadge = 0;

function titleText(): string {
  const base = t(titleKey, titleParams);
  return titleBadge > 0 ? `(${titleBadge > 99 ? '99+' : titleBadge}) ${base}` : base;
}

/** document.title that follows the language. */
export function setTitle(key: Key, params?: Params): void {
  titleKey = key;
  titleParams = params;
  document.title = titleText();
}

/** The "(n)" in front of the tab title; 0 removes it. */
export function setTitleBadge(n: number): void {
  titleBadge = Math.max(0, n);
  document.title = titleText();
}

function applyDocument(): void {
  document.documentElement.lang = current;
  document.title = titleText();
}

export function setLang(l: Lang): void {
  if (l === current) return;
  current = l;
  try {
    localStorage.setItem(STORE_KEY, l);
  } catch {
    /* storage blocked */
  }
  applyDocument();
  for (const item of live) {
    const node = item.ref.deref();
    if (node) item.apply(node);
    else live.delete(item);
  }
  for (const fn of listeners) {
    try {
      fn(l);
    } catch (err) {
      console.error(err);
    }
  }
}

if (typeof document !== 'undefined') applyDocument();

// ---- formatting -------------------------------------------------------------------------

export function fmtNumber(n: number): string {
  return new Intl.NumberFormat(locale()).format(n);
}

/** "12 Mar" / "12 мар." */
export function fmtDate(ts: number, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }): string {
  return new Intl.DateTimeFormat(locale(), opts).format(new Date(ts));
}

/** "12 March 2026" / "12 марта 2026 г." */
export function fmtLongDate(ts: number): string {
  return fmtDate(ts, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** "14:05" (24h in both languages). */
export function fmtTime(ts: number, seconds = false): string {
  return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined, hourCycle: 'h23' }).format(new Date(ts));
}

/** "5 minutes ago", "in 2 hours" / "5 минут назад", "через 2 часа". */
export function fmtRelative(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 86_400_000],
    ['month', 30 * 86_400_000],
    ['week', 7 * 86_400_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  return rtf.format(Math.round(diff / 1000), 'second');
}

/** "3 days", "1 hour 30 minutes" / "3 дня", "1 час 30 минут" — a whole-unit duration. */
export function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const parts: string[] = [];
  if (d) parts.push(t('unit.days', { n: d }));
  if (hh) parts.push(t('unit.hours', { n: hh }));
  if (mm) parts.push(t('unit.minutes', { n: mm }));
  if (ss || !parts.length) parts.push(t('unit.seconds', { n: ss }));
  return parts.join(' ');
}

/** "Alice, Bob and Carol" / "Алиса, Боб и Кэрол". */
export function fmtList(items: string[]): string {
  return new Intl.ListFormat(locale(), { style: 'long', type: 'conjunction' }).format(items);
}

// ---- countries --------------------------------------------------------------------------

const regionNames = new Map<Lang, Intl.DisplayNames | null>();

function displayNames(l: Lang): Intl.DisplayNames | null {
  if (!regionNames.has(l)) {
    try {
      regionNames.set(l, new Intl.DisplayNames([l], { type: 'region', fallback: 'none' }));
    } catch {
      regionNames.set(l, null);
    }
  }
  return regionNames.get(l) ?? null;
}

/** Flags that are regions, not ISO countries (Intl has no names for them). */
const REGIONS_RU: Record<string, string> = {
  'sh-ac': 'Остров Вознесения',
  'sh-hl': 'Остров Святой Елены',
  'sh-ta': 'Тристан-да-Кунья',
  'es-pv': 'Страна Басков',
  'es-ct': 'Каталония',
  'es-ga': 'Галисия',
  'gb-eng': 'Англия',
  'gb-sct': 'Шотландия',
  'gb-wls': 'Уэльс',
  'gb-nir': 'Северная Ирландия',
};

/** Country name in a language: Intl by ISO code where it knows one, else the server's English name. */
export function countryNameIn(l: Lang, code: string, fallback: string): string {
  if (l === 'en') return fallback;
  if (REGIONS_RU[code]) return REGIONS_RU[code];
  if (!/^[a-z]{2}$/i.test(code)) return fallback;
  try {
    return displayNames(l)?.of(code.toUpperCase()) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Country name in the current language. */
export function countryName(code: string, fallback: string): string {
  return countryNameIn(current, code, fallback);
}
