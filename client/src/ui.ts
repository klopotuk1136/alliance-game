// The control kit: custom select (optionally searchable), menu button, number stepper,
// segmented control, search field and a small inline icon set. Every control keeps a real
// form element or ARIA role underneath, dispatches bubbling `input` / `change` events on
// its root (so a surrounding <form> listener sees edits), and works with touch.

import { h, s } from './dom.ts';

// ------------------------------------------------------------------ icons

const ICONS: Record<string, string> = {
  hex: 'M12 2.5 20.2 7.25v9.5L12 21.5 3.8 16.75v-9.5Z',
  move: 'M5 12h12M13 6l6 6-6 6',
  attack: 'M5 5l9.5 9.5M19 5 9.5 14.5M4 17l3 3M17 20l3-3M8 16l-2 2M16 16l2 2',
  grant: 'M12 5v14M5 12h14',
  range: 'M12 3v3M12 18v3M3 12h3M18 12h3M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.5 15.5 20 20',
  close: 'M6 6l12 12M18 6 6 18',
  chevron: 'M6 9l6 6 6-6',
  check: 'M5 12.5l4.5 4.5L19 7',
  minus: 'M6 12h12',
  plus: 'M12 6v12M6 12h12',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  back: 'M15 6l-6 6 6 6',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  send: 'M4 12 20 4l-4 16-4-7Z M12 13l8-9',
  whisper: 'M4 6h16v10H9l-5 4Z',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.4c2 .8 3.5 2.8 3.5 5.6',
  log: 'M7 4h10v16H7zM10 8h4M10 12h4M10 16h2',
  chat: 'M4 5h16v11H10l-4 4v-4H4Z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  clock: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 7.5V12l3 2',
  crown: 'M4 18h16M5 15 4 7l5 4 3-6 3 6 5-4-1 8Z',
  heart: 'M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z',
  pause: 'M9 6v12M15 6v12',
  info: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 11v5M12 8v.5',
  alert: 'M12 4 21 19H3ZM12 10v4M12 16.5v.5',
  globe: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM3.5 12h17M12 3.5c2.4 2.4 3.4 5.3 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.3-3.4-8.5s1-6.1 3.4-8.5Z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5',
  camera: 'M4 8h3.5L9 5.5h6L16.5 8H20v11H4ZM12 10.5a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5Z',
  lock: 'M6.5 11h11v9h-11ZM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  trash: 'M5 7h14M9.5 7V4.5h5V7M7 7l1 13h8l1-13',
  seal: 'M12 3 14 5.2l3-.4.6 3 2.6 1.6-1.3 2.6 1.3 2.6-2.6 1.6-.6 3-3-.4L12 21l-2-2.2-3 .4-.6-3-2.6-1.6 1.3-2.6-1.3-2.6 2.6-1.6.6-3 3 .4Z',
};

/** A 24×24 stroke icon. Decorative unless a label is given. */
export function icon(name: keyof typeof ICONS | string, cls = ''): SVGSVGElement {
  return s(
    'svg',
    { class: `icon ${cls}`.trim(), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { d: ICONS[name] ?? ICONS.hex }),
  );
}

/** The game mark: a brass hexagon with a split (alliance / betrayal). */
export function logoMark(): SVGSVGElement {
  return s(
    'svg',
    { class: 'logo-mark', viewBox: '0 0 32 32', 'aria-hidden': 'true' },
    s('path', { class: 'lm-outer', d: 'M16 2.5 27.7 9.25v13.5L16 29.5 4.3 22.75V9.25Z' }),
    s('path', { class: 'lm-left', d: 'M16 8.5 9.5 12.25v7.5L16 23.5Z' }),
    s('path', { class: 'lm-right', d: 'M17.5 8.5 24 12.25v7.5L17.5 23.5Z' }),
  );
}

export function logo(small = false): HTMLElement {
  return h('div', { class: `logo ${small ? 'small' : ''}` }, logoMark(), h('span', { class: 'logo-word' }, 'Alliance'));
}

let uid = 0;
const nextId = (prefix: string): string => `${prefix}-${++uid}`;

function fire(el: Element, type: 'input' | 'change'): void {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

// ------------------------------------------------------------------ popover listbox

export interface ListOption<V extends string = string> {
  value: V;
  label: string;
  /** Extra text shown on the right (e.g. "in range", "UTC+1"). */
  hint?: string;
  /** Leading visual (flag, icon). Built fresh on each render. */
  lead?: () => Node;
  disabled?: boolean;
  /** Extra words matched by search and type-ahead. */
  keywords?: string;
}

interface ListboxOpts<V extends string> {
  anchor: HTMLElement;
  options: () => ListOption<V>[];
  selected: () => V | null;
  onPick: (v: V) => void;
  onClose: () => void;
  searchable: boolean;
  searchPlaceholder?: string;
  label: string;
  emptyText?: string;
  /** Minimum popover width; defaults to the anchor's width. */
  minWidth?: number;
}

const openPopovers = new Set<Listbox<string>>();

/** A floating listbox anchored to a control. Lives in <body>, positioned inside the viewport. */
class Listbox<V extends string> {
  readonly id = nextId('lb');
  readonly el: HTMLElement;
  readonly list: HTMLUListElement;
  readonly search: HTMLInputElement | null = null;
  private readonly o: ListboxOpts<V>;
  private shown: ListOption<V>[] = [];
  private active = -1;
  private typed = '';
  private typedAt = 0;
  private readonly onDocDown = (ev: PointerEvent): void => {
    const t = ev.target as Node;
    if (!this.el.contains(t) && !this.o.anchor.contains(t)) this.close();
  };
  private readonly onReflow = (ev: Event): void => {
    if (ev.type === 'scroll' && this.el.contains(ev.target as Node)) return;
    this.place();
  };

  constructor(o: ListboxOpts<V>) {
    this.o = o;
    this.list = h('ul', { class: 'lb-list', role: 'listbox', id: this.id, 'aria-label': o.label, tabindex: '-1' });
    const parts: HTMLElement[] = [];
    if (o.searchable) {
      this.search = h('input', {
        class: 'lb-search',
        type: 'text',
        placeholder: o.searchPlaceholder ?? 'Search…',
        autocomplete: 'off',
        spellcheck: 'false',
        role: 'combobox',
        'aria-expanded': 'true',
        'aria-controls': this.id,
        'aria-autocomplete': 'list',
        'aria-label': `Search ${o.label.toLowerCase()}`,
      });
      this.search.addEventListener('input', () => {
        this.render();
        this.setActive(this.shown.findIndex((x) => !x.disabled));
      });
      this.search.addEventListener('keydown', (ev) => this.key(ev));
      parts.push(h('div', { class: 'lb-search-wrap' }, icon('search'), this.search));
    }
    this.el = h('div', { class: 'popover lb' }, parts, this.list);
    this.list.addEventListener('pointermove', (ev) => {
      const li = (ev.target as Element).closest('li[data-i]');
      if (li) this.setActive(Number(li.getAttribute('data-i')), false);
    });
    this.list.addEventListener('click', (ev) => {
      const li = (ev.target as Element).closest('li[data-i]');
      if (li) this.pick(Number(li.getAttribute('data-i')));
    });
    // Keep focus on the trigger/search while clicking options.
    this.list.addEventListener('mousedown', (ev) => ev.preventDefault());
  }

  open(): void {
    for (const p of openPopovers) if (p !== (this as unknown as Listbox<string>)) p.close();
    openPopovers.add(this as unknown as Listbox<string>);
    document.body.appendChild(this.el);
    this.render();
    const sel = this.o.selected();
    const i = this.shown.findIndex((x) => x.value === sel);
    this.setActive(i >= 0 ? i : this.shown.findIndex((x) => !x.disabled));
    this.place();
    requestAnimationFrame(() => this.el.classList.add('in'));
    document.addEventListener('pointerdown', this.onDocDown, true);
    window.addEventListener('resize', this.onReflow);
    window.addEventListener('scroll', this.onReflow, true);
    if (this.search) {
      this.search.value = '';
      this.render();
      this.search.focus({ preventScroll: true });
    }
  }

  get isOpen(): boolean {
    return this.el.isConnected;
  }

  close(): void {
    if (!this.isOpen) return;
    openPopovers.delete(this as unknown as Listbox<string>);
    this.el.classList.remove('in');
    this.el.remove();
    document.removeEventListener('pointerdown', this.onDocDown, true);
    window.removeEventListener('resize', this.onReflow);
    window.removeEventListener('scroll', this.onReflow, true);
    this.o.onClose();
  }

  get activeId(): string {
    return this.active >= 0 ? `${this.id}-o${this.active}` : '';
  }

  private render(): void {
    const q = this.search?.value.trim().toLowerCase() ?? '';
    const all = this.o.options();
    this.shown = q ? all.filter((x) => `${x.label} ${x.keywords ?? ''} ${x.hint ?? ''}`.toLowerCase().includes(q)) : all;
    // Very long lists (time zones) render a capped slice; search narrows them.
    const slice = this.shown.slice(0, 300);
    const sel = this.o.selected();
    this.list.textContent = '';
    if (!slice.length) {
      this.list.appendChild(h('li', { class: 'lb-empty', role: 'presentation' }, this.o.emptyText ?? 'Nothing matches'));
      return;
    }
    slice.forEach((x, i) => {
      const isSel = x.value === sel;
      this.list.appendChild(
        h(
          'li',
          {
            id: `${this.id}-o${i}`,
            class: `lb-opt${isSel ? ' selected' : ''}`,
            role: 'option',
            'aria-selected': String(isSel),
            'aria-disabled': x.disabled ? 'true' : null,
            'data-i': i,
          },
          x.lead ? h('span', { class: 'lb-lead' }, x.lead()) : null,
          h('span', { class: 'lb-label' }, x.label),
          x.hint ? h('span', { class: 'lb-hint' }, x.hint) : null,
          isSel ? icon('check', 'lb-check') : null,
        ),
      );
    });
    if (this.shown.length > slice.length) {
      this.list.appendChild(h('li', { class: 'lb-empty', role: 'presentation' }, `${this.shown.length - slice.length} more… type to narrow`));
    }
  }

  private setActive(i: number, scroll = true): void {
    const items = this.list.querySelectorAll<HTMLElement>('li[data-i]');
    items.forEach((li) => li.classList.remove('active'));
    this.active = i >= 0 && i < items.length ? i : -1;
    const li = this.active >= 0 ? items[this.active] : null;
    li?.classList.add('active');
    if (li && scroll) li.scrollIntoView({ block: 'nearest' });
    const owner = this.search ?? this.o.anchor;
    if (this.activeId) owner.setAttribute('aria-activedescendant', this.activeId);
    else owner.removeAttribute('aria-activedescendant');
  }

  private move(delta: number): void {
    const n = Math.min(this.shown.length, 300);
    if (!n) return;
    let i = this.active;
    for (let step = 0; step < n; step++) {
      i = i < 0 ? (delta > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, i + delta));
      if (!this.shown[i]?.disabled) break;
      if ((delta > 0 && i === n - 1) || (delta < 0 && i === 0)) return;
    }
    this.setActive(i);
  }

  private pick(i: number): void {
    const x = this.shown[i];
    if (!x || x.disabled) return;
    this.o.onPick(x.value);
    this.close();
  }

  /** Shared keyboard handling for the trigger (when open) and the search box. */
  key(ev: KeyboardEvent): boolean {
    const n = Math.min(this.shown.length, 300);
    switch (ev.key) {
      case 'ArrowDown':
        this.move(1);
        break;
      case 'ArrowUp':
        this.move(-1);
        break;
      case 'PageDown':
        this.move(8);
        break;
      case 'PageUp':
        this.move(-8);
        break;
      case 'Home':
        if (this.search) return false;
        this.setActive(this.shown.findIndex((x) => !x.disabled));
        break;
      case 'End': {
        if (this.search) return false;
        let i = n - 1;
        while (i >= 0 && this.shown[i]?.disabled) i--;
        this.setActive(i);
        break;
      }
      case 'Enter':
        if (this.active >= 0) this.pick(this.active);
        break;
      case ' ':
        if (this.search) return false;
        if (this.active >= 0) this.pick(this.active);
        break;
      case 'Escape':
        this.close();
        this.o.anchor.focus();
        break;
      case 'Tab':
        this.close();
        return false;
      default:
        if (!this.search && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
          this.typeAhead(ev.key);
          break;
        }
        return false;
    }
    ev.preventDefault();
    ev.stopPropagation();
    return true;
  }

  typeAhead(ch: string): void {
    const now = Date.now();
    this.typed = now - this.typedAt > 700 ? ch.toLowerCase() : this.typed + ch.toLowerCase();
    this.typedAt = now;
    const n = Math.min(this.shown.length, 300);
    const start = this.typed.length === 1 ? this.active + 1 : this.active;
    for (let k = 0; k < n; k++) {
      const i = (Math.max(0, start) + k) % n;
      const x = this.shown[i];
      if (!x.disabled && x.label.toLowerCase().startsWith(this.typed)) {
        this.setActive(i);
        return;
      }
    }
  }

  /** Positions below the anchor (or above when there's no room), clamped to the viewport. */
  place(): void {
    if (!this.isOpen) return;
    const r = this.o.anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const gap = 6;
    const margin = 8;
    const width = Math.min(vw - margin * 2, Math.max(r.width, this.o.minWidth ?? 0));
    this.el.style.width = `${width}px`;
    const below = vh - r.bottom - gap - margin;
    const above = r.top - gap - margin;
    const natural = Math.min(340, this.el.scrollHeight || 340);
    const up = below < Math.min(natural, 200) && above > below;
    const maxH = Math.max(120, Math.min(340, up ? above : below));
    this.el.style.maxHeight = `${maxH}px`;
    let left = r.left;
    if (left + width > vw - margin) left = vw - margin - width;
    left = Math.max(margin, left);
    this.el.style.left = `${left}px`;
    if (up) {
      this.el.style.top = '';
      this.el.style.bottom = `${vh - r.top + gap}px`;
    } else {
      this.el.style.bottom = '';
      this.el.style.top = `${r.bottom + gap}px`;
    }
    this.el.classList.toggle('up', up);
  }
}

// ------------------------------------------------------------------ select

export interface SelectOpts<V extends string> {
  options: ListOption<V>[];
  value?: V;
  /** Accessible name. */
  label: string;
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  onChange?: (v: V) => void;
  cls?: string;
  minWidth?: number;
}

/**
 * A select: a button showing the current option plus a popover listbox.
 * `value` get/set like a native select; `onChange` and a bubbling `change` event on `el`.
 */
export class Select<V extends string = string> {
  readonly el: HTMLElement;
  readonly button: HTMLButtonElement;
  onChange: (v: V) => void;
  private opts: ListOption<V>[];
  private current: V | null;
  private readonly valueEl = h('span', { class: 'sel-value' });
  private readonly placeholder: string;
  private readonly lb: Listbox<V>;

  constructor(o: SelectOpts<V>) {
    this.opts = o.options;
    this.current = o.value ?? o.options[0]?.value ?? null;
    this.placeholder = o.placeholder ?? 'Choose…';
    this.onChange = o.onChange ?? (() => undefined);
    this.button = h(
      'button',
      {
        class: 'sel-trigger',
        type: 'button',
        role: 'combobox',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
        'aria-label': o.label,
      },
      this.valueEl,
      icon('chevron', 'sel-chevron'),
    );
    this.el = h('div', { class: `select ${o.cls ?? ''}`.trim() }, this.button);
    this.lb = new Listbox<V>({
      anchor: this.button,
      options: () => this.opts,
      selected: () => this.current,
      onPick: (v) => this.set(v, true),
      onClose: () => {
        this.button.setAttribute('aria-expanded', 'false');
        this.button.removeAttribute('aria-activedescendant');
        this.el.classList.remove('open');
      },
      searchable: !!o.searchable,
      searchPlaceholder: o.searchPlaceholder,
      label: o.label,
      minWidth: o.minWidth,
    });
    this.button.setAttribute('aria-controls', this.lb.id);
    this.button.addEventListener('click', () => (this.lb.isOpen ? this.lb.close() : this.open()));
    this.button.addEventListener('keydown', (ev) => {
      if (this.lb.isOpen) {
        this.lb.key(ev);
        return;
      }
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(ev.key)) {
        ev.preventDefault();
        this.open();
      } else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !o.searchable) {
        // Type-ahead on a closed select picks directly, like a native one.
        const ch = ev.key.toLowerCase();
        const start = this.opts.findIndex((x) => x.value === this.current);
        for (let k = 1; k <= this.opts.length; k++) {
          const x = this.opts[(start + k) % this.opts.length];
          if (!x.disabled && x.label.toLowerCase().startsWith(ch)) {
            this.set(x.value, true);
            break;
          }
        }
      }
    });
    this.paint();
  }

  private open(): void {
    if (this.button.disabled) return;
    this.el.classList.add('open');
    this.button.setAttribute('aria-expanded', 'true');
    this.lb.open();
  }

  get value(): V {
    return (this.current ?? '') as V;
  }

  set value(v: V) {
    this.set(v, false);
  }

  get disabled(): boolean {
    return this.button.disabled;
  }

  set disabled(d: boolean) {
    this.button.disabled = d;
    if (d) this.lb.close();
  }

  setOptions(options: ListOption<V>[]): void {
    this.opts = options;
    this.paint();
  }

  private set(v: V, user: boolean): void {
    const changed = v !== this.current;
    this.current = v;
    this.paint();
    if (user && changed) {
      this.onChange(v);
      fire(this.el, 'change');
    }
  }

  private paint(): void {
    const x = this.opts.find((o) => o.value === this.current);
    this.valueEl.textContent = '';
    if (x?.lead) this.valueEl.appendChild(h('span', { class: 'lb-lead' }, x.lead()));
    this.valueEl.appendChild(h('span', { class: x ? 'sel-text' : 'sel-text placeholder' }, x?.label ?? this.placeholder));
  }
}

// ------------------------------------------------------------------ menu button

export interface MenuOpts<V extends string> {
  /** Content of the trigger button. */
  trigger: Array<Node | string>;
  label: string;
  options: () => ListOption<V>[];
  onPick: (v: V) => void;
  cls?: string;
  searchable?: boolean;
  emptyText?: string;
  minWidth?: number;
  title?: string;
}

/** A button that opens a listbox of choices and fires `onPick` (no persistent value). */
export class MenuButton<V extends string = string> {
  readonly el: HTMLButtonElement;
  private readonly lb: Listbox<V>;

  constructor(o: MenuOpts<V>) {
    this.el = h(
      'button',
      { class: `btn menu-btn ${o.cls ?? ''}`.trim(), type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', title: o.title ?? null },
      o.trigger,
    );
    this.lb = new Listbox<V>({
      anchor: this.el,
      options: o.options,
      selected: () => null,
      onPick: (v) => o.onPick(v),
      onClose: () => {
        this.el.setAttribute('aria-expanded', 'false');
        this.el.removeAttribute('aria-activedescendant');
      },
      searchable: !!o.searchable,
      label: o.label,
      emptyText: o.emptyText,
      minWidth: o.minWidth ?? 220,
    });
    this.el.setAttribute('aria-controls', this.lb.id);
    this.el.addEventListener('click', () => {
      if (this.lb.isOpen) this.lb.close();
      else this.open();
    });
    this.el.addEventListener('keydown', (ev) => {
      if (this.lb.isOpen) this.lb.key(ev);
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        this.open();
      }
    });
  }

  private open(): void {
    if (this.el.disabled) return;
    this.el.setAttribute('aria-expanded', 'true');
    this.lb.open();
  }

  set disabled(d: boolean) {
    this.el.disabled = d;
    if (d) this.lb.close();
  }
}

// ------------------------------------------------------------------ stepper

export interface StepperOpts {
  min?: number;
  max?: number;
  step?: number;
  /** Accepts fractions (duration fields); buttons still step by `step`. */
  decimal?: boolean;
  label?: string;
}

/** A number input with −/+ buttons. `input` is a real <input type="number"> (spinners hidden). */
export class Stepper {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly dec: HTMLButtonElement;
  private readonly inc: HTMLButtonElement;
  private readonly o: StepperOpts;

  constructor(o: StepperOpts = {}) {
    this.o = o;
    this.input = h('input', {
      class: 'stepper-input',
      type: 'number',
      min: o.min ?? null,
      max: o.max ?? null,
      step: o.decimal ? 'any' : (o.step ?? 1),
      inputmode: o.decimal ? 'decimal' : 'numeric',
      required: true,
      'aria-label': o.label ?? null,
    });
    this.dec = h('button', { class: 'stepper-btn', type: 'button', tabindex: '-1', 'aria-label': 'Decrease' }, icon('minus'));
    this.inc = h('button', { class: 'stepper-btn', type: 'button', tabindex: '-1', 'aria-label': 'Increase' }, icon('plus'));
    this.el = h('div', { class: 'stepper' }, this.dec, this.input, this.inc);
    this.hold(this.dec, -1);
    this.hold(this.inc, 1);
    this.input.addEventListener('input', () => this.sync());
    this.input.addEventListener('change', () => this.sync());
    // Wheel over a focused number field shouldn't silently change it.
    this.input.addEventListener('wheel', () => this.input.blur(), { passive: true });
  }

  get value(): string {
    return this.input.value;
  }

  set value(v: string) {
    this.input.value = v;
    this.sync();
  }

  set disabled(d: boolean) {
    this.input.disabled = d;
    this.sync();
  }

  bump(dir: number): void {
    const step = this.o.step ?? 1;
    const cur = Number(this.input.value);
    let next = Number.isFinite(cur) && this.input.value.trim() !== '' ? cur + dir * step : (this.o.min ?? 0);
    // Snap fractional values to the step grid first.
    if (!Number.isInteger(next / step)) next = dir > 0 ? Math.ceil(cur / step) * step : Math.floor(cur / step) * step;
    if (this.o.min !== undefined) next = Math.max(this.o.min, next);
    if (this.o.max !== undefined) next = Math.min(this.o.max, next);
    if (String(next) === this.input.value) return;
    this.input.value = String(next);
    this.sync();
    fire(this.input, 'input');
    fire(this.input, 'change');
  }

  private hold(btn: HTMLButtonElement, dir: number): void {
    let t = 0;
    const stop = (): void => {
      clearTimeout(t);
      t = 0;
    };
    btn.addEventListener('pointerdown', (ev) => {
      if (btn.disabled || ev.button !== 0) return;
      ev.preventDefault();
      this.bump(dir);
      const repeat = (delay: number): void => {
        t = window.setTimeout(() => {
          this.bump(dir);
          repeat(Math.max(40, delay * 0.8));
        }, delay);
      };
      repeat(420);
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
    // Keyboard / assistive tech "click" (pointer clicks are handled on pointerdown).
    btn.addEventListener('click', (ev) => {
      if (ev.detail === 0) this.bump(dir);
    });
  }

  private sync(): void {
    const v = Number(this.input.value);
    const off = this.input.disabled;
    this.dec.disabled = off || (this.o.min !== undefined && Number.isFinite(v) && v <= this.o.min);
    this.inc.disabled = off || (this.o.max !== undefined && Number.isFinite(v) && v >= this.o.max);
  }
}

// ------------------------------------------------------------------ segmented control

export interface SegOpts<V extends string> {
  options: Array<{ value: V; label: string; title?: string }>;
  value?: V;
  label: string;
  onChange?: (v: V) => void;
  cls?: string;
}

/** A radiogroup of a few options. Arrow keys move and select, like native radios. */
export class Segmented<V extends string = string> {
  readonly el: HTMLElement;
  onChange: (v: V) => void;
  private current: V;
  private readonly btns = new Map<V, HTMLButtonElement>();

  constructor(o: SegOpts<V>) {
    this.current = o.value ?? o.options[0].value;
    this.onChange = o.onChange ?? (() => undefined);
    this.el = h('div', { class: `segmented ${o.cls ?? ''}`.trim(), role: 'radiogroup', 'aria-label': o.label });
    o.options.forEach((x, i) => {
      const b = h('button', { class: 'seg', type: 'button', role: 'radio', title: x.title ?? null }, x.label);
      b.addEventListener('click', () => this.set(x.value, true));
      b.addEventListener('keydown', (ev) => {
        const d = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        ev.preventDefault();
        const next = o.options[(i + d + o.options.length) % o.options.length];
        this.set(next.value, true);
        this.btns.get(next.value)?.focus();
      });
      this.btns.set(x.value, b);
      this.el.appendChild(b);
    });
    this.paint();
  }

  get value(): V {
    return this.current;
  }

  set value(v: V) {
    this.set(v, false);
  }

  private set(v: V, user: boolean): void {
    const changed = v !== this.current;
    this.current = v;
    this.paint();
    if (user && changed) {
      this.onChange(v);
      fire(this.el, 'change');
    }
  }

  private paint(): void {
    for (const [v, b] of this.btns) {
      const on = v === this.current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
}

// ------------------------------------------------------------------ search field

/** A search input with a leading icon and a clear button. */
export function searchField(placeholder: string, label = placeholder): { el: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { class: 'search-input', type: 'search', placeholder, autocomplete: 'off', spellcheck: 'false', 'aria-label': label });
  const clear = h('button', { class: 'search-clear', type: 'button', 'aria-label': 'Clear search', hidden: true }, icon('close'));
  const sync = (): void => {
    clear.hidden = input.value === '';
  };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && input.value) {
      ev.stopPropagation();
      input.value = '';
      sync();
      fire(input, 'input');
    }
  });
  clear.addEventListener('click', () => {
    input.value = '';
    sync();
    fire(input, 'input');
    input.focus();
  });
  return { el: h('div', { class: 'search-field' }, icon('search', 'search-icon'), input, clear), input };
}

/** An empty state: a faint hex cluster, a title and a line of help. */
export function emptyState(title: string, text?: string, cls = ''): HTMLElement {
  const hexAt = (x: number, y: number, cl: string) =>
    s('path', { class: cl, d: `M${x} ${y - 10} ${x + 8.66} ${y - 5} ${x + 8.66} ${y + 5} ${x} ${y + 10} ${x - 8.66} ${y + 5} ${x - 8.66} ${y - 5}Z` });
  const art = s(
    'svg',
    { class: 'empty-art', viewBox: '0 0 64 48', 'aria-hidden': 'true' },
    hexAt(22, 16, 'e1'),
    hexAt(39.32, 16, 'e2'),
    hexAt(30.66, 31, 'e3'),
  );
  return h('div', { class: `empty-state ${cls}`.trim() }, art, h('p', { class: 'empty-title' }, title), text ? h('p', { class: 'empty-text' }, text) : null);
}
