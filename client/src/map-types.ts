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
  /** Blitz: every player's charge (public), shown as a glow + bolt badge on the piece. */
  charges?: Record<number, number> | null;
}

/** Blitz: one of your queued orders drawn on the board as a ghost (arrow / ring / badge). */
export interface OrderMark {
  kind: 'move' | 'attack' | 'grant' | 'upgrade' | 'charge';
  from: Hex;
  to: Hex;
  /** Short text at the target ("−3", "+1", "1"). */
  label?: string;
}

export type BoardAction = 'move' | 'attack' | 'grant' | 'upgrade' | 'charge';

/** A pointer gesture on a cell: where it landed (viewport px) and whether it came from touch. */
export interface CellGesture {
  hex: Hex;
  x: number;
  y: number;
  touch: boolean;
}

export interface MapImpl {
  readonly el: Element;
  hovered: Hex | null;
  selected: Hex | null;
  onHover: (h: Hex | null) => void;
  onSelect: (h: Hex | null) => void;
  /** Right-click (desktop) or long-press (touch) on a cell: open the action menu. */
  onMenu: (g: CellGesture) => void;
  /** Double-click / double-tap on a cell (the cell is already selected when this fires). */
  onActivate: (g: CellGesture) => void;
  setRadius(radius: number): void;
  setSelected(hex: Hex | null): void;
  render(input: MapInput): void;
  flashCell(hex: Hex): void;
  shot(from: Hex, to: Hex, kind: 'attack' | 'grant'): void;
  float(at: Hex, text: string, kind: 'good' | 'bad' | 'info'): void;
  ring(at: Hex, kind: 'range' | 'bad'): void;
  burst(at: Hex): void;
  shake(pid: number): void;
  /** Hints an action on the board while a menu item is hovered; `null` clears the hint. */
  hint(kind: BoardAction | null, at: Hex | null): void;
  /** A quick brass "hop" marker on a move target. */
  hop(at: Hex): void;
  /** A small "no" on a cell (illegal quick action). */
  deny(at: Hex): void;
  /** Lobby preview only: the joined players, standing around the board. */
  setRoster?(players: PublicPlayer[], myPid: number | null): void;
  /** Blitz: your queued orders as ghosts on the board (replaces the previous set). */
  setOrders?(marks: OrderMark[]): void;
  /** Blitz replay: a shot into a cell — a hit explodes, a miss puffs on the empty cell. */
  strike?(from: Hex, to: Hex, hit: boolean, power: number): void;
  /** Blitz replay: the piece starts towards `toward` and is pushed back (a bounced move). */
  bounce?(pid: number, toward: Hex): void;
  destroy(): void;
}
