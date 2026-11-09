// The contract every game board implements (the 3D board and the SVG fallback).

import type { Hex } from '../../shared/hex.ts';
import type { PublicPlayer } from '../../shared/protocol.ts';

export interface MapInput {
  players: PublicPlayer[];
  myPid: number | null;
  myPos: Hex | null;
  range: number;
  showRange: boolean;
  /** Your own HP (shown as pips on your piece's label); others' HP is hidden. */
  myHp?: number | null;
}

export interface MapImpl {
  readonly el: Element;
  hovered: Hex | null;
  selected: Hex | null;
  onHover: (h: Hex | null) => void;
  onSelect: (h: Hex | null) => void;
  setRadius(radius: number): void;
  setSelected(hex: Hex | null): void;
  render(input: MapInput): void;
  flashCell(hex: Hex): void;
  shot(from: Hex, to: Hex, kind: 'attack' | 'grant'): void;
  float(at: Hex, text: string, kind: 'good' | 'bad' | 'info'): void;
  ring(at: Hex, kind: 'range' | 'bad'): void;
  burst(at: Hex): void;
  shake(pid: number): void;
  /** Lobby preview only: the joined players, standing around the board. */
  setRoster?(players: PublicPlayer[], myPid: number | null): void;
  destroy(): void;
}
