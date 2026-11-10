// Blitz mode, the parts shared by the server (which validates and resolves orders) and the
// browser (whose planner shows the same prices and refusals before sending).
//
// A blitz turn: everyone queues secret orders, then all of them resolve together:
//   1. range-ups   2. moves (simultaneous; collisions bounce)   3. attacks on CELLS
//   (after the moves: you must guess where the target goes)   4. AP gifts to cells
//   5. charges bank (visible to everyone from the next turn)   6. eliminations, win check.

import { actionCost } from './costs.ts';
import { hexDistance, inGrid, type Hex } from './hex.ts';
import type { GameSettings } from './settings.ts';

export type BlitzOrder =
  | { type: 'move'; q: number; r: number }
  | { type: 'attack'; q: number; r: number }
  | { type: 'grant'; q: number; r: number }
  | { type: 'charge' }
  | { type: 'upgrade' };

export type BlitzOrderKind = BlitzOrder['type'];
export const BLITZ_KINDS: readonly BlitzOrderKind[] = ['move', 'attack', 'grant', 'upgrade', 'charge'];

/** How long the browser replays a resolved turn before planning starts (added to the deadline). */
export const BLITZ_REPLAY_MS = 4500;

/** The public blitz state plus the viewer's own orders (never anyone else's). */
export interface BlitzView {
  turn: number;
  /** When this turn's planning ends (ms, server clock); null while paused or finished. */
  deadline: number | null;
  /** When planning of this turn began (after the previous turn's replay). */
  planningFrom: number | null;
  /** Players who confirmed their orders for this turn (who, never what). */
  confirmed: number[];
  /** Charge of every alive player (public on purpose: a charged attacker can be dodged). */
  charges: Record<number, number>;
  /** The viewer's queued orders (null for spectators and eliminated players). */
  myOrders: BlitzOrder[] | null;
  myConfirmed: boolean;
  /** The previous turn as the viewer may see it, for the replay and summary. */
  last: BlitzTurnView | null;
}

export interface BlitzMoveView {
  pid: number;
  from: [number, number];
  to: [number, number];
  /** Tried to move to `to` but bounced back to `from`. */
  bounced: boolean;
}

export interface BlitzShotView {
  cell: [number, number];
  hit: boolean;
  /** Your own shot. */
  mine: boolean;
  /** Attacker and their cell after moves: for your own shots, or when attacks are public. */
  pid?: number;
  from?: [number, number];
  /** Damage: for the shooter, the victim, or everyone when attacks are public. */
  damage?: number;
  /** The shot carried charge (shown with a bigger comet). Same visibility as damage. */
  charged?: boolean;
  /** You were the one hit. */
  onMe?: boolean;
}

export interface BlitzGiftView {
  cell: [number, number];
  /** The receiver; null when the cell was empty (the gift was lost). */
  to: number | null;
  amount: number;
  mine: boolean;
  /** The giver: yours, or when gifts are public. */
  pid?: number;
  from?: [number, number];
}

export interface BlitzTurnView {
  turn: number;
  resolvedAt: number;
  moves: BlitzMoveView[];
  shots: BlitzShotView[];
  gifts: BlitzGiftView[];
  /** New charge levels (public). */
  charges: Array<{ pid: number; level: number; before: number }>;
  /** Your own range-up, if any. */
  myRange?: number;
  eliminated: Array<{ pid: number; by: number | null; at: [number, number] }>;
  /** Your HP / AP change this turn (only yours). */
  myDamage?: number;
  myGifts?: number;
}

export interface BlitzPlanContext {
  settings: GameSettings;
  pos: Hex;
  ap: number;
  range: number;
  charge: number;
}

export type BlitzPlanResult = { ok: true; orders: BlitzOrder[]; costs: number[]; total: number } | { ok: false; error: string; index: number };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Price of an order: the nth use of a kind within one turn (rising prices reset every turn). */
export function blitzOrderCost(s: GameSettings, kind: BlitzOrderKind, nth: number): number {
  if (kind === 'charge') return s.costCharge;
  return actionCost(s, kind, nth);
}

/** Price of the next order of `kind` after the queue `orders`. */
export function blitzNextCost(s: GameSettings, orders: readonly BlitzOrder[], kind: BlitzOrderKind): number {
  return blitzOrderCost(s, kind, orders.filter((o) => o.type === kind).length);
}

/** Range for this turn's shots: current range plus every queued range-up (they resolve first). */
export function blitzRange(s: GameSettings, range: number, orders: readonly BlitzOrder[]): number {
  return range + orders.filter((o) => o.type === 'upgrade').length * s.upgradeAmount;
}

/** Charge the player will hold after this turn's queue resolves (attacks spend it, charges add). */
export function blitzChargeAfter(charge: number, orders: readonly BlitzOrder[]): number {
  const spends = orders.some((o) => o.type === 'attack') && charge > 0;
  return (spends ? 0 : charge) + orders.filter((o) => o.type === 'charge').length;
}

/** Where the player stands after their own move order (bounces aside). */
export function blitzDestination(pos: Hex, orders: readonly BlitzOrder[]): Hex {
  const m = orders.find((o) => o.type === 'move');
  return m && m.type === 'move' ? { q: m.q, r: m.r } : pos;
}

function clean(raw: unknown): BlitzOrder | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  switch (o.type) {
    case 'move':
    case 'attack':
    case 'grant':
      return isInt(o.q) && isInt(o.r) ? { type: o.type, q: o.q, r: o.r } : null;
    case 'charge':
    case 'upgrade':
      return { type: o.type };
    default:
      return null;
  }
}

/**
 * Checks a whole queue of orders the way the server will run it. Ranges are measured from
 * where the player stands when the turn begins; queued range-ups count (they resolve first).
 */
export function checkBlitzOrders(raw: unknown, ctx: BlitzPlanContext): BlitzPlanResult {
  const s = ctx.settings;
  if (!Array.isArray(raw)) return { ok: false, error: 'Orders must be a list', index: -1 };
  if (raw.length > s.blitzMaxOrders) return { ok: false, error: `Too many orders (max ${s.blitzMaxOrders} per turn)`, index: s.blitzMaxOrders };
  const orders: BlitzOrder[] = [];
  for (let i = 0; i < raw.length; i++) {
    const o = clean(raw[i]);
    if (!o) return { ok: false, error: 'Unknown order', index: i };
    orders.push(o);
  }
  const range = blitzRange(s, ctx.range, orders);
  const costs: number[] = [];
  const nth: Record<BlitzOrderKind, number> = { move: 0, attack: 0, grant: 0, upgrade: 0, charge: 0 };
  let total = 0;
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    if (o.type === 'move') {
      if (nth.move > 0) return { ok: false, error: 'Only one move per turn', index: i };
      const to = { q: o.q, r: o.r };
      if (!inGrid(to, s.gridRadius)) return { ok: false, error: "You can't move off the map", index: i };
      if (hexDistance(ctx.pos, to) !== 1) return { ok: false, error: 'You can only move to a neighbouring cell', index: i };
    } else if (o.type === 'attack' || o.type === 'grant') {
      const at = { q: o.q, r: o.r };
      if (!inGrid(at, s.gridRadius)) return { ok: false, error: 'That cell is not on the map', index: i };
      const d = hexDistance(ctx.pos, at);
      if (d === 0) return { ok: false, error: "You can't target your own cell", index: i };
      if (d > range) return { ok: false, error: `Out of range (your range is ${range})`, index: i };
    } else if (o.type === 'charge') {
      if (s.blitzChargeCap <= 0) return { ok: false, error: 'Charging is off in this game', index: i };
    }
    const cost = blitzOrderCost(s, o.type, nth[o.type]);
    nth[o.type] += 1;
    costs.push(cost);
    total += cost;
  }
  if (nth.charge > 0 && blitzChargeAfter(ctx.charge, orders) > s.blitzChargeCap) {
    return { ok: false, error: `Charge is capped at +${s.blitzChargeCap}`, index: orders.map((o) => o.type).lastIndexOf('charge') };
  }
  if (total > ctx.ap) return { ok: false, error: `Not enough AP (need ${total}, you have ${ctx.ap})`, index: orders.length - 1 };
  return { ok: true, orders, costs, total };
}
