// The playing field: engraved enamel hex tiles (one instanced draw for the tops + one for
// the brass bevels), a single instanced glow overlay for range / territory / hover, the
// brass-and-lacquer frame with engraved scale ticks and corner bosses, a compass rose, an
// old sea chart on the table and the baize beyond it.
//
// Radius changes animate: the frame slides out and new rings rise from under the board
// one ring after another (or sink, outermost first, before the frame closes in).

import {
  AdditiveBlending,
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Shape,
  ShaderMaterial,
  type Texture,
  Vector2,
} from 'three';
import { cellCount, gridCells, hexDistance, hexKey, type Hex } from '../../../shared/hex.ts';
import {
  baizeTexture,
  chartTexture,
  compassTexture,
  engravingTexture,
  railTexture,
} from './textures.ts';
import { clamp01, ease, frameRadius, hash01, hexShape, HOVER_LIFT, type Palette, SELECT_LIFT, SQRT3, TILE_R, TILE_TOP, worldOf } from './util.ts';

const RAIL_W = 0.95; // frame rail width
const RAIL_TOP = 0.36;
const TABLE_Y = -0.46;
const RISE_DUR = 0.46;

export interface FieldOpts {
  mobile: boolean;
  reduced: boolean;
  aniso: number;
  C: Palette;
}

/** Brass corner brackets around a pointy-top hex (the selection marker). */
function bracketGeometry(rIn: number, rOut: number, f: number): BufferGeometry {
  const pos: number[] = [];
  const corner = (i: number, r: number): [number, number] => {
    const a = (Math.PI / 180) * (60 * i - 30);
    return [r * Math.cos(a), r * Math.sin(a)];
  };
  const mix = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let i = 0; i < 6; i++) {
    const o0 = corner(i, rOut);
    const o1 = corner(i + 1, rOut);
    const i0 = corner(i, rIn);
    const i1 = corner(i + 1, rIn);
    for (const [t0, t1] of [
      [0, f],
      [1 - f, 1],
    ]) {
      const a = mix(o0, o1, t0);
      const b = mix(o0, o1, t1);
      const c = mix(i0, i1, t1);
      const d = mix(i0, i1, t0);
      pos.push(a[0], 0, a[1], b[0], 0, b[1], c[0], 0, c[1], a[0], 0, a[1], c[0], 0, c[1], d[0], 0, d[1]);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  return g;
}

/** A hex fan whose `edge` attribute is the hex distance (0 centre → 1 rim): exact per sector. */
function glowHexGeometry(r: number): BufferGeometry {
  const pos: number[] = [0, 0, 0];
  const edge: number[] = [0];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pos.push(r * Math.cos(a), 0, r * Math.sin(a));
    edge.push(1);
  }
  const idx: number[] = [];
  for (let i = 0; i < 6; i++) idx.push(0, 1 + ((i + 1) % 6), 1 + i);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('edge', new Float32BufferAttribute(edge, 1));
  g.setIndex(idx);
  return g;
}

export class Field {
  readonly group = new Group();
  /** Cells currently on the board (may include sinking rings during a shrink). */
  cells: Hex[] = [];
  readonly index = new Map<string, number>();
  ring = new Uint8Array(0);
  kind = new Uint8Array(0); // 0 plain, 1 range, 2 adjacent, 3 mine
  lift = new Float32Array(0);
  /** 0 = under the board, 1 = in place (eased, may overshoot). */
  rise = new Float32Array(0);
  private prog = new Float32Array(0);
  private dir = new Int8Array(0);
  private delay = new Float32Array(0);
  private readonly moving = new Set<number>();
  private readonly lifting = new Set<number>();
  private readonly flashes = new Map<number, number>();
  hoverIdx = -1;
  selIdx = -1;
  /** Target radius (what the game says) and the radius the meshes are built for. */
  radius = -1;
  private builtR = -1;
  private capacity = 0;
  /** Inner frame radius, animated. */
  frameR = 0;
  private frameGoal = 0;
  private tiles: InstancedMesh | null = null;
  private overlay: InstancedMesh | null = null;
  readonly selMarker: Mesh;
  private selT = 1;

  private readonly C: Palette;
  private readonly reduced: boolean;
  private readonly tileGeo: ExtrudeGeometry;
  private readonly glowGeo: BufferGeometry;
  private readonly tileTop: MeshStandardMaterial;
  private readonly tileSide: MeshStandardMaterial;
  private readonly glowMat: ShaderMaterial;
  readonly uTime = { value: 0 };
  private readonly textures: Texture[] = [];

  // frame
  private readonly floor: Mesh;
  private readonly rails: Mesh[] = [];
  private readonly strips: Mesh[] = [];
  private readonly bosses: InstancedMesh;
  private readonly compass: Mesh;
  private readonly chart: Mesh;
  private readonly railTex: Texture;
  private readonly owned: Array<{ dispose(): void }> = [];

  private readonly m = new Matrix4();
  private readonly col = new Color();
  private readonly col2 = new Color();

  constructor(o: FieldOpts) {
    this.C = o.C;
    this.reduced = o.reduced;
    const C = o.C;

    // ---- tiles
    const tile = new ExtrudeGeometry(hexShape(TILE_R - 0.035), {
      depth: 0.16,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.035,
      bevelSegments: o.mobile ? 2 : 3,
      curveSegments: 1,
    });
    tile.rotateX(-Math.PI / 2);
    tile.translate(0, 0.03, 0);
    this.tileGeo = tile;

    const engrave = engravingTexture(o.mobile ? 512 : 1024, o.aniso);
    this.textures.push(engrave);
    this.tileTop = new MeshStandardMaterial({ color: new Color('#16243f'), roughness: 0.56, metalness: 0.1 });
    const brassLine = C.brass.clone();
    this.tileTop.onBeforeCompile = (sh) => {
      sh.uniforms.uEngrave = { value: engrave };
      sh.uniforms.uEngScale = { value: o.mobile ? 1 / 5.5 : 1 / 7 };
      sh.uniforms.uBrass = { value: brassLine };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec2 vLoc;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vLoc = position.xz;
          vec4 wp4 = vec4(position, 1.0);
          #ifdef USE_INSTANCING
            wp4 = instanceMatrix * wp4;
          #endif
          vWP = (modelMatrix * wp4).xyz;`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uEngrave;\nuniform float uEngScale;\nuniform vec3 uBrass;\nvarying vec3 vWP;\nvarying vec2 vLoc;\nfloat bEng = 0.0;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          vec3 eng = texture2D(uEngrave, vWP.xz * uEngScale).rgb;
          vec2 ap = abs(vLoc);
          float hd = max(ap.x, 0.5 * ap.x + 0.8660254 * ap.y) / ${(TILE_R * 0.866).toFixed(4)};
          // fine detail fades out when a tile is small on screen (no shimmering brass moiré)
          float px = fwidth(vWP.x) + fwidth(vWP.z);
          float detail = 1.0 - smoothstep(0.035, 0.11, px);
          eng.rg *= detail;
          float grain = eng.b - 0.376;
          vec3 base = diffuseColor.rgb * (1.0 + grain * 0.35);
          // engraved contours read as fine brass inlay; hachures darken the slopes
          base = mix(base, uBrass * 0.3, eng.r * 0.32);
          base *= 1.0 - eng.g * 0.22;
          // engraved border line inside each tile
          float inl = smoothstep(0.018, 0.0, abs(hd - 0.88));
          inl *= mix(0.25, 1.0, detail);
          base = mix(base, uBrass * 0.5, inl * 0.5);
          // soft occlusion towards the rim, a faint lamp sheen in the middle
          base *= mix(1.08, 0.7, smoothstep(0.55, 1.0, hd));
          diffuseColor.rgb = base;
          bEng = max(eng.r * 0.6, inl);`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = clamp(roughnessFactor + bEng * 0.18 + (texture2D(uEngrave, vWP.xz * uEngScale * 3.1).b - 0.376) * 0.2, 0.3, 1.0);`,
        )
        .replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>
          metalnessFactor = mix(metalnessFactor, 0.9, bEng * 0.8);`,
        );
    };
    this.tileTop.customProgramCacheKey = () => 'b3-tile-top';
    this.tileSide = new MeshStandardMaterial({ color: C.brassDim.clone().multiplyScalar(0.9), roughness: 0.36, metalness: 0.9 });

    // ---- glow overlay (range / territory / hover / flashes): one draw
    this.glowGeo = glowHexGeometry(TILE_R - 0.03);
    this.glowMat = new ShaderMaterial({
      uniforms: { uTime: this.uTime },
      vertexShader: `
        attribute float edge;
        varying float vEdge;
        varying vec3 vCol;
        varying vec3 vW;
        void main() {
          vEdge = edge;
          #ifdef USE_INSTANCING_COLOR
            vCol = instanceColor;
          #else
            vCol = vec3(1.0);
          #endif
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `
        uniform float uTime;
        varying float vEdge;
        varying vec3 vCol;
        varying vec3 vW;
        void main() {
          float e = vEdge;
          // glow seeping in from the tile edges + a faint wash over the face
          float rim = pow(e, 7.0) * 1.6 + pow(e, 2.5) * 0.35;
          float fill = 0.16;
          float shimmer = 0.88 + 0.12 * sin(uTime * 1.7 + vW.x * 0.9 + vW.z * 0.6);
          vec3 c = vCol * (rim + fill) * shimmer;
          gl_FragColor = vec4(c, 1.0);
        }`,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });

    this.selMarker = new Mesh(bracketGeometry(TILE_R + 0.02, TILE_R + 0.11, 0.3), new MeshBasicMaterial({ color: C.brassHi.clone(), side: DoubleSide, toneMapped: false }));
    this.selMarker.visible = false;
    this.selMarker.renderOrder = 2;
    this.group.add(this.selMarker);

    // ---- floor under the tiles (unit hexagon, scaled with the frame)
    const floorGeo = new ExtrudeGeometry(hexShape(1, true), { depth: 0.44, bevelEnabled: false, curveSegments: 1 });
    floorGeo.rotateX(-Math.PI / 2);
    floorGeo.translate(0, -0.44, 0);
    const floorMat = new MeshStandardMaterial({ color: new Color('#070a10'), roughness: 0.8, metalness: 0.1 });
    this.floor = new Mesh(floorGeo, floorMat);
    this.floor.receiveShadow = true;
    this.owned.push(floorGeo, floorMat);

    // ---- rails: a lacquered moulding (unit length along x), with a brass strip of ticks on top
    const prof = new Shape();
    const W = RAIL_W;
    const H0 = TABLE_Y;
    prof.moveTo(0, H0);
    prof.lineTo(0, RAIL_TOP - 0.02);
    prof.lineTo(0.05, RAIL_TOP);
    prof.lineTo(W * 0.52, RAIL_TOP);
    prof.lineTo(W * 0.6, RAIL_TOP - 0.05);
    prof.lineTo(W * 0.78, RAIL_TOP - 0.07);
    prof.lineTo(W * 0.88, RAIL_TOP - 0.16);
    prof.lineTo(W, RAIL_TOP - 0.24);
    prof.lineTo(W, H0);
    prof.closePath();
    const railGeo = new ExtrudeGeometry(prof, { depth: 1, bevelEnabled: false, curveSegments: 1 });
    // shape XY → rail: x across (inner 0 → outer W), y up, z along → rotate so length runs along x
    railGeo.rotateY(Math.PI / 2);
    railGeo.translate(-0.5, 0, 0);
    // after rotateY(π/2): shape x → −z (across, inner at z=0, outer at z=−W); length along x
    const railMat = new MeshStandardMaterial({ color: new Color('#121a28'), roughness: 0.3, metalness: 0.35 });
    this.railTex = railTexture();
    this.textures.push(this.railTex);
    const stripGeo = new PlaneGeometry(1, 0.2).rotateX(-Math.PI / 2);
    const stripMat = new MeshStandardMaterial({ map: this.railTex, roughness: 0.3, metalness: 0.92, emissive: C.brassDim.clone(), emissiveIntensity: 0.12 });
    this.owned.push(railGeo, railMat, stripGeo, stripMat);
    for (let i = 0; i < 6; i++) {
      const r = new Mesh(railGeo, railMat);
      r.castShadow = false;
      r.receiveShadow = true;
      const s = new Mesh(stripGeo, stripMat);
      this.rails.push(r);
      this.strips.push(s);
      this.group.add(r, s);
    }
    // corner bosses: turned brass knobs
    const bossProf = [
      [0, TABLE_Y],
      [0.5, TABLE_Y],
      [0.5, RAIL_TOP - 0.05],
      [0.46, RAIL_TOP + 0.02],
      [0.36, RAIL_TOP + 0.06],
      [0.3, RAIL_TOP + 0.06],
      [0.27, RAIL_TOP + 0.1],
      [0.14, RAIL_TOP + 0.15],
      [0, RAIL_TOP + 0.16],
    ].map(([x, y]) => new Vector2(x, y));
    const bossGeo = new LatheGeometry(bossProf, o.mobile ? 20 : 32);
    const brassMat = new MeshStandardMaterial({ color: C.brass.clone(), roughness: 0.26, metalness: 0.95, emissive: C.brassDim.clone(), emissiveIntensity: 0.18 });
    this.bosses = new InstancedMesh(bossGeo, brassMat, 6);
    this.bosses.castShadow = true;
    this.owned.push(bossGeo, brassMat);

    // compass rose medallion on the table, north-west of the frame
    const compassTex = compassTexture(o.mobile ? 256 : 512);
    this.textures.push(compassTex);
    const compassMat = new MeshStandardMaterial({ map: compassTex, transparent: true, roughness: 0.34, metalness: 0.85, alphaTest: 0.02 });
    const compassGeo = new CircleGeometry(1.25, 48).rotateX(-Math.PI / 2);
    this.compass = new Mesh(compassGeo, compassMat);
    this.compass.receiveShadow = true;
    this.owned.push(compassMat, compassGeo);

    // the chart and the baize
    const chartTex = chartTexture(o.mobile ? 1024 : 2048, o.aniso);
    this.textures.push(chartTex);
    const chartGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const chartMat = new MeshStandardMaterial({ map: chartTex, transparent: true, roughness: 0.86, metalness: 0, depthWrite: false });
    this.chart = new Mesh(chartGeo, chartMat);
    this.chart.rotation.y = 0.07;
    this.chart.position.y = TABLE_Y + 0.004;
    this.chart.receiveShadow = true;
    this.chart.renderOrder = -1;
    const baize = baizeTexture('#0b1018', '#c9a45c', o.aniso);
    baize.repeat.set(60, 60);
    this.textures.push(baize);
    const tableGeo = new PlaneGeometry(420, 420).rotateX(-Math.PI / 2);
    const tableMat = new MeshStandardMaterial({ map: baize, roughness: 0.95, metalness: 0 });
    const table = new Mesh(tableGeo, tableMat);
    table.position.y = TABLE_Y;
    table.receiveShadow = true;
    this.owned.push(chartGeo, chartMat, tableGeo, tableMat);

    this.group.add(this.floor, this.bosses, this.compass, this.chart, table);
  }

  // ================================================================== radius

  /** Sets the board radius; animates rings in/out unless `instant`. */
  setRadius(R: number, instant: boolean): void {
    if (R === this.radius) return;
    const first = this.radius < 0;
    const old = first ? 0 : this.radius;
    this.radius = R;
    const animate = !instant && !this.reduced;
    if (R > this.builtR) this.rebuild(R, first ? -1 : this.builtR);
    // targets per cell
    const n = this.cells.length;
    const step = Math.min(0.075, 0.85 / Math.max(1, Math.abs(R - old)));
    for (let i = 0; i < n; i++) {
      const ring = this.ring[i];
      const target = ring <= R ? 1 : -1;
      if (!animate) {
        this.prog[i] = target > 0 ? 1 : 0;
        this.rise[i] = this.prog[i];
        this.dir[i] = 0;
        continue;
      }
      const atGoal = target > 0 ? this.prog[i] >= 1 && this.dir[i] >= 0 : this.prog[i] <= 0 && this.dir[i] <= 0;
      if (atGoal || this.dir[i] === target) continue;
      this.dir[i] = target;
      const jitter = hash01(this.cells[i].q + 97, this.cells[i].r - 31) * 0.05 + angleSweep(this.cells[i]) * 0.06;
      this.delay[i] =
        target > 0
          ? (first ? 0.05 : 0.14) + Math.max(0, ring - old - (first ? 0 : 1)) * step + jitter
          : Math.max(0, old - ring) * step + jitter;
      this.moving.add(i);
    }
    if (!animate) {
      if (this.builtR > R) this.rebuild(R, -2);
      for (let i = 0; i < this.cells.length; i++) this.placeCell(i);
      this.markMatrices();
      this.frameGoal = this.frameR = frameRadius(R);
      this.placeFrame();
    } else {
      this.frameGoal = frameRadius(Math.max(R, this.maxLiveRing()));
      if (first) {
        this.frameR = frameRadius(R) * 0.94;
        this.placeFrame();
      }
    }
  }

  private maxLiveRing(): number {
    let m = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.prog[i] > 0.001 || this.dir[i] > 0) m = Math.max(m, this.ring[i]);
    return m;
  }

  /**
   * Rebuilds the instanced meshes for radius R. `prevR` ≥ 0 keeps the state of the cells
   * within it (rise etc.); −1 starts everything sunk (intro); −2 keeps everything risen.
   */
  private rebuild(R: number, prevR: number): void {
    const oldIndex = new Map(this.index);
    const oldProg = this.prog;
    const oldDir = this.dir;
    const oldDelay = this.delay;
    const oldKind = this.kind;
    const oldLift = this.lift;
    const oldCells = this.cells;
    const selKey = this.selIdx >= 0 ? hexKey(oldCells[this.selIdx]) : null;
    const hovKey = this.hoverIdx >= 0 ? hexKey(oldCells[this.hoverIdx]) : null;

    this.cells = gridCells(R);
    // ring order: centre first, so the overlay draws back-to-front-ish and rings index cleanly
    this.cells.sort((a, b) => hexDistance(a, { q: 0, r: 0 }) - hexDistance(b, { q: 0, r: 0 }));
    const n = this.cells.length;
    this.index.clear();
    this.cells.forEach((h, i) => this.index.set(hexKey(h), i));
    this.ring = new Uint8Array(n);
    this.kind = new Uint8Array(n);
    this.lift = new Float32Array(n);
    this.rise = new Float32Array(n);
    this.prog = new Float32Array(n);
    this.dir = new Int8Array(n);
    this.delay = new Float32Array(n);
    const moving = [...this.moving].map((i) => hexKey(oldCells[i]));
    this.moving.clear();
    this.lifting.clear();
    this.flashes.clear();
    for (let i = 0; i < n; i++) {
      const h = this.cells[i];
      this.ring[i] = hexDistance(h, { q: 0, r: 0 });
      const j = oldIndex.get(hexKey(h));
      if (prevR === -2) this.prog[i] = 1;
      else if (j !== undefined && prevR >= 0) {
        this.prog[i] = oldProg[j];
        this.dir[i] = oldDir[j];
        this.delay[i] = oldDelay[j];
        this.kind[i] = oldKind[j];
        this.lift[i] = oldLift[j];
      } else this.prog[i] = 0;
      this.rise[i] = this.prog[i];
    }
    for (const k of moving) {
      const i = this.index.get(k);
      if (i !== undefined) this.moving.add(i);
    }
    this.selIdx = selKey ? (this.index.get(selKey) ?? -1) : -1;
    this.hoverIdx = hovKey ? (this.index.get(hovKey) ?? -1) : -1;

    if (n > this.capacity || !this.tiles) {
      for (const m of [this.tiles, this.overlay]) {
        if (!m) continue;
        this.group.remove(m);
        m.dispose();
      }
      this.capacity = Math.max(n, cellCount(R + 3));
      this.tiles = new InstancedMesh(this.tileGeo, [this.tileTop, this.tileSide], this.capacity);
      this.tiles.receiveShadow = true;
      this.overlay = new InstancedMesh(this.glowGeo, this.glowMat, this.capacity);
      this.overlay.renderOrder = 1;
      this.tiles.frustumCulled = false;
      this.overlay.frustumCulled = false;
      this.group.add(this.tiles, this.overlay);
      const black = new Color(0, 0, 0);
      for (let i = 0; i < this.capacity; i++) {
        this.overlay.setColorAt(i, black);
        this.tiles.setColorAt(i, black);
      }
    }
    this.tiles.count = n;
    this.overlay!.count = n;
    for (let i = 0; i < n; i++) {
      const h = this.cells[i];
      // subtle per-tile variation of the enamel: value and a touch of hue
      const v = hash01(h.q * 7 + 3, h.r * 13 - 5);
      const w = hash01(h.q - 11, h.r + 29);
      this.col.setRGB(0.92 + v * 0.16, 0.94 + v * 0.12 + w * 0.03, 0.95 + v * 0.1 + (1 - w) * 0.05);
      this.tiles.setColorAt(i, this.col);
      this.paintCell(i);
      this.placeCell(i);
    }
    this.tiles.instanceColor!.needsUpdate = true;
    this.markMatrices();
    this.builtR = R;
    this.selMarker.visible = this.selIdx >= 0;
  }

  // ================================================================== cell state

  applyRange(myPos: Hex | null, range: number, showRange: boolean): void {
    for (let i = 0; i < this.cells.length; i++) {
      const d = myPos ? hexDistance(myPos, this.cells[i]) : -1;
      this.kind[i] = d === 0 ? 3 : showRange && d === 1 ? 2 : showRange && d > 0 && d <= range ? 1 : 0;
      this.paintCell(i);
    }
    if (this.overlay) this.overlay.instanceColor!.needsUpdate = true;
  }

  private paintCell(i: number): void {
    if (!this.overlay) return;
    const C = this.C;
    const o = this.col.setRGB(0, 0, 0);
    switch (this.kind[i]) {
      case 1:
        o.copy(C.info).multiplyScalar(0.3);
        break;
      case 2:
        o.copy(C.info).multiplyScalar(0.5);
        break;
      case 3:
        o.copy(C.brassHi).multiplyScalar(0.85);
        break;
    }
    if (i === this.hoverIdx) o.add(this.col2.copy(C.brassHi).multiplyScalar(0.55));
    if (i === this.selIdx) o.add(this.col2.copy(C.brass).multiplyScalar(0.35));
    const f = this.flashes.get(i);
    if (f !== undefined) o.add(this.col2.copy(C.danger).multiplyScalar(1.3 * f * f));
    this.overlay.setColorAt(i, o);
  }

  /** Cell changed hover/selection: repaint now, animate its lift. */
  touchCell(i: number): void {
    if (!this.overlay || i < 0 || i >= this.cells.length) return;
    this.paintCell(i);
    this.overlay.instanceColor!.needsUpdate = true;
    this.lifting.add(i);
  }

  setHover(i: number): void {
    const prev = this.hoverIdx;
    this.hoverIdx = i;
    if (prev >= 0) this.touchCell(prev);
    if (i >= 0) this.touchCell(i);
  }

  setSelected(i: number): void {
    const prev = this.selIdx;
    this.selIdx = i;
    if (prev >= 0) this.touchCell(prev);
    if (i >= 0) this.touchCell(i);
    this.selMarker.visible = i >= 0;
    this.selT = 0;
  }

  flash(i: number): void {
    this.flashes.set(i, 1);
  }

  liftAt(h: Hex): number {
    const i = this.index.get(hexKey(h));
    return i === undefined ? 0 : this.lift[i] + (this.rise[i] - 1) * 0.6;
  }

  inBoard(h: Hex): boolean {
    return hexDistance(h, { q: 0, r: 0 }) <= this.radius;
  }

  private placeCell(i: number): void {
    const { x, z } = worldOf(this.cells[i]);
    const r = this.rise[i];
    const y = this.lift[i] + (r - 1) * 0.6;
    const s = 0.72 + 0.28 * Math.min(1, r);
    this.m.makeScale(s, 1, s).setPosition(x, y, z);
    this.tiles!.setMatrixAt(i, this.m);
    const os = r < 0.98 ? Math.max(0, r) * s : 1;
    this.m.makeScale(os, 1, os).setPosition(x, TILE_TOP + y + 0.003, z);
    this.overlay!.setMatrixAt(i, this.m);
  }

  private markMatrices(): void {
    if (!this.tiles) return;
    this.tiles.instanceMatrix.needsUpdate = true;
    this.overlay!.instanceMatrix.needsUpdate = true;
  }

  // ================================================================== frame

  private placeFrame(): void {
    const Rf = this.frameR;
    const ap = Rf * Math.cos(Math.PI / 6); // inner apothem
    const len = Rf + 0.25;
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + (Math.PI / 3) * i; // edge normal direction
      const r = this.rails[i];
      r.position.set(Math.cos(a) * ap, 0, Math.sin(a) * ap);
      r.rotation.set(0, -a - Math.PI / 2, 0);
      r.scale.set(len, 1, 1);
      const s = this.strips[i];
      const apS = ap + RAIL_W * 0.27;
      s.position.set(Math.cos(a) * apS, RAIL_TOP + 0.002, Math.sin(a) * apS);
      s.rotation.set(0, -a - Math.PI / 2, 0);
      s.scale.set(len + RAIL_W * 0.27 * 1.155, 1, 1);
    }
    this.railTex.repeat.set((len + 0.3) / 20, 1);
    const Rb = Rf + RAIL_W * 0.52;
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      this.m.makeTranslation(Math.cos(a) * Rb, 0, Math.sin(a) * Rb);
      this.bosses.setMatrixAt(i, this.m);
    }
    this.bosses.instanceMatrix.needsUpdate = true;
    this.floor.scale.set(Rf + 0.05, 1, Rf + 0.05);
    const out = Rf + RAIL_W;
    const ca = (-2 * Math.PI) / 3 + 0.08;
    this.compass.position.set(Math.cos(ca) * (out + 2.3), TABLE_Y + 0.012, Math.sin(ca) * (out + 2.3));
    const cs = 2 * out + 13;
    this.chart.scale.set(cs, 1, cs);
  }

  /** Radius of the outer frame edge right now (for lights, lobby pieces). */
  get outerR(): number {
    return this.frameR + RAIL_W;
  }

  // ================================================================== animation

  /** Advances rises, lifts, flashes and the frame; returns true while anything moves. */
  update(dt: number): { active: boolean; frameMoved: boolean } {
    let active = false;
    let frameMoved = false;
    if (!this.tiles) return { active, frameMoved };
    let matrices = false;
    let colors = false;

    if (this.moving.size) {
      active = true;
      matrices = true;
      for (const i of this.moving) {
        if (this.delay[i] > 0) {
          this.delay[i] -= dt;
          continue;
        }
        const d = this.dir[i];
        this.prog[i] = clamp01(this.prog[i] + (d * dt) / RISE_DUR);
        const p = this.prog[i];
        this.rise[i] = d > 0 ? ease.outBack(p) : ease.outCubic(p);
        this.placeCell(i);
        if ((d > 0 && p >= 1) || (d < 0 && p <= 0)) {
          this.dir[i] = 0;
          this.rise[i] = p;
          this.placeCell(i);
          this.moving.delete(i);
        }
      }
      this.frameGoal = frameRadius(Math.max(this.radius, this.maxLiveRing()));
      if (!this.moving.size && this.builtR > this.radius) {
        // shrink finished: drop the sunk rings for good
        this.rebuild(this.radius, this.builtR);
      }
    }

    if (Math.abs(this.frameGoal - this.frameR) > 1e-3) {
      const k = 1 - Math.exp(-dt * (this.reduced ? 30 : 6.5));
      this.frameR += (this.frameGoal - this.frameR) * k;
      if (Math.abs(this.frameGoal - this.frameR) <= 1e-3) this.frameR = this.frameGoal;
      this.placeFrame();
      active = true;
      frameMoved = true;
    }

    if (this.lifting.size) {
      active = true;
      matrices = true;
      const k = 1 - Math.exp(-dt * (this.reduced ? 30 : 18));
      for (const i of this.lifting) {
        if (i >= this.cells.length) {
          this.lifting.delete(i);
          continue;
        }
        const goal = i === this.hoverIdx ? HOVER_LIFT : i === this.selIdx ? SELECT_LIFT : 0;
        this.lift[i] += (goal - this.lift[i]) * k;
        if (Math.abs(goal - this.lift[i]) < 5e-4) {
          this.lift[i] = goal;
          this.lifting.delete(i);
        }
        this.placeCell(i);
      }
    }
    if (this.flashes.size) {
      active = true;
      colors = true;
      for (const [i, f] of this.flashes) {
        const nf = f - dt / 0.6;
        if (nf <= 0) this.flashes.delete(i);
        else this.flashes.set(i, nf);
        this.paintCell(i);
      }
    }
    if (matrices) this.markMatrices();
    if (colors) this.overlay!.instanceColor!.needsUpdate = true;

    if (this.selMarker.visible && this.selIdx >= 0 && this.selIdx < this.cells.length) {
      const { x, z } = worldOf(this.cells[this.selIdx]);
      const k = this.reduced ? 1 : ease.outCubic(clamp01(this.selT));
      this.selMarker.position.set(x, TILE_TOP + this.liftAt(this.cells[this.selIdx]) + 0.006, z);
      this.selMarker.scale.setScalar(1.18 - 0.18 * k);
      if (this.selT < 1) {
        this.selT += dt / 0.22;
        active = true;
      }
    }
    return { active, frameMoved };
  }

  dispose(): void {
    for (const m of [this.tiles, this.overlay]) m?.dispose();
    this.tileGeo.dispose();
    this.glowGeo.dispose();
    this.tileTop.dispose();
    this.tileSide.dispose();
    this.glowMat.dispose();
    this.bosses.dispose();
    this.selMarker.geometry.dispose();
    (this.selMarker.material as MeshBasicMaterial).dispose();
    for (const t of this.textures) t.dispose();
    for (const o of this.owned) o.dispose();
  }
}

/** 0..1 around the board, so a ring rises as a sweeping wave rather than all at once. */
function angleSweep(h: Hex): number {
  const { x, z } = worldOf(h);
  return (Math.atan2(z, x) / (Math.PI * 2) + 0.5) % 1;
}

export { SQRT3 };
