// Shared constants and small helpers for the 3D board.

import { Color, Shape } from 'three';
import type { Hex } from '../../../shared/hex.ts';

export const SQRT3 = Math.sqrt(3);
/** Tile circumradius; one cell is 1 unit from centre to centre along a row of √3. */
export const TILE_R = 0.9;
/** Height of a tile's top face above the board floor. */
export const TILE_TOP = 0.22;
export const FOV = 34;
export const HOVER_LIFT = 0.07;
export const SELECT_LIFT = 0.035;

/** Default camera elevation above the table (radians), and the orbit limits. */
export const TILT_DEFAULT = (50 * Math.PI) / 180;
export const TILT_MIN = (25 * Math.PI) / 180;
export const TILT_MAX = (78 * Math.PI) / 180;

export const ease = {
  outCubic: (t: number): number => 1 - (1 - t) ** 3,
  inCubic: (t: number): number => t * t * t,
  inOutCubic: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  inOutSine: (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t: number): number => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2,
  outQuint: (t: number): number => 1 - (1 - t) ** 5,
  outBounce: (t: number): number => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Outer radius (centre to corner) of the flat-top hexagon frame around a grid of radius R. */
export const frameRadius = (R: number): number => SQRT3 * R + 1.15;

export function worldOf(h: Hex): { x: number; z: number } {
  return { x: SQRT3 * (h.q + h.r / 2), z: 1.5 * h.r };
}

export function hexAt(x: number, z: number): Hex {
  const qf = (SQRT3 / 3) * x - z / 3;
  const rf = (2 / 3) * z;
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q: q + 0, r: r + 0 };
}

export function shortName(name: string): string {
  const chars = [...name];
  return chars.length > 9 ? chars.slice(0, 8).join('') + '…' : name;
}

export function cssColor(name: string, fallback: string): Color {
  let v = '';
  try {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    /* no styles yet */
  }
  const c = new Color();
  try {
    c.setStyle(v || fallback);
  } catch {
    c.setStyle(fallback);
  }
  return c;
}

export function hexShape(r: number, flatTop = false): Shape {
  const s = new Shape();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - (flatTop ? 0 : 30));
    const x = r * Math.cos(a);
    const y = r * Math.sin(a);
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

export interface Palette {
  bg: Color;
  panel: Color;
  line: Color;
  text: Color;
  brass: Color;
  brassHi: Color;
  brassDim: Color;
  danger: Color;
  good: Color;
  info: Color;
}

export function readPalette(): Palette {
  return {
    bg: cssColor('--bg', '#0a0e15'),
    panel: cssColor('--panel', '#131a25'),
    line: cssColor('--line', '#263041'),
    text: cssColor('--text', '#ece4d2'),
    brass: cssColor('--brass', '#c9a45c'),
    brassHi: cssColor('--brass-hi', '#e8c987'),
    brassDim: cssColor('--brass-dim', '#7d6638'),
    danger: cssColor('--danger', '#d0463c'),
    good: cssColor('--good', '#5fae7b'),
    info: cssColor('--info', '#6f9fd8'),
  };
}

/** Deterministic noise so procedural art looks the same on every load. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Cheap integer hash → [0, 1). */
export function hash01(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
