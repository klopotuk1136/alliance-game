// The game board. `HexMap` is a drop-in facade: it mounts a host element at once, then
// lazy-loads the three.js board (client/src/board3d) so auth/home/lobby never pay for
// three. If WebGL2 is missing, the 3D board fails to start, or the player forced it
// (`?map=svg` or localStorage `alliance.map = svg`), the SVG board is used instead.
// State set before the board is ready (radius, last render, selection) is replayed.
// `new HexMap({ preview: true })` is the lobby's live preview: no SVG fallback (the host
// just stays empty without WebGL), pieces stand around the rim via `roster()`.

import type { Hex } from '../../shared/hex.ts';
import type { PublicPlayer } from '../../shared/protocol.ts';
import { SvgHexMap } from './map-svg.ts';
import type { BoardAction, CellGesture, MapImpl, MapInput, OrderMark } from './map-types.ts';

export type { BoardAction, CellGesture, MapInput, OrderMark } from './map-types.ts';

function wantsSvg(): boolean {
  try {
    if (new URLSearchParams(location.search).get('map') === 'svg') return true;
    if (localStorage.getItem('alliance.map') === 'svg') return true;
  } catch {
    /* storage blocked: ignore */
  }
  return false;
}

/** Cheap WebGL2 probe (three.js needs WebGL2); the probe context is released at once. */
function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export class HexMap {
  readonly el: HTMLDivElement;
  onHover: (h: Hex | null) => void = () => undefined;
  onSelect: (h: Hex | null) => void = () => undefined;
  onMenu: (g: CellGesture) => void = () => undefined;
  onActivate: (g: CellGesture) => void = () => undefined;

  private impl: MapImpl | null = null;
  private radius = -1;
  private input: MapInput | null = null;
  private pendingSelected: Hex | null = null;
  private destroyed = false;
  private readonly preview: boolean;
  private rosterArgs: [PublicPlayer[], number | null] | null = null;
  private marks: OrderMark[] = [];

  constructor(opts: { preview?: boolean } = {}) {
    this.preview = !!opts.preview;
    this.el = document.createElement('div');
    this.el.className = `board-host${this.preview ? ' preview' : ''}`;
    if (wantsSvg() || !hasWebGL2()) {
      if (this.preview) this.el.classList.add('unavailable');
      else this.useSvg();
      return;
    }
    this.el.classList.add('loading');
    import('./board3d/board.ts')
      .then(({ Board3D }) => {
        if (this.destroyed) return;
        this.attach(new Board3D({ preview: this.preview }));
      })
      .catch((err: unknown) => {
        console.warn('3D board unavailable', err);
        if (this.destroyed) return;
        if (this.preview) {
          this.el.classList.remove('loading');
          this.el.classList.add('unavailable');
        } else this.useSvg();
      });
  }

  /** True when a board is (or will be) shown; false for a preview without WebGL. */
  get available(): boolean {
    return !this.el.classList.contains('unavailable');
  }

  get hovered(): Hex | null {
    return this.impl ? this.impl.hovered : null;
  }

  get selected(): Hex | null {
    return this.impl ? this.impl.selected : this.pendingSelected;
  }

  private useSvg(): void {
    this.attach(new SvgHexMap());
  }

  private attach(impl: MapImpl): void {
    this.impl = impl;
    impl.onHover = (h) => this.onHover(h);
    impl.onSelect = (h) => this.onSelect(h);
    impl.onMenu = (g) => this.onMenu(g);
    impl.onActivate = (g) => this.onActivate(g);
    this.el.classList.remove('loading');
    this.el.classList.toggle('is-3d', !(impl instanceof SvgHexMap));
    this.el.appendChild(impl.el);
    if (this.radius >= 0) impl.setRadius(this.radius);
    if (this.input) impl.render(this.input);
    if (this.pendingSelected) impl.setSelected(this.pendingSelected);
    if (this.rosterArgs) impl.setRoster?.(...this.rosterArgs);
    if (this.marks.length) impl.setOrders?.(this.marks);
    // A board that dies later (e.g. the WebGL context cannot be restored) falls back too.
    this.el.addEventListener('board-failed', () => this.fallback(impl), { once: true });
  }

  private fallback(dead: MapImpl): void {
    if (this.destroyed || this.impl !== dead || dead instanceof SvgHexMap) return;
    this.pendingSelected = dead.selected;
    dead.destroy();
    this.impl = null;
    if (this.preview) this.el.classList.add('unavailable');
    else this.useSvg();
  }

  setRadius(radius: number): void {
    this.radius = radius;
    this.impl?.setRadius(radius);
  }

  setSelected(hex: Hex | null): void {
    if (this.impl) {
      this.impl.setSelected(hex);
    } else {
      this.pendingSelected = hex;
      this.onSelect(hex);
    }
  }

  /** Lobby preview: the players standing around the board. */
  roster(players: PublicPlayer[], myPid: number | null): void {
    this.rosterArgs = [players, myPid];
    this.impl?.setRoster?.(players, myPid);
  }

  render(input: MapInput): void {
    this.input = input;
    this.impl?.render(input);
  }

  flashCell(hex: Hex): void {
    this.impl?.flashCell(hex);
  }

  shot(from: Hex, to: Hex, kind: 'attack' | 'grant'): void {
    this.impl?.shot(from, to, kind);
  }

  float(at: Hex, text: string, kind: 'good' | 'bad' | 'info'): void {
    this.impl?.float(at, text, kind);
  }

  ring(at: Hex, kind: 'range' | 'bad'): void {
    this.impl?.ring(at, kind);
  }

  burst(at: Hex): void {
    this.impl?.burst(at);
  }

  shake(pid: number): void {
    this.impl?.shake(pid);
  }

  hint(kind: BoardAction | null, at: Hex | null): void {
    this.impl?.hint(kind, at);
  }

  hop(at: Hex): void {
    this.impl?.hop(at);
  }

  deny(at: Hex): void {
    this.impl?.deny(at);
  }

  /** Blitz: your queued orders as ghosts on the board. */
  setOrders(marks: OrderMark[]): void {
    this.marks = marks;
    this.impl?.setOrders?.(marks);
  }

  /** Blitz replay: a shot into a cell (boards without a dedicated effect use a plain shot). */
  strike(from: Hex, to: Hex, hit: boolean, power: number): void {
    if (!this.impl) return;
    if (this.impl.strike) this.impl.strike(from, to, hit, power);
    else this.impl.shot(from, to, 'attack');
  }

  /** Blitz replay: a bounced move. */
  bounce(pid: number, toward: Hex): void {
    this.impl?.bounce?.(pid, toward);
  }

  /** Frees the WebGL context and every GPU resource; call when the game screen closes. */
  destroy(): void {
    this.destroyed = true;
    this.impl?.destroy();
    this.impl = null;
    this.el.remove();
  }
}
