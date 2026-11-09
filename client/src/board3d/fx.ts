// Pooled visual effects. Nothing here allocates per frame:
// - two particle pools (additive sparks/embers/motes, and alpha-blended smoke/dust), each a
//   single Points draw with CPU-integrated typed arrays;
// - comets (attack: ember comet with a smoky trail; grant: a stream of golden motes) that
//   fly a quadratic arc and call back on arrival;
// - shockwave rings, glowing crack decals, flash sprites, an impact light;
// - dust motes drifting in the lamp cone (GPU-animated, no CPU per frame).

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PlaneGeometry,
  PointLight,
  Points,
  type Scene,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  type Texture,
  Vector3,
} from 'three';
import { clamp01, ease } from './util.ts';

// ------------------------------------------------------------------ particles

const PVERT = `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aAlpha > 0.001 ? aSize * uScale / max(0.1, -mv.z) : 0.0;
  }`;
const PFRAG_ADD = `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p) * 2.0;
    float a = (1.0 - smoothstep(0.0, 1.0, d));
    a = a * a * vAlpha;
    gl_FragColor = vec4(vColor * a * (1.0 + 2.0 * (1.0 - smoothstep(0.0, 0.35, d))), 1.0);
  }`;
const PFRAG_SMOKE = `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p) * 2.0;
    float a = (1.0 - smoothstep(0.2, 1.0, d)) * vAlpha;
    gl_FragColor = vec4(vColor, a);
  }`;

export interface Emit {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  g: number;
  b: number;
  life: number;
  size: number;
  /** size at end of life (multiplier) */
  grow: number;
  grav: number;
  drag: number;
  alpha: number;
}

class Pool {
  readonly points: Points;
  private readonly n: number;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size0: Float32Array;
  private readonly grow: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly a0: Float32Array;
  private next = 0;
  alive = 0;
  readonly mat: ShaderMaterial;
  private readonly geo: BufferGeometry;
  private readonly attrs: BufferAttribute[];

  constructor(n: number, additive: boolean) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.grow = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.geo = new BufferGeometry();
    const mk = (arr: Float32Array, k: number): BufferAttribute => new BufferAttribute(arr, k).setUsage(DynamicDrawUsage);
    this.attrs = [mk(this.pos, 3), mk(this.col, 3), mk(this.size, 1), mk(this.alpha, 1)];
    this.geo.setAttribute('position', this.attrs[0]);
    this.geo.setAttribute('aColor', this.attrs[1]);
    this.geo.setAttribute('aSize', this.attrs[2]);
    this.geo.setAttribute('aAlpha', this.attrs[3]);
    this.mat = new ShaderMaterial({
      uniforms: { uScale: { value: 400 } },
      vertexShader: PVERT,
      fragmentShader: additive ? PFRAG_ADD : PFRAG_SMOKE,
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
    });
    this.points = new Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
    this.points.visible = false;
  }

  emit(e: Emit): void {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    if (this.alpha[i] <= 0) this.alive++;
    const i3 = i * 3;
    this.pos[i3] = e.x;
    this.pos[i3 + 1] = e.y;
    this.pos[i3 + 2] = e.z;
    this.vel[i3] = e.vx;
    this.vel[i3 + 1] = e.vy;
    this.vel[i3 + 2] = e.vz;
    this.col[i3] = e.r;
    this.col[i3 + 1] = e.g;
    this.col[i3 + 2] = e.b;
    this.age[i] = 0;
    this.life[i] = e.life;
    this.size0[i] = e.size;
    this.size[i] = e.size;
    this.grow[i] = e.grow;
    this.grav[i] = e.grav;
    this.drag[i] = e.drag;
    this.a0[i] = e.alpha;
    this.alpha[i] = e.alpha;
    this.points.visible = true;
  }

  update(dt: number): boolean {
    if (this.alive <= 0) {
      this.alive = 0;
      this.points.visible = false;
      return false;
    }
    let alive = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.alpha[i] <= 0) continue;
      const a = (this.age[i] += dt);
      const L = this.life[i];
      if (a >= L) {
        this.alpha[i] = 0;
        continue;
      }
      alive++;
      const i3 = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= dr;
      this.vel[i3 + 1] = this.vel[i3 + 1] * dr - this.grav[i] * dt;
      this.vel[i3 + 2] *= dr;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < 0.24 && this.grav[i] > 0) {
        // bounce sparks off the table
        this.pos[i3 + 1] = 0.24;
        this.vel[i3 + 1] *= -0.35;
      }
      const k = a / L;
      this.size[i] = this.size0[i] * (1 + (this.grow[i] - 1) * k);
      // quick fade-in, long fade-out
      this.alpha[i] = this.a0[i] * Math.min(1, k * 10) * (1 - k) ** 1.4 + 1e-4;
    }
    this.alive = alive;
    for (const at of this.attrs) at.needsUpdate = true;
    if (!alive) this.points.visible = false;
    return alive > 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ------------------------------------------------------------------ comets

type CometKind = 'attack' | 'grant';

interface Comet {
  on: boolean;
  kind: CometKind;
  a: Vector3;
  c: Vector3;
  b: Vector3;
  t: number;
  dur: number;
  heads: Sprite[];
  mats: SpriteMaterial[];
  onArrive: (() => void) | null;
  emitAcc: number;
}

interface Ring {
  on: boolean;
  mesh: Mesh;
  mat: ShaderMaterial;
  t: number;
  dur: number;
  from: number;
  to: number;
  delay: number;
}

interface Decal {
  on: boolean;
  mesh: Mesh;
  mat: MeshBasicMaterial;
  t: number;
  dur: number;
  color: Color;
}

interface Flash {
  on: boolean;
  s: Sprite;
  mat: SpriteMaterial;
  t: number;
  dur: number;
  size: number;
}

const RING_FRAG = `
  uniform vec3 uColor;
  uniform float uK;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float band = smoothstep(0.86, 0.97, r) * (1.0 - smoothstep(0.97, 1.0, r));
    float inner = smoothstep(0.2, 0.97, r) * 0.25;
    float a = (band + inner) * (1.0 - uK) * (1.0 - uK);
    gl_FragColor = vec4(uColor * a, 1.0);
  }`;
const RING_VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export interface FxOpts {
  mobile: boolean;
  reduced: boolean;
  glow: Texture;
  crack: Texture;
}

export class Effects {
  readonly add: Pool;
  readonly smoke: Pool;
  readonly light: PointLight;
  private lightT = 1;
  private lightI = 0;
  private readonly comets: Comet[] = [];
  private readonly rings: Ring[] = [];
  private readonly decals: Decal[] = [];
  private readonly flashes: Flash[] = [];
  private readonly ringGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly decalGeo = new PlaneGeometry(1.6, 1.6).rotateX(-Math.PI / 2);
  private readonly motes: Points;
  readonly moteTime = { value: 0 };
  private readonly moteR = { value: 10 };
  private readonly reduced: boolean;
  private readonly mobile: boolean;
  private readonly v = new Vector3();
  private readonly v2 = new Vector3();
  private readonly e: Emit = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1, life: 1, size: 0.1, grow: 1, grav: 0, drag: 0, alpha: 1 };

  constructor(
    private readonly scene: Scene,
    o: FxOpts,
  ) {
    this.reduced = o.reduced;
    this.mobile = o.mobile;
    this.add = new Pool(o.mobile ? 384 : 768, true);
    this.smoke = new Pool(o.mobile ? 128 : 256, false);
    scene.add(this.add.points, this.smoke.points);

    this.light = new PointLight(0xff7a4a, 0, 7, 2);
    this.light.castShadow = false;
    scene.add(this.light);

    for (let i = 0; i < 4; i++) {
      const mats: SpriteMaterial[] = [];
      const heads: Sprite[] = [];
      for (let j = 0; j < 3; j++) {
        const m = new SpriteMaterial({ map: o.glow, color: 0xffffff, blending: AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
        const s = new Sprite(m);
        s.visible = false;
        s.renderOrder = 7;
        scene.add(s);
        mats.push(m);
        heads.push(s);
      }
      this.comets.push({ on: false, kind: 'attack', a: new Vector3(), c: new Vector3(), b: new Vector3(), t: 0, dur: 1, heads, mats, onArrive: null, emitAcc: 0 });
    }
    for (let i = 0; i < 6; i++) {
      const mat = new ShaderMaterial({
        uniforms: { uColor: { value: new Color() }, uK: { value: 0 } },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const mesh = new Mesh(this.ringGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 4;
      scene.add(mesh);
      this.rings.push({ on: false, mesh, mat, t: 0, dur: 1, from: 0, to: 1, delay: 0 });
    }
    for (let i = 0; i < 3; i++) {
      const mat = new MeshBasicMaterial({ map: o.crack, color: 0x000000, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
      const mesh = new Mesh(this.decalGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 3;
      scene.add(mesh);
      this.decals.push({ on: false, mesh, mat, t: 0, dur: 1, color: new Color() });
    }
    for (let i = 0; i < 6; i++) {
      const mat = new SpriteMaterial({ map: o.glow, color: 0xffffff, blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, toneMapped: false });
      const s = new Sprite(mat);
      s.visible = false;
      s.renderOrder = 8;
      scene.add(s);
      this.flashes.push({ on: false, s, mat, t: 0, dur: 1, size: 1 });
    }

    // dust motes in the lamp cone: positions + seeds, animated in the vertex shader
    const N = o.mobile ? 48 : 110;
    const seeds = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) seeds[i] = Math.random();
    const mg = new BufferGeometry();
    mg.setAttribute('position', new BufferAttribute(seeds, 3));
    const mm = new ShaderMaterial({
      uniforms: { uTime: this.moteTime, uR: this.moteR, uScale: this.add.mat.uniforms.uScale },
      vertexShader: `
        uniform float uTime; uniform float uR; uniform float uScale;
        varying float vA;
        void main() {
          vec3 s = position;
          float t = uTime * (0.04 + s.y * 0.05);
          float ang = s.x * 6.2831 + t * 0.6;
          float rad = sqrt(s.z) * uR * 0.85;
          vec3 p = vec3(cos(ang) * rad, 0.6 + fract(s.y + t * 0.15) * (2.5 + uR * 0.35), sin(ang) * rad);
          p.x += sin(uTime * 0.31 + s.z * 17.0) * 0.4;
          p.z += cos(uTime * 0.27 + s.x * 13.0) * 0.4;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float h = fract(s.y + t * 0.15);
          vA = smoothstep(0.0, 0.15, h) * (1.0 - smoothstep(0.7, 1.0, h)) * (0.5 + 0.5 * sin(uTime * 1.3 + s.x * 40.0));
          gl_PointSize = (0.035 + s.z * 0.03) * uScale / max(0.1, -mv.z);
        }`,
      fragmentShader: `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = (1.0 - smoothstep(0.0, 1.0, d)) * vA * 0.55;
          gl_FragColor = vec4(vec3(1.0, 0.86, 0.62) * a, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.motes = new Points(mg, mm);
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 9;
    this.motes.visible = !o.reduced;
    scene.add(this.motes);
  }

  /** Pixel scale for point sizes (call on resize). */
  setScale(heightPx: number, fovDeg: number): void {
    this.add.mat.uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.smoke.mat.uniforms.uScale.value = this.add.mat.uniforms.uScale.value;
  }

  setBoardRadius(r: number): void {
    this.moteR.value = r;
  }

  // ---------------------------------------------------------------- emitters

  private emitter(pool: Pool, x: number, y: number, z: number, vx: number, vy: number, vz: number, col: Color, life: number, size: number, grow: number, grav: number, drag: number, alpha: number): void {
    const e = this.e;
    e.x = x;
    e.y = y;
    e.z = z;
    e.vx = vx;
    e.vy = vy;
    e.vz = vz;
    e.r = col.r;
    e.g = col.g;
    e.b = col.b;
    e.life = life;
    e.size = size;
    e.grow = grow;
    e.grav = grav;
    e.drag = drag;
    e.alpha = alpha;
    pool.emit(e);
  }

  sparks(p: Vector3, col: Color, n: number, speed = 4): void {
    if (this.reduced) return;
    n = this.mobile ? Math.ceil(n * 0.6) : n;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = 0.35 + Math.random() * 0.9;
      const sp = speed * (0.4 + Math.random() * 0.8);
      const hot = Math.random();
      this.emitter(this.add, p.x, p.y, p.z, Math.cos(a) * sp, up * sp, Math.sin(a) * sp, col, 0.45 + Math.random() * 0.6, 0.11 + hot * 0.08, 0.35, 9, 1.6, 1);
    }
  }

  embers(p: Vector3, col: Color, n: number, spread = 0.4): void {
    if (this.reduced) return;
    n = this.mobile ? Math.ceil(n * 0.6) : n;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      this.emitter(this.add, p.x + Math.cos(a) * r, p.y + Math.random() * 0.3, p.z + Math.sin(a) * r, (Math.random() - 0.5) * 0.5, 0.5 + Math.random() * 1.1, (Math.random() - 0.5) * 0.5, col, 1.2 + Math.random() * 1.2, 0.1 + Math.random() * 0.06, 0.3, -0.15, 0.9, 0.9);
    }
  }

  smokePuff(p: Vector3, n: number, dark = true, spread = 0.35): void {
    if (this.reduced) return;
    n = this.mobile ? Math.ceil(n * 0.6) : n;
    const c = this.v2.set(dark ? 0.07 : 0.32, dark ? 0.07 : 0.28, dark ? 0.08 : 0.22);
    const col = tmpColor.setRGB(c.x, c.y, c.z);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      this.emitter(this.smoke, p.x + Math.cos(a) * r, p.y + Math.random() * 0.2, p.z + Math.sin(a) * r, Math.cos(a) * 0.4, 0.4 + Math.random() * 0.6, Math.sin(a) * 0.4, col, 1.1 + Math.random() * 0.9, 0.5 + Math.random() * 0.35, 3, -0.05, 1.4, dark ? 0.6 : 0.4);
    }
  }

  /** A ring of dust kicked up at a piece's base. */
  dust(p: Vector3, n: number, strength = 1): void {
    if (this.reduced) return;
    n = this.mobile ? Math.ceil(n * 0.6) : n;
    const col = tmpColor.setRGB(0.42, 0.37, 0.29);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      const sp = (1.1 + Math.random() * 0.8) * strength;
      this.emitter(this.smoke, p.x + Math.cos(a) * 0.32, p.y + 0.04, p.z + Math.sin(a) * 0.32, Math.cos(a) * sp, 0.15 + Math.random() * 0.3, Math.sin(a) * sp, col, 0.55 + Math.random() * 0.35, 0.3 + Math.random() * 0.15, 2.4, 0.3, 4.2, 0.5);
    }
  }

  /** Sparkles rising around a point (grant arrival, spawn). */
  sparkleUp(p: Vector3, col: Color, n: number, r = 0.5): void {
    if (this.reduced) return;
    n = this.mobile ? Math.ceil(n * 0.6) : n;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = r * (0.4 + Math.random() * 0.6);
      this.emitter(this.add, p.x + Math.cos(a) * rr, p.y + Math.random() * 0.4, p.z + Math.sin(a) * rr, Math.cos(a) * 0.15, 0.7 + Math.random() * 1.2, Math.sin(a) * 0.15, col, 0.8 + Math.random() * 0.7, 0.11 + Math.random() * 0.06, 0.2, -0.3, 1.5, 1);
    }
  }

  /** Embers converging onto a point (a piece charging its shot). */
  converge(p: Vector3, col: Color, n: number): void {
    if (this.reduced) return;
    n = this.mobile ? Math.ceil(n * 0.6) : n;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const el = (Math.random() - 0.3) * 1.2;
      const r = 0.7 + Math.random() * 0.4;
      const sx = Math.cos(a) * Math.cos(el) * r;
      const sy = Math.sin(el) * r;
      const sz = Math.sin(a) * Math.cos(el) * r;
      const life = 0.28;
      this.emitter(this.add, p.x + sx, p.y + sy, p.z + sz, -sx / life, -sy / life, -sz / life, col, life, 0.12, 0.4, 0, 0, 1);
    }
  }

  // ---------------------------------------------------------------- comets

  comet(kind: CometKind, a: Vector3, b: Vector3, hot: Color, onArrive: () => void): void {
    const c = this.comets.find((x) => !x.on) ?? this.comets[0];
    if (c.on && c.onArrive) c.onArrive();
    c.on = true;
    c.kind = kind;
    c.a.copy(a);
    c.b.copy(b);
    const dist = a.distanceTo(b);
    c.c.copy(a).lerp(b, 0.5);
    c.c.y += 0.7 + dist * 0.16;
    c.t = 0;
    c.dur = this.reduced ? 0.0001 : kind === 'attack' ? 0.42 + Math.min(0.35, dist * 0.025) : 0.7 + Math.min(0.4, dist * 0.03);
    c.onArrive = onArrive;
    c.emitAcc = 0;
    for (let i = 0; i < c.heads.length; i++) {
      const on = kind === 'attack' ? i < 2 : true;
      c.heads[i].visible = on && !this.reduced;
      c.mats[i].color.copy(hot);
      if (kind === 'attack' && i === 1) c.mats[i].color.setRGB(1, 0.95, 0.85);
    }
  }

  private arc(c: Comet, t: number, out: Vector3): Vector3 {
    const u = 1 - t;
    out.set(
      u * u * c.a.x + 2 * u * t * c.c.x + t * t * c.b.x,
      u * u * c.a.y + 2 * u * t * c.c.y + t * t * c.b.y,
      u * u * c.a.z + 2 * u * t * c.c.z + t * t * c.b.z,
    );
    return out;
  }

  private updateComet(c: Comet, dt: number): void {
    c.t += dt;
    const k = clamp01(c.t / c.dur);
    if (c.kind === 'attack') {
      const e = ease.inOutSine(k) * 0.85 + k * 0.15;
      const p = this.arc(c, e, this.v);
      c.heads[0].position.copy(p);
      c.heads[1].position.copy(p);
      const pulse = 1 + Math.sin(c.t * 50) * 0.1;
      c.heads[0].scale.setScalar(1.9 * pulse);
      c.heads[1].scale.setScalar(0.62);
      // trail: hot embers + smoke, emitted at a steady rate along the path
      c.emitAcc += dt * (this.mobile ? 90 : 160);
      const prev = this.arc(c, Math.max(0, e - 0.04), this.v2);
      while (c.emitAcc >= 1) {
        c.emitAcc -= 1;
        const f = Math.random();
        const x = prev.x + (p.x - prev.x) * f;
        const y = prev.y + (p.y - prev.y) * f;
        const z = prev.z + (p.z - prev.z) * f;
        const hot = Math.random();
        tmpColor.setRGB(1, 0.35 + hot * 0.45, 0.12 + hot * 0.2);
        this.emitter(this.add, x, y, z, (Math.random() - 0.5) * 0.6, (Math.random() - 0.2) * 0.6, (Math.random() - 0.5) * 0.6, tmpColor, 0.3 + Math.random() * 0.45, 0.15 + Math.random() * 0.12, 0.25, 0.6, 2.4, 1);
        if (Math.random() < 0.35) {
          tmpColor.setRGB(0.1, 0.085, 0.08);
          this.emitter(this.smoke, x, y, z, (Math.random() - 0.5) * 0.3, 0.25 + Math.random() * 0.3, (Math.random() - 0.5) * 0.3, tmpColor, 0.8 + Math.random() * 0.6, 0.3, 3, -0.05, 1.2, 0.45);
        }
      }
    } else {
      // grant: three motes chasing each other along the arc, weaving around it
      c.emitAcc += dt * (this.mobile ? 80 : 150);
      for (let i = 0; i < 3; i++) {
        const ki = clamp01(k * 1.25 - i * 0.12);
        const e = ease.inOutSine(ki);
        const p = this.arc(c, e, this.v);
        const w = Math.sin(ki * Math.PI * 3 + i * 2.1) * 0.22 * Math.sin(Math.PI * ki);
        p.x += w;
        p.y += Math.cos(ki * Math.PI * 3 + i * 2.1) * 0.12 * Math.sin(Math.PI * ki);
        c.heads[i].position.copy(p);
        c.heads[i].scale.setScalar(ki > 0 && ki < 1 ? (i === 0 ? 1.35 : 0.95) : 0.0001);
        if (i === 0 && ki > 0 && ki < 1) {
          while (c.emitAcc >= 1) {
            c.emitAcc -= 1;
            tmpColor.copy(c.mats[0].color).lerp(GOLD, Math.random());
            this.emitter(this.add, p.x, p.y, p.z, (Math.random() - 0.5) * 0.4, -0.1 + Math.random() * 0.4, (Math.random() - 0.5) * 0.4, tmpColor, 0.55 + Math.random() * 0.5, 0.11 + Math.random() * 0.07, 0.2, 0.2, 1.5, 1);
          }
        }
      }
    }
    if (k >= 1) {
      c.on = false;
      for (const h of c.heads) h.visible = false;
      const cb = c.onArrive;
      c.onArrive = null;
      cb?.();
    }
  }

  // ---------------------------------------------------------------- one-shots

  shockwave(x: number, y: number, z: number, col: Color, to: number, dur: number, delay = 0): void {
    const r = this.rings.find((q) => !q.on) ?? this.rings[0];
    r.on = true;
    r.t = 0;
    r.dur = dur;
    r.from = 0.4;
    r.to = to;
    r.delay = delay;
    r.mesh.position.set(x, y, z);
    r.mesh.scale.setScalar(0.001);
    r.mat.uniforms.uColor.value.copy(col);
    r.mat.uniforms.uK.value = 0;
    r.mesh.visible = false;
  }

  crack(x: number, y: number, z: number, col: Color, dur = 1.2): void {
    if (this.reduced) return;
    const d = this.decals.find((q) => !q.on) ?? this.decals[0];
    d.on = true;
    d.t = 0;
    d.dur = dur;
    d.color.copy(col);
    d.mesh.position.set(x, y, z);
    d.mesh.rotation.y = Math.random() * Math.PI * 2;
    d.mesh.visible = true;
  }

  flash(p: Vector3, col: Color, size: number, dur: number): void {
    const f = this.flashes.find((q) => !q.on) ?? this.flashes[0];
    f.on = true;
    f.t = 0;
    f.dur = dur;
    f.size = size;
    f.s.position.copy(p);
    f.mat.color.copy(col);
    f.s.visible = true;
  }

  lightFlash(p: Vector3, col: Color, intensity: number): void {
    if (this.reduced) return;
    this.light.position.copy(p);
    this.light.position.y += 0.5;
    this.light.color.copy(col);
    this.lightI = intensity;
    this.lightT = 0;
  }

  /** Advances everything; returns true while any effect is alive. */
  update(dt: number): boolean {
    let active = false;
    for (const c of this.comets) {
      if (!c.on) continue;
      this.updateComet(c, dt);
      active = true;
    }
    for (const r of this.rings) {
      if (!r.on) continue;
      active = true;
      if (r.delay > 0) {
        r.delay -= dt;
        continue;
      }
      r.mesh.visible = true;
      r.t += dt;
      const k = clamp01(r.t / r.dur);
      r.mesh.scale.setScalar(r.from + (r.to - r.from) * ease.outQuint(k));
      r.mat.uniforms.uK.value = k;
      if (k >= 1) {
        r.on = false;
        r.mesh.visible = false;
      }
    }
    for (const d of this.decals) {
      if (!d.on) continue;
      active = true;
      d.t += dt;
      const k = clamp01(d.t / d.dur);
      const glow = k < 0.08 ? k / 0.08 : (1 - k) ** 2;
      d.mat.color.copy(d.color).multiplyScalar(glow * 1.6);
      if (k >= 1) {
        d.on = false;
        d.mesh.visible = false;
      }
    }
    for (const f of this.flashes) {
      if (!f.on) continue;
      active = true;
      f.t += dt;
      const k = clamp01(f.t / f.dur);
      f.s.scale.setScalar(f.size * (this.reduced ? 1 : 0.35 + 0.65 * ease.outCubic(k)));
      f.mat.opacity = (1 - k) ** 2;
      if (k >= 1) {
        f.on = false;
        f.s.visible = false;
      }
    }
    if (this.lightT < 1) {
      this.lightT = Math.min(1, this.lightT + dt / 0.55);
      this.light.intensity = this.lightI * (1 - this.lightT) ** 2;
      active = true;
    } else this.light.intensity = 0;
    if (this.add.update(dt)) active = true;
    if (this.smoke.update(dt)) active = true;
    return active;
  }

  dispose(): void {
    this.add.dispose();
    this.smoke.dispose();
    this.ringGeo.dispose();
    this.decalGeo.dispose();
    for (const c of this.comets) for (const m of c.mats) m.dispose();
    for (const r of this.rings) r.mat.dispose();
    for (const d of this.decals) d.mat.dispose();
    for (const f of this.flashes) f.mat.dispose();
    this.motes.geometry.dispose();
    (this.motes.material as ShaderMaterial).dispose();
    this.scene.remove(this.light);
  }
}

const tmpColor = new Color();
const GOLD = new Color(1, 0.82, 0.42);
