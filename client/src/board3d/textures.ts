// Procedural textures for the 3D board, all drawn once on small canvases at runtime
// (no image downloads besides the flags themselves):
// - engraving: a seamless topographic plate (contours + hachures + grain) the tiles sample in world space;
// - chart: an old night-sea chart lying on the table under the board;
// - baize: the table cloth beyond the chart;
// - compass: a brass compass rose medallion;
// - rail: engraved scale ticks along the brass frame;
// - crack: glowing fracture lines for impacts;
// - glow / ring: soft sprites;
// - flags: the country flag (4:3) for the cloth banners, and its dominant colour.

import { CanvasTexture, Color, LinearSRGBColorSpace, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';
import { rng } from './util.ts';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: false })!];
}

function tex(c: HTMLCanvasElement, srgb: boolean, anisotropy = 1, repeat = false): Texture {
  const t = new CanvasTexture(c);
  t.colorSpace = srgb ? SRGBColorSpace : LinearSRGBColorSpace;
  t.anisotropy = anisotropy;
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

// ------------------------------------------------------------------ engraving

/**
 * A seamless "engraved survey plate": R = contour lines, G = hachures (hatching on the
 * slopes, like an old relief map), B = fine stone grain. Built from a periodic height
 * field (integer frequencies on the torus), so it tiles without seams.
 */
export function engravingTexture(N: number, anisotropy: number): Texture {
  const [c, g] = canvas(N, N);
  const img = g.createImageData(N, N);
  const d = img.data;
  const rand = rng(41);
  const waves: Array<[number, number, number, number]> = [];
  const freqs: Array<[number, number]> = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
    [2, 1],
    [1, 2],
    [2, -1],
    [3, 1],
    [1, -3],
  ];
  for (const [kx, ky] of freqs) {
    const amp = 1 / Math.hypot(kx, ky) ** 1.15;
    waves.push([kx * Math.PI * 2, ky * Math.PI * 2, rand() * Math.PI * 2, amp]);
  }
  const H = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    const v = y / N;
    for (let x = 0; x < N; x++) {
      const u = x / N;
      let h = 0;
      for (const [ax, ay, ph, a] of waves) h += a * Math.sin(ax * u + ay * v + ph);
      H[y * N + x] = h;
    }
  }
  const levels = 4.2; // contour spacing in height units⁻¹
  const at = (x: number, y: number): number => H[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const h = at(x, y);
      const gx = (at(x + 1, y) - at(x - 1, y)) * 0.5;
      const gy = (at(x, y + 1) - at(x, y - 1)) * 0.5;
      const grad = Math.hypot(gx, gy) * levels + 1e-5;
      // distance (in px) to the nearest contour line, anti-aliased
      const f = h * levels;
      const dist = Math.abs(f - Math.round(f)) / grad;
      const major = Math.round(f) % 5 === 0;
      const w = major ? 1.1 : 0.55;
      const line = Math.max(0, 1 - Math.max(0, dist - w * 0.5) / 0.8) * (major ? 1 : 0.55);
      // hachures: short strokes along the slope where it is steep
      const slope = Math.min(1, grad / (levels * 0.045));
      const ang = Math.atan2(gy, gx);
      const s = (x * Math.cos(ang) + y * Math.sin(ang)) * 0.0 + (x * -Math.sin(ang) + y * Math.cos(ang));
      const hatch = slope > 0.55 ? Math.max(0, 1 - Math.abs(((s / 4) % 1 + 1) % 1 - 0.5) * 7) * (slope - 0.55) * 1.4 : 0;
      const i = (y * N + x) * 4;
      d[i] = Math.min(255, line * 255);
      d[i + 1] = Math.min(255, hatch * 200);
      d[i + 2] = 96 + (rand() - 0.5) * 70 + Math.sin(x * 0.9 + y * 0.31) * 6;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return tex(c, false, anisotropy, true);
}

// ------------------------------------------------------------------ table

/** The table baize beyond the chart: deep ink with grain and a faint brass grid. */
export function baizeTexture(base: string, line: string, anisotropy: number): Texture {
  const N = 256;
  const [c, g] = canvas(N, N);
  g.fillStyle = base;
  g.fillRect(0, 0, N, N);
  const rand = rng(7);
  for (let i = 0; i < 4200; i++) {
    const a = rand() * 0.05;
    g.fillStyle = rand() > 0.5 ? `rgba(255,240,215,${a})` : `rgba(0,0,0,${a * 1.6})`;
    g.fillRect(rand() * N, rand() * N, 1 + rand() * 1.5, 1 + rand() * 1.5);
  }
  g.strokeStyle = line;
  for (let i = 0; i <= 8; i++) {
    const p = (i * N) / 8 + 0.5;
    g.globalAlpha = i % 4 === 0 ? 0.12 : 0.045;
    g.beginPath();
    g.moveTo(p, 0);
    g.lineTo(p, N);
    g.moveTo(0, p);
    g.lineTo(N, p);
    g.stroke();
  }
  return tex(c, true, anisotropy, true);
}

/**
 * An old navigation chart on dark paper: lat/long graticule with a degree scale border,
 * rhumb lines fanning from two compass roses, faint coastlines with soundings, a
 * cartouche, foxing and a burnt vignette. Alpha fades at the edges so it lies on the baize.
 */
export function chartTexture(N: number, anisotropy: number): Texture {
  const [c, g] = canvas(N, N);
  const k = N / 1024;
  const rand = rng(1999);
  // paper
  const paper = g.createRadialGradient(N * 0.5, N * 0.48, N * 0.1, N * 0.5, N * 0.5, N * 0.72);
  paper.addColorStop(0, '#1d2433');
  paper.addColorStop(0.6, '#161c28');
  paper.addColorStop(1, '#0e121a');
  g.fillStyle = paper;
  g.fillRect(0, 0, N, N);
  // foxing / stains
  for (let i = 0; i < 26; i++) {
    const x = rand() * N;
    const y = rand() * N;
    const r = (20 + rand() * 90) * k;
    const s = g.createRadialGradient(x, y, 0, x, y, r);
    s.addColorStop(0, `rgba(120,96,58,${0.05 + rand() * 0.06})`);
    s.addColorStop(1, 'rgba(120,96,58,0)');
    g.fillStyle = s;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // fibres
  for (let i = 0; i < 2600 * k * k + 900; i++) {
    g.fillStyle = `rgba(236,228,210,${rand() * 0.035})`;
    g.fillRect(rand() * N, rand() * N, (1 + rand() * 3) * k, k);
  }
  const ink = (a: number): string => `rgba(201,164,92,${a})`;
  const pale = (a: number): string => `rgba(214,206,186,${a})`;
  // rhumb lines from two roses
  const roses: Array<[number, number]> = [
    [N * 0.24, N * 0.3],
    [N * 0.74, N * 0.68],
  ];
  g.lineWidth = Math.max(1, 0.9 * k);
  for (const [rx, ry] of roses) {
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      g.strokeStyle = i % 4 === 0 ? ink(0.16) : ink(0.07);
      g.beginPath();
      g.moveTo(rx, ry);
      g.lineTo(rx + Math.cos(a) * N * 1.5, ry + Math.sin(a) * N * 1.5);
      g.stroke();
    }
    // small rose
    g.save();
    g.translate(rx, ry);
    for (let i = 0; i < 8; i++) {
      g.rotate(Math.PI / 4);
      g.fillStyle = i % 2 ? ink(0.18) : ink(0.3);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(6 * k, 0);
      g.lineTo(0, (i % 2 ? -26 : -46) * k);
      g.lineTo(-6 * k, 0);
      g.closePath();
      g.fill();
    }
    g.strokeStyle = ink(0.3);
    g.beginPath();
    g.arc(0, 0, 54 * k, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }
  // graticule
  const step = N / 8;
  g.strokeStyle = pale(0.09);
  g.lineWidth = Math.max(1, 1.1 * k);
  for (let i = 1; i < 8; i++) {
    g.beginPath();
    g.moveTo(i * step, 0);
    g.lineTo(i * step, N);
    g.moveTo(0, i * step);
    g.lineTo(N, i * step);
    g.stroke();
  }
  // coastlines: closed noisy loops with ring "depth contours" around them and soundings
  const islands: Array<[number, number, number]> = [
    [0.12, 0.78, 0.13],
    [0.86, 0.18, 0.12],
    [0.55, 0.08, 0.07],
    [0.06, 0.12, 0.08],
    [0.93, 0.92, 0.1],
  ];
  for (const [ix, iy, ir] of islands) {
    const pts: number[] = [];
    const seed = rand() * 10;
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const r = ir * (1 + 0.22 * Math.sin(a * 3 + seed) + 0.12 * Math.sin(a * 7 + seed * 2) + 0.06 * Math.sin(a * 13 + seed));
      pts.push(a, r);
    }
    for (let ring = 3; ring >= 0; ring--) {
      g.beginPath();
      for (let i = 0; i < pts.length; i += 2) {
        const r = (pts[i + 1] + ring * 0.018) * N;
        const x = ix * N + Math.cos(pts[i]) * r;
        const y = iy * N + Math.sin(pts[i]) * r;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      if (ring === 0) {
        g.fillStyle = 'rgba(30,38,52,0.9)';
        g.fill();
        g.strokeStyle = pale(0.32);
        g.lineWidth = Math.max(1, 1.6 * k);
        g.stroke();
        // land hatching
        g.save();
        g.clip();
        g.strokeStyle = pale(0.07);
        g.lineWidth = Math.max(1, k);
        for (let h = -N; h < N * 2; h += 5 * k) {
          g.beginPath();
          g.moveTo(h, 0);
          g.lineTo(h - N, N);
          g.stroke();
        }
        g.restore();
      } else {
        g.setLineDash([4 * k, 5 * k]);
        g.strokeStyle = pale(0.09 - ring * 0.015);
        g.lineWidth = Math.max(1, k);
        g.stroke();
        g.setLineDash([]);
      }
    }
  }
  // soundings
  g.fillStyle = pale(0.2);
  g.font = `italic ${Math.round(11 * k)}px Georgia, serif`;
  for (let i = 0; i < 110; i++) {
    g.fillText(String(Math.floor(4 + rand() * 60)), rand() * N, rand() * N);
  }
  // cartouche
  g.save();
  g.translate(N * 0.8, N * 0.88);
  g.strokeStyle = ink(0.4);
  g.lineWidth = Math.max(1, 1.2 * k);
  g.strokeRect(-110 * k, -34 * k, 220 * k, 68 * k);
  g.strokeRect(-104 * k, -28 * k, 208 * k, 56 * k);
  g.fillStyle = ink(0.45);
  g.textAlign = 'center';
  g.font = `600 ${Math.round(17 * k)}px Georgia, serif`;
  g.fillText('MARE  FOEDERIS', 0, -2 * k);
  g.font = `italic ${Math.round(10 * k)}px Georgia, serif`;
  g.fillText('Charta secreta · scala leucarum', 0, 16 * k);
  g.restore();
  // degree border
  const b = 18 * k;
  g.strokeStyle = ink(0.35);
  g.lineWidth = Math.max(1, 1.2 * k);
  g.strokeRect(b, b, N - 2 * b, N - 2 * b);
  g.strokeRect(b + 7 * k, b + 7 * k, N - 2 * b - 14 * k, N - 2 * b - 14 * k);
  for (let i = 0; i <= 64; i++) {
    const p = b + ((N - 2 * b) * i) / 64;
    const len = (i % 8 === 0 ? 7 : 3.5) * k;
    g.fillStyle = i % 2 ? ink(0.4) : 'rgba(0,0,0,0)';
    if (i < 64) {
      const w = (N - 2 * b) / 64;
      g.fillRect(p, b, w, 7 * k);
      g.fillRect(p, N - b - 7 * k, w, 7 * k);
      g.fillRect(b, p, 7 * k, w);
      g.fillRect(N - b - 7 * k, p, 7 * k, w);
    }
    void len;
  }
  // burnt edges: alpha vignette
  g.globalCompositeOperation = 'destination-in';
  const v = g.createRadialGradient(N / 2, N / 2, N * 0.36, N / 2, N / 2, N * 0.72);
  v.addColorStop(0, 'rgba(0,0,0,1)');
  v.addColorStop(0.8, 'rgba(0,0,0,0.75)');
  v.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = v;
  g.fillRect(0, 0, N, N);
  g.globalCompositeOperation = 'source-over';
  return tex(c, true, anisotropy);
}

/** A brass compass rose medallion (RGBA; transparent outside the disc). */
export function compassTexture(N: number): Texture {
  const [c, g] = canvas(N, N);
  const k = N / 512;
  const cx = N / 2;
  g.translate(cx, cx);
  const disc = g.createRadialGradient(-60 * k, -80 * k, 10 * k, 0, 0, 250 * k);
  disc.addColorStop(0, '#e8c987');
  disc.addColorStop(0.55, '#b48f4b');
  disc.addColorStop(1, '#6e5530');
  g.fillStyle = disc;
  g.beginPath();
  g.arc(0, 0, 250 * k, 0, Math.PI * 2);
  g.fill();
  // engraved rings
  g.strokeStyle = 'rgba(40,28,12,0.75)';
  for (const [r, w] of [
    [236, 3],
    [214, 1.5],
    [150, 1.5],
    [60, 1.5],
  ] as const) {
    g.lineWidth = w * k;
    g.beginPath();
    g.arc(0, 0, r * k, 0, Math.PI * 2);
    g.stroke();
  }
  // degree ticks
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const r0 = (i % 9 === 0 ? 196 : 205) * k;
    g.lineWidth = (i % 9 === 0 ? 2.4 : 1.2) * k;
    g.beginPath();
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.lineTo(Math.cos(a) * 214 * k, Math.sin(a) * 214 * k);
    g.stroke();
  }
  // star: 4 long + 4 short points, half-shaded like a real rose
  const point = (a: number, len: number, wid: number, dark: boolean, light: boolean): void => {
    g.save();
    g.rotate(a);
    g.fillStyle = light ? 'rgba(255,240,205,0.85)' : 'rgba(255,235,190,0.45)';
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, -len);
    g.lineTo(wid, 0);
    g.closePath();
    g.fill();
    g.fillStyle = dark ? 'rgba(40,28,12,0.85)' : 'rgba(40,28,12,0.55)';
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, -len);
    g.lineTo(-wid, 0);
    g.closePath();
    g.fill();
    g.restore();
  };
  for (let i = 0; i < 4; i++) point(Math.PI / 4 + (i * Math.PI) / 2, 120 * k, 22 * k, false, false);
  for (let i = 0; i < 4; i++) point((i * Math.PI) / 2, 190 * k, 30 * k, true, true);
  g.fillStyle = '#2a1d0c';
  g.beginPath();
  g.arc(0, 0, 9 * k, 0, Math.PI * 2);
  g.fill();
  // N
  g.fillStyle = 'rgba(40,28,12,0.9)';
  g.font = `700 ${Math.round(40 * k)}px Georgia, serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('N', 0, -228 * k + 2 * k);
  // patina speckle
  const rand = rng(5);
  for (let i = 0; i < 1400; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 248 * k;
    g.fillStyle = rand() > 0.5 ? 'rgba(40,28,12,0.12)' : 'rgba(255,240,200,0.08)';
    g.fillRect(Math.cos(a) * r, Math.sin(a) * r, 1.5 * k, 1.5 * k);
  }
  return tex(c, true, 4);
}

/** Engraved scale along the brass frame: fine ticks every unit, longer every fifth. */
export function railTexture(): Texture {
  const W = 512;
  const H = 64;
  const [c, g] = canvas(W, H);
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#f0d79c');
  grd.addColorStop(0.45, '#c9a45c');
  grd.addColorStop(1, '#8a6d3a');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(40,28,12,0.8)';
  for (let i = 0; i < 20; i++) {
    const x = (i / 20) * W;
    const long = i % 5 === 0;
    g.fillRect(x, 0, long ? 3 : 2, long ? H * 0.62 : H * 0.36);
  }
  g.fillRect(0, H * 0.82, W, 2);
  return tex(c, true, 4, true);
}

/** Branching fracture lines (white on transparent; tinted by the material). */
export function crackTexture(): Texture {
  const N = 256;
  const [c, g] = canvas(N, N);
  const rand = rng(77);
  g.translate(N / 2, N / 2);
  g.lineCap = 'round';
  g.strokeStyle = '#fff';
  const branch = (x: number, y: number, a: number, len: number, w: number, depth: number): void => {
    let px = x;
    let py = y;
    const steps = 6;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(px, py);
    for (let i = 0; i < steps; i++) {
      a += (rand() - 0.5) * 0.9;
      px += Math.cos(a) * (len / steps);
      py += Math.sin(a) * (len / steps);
      g.lineTo(px, py);
      if (depth > 0 && rand() < 0.28) branch(px, py, a + (rand() > 0.5 ? 0.8 : -0.8), len * 0.5, w * 0.6, depth - 1);
    }
    g.stroke();
  };
  g.shadowColor = '#fff';
  g.shadowBlur = 6;
  for (let i = 0; i < 7; i++) branch(0, 0, (i / 7) * Math.PI * 2 + rand() * 0.5, 70 + rand() * 40, 3.2, 2);
  return tex(c, false);
}

/** A soft radial glow for projectile heads and flashes (white; tinted by the material). */
export function glowTexture(): Texture {
  const N = 64;
  const [c, g] = canvas(N, N);
  const grd = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, N, N);
  return tex(c, false);
}

/** Soft ground glow under a piece: bright ring fading in and out (white; tinted). */
export function ringGlowTexture(): Texture {
  const N = 128;
  const [c, g] = canvas(N, N);
  const grd = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grd.addColorStop(0, 'rgba(255,255,255,0.18)');
  grd.addColorStop(0.42, 'rgba(255,255,255,0.32)');
  grd.addColorStop(0.62, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.7, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, N, N);
  return tex(c, false);
}

// ------------------------------------------------------------------ flags

export interface FlagArt {
  texture: Texture;
  /** The flag's most prominent saturated colour (linear), for glows and enamel. */
  color: Color;
}

const flagCache = new Map<string, Promise<{ canvas: HTMLCanvasElement; color: Color }>>();

/** Picks the most frequent "colourful" colour of a flag (ignores near-white/black). */
function dominantColor(g: CanvasRenderingContext2D, w: number, h: number): Color {
  const d = g.getImageData(0, 0, w, h).data;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < d.length; i += 16) {
    const r = d[i];
    const gg = d[i + 1];
    const b = d[i + 2];
    const mx = Math.max(r, gg, b);
    const mn = Math.min(r, gg, b);
    const sat = mx ? (mx - mn) / mx : 0;
    if (sat < 0.3 || mx < 50) continue;
    const key = ((r >> 5) << 6) | ((gg >> 5) << 3) | (b >> 5);
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += r;
    e.g += gg;
    e.b += b;
    buckets.set(key, e);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
  const col = new Color();
  if (!best) return col.setStyle('#c9a45c');
  col.setRGB(best.r / best.n / 255, best.g / best.n / 255, best.b / best.n / 255, SRGBColorSpace);
  return col;
}

/** Loads /flags/4x3/<code>.svg and rasterises it with a woven-silk finish. */
function flagCanvas(code: string, W: number): Promise<{ canvas: HTMLCanvasElement; color: Color }> {
  const key = `${code}@${W}`;
  let p = flagCache.get(key);
  if (p) return p;
  p = (async () => {
    const H = Math.round((W * 3) / 4);
    const res = await fetch(`/flags/4x3/${encodeURIComponent(code)}.svg`);
    if (!res.ok) throw new Error(`flag ${code}: ${res.status}`);
    let svg = await res.text();
    // Firefox/Safari only rasterise SVGs that carry an intrinsic size.
    svg = svg.replace(/<svg\b/, `<svg width="${W}" height="${H}" preserveAspectRatio="none"`);
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      const [c, g] = canvas(W, H);
      g.drawImage(img, 0, 0, W, H);
      const color = dominantColor(g, W, H);
      // silk weave + a hem along the hoist
      g.globalAlpha = 0.07;
      g.fillStyle = '#000';
      for (let y = 0; y < H; y += 2) g.fillRect(0, y, W, 1);
      g.globalAlpha = 0.05;
      g.fillStyle = '#fff';
      for (let x = 0; x < W; x += 3) g.fillRect(x, 0, 1, H);
      g.globalAlpha = 1;
      const hem = g.createLinearGradient(0, 0, W * 0.06, 0);
      hem.addColorStop(0, 'rgba(0,0,0,0.45)');
      hem.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = hem;
      g.fillRect(0, 0, W * 0.06, H);
      return { canvas: c, color };
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  flagCache.set(key, p);
  p.catch(() => flagCache.delete(key));
  return p;
}

export async function flagArt(code: string, width: number, anisotropy: number): Promise<FlagArt> {
  const { canvas: c, color } = await flagCanvas(code, width);
  const t = tex(c, true, anisotropy);
  return { texture: t, color: color.clone() };
}

