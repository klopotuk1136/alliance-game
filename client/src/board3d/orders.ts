// Blitz: your queued orders drawn on the table as ghosts — a brass path for the move, red
// arcs ending in a hexagonal target ring for shots, green arcs for AP gifts, a blue ring
// round your piece for Range +1, a bolt for Charge. Static meshes, rebuilt only when the
// queue changes (a handful of draws); the numbers are HTML badges placed by board.ts.

import {
  AdditiveBlending,
  type BufferGeometry,
  CircleGeometry,
  type Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  QuadraticBezierCurve3,
  RingGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import { hexKey, type Hex } from '../../../shared/hex.ts';
import type { OrderMark } from '../map-types.ts';
import { TILE_TOP, worldOf } from './util.ts';

export interface MarkBadge {
  el: HTMLDivElement;
  x: number;
  y: number;
  z: number;
  /** The target cell (board.ts lifts the badge above a piece standing there). */
  hex: Hex;
  /** A badge about your own piece (range / charge), offset beside it. */
  self: boolean;
}

export interface MarkColors {
  move: Color;
  attack: Color;
  grant: Color;
  upgrade: Color;
  charge: Color;
}

export class OrderMarks {
  readonly group = new Group();
  readonly badges: MarkBadge[] = [];
  private readonly geos: BufferGeometry[] = [];
  private readonly mats = new Map<string, MeshBasicMaterial>();
  private key = '';

  constructor(
    private readonly labels: HTMLElement,
    private readonly colors: MarkColors,
    private readonly liftAt: (h: Hex) => number,
  ) {
    this.group.renderOrder = 5;
  }

  private mat(kind: OrderMark['kind'], ghost: boolean): MeshBasicMaterial {
    const k = `${kind}:${ghost}`;
    let m = this.mats.get(k);
    if (!m) {
      m = new MeshBasicMaterial({
        color: this.colors[kind].clone().multiplyScalar(ghost ? 0.9 : 1.5),
        transparent: true,
        opacity: ghost ? 0.38 : 0.92,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      });
      this.mats.set(k, m);
    }
    return m;
  }

  private add(geo: BufferGeometry, kind: OrderMark['kind'], ghost = false): Mesh {
    this.geos.push(geo);
    const mesh = new Mesh(geo, this.mat(kind, ghost));
    mesh.renderOrder = 5;
    this.group.add(mesh);
    return mesh;
  }

  private top(h: Hex): number {
    return TILE_TOP + this.liftAt(h) + 0.035;
  }

  /** Replaces the drawn orders; returns true when something changed. */
  set(marks: OrderMark[]): boolean {
    const key = JSON.stringify(marks);
    if (key === this.key) return false;
    this.key = key;
    this.clear();
    const ringsAt = new Map<string, number>();
    for (const m of marks) {
      const a = worldOf(m.from);
      const b = worldOf(m.to);
      const ya = this.top(m.from);
      const yb = this.top(m.to);
      if (m.kind === 'move' || m.kind === 'attack' || m.kind === 'grant') {
        const dist = Math.hypot(b.x - a.x, b.z - a.z);
        const lift = m.kind === 'move' ? 0.35 : 0.6 + dist * 0.28;
        const start = new Vector3(a.x, ya + (m.kind === 'move' ? 0.05 : 0.5), a.z);
        const end = new Vector3(b.x, yb + (m.kind === 'move' ? 0.05 : 0.12), b.z);
        // stop the tube short of the target so the ring reads clearly
        const mid = new Vector3((a.x + b.x) / 2, Math.max(start.y, end.y) + lift, (a.z + b.z) / 2);
        const curve = new QuadraticBezierCurve3(start, mid, end);
        this.add(new TubeGeometry(curve, Math.max(12, Math.round(dist * 10)), m.kind === 'move' ? 0.05 : 0.04, 6, false), m.kind);
      }
      if (m.kind === 'charge' || m.kind === 'upgrade') {
        const n = ringsAt.get(`self:${m.kind}`) ?? 0;
        ringsAt.set(`self:${m.kind}`, n + 1);
        const r0 = m.kind === 'upgrade' ? 0.95 + n * 0.16 : 0.62 + n * 0.12;
        const ring = this.add(new RingGeometry(r0, r0 + 0.07, 48), m.kind);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(a.x, ya, a.z);
        continue;
      }
      // the hexagonal target ring (several orders on one cell nest inside each other)
      const k = hexKey(m.to);
      const n = ringsAt.get(k) ?? 0;
      ringsAt.set(k, n + 1);
      const r0 = Math.max(0.3, 0.74 - n * 0.14);
      const ring = this.add(new RingGeometry(r0 - 0.1, r0, 6, 1, Math.PI / 6), m.kind);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(b.x, yb, b.z);
      if (n === 0) {
        const fill = this.add(new CircleGeometry(0.78, 6, Math.PI / 6), m.kind, true);
        fill.rotation.x = -Math.PI / 2;
        fill.position.set(b.x, yb - 0.004, b.z);
      }
    }
    // badges: one per target cell (labels joined), placed above the cell
    const byCell = new Map<string, { m: OrderMark; texts: string[] }>();
    for (const m of marks) {
      if (!m.label) continue;
      const self = m.kind === 'charge' || m.kind === 'upgrade';
      const k = self ? `self:${m.kind}` : hexKey(m.to);
      const e = byCell.get(k) ?? { m, texts: [] };
      e.texts.push(m.label);
      byCell.set(k, e);
    }
    for (const { m, texts } of byCell.values()) {
      const el = document.createElement('div');
      el.className = `b3-order ${m.kind}`;
      el.textContent = texts.join(' ');
      this.labels.appendChild(el);
      const at = m.kind === 'charge' || m.kind === 'upgrade' ? m.from : m.to;
      const w = worldOf(at);
      const self = m.kind === 'upgrade' || m.kind === 'charge';
      this.badges.push({ el, x: w.x + (m.kind === 'charge' ? 0.8 : 0), y: this.top(at) + 0.03, z: w.z + (m.kind === 'upgrade' ? 1.05 : 0), hex: at, self });
    }
    return true;
  }

  private clear(): void {
    for (const c of [...this.group.children]) this.group.remove(c);
    for (const g of this.geos) g.dispose();
    this.geos.length = 0;
    for (const b of this.badges) b.el.remove();
    this.badges.length = 0;
  }

  dispose(): void {
    this.clear();
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
  }
}
