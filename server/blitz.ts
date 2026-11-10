// Blitz mode rules: per-turn state and the deterministic resolution of everyone's orders.
// Pure like engine.ts — no I/O; room.ts stores the state (rooms.blitz, JSON) and drives the
// turn timer. Order validation is shared with the browser's planner (shared/blitz.ts).
//
// Resolution of one turn, in this order:
//   1. range-ups (every queued Range +1 counts for this turn's shots)
//   2. moves, all at once: two players into one cell → both bounce back; two players swapping
//      cells → both bounce; moving into a cell whose occupant stays (or bounces) → bounce;
//      moving into a cell someone else leaves → fine. Bounces can cascade; repeated until stable.
//   3. attacks hit the CELL they were aimed at, after the moves: whoever stands there takes the
//      damage (never the shooter). Damage = attackDamage, + the shooter's charge on their first
//      attack of the turn (the charge is spent even on a miss). Shots stack.
//   4. AP gifts land on whoever stands on the cell after the moves (lost on an empty cell,
//      lost for a player eliminated in step 3).
//   5. charges bank (+1 each, capped): usable from the NEXT turn and visible to everyone.
//   6. eliminations (HP ≤ 0, all at once), then the win check (room.ts).
// AP is paid in queue order at resolution; an order that can no longer be paid is skipped.

import { emptyCounts } from '../shared/costs.ts';
import { blitzOrderCost, BLITZ_REPLAY_MS, type BlitzOrder, type BlitzOrderKind } from '../shared/blitz.ts';
import { hexKey, type Hex } from '../shared/hex.ts';
import type { GameSettings } from '../shared/settings.ts';
import { eliminate, positionOf, type GameEvent, type Players } from './engine.ts';

export interface BlitzShot {
  pid: number;
  /** Shooter's cell after the moves. */
  from: [number, number];
  cell: [number, number];
  damage: number;
  charged: boolean;
  /** Victim pid, or null for a miss. */
  victim: number | null;
}

export interface BlitzGift {
  pid: number;
  from: [number, number];
  cell: [number, number];
  amount: number;
  to: number | null;
}

/** Everything that happened in one turn (server-side, complete; views.ts filters per viewer). */
export interface BlitzTurnReport {
  turn: number;
  resolvedAt: number;
  moves: Array<{ pid: number; from: [number, number]; to: [number, number]; bounced: boolean }>;
  shots: BlitzShot[];
  gifts: BlitzGift[];
  charges: Array<{ pid: number; level: number; before: number }>;
  ranges: Array<{ pid: number; range: number }>;
  eliminated: Array<{ pid: number; by: number | null; at: [number, number] }>;
}

export interface BlitzState {
  turn: number;
  /** Queued orders by pid (as strings: JSON keys). */
  orders: Record<string, BlitzOrder[]>;
  confirmed: number[];
  /** Banked charge by pid. */
  charge: Record<string, number>;
  /** When planning of the current turn began (after the previous replay). */
  planningFrom: number | null;
  /** Time left in the turn when the game was paused (ms). */
  pausedLeft: number | null;
  last: BlitzTurnReport | null;
}

export function newBlitzState(): BlitzState {
  return { turn: 0, orders: {}, confirmed: [], charge: {}, planningFrom: null, pausedLeft: null, last: null };
}

/** Reads the stored JSON defensively. */
export function parseBlitzState(raw: string | null | undefined): BlitzState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<BlitzState>;
    if (!v || typeof v !== 'object' || typeof v.turn !== 'number') return null;
    return {
      turn: v.turn,
      orders: v.orders && typeof v.orders === 'object' ? v.orders : {},
      confirmed: Array.isArray(v.confirmed) ? v.confirmed.filter((x) => typeof x === 'number') : [],
      charge: v.charge && typeof v.charge === 'object' ? v.charge : {},
      planningFrom: typeof v.planningFrom === 'number' ? v.planningFrom : null,
      pausedLeft: typeof v.pausedLeft === 'number' ? v.pausedLeft : null,
      last: v.last ?? null,
    };
  } catch {
    return null;
  }
}

export function chargeOf(st: BlitzState, pid: number): number {
  return st.charge[String(pid)] ?? 0;
}

const pair = (h: Hex): [number, number] => [h.q, h.r];

/**
 * Starts the next planning phase: everyone alive gets the turn's AP, price counters reset,
 * the order book is cleared. Returns the turn's deadline. `replay` = leave time for the
 * browsers to replay the turn that just resolved before the planning clock starts.
 */
export function beginTurn(players: Players, settings: GameSettings, st: BlitzState, now: number, replay: boolean): number {
  st.turn += 1;
  st.orders = {};
  st.confirmed = [];
  st.pausedLeft = null;
  for (const p of players.values()) {
    if (p.alive) p.ap += settings.blitzApPerTurn;
    p.used = emptyCounts();
  }
  st.planningFrom = now + (replay ? BLITZ_REPLAY_MS : 0);
  return st.planningFrom + settings.blitzTurnSec * 1000;
}

/** Resolves the current turn. Mutates players and `st` (charges, last report); returns the events. */
export function resolveTurn(players: Players, settings: GameSettings, st: BlitzState, now: number): { events: GameEvent[]; report: BlitzTurnReport; attacked: boolean } {
  const alive = [...players.values()].filter((p) => p.alive && positionOf(p)).sort((a, b) => a.pid - b.pid);
  const events: GameEvent[] = [];
  const report: BlitzTurnReport = { turn: st.turn, resolvedAt: now, moves: [], shots: [], gifts: [], charges: [], ranges: [], eliminated: [] };
  const start = new Map(alive.map((p) => [p.pid, positionOf(p)!]));

  // Pay for every order in queue order; anything that can't be paid any more is dropped.
  const paid = new Map<number, Array<{ order: BlitzOrder; cost: number }>>();
  for (const p of alive) {
    const list: Array<{ order: BlitzOrder; cost: number }> = [];
    const nth: Record<BlitzOrderKind, number> = { move: 0, attack: 0, grant: 0, upgrade: 0, charge: 0 };
    for (const order of st.orders[String(p.pid)] ?? []) {
      if (order.type === 'move' && nth.move > 0) continue;
      const cost = blitzOrderCost(settings, order.type, nth[order.type]);
      if (cost > p.ap) continue;
      p.ap -= cost;
      nth[order.type] += 1;
      list.push({ order, cost });
    }
    p.used = { move: nth.move, attack: nth.attack, grant: nth.grant, upgrade: nth.upgrade };
    paid.set(p.pid, list);
  }

  // 1. range-ups
  for (const p of alive) {
    const ups = paid.get(p.pid)!.filter((x) => x.order.type === 'upgrade');
    if (!ups.length) continue;
    p.range += ups.length * settings.upgradeAmount;
    report.ranges.push({ pid: p.pid, range: p.range });
    for (const u of ups) events.push({ ts: now, type: 'upgrade', actor: p.pid, target: null, data: { range: p.range, cost: u.cost } });
  }

  // 2. moves
  const want = new Map<number, Hex>();
  for (const p of alive) {
    const m = paid.get(p.pid)!.find((x) => x.order.type === 'move')?.order;
    if (m && m.type === 'move') want.set(p.pid, { q: m.q, r: m.r });
  }
  const bounced = new Set<number>();
  for (let changed = true; changed; ) {
    changed = false;
    const movers = [...want.keys()].filter((pid) => !bounced.has(pid));
    const byDest = new Map<string, number[]>();
    for (const pid of movers) {
      const k = hexKey(want.get(pid)!);
      byDest.set(k, [...(byDest.get(k) ?? []), pid]);
    }
    // whoever ends the phase on their start cell (stays, or already bounced)
    const stayers = new Map<string, number>();
    for (const p of alive) if (!want.has(p.pid) || bounced.has(p.pid)) stayers.set(hexKey(start.get(p.pid)!), p.pid);
    const startOf = new Map<string, number>();
    for (const p of alive) startOf.set(hexKey(start.get(p.pid)!), p.pid);
    for (const pid of movers) {
      const dest = want.get(pid)!;
      const k = hexKey(dest);
      let bounce = (byDest.get(k)?.length ?? 0) > 1 || stayers.has(k);
      const other = startOf.get(k);
      if (!bounce && other !== undefined && other !== pid && movers.includes(other)) {
        // a swap: the other one walks into my cell while I walk into theirs
        const theirs = want.get(other)!;
        if (hexKey(theirs) === hexKey(start.get(pid)!)) bounce = true;
      }
      if (bounce) {
        bounced.add(pid);
        changed = true;
      }
    }
  }
  for (const [pid, dest] of want) {
    const p = players.get(pid)!;
    const from = start.get(pid)!;
    const ok = !bounced.has(pid);
    if (ok) {
      p.q = dest.q;
      p.r = dest.r;
    }
    report.moves.push({ pid, from: pair(from), to: pair(dest), bounced: !ok });
    events.push({ ts: now, type: 'move', actor: pid, target: null, data: { from: pair(from), to: pair(ok ? dest : from), ...(ok ? {} : { bounced: 1 }) } });
  }
  const occupant = new Map<string, number>();
  for (const p of alive) occupant.set(hexKey(positionOf(p)!), p.pid);

  // 3. attacks
  const damageTo = new Map<number, number>();
  const damageBy = new Map<number, Map<number, number>>();
  for (const p of alive) {
    const shots = paid.get(p.pid)!.filter((x) => x.order.type === 'attack');
    if (!shots.length) continue;
    let charge = chargeOf(st, p.pid);
    const from = pair(positionOf(p)!);
    for (const s of shots) {
      const o = s.order as Extract<BlitzOrder, { type: 'attack' }>;
      const damage = settings.attackDamage + charge;
      const charged = charge > 0;
      charge = 0;
      const occ = occupant.get(hexKey(o));
      const victim = occ !== undefined && occ !== p.pid ? occ : null;
      report.shots.push({ pid: p.pid, from, cell: [o.q, o.r], damage, charged, victim });
      if (victim !== null) {
        damageTo.set(victim, (damageTo.get(victim) ?? 0) + damage);
        const by = damageBy.get(victim) ?? new Map<number, number>();
        by.set(p.pid, (by.get(p.pid) ?? 0) + damage);
        damageBy.set(victim, by);
      } else {
        events.push({ ts: now, type: 'miss', actor: p.pid, target: null, data: { cell: [o.q, o.r], damage, cost: s.cost } });
      }
    }
    if (chargeOf(st, p.pid) > 0) st.charge[String(p.pid)] = 0;
  }
  // HP all at once, so everyone's shots of this turn count even if they fall this turn
  for (const shot of report.shots) {
    if (shot.victim === null) continue;
    const v = players.get(shot.victim)!;
    v.hp -= shot.damage;
    events.push({
      ts: now,
      type: 'attack',
      actor: shot.pid,
      target: v.pid,
      data: { damage: shot.damage, hpLeft: Math.max(0, v.hp), from: shot.from, cell: shot.cell, ...(shot.charged ? { charged: 1 } : {}) },
    });
  }
  const falling = alive.filter((p) => p.hp <= 0);
  const fallingSet = new Set(falling.map((p) => p.pid));

  // 4. AP gifts (to whoever stands there and survives the shots)
  for (const p of alive) {
    for (const g of paid.get(p.pid)!.filter((x) => x.order.type === 'grant')) {
      const o = g.order as Extract<BlitzOrder, { type: 'grant' }>;
      const occ = occupant.get(hexKey(o));
      const to = occ !== undefined && occ !== p.pid && !fallingSet.has(occ) && !fallingSet.has(p.pid) ? occ : null;
      const gift: BlitzGift = { pid: p.pid, from: pair(positionOf(p)!), cell: [o.q, o.r], amount: settings.grantAmount, to };
      report.gifts.push(gift);
      if (to !== null) {
        players.get(to)!.ap += settings.grantAmount;
        events.push({ ts: now, type: 'grant', actor: p.pid, target: to, data: { amount: settings.grantAmount, cost: g.cost, cell: [o.q, o.r] } });
      } else {
        events.push({ ts: now, type: 'gift-lost', actor: p.pid, target: null, data: { amount: settings.grantAmount, cell: [o.q, o.r] } });
      }
    }
  }

  // 5. charges bank (for the next turn)
  for (const p of alive) {
    if (fallingSet.has(p.pid)) continue;
    const n = paid.get(p.pid)!.filter((x) => x.order.type === 'charge').length;
    if (!n) continue;
    const before = chargeOf(st, p.pid);
    const level = Math.min(settings.blitzChargeCap, before + n);
    st.charge[String(p.pid)] = level;
    report.charges.push({ pid: p.pid, level, before });
    events.push({ ts: now, type: 'charge', actor: p.pid, target: null, data: { level } });
  }

  // 6. eliminations: the killer is whoever dealt the most damage to them this turn
  for (const p of falling) {
    const at = positionOf(p)!;
    let by: number | null = null;
    let best = 0;
    for (const [pid, d] of damageBy.get(p.pid) ?? []) {
      if (d > best) {
        best = d;
        by = pid;
      }
    }
    eliminate(p, by, now);
    delete st.charge[String(p.pid)];
    report.eliminated.push({ pid: p.pid, by, at: pair(at) });
    events.push({ ts: now, type: 'eliminate', actor: by, target: p.pid, data: { at: pair(at) } });
  }

  const hits = report.shots.filter((s) => s.victim !== null).length;
  events.unshift({ ts: now, type: 'turn', actor: null, target: null, data: { turn: st.turn, hits, misses: report.shots.length - hits } });
  st.last = report;
  st.orders = {};
  st.confirmed = [];
  return { events, report, attacked: report.shots.length > 0 };
}
