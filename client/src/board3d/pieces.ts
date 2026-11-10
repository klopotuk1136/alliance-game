// Player pieces: a turned commander's miniature per country.
//
//   finial ── spear-point brass finial
//   cloth ─── the country's flag (4:3), waving in a vertex shader (cheap: 15×8 grid)
//   pole ──── slim brass staff
//   base ──── turned brass (you) / gunmetal (others) plinth: bevelled foot, an engraved
//             groove holding an enamel band in the flag's dominant colour, cove and collar
//   glow ──── a soft ring on the tile in the country's colour (stronger for you)
//
// Everything is procedural; one geometry set shared by all pieces, a few small
// materials per piece. If /models/piece.glb exists it can replace the base (optional
// slot, see loadPieceModel) — the flag, glow and animation stay procedural.
// Animations: drop-in spawn, hop on move, wind-up before a shot, recoil and red flash
// on hit, a happy bob on a grant, topple + grey banner on elimination.

import {
  AdditiveBlending,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Shape,
  type Texture,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { Hex } from '../../../shared/hex.ts';
import { t } from '../i18n.ts';
import { flagArt } from './textures.ts';
import { clamp01, ease, initials, type Palette, shortName, TILE_TOP } from './util.ts';

export const FLAG_W = 0.8;
export const FLAG_H = 0.6;
const POLE_BASE = 0.56;
const POLE_TOP = 1.78;
const FLAG_TOP = POLE_TOP - 0.06;
/** Height of the piece's "chest" (where shots leave and land). */
export const PIECE_MID = 1.15;
export const PIECE_TOP = POLE_TOP + 0.2;

export interface PieceGeo {
  base: BufferGeometry;
  band: BufferGeometry;
  pole: BufferGeometry;
  finial: BufferGeometry;
  flag: BufferGeometry;
  glow: BufferGeometry;
  star: BufferGeometry;
}

export function pieceGeometry(mobile: boolean): PieceGeo {
  const seg = mobile ? 22 : 36;
  const prof = [
    [0, 0],
    [0.4, 0],
    [0.425, 0.018],
    [0.43, 0.06],
    [0.415, 0.085],
    [0.392, 0.092],
    [0.385, 0.1], // engraved groove (the enamel band sits here)
    [0.385, 0.118],
    [0.4, 0.125],
    [0.398, 0.145],
    [0.36, 0.168],
    [0.31, 0.172],
    [0.3, 0.2],
    [0.255, 0.226],
    [0.2, 0.262],
    [0.155, 0.31],
    [0.128, 0.37],
    [0.118, 0.43],
    [0.13, 0.465],
    [0.165, 0.48],
    [0.17, 0.505],
    [0.14, 0.53],
    [0.085, 0.548],
    [0.05, POLE_BASE + 0.01],
    [0, POLE_BASE + 0.012],
  ].map(([x, y]) => new Vector2(x, y));
  const base = new LatheGeometry(prof, seg);
  const band = new TorusGeometry(0.39, 0.016, 6, seg * 2).rotateX(Math.PI / 2).translate(0, 0.109, 0);
  const pole = new CylinderGeometry(0.017, 0.022, POLE_TOP - POLE_BASE, 8, 1).translate(0, (POLE_TOP + POLE_BASE) / 2, 0);
  const fin = [
    [0, 0],
    [0.03, 0.004],
    [0.046, 0.03],
    [0.038, 0.058],
    [0.018, 0.072],
    [0.026, 0.088],
    [0.008, 0.19],
    [0, 0.2],
  ].map(([x, y]) => new Vector2(x, y));
  const finial = new LatheGeometry(fin, mobile ? 10 : 14).translate(0, POLE_TOP - 0.01, 0);
  const flag = new PlaneGeometry(FLAG_W, FLAG_H, mobile ? 12 : 16, mobile ? 6 : 8).translate(FLAG_W / 2 + 0.012, FLAG_TOP - FLAG_H / 2, 0);
  const glow = new PlaneGeometry(1.9, 1.9).rotateX(-Math.PI / 2);
  // your own piece wears a five-point commander's star instead of the spear tip
  const st = new Shape();
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? 0.055 : 0.135;
    if (i) st.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    else st.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  st.closePath();
  const star = new ExtrudeGeometry(st, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 1, curveSegments: 1 })
    .translate(0, 0, -0.011)
    .translate(0, POLE_TOP + 0.13, 0);
  return { base, band, pole, finial, flag, glow, star };
}

/** Shared clock for every flag (one uniform object → one program for all flags). */
export const flagClock = { value: 0 };

function flagMaterial(phase: number): { mat: MeshStandardMaterial; grey: { value: number }; amp: { value: number } } {
  const mat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, metalness: 0, side: DoubleSide });
  const grey = { value: 0 };
  const amp = { value: 0.075 };
  const ph = { value: phase };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = flagClock;
    sh.uniforms.uPhase = ph;
    sh.uniforms.uGrey = grey;
    sh.uniforms.uAmp = amp;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uPhase;\nuniform float uAmp;\nvarying float vFold;')
      .replace(
        '#include <beginnormal_vertex>',
        `float fu = clamp((position.x - 0.012) / ${FLAG_W.toFixed(3)}, 0.0, 1.0);
        float fv = (position.y - ${(FLAG_TOP - FLAG_H).toFixed(3)}) / ${FLAG_H.toFixed(3)};
        float k1 = 6.2; float k2 = 11.0;
        float a1 = fu * k1 - uTime * 3.1 + uPhase + fv * 0.9;
        float a2 = fu * k2 - uTime * 4.9 + uPhase * 1.7 - fv * 1.4;
        float wv = sin(a1) * 0.7 + sin(a2) * 0.3;
        float dw = (cos(a1) * 0.7 * k1 + cos(a2) * 0.3 * k2) / ${FLAG_W.toFixed(3)};
        float env = fu * (0.65 + 0.35 * fu);
        float dz = wv * uAmp * env;
        float dzdx = uAmp * (dw * env + wv * (0.65 + 0.7 * fu) / ${FLAG_W.toFixed(3)});
        vFold = wv * env;
        vec3 objectNormal = normalize(vec3(-dzdx, 0.0, 1.0));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(1.0, 0.0, 0.0);
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(position);
        transformed.z += dz;
        // the fly end droops a touch and the cloth pulls in as it ripples
        transformed.y -= fu * fu * 0.035;
        transformed.x -= abs(dz) * 0.35 * fu;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGrey;\nvarying float vFold;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        diffuseColor.rgb *= 0.86 + 0.24 * vFold;
        float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum) * vec3(0.55, 0.56, 0.6), uGrey);`,
      );
  };
  mat.customProgramCacheKey = () => 'b3-flag';
  return { mat, grey, amp };
}

/**
 * Optional sculpted base. Off by default (no request, no console noise): set this to
 * '/models/piece.glb' after dropping a GLB into client/public/models/ to use it. The
 * first mesh's geometry replaces the turned base (normalised to its size in board.ts).
 */
export const PIECE_MODEL_URL: string | null = null;
let modelBase: Promise<BufferGeometry | null> | null = null;
export function loadPieceModel(): Promise<BufferGeometry | null> {
  const url = PIECE_MODEL_URL;
  if (!url) return Promise.resolve(null);
  if (modelBase) return modelBase;
  modelBase = (async () => {
    try {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync(url);
      let geo: BufferGeometry | null = null;
      gltf.scene.traverse((o) => {
        const m = o as Mesh;
        if (!geo && m.isMesh) geo = m.geometry;
      });
      return geo;
    } catch {
      return null;
    }
  })();
  return modelBase;
}

export type PieceAnim = 'none';

export class Piece {
  readonly pid: number;
  readonly root = new Group();
  /** Tilt/topple pivot (base centre). */
  readonly tilt = new Group();
  readonly flagPivot = new Group();
  readonly base: Mesh;
  readonly flag: Mesh;
  readonly glow: Mesh;
  private readonly finial: Mesh;
  private readonly star: Mesh;
  readonly label: HTMLDivElement;
  private readonly nameEl: HTMLSpanElement;
  private readonly iniEl: HTMLSpanElement;
  private readonly hpEl: HTMLSpanElement;
  /** Blitz: the public charge badge ("ϟ+2"). */
  private readonly chargeEl: HTMLSpanElement;
  chargeLevel = 0;
  /** Label collision avoidance (board.ts): 'full' name, 'mini' initials or a 'dot'. */
  labelMode: 'full' | 'mini' | 'dot' = 'full';
  /** Cached label sizes (px) for 'full' and 'mini'; re-measured when `labelDirty`. */
  labelSize = { fw: 0, fh: 0, mw: 0, mh: 0 };
  labelDirty = true;
  private readonly baseMat: MeshStandardMaterial;
  private readonly bandMat: MeshStandardMaterial;
  private readonly poleMat: MeshStandardMaterial;
  private readonly flagMat: MeshStandardMaterial;
  private readonly glowMat: MeshBasicMaterial;
  private readonly grey: { value: number };
  readonly amp: { value: number };
  private tex: Texture | null = null;
  readonly flagColor = new Color(0.79, 0.64, 0.36);
  flagCode = '';
  nick = '';
  me = false;
  hex: Hex | null = null;

  // motion
  readonly pos = new Vector3();
  readonly from = new Vector3();
  readonly to = new Vector3();
  moveT = 1;
  moveDur = 0.5;
  spawnT = 1;
  /** Tilt state: direction (unit, xz) and a damped spring angle. */
  private readonly tiltDir = new Vector2(1, 0);
  tiltA = 0;
  tiltV = 0;
  tiltGoal = 0;
  bobT = 1;
  hitT = 1;
  chargeT = 1;
  dieT = -1;
  private readonly dieDir = new Vector2(1, 0);
  readonly phase: number;
  private readonly C: Palette;
  private readonly axis = new Vector3();
  private readonly q = new Quaternion();
  onLanded: ((p: Piece) => void) | null = null;

  constructor(pid: number, geo: PieceGeo, C: Palette, glowTex: Texture, aniso: number, flagWidth: number, blank: Texture) {
    this.pid = pid;
    this.C = C;
    this.phase = ((pid * 2.399) % (Math.PI * 2)) + 0.3;
    this.aniso = aniso;
    this.flagWidth = flagWidth;
    this.baseMat = new MeshStandardMaterial({ roughness: 0.28, metalness: 0.95 });
    this.bandMat = new MeshStandardMaterial({ roughness: 0.25, metalness: 0.2, emissiveIntensity: 0.55 });
    this.poleMat = new MeshStandardMaterial({ roughness: 0.25, metalness: 0.95 });
    const fm = flagMaterial(this.phase);
    this.flagMat = fm.mat;
    // a plain cloth until the flag arrives; same shader variant, so no recompile later
    this.flagMat.map = blank;
    this.grey = fm.grey;
    this.amp = fm.amp;
    this.glowMat = new MeshBasicMaterial({ map: glowTex, color: 0x000000, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false });

    this.base = new Mesh(geo.base, this.baseMat);
    this.base.castShadow = true;
    this.base.receiveShadow = true;
    const band = new Mesh(geo.band, this.bandMat);
    const pole = new Mesh(geo.pole, this.poleMat);
    pole.castShadow = true;
    const finial = new Mesh(geo.finial, this.poleMat);
    finial.castShadow = true;
    this.finial = finial;
    this.star = new Mesh(geo.star, this.poleMat);
    this.star.castShadow = true;
    this.star.visible = false;
    this.flag = new Mesh(geo.flag, this.flagMat);
    this.flag.castShadow = false;
    this.flagPivot.add(this.flag, this.star);
    this.tilt.add(this.base, band, pole, finial, this.flagPivot);
    this.glow = new Mesh(geo.glow, this.glowMat);
    this.glow.position.y = 0.012;
    this.glow.renderOrder = 2;
    this.root.add(this.tilt, this.glow);
    for (const m of [this.base, pole, finial, this.flag]) m.userData.pid = pid;

    this.label = document.createElement('div');
    this.label.className = 'b3-label';
    this.nameEl = document.createElement('span');
    this.nameEl.className = 'b3-name';
    this.iniEl = document.createElement('span');
    this.iniEl.className = 'b3-ini';
    this.hpEl = document.createElement('span');
    this.hpEl.className = 'b3-hp';
    this.hpEl.hidden = true;
    this.chargeEl = document.createElement('span');
    this.chargeEl.className = 'b3-charge';
    this.chargeEl.hidden = true;
    this.label.append(this.nameEl, this.iniEl, this.hpEl, this.chargeEl);
    this.style(false);
  }

  private readonly aniso: number;
  private readonly flagWidth: number;

  setNick(n: string): void {
    if (n === this.nick) return;
    this.nick = n;
    this.nameEl.textContent = shortName(n);
    this.iniEl.textContent = initials(n);
    this.labelDirty = true;
  }

  setHp(hp: number | null): void {
    if (hp === null || !this.me) {
      if (!this.hpEl.hidden) this.labelDirty = true;
      this.hpEl.hidden = true;
      return;
    }
    if (this.hpEl.hidden) this.labelDirty = true;
    this.hpEl.hidden = false;
    const n = Math.max(0, Math.round(hp));
    const txt = n <= 6 ? '●'.repeat(n) || '○' : `♥ ${n}`;
    if (this.hpEl.textContent !== txt) {
      this.hpEl.textContent = txt;
      this.labelDirty = true;
    }
    this.hpEl.title = t('unit.hp', { n });
    this.hpEl.classList.toggle('low', n <= 1);
  }

  /** Blitz: shows the player's charge (public) as a badge and a hotter glow ring. */
  setCharge(n: number): void {
    const v = Math.max(0, Math.round(n));
    if (v === this.chargeLevel) return;
    this.chargeLevel = v;
    this.chargeEl.hidden = v === 0;
    this.chargeEl.textContent = v ? `ϟ+${v}` : '';
    this.chargeEl.dataset.level = String(v);
    this.label.classList.toggle('charged', v > 0);
    this.labelDirty = true;
    this.applyGlow(1);
  }

  /** Loads the flag; resolves true when the texture landed (for a redraw). */
  async setFlag(code: string): Promise<boolean> {
    if (code === this.flagCode) return false;
    this.flagCode = code;
    try {
      const art = await flagArt(code, this.flagWidth, this.aniso);
      if (this.flagCode !== code || this.dieT >= 1) {
        art.texture.dispose();
        return false;
      }
      this.tex?.dispose();
      this.tex = art.texture;
      this.flagMat.map = art.texture;
      this.flagMat.color.setRGB(1, 1, 1);
      this.flagMat.needsUpdate = true;
      this.flagColor.copy(art.color);
      this.style(this.me);
      return true;
    } catch {
      return false;
    }
  }

  style(me: boolean): void {
    const C = this.C;
    this.me = me;
    if (me) {
      this.baseMat.color.copy(C.brass);
      this.baseMat.emissive.copy(C.brassDim);
      this.baseMat.emissiveIntensity = 0.22;
      this.baseMat.roughness = 0.24;
      this.poleMat.color.copy(C.brassHi);
      this.poleMat.emissive.copy(C.brassDim);
      this.poleMat.emissiveIntensity = 0.3;
    } else {
      this.baseMat.color.setRGB(0.2, 0.22, 0.26);
      this.baseMat.emissive.setRGB(0, 0, 0);
      this.baseMat.emissiveIntensity = 0;
      this.baseMat.roughness = 0.3;
      this.poleMat.color.copy(C.brassDim).multiplyScalar(1.25);
      this.poleMat.emissive.setRGB(0, 0, 0);
      this.poleMat.emissiveIntensity = 0;
    }
    this.bandMat.color.copy(this.flagColor);
    this.bandMat.emissive.copy(this.flagColor);
    this.star.visible = me;
    this.finial.visible = !me;
    if (this.label.classList.contains('me') !== me) this.labelDirty = true;
    this.label.classList.toggle('me', me);
    this.root.renderOrder = me ? 1 : 0;
    this.glowBase = me ? 1 : 0.55;
    this.applyGlow(1);
  }

  private glowBase = 0.55;

  applyGlow(k: number): void {
    const c = this.glowMat.color.copy(this.flagColor);
    if (this.me) c.lerp(this.C.brassHi, 0.45);
    // a charged piece glows hot: towards ember red, brighter with each level
    if (this.chargeLevel > 0) c.lerp(this.C.danger, Math.min(0.75, 0.3 + this.chargeLevel * 0.15)).multiplyScalar(1 + this.chargeLevel * 0.55);
    c.multiplyScalar(this.glowBase * k * (this.dieT >= 0 ? 0 : 1));
  }

  /** Places the piece instantly. */
  place(x: number, y: number, z: number): void {
    this.pos.set(x, y, z);
    this.from.copy(this.pos);
    this.to.copy(this.pos);
    this.moveT = 1;
  }

  moveTo(x: number, y: number, z: number, reduced: boolean, dur = 0.55): void {
    this.from.copy(this.pos);
    this.to.set(x, y, z);
    this.moveDur = dur;
    this.moveT = reduced ? 1 : 0;
    if (reduced) this.pos.copy(this.to);
  }

  /** Leans the piece towards (dx, dz) by `angle` radians with a spring (negative = away). */
  lean(dx: number, dz: number, angle: number, kick = 0): void {
    const l = Math.hypot(dx, dz) || 1;
    this.tiltDir.set(dx / l, dz / l);
    this.tiltGoal = angle;
    this.tiltV += kick;
  }

  hit(dx: number, dz: number): void {
    this.lean(dx, dz, 0, -5.5);
    this.hitT = 0;
  }

  charge(dx: number, dz: number): void {
    this.lean(dx, dz, -0.2);
    this.chargeT = 0;
  }

  release(): void {
    this.tiltGoal = 0;
    this.tiltV += 7;
  }

  bob(): void {
    this.bobT = 0;
  }

  /** 'topple' = eliminated (falls, banner greys); 'sink' = left the lobby. */
  dieMode: 'topple' | 'sink' = 'topple';

  die(reduced: boolean, mode: 'topple' | 'sink' = 'topple'): void {
    if (this.dieT >= 0) return;
    this.dieT = 0;
    this.dieMode = mode;
    const a = this.phase * 3.1;
    this.dieDir.set(Math.cos(a), Math.sin(a));
    this.label.classList.add('dead');
    this.labelDirty = true;
    if (reduced) this.dieT = 0.999;
  }

  /**
   * Advances the piece; returns true while animating. `scale` = zoom compensation;
   * `camAz` turns the banner towards the viewer; `idle` = time for the idle sway.
   */
  update(dt: number, scale: number, camAz: number, reduced: boolean): { active: boolean; landed: boolean; shadow: boolean } {
    let active = false;
    let landed = false;
    let shadow = false;
    let y = 0;
    let s = scale;
    let squash = 0;

    if (this.spawnT < 1) {
      this.spawnT = Math.min(1, this.spawnT + dt / 0.62);
      const k = clamp01(this.spawnT);
      if (k > 0) {
        y += (1 - ease.outBounce(k)) * 2.2;
        s *= Math.min(1, 0.4 + k * 2);
        if (this.spawnT >= 1) landed = true;
      } else s = 0.0001;
      active = true;
      shadow = true;
    }
    if (this.moveT < 1) {
      this.moveT = Math.min(1, this.moveT + dt / this.moveDur);
      const k = ease.inOutCubic(this.moveT);
      this.pos.lerpVectors(this.from, this.to, k);
      const dist = Math.hypot(this.to.x - this.from.x, this.to.z - this.from.z);
      y += Math.sin(Math.PI * this.moveT) * (0.45 + Math.min(1.2, dist * 0.12));
      // squash on take-off and landing
      squash = Math.max(0, 1 - this.moveT * 8) * 0.12 + Math.max(0, this.moveT * 8 - 7) * 0.14;
      if (this.moveT >= 1) landed = true;
      active = true;
      shadow = true;
    }
    if (this.bobT < 1) {
      this.bobT = Math.min(1, this.bobT + dt / 0.7);
      y += Math.sin(Math.PI * this.bobT) * 0.28 * (1 - this.bobT * 0.3);
      this.applyGlow(1 + Math.sin(Math.PI * this.bobT) * 1.6);
      if (this.bobT >= 1) this.applyGlow(1);
      active = true;
      shadow = true;
    }
    if (this.hitT < 1) {
      this.hitT = Math.min(1, this.hitT + dt / 0.65);
      const f = (1 - this.hitT) ** 2;
      this.baseMat.emissive.setRGB(0.9 * f, 0.12 * f, 0.08 * f);
      this.baseMat.emissiveIntensity = 1.6;
      if (this.hitT >= 1) this.style(this.me);
      active = true;
    }
    if (this.chargeT < 1) {
      this.chargeT = Math.min(1, this.chargeT + dt / 0.3);
      this.applyGlow(1 + this.chargeT * 2.2);
      if (this.chargeT >= 1) this.applyGlow(1);
      active = true;
    }

    // damped spring for leaning
    if (!reduced && (Math.abs(this.tiltA - this.tiltGoal) > 1e-4 || Math.abs(this.tiltV) > 1e-3)) {
      const kS = 120;
      const kD = 13;
      const acc = (this.tiltGoal - this.tiltA) * kS - this.tiltV * kD;
      this.tiltV += acc * Math.min(dt, 1 / 30);
      this.tiltA += this.tiltV * Math.min(dt, 1 / 30);
      active = true;
      shadow = true;
    } else {
      this.tiltA = reduced ? 0 : this.tiltGoal;
      this.tiltV = 0;
    }

    let topple = 0;
    if (this.dieT >= 0 && this.dieT < 1) {
      const sinkOnly = this.dieMode === 'sink';
      const dur = sinkOnly ? 0.6 : 3.2;
      this.dieT = Math.min(1, this.dieT + dt / dur);
      const t = this.dieT * dur; // seconds
      // topple: 0–0.75 s fall with a bounce, banner greys, hold, then sink and fade from 2.2 s
      if (!sinkOnly) {
        topple = ease.outBounce(clamp01(t / 0.75)) * (Math.PI / 2 - 0.12);
        this.grey.value = clamp01(t / 0.6);
        this.amp.value = 0.075 * (1 - clamp01(t / 0.5)) + 0.012;
      }
      const sink = sinkOnly ? ease.inCubic(clamp01(t / 0.6)) : clamp01((t - 2.2) / 1);
      y -= sink * 0.9;
      s *= 1 - sink * 0.25;
      this.applyGlow(0);
      this.label.style.opacity = String(1 - clamp01(t / (sinkOnly ? 0.3 : 1.2)));
      active = true;
      shadow = true;
    }

    // compose
    this.root.position.set(this.pos.x, this.pos.y + y, this.pos.z);
    this.root.scale.set(s * (1 + squash * 0.6), s * (1 - squash), s * (1 + squash * 0.6));
    if (topple > 0) {
      this.axis.set(this.dieDir.y, 0, -this.dieDir.x);
      this.tilt.quaternion.setFromAxisAngle(this.axis, topple);
      this.tilt.position.y = Math.sin(topple) * 0.4;
    } else if (Math.abs(this.tiltA) > 1e-4) {
      this.axis.set(this.tiltDir.y, 0, -this.tiltDir.x);
      this.tilt.quaternion.setFromAxisAngle(this.axis, this.tiltA);
      this.tilt.position.y = Math.abs(Math.sin(this.tiltA)) * 0.4;
    } else {
      this.tilt.quaternion.identity();
      this.tilt.position.y = 0;
    }
    // banner faces the viewer, streaming slightly away to the right
    this.q.setFromAxisAngle(this.axis.set(0, 1, 0), camAz - 0.32);
    this.flagPivot.quaternion.copy(this.q);
    return { active, landed, shadow };
  }

  get dead(): boolean {
    return this.dieT >= 1;
  }

  dispose(): void {
    this.baseMat.dispose();
    this.bandMat.dispose();
    this.poleMat.dispose();
    this.flagMat.dispose();
    this.glowMat.dispose();
    this.tex?.dispose();
    this.label.remove();
    this.root.removeFromParent();
  }
}

export { TILE_TOP };
