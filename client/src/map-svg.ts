// SVG hex map: cells, player tokens (country flags) and short effect animations.
// Cells are created once per grid size; tokens are kept and moved, so moves slide.
// This is the fallback board, used when WebGL is unavailable (see map.ts).

import { gridCells, hexCorners, hexDistance, hexKey, hexToPixel, type Hex } from '../../shared/hex.ts';
import type { PublicPlayer } from '../../shared/protocol.ts';
import { s } from './dom.ts';
import { L } from './i18n.ts';
import type { BoardAction, CellGesture, MapImpl, MapInput, OrderMark } from './map-types.ts';
import { LONG_PRESS_MS, pressRing, type PressRing } from './press-ring.ts';

const SIZE = 32;
const FLAG_R = SIZE * 0.45;
const FLAG_Y = -SIZE * 0.14;

interface Token {
  g: SVGGElement;
  inner: SVGGElement;
  img: SVGImageElement;
  label: SVGTextElement;
  flag: string;
  nick: string;
}

function shortName(name: string): string {
  const chars = [...name];
  return chars.length > 9 ? chars.slice(0, 8).join('') + '…' : name;
}

export class SvgHexMap implements MapImpl {
  readonly el: SVGSVGElement;
  hovered: Hex | null = null;
  selected: Hex | null = null;
  onHover: (h: Hex | null) => void = () => undefined;
  onSelect: (h: Hex | null) => void = () => undefined;
  onMenu: (g: CellGesture) => void = () => undefined;
  onActivate: (g: CellGesture) => void = () => undefined;

  private readonly cellLayer: SVGGElement;
  private readonly tokenLayer: SVGGElement;
  private readonly fxLayer: SVGGElement;
  /** Blitz: ghosts of the queued orders. */
  private readonly orderLayer: SVGGElement;
  private ordersKey = '';
  private readonly cells = new Map<string, { hex: Hex; poly: SVGPolygonElement }>();
  private readonly tokens = new Map<number, Token>();
  private radius = -1;
  private myPid: number | null = null;
  private myPos: Hex | null = null;
  private range = 0;
  private lastTap = { t: 0, key: '', x: 0, y: 0, hex: null as Hex | null };
  /** time of the latest pointerdown: a double counts from the first release to the second press */
  private downAt = 0;
  private press: { id: number; x: number; y: number; hex: Hex; timer: number; ring: PressRing } | null = null;
  /** a long-press just opened the menu: swallow the click that follows the lift */
  private swallowClick = false;
  private previewKey = '';

  constructor() {
    this.cellLayer = s('g', { class: 'cells' });
    this.tokenLayer = s('g', { class: 'tokens' });
    this.fxLayer = s('g', { class: 'fx' });
    this.orderLayer = s('g', { class: 'orders' });
    this.el = s(
      'svg',
      { class: 'hexmap', role: 'img', 'aria-label': L('board.gameMap') },
      s('defs', null, s('clipPath', { id: 'tok-clip', clipPathUnits: 'objectBoundingBox' }, s('circle', { cx: 0.5, cy: 0.5, r: 0.5 }))),
      this.cellLayer,
      this.orderLayer,
      this.tokenLayer,
      this.fxLayer,
    );

    const cellFrom = (target: EventTarget | null): Hex | null => {
      const key = target instanceof Element ? target.getAttribute('data-key') : null;
      return key ? (this.cells.get(key)?.hex ?? null) : null;
    };
    this.el.addEventListener('pointerover', (ev) => {
      const hex = cellFrom(ev.target);
      if (hex) this.setHover(hex);
    });
    this.el.addEventListener('pointerleave', () => this.setHover(null));
    // Same mapping as the 3D board: click selects, a second click on the same cell within
    // the window = activate (move), right-click / long-press = the action menu.
    this.el.addEventListener('click', (ev) => {
      if (this.swallowClick) {
        this.swallowClick = false;
        return;
      }
      const hex = cellFrom(ev.target);
      if (!hex) return;
      const key = hexKey(hex);
      const touch = (ev as PointerEvent).pointerType === 'touch' || (ev as PointerEvent).pointerType === 'pen';
      const now = ev.timeStamp || performance.now();
      const lt = this.lastTap;
      const gap = Math.hypot(ev.clientX - lt.x, ev.clientY - lt.y);
      // 350 ms on touch (late events on real phones); a near miss on the neighbour counts for the first cell
      const sameTarget = lt.key === key || (touch && gap < 24 && lt.hex !== null);
      if (lt.t && (this.downAt || now) - lt.t < (touch ? 350 : 450) && sameTarget && gap < (touch ? 36 : 12)) {
        const target = lt.hex ?? hex;
        this.lastTap.t = 0;
        if (!this.selected || hexKey(this.selected) !== hexKey(target)) this.setSelected(target);
        this.onActivate({ hex: target, x: ev.clientX, y: ev.clientY, touch });
        return;
      }
      this.lastTap = { t: now, key, x: ev.clientX, y: ev.clientY, hex };
      const same = this.selected && hexKey(this.selected) === key;
      this.setSelected(same ? null : hex);
    });
    this.el.addEventListener('dblclick', (ev) => ev.preventDefault());
    this.el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      // touch long-press is handled by the timer below (some browsers also send contextmenu)
      if (this.press || this.swallowClick) return;
      const hex = cellFrom(ev.target);
      if (!hex) return;
      this.lastTap.t = 0;
      if (!this.selected || hexKey(this.selected) !== hexKey(hex)) this.setSelected(hex);
      this.onMenu({ hex, x: ev.clientX, y: ev.clientY, touch: false });
    });
    this.el.addEventListener('pointerdown', (ev) => {
      this.downAt = ev.timeStamp;
      if (ev.pointerType === 'mouse') return;
      if (this.press) {
        this.endPress(false); // a second finger: pinch/zoom, not a press
        return;
      }
      const hex = cellFrom(ev.target);
      if (!hex) return;
      const { pointerId: id, clientX: x, clientY: y } = ev;
      const timer = window.setTimeout(() => requestAnimationFrame(() => {
        // (after a frame: a queued drag / second finger cancels first)
        if (!this.press || this.press.id !== id) return;
        this.endPress(true);
        this.swallowClick = true;
        setTimeout(() => (this.swallowClick = false), 700);
        this.lastTap.t = 0;
        if (!this.selected || hexKey(this.selected) !== hexKey(hex)) this.setSelected(hex);
        this.onMenu({ hex, x, y, touch: true });
      }), LONG_PRESS_MS);
      this.press = { id, x, y, hex, timer, ring: pressRing(x, y) };
    });
    this.el.addEventListener('pointermove', (ev) => {
      const p = this.press;
      if (p && p.id === ev.pointerId && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 12) this.endPress(false);
    });
    const lift = (ev: PointerEvent): void => {
      if (this.press?.id === ev.pointerId) this.endPress(false);
    };
    this.el.addEventListener('pointerup', lift);
    this.el.addEventListener('pointercancel', lift);
  }

  private endPress(fired: boolean): void {
    const p = this.press;
    if (!p) return;
    this.press = null;
    clearTimeout(p.timer);
    p.ring.end(fired);
  }

  px(h: Hex): { x: number; y: number } {
    return hexToPixel(h, SIZE);
  }

  setRadius(radius: number): void {
    if (radius === this.radius) return;
    this.radius = radius;
    this.cellLayer.textContent = '';
    this.cells.clear();
    const corners = hexCorners(SIZE * 0.94);
    for (const hex of gridCells(radius)) {
      const { x, y } = this.px(hex);
      const points = corners.map((c) => `${(x + c.x).toFixed(2)},${(y + c.y).toFixed(2)}`).join(' ');
      const key = hexKey(hex);
      const poly = s('polygon', { class: 'cell', points, 'data-key': key });
      this.cells.set(key, { hex, poly });
      this.cellLayer.appendChild(poly);
    }
    const pad = 6;
    const w = Math.sqrt(3) * SIZE * (2 * radius + 1) + pad * 2;
    const h = SIZE * (3 * radius + 2) + pad * 2;
    this.el.setAttribute('viewBox', `${(-w / 2).toFixed(1)} ${(-h / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
  }

  setHover(hex: Hex | null): void {
    if (this.hovered) this.cells.get(hexKey(this.hovered))?.poly.classList.remove('hover');
    this.hovered = hex;
    if (hex) this.cells.get(hexKey(hex))?.poly.classList.add('hover');
    this.onHover(hex);
  }

  setSelected(hex: Hex | null): void {
    if (this.selected) this.cells.get(hexKey(this.selected))?.poly.classList.remove('selected');
    this.selected = hex;
    if (hex) this.cells.get(hexKey(hex))?.poly.classList.add('selected');
    this.onSelect(hex);
  }

  render(input: MapInput): void {
    const { myPos, range, showRange } = input;
    this.myPid = input.myPid;
    this.myPos = myPos;
    this.range = range;
    for (const { hex, poly } of this.cells.values()) {
      const d = myPos ? hexDistance(myPos, hex) : -1;
      poly.classList.toggle('in-range', showRange && d > 0 && d <= range);
      poly.classList.toggle('adjacent', showRange && d === 1);
      poly.classList.toggle('mine', d === 0);
    }

    const onMap = new Set<number>();
    for (const p of input.players) {
      if (!p.alive || p.q === null || p.r === null) continue;
      onMap.add(p.pid);
      let t = this.tokens.get(p.pid);
      const { x, y } = this.px({ q: p.q, r: p.r });
      if (!t) {
        t = this.createToken(p);
        this.tokens.set(p.pid, t);
        t.g.classList.add('no-anim');
        t.g.style.transform = `translate(${x}px, ${y}px)`;
        this.tokenLayer.appendChild(t.g);
        const g = t.g;
        requestAnimationFrame(() => requestAnimationFrame(() => g.classList.remove('no-anim')));
      } else {
        t.g.style.transform = `translate(${x}px, ${y}px)`;
      }
      if (t.flag !== p.flag) {
        t.img.setAttribute('href', `/flags/1x1/${p.flag}.svg`);
        t.flag = p.flag;
      }
      if (t.nick !== p.nickname) {
        t.label.textContent = shortName(p.nickname);
        t.nick = p.nickname;
      }
      t.g.classList.toggle('me', p.pid === input.myPid);
    }
    for (const [pid, t] of this.tokens) {
      if (onMap.has(pid)) continue;
      this.tokens.delete(pid);
      t.g.classList.add('dying');
      setTimeout(() => t.g.remove(), 700);
    }
  }

  private createToken(p: PublicPlayer): Token {
    const img = s('image', {
      href: `/flags/1x1/${p.flag}.svg`,
      x: -FLAG_R,
      y: FLAG_Y - FLAG_R,
      width: FLAG_R * 2,
      height: FLAG_R * 2,
      'clip-path': 'url(#tok-clip)',
      preserveAspectRatio: 'xMidYMid slice',
    });
    const label = s('text', { class: 'tok-label', y: SIZE * 0.62 }, shortName(p.nickname));
    const inner = s('g', { class: 'tok-inner' }, s('circle', { class: 'tok-ring', cy: FLAG_Y, r: FLAG_R + 2.5 }), img, label);
    const g = s('g', { class: 'token' }, inner);
    return { g, inner, img, label, flag: p.flag, nick: p.nickname };
  }

  // ---------------------------------------------------------------- effects

  private fx(el: SVGElement, ms: number): void {
    this.fxLayer.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  shot(from: Hex, to: Hex, kind: 'attack' | 'grant'): void {
    const a = this.px(from);
    const b = this.px(to);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const line = s('line', { class: `shot ${kind}`, x1: a.x, y1: a.y + FLAG_Y, x2: b.x, y2: b.y + FLAG_Y });
    line.style.setProperty('--len', String(len));
    line.style.strokeDasharray = String(len);
    this.fx(line, 700);
    this.fx(s('circle', { class: `impact ${kind}`, cx: b.x, cy: b.y + FLAG_Y, r: FLAG_R + 4 }), 900);
  }

  /** Blitz: dashed lines and target rings for the queued orders (the 3D board draws arcs). */
  setOrders(marks: OrderMark[]): void {
    const key = JSON.stringify(marks);
    if (key === this.ordersKey) return;
    this.ordersKey = key;
    this.orderLayer.textContent = '';
    for (const m of marks) {
      const a = this.px(m.from);
      const b = this.px(m.to);
      if (m.kind === 'upgrade' || m.kind === 'charge') {
        this.orderLayer.appendChild(s('circle', { class: `order-ring ${m.kind}`, cx: a.x, cy: a.y, r: SIZE * (m.kind === 'upgrade' ? 0.95 : 0.75) }));
        continue;
      }
      this.orderLayer.appendChild(s('line', { class: `order-line ${m.kind}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
      this.orderLayer.appendChild(s('circle', { class: `order-ring ${m.kind}`, cx: b.x, cy: b.y, r: SIZE * 0.62 }));
      if (m.label) this.orderLayer.appendChild(s('text', { class: `order-label ${m.kind}`, x: b.x, y: b.y - SIZE * 0.7 }, m.label));
    }
  }

  float(at: Hex, text: string, kind: 'good' | 'bad' | 'info'): void {
    const p = this.px(at);
    this.fx(s('text', { class: `float ${kind}`, x: p.x, y: p.y - SIZE * 0.55 }, text), 1400);
  }

  ring(at: Hex, kind: 'range' | 'bad'): void {
    const p = this.px(at);
    this.fx(s('circle', { class: `ring ${kind}`, cx: p.x, cy: p.y + FLAG_Y, r: SIZE * 0.6 }), 900);
  }

  burst(at: Hex): void {
    this.ring(at, 'bad');
    this.float(at, '☠', 'bad');
  }

  shake(pid: number): void {
    const t = this.tokens.get(pid);
    if (!t) return;
    t.inner.classList.remove('shake');
    requestAnimationFrame(() => t.inner.classList.add('shake'));
    setTimeout(() => t.inner.classList.remove('shake'), 600);
  }

  hint(kind: BoardAction | null, at: Hex | null): void {
    const k = kind ? `${kind}:${at ? hexKey(at) : ''}` : '';
    if (k === this.previewKey) return;
    this.previewKey = k;
    if (!kind) return;
    const target = kind === 'upgrade' || kind === 'charge' ? this.myPos : at;
    if (!target) return;
    const p = this.px(target);
    const r = kind === 'upgrade' ? SIZE * (0.6 + this.range * 1.5) : SIZE * 0.55;
    this.fx(s('circle', { class: `ring hint ${kind}`, cx: p.x, cy: p.y, r }), 700);
  }

  hop(at: Hex): void {
    const p = this.px(at);
    this.fx(s('circle', { class: 'ring hint move', cx: p.x, cy: p.y, r: SIZE * 0.6 }), 700);
    const t = this.myPid !== null ? this.tokens.get(this.myPid) : undefined;
    if (t) {
      t.inner.classList.remove('hop');
      requestAnimationFrame(() => t.inner.classList.add('hop'));
      setTimeout(() => t.inner.classList.remove('hop'), 450);
    }
  }

  deny(at: Hex): void {
    this.flashCell(at);
    if (this.myPid !== null) this.shake(this.myPid);
  }

  destroy(): void {
    this.endPress(false);
    this.el.remove();
  }

  flashCell(hex: Hex): void {
    const poly = this.cells.get(hexKey(hex))?.poly;
    if (!poly) return;
    poly.classList.remove('flash');
    requestAnimationFrame(() => poly.classList.add('flash'));
    setTimeout(() => poly.classList.remove('flash'), 450);
  }
}
