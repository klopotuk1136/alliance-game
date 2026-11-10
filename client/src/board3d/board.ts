// The 3D game board (three.js), style «Штаб»: a war-room map table at night.
//
//   camera.ts  orbit rig + mouse/touch controls (damped, clamped to the table)
//   field.ts   engraved enamel tiles, glow overlay, brass frame, compass, sea chart
//   pieces.ts  commander miniatures with waving cloth flags
//   fx.ts      pooled particles, comets, shockwaves, cracks, flashes, dust motes
//   textures.ts procedural canvas textures (+ flag rasterising)
//
// Cost model (phones first):
// - tiles are two instanced draws (tops + brass bevels), the glow overlay one more;
// - renders on demand: a frame is drawn when something changed; while idle only the
//   "ambient" loop runs (flags wave, dust drifts) at ≤30 fps — 15 fps after 45 s without
//   input — and only while the board is on screen, the tab visible and motion allowed.
//   Under prefers-reduced-motion there is no ambient loop at all: idle = zero frames;
// - the shadow map is redrawn only when a piece or the frame moves;
// - DPR capped (2 desktop, 1.5 touch), no post-processing;
// - destroy() frees every GPU resource and the WebGL context itself.
//
// Optional sculpted model: drop a GLB in client/public/models/ and set PIECE_MODEL_URL in pieces.ts (base only, Y up,
// any scale — it is normalised to the procedural base's size). Without it the turned
// procedural base is used; flags, glow and animations are the same either way.

import {
  ACESFilmicToneMapping,
  BackSide,
  BoxGeometry,
  DataTexture,
  Color,
  DoubleSide,
  Fog,
  Group,
  HemisphereLight,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Raycaster,
  Scene,
  SpotLight,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { hexDistance, hexKey, type Hex } from '../../../shared/hex.ts';
import type { PublicPlayer } from '../../../shared/protocol.ts';
import type { BoardAction, CellGesture, MapImpl, MapInput, OrderMark } from '../map-types.ts';
import { bindAttr, onLang, t, type Key } from '../i18n.ts';
import { pressRing, type PressRing } from '../press-ring.ts';
import { OrbitControls, OrbitRig } from './camera.ts';
import { Effects } from './fx.ts';
import { Field } from './field.ts';
import { OrderMarks } from './orders.ts';
import { flagClock, loadPieceModel, Piece, PIECE_MID, PIECE_TOP, pieceGeometry, type PieceGeo } from './pieces.ts';
import { crackTexture, glowTexture, ringGlowTexture } from './textures.ts';
import { clamp, clamp01, ease, FOV, hexAt, readPalette, TILE_TOP, TILT_DEFAULT, worldOf } from './util.ts';

export interface BoardOpts {
  /** Lobby preview: pieces stand around the rim, the page keeps its scroll. */
  preview?: boolean;
}

interface Timed {
  t: number;
  fn: () => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgIcon(paths: string, cls = ''): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  s.innerHTML = paths;
  return s;
}

export class Board3D implements MapImpl {
  readonly el: HTMLDivElement;
  hovered: Hex | null = null;
  selected: Hex | null = null;
  onHover: (h: Hex | null) => void = () => undefined;
  onSelect: (h: Hex | null) => void = () => undefined;
  onMenu: (g: CellGesture) => void = () => undefined;
  onActivate: (g: CellGesture) => void = () => undefined;

  private readonly preview: boolean;
  private readonly canvas: HTMLCanvasElement;
  private readonly labels: HTMLDivElement;
  private readonly focusBtn: HTMLButtonElement;
  private readonly offLang: () => void;
  private readonly compassBtn: HTMLButtonElement;
  private readonly compassNeedle: SVGSVGElement;
  private readonly expandBtn: HTMLButtonElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.5, 600);
  private readonly rig: OrbitRig;
  private readonly controls: OrbitControls;
  private readonly raycaster = new Raycaster();
  private readonly mobile: boolean;
  private readonly reduced: boolean;
  private readonly aniso: number;
  private readonly C = readPalette();
  private readonly field: Field;
  private readonly fx: Effects;
  /** Blitz: the ghosts of your queued orders. */
  private readonly orderMarks: OrderMarks;
  private readonly key: SpotLight;
  private readonly geo: PieceGeo;
  private readonly glowTex: Texture;
  private readonly ringTex: Texture;
  private readonly crackTex: Texture;
  private readonly blankTex: DataTexture;
  private warmed = false;

  private input: MapInput | null = null;
  private rangeKey = '';
  private readonly pieces = new Map<number, Piece>();
  private readonly dying: Piece[] = [];
  private readonly pieceGroup = new Group();
  private spawnStagger = 0;
  private tokScale = 1;
  private readonly floats: Array<{ el: HTMLDivElement; x: number; y: number; z: number; t: number; life: number; offset: number; key: string }> = [];
  private readonly floatStack = new Map<string, number>();
  /** Cells with a shot still in flight → the floats there wait for the impact. */
  private readonly incoming = new Map<string, number>();
  private readonly timeline: Timed[] = [];
  private roster: { players: PublicPlayer[]; myPid: number | null } | null = null;

  // view
  private width = 0;
  private height = 0;
  private introDone = false;
  private lastAz = NaN;
  /** The previous single tap/click, for double-click / double-tap detection. */
  private lastTap = { t: 0, x: 0, y: 0, key: null as string | null, hex: null as Hex | null };
  private press: PressRing | null = null;
  private previewKey = '';
  private expanded: { layer: HTMLDivElement; parent: HTMLElement; next: Node | null } | null = null;

  /** Debug: slows every animation (e.g. 0.2 to inspect an effect). */
  timeScale = 1;

  // loop
  private raf = 0;
  private ambientTimer = 0;
  private last = 0;
  private lastActivity = performance.now();
  private frames = 0;
  private shadowDirty = true;
  private hidden = document.hidden;
  private inView = true;
  private lost = false;
  private disposed = false;
  private readonly ro: ResizeObserver;
  private readonly io: IntersectionObserver | null;
  private readonly tmpV = new Vector3();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpC = new Color();

  constructor(opts: BoardOpts = {}) {
    this.preview = !!opts.preview;
    this.mobile = window.matchMedia('(pointer: coarse)').matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---- DOM
    this.el = document.createElement('div');
    this.el.className = `board3d${this.preview ? ' preview' : ''}`;
    this.el.setAttribute('role', 'img');
    bindAttr(this.el, 'aria-label', this.preview ? 'board.mapPreview' : 'board.gameMap');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'b3-canvas';
    this.canvas.style.touchAction = this.preview ? 'pan-y' : 'none';
    this.labels = document.createElement('div');
    this.labels.className = 'b3-labels';
    this.labels.setAttribute('aria-hidden', 'true');
    const vignette = document.createElement('div');
    vignette.className = 'b3-vignette';
    const tools = document.createElement('div');
    tools.className = 'b3-tools';
    const btn = (cls: string, label: Key): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `b3-btn ${cls}`;
      b.setAttribute('aria-label', t(label));
      b.title = t(label);
      return b;
    };
    this.expandBtn = btn('b3-expand', 'board.expand');
    this.expandBtn.append(
      svgIcon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', 'ic-open'),
      svgIcon('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>', 'ic-close'),
    );
    this.expandBtn.addEventListener('click', () => this.toggleExpand());
    this.compassBtn = btn('b3-compass', 'board.resetView');
    bindAttr(this.compassBtn, 'aria-label', 'board.resetView');
    bindAttr(this.compassBtn, 'title', 'board.resetView');
    this.compassNeedle = svgIcon('<path class="n" d="M12 3l3.2 9h-6.4z"/><path class="s" d="M12 21l-3.2-9h6.4z"/><circle cx="12" cy="12" r="1.4"/>');
    this.compassBtn.append(this.compassNeedle);
    this.compassBtn.addEventListener('click', () => {
      this.rig.resetView();
      this.bump();
    });
    this.focusBtn = btn('b3-focus', 'board.wholeMap');
    this.focusBtn.addEventListener('click', () => this.toggleFocus());
    tools.append(this.expandBtn, this.compassBtn, this.focusBtn);
    this.el.append(this.canvas, vignette, this.labels, tools);
    // debugging / test handle: document.querySelector('.board3d').b3
    (this.el as HTMLDivElement & { b3?: Board3D }).b3 = this;

    // ---- renderer (throws without WebGL: map.ts then falls back to SVG)
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false });
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.mobile ? 1.5 : 2));
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1.08;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.shadowMap.autoUpdate = false;
    this.aniso = Math.min(this.mobile ? 4 : 8, r.capabilities.getMaxAnisotropy());

    this.scene.background = this.C.bg.clone();
    this.scene.fog = new Fog(this.C.bg.clone(), 40, 120);
    this.buildEnvironment();

    // lights: warm desk lamp (key, shadows) + cool night fill + a cool rim from behind
    this.key = new SpotLight(0xffd7a3, 5.4, 0, Math.PI / 5, 0.62, 0);
    this.key.castShadow = true;
    const sm = this.mobile ? 1024 : 2048;
    this.key.shadow.mapSize.set(sm, sm);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    this.key.shadow.radius = 3;
    this.scene.add(this.key, this.key.target);
    this.scene.add(new HemisphereLight(0x8fa6d4, 0x0a0e15, 0.55));
    const rim = new SpotLight(0x6f9fd8, 1.8, 0, Math.PI / 4, 0.9, 0);
    rim.position.set(6, 14, -40);
    this.scene.add(rim, rim.target);

    // ---- world
    this.field = new Field({ mobile: this.mobile, reduced: this.reduced, aniso: this.aniso, C: this.C });
    this.scene.add(this.field.group, this.pieceGroup);
    this.glowTex = glowTexture();
    this.ringTex = ringGlowTexture();
    this.crackTex = crackTexture();
    this.blankTex = new DataTexture(new Uint8Array([150, 142, 126, 255]), 1, 1);
    this.blankTex.needsUpdate = true;
    this.fx = new Effects(this.scene, { mobile: this.mobile, reduced: this.reduced, glow: this.glowTex, crack: this.crackTex });
    this.orderMarks = new OrderMarks(
      this.labels,
      { move: this.C.brassHi, attack: this.C.danger, grant: this.C.good, upgrade: this.C.info, charge: this.C.brassHi },
      (h) => (this.field.inBoard(h) ? this.field.liftAt(h) : 0),
    );
    this.scene.add(this.orderMarks.group);
    this.geo = pieceGeometry(this.mobile);
    loadPieceModel()
      .then((g) => {
        if (!g || this.disposed) return;
        // normalise the sculpted base to the procedural base's footprint
        g = g.clone();
        g.computeBoundingBox();
        const bb = g.boundingBox!;
        const s = 0.6 / Math.max(1e-3, bb.max.y - bb.min.y);
        g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
        g.scale(s, s, s);
        g.computeVertexNormals();
        this.geo.base.dispose();
        this.geo.base = g;
        for (const p of this.pieces.values()) p.base.geometry = g;
        this.shadowDirty = true;
        this.requestRender();
      })
      .catch(() => undefined);

    // ---- camera + controls
    this.rig = new OrbitRig(this.camera);
    if (this.preview) this.rig.margin = 3.6;
    this.controls = new OrbitControls(this.canvas, this.rig, {
      tap: (e, downAt) => this.tap(e, downAt),
      hover: (x, y, type) => {
        if (type === 'leave') this.setHover(null);
        else if (!this.preview) this.setHover(this.pick(x, y));
      },
      dragStart: () => {
        // a drag or pinch between two taps is not a double-tap
        this.lastTap.t = 0;
        if (!this.preview) this.setHover(null);
      },
      changed: () => this.bump(),
      context: (e) => this.contextAt(e.clientX, e.clientY, false),
      pressStart: (x, y) => {
        if (this.preview || !this.pick(x, y)) return false;
        this.press = pressRing(x, y);
        return true;
      },
      pressEnd: (fired) => {
        this.press?.end(fired);
        this.press = null;
      },
      longPress: (x, y) => {
        this.lastTap.t = 0;
        try {
          navigator.vibrate?.(8);
        } catch {
          /* not allowed */
        }
        this.contextAt(x, y, true);
      },
    });
    this.controls.preview = this.preview;
    this.controls.lastInput = performance.now();

    // ---- events
    this.canvas.addEventListener('webglcontextlost', this.onLost);
    this.canvas.addEventListener('webglcontextrestored', this.onRestored);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.io =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            this.inView = entries.some((e) => e.isIntersecting);
            if (this.inView) this.requestRender();
          })
        : null;
    this.io?.observe(this.el);
    // Language switch: only the tool buttons' titles change; the scene is untouched.
    this.offLang = onLang(() => this.syncButtons());
  }

  /** A tiny night-room environment so brass reads as metal (one-off PMREM bake). */
  private buildEnvironment(): void {
    const env = new Scene();
    const room = new Mesh(new BoxGeometry(12, 8, 12), new MeshBasicMaterial({ color: new Color(0.012, 0.016, 0.026), side: BackSide }));
    const panel = (w: number, h: number, c: Color, x: number, y: number, z: number, rx: number, ry: number): Mesh => {
      const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: c, side: DoubleSide }));
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, 0);
      env.add(m);
      return m;
    };
    panel(3.2, 3.2, new Color(1, 0.72, 0.42).multiplyScalar(8), -2.5, 3.9, 2, Math.PI / 2, 0); // the lamp
    panel(7, 2.2, new Color(0.25, 0.38, 0.62).multiplyScalar(1.7), 0, 1.6, -5.9, 0, 0); // night window
    panel(10, 0.5, new Color(1, 0.85, 0.6).multiplyScalar(1.4), 0, 3.5, 5.9, 0, 0); // strip
    panel(0.6, 6, new Color(1, 0.8, 0.55).multiplyScalar(2.2), 5.9, 2.5, 0, 0, -Math.PI / 2); // side sliver: brass edge highlights
    panel(0.4, 6, new Color(0.5, 0.65, 1).multiplyScalar(1.2), -5.9, 2.5, -2, 0, Math.PI / 2);
    env.add(room);
    const pmrem = new PMREMGenerator(this.renderer);
    const rt = pmrem.fromScene(env, 0.03);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.6;
    pmrem.dispose();
    env.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose();
        (o.material as Material).dispose();
      }
    });
  }

  // ================================================================== public API

  setRadius(radius: number): void {
    if (radius === this.field.radius || this.disposed) return;
    const first = this.field.radius < 0;
    // first appearance: rings rise from the centre; later changes animate ring by ring
    this.field.setRadius(radius, false);
    this.rig.radius = radius;
    this.rig.outer = this.field.outerR;
    this.fx.setBoardRadius(Math.sqrt(3) * radius + 2);
    this.rangeKey = '';
    if (this.input) this.render(this.input);
    if (this.width) {
      if (first) this.rig.auto = true;
      this.rig.refit(true);
      if (this.rig.auto) this.rig.showAll();
      this.rig.clampGoal();
    }
    this.layoutRoster(false);
    this.lightToBoard();
    this.bump();
  }

  setHover(hex: Hex | null): void {
    const same = (hex && this.hovered && hexKey(hex) === hexKey(this.hovered)) || (!hex && !this.hovered);
    if (same) return;
    this.hovered = hex;
    this.field.setHover(hex ? (this.field.index.get(hexKey(hex)) ?? -1) : -1);
    this.canvas.style.cursor = hex ? 'pointer' : '';
    this.onHover(hex);
    this.requestRender();
  }

  setSelected(hex: Hex | null): void {
    this.selected = hex;
    this.field.setSelected(hex ? (this.field.index.get(hexKey(hex)) ?? -1) : -1);
    this.onSelect(hex);
    this.requestRender();
  }

  render(input: MapInput): void {
    this.input = input;
    if (this.field.radius < 0 || this.disposed) return;
    const { myPos, range, showRange } = input;
    const rk = `${myPos ? hexKey(myPos) : '-'}|${range}|${showRange}|${this.field.cells.length}`;
    if (rk !== this.rangeKey) {
      this.rangeKey = rk;
      this.field.applyRange(myPos, range, showRange);
    }
    const onMap = new Set<number>();
    for (const p of input.players) {
      if (!p.alive || p.q === null || p.r === null) continue;
      onMap.add(p.pid);
      const hex = { q: p.q, r: p.r };
      const me = p.pid === input.myPid;
      let pc = this.pieces.get(p.pid);
      if (!pc) {
        pc = this.createPiece(p);
        const w = worldOf(hex);
        pc.place(w.x, TILE_TOP, w.z);
        pc.hex = hex;
      } else if (!pc.hex || hexKey(pc.hex) !== hexKey(hex)) {
        const w = worldOf(hex);
        if (!this.reduced) this.fx.dust(this.tmpA.set(pc.pos.x, TILE_TOP, pc.pos.z), 14, 0.8);
        pc.moveTo(w.x, TILE_TOP, w.z, this.reduced);
        pc.hex = hex;
      }
      this.syncPiece(pc, p, me, me ? (input.myHp ?? null) : null);
      pc.setCharge(input.charges?.[p.pid] ?? 0);
    }
    for (const [pid, pc] of this.pieces) {
      if (onMap.has(pid)) continue;
      this.pieces.delete(pid);
      this.dying.push(pc);
      // the killing shot is announced right after this render: fall when it lands
      const key = pc.hex ? hexKey(pc.hex) : '';
      this.after(0.001, () => {
        const fall = (): void => pc.die(this.reduced, 'topple');
        if (key && this.incoming.has(key)) this.waitImpact(key, fall);
        else fall();
      });
    }
    this.syncButtons();
    this.shadowDirty = true;
    this.requestRender();
  }

  /** Lobby: the joined players stand around the rim (positions aren't known yet). */
  setRoster(players: PublicPlayer[], myPid: number | null): void {
    if (this.disposed) return;
    this.roster = { players, myPid };
    const seen = new Set<number>();
    for (const p of players) {
      seen.add(p.pid);
      let pc = this.pieces.get(p.pid);
      if (!pc) pc = this.createPiece(p);
      this.syncPiece(pc, p, p.pid === myPid, null);
    }
    for (const [pid, pc] of this.pieces) {
      if (seen.has(pid)) continue;
      this.pieces.delete(pid);
      pc.die(this.reduced, 'sink');
      this.dying.push(pc);
    }
    this.layoutRoster(true);
    this.shadowDirty = true;
    this.requestRender();
  }

  flashCell(hex: Hex): void {
    const i = this.field.index.get(hexKey(hex));
    if (i === undefined) return;
    this.field.flash(i);
    this.requestRender();
  }

  shot(from: Hex, to: Hex, kind: 'attack' | 'grant'): void {
    const src = this.pieceAt(from);
    const dst = this.pieceAt(to);
    const s = this.tokScale;
    const a = this.tmpA.set(0, 0, 0);
    if (src) a.set(src.pos.x, src.pos.y + PIECE_TOP * s, src.pos.z);
    else {
      const w = worldOf(from);
      a.set(w.x, TILE_TOP + PIECE_TOP * s, w.z);
    }
    const w = worldOf(to);
    const b = this.tmpB.set(w.x, TILE_TOP + PIECE_MID * s, w.z);
    const A = a.clone();
    const B = b.clone();
    const key = hexKey(to);
    this.incoming.set(key, (this.incoming.get(key) ?? 0) + 1);
    const land = (): void => {
      const n = (this.incoming.get(key) ?? 1) - 1;
      if (n > 0) this.incoming.set(key, n);
      else this.incoming.delete(key);
      this.impact(to, kind, A, B);
    };
    if (kind === 'attack') {
      const wind = this.reduced ? 0 : 0.3;
      if (src && !this.reduced) {
        src.charge(B.x - A.x, B.z - A.z);
        this.fx.converge(A, this.tmpC.setRGB(1, 0.55, 0.3), 26);
        this.fx.flash(A, this.tmpC.setRGB(1, 0.5, 0.28), 1.1, 0.34);
      }
      this.after(wind, () => {
        src?.release();
        if (!this.reduced) this.fx.flash(A, this.tmpC.setRGB(1, 0.75, 0.5), 1.6, 0.25);
        this.fx.comet('attack', A, B, this.tmpC.setRGB(1, 0.42, 0.22), land);
      });
    } else {
      src?.bob();
      this.fx.comet('grant', A, B, this.tmpC.copy(this.C.good).lerp(this.C.brassHi, 0.45).multiplyScalar(1.6), land);
    }
    this.bump();
  }

  float(at: Hex, text: string, kind: 'good' | 'bad' | 'info'): void {
    const show = (): void => {
      const w = worldOf(at);
      const el = document.createElement('div');
      el.className = `b3-float ${kind}`;
      el.textContent = text;
      const key = hexKey(at);
      const stack = (this.floatStack.get(key) ?? 0) + 1;
      this.floatStack.set(key, stack);
      this.labels.appendChild(el);
      this.floats.push({ el, x: w.x, y: TILE_TOP + PIECE_TOP * Math.min(this.tokScale, 1.4) + 0.15, z: w.z, t: 0, life: 1.6, offset: (stack - 1) * 24, key });
      this.bump();
    };
    // a number for a shot still in the air pops on impact
    if (this.incoming.has(hexKey(at))) this.waitImpact(hexKey(at), show);
    else show();
  }

  ring(at: Hex, kind: 'range' | 'bad'): void {
    const w = worldOf(at);
    const y = TILE_TOP + this.field.liftAt(at) + 0.03;
    const col = (kind === 'range' ? this.C.info : this.C.danger).clone();
    this.fx.shockwave(w.x, y, w.z, col, this.reduced ? 2.2 : 6.5, this.reduced ? 0.6 : 1.4);
    if (!this.reduced) {
      this.fx.shockwave(w.x, y, w.z, col, 4.2, 1.1, 0.14);
      this.fx.sparkleUp(this.tmpA.set(w.x, TILE_TOP + 0.2, w.z), kind === 'range' ? this.tmpC.copy(this.C.info).multiplyScalar(1.4) : this.C.danger, 22, 0.6);
    }
    this.bump();
  }

  burst(at: Hex): void {
    if (this.incoming.has(hexKey(at))) {
      this.waitImpact(hexKey(at), () => this.burst(at));
      return;
    }
    const w = worldOf(at);
    const p = this.tmpA.set(w.x, TILE_TOP + 0.3, w.z);
    this.fx.flash(this.tmpB.set(w.x, TILE_TOP + PIECE_MID, w.z), this.tmpC.setRGB(1, 0.35, 0.25), 3.4, 0.7);
    this.fx.shockwave(w.x, TILE_TOP + 0.03, w.z, this.C.danger.clone(), this.reduced ? 2.2 : 5.5, 1.2);
    this.fx.smokePuff(p, 26, true, 0.45);
    this.fx.embers(p, this.tmpC.setRGB(1, 0.45, 0.2), 30, 0.5);
    this.fx.lightFlash(p, this.tmpC.setRGB(1, 0.3, 0.2), 30);
    this.flashCell(at);
    if (!this.reduced) this.rig.shake(1.4);
    this.float(at, '☠', 'bad');
  }

  shake(pid: number): void {
    const pc = this.pieces.get(pid);
    if (!pc) return;
    if (pc.hex) this.flashCell(pc.hex);
    if (this.reduced) return;
    const a = Math.random() * Math.PI * 2;
    pc.hit(Math.cos(a), Math.sin(a));
    this.fx.sparks(this.tmpA.set(pc.pos.x, pc.pos.y + PIECE_MID * this.tokScale, pc.pos.z), this.tmpC.setRGB(1, 0.5, 0.25), 18, 2.6);
    this.rig.shake(0.8);
    this.bump();
  }

  /** Menu-item hover: a light, one-shot hint on the board (cheap: one pooled ring + a lean). */
  hint(kind: BoardAction | null, at: Hex | null): void {
    const k = kind ? `${kind}:${at ? hexKey(at) : ''}` : '';
    if (k === this.previewKey) return;
    this.previewKey = k;
    const me = this.input?.myPid != null ? this.pieces.get(this.input.myPid) : undefined;
    const myPos = this.input?.myPos ?? null;
    if (!kind) {
      me?.lean(0, 1, 0);
      this.bump();
      return;
    }
    const target = kind === 'upgrade' || kind === 'charge' ? myPos : at;
    if (!target || !this.field.inBoard(target)) return;
    const w = worldOf(target);
    const y = TILE_TOP + this.field.liftAt(target) + 0.03;
    const col = kind === 'attack' ? this.C.danger : kind === 'grant' ? this.tmpC.copy(this.C.good).lerp(this.C.brassHi, 0.4) : kind === 'upgrade' ? this.C.info : this.C.brassHi;
    this.fx.shockwave(w.x, y, w.z, col.clone(), kind === 'upgrade' ? 1.6 + (this.input?.range ?? 1) * 1.6 : 1.5, this.reduced ? 0.3 : 0.7);
    if (me && myPos && kind !== 'upgrade' && kind !== 'charge') {
      const a = worldOf(myPos);
      if (!this.reduced) me.lean(w.x - a.x, w.z - a.z, kind === 'move' ? 0.12 : kind === 'attack' ? -0.1 : 0.08);
    }
    this.bump();
  }

  /** Blitz: draws your queued orders as ghosts (rebuilt only when they change). */
  setOrders(marks: OrderMark[]): void {
    if (this.disposed) return;
    if (this.orderMarks.set(marks)) this.bump();
  }

  /** Blitz replay: a shot into a cell. Hits explode like any attack; misses puff on the empty cell. */
  strike(from: Hex, to: Hex, hit: boolean, power: number): void {
    if (this.disposed) return;
    const key = hexKey(to);
    if (hit) {
      this.shot(from, to, 'attack');
      if (power > 1 && !this.reduced) {
        // a charged shot lands harder: a second, wider ring and more sparks
        this.waitImpact(key, () => {
          const w = worldOf(to);
          this.fx.shockwave(w.x, TILE_TOP + 0.04, w.z, this.tmpC.setRGB(1, 0.55, 0.2), 3 + power * 1.4, 1.1);
          this.fx.sparks(this.tmpA.set(w.x, TILE_TOP + PIECE_MID, w.z), this.tmpC.setRGB(1, 0.7, 0.35), 20 + power * 14, 5);
          this.rig.shake(0.6 + power * 0.3);
        });
      }
      return;
    }
    const src = this.pieceAt(from);
    const s = this.tokScale;
    const A = new Vector3();
    if (src) A.set(src.pos.x, src.pos.y + PIECE_TOP * s, src.pos.z);
    else {
      const wf = worldOf(from);
      A.set(wf.x, TILE_TOP + PIECE_TOP * s, wf.z);
    }
    const w = worldOf(to);
    const B = new Vector3(w.x, TILE_TOP + 0.12, w.z);
    this.incoming.set(key, (this.incoming.get(key) ?? 0) + 1);
    const land = (): void => {
      const n = (this.incoming.get(key) ?? 1) - 1;
      if (n > 0) this.incoming.set(key, n);
      else this.incoming.delete(key);
      const y = TILE_TOP + this.field.liftAt(to) + 0.03;
      // a dull thud on an empty cell: dust, smoke, a grey ring — no fire
      this.fx.shockwave(w.x, y, w.z, this.tmpC.setRGB(0.55, 0.52, 0.48), this.reduced ? 1.6 : 2.6, 0.7);
      this.fx.smokePuff(this.tmpA.set(w.x, TILE_TOP + 0.25, w.z), 16, false, 0.4);
      this.fx.dust(this.tmpA.set(w.x, TILE_TOP, w.z), 18, 1);
      this.fx.flash(B, this.tmpC.setRGB(0.9, 0.7, 0.5), 1.4, 0.3);
      this.bump();
    };
    src?.release();
    this.fx.comet('attack', A, B, this.tmpC.setRGB(1, 0.42, 0.22).multiplyScalar(power > 1 ? 1.3 : 1), land);
    this.bump();
  }

  /** Blitz replay: a bounced move — the piece sets off towards `toward` and is pushed back. */
  bounce(pid: number, toward: Hex): void {
    const pc = this.pieces.get(pid);
    if (!pc || !pc.hex || this.disposed) return;
    const a = worldOf(pc.hex);
    const b = worldOf(toward);
    if (this.reduced) {
      this.flashCell(toward);
      return;
    }
    pc.moveTo(a.x + (b.x - a.x) * 0.4, TILE_TOP, a.z + (b.z - a.z) * 0.4, false, 0.26);
    this.after(0.3, () => {
      pc.moveTo(a.x, TILE_TOP, a.z, false, 0.3);
      pc.hit(a.x - b.x, a.z - b.z);
      this.fx.dust(this.tmpA.set(a.x + (b.x - a.x) * 0.5, TILE_TOP, a.z + (b.z - a.z) * 0.5), 14, 0.9);
      this.flashCell(toward);
    });
    this.bump();
  }

  /** Quick-move feedback: a brass ring on the target and a little hop of my piece. */
  hop(at: Hex): void {
    if (!this.field.inBoard(at)) return;
    const w = worldOf(at);
    const y = TILE_TOP + this.field.liftAt(at) + 0.03;
    this.fx.shockwave(w.x, y, w.z, this.C.brassHi.clone(), 1.9, this.reduced ? 0.3 : 0.55);
    if (!this.reduced) this.fx.sparkleUp(this.tmpA.set(w.x, TILE_TOP + 0.15, w.z), this.C.brassHi, 10, 0.45);
    const me = this.input?.myPid != null ? this.pieces.get(this.input.myPid) : undefined;
    me?.bob();
    this.bump();
  }

  /** An illegal quick action: the cell flashes and my piece shakes its head. */
  deny(at: Hex): void {
    this.flashCell(at);
    const me = this.input?.myPid != null ? this.pieces.get(this.input.myPid) : undefined;
    const myPos = this.input?.myPos ?? null;
    if (me && myPos && !this.reduced) {
      const a = worldOf(myPos);
      const b = worldOf(at);
      // sideways to the target direction: a "no" wobble, not a hit
      me.lean(-(b.z - a.z) || 1, b.x - a.x, 0, 3.2);
    }
    this.bump();
  }

  destroy(): void {
    if (this.disposed) return;
    this.offLang();
    this.press?.end(false);
    this.press = null;
    if (this.expanded) this.toggleExpand();
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.ambientTimer);
    this.ro.disconnect();
    this.io?.disconnect();
    this.controls.dispose();
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const f of this.floats) f.el.remove();
    for (const p of [...this.pieces.values(), ...this.dying]) p.dispose();
    this.pieces.clear();
    this.dying.length = 0;
    this.fx.dispose();
    this.orderMarks.dispose();
    this.field.dispose();
    for (const g of Object.values(this.geo)) g.dispose();
    this.glowTex.dispose();
    this.ringTex.dispose();
    this.crackTex.dispose();
    this.blankTex.dispose();
    const seen = new Set<unknown>();
    this.scene.traverse((o: Object3D) => {
      const m = o as Mesh;
      if (m.geometry && !seen.has(m.geometry)) {
        seen.add(m.geometry);
        m.geometry.dispose();
      }
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      for (const mt of mats) {
        if (seen.has(mt)) continue;
        seen.add(mt);
        mt.dispose();
      }
    });
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.el.remove();
  }

  // ================================================================== pieces

  private createPiece(p: PublicPlayer): Piece {
    const pc = new Piece(p.pid, this.geo, this.C, this.ringTex, this.aniso, this.mobile ? 256 : 384, this.blankTex);
    this.pieces.set(p.pid, pc);
    this.pieceGroup.add(pc.root);
    this.labels.appendChild(pc.label);
    pc.spawnT = this.reduced ? 1 : -this.spawnStagger;
    if (!this.reduced) this.spawnStagger = Math.min(this.spawnStagger + 0.09, 0.9);
    return pc;
  }

  private syncPiece(pc: Piece, p: PublicPlayer, me: boolean, hp: number | null): void {
    pc.setNick(p.nickname);
    if (me !== pc.me) pc.style(me);
    pc.setHp(hp);
    if (pc.flagCode !== p.flag) {
      void pc.setFlag(p.flag).then((ok) => {
        if (ok && !this.disposed) this.requestRender();
      });
    }
  }

  private pieceAt(h: Hex): Piece | null {
    const k = hexKey(h);
    for (const p of this.pieces.values()) if (p.hex && hexKey(p.hex) === k) return p;
    return null;
  }

  /** Lobby pieces: evenly around the front of the frame, sliding out as the board grows. */
  private layoutRoster(animate: boolean): void {
    if (!this.roster || !this.preview) return;
    const list = this.roster.players.map((p) => this.pieces.get(p.pid)).filter((p): p is Piece => !!p);
    const n = list.length;
    if (!n) return;
    // around the whole rim, like a council at the table (offset so nobody stands dead-centre in front)
    const R = this.field.outerR + 0.45 + 0.5 * this.tokScale;
    const step = n <= 2 ? Math.min(0.6, (1.4 * this.tokScale) / Math.max(R, 1)) : (Math.PI * 2) / n;
    list.forEach((pc, i) => {
      const a = Math.PI / 2 + (n <= 2 ? (i - (n - 1) / 2) * step : (i + 0.5) * step);
      const x = Math.cos(a) * R;
      const z = Math.sin(a) * R;
      const y = -0.46;
      const far = Math.hypot(pc.to.x - x, pc.to.z - z) > 0.05;
      if (pc.spawnT < 1 || !animate || !far) pc.place(x, y, z);
      else pc.moveTo(x, y, z, this.reduced, 0.45);
    });
  }

  // ================================================================== effects

  private after(sec: number, fn: () => void): void {
    if (sec <= 0) fn();
    else this.timeline.push({ t: sec, fn });
    this.bump();
  }

  private waitImpact(key: string, fn: () => void): void {
    const check = (): void => {
      if (!this.incoming.has(key) || this.disposed) fn();
      else this.after(0.05, check);
    };
    this.after(0.05, check);
  }

  private impact(at: Hex, kind: 'attack' | 'grant', from: Vector3, to: Vector3): void {
    const w = worldOf(at);
    const y = TILE_TOP + this.field.liftAt(at) + 0.025;
    const dst = this.pieceAt(at);
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    if (kind === 'attack') {
      this.fx.flash(to, this.tmpC.setRGB(1, 0.62, 0.4), 3.2, 0.5);
      this.fx.lightFlash(to, this.tmpC.setRGB(1, 0.45, 0.22), 38);
      this.fx.shockwave(w.x, y, w.z, this.tmpC.setRGB(1, 0.32, 0.18), this.reduced ? 2.2 : 4.6, this.reduced ? 0.5 : 0.85);
      if (!this.reduced) this.fx.shockwave(w.x, y, w.z, this.tmpC.setRGB(1, 0.75, 0.45), 2.6, 0.5, 0.05);
      this.fx.crack(w.x, y - 0.012, w.z, this.tmpC.setRGB(1, 0.36, 0.12));
      this.fx.sparks(to, this.tmpC.setRGB(1, 0.6, 0.3), 46, 4.4);
      this.fx.embers(this.tmpA.set(w.x, TILE_TOP + 0.4, w.z), this.tmpC.setRGB(1, 0.38, 0.14), 16, 0.4);
      this.fx.smokePuff(this.tmpA.set(w.x, TILE_TOP + 0.6, w.z), 9, true, 0.3);
      this.flashCell(at);
      if (dst && !this.reduced) dst.hit(dx, dz);
      if (!this.reduced) this.rig.shake(1);
    } else {
      const gold = this.tmpC.copy(this.C.brassHi).lerp(this.C.good, 0.35);
      this.fx.flash(to, gold, 2.2, 0.6);
      this.fx.lightFlash(to, gold, 16);
      this.fx.shockwave(w.x, y, w.z, this.tmpC.copy(this.C.good).lerp(this.C.brassHi, 0.5), this.reduced ? 2 : 3.6, this.reduced ? 0.6 : 1.1);
      this.fx.sparkleUp(this.tmpA.set(w.x, TILE_TOP + 0.2, w.z), this.tmpC.copy(this.C.brassHi).lerp(this.C.good, 0.4), 34, 0.55);
      dst?.bob();
    }
    this.shadowDirty = true;
    this.bump();
  }

  // ================================================================== camera & view

  private toggleFocus(): void {
    const me = this.input?.myPos ?? null;
    if (this.rig.zoomedIn() < 0.03 && me) {
      const w = worldOf(me);
      Object.assign(this.rig.goal, { tx: w.x, tz: w.z, d: Math.max(this.rig.minD, this.rig.fit.d * 0.42) });
      this.rig.auto = false;
    } else this.rig.showAll();
    this.rig.clampGoal();
    this.bump();
  }

  private syncButtons(): void {
    const me = this.input?.myPos ?? null;
    const zoomed = this.rig.zoomedIn() >= 0.03;
    const label = t(me && !zoomed ? 'board.centreMe' : 'board.wholeMap');
    this.focusBtn.setAttribute('aria-label', label);
    this.focusBtn.title = t('board.focusTitle', { label });
    this.focusBtn.textContent = me && !zoomed ? '◎' : '⤢';
    this.focusBtn.hidden = !me && !zoomed;
    const ex = !!this.expanded;
    this.expandBtn.classList.toggle('on', ex);
    const el = t(ex ? 'board.exitExpand' : 'board.expand');
    this.expandBtn.setAttribute('aria-label', el);
    this.expandBtn.title = el;
    this.expandBtn.setAttribute('aria-pressed', String(ex));
  }

  private toggleExpand(): void {
    if (this.expanded) {
      const { layer, parent, next } = this.expanded;
      this.expanded = null;
      parent.insertBefore(this.el, next);
      layer.remove();
      document.body.classList.remove('b3-expanded');
      window.removeEventListener('keydown', this.onExpandKey, true);
    } else {
      const parent = this.el.parentElement;
      if (!parent) return;
      const layer = document.createElement('div');
      layer.className = 'b3-expand-layer';
      // keep a fixed action bar (phones) usable below the expanded map
      const bar = document.querySelector<HTMLElement>('.actions-card');
      if (bar && getComputedStyle(bar).position === 'fixed' && bar.offsetHeight) layer.style.bottom = `${bar.offsetHeight}px`;
      this.expanded = { layer, parent, next: this.el.nextSibling };
      layer.appendChild(this.el);
      document.body.appendChild(layer);
      document.body.classList.add('b3-expanded');
      window.addEventListener('keydown', this.onExpandKey, true);
    }
    this.syncButtons();
    this.expandBtn.focus({ preventScroll: true });
    this.bump();
  }

  private readonly onExpandKey = (e: KeyboardEvent): void => {
    // an open action menu takes Esc first
    if (e.key !== 'Escape' || !this.expanded || document.body.classList.contains('am-open')) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.toggleExpand();
  };

  private resize(): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h || (w === this.width && h === this.height)) return;
    const wasFit = this.rig.auto;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fx.setScale(h * this.renderer.getPixelRatio(), FOV);
    if (this.field.radius >= 0) {
      this.rig.refit(true);
      if (wasFit || !this.introDone) this.rig.showAll();
      this.rig.clampGoal();
      if (!this.introDone) {
        this.introDone = true;
        Object.assign(this.rig.cur, this.rig.goal);
        if (!this.reduced) {
          // a slow cinematic swing in
          this.rig.cur.d = this.rig.fit.d * 1.35;
          this.rig.cur.tilt = Math.max(0.3, TILT_DEFAULT - 0.22);
          this.rig.cur.az = this.rig.goal.az - 0.55;
        }
      }
    }
    this.syncButtons();
    this.requestRender();
  }

  /** Points the key light (and its shadow camera) at the current board size. */
  private lightToBoard(): void {
    const S = this.field.outerR + (this.preview ? 1.5 : 0.3);
    this.key.position.set(-S * 0.55, S * 2.3 + 6, S * 0.85 + 3);
    this.key.target.position.set(0, 0, -S * 0.08);
    const dist = this.key.position.distanceTo(this.key.target.position);
    this.key.angle = Math.min(1.2, Math.atan((S * 1.5) / dist));
    this.key.shadow.camera.near = Math.max(1, dist - S * 1.6);
    this.key.shadow.camera.far = dist + S * 1.6;
    this.key.shadow.camera.updateProjectionMatrix();
    this.shadowDirty = true;
  }

  // ================================================================== input

  private ndc(x: number, y: number): Vector2 {
    const r = this.canvas.getBoundingClientRect();
    return new Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  private pick(clientX: number, clientY: number): Hex | null {
    if (this.field.radius < 0 || clientX < 0) return null;
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    // pieces first: a banner stands in front of the cell behind it
    const targets: Object3D[] = [];
    for (const p of this.pieces.values()) if (p.hex) targets.push(p.base, p.flag);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (hit) {
      const p = this.pieces.get(hit.object.userData.pid as number);
      if (p?.hex) return p.hex;
    }
    const plane = this.tmpV;
    const t = -(this.raycaster.ray.origin.y - TILE_TOP) / this.raycaster.ray.direction.y;
    if (!Number.isFinite(t) || t < 0) return null;
    this.raycaster.ray.at(t, plane);
    const h = hexAt(plane.x, plane.z);
    return this.field.inBoard(h) ? h : null;
  }

  /**
   * One path for mouse and touch. A single tap/click toggles the cell's selection at once
   * (no delay). A second one on the SAME cell whose press starts within the window after
   * the first one's release (Android's rule; event times, so a janky frame doesn't matter),
   * with no drag/pinch in between — dragStart clears lastTap — is a double: the cell is (re)selected and
   * onActivate fires (the game moves there). A double on the table outside the grid
   * toggles centre-on-me / whole map. Camera never moves for a double on a cell.
   * Real phones: the window is 350 ms (touch events can land late on a busy frame) and the
   * second tap may hit a neighbouring cell's edge — within the finger slop it still counts as
   * a double on the FIRST tap's cell, so the first tap's selection never steals the second.
   */
  private tap(e: PointerEvent, downAt: number): void {
    this.bump();
    if (this.preview) return;
    const now = e.timeStamp || performance.now();
    const lt = this.lastTap;
    const hex = this.pick(e.clientX, e.clientY);
    const key = hex ? hexKey(hex) : null;
    const touch = e.pointerType !== 'mouse';
    const windowMs = touch ? 350 : 450;
    const gap = Math.hypot(e.clientX - lt.x, e.clientY - lt.y);
    const near = gap < (touch ? 36 : 12);
    // same cell, or (touch) a near miss on the neighbour: the first tap's cell wins
    const sameTarget = key === lt.key || (touch && near && lt.hex !== null && hex !== null && gap < 24);
    const dbl = lt.t > 0 && (downAt || now) - lt.t < windowMs && near && sameTarget;
    if (dbl) {
      this.lastTap.t = 0;
      const target = lt.hex ?? hex;
      if (target) {
        if (!this.selected || hexKey(this.selected) !== hexKey(target)) this.setSelected(target);
        this.onActivate({ hex: target, x: e.clientX, y: e.clientY, touch });
      } else this.toggleFocus();
      return;
    }
    this.lastTap = { t: now, x: e.clientX, y: e.clientY, key, hex };
    if (!hex) return;
    const same = this.selected && hexKey(this.selected) === key;
    this.setSelected(same ? null : hex);
  }

  /** Right-click / long-press: select the cell (the menu's target) and ask for the menu. */
  private contextAt(x: number, y: number, touch: boolean): void {
    if (this.preview) return;
    const hex = this.pick(x, y);
    if (!hex) return;
    if (!this.selected || hexKey(this.selected) !== hexKey(hex)) this.setSelected(hex);
    this.onMenu({ hex, x, y, touch });
  }

  // ================================================================== loop

  private readonly onVisibility = (): void => {
    this.hidden = document.hidden;
    if (this.hidden) {
      cancelAnimationFrame(this.raf);
      clearTimeout(this.ambientTimer);
      this.raf = 0;
      this.ambientTimer = 0;
    } else {
      this.last = 0;
      this.requestRender();
    }
  };

  private readonly onLost = (e: Event): void => {
    e.preventDefault();
    this.lost = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    setTimeout(() => {
      if (this.lost && !this.disposed) this.el.dispatchEvent(new Event('board-failed', { bubbles: true }));
    }, 4000);
  };

  private readonly onRestored = (): void => {
    this.lost = false;
    this.shadowDirty = true;
    this.requestRender();
  };

  /** Something happened: draw now and keep the ambient loop at full rate for a while. */
  private bump(): void {
    this.lastActivity = performance.now();
    this.requestRender();
  }

  private requestRender(): void {
    if (this.raf || this.hidden || this.lost || this.disposed || !this.width) return;
    if (this.ambientTimer) {
      clearTimeout(this.ambientTimer);
      this.ambientTimer = 0;
    }
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Idle animation allowed? (flags waving, dust, lobby turntable) */
  private ambientOn(): boolean {
    return !this.reduced && !this.hidden && this.inView && !this.lost && (this.pieces.size > 0 || this.preview);
  }

  private readonly tick = (now: number): void => {
    this.raf = 0;
    if (this.disposed || this.field.radius < 0) return;
    if (!this.warmed) {
      // compile every material once, effects included (pooled, invisible), so the first
      // attack never stalls on a shader compile (async where KHR_parallel_shader_compile exists)
      this.warmed = true;
      this.renderer.compileAsync(this.scene, this.camera).catch(() => undefined);
    }
    const dt = (this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60) * this.timeScale;
    this.last = now;

    // timeline
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const e = this.timeline[i];
      e.t -= dt;
      if (e.t <= 0) {
        this.timeline.splice(i, 1);
        e.fn();
      }
    }

    // lobby turntable: a slow drift once nobody has touched the board for a few seconds
    if (this.preview && !this.reduced && now - this.controls.lastInput > 6000 && !this.controls.dragging) {
      this.rig.goal.az += dt * 0.05;
      if (this.rig.auto) this.rig.showAll();
    }

    let active = this.rig.update(dt, this.reduced);
    const fog = this.scene.fog as Fog;
    const span = this.field.outerR;
    fog.near = this.rig.cur.d + span * 0.5;
    fog.far = fog.near + span * 3 + 30;
    const f = this.field.update(dt);
    if (f.active) active = true;
    if (f.frameMoved) {
      this.lightToBoard();
      this.layoutRoster(false);
      this.rig.outer = this.field.outerR;
      if (this.rig.auto) this.rig.showAll();
      else this.rig.refit();
    }

    // zoom compensation: pieces grow when a cell is small on screen (phones, whole map)
    const c = this.rig.cur;
    const pa = this.tmpV.set(c.tx, TILE_TOP, c.tz).project(this.camera);
    const ax = pa.x;
    const ay = pa.y;
    const pb = this.tmpV.set(c.tx + Math.cos(c.az), TILE_TOP, c.tz - Math.sin(c.az)).project(this.camera);
    const ppc = (Math.hypot((pb.x - ax) * this.width, (pb.y - ay) * this.height) / 2) || 1;
    const ts = 1.3 * clamp(40 / ppc, 1, 1.75);
    if (Math.abs(ts - this.tokScale) > 0.004) {
      this.tokScale = ts;
      this.shadowDirty = true;
    }
    const compact = ppc < 30;
    if (compact !== this.labels.classList.contains('compact')) {
      this.labels.classList.toggle('compact', compact);
      for (const p of this.pieces.values()) p.labelDirty = true;
    }

    // pieces
    const scale = this.preview ? this.tokScale * 1.1 : this.tokScale;
    for (const p of this.pieces.values()) {
      if (p.hex && p.moveT >= 1) p.pos.y = TILE_TOP + this.field.liftAt(p.hex);
      const r = p.update(dt, scale, c.az, this.reduced);
      if (r.active) active = true;
      if (r.shadow) this.shadowDirty = true;
      if (r.landed) this.landed(p);
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const p = this.dying[i];
      p.update(dt, scale, c.az, this.reduced);
      if (p.dieT >= 0) this.shadowDirty = true;
      if (p.dead) {
        p.dispose();
        this.dying.splice(i, 1);
      } else active = true;
    }

    if (this.fx.update(dt)) active = true;
    if (this.timeline.length) active = true;

    // floats: pop in with a little overshoot, rise, fade
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const fl = this.floats[i];
      fl.t += dt;
      const k = clamp01(fl.t / fl.life);
      const rise = this.reduced ? 0 : ease.outCubic(k) * 0.9;
      this.tmpV.set(fl.x, fl.y + rise, fl.z).project(this.camera);
      const x = ((this.tmpV.x + 1) / 2) * this.width;
      const y = ((1 - this.tmpV.y) / 2) * this.height;
      const pop = this.reduced ? 1 : k < 0.18 ? 0.4 + ease.outBack(k / 0.18) * 0.6 : 1;
      const op = k < 0.08 ? k / 0.08 : 1 - clamp01((k - 0.6) / 0.4);
      fl.el.style.transform = `translate3d(${x.toFixed(1)}px, ${(y - fl.offset).toFixed(1)}px, 0) translate(-50%, -50%) scale(${pop.toFixed(3)})`;
      fl.el.style.opacity = op.toFixed(3);
      if (k >= 1) {
        fl.el.remove();
        this.floats.splice(i, 1);
        const n = (this.floatStack.get(fl.key) ?? 1) - 1;
        if (n > 0) this.floatStack.set(fl.key, n);
        else this.floatStack.delete(fl.key);
      } else active = true;
    }

    // ambient clocks advance only on drawn frames
    flagClock.value += dt;
    this.fx.moteTime.value += dt;
    this.field.uTime.value += dt;

    if (this.shadowDirty) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
    }
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
    if (Math.abs(c.az - this.lastAz) > 1e-3 || Number.isNaN(this.lastAz)) {
      this.lastAz = c.az;
      this.compassNeedle.style.transform = `rotate(${((c.az * 180) / Math.PI).toFixed(1)}deg)`;
    }
    this.frames++;
    this.el.dataset.frames = String(this.frames);

    if (active) {
      this.lastActivity = now;
      this.requestRender();
    } else {
      this.last = 0;
      this.spawnStagger = 0;
      this.syncButtons();
      if (this.ambientOn()) {
        // idle: ~30 fps, ~15 fps after 45 s without input or events
        const slow = now - Math.max(this.lastActivity, this.controls.lastInput) > 45000;
        this.ambientTimer = window.setTimeout(() => {
          this.ambientTimer = 0;
          this.last = performance.now() - (slow ? 66 : 33);
          this.requestRender();
        }, slow ? 66 : 33);
      }
    }
  };

  private landed(p: Piece): void {
    if (this.reduced) return;
    const at = this.tmpA.set(p.pos.x, p.pos.y, p.pos.z);
    this.fx.dust(at, 16, 1);
    if (p.me) this.fx.sparkleUp(at, this.C.brassHi, 10, 0.4);
    if (p.hex) this.fx.shockwave(p.pos.x, p.pos.y + 0.02, p.pos.z, this.tmpC.setRGB(0.5, 0.42, 0.3), 1.8, 0.5);
  }

  /**
   * Places the HTML name labels over the pieces. Labels never pile up: they are laid out by
   * priority (mine, the selected / hovered cell, pieces in my range, the rest), and one that
   * would overlap an already placed label shrinks to the player's initials, or to a dot.
   */
  private updateLabels(): void {
    // blitz order badges sit on their cells
    for (const b of this.orderMarks.badges) {
      // over a piece standing on the target: float above its flag, clear of its name label
      const lift = !b.self && this.pieceAt(b.hex) ? PIECE_TOP * this.tokScale + 0.25 : 0;
      this.tmpV.set(b.x, b.y + lift, b.z).project(this.camera);
      if (this.tmpV.z > 1) {
        b.el.style.visibility = 'hidden';
        continue;
      }
      b.el.style.visibility = '';
      b.el.style.transform = `translate3d(${(((this.tmpV.x + 1) / 2) * this.width).toFixed(1)}px, ${(((1 - this.tmpV.y) / 2) * this.height).toFixed(1)}px, 0) translate(-50%, -50%)`;
    }
    const s = this.preview ? this.tokScale * 1.1 : this.tokScale;
    const off = 4 + 6 * (s - 1);
    const sel = this.selected ? hexKey(this.selected) : null;
    const hov = this.hovered ? hexKey(this.hovered) : null;
    const myPos = this.input?.myPos ?? null;
    const range = this.input?.range ?? 0;
    const items: Array<{ p: Piece; x: number; y: number; pri: number }> = [];
    for (const list of [this.pieces.values(), this.dying.values()]) {
      for (const p of list) {
        const pos = p.root.position;
        this.tmpV.set(pos.x, pos.y - 0.02, pos.z).project(this.camera);
        if (this.tmpV.z > 1 || p.spawnT <= 0) {
          p.label.style.visibility = 'hidden';
          continue;
        }
        const x = ((this.tmpV.x + 1) / 2) * this.width;
        const y = ((1 - this.tmpV.y) / 2) * this.height;
        const k = p.hex ? hexKey(p.hex) : null;
        let pri = 1;
        if (p.dieT >= 0) pri = 0;
        else if (p.me) pri = 100;
        else if (k !== null && k === sel) pri = 90;
        else if (k !== null && k === hov) pri = 80;
        else if (myPos && p.hex && hexDistance(myPos, p.hex) <= range) pri = 50;
        items.push({ p, x, y, pri });
      }
    }
    items.sort((a, b) => b.pri - a.pri || a.y - b.y);
    const placed: Array<[number, number, number, number]> = [];
    const free = (l: number, t: number, w: number, h: number): boolean => {
      for (const [pl, pt, pw, ph] of placed) if (l < pl + pw && l + w > pl && t < pt + ph && t + h > pt) return false;
      return true;
    };
    const pad = 2;
    for (const { p, x, y, pri } of items) {
      if (p.labelDirty) this.measureLabel(p);
      const z = p.labelSize;
      let mode: Piece['labelMode'] = 'full';
      if (pri >= 80) mode = 'full';
      else if (free(x - z.fw / 2 - pad, y + off - pad, z.fw + pad * 2, z.fh + pad * 2)) mode = 'full';
      else if (free(x - z.mw / 2 - pad, y + off - pad, z.mw + pad * 2, z.mh + pad * 2)) mode = 'mini';
      else mode = 'dot';
      if (mode === 'full') placed.push([x - z.fw / 2 - pad, y + off - pad, z.fw + pad * 2, z.fh + pad * 2]);
      else if (mode === 'mini') placed.push([x - z.mw / 2 - pad, y + off - pad, z.mw + pad * 2, z.mh + pad * 2]);
      if (mode !== p.labelMode) {
        p.labelMode = mode;
        p.label.classList.toggle('mini', mode === 'mini');
        p.label.classList.toggle('dot', mode === 'dot');
      }
      p.label.style.visibility = '';
      p.label.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, ${off.toFixed(1)}px)`;
    }
  }

  /** Measures a label's full and initials sizes once (after its text / style changed). */
  private measureLabel(p: Piece): void {
    const el = p.label;
    el.classList.remove('mini', 'dot');
    const fw = el.offsetWidth;
    const fh = el.offsetHeight;
    el.classList.add('mini');
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    el.classList.remove('mini');
    if (p.labelMode !== 'full') el.classList.add(p.labelMode);
    // not laid out yet (hidden board): try again next frame
    if (!fw) return;
    p.labelSize = { fw, fh, mw, mh };
    p.labelDirty = false;
  }
}
