// Pure game rules. Nothing here does I/O: functions take the current state, check the
// request against it, and either mutate the state and return events, or return an error
// without touching anything.

import { gridCells, hexDistance, inGrid, type Hex } from '../shared/hex.ts';
import { effectiveSpawnDistance, type GameSettings } from '../shared/settings.ts';
import type { GameAction } from '../shared/protocol.ts';

export interface PlayerState {
  pid: number;
  userId: number;
  nickname: string;
  flag: string;
  joinedAt: number;
  q: number | null;
  r: number | null;
  hp: number;
  ap: number;
  range: number;
  alive: boolean;
  eliminatedAt: number | null;
  eliminatedBy: number | null;
}

export type EventType =
  | 'start'
  | 'move'
  | 'attack'
  | 'grant'
  | 'upgrade'
  | 'eliminate'
  | 'tick'
  | 'pause'
  | 'resume'
  | 'finish'
  | 'adjust';

export type EventData = Record<string, number | string | null | number[]>;

export interface GameEvent {
  ts: number;
  type: EventType;
  actor: number | null;
  target: number | null;
  data: EventData;
}

export type ActionOutcome = { ok: true; events: GameEvent[] } | { ok: false; error: string };

export type Players = Map<number, PlayerState>;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function fail(error: string): ActionOutcome {
  return { ok: false, error };
}

function notEnoughAp(cost: number, have: number): string {
  return `Not enough AP (need ${cost}, you have ${have})`;
}

export function positionOf(p: PlayerState): Hex | null {
  return p.q === null || p.r === null ? null : { q: p.q, r: p.r };
}

export function occupantAt(players: Players, cell: Hex): PlayerState | undefined {
  for (const p of players.values()) {
    if (p.alive && p.q === cell.q && p.r === cell.r) return p;
  }
  return undefined;
}

export function alivePlayers(players: Players): PlayerState[] {
  return [...players.values()].filter((p) => p.alive);
}

export function eliminate(p: PlayerState, by: number | null, now: number): void {
  p.alive = false;
  p.hp = Math.max(0, p.hp);
  p.q = null;
  p.r = null;
  p.eliminatedAt = now;
  p.eliminatedBy = by;
}

function resolveTarget(players: Players, actor: PlayerState, targetPid: unknown): PlayerState | string {
  if (!isInt(targetPid)) return 'Pick a player to target';
  if (targetPid === actor.pid) return "You can't target yourself";
  const target = players.get(targetPid);
  const at = target ? positionOf(target) : null;
  if (!target || !target.alive || !at) return 'That player is not on the map';
  const from = positionOf(actor)!;
  if (hexDistance(from, at) > actor.range) return `Out of range (your range is ${actor.range})`;
  return target;
}

/** Validates and applies one player action. Mutates `players` only when the action succeeds. */
export function applyAction(
  players: Players,
  settings: GameSettings,
  actorPid: number,
  action: GameAction,
  now: number,
): ActionOutcome {
  const actor = players.get(actorPid);
  if (!actor) return fail('You are not in this game');
  const from = positionOf(actor);
  if (!actor.alive || !from) return fail('You have been eliminated');
  if (!action || typeof action !== 'object') return fail('Unknown action');

  switch (action.type) {
    case 'move': {
      if (!isInt(action.q) || !isInt(action.r)) return fail('Pick a cell to move to');
      const to = { q: action.q, r: action.r };
      if (!inGrid(to, settings.gridRadius)) return fail("You can't move off the map");
      if (hexDistance(from, to) !== 1) return fail('You can only move to a neighbouring cell');
      if (occupantAt(players, to)) return fail('That cell is occupied');
      if (actor.ap < settings.costMove) return fail(notEnoughAp(settings.costMove, actor.ap));
      actor.ap -= settings.costMove;
      actor.q = to.q;
      actor.r = to.r;
      return {
        ok: true,
        events: [{ ts: now, type: 'move', actor: actor.pid, target: null, data: { from: [from.q, from.r], to: [to.q, to.r] } }],
      };
    }

    case 'attack': {
      const target = resolveTarget(players, actor, action.target);
      if (typeof target === 'string') return fail(target);
      if (actor.ap < settings.costAttack) return fail(notEnoughAp(settings.costAttack, actor.ap));
      const at = positionOf(target)!;
      actor.ap -= settings.costAttack;
      target.hp -= settings.attackDamage;
      const events: GameEvent[] = [
        {
          ts: now,
          type: 'attack',
          actor: actor.pid,
          target: target.pid,
          data: { damage: settings.attackDamage, hpLeft: Math.max(0, target.hp) },
        },
      ];
      if (target.hp <= 0) {
        eliminate(target, actor.pid, now);
        events.push({ ts: now, type: 'eliminate', actor: actor.pid, target: target.pid, data: { at: [at.q, at.r] } });
      }
      return { ok: true, events };
    }

    case 'grant': {
      const target = resolveTarget(players, actor, action.target);
      if (typeof target === 'string') return fail(target);
      if (actor.ap < settings.costGrant) return fail(notEnoughAp(settings.costGrant, actor.ap));
      actor.ap -= settings.costGrant;
      target.ap += settings.grantAmount;
      return {
        ok: true,
        events: [{ ts: now, type: 'grant', actor: actor.pid, target: target.pid, data: { amount: settings.grantAmount } }],
      };
    }

    case 'upgrade': {
      if (actor.ap < settings.costUpgrade) return fail(notEnoughAp(settings.costUpgrade, actor.ap));
      actor.ap -= settings.costUpgrade;
      actor.range += settings.upgradeAmount;
      return {
        ok: true,
        events: [{ ts: now, type: 'upgrade', actor: actor.pid, target: null, data: { range: actor.range } }],
      };
    }

    default:
      return fail('Unknown action');
  }
}

/** Grants AP to every alive player at the same instant. */
export function applyTick(players: Players, settings: GameSettings, now: number): GameEvent {
  for (const p of players.values()) {
    if (p.alive) p.ap += settings.apPerTick;
  }
  return { ts: now, type: 'tick', actor: null, target: null, data: { amount: settings.apPerTick } };
}

/**
 * Picks `count` distinct random cells, each at least `minDist` from all others.
 * Returns null if no arrangement was found (grid too small for that many players).
 */
export function spawnPositions(count: number, radius: number, minDist: number, rng: () => number, attempts = 300): Hex[] | null {
  const cells = gridCells(radius);
  if (count > cells.length) return null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const placed: Hex[] = [];
    // Cells still far enough from everyone placed so far; shrinks after each pick.
    let options = cells;
    for (let i = 0; i < count && options.length > 0; i++) {
      const pick = options[Math.floor(rng() * options.length)];
      placed.push(pick);
      options = options.filter((c) => hexDistance(c, pick) >= minDist);
    }
    if (placed.length === count) return placed;
  }
  return null;
}

/** Whether `count` players can be spawned `minDist` apart on a map of `radius` (used to validate settings). */
export function canFit(count: number, radius: number, minDist: number, rng: () => number): boolean {
  return spawnPositions(count, radius, minDist, rng, 40) !== null;
}

/** Places everyone on the map with starting stats. Returns an error string if they don't fit. */
export function startGame(players: Players, settings: GameSettings, rng: () => number, now: number): GameEvent | string {
  const list = [...players.values()];
  if (list.length < 2) return 'At least 2 players are needed to start';
  const minDist = effectiveSpawnDistance(settings);
  const spots = spawnPositions(list.length, settings.gridRadius, minDist, rng);
  if (!spots) {
    return `Can't fit ${list.length} players at least ${minDist} cells apart on a radius-${settings.gridRadius} grid; increase gridRadius`;
  }
  list.forEach((p, i) => {
    p.q = spots[i].q;
    p.r = spots[i].r;
    p.hp = settings.startHp;
    p.ap = settings.startAp;
    p.range = settings.startRange;
    p.alive = true;
    p.eliminatedAt = null;
    p.eliminatedBy = null;
  });
  return { ts: now, type: 'start', actor: null, target: null, data: {} };
}

/** Clears all in-game fields (used when a room goes back to the lobby). */
export function clearGameState(players: Players): void {
  for (const p of players.values()) {
    p.q = null;
    p.r = null;
    p.hp = 0;
    p.ap = 0;
    p.range = 0;
    p.alive = true;
    p.eliminatedAt = null;
    p.eliminatedBy = null;
  }
}
