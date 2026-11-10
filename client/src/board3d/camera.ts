// Orbit camera for the board: a damped target/distance/tilt/azimuth rig, clamped so the
// table is always in view and the camera never dips under it, plus the pointer, touch and
// wheel controls that drive it.
//
// Desktop: left-drag orbits, right-drag / shift-drag / middle-drag pans, wheel zooms to the
// cursor. Touch: one finger orbits, two fingers pinch-zoom + pan + twist-rotate. A tap (no
// drag) selects; a double tap/click toggles "centre on me" / "whole map".
// In the lobby preview the board must not trap the page: one-finger vertical drags scroll
// the page (touch-action: pan-y) and a plain wheel scrolls; ctrl/⌘+wheel (and trackpad
// pinch) zooms.

import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { clamp, clamp01, FOV, SQRT3, TILE_TOP, TILT_DEFAULT, TILT_MAX, TILT_MIN, frameRadius } from './util.ts';
import { LONG_PRESS_MS } from '../press-ring.ts';

export interface CamState {
  tx: number;
  tz: number;
  d: number;
  tilt: number; // elevation above the table, radians
  az: number; // azimuth, radians; 0 = north up (camera on +z looking to −z)
}

const TAU = Math.PI * 2;

export class OrbitRig {
  readonly cur: CamState = { tx: 0, tz: 0, d: 30, tilt: TILT_DEFAULT, az: 0 };
  readonly goal: CamState = { tx: 0, tz: 0, d: 30, tilt: TILT_DEFAULT, az: 0 };
  fit = { d: 30, tx: 0, tz: 0 };
  minD = 4;
  maxD = 40;
  radius = -1;
  /** Extra room around the frame to keep in view (lobby pieces stand outside it). */
  margin = 0;
  /** Outer frame radius right now (animated by the field while the board resizes). */
  outer = 0;
  /** Whole-table mode: the view re-fits when the board resizes or the user orbits. */
  auto = true;
  private fitKey = '';
  private readonly scratch = new PerspectiveCamera(FOV, 1, 0.5, 600);
  private readonly ray = new Raycaster();
  private readonly plane = new Plane(new Vector3(0, 1, 0), -TILE_TOP);
  private readonly v2 = new Vector2();
  private readonly v3 = new Vector3();
  private readonly pts: Vector3[] = [];
  shakeT = 1;
  shakeAmp = 0;

  constructor(readonly camera: PerspectiveCamera) {
    for (let i = 0; i < 12; i++) this.pts.push(new Vector3());
  }

  apply(cam: PerspectiveCamera, s: CamState): void {
    const ch = Math.cos(s.tilt) * s.d;
    cam.position.set(s.tx + Math.sin(s.az) * ch, TILE_TOP + Math.sin(s.tilt) * s.d, s.tz + Math.cos(s.az) * ch);
    cam.up.set(0, 1, 0);
    cam.lookAt(s.tx, TILE_TOP, s.tz);
    cam.updateMatrixWorld();
  }

  /** Point on the tile-top plane under NDC (x, y) for a camera state. */
  groundAt(nx: number, ny: number, s: CamState, out: Vector3): Vector3 | null {
    const cam = this.scratch;
    if (cam.aspect !== this.camera.aspect) {
      cam.aspect = this.camera.aspect;
      cam.updateProjectionMatrix();
    }
    this.apply(cam, s);
    this.ray.setFromCamera(this.v2.set(nx, ny), cam);
    return this.ray.ray.intersectPlane(this.plane, out);
  }

  /** Distance and target that frame the whole table for a given azimuth/tilt. */
  fitFor(az: number, tilt: number): { d: number; tx: number; tz: number } {
    const R = Math.max(0, this.radius);
    const Rf = (this.outer || frameRadius(R) + 0.95) - 0.2 + this.margin;
    const top = TILE_TOP + 1.9;
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      this.pts[i].set(Rf * Math.cos(a), 0, Rf * Math.sin(a));
      this.pts[i + 6].set(SQRT3 * R * Math.cos(a), top, SQRT3 * R * Math.sin(a));
    }
    const cam = this.scratch;
    cam.aspect = this.camera.aspect;
    cam.updateProjectionMatrix();
    const s: CamState = { tx: 0, tz: 0, d: 30, tilt, az };
    const mx = 0.94;
    const my = 0.9;
    let cy = 0;
    let cx = 0;
    const extent = (): boolean => {
      this.apply(cam, s);
      let lo = Infinity;
      let hi = -Infinity;
      let lx = Infinity;
      let hx = -Infinity;
      let ok = true;
      for (const p of this.pts) {
        const v = this.v3.copy(p).project(cam);
        if (Math.abs(v.x) > mx || Math.abs(v.y) > my || v.z > 1) ok = false;
        lo = Math.min(lo, v.y);
        hi = Math.max(hi, v.y);
        lx = Math.min(lx, v.x);
        hx = Math.max(hx, v.x);
      }
      cy = (lo + hi) / 2;
      cx = (lx + hx) / 2;
      return ok;
    };
    for (let pass = 0; pass < 3; pass++) {
      let a = 2;
      let b = 900;
      for (let i = 0; i < 36; i++) {
        s.d = (a + b) / 2;
        if (extent()) b = s.d;
        else a = s.d;
      }
      s.d = b;
      extent();
      const g = this.groundAt(cx, cy, s, this.v3);
      if (g) {
        s.tx = g.x;
        s.tz = g.z;
      }
    }
    return { d: s.d, tx: s.tx, tz: s.tz };
  }

  /** Recomputes the fit (and zoom limits) when the board, viewport or view angle changed. */
  refit(force = false): void {
    if (this.radius < 0) return;
    const g = this.goal;
    const key = `${this.radius}|${this.outer.toFixed(2)}|${this.margin}|${this.camera.aspect.toFixed(3)}|${g.tilt.toFixed(2)}|${(((g.az % TAU) + TAU) % TAU).toFixed(1)}`;
    if (!force && key === this.fitKey) return;
    this.fitKey = key;
    this.fit = this.fitFor(g.az, g.tilt);
    this.maxD = this.fit.d * 1.15;
    // closest zoom still shows ~5 cells across the narrow side
    const halfTan = Math.tan(((FOV / 2) * Math.PI) / 180);
    const across = 2 * halfTan * Math.min(1, this.camera.aspect);
    this.minD = Math.min(this.fit.d * 0.85, Math.max(6.5, 8.5 / across));
  }

  /** How far we are zoomed in: 0 = whole table, 1 = closest. */
  zoomedIn(s: CamState = this.goal): number {
    const span = this.fit.d - this.minD;
    return span > 0 ? clamp01((this.fit.d - s.d) / span) : 0;
  }

  clampGoal(): void {
    const g = this.goal;
    g.tilt = clamp(g.tilt, TILT_MIN, TILT_MAX);
    this.refit();
    g.d = clamp(g.d, this.minD, this.maxD);
    const lim = 0.3 + (SQRT3 * Math.max(0, this.radius) + 0.5) * clamp01(this.zoomedIn() * 3);
    const dx = g.tx - this.fit.tx;
    const dz = g.tz - this.fit.tz;
    const len = Math.hypot(dx, dz);
    if (len > lim) {
      const k = lim / (len || 1);
      g.tx = this.fit.tx + dx * k;
      g.tz = this.fit.tz + dz * k;
    }
  }

  /** Whole table, current angle kept. */
  showAll(): void {
    this.auto = true;
    this.refit(true);
    Object.assign(this.goal, { tx: this.fit.tx, tz: this.fit.tz, d: this.fit.d });
  }

  /** North up, default tilt, whole table. */
  resetView(): void {
    const g = this.goal;
    // unwind to the nearest full turn so the camera takes the short way round
    g.az = Math.round(g.az / TAU) * TAU;
    g.tilt = TILT_DEFAULT;
    this.showAll();
  }

  /** Damps the camera towards its goal; returns true while still moving. */
  update(dt: number, reduced: boolean): boolean {
    const c = this.cur;
    const g = this.goal;
    const k = 1 - Math.exp(-dt * (reduced ? 16 : 7.5));
    const ka = 1 - Math.exp(-dt * (reduced ? 16 : 9));
    c.tx += (g.tx - c.tx) * k;
    c.tz += (g.tz - c.tz) * k;
    c.d += (g.d - c.d) * k;
    c.tilt += (g.tilt - c.tilt) * ka;
    c.az += (g.az - c.az) * ka;
    const moving =
      Math.abs(g.tx - c.tx) > 1e-3 ||
      Math.abs(g.tz - c.tz) > 1e-3 ||
      Math.abs(g.d - c.d) > 1e-3 * g.d ||
      Math.abs(g.tilt - c.tilt) > 2e-4 ||
      Math.abs(g.az - c.az) > 2e-4;
    if (!moving) Object.assign(c, g);
    this.apply(this.camera, c);
    let shaking = false;
    if (this.shakeT < 1) {
      this.shakeT = Math.min(1, this.shakeT + dt / 0.38);
      const f = (1 - this.shakeT) ** 2 * this.shakeAmp * c.d * 0.006;
      const t = this.shakeT * 38;
      this.camera.position.x += Math.sin(t * 1.3) * f;
      this.camera.position.y += Math.sin(t * 1.7 + 1) * f * 0.6;
      this.camera.position.z += Math.cos(t * 1.1) * f;
      this.camera.updateMatrixWorld();
      shaking = true;
    }
    return moving || shaking;
  }

  shake(amp: number): void {
    this.shakeAmp = amp;
    this.shakeT = 0;
  }
}

// ------------------------------------------------------------------ controls

export interface ControlHooks {
  /** A tap / click without drag; `downAt` = the pointerdown's event time. */
  tap(e: PointerEvent, downAt: number): void;
  /** Mouse/pen moved over the board without a button pressed. */
  hover(x: number, y: number, pointerType: string): void;
  /** A drag began (hover should clear). */
  dragStart(): void;
  /** The view changed: draw a frame. */
  changed(): void;
  /** Right-click (or ctrl+click) without drag: the context menu, not a pan. */
  context?(e: PointerEvent): void;
  /** A touch/pen press began; return true to arm the long-press timer (e.g. it is on a cell). */
  pressStart?(x: number, y: number): boolean;
  /** The armed press was held still long enough. */
  longPress?(x: number, y: number): void;
  /** The armed press ended: fired, or cancelled by a lift, drag or second finger. */
  pressEnd?(fired: boolean): void;
}


type Mode = 'orbit' | 'pan' | 'pinch';

export class OrbitControls {
  /** Lobby preview: never trap the page scroll. */
  preview = false;
  private readonly pointers = new Map<number, { x: number; y: number; type: string }>();
  private g: {
    sx: number;
    sy: number;
    moved: boolean;
    multi: boolean;
    mode: Mode;
    /** right button / ctrl+click: a click opens the menu, a drag pans */
    ctx: boolean;
    /** a long-press fired: the rest of this gesture is ignored */
    held: boolean;
    /** pointerdown event time */
    t0: number;
    spread0: number;
    d0: number;
    angle0: number;
    az0: number;
  } | null = null;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  /** Last user input time (performance.now), for the lobby turntable. */
  lastInput = 0;
  private pressTimer = 0;
  private pressArmed = false;

  constructor(
    private readonly el: HTMLElement,
    private readonly rig: OrbitRig,
    private readonly hooks: ControlHooks,
  ) {
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('dblclick', this.onDbl);
    el.addEventListener('contextmenu', this.onContext);
  }

  dispose(): void {
    this.cancelPress();
    const el = this.el;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointercancel', this.onUp);
    el.removeEventListener('pointerleave', this.onLeave);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('dblclick', this.onDbl);
    el.removeEventListener('contextmenu', this.onContext);
  }

  get dragging(): boolean {
    return !!this.g?.moved;
  }

  private ndc(x: number, y: number): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1];
  }

  private readonly onContext = (e: Event): void => e.preventDefault();

  private readonly onDown = (e: PointerEvent): void => {
    this.lastInput = performance.now();
    const ctx = e.pointerType === 'mouse' && (e.button === 2 || (e.button === 0 && e.ctrlKey));
    const pan = e.pointerType === 'mouse' && (e.button === 2 || e.button === 1 || e.shiftKey);
    if (e.pointerType === 'mouse' && e.button !== 0 && !pan) return;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (this.pointers.size === 1) {
      this.g = { sx: e.clientX, sy: e.clientY, moved: false, multi: false, mode: pan ? 'pan' : 'orbit', ctx, held: false, t0: e.timeStamp, spread0: 0, d0: this.rig.goal.d, angle0: 0, az0: this.rig.goal.az };
      if (pan) e.preventDefault();
      if (e.pointerType !== 'mouse' && !this.preview && this.hooks.pressStart?.(e.clientX, e.clientY)) {
        const g = this.g;
        const { clientX: x, clientY: y } = e;
        this.pressArmed = true;
        this.pressTimer = window.setTimeout(() => {
          this.pressTimer = 0;
          // input already queued for this frame (a drag, a second finger) lands first:
          // pointermove is frame-aligned, so on a busy frame it can trail the timer
          requestAnimationFrame(() => {
            if (!this.pressArmed || this.g !== g || g.moved || g.multi) return;
            this.pressArmed = false;
            g.held = true;
            this.hooks.pressEnd?.(true);
            this.hooks.longPress?.(x, y);
          });
        }, LONG_PRESS_MS);
      }
    } else if (this.g && this.pointers.size === 2) {
      this.cancelPress();
      const [a, b] = [...this.pointers.values()];
      Object.assign(this.g, {
        multi: true,
        moved: true,
        mode: 'pinch',
        spread0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        d0: this.rig.goal.d,
        angle0: Math.atan2(b.y - a.y, b.x - a.x),
        az0: this.rig.goal.az,
      });
      this.hooks.dragStart();
    }
  };

  private readonly onMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') this.hooks.hover(e.clientX, e.clientY, e.pointerType);
      return;
    }
    const g = this.g;
    if (!g || g.held) return;
    this.lastInput = performance.now();
    if (!g.moved) {
      // touch slop: a finger wobbles ~10 px during a tap on real phones
      const thr = e.pointerType === 'mouse' ? 4 : 12;
      if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < thr) return;
      this.cancelPress();
      g.moved = true;
      this.hooks.dragStart();
      this.el.style.cursor = 'grabbing';
    }
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    if (this.pointers.size === 1) {
      if (g.mode === 'pan') {
        const [px, py] = this.ndc(prev.x, prev.y);
        const [cx, cy] = this.ndc(e.clientX, e.clientY);
        this.panBy(px, py, cx, cy);
      } else {
        this.orbitBy(dx, this.preview && e.pointerType !== 'mouse' ? 0 : dy);
      }
      prev.x = e.clientX;
      prev.y = e.clientY;
    } else if (this.pointers.size >= 2) {
      const [a0, b0] = [...this.pointers.values()];
      const mid0 = this.ndc((a0.x + b0.x) / 2, (a0.y + b0.y) / 2);
      prev.x = e.clientX;
      prev.y = e.clientY;
      const [a, b] = [...this.pointers.values()];
      const spread = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = this.ndc((a.x + b.x) / 2, (a.y + b.y) / 2);
      // twist: rotate with the fingers
      let da = Math.atan2(b.y - a.y, b.x - a.x) - g.angle0;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      this.rig.goal.az = g.az0 - da;
      this.zoomAt(mid0[0], mid0[1], (g.d0 * g.spread0) / spread);
      this.panBy(mid0[0], mid0[1], mid[0], mid[1]);
      // fingers on glass: the map sticks to them, no damping lag
      Object.assign(this.rig.cur, this.rig.goal);
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    const g = this.g;
    if (this.pointers.size === 0) {
      this.cancelPress();
      this.g = null;
      this.el.style.cursor = '';
      if (g && !g.moved && !g.multi && !g.held && e.type === 'pointerup') {
        if (g.ctx) this.hooks.context?.(e);
        else this.hooks.tap(e, g.t0);
      }
      this.hooks.changed();
    } else if (g && this.pointers.size === 1) {
      // pinch → one finger left: carry on orbiting from here
      g.mode = 'orbit';
      g.d0 = this.rig.goal.d;
    }
  };

  private readonly onLeave = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && !this.pointers.size) this.hooks.hover(-1, -1, 'leave');
  };

  // Double-click / double-tap is detected from two taps in board.ts (one path for mouse
  // and touch); the native event only needs its default (text selection) suppressed.
  private readonly onDbl = (e: MouseEvent): void => e.preventDefault();

  private cancelPress(): void {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = 0;
    if (this.pressArmed) {
      this.pressArmed = false;
      this.hooks.pressEnd?.(false);
    }
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (this.preview && !e.ctrlKey && !e.metaKey) return; // let the lobby page scroll
    e.preventDefault();
    this.lastInput = performance.now();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const [nx, ny] = this.ndc(e.clientX, e.clientY);
    const gain = e.ctrlKey ? 0.006 : 0.0018; // trackpad pinch arrives as ctrl+wheel with small deltas
    this.zoomAt(nx, ny, this.rig.goal.d * Math.exp(clamp(dy, -200, 200) * gain));
    this.hooks.changed();
  };

  orbitBy(dx: number, dy: number): void {
    const h = this.el.clientHeight || 400;
    const g = this.rig.goal;
    g.az -= (dx / h) * Math.PI * 0.9;
    g.tilt += (dy / h) * Math.PI * 0.5;
    this.rig.clampGoal();
    // whole-table view stays centred while it turns
    if (this.rig.auto) this.rig.showAll();
    this.hooks.changed();
  }

  /** Zoom to distance `d` keeping the ground point under NDC (nx, ny) fixed. */
  zoomAt(nx: number, ny: number, d: number): void {
    const rig = this.rig;
    const before = rig.groundAt(nx, ny, rig.goal, this.tmp);
    rig.goal.d = clamp(d, rig.minD, rig.maxD);
    const after = rig.groundAt(nx, ny, rig.goal, this.tmp2);
    if (before && after) {
      rig.goal.tx += before.x - after.x;
      rig.goal.tz += before.z - after.z;
    }
    rig.clampGoal();
    rig.auto = rig.zoomedIn() < 0.02;
    if (rig.auto) rig.showAll();
    this.hooks.changed();
  }

  /** Drag: the ground point under the old pointer follows the pointer 1:1. */
  panBy(px: number, py: number, cx: number, cy: number): void {
    const rig = this.rig;
    const a = rig.groundAt(px, py, rig.goal, this.tmp);
    const b = rig.groundAt(cx, cy, rig.goal, this.tmp2);
    if (!a || !b) return;
    rig.goal.tx += a.x - b.x;
    rig.goal.tz += a.z - b.z;
    rig.clampGoal();
    rig.cur.tx = rig.goal.tx;
    rig.cur.tz = rig.goal.tz;
    this.hooks.changed();
  }
}
