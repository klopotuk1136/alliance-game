// The planning board's drawing surface: a flat top-down hex map (snapshot pieces, your
// own range) with the plan's arrows, pins, notes and ghost pieces, plus pan / zoom and
// screen → cell conversion. Pure drawing: plan.ts owns the tools and the data.

import { gridCells, hexCorners, hexDistance, hexKey, hexToPixel, inGrid, type Hex } from '../../shared/hex.ts';
import type { ArrowKind, PinKind, PlanItem, PlanPiece } from '../../shared/plan.ts';
import { s } from './dom.ts';
import { L, t } from './i18n.ts';

export const SIZE = 32;
const FLAG_R = SIZE * 0.42;

export interface PlanRenderInput {
  radius: number;
  pieces: PlanPiece[];
  items: PlanItem[];
  turn: number;
  myPid: number | null;
  /** Your own attack range (only ever yours: others' ranges are secret). */
  myRange: number | null;
  colorOf(pid: number): string;
  nameOf(pid: number): string;
  /** Item to highlight (inspected), if any. */
  selected: number | null;
}

/** Plain-language description of an item, for hover titles and the info chip. */
export function describe(it: PlanItem, nameOf: (pid: number) => string): string {
  const by = nameOf(it.author);
  switch (it.kind) {
    case 'move':
      return t('plan.desc.move', { by });
    case 'attack':
      return t('plan.desc.attack', { by });
    case 'support':
      return t('plan.desc.support', { by });
    case 'pin':
      return t(it.pin === 'target' ? 'plan.desc.target' : it.pin === 'defend' ? 'plan.desc.defend' : 'plan.desc.rally', { by });
    case 'note':
      return t('plan.desc.note', { by, text: it.text });
    case 'ghost':
      return t('plan.desc.ghost', { name: nameOf(it.pid), by });
  }
}

function px(h: Hex): { x: number; y: number } {
  return hexToPixel(h, SIZE);
}

/** Pixel → the hex it falls in (cube rounding). */
export function pixelToHex(x: number, y: number): Hex {
  const qf = ((Math.sqrt(3) / 3) * x - y / 3) / SIZE;
  const rf = ((2 / 3) * y) / SIZE;
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s2 = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s2 - sf);
  if (dq > dr && dq > ds) q = -r - s2;
  else if (dr > ds) r = -q - s2;
  return { q: q + 0, r: r + 0 };
}

function short(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text;
}

/** A curved arrow from cell centre a to b: the path, its arrowhead and useful points. */
function arrowGeom(a: { x: number; y: number }, b: { x: number; y: number }, bend: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  // Neighbouring cells: trim less, or the arrow would be all head.
  const near = len < SIZE * 2.2;
  const s0 = { x: a.x + ux * SIZE * (near ? 0.3 : 0.5), y: a.y + uy * SIZE * (near ? 0.3 : 0.5) };
  const e0 = { x: b.x - ux * SIZE * (near ? 0.25 : 0.42), y: b.y - uy * SIZE * (near ? 0.25 : 0.42) };
  const curve = Math.min(len * 0.16, SIZE * 1.6) * bend;
  const c = { x: (s0.x + e0.x) / 2 + nx * curve, y: (s0.y + e0.y) / 2 + ny * curve };
  // Tangent at the end of the quadratic curve.
  let tx = e0.x - c.x;
  let ty = e0.y - c.y;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  const headL = near ? 10 : 13;
  const headW = near ? 6.5 : 7.5;
  const base = { x: e0.x - tx * headL, y: e0.y - ty * headL };
  const head = [
    `${e0.x.toFixed(1)},${e0.y.toFixed(1)}`,
    `${(base.x - ty * headW).toFixed(1)},${(base.y + tx * headW).toFixed(1)}`,
    `${(base.x + ty * headW).toFixed(1)},${(base.y - tx * headW).toFixed(1)}`,
  ].join(' ');
  // The line stops inside the head so dashes don't poke out of its tip.
  const lineEnd = { x: e0.x - tx * headL * 0.6, y: e0.y - ty * headL * 0.6 };
  const d = `M${s0.x.toFixed(1)} ${s0.y.toFixed(1)} Q${c.x.toFixed(1)} ${c.y.toFixed(1)} ${lineEnd.x.toFixed(1)} ${lineEnd.y.toFixed(1)}`;
  const mid = { x: 0.25 * s0.x + 0.5 * c.x + 0.25 * e0.x, y: 0.25 * s0.y + 0.5 * c.y + 0.25 * e0.y };
  return { d, head, mid, start: s0 };
}

const KIND_GLYPH: Record<ArrowKind, string> = {
  move: 'M-4 0h7M0.5-3.5 4 0l-3.5 3.5',
  attack: 'M-4.5-4.5l9 9M4.5-4.5l-9 9',
  support: 'M0-4.5v9M-4.5 0h9',
};

const PIN_GLYPH: Record<PinKind, string> = {
  target: 'M0-6.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13M0-2.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5',
  defend: 'M0-7 6-4.6v4.1c0 3.6-2.5 6-6 7.3-3.5-1.3-6-3.7-6-7.3v-4.1Z',
  rally: 'M-4 7V-7M-4-6.5h9l-2.2 3.4 2.2 3.4h-9',
};

export class PlanCanvas {
  readonly el: SVGSVGElement;
  private readonly world: SVGGElement;
  private readonly cellLayer: SVGGElement;
  private readonly rangeLayer: SVGGElement;
  private readonly pastLayer: SVGGElement;
  private readonly pieceLayer: SVGGElement;
  private readonly itemLayer: SVGGElement;
  private readonly previewLayer: SVGGElement;
  private readonly hoverPoly: SVGPolygonElement;
  private readonly cells = new Map<string, SVGPolygonElement>();
  private radius = -1;
  private cellPoints = '';
  /** Pan (in viewBox units) and zoom of the world group. */
  private view = { x: 0, y: 0, k: 1 };

  constructor() {
    this.cellLayer = s('g', { class: 'pl-cells' });
    this.rangeLayer = s('g', { class: 'pl-range' });
    this.pastLayer = s('g', { class: 'pl-past' });
    this.pieceLayer = s('g', { class: 'pl-pieces' });
    this.itemLayer = s('g', { class: 'pl-items' });
    this.previewLayer = s('g', { class: 'pl-preview' });
    this.hoverPoly = s('polygon', { class: 'pl-hover', points: '' });
    this.world = s('g', { class: 'pl-world' }, this.cellLayer, this.rangeLayer, this.hoverPoly, this.pastLayer, this.pieceLayer, this.itemLayer, this.previewLayer);
    this.el = s(
      'svg',
      { class: 'plan-svg', role: 'img', 'aria-label': L('plan.mapLabel') },
      s('defs', null, s('clipPath', { id: 'pl-clip', clipPathUnits: 'objectBoundingBox' }, s('circle', { cx: 0.5, cy: 0.5, r: 0.5 }))),
      this.world,
    );
  }

  // ---------------------------------------------------------------- grid & view

  setRadius(radius: number): void {
    if (radius === this.radius) return;
    this.radius = radius;
    this.cellLayer.textContent = '';
    this.cells.clear();
    const corners = hexCorners(SIZE * 0.95);
    this.cellPoints = corners.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');
    for (const hex of gridCells(radius)) {
      const { x, y } = px(hex);
      const poly = s('polygon', { class: 'pl-cell', points: this.cellPoints, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` });
      this.cells.set(hexKey(hex), poly);
      this.cellLayer.appendChild(poly);
    }
    const pad = 14;
    const w = Math.sqrt(3) * SIZE * (2 * radius + 1) + pad * 2;
    const h = SIZE * (3 * radius + 2) + pad * 2;
    this.el.setAttribute('viewBox', `${(-w / 2).toFixed(1)} ${(-h / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
    this.fit();
  }

  inGrid(h: Hex): boolean {
    return this.radius >= 0 && inGrid(h, this.radius);
  }

  fit(): void {
    this.view = { x: 0, y: 0, k: 1 };
    this.applyView();
  }

  private applyView(): void {
    const { x, y, k } = this.view;
    this.world.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(4)})`);
  }

  /** Screen point → viewBox coordinates (before pan/zoom). */
  private toView(clientX: number, clientY: number): { x: number; y: number } {
    const m = this.el.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  /** Screen point → map pixel coordinates. */
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const v = this.toView(clientX, clientY);
    return { x: (v.x - this.view.x) / this.view.k, y: (v.y - this.view.y) / this.view.k };
  }

  /** The cell under a screen point, or null when off the map. */
  cellAt(clientX: number, clientY: number): Hex | null {
    const w = this.toWorld(clientX, clientY);
    const h = pixelToHex(w.x, w.y);
    return this.inGrid(h) ? h : null;
  }

  /** Pans by a screen-space delta. */
  panBy(dxClient: number, dyClient: number): void {
    const m = this.el.getScreenCTM();
    const scale = m ? m.a : 1;
    this.view.x += dxClient / scale;
    this.view.y += dyClient / scale;
    this.clampView();
    this.applyView();
  }

  /** Zooms by `factor` around a screen point. */
  zoomAt(clientX: number, clientY: number, factor: number): void {
    const v = this.toView(clientX, clientY);
    const k = Math.min(5, Math.max(0.7, this.view.k * factor));
    const f = k / this.view.k;
    this.view.x = v.x - (v.x - this.view.x) * f;
    this.view.y = v.y - (v.y - this.view.y) * f;
    this.view.k = k;
    this.clampView();
    this.applyView();
  }

  private clampView(): void {
    const vb = this.el.viewBox.baseVal;
    if (!vb || !vb.width) return;
    // Keep at least part of the map in view.
    const lim = (vb.width / 2) * this.view.k;
    const limY = (vb.height / 2) * this.view.k;
    this.view.x = Math.max(-lim, Math.min(lim, this.view.x));
    this.view.y = Math.max(-limY, Math.min(limY, this.view.y));
  }

  setHover(h: Hex | null): void {
    if (!h) {
      this.hoverPoly.setAttribute('points', '');
      return;
    }
    const { x, y } = px(h);
    this.hoverPoly.setAttribute('points', this.cellPoints);
    this.hoverPoly.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
  }

  // ---------------------------------------------------------------- drawing

  render(o: PlanRenderInput): void {
    this.setRadius(o.radius);

    // Your own range, around your piece on the snapshot.
    this.rangeLayer.textContent = '';
    const mine = o.pieces.find((p) => p.pid === o.myPid);
    if (mine && o.myRange) {
      for (const hex of gridCells(o.radius)) {
        const d = hexDistance(hex, mine);
        if (d === 0 || d > o.myRange) continue;
        const { x, y } = px(hex);
        this.rangeLayer.appendChild(s('polygon', { class: 'pl-inrange', points: this.cellPoints, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` }));
      }
    }

    this.pieceLayer.textContent = '';
    for (const p of o.pieces) this.pieceLayer.appendChild(this.piece(p, p.pid === o.myPid));

    // Earlier turns stay faintly visible under the current one; later turns are hidden.
    this.pastLayer.textContent = '';
    this.itemLayer.textContent = '';
    const byTurn = (t: number) => o.items.filter((i) => i.turn === t);
    for (let t = 1; t < o.turn; t++) for (const it of this.ordered(byTurn(t))) this.pastLayer.appendChild(this.item(it.it, it.step, o, true));
    for (const it of this.ordered(byTurn(o.turn))) this.itemLayer.appendChild(this.item(it.it, it.step, o, false));
  }

  /** Draw order: ghosts, pins, notes on top, arrows in between; arrows get step numbers 1, 2, 3… */
  private ordered(items: PlanItem[]): Array<{ it: PlanItem; step: number }> {
    const rank = (k: PlanItem['kind']): number => (k === 'ghost' ? 0 : k === 'move' || k === 'attack' || k === 'support' ? 1 : k === 'pin' ? 2 : 3);
    let step = 0;
    const steps = new Map<number, number>();
    for (const it of [...items].sort((a, b) => a.id - b.id)) if (rank(it.kind) === 1) steps.set(it.id, ++step);
    return [...items].sort((a, b) => rank(a.kind) - rank(b.kind) || a.id - b.id).map((it) => ({ it, step: steps.get(it.id) ?? 0 }));
  }

  private piece(p: PlanPiece, me: boolean): SVGGElement {
    const { x, y } = px(p);
    return s(
      'g',
      { class: `pl-piece ${me ? 'me' : ''}`, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` },
      s('title', null, me ? t('plan.pieceYou', { name: p.nickname }) : p.nickname),
      s('circle', { class: 'pl-piece-ring', r: FLAG_R + 3 }),
      s('image', {
        href: `/flags/1x1/${p.flag}.svg`,
        x: -FLAG_R,
        y: -FLAG_R,
        width: FLAG_R * 2,
        height: FLAG_R * 2,
        'clip-path': 'url(#pl-clip)',
        preserveAspectRatio: 'xMidYMid slice',
      }),
      s('text', { class: 'pl-piece-label', y: FLAG_R + 13 }, short(p.nickname, 10)),
    );
  }

  private item(it: PlanItem, step: number, o: PlanRenderInput, faint: boolean): SVGGElement {
    const color = o.colorOf(it.author);
    const g = s('g', { class: `pl-item k-${it.kind} ${faint ? 'faint' : ''} ${o.selected === it.id ? 'sel' : ''}`, 'data-id': it.id, style: `--c:${color}` });
    g.appendChild(s('title', null, describe(it, o.nameOf)));
    switch (it.kind) {
      case 'move':
      case 'attack':
      case 'support': {
        const a = px({ q: it.from[0], r: it.from[1] });
        const b = px({ q: it.to[0], r: it.to[1] });
        const geo = arrowGeom(a, b, 1);
        g.append(
          s('path', { class: 'pl-hit', d: geo.d }),
          s('path', { class: 'pl-arrow-shadow', d: geo.d }),
          s('path', { class: 'pl-arrow', d: geo.d }),
          s('polygon', { class: 'pl-head', points: geo.head }),
        );
        if (it.kind !== 'move') {
          g.append(
            s('g', { class: 'pl-badge', transform: `translate(${geo.mid.x.toFixed(1)} ${geo.mid.y.toFixed(1)})` }, s('circle', { r: 8.5 }), s('path', { d: KIND_GLYPH[it.kind] })),
          );
        }
        if (step && !faint) {
          g.append(
            s(
              'g',
              { class: 'pl-step', transform: `translate(${geo.start.x.toFixed(1)} ${geo.start.y.toFixed(1)})` },
              s('circle', { r: 7.5 }),
              s('text', { y: 3.6 }, String(step)),
            ),
          );
        }
        break;
      }
      case 'pin': {
        const { x, y } = px({ q: it.at[0], r: it.at[1] });
        g.setAttribute('transform', `translate(${x.toFixed(1)} ${(y - SIZE * 0.55).toFixed(1)})`);
        g.classList.add(`pin-${it.pin}`);
        g.append(
          s('path', { class: 'pl-pin-stem', d: `M0 8 L0 ${SIZE * 0.5}` }),
          s('circle', { class: 'pl-pin-disc', r: 11 }),
          s('path', { class: 'pl-pin-glyph', d: PIN_GLYPH[it.pin] }),
        );
        break;
      }
      case 'note': {
        const { x, y } = px({ q: it.at[0], r: it.at[1] });
        const text = short(it.text, 22);
        const w = Math.max(34, [...text].length * 6.3 + 18);
        g.setAttribute('transform', `translate(${x.toFixed(1)} ${(y - SIZE * 0.2).toFixed(1)})`);
        g.append(
          s('path', { class: 'pl-note-box', d: `M${-w / 2} -30 h${w} v20 h${-w / 2 + 6} l-6 6 l-6 -6 h${-w / 2 + 6} Z` }),
          s('rect', { class: 'pl-note-bar', x: -w / 2, y: -30, width: 4, height: 20 }),
          s('text', { class: 'pl-note-text', x: 2, y: -16 }, text),
        );
        break;
      }
      case 'ghost': {
        const src = o.pieces.find((p) => p.pid === it.pid);
        const at = px({ q: it.at[0], r: it.at[1] });
        if (src) {
          const from = px(src);
          g.append(s('line', { class: 'pl-ghost-trail', x1: from.x, y1: from.y, x2: at.x, y2: at.y }));
        }
        g.append(
          s(
            'g',
            { class: 'pl-ghost', transform: `translate(${at.x.toFixed(1)} ${at.y.toFixed(1)})` },
            s('circle', { class: 'pl-ghost-ring', r: FLAG_R + 3 }),
            src
              ? s('image', {
                  href: `/flags/1x1/${src.flag}.svg`,
                  x: -FLAG_R,
                  y: -FLAG_R,
                  width: FLAG_R * 2,
                  height: FLAG_R * 2,
                  'clip-path': 'url(#pl-clip)',
                  preserveAspectRatio: 'xMidYMid slice',
                })
              : null,
          ),
        );
        break;
      }
    }
    return g;
  }

  // ---------------------------------------------------------------- previews while dragging

  clearPreview(): void {
    this.previewLayer.textContent = '';
  }

  previewArrow(from: Hex, to: Hex, kind: ArrowKind, color: string): void {
    this.clearPreview();
    if (hexKey(from) === hexKey(to)) {
      const { x, y } = px(from);
      this.previewLayer.appendChild(s('circle', { class: 'pl-origin', cx: x, cy: y, r: SIZE * 0.7, style: `--c:${color}` }));
      return;
    }
    const geo = arrowGeom(px(from), px(to), 1);
    this.previewLayer.appendChild(
      s(
        'g',
        { class: `pl-item k-${kind} preview`, style: `--c:${color}` },
        s('path', { class: 'pl-arrow', d: geo.d }),
        s('polygon', { class: 'pl-head', points: geo.head }),
      ),
    );
  }

  previewGhost(piece: PlanPiece, to: Hex, color: string): void {
    this.clearPreview();
    const a = px(piece);
    const b = px(to);
    this.previewLayer.appendChild(
      s(
        'g',
        { class: 'pl-item k-ghost preview', style: `--c:${color}` },
        s('line', { class: 'pl-ghost-trail', x1: a.x, y1: a.y, x2: b.x, y2: b.y }),
        s(
          'g',
          { class: 'pl-ghost', transform: `translate(${b.x.toFixed(1)} ${b.y.toFixed(1)})` },
          s('circle', { class: 'pl-ghost-ring', r: FLAG_R + 3 }),
          s('image', {
            href: `/flags/1x1/${piece.flag}.svg`,
            x: -FLAG_R,
            y: -FLAG_R,
            width: FLAG_R * 2,
            height: FLAG_R * 2,
            'clip-path': 'url(#pl-clip)',
            preserveAspectRatio: 'xMidYMid slice',
          }),
        ),
      ),
    );
  }
}
