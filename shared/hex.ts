// Hex grid math using axial coordinates (q, r). The third cube coordinate is s = -q - r.
// The playing field is a hexagon of a given radius centred on (0, 0).

export interface Hex {
  q: number;
  r: number;
}

export const DIRECTIONS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function inGrid(h: Hex, radius: number): boolean {
  return hexDistance(h, { q: 0, r: 0 }) <= radius;
}

export function neighbors(h: Hex): Hex[] {
  return DIRECTIONS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }));
}

export function gridCells(radius: number): Hex[] {
  const cells: Hex[] = [];
  for (let q = -radius; q <= radius; q++) {
    const rMin = Math.max(-radius, -q - radius);
    const rMax = Math.min(radius, -q + radius);
    for (let r = rMin; r <= rMax; r++) cells.push({ q, r });
  }
  return cells;
}

export function cellCount(radius: number): number {
  return 3 * radius * (radius + 1) + 1;
}

export function hexKey(h: Hex): string {
  return `${h.q},${h.r}`;
}

export function sameHex(a: Hex, b: Hex): boolean {
  return a.q === b.q && a.r === b.r;
}

/** Pixel centre of a pointy-top hex of the given size (centre-to-corner distance). */
export function hexToPixel(h: Hex, size: number): { x: number; y: number } {
  return {
    x: size * Math.sqrt(3) * (h.q + h.r / 2),
    y: size * 1.5 * h.r,
  };
}

/** Corner points of a pointy-top hex centred at (0, 0). */
export function hexCorners(size: number): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    pts.push({ x: size * Math.cos(angle), y: size * Math.sin(angle) });
  }
  return pts;
}
