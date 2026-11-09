// Chat stickers: the catalog from GET /api/stickers, the picker (a popover next to the
// chat input on desktop, a bottom sheet on phones) and the recently used list.

import type { StickerInfo, StickerPack, StickersResponse } from '../../shared/protocol.ts';
import { api } from './api.ts';
import { h, replaceChildren, s } from './dom.ts';

// ---------------------------------------------------------------- catalog

let packs: StickerPack[] = [];
const byId = new Map<string, StickerInfo>();
let loadedAt = 0;
let loaded = false;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Fetches the catalog (again if it is older than `maxAgeMs`, so new files show up). */
export function loadStickers(maxAgeMs = 30_000): Promise<void> {
  if (pending) return pending;
  if (loaded && Date.now() - loadedAt < maxAgeMs) return Promise.resolve();
  pending = api<StickersResponse>('GET', '/api/stickers')
    .then((res) => {
      const before = JSON.stringify(packs);
      packs = Array.isArray(res.packs) ? res.packs : [];
      byId.clear();
      for (const p of packs) for (const st of p.stickers) byId.set(st.id, st);
      loaded = true;
      loadedAt = Date.now();
      if (JSON.stringify(packs) !== before) for (const fn of listeners) fn();
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function onStickersChange(fn: () => void): void {
  listeners.add(fn);
}

export function stickersLoaded(): boolean {
  return loaded;
}

export function hasStickers(): boolean {
  return byId.size > 0;
}

export function stickerById(id: string): StickerInfo | undefined {
  return byId.get(id);
}

/** Display name for a sticker id, even one that has been removed from the server since. */
export function stickerName(id: string): string {
  const known = byId.get(id);
  if (known) return known.name;
  const file = id.split('/').pop() ?? id;
  return file.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || 'sticker';
}

/** URL of a sticker: the versioned one from the catalog, or the plain path while it loads. */
export function stickerUrl(id: string): string {
  return byId.get(id)?.url ?? `/stickers/${id.split('/').map(encodeURIComponent).join('/')}`;
}

// ---------------------------------------------------------------- recent

const RECENT_KEY = 'alliance.recentStickers';
const RECENT_MAX = 16;

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string): void {
  const list = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // private mode / storage full: recents just don't stick
  }
}

// ---------------------------------------------------------------- icon

/** A sticker: a square with a peeled corner and a small smile. */
export function stickerIcon(): SVGSVGElement {
  return s(
    'svg',
    { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { d: 'M4 4h16v10l-6 6H4ZM14 20v-6h6M9 9v1M14 9v1M8.5 13.2c1.2 1.1 2.9 1.3 4.2.6' }),
  );
}

// ---------------------------------------------------------------- picker

const PHONE = '(max-width: 640px)';

export class StickerPicker {
  readonly button: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly backdrop = h('div', { class: 'stk-backdrop', 'aria-hidden': 'true' });
  private readonly tabsEl = h('div', { class: 'stk-tabs', role: 'tablist', 'aria-label': 'Sticker packs' });
  private readonly bodyEl = h('div', { class: 'stk-body' });
  private readonly onPick: (id: string) => void;
  private activePack = '';
  private isOpen = false;
  private readonly id = `stk-${Math.random().toString(36).slice(2, 8)}`;

  private readonly onDocDown = (ev: PointerEvent): void => {
    const t = ev.target as Node;
    if (!this.panel.contains(t) && !this.button.contains(t)) this.close();
  };
  private readonly onReflow = (): void => this.place();

  constructor(onPick: (id: string) => void) {
    this.onPick = onPick;
    this.button = h(
      'button',
      {
        class: 'btn ghost sticker-btn',
        type: 'button',
        'aria-label': 'Stickers',
        title: 'Stickers',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        'aria-controls': this.id,
      },
      stickerIcon(),
    );
    this.button.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    this.panel = h(
      'div',
      { class: 'stk-panel', id: this.id, role: 'dialog', 'aria-label': 'Stickers', hidden: true },
      h('div', { class: 'stk-grab', 'aria-hidden': 'true' }),
      this.tabsEl,
      this.bodyEl,
    );
    this.panel.addEventListener('keydown', (ev) => this.key(ev));
    this.panel.addEventListener('focusout', (ev) => {
      const next = ev.relatedTarget as Node | null;
      if (next && !this.panel.contains(next) && next !== this.button && !matchMedia(PHONE).matches) this.close();
    });
    this.backdrop.addEventListener('click', () => this.close(true));
    onStickersChange(() => {
      if (this.isOpen) this.render();
    });
  }

  set disabled(d: boolean) {
    this.button.disabled = d;
    if (d) this.close();
  }

  /** Shown only when the server has stickers at all. */
  set available(a: boolean) {
    this.button.hidden = !a;
    if (!a) this.close();
  }

  open(): void {
    if (this.isOpen || this.button.disabled) return;
    this.isOpen = true;
    this.button.setAttribute('aria-expanded', 'true');
    const phone = matchMedia(PHONE).matches;
    this.panel.classList.toggle('sheet', phone);
    this.panel.classList.remove('up');
    this.panel.removeAttribute('style');
    if (phone) document.body.append(this.backdrop);
    document.body.append(this.panel);
    this.panel.hidden = false;
    this.render();
    this.place();
    requestAnimationFrame(() => {
      this.panel.classList.add('in');
      this.backdrop.classList.add('in');
    });
    document.addEventListener('pointerdown', this.onDocDown, true);
    window.addEventListener('resize', this.onReflow);
    this.focusFirst();
    // Pick up stickers added on the server since the catalog was loaded.
    loadStickers().catch(() => {
      if (this.isOpen && !stickersLoaded()) this.render(true);
    });
  }

  close(refocus = false): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.button.setAttribute('aria-expanded', 'false');
    this.panel.classList.remove('in');
    this.backdrop.classList.remove('in');
    this.panel.hidden = true;
    this.panel.remove();
    this.backdrop.remove();
    document.removeEventListener('pointerdown', this.onDocDown, true);
    window.removeEventListener('resize', this.onReflow);
    if (refocus) this.button.focus();
  }

  private pick(id: string): void {
    pushRecent(id);
    this.close(true);
    this.onPick(id);
  }

  private focusFirst(): void {
    if (matchMedia('(pointer: coarse)').matches) return; // don't pop the keyboard / scroll on phones
    const first = this.bodyEl.querySelector<HTMLElement>('.stk-grid .stk-cell') ?? this.tabsEl.querySelector<HTMLElement>('.stk-tab.active');
    first?.focus({ preventScroll: true });
  }

  /** Desktop: above the button, right-aligned to it, flipped below when there is no room. */
  private place(): void {
    if (!this.isOpen) return;
    const phone = matchMedia(PHONE).matches;
    if (phone !== this.panel.classList.contains('sheet')) {
      this.close();
      return;
    }
    if (phone) return;
    const r = this.button.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const margin = 8;
    const gap = 8;
    const width = Math.min(344, vw - margin * 2);
    const height = Math.min(380, Math.max(220, Math.max(r.top, vh - r.bottom) - gap - margin));
    this.panel.style.width = `${width}px`;
    this.panel.style.height = `${height}px`;
    const left = Math.max(margin, Math.min(r.right - width, vw - margin - width));
    this.panel.style.left = `${left}px`;
    const up = r.top - gap - margin >= height || r.top > vh - r.bottom;
    this.panel.style.top = up ? `${Math.max(margin, r.top - gap - height)}px` : `${r.bottom + gap}px`;
    this.panel.classList.toggle('up', up);
  }

  private cell(st: StickerInfo): HTMLButtonElement {
    const img = h('img', {
      src: st.url,
      alt: st.name,
      loading: 'lazy',
      decoding: 'async',
      draggable: 'false',
      width: st.w ?? null,
      height: st.h ?? null,
    });
    const btn = h('button', { class: 'stk-cell', type: 'button', title: st.name, 'data-id': st.id }, img);
    btn.addEventListener('click', () => this.pick(st.id));
    return btn;
  }

  private render(failed = false): void {
    if (!this.isOpen) return;
    if (!stickersLoaded()) {
      replaceChildren(this.tabsEl);
      replaceChildren(this.bodyEl, h('p', { class: 'stk-note' }, failed ? "Couldn't load stickers. Try again in a moment." : 'Loading stickers…'));
      return;
    }
    if (!packs.length) {
      replaceChildren(this.tabsEl);
      replaceChildren(this.bodyEl, h('p', { class: 'stk-note' }, 'No stickers yet.'));
      return;
    }
    if (!packs.some((p) => p.id === this.activePack)) this.activePack = packs[0].id;
    const pack = packs.find((p) => p.id === this.activePack)!;

    replaceChildren(
      this.tabsEl,
      packs.map((p) => {
        const active = p.id === this.activePack;
        const tab = h(
          'button',
          {
            class: `stk-tab ${active ? 'active' : ''}`,
            type: 'button',
            role: 'tab',
            'aria-selected': String(active),
            'aria-controls': `${this.id}-grid`,
            'aria-label': p.title,
            title: p.title,
            tabindex: active ? '0' : '-1',
          },
          h('img', { src: p.cover, alt: '', decoding: 'async', draggable: 'false' }),
        );
        tab.addEventListener('click', () => {
          this.activePack = p.id;
          this.render();
          this.bodyEl.scrollTop = 0;
          this.tabsEl.querySelector<HTMLElement>('.stk-tab.active')?.focus({ preventScroll: true });
        });
        return tab;
      }),
    );
    this.tabsEl.querySelector('.stk-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    const recent = readRecent()
      .map((id) => byId.get(id))
      .filter((x): x is StickerInfo => !!x)
      .slice(0, 8);
    replaceChildren(
      this.bodyEl,
      recent.length
        ? h(
            'section',
            { class: 'stk-section stk-recent', 'aria-label': 'Recently used' },
            h('h3', { class: 'stk-label' }, 'Recent'),
            h('div', { class: 'stk-row' }, recent.map((st) => this.cell(st))),
          )
        : null,
      h(
        'section',
        { class: 'stk-section' },
        h('h3', { class: 'stk-label' }, pack.title),
        h('div', { class: 'stk-grid', id: `${this.id}-grid`, role: 'tabpanel', 'aria-label': pack.title }, pack.stickers.map((st) => this.cell(st))),
      ),
    );
  }

  private key(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      this.close(true);
      return;
    }
    const target = ev.target as HTMLElement;
    if (target.classList.contains('stk-tab')) {
      const tabs = [...this.tabsEl.querySelectorAll<HTMLElement>('.stk-tab')];
      const i = tabs.indexOf(target);
      let j = -1;
      if (ev.key === 'ArrowRight') j = (i + 1) % tabs.length;
      else if (ev.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      else if (ev.key === 'Home') j = 0;
      else if (ev.key === 'End') j = tabs.length - 1;
      else if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        this.bodyEl.querySelector<HTMLElement>('.stk-cell')?.focus();
        return;
      }
      if (j >= 0) {
        ev.preventDefault();
        tabs[j].click();
      }
      return;
    }
    if (!target.classList.contains('stk-cell')) return;
    const cells = [...this.bodyEl.querySelectorAll<HTMLElement>('.stk-cell')];
    const i = cells.indexOf(target);
    let next: HTMLElement | undefined;
    if (ev.key === 'ArrowRight') next = cells[i + 1];
    else if (ev.key === 'ArrowLeft') next = cells[i - 1];
    else if (ev.key === 'Home') next = cells[0];
    else if (ev.key === 'End') next = cells[cells.length - 1];
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      // The nearest cell in the next row, by position (works across the recent row and the grid).
      const down = ev.key === 'ArrowDown';
      const r = target.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      let bestRow = Infinity;
      for (const c of cells) {
        const cr = c.getBoundingClientRect();
        const dy = down ? cr.top - r.top : r.top - cr.top;
        if (dy > 4 && dy < bestRow) bestRow = dy;
      }
      let bestDx = Infinity;
      for (const c of cells) {
        const cr = c.getBoundingClientRect();
        const dy = down ? cr.top - r.top : r.top - cr.top;
        if (Math.abs(dy - bestRow) > 4) continue;
        const dx = Math.abs(cr.left + cr.width / 2 - cx);
        if (dx < bestDx) {
          bestDx = dx;
          next = c;
        }
      }
      if (!next && !down) next = this.tabsEl.querySelector<HTMLElement>('.stk-tab.active') ?? undefined;
    } else return;
    ev.preventDefault();
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
  }
}
