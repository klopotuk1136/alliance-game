// The board's action menu: right-click a cell (desktop) or long-press it (touch) and the
// four actions appear at the pointer — icon, label, current cost, key hint, and for an
// item that can't run now a short reason. Picking runs the caller's onPick (the same code
// path as the action buttons and keys 1–4). Esc, a click outside, Tab or scrolling the
// page close it. Hovering / arrowing to an item asks the board for a cheap preview.
// On phones (touch, ≤900 px) it is a bottom sheet over the action bar instead: big rows,
// the cell as its title; a tap outside, Esc or a swipe down closes it.
// Styled like the «Штаб» popovers in ui.ts (.popover); CSS lives in the `input` block.

import type { Hex } from '../../shared/hex.ts';
import { h, onCloseTransient } from './dom.ts';
import { t } from './i18n.ts';
import type { BoardAction } from './map-types.ts';
import { icon } from './ui.ts';

/** One row of the menu; the RULES side's getActionMenu() returns exactly this shape. */
export interface ActionMenuItem {
  kind: BoardAction;
  label: string;
  cost: number;
  enabled: boolean;
  reason?: string;
}

const META: Record<BoardAction, { icon: string; key: string }> = {
  move: { icon: 'move', key: '1' },
  attack: { icon: 'attack', key: '2' },
  grant: { icon: 'grant', key: '3' },
  upgrade: { icon: 'range', key: '4' },
  charge: { icon: 'bolt', key: '5' },
};

const KEY_KIND: Record<string, BoardAction> = {
  Digit1: 'move',
  Digit2: 'attack',
  Digit3: 'grant',
  Digit4: 'upgrade',
  Numpad1: 'move',
  Numpad2: 'attack',
  Numpad3: 'grant',
  Numpad4: 'upgrade',
  Digit5: 'charge',
  Numpad5: 'charge',
};

export interface ActionMenuOpts {
  x: number;
  y: number;
  touch: boolean;
  cell: Hex;
  /** The header line describing the cell (flag + name, distance…). */
  title: Array<Node | string>;
  items: ActionMenuItem[];
  onPick: (kind: BoardAction, cell: Hex) => void;
  onPreview: (kind: BoardAction | null, cell: Hex) => void;
}

export class ActionMenu {
  private el: HTMLElement | null = null;
  private o: ActionMenuOpts | null = null;
  private buttons: HTMLButtonElement[] = [];
  private active = -1;
  private swallowTimer = 0;
  private sheet = false;
  private offTransient: (() => void) | null = null;
  private drag: { id: number; y0: number; dy: number } | null = null;
  private swallowSheetClick = false;

  get isOpen(): boolean {
    return !!this.el;
  }

  get cell(): Hex | null {
    return this.o?.cell ?? null;
  }

  open(o: ActionMenuOpts): void {
    this.close();
    this.o = o;
    this.sheet = o.touch && matchMedia('(max-width: 900px)').matches;
    const el = h('div', { class: `popover am${o.touch ? ' touch' : ''}${this.sheet ? ' sheet' : ''}`, role: 'menu', 'aria-label': t('board.menuLabel'), tabindex: '-1' });
    this.el = el;
    el.addEventListener('pointerleave', () => this.previewAt(-1));
    el.addEventListener('contextmenu', (ev) => ev.preventDefault());
    if (this.sheet) this.bindSwipe(el);
    this.render(o.title, o.items);
    document.body.appendChild(el);
    document.body.classList.add('am-open');
    document.body.classList.toggle('am-sheet-open', this.sheet);
    this.offTransient = onCloseTransient(() => this.close());
    this.place();
    requestAnimationFrame(() => el.classList.add('in'));
    document.addEventListener('pointerdown', this.onDocDown, true);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('scroll', this.onScroll, true);
    // keyboard / screen-reader users land on the first runnable action; touch keeps no focus ring
    const first = o.items.findIndex((x) => x.enabled);
    if (!o.touch) this.setActive(first >= 0 ? first : 0, true);
  }

  /** Re-renders the rows in place (AP changed, a player moved…), keeping the position. */
  update(title: Array<Node | string>, items: ActionMenuItem[]): void {
    if (!this.el || !this.o) return;
    this.o.items = items;
    this.o.title = title;
    const kind = this.o.items[this.active]?.kind;
    this.render(title, items);
    if (kind) this.setActive(items.findIndex((x) => x.kind === kind), document.activeElement?.closest('.am') === this.el);
  }

  close(): void {
    const el = this.el;
    const o = this.o;
    if (!el || !o) return;
    this.el = null;
    this.o = null;
    this.buttons = [];
    this.active = -1;
    document.removeEventListener('pointerdown', this.onDocDown, true);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('scroll', this.onScroll, true);
    document.body.classList.remove('am-open', 'am-sheet-open');
    this.offTransient?.();
    this.offTransient = null;
    this.drag = null;
    el.style.transform = '';
    const hadFocus = el.contains(document.activeElement);
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 120);
    if (hadFocus) (document.activeElement as HTMLElement | null)?.blur();
    o.onPreview(null, o.cell);
  }

  // ---------------------------------------------------------------- internals

  private render(title: Array<Node | string>, items: ActionMenuItem[]): void {
    const el = this.el!;
    el.textContent = '';
    el.setAttribute('aria-label', t('board.menuLabel'));
    this.buttons = items.map((it, i) => {
      const m = META[it.kind];
      const b = h(
        'button',
        {
          type: 'button',
          class: `am-item am-${it.kind}${it.enabled ? '' : ' off'}`,
          role: 'menuitem',
          tabindex: '-1',
          'aria-disabled': it.enabled ? null : 'true',
          'aria-keyshortcuts': m.key,
        },
        h('span', { class: 'am-icon' }, icon(m.icon)),
        h('span', { class: 'am-text' }, h('span', { class: 'am-label' }, it.label), it.reason && !it.enabled ? h('span', { class: 'am-reason' }, it.reason) : null),
        h('span', { class: 'am-cost' }, t('unit.ap', { n: it.cost })),
        h('kbd', { class: 'kbd' }, m.key),
      );
      b.addEventListener('pointerenter', () => this.setActive(i, false));
      b.addEventListener('click', () => this.pick(i));
      return b;
    });
    if (this.sheet) el.append(h('div', { class: 'am-grab', 'aria-hidden': 'true' }));
    el.append(h('div', { class: 'am-head' }, title), h('div', { class: 'am-list' }, this.buttons));
  }

  /** Phone sheet: drag it down to close (the rows stay tappable; a drag swallows its click). */
  private bindSwipe(el: HTMLElement): void {
    el.addEventListener('pointerdown', (ev) => {
      this.swallowSheetClick = false;
      if (ev.pointerType === 'mouse') return;
      this.drag = { id: ev.pointerId, y0: ev.clientY, dy: 0 };
    });
    el.addEventListener('pointermove', (ev) => {
      const d = this.drag;
      if (!d || d.id !== ev.pointerId) return;
      d.dy = Math.max(0, ev.clientY - d.y0);
      if (d.dy < 8) return;
      el.classList.add('dragging');
      el.style.transform = `translateY(${d.dy}px)`;
    });
    const end = (ev: PointerEvent): void => {
      const d = this.drag;
      if (!d || d.id !== ev.pointerId) return;
      this.drag = null;
      el.classList.remove('dragging');
      if (d.dy >= 8) this.swallowSheetClick = true;
      if (d.dy > Math.min(90, el.offsetHeight * 0.3)) {
        this.close();
        return;
      }
      el.style.transform = '';
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener(
      'click',
      (ev) => {
        if (!this.swallowSheetClick) return;
        this.swallowSheetClick = false;
        ev.stopPropagation();
        ev.preventDefault();
      },
      true,
    );
  }

  private place(): void {
    const el = this.el;
    const o = this.o;
    if (!el || !o) return;
    if (this.sheet) {
      // a bottom sheet: CSS pins it to the bottom edge (over the action bar)
      el.style.left = '';
      el.style.top = '';
      return;
    }
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const m = 8;
    const w = el.offsetWidth;
    const ht = el.offsetHeight;
    let left: number;
    let top: number;
    if (o.touch) {
      // above the finger so it doesn't hide the menu; below when there's no room
      left = o.x - w / 2;
      top = o.y - ht - 30;
      if (top < m) top = o.y + 30;
      el.classList.toggle('below', top > o.y);
    } else {
      left = o.x + 4;
      top = o.y + 4;
      if (left + w > vw - m) left = o.x - w - 4;
      if (top + ht > vh - m) top = o.y - ht - 4;
    }
    left = Math.max(m, Math.min(vw - m - w, left));
    top = Math.max(m, Math.min(vh - m - ht, top));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.transformOrigin = `${Math.round(o.x - left)}px ${Math.round(o.y - top)}px`;
  }

  private setActive(i: number, focus: boolean): void {
    this.buttons.forEach((b, k) => b.classList.toggle('active', k === i));
    this.active = i;
    if (focus && i >= 0) this.buttons[i]?.focus({ preventScroll: true });
    this.previewAt(i);
  }

  private previewAt(i: number): void {
    const o = this.o;
    if (!o) return;
    const it = o.items[i];
    o.onPreview(it && it.enabled ? it.kind : null, o.cell);
  }

  private pick(i: number): void {
    const o = this.o;
    const it = o?.items[i];
    if (!o || !it) return;
    if (!it.enabled) {
      const b = this.buttons[i];
      b.classList.remove('nope');
      void b.offsetWidth;
      b.classList.add('nope');
      return;
    }
    const cell = o.cell;
    this.close();
    o.onPick(it.kind, cell);
  }

  private move(d: number): void {
    const items = this.o?.items ?? [];
    const n = items.length;
    if (!n) return;
    let i = this.active;
    for (let k = 0; k < n; k++) {
      i = (i + d + n) % n;
      if (items[i].enabled) break;
    }
    this.setActive(i, true);
  }

  private readonly onKey = (ev: KeyboardEvent): void => {
    if (!this.o) return;
    const kind = KEY_KIND[ev.code];
    let handled = true;
    if (ev.key === 'Escape') this.close();
    else if (ev.key === 'ArrowDown') this.move(1);
    else if (ev.key === 'ArrowUp') this.move(-1);
    else if (ev.key === 'Home') this.setActive(0, true);
    else if (ev.key === 'End') this.setActive(this.buttons.length - 1, true);
    else if ((ev.key === 'Enter' || ev.key === ' ') && this.active >= 0) this.pick(this.active);
    else if (kind && !ev.ctrlKey && !ev.metaKey && !ev.altKey) this.pick(this.o.items.findIndex((x) => x.kind === kind));
    else if (ev.key === 'Tab') {
      this.close();
      handled = false;
    } else handled = false;
    if (handled) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };

  private readonly onDocDown = (ev: PointerEvent): void => {
    if (!this.el || this.el.contains(ev.target as Node)) return;
    this.close();
    // A press on the board only dismisses the menu (no select / orbit), like a native menu —
    // except a right-click, which goes on to open the menu for the new cell.
    const onBoard = (ev.target as Element | null)?.closest?.('.board-host');
    if (onBoard && ev.button !== 2) {
      ev.stopPropagation();
      ev.preventDefault();
      const swallow = (e: Event): void => {
        e.stopPropagation();
        e.preventDefault();
      };
      document.addEventListener('click', swallow, { capture: true, once: true });
      clearTimeout(this.swallowTimer);
      this.swallowTimer = window.setTimeout(() => document.removeEventListener('click', swallow, true), 600);
    }
  };

  private readonly onResize = (): void => this.place();

  private readonly onScroll = (ev: Event): void => {
    if (this.el && !this.el.contains(ev.target as Node)) this.close();
  };
}
