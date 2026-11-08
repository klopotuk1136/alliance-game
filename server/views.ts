// The ONLY place where room state is turned into data for a client. Every message a
// browser receives is built here, per viewer, so this file decides what stays secret:
// other players' HP, AP and range never leave the server until the game is finished.

import type { LogEntry, PublicPlayer, Reveal, RevealPlayer, RoomView } from '../shared/protocol.ts';
import type { GameSettings } from '../shared/settings.ts';
import type { RoomRow, StoredEvent } from './db.ts';
import type { PlayerState } from './engine.ts';

export interface RoomSnapshot {
  row: RoomRow;
  settings: GameSettings;
  players: Map<number, PlayerState>;
  events: StoredEvent[];
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function pair(v: unknown): [number, number] | undefined {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
    ? [v[0], v[1]]
    : undefined;
}

function strip(entry: LogEntry): LogEntry {
  for (const k of Object.keys(entry) as Array<keyof LogEntry>) {
    if (entry[k] === undefined || entry[k] === null) delete entry[k];
  }
  return entry;
}

/** Public events everyone in the room may see. */
function publicEntry(ev: StoredEvent): LogEntry | null {
  const base = { id: ev.id, ts: ev.ts };
  switch (ev.type) {
    case 'start':
    case 'pause':
    case 'resume':
      return { ...base, type: ev.type };
    case 'tick':
      return { ...base, type: 'tick', amount: num(ev.data.amount) };
    case 'finish':
      return strip({ ...base, type: 'finish', target: ev.target ?? undefined });
    case 'eliminate':
      return strip({ ...base, type: 'eliminate', actor: ev.actor ?? undefined, target: ev.target ?? undefined, at: pair(ev.data.at) });
    default:
      return null;
  }
}

/** What one player sees of an event in their personal log (null = nothing). */
export function visibleEntry(ev: StoredEvent, viewerPid: number | null): LogEntry | null {
  const pub = publicEntry(ev);
  if (pub) return pub;
  if (viewerPid === null) return null;
  const base = { id: ev.id, ts: ev.ts };
  switch (ev.type) {
    case 'attack':
      if (ev.actor === viewerPid) return { ...base, type: 'attack', target: ev.target ?? undefined, amount: num(ev.data.damage) };
      // The victim learns they were hit, never by whom.
      if (ev.target === viewerPid) return { ...base, type: 'hit', amount: num(ev.data.damage) };
      return null;
    case 'grant':
      if (ev.actor === viewerPid) return { ...base, type: 'grant', target: ev.target ?? undefined, amount: num(ev.data.amount) };
      // Grants are anonymous for the receiver.
      if (ev.target === viewerPid) return { ...base, type: 'granted', amount: num(ev.data.amount) };
      return null;
    case 'upgrade':
      if (ev.actor === viewerPid) return { ...base, type: 'upgrade', value: num(ev.data.range) };
      return null;
    case 'adjust':
      if (ev.target === viewerPid) return { ...base, type: 'adjust' };
      return null;
    default:
      // moves are visible on the map; they are not logged
      return null;
  }
}

/** Full-detail history entry, only used once the game is finished. */
export function revealEntry(ev: StoredEvent): LogEntry | null {
  const base = { id: ev.id, ts: ev.ts };
  switch (ev.type) {
    case 'attack':
      return strip({ ...base, type: 'attack', actor: ev.actor ?? undefined, target: ev.target ?? undefined, amount: num(ev.data.damage), value: num(ev.data.hpLeft) });
    case 'grant':
      return strip({ ...base, type: 'grant', actor: ev.actor ?? undefined, target: ev.target ?? undefined, amount: num(ev.data.amount) });
    case 'upgrade':
      return strip({ ...base, type: 'upgrade', actor: ev.actor ?? undefined, value: num(ev.data.range) });
    case 'adjust':
      return strip({ ...base, type: 'adjust', target: ev.target ?? undefined });
    default:
      return publicEntry(ev);
  }
}

export function buildReveal(players: Map<number, PlayerState>, events: StoredEvent[]): Reveal {
  const stats = new Map<number, RevealPlayer>();
  for (const p of players.values()) {
    stats.set(p.pid, {
      pid: p.pid,
      hp: Math.max(0, p.hp),
      ap: p.ap,
      range: p.range,
      kills: 0,
      damageDealt: 0,
      damageTaken: 0,
      apGiven: 0,
      apReceived: 0,
      upgrades: 0,
    });
  }
  const history: LogEntry[] = [];
  for (const ev of events) {
    const actor = ev.actor !== null ? stats.get(ev.actor) : undefined;
    const target = ev.target !== null ? stats.get(ev.target) : undefined;
    if (ev.type === 'attack') {
      const dmg = num(ev.data.damage) ?? 0;
      if (actor) actor.damageDealt += dmg;
      if (target) target.damageTaken += dmg;
    } else if (ev.type === 'grant') {
      const amount = num(ev.data.amount) ?? 0;
      if (actor) actor.apGiven += amount;
      if (target) target.apReceived += amount;
    } else if (ev.type === 'upgrade') {
      if (actor) actor.upgrades += 1;
    } else if (ev.type === 'eliminate') {
      if (actor) actor.kills += 1;
    }
    const entry = revealEntry(ev);
    if (entry) history.push(entry);
  }
  return { players: [...stats.values()], history };
}

export function participantOf(room: RoomSnapshot, userId: number): PlayerState | undefined {
  for (const p of room.players.values()) if (p.userId === userId) return p;
  return undefined;
}

/** The room as one particular user is allowed to see it. */
export function buildView(room: RoomSnapshot, viewerUserId: number, now: number): RoomView {
  const { row } = room;
  const me = participantOf(room, viewerUserId);
  const finished = row.phase === 'finished';
  // Outsiders may look at a lobby (to decide whether to join) but not at a running game.
  const canSeePlayers = row.phase === 'lobby' || me !== undefined;
  const players: PublicPlayer[] = canSeePlayers
    ? [...room.players.values()].map((p) => ({
        pid: p.pid,
        nickname: p.nickname,
        flag: p.flag,
        alive: p.alive,
        q: p.alive ? p.q : null,
        r: p.alive ? p.r : null,
        eliminatedBy: p.eliminatedBy,
        eliminatedAt: p.eliminatedAt,
        isCreator: p.userId === row.creator_id,
      }))
    : [];
  return {
    code: row.code,
    name: row.name,
    phase: row.phase,
    serverNow: now,
    rules: { ...room.settings },
    isCreator: row.creator_id === viewerUserId,
    participant: me !== undefined,
    lobbyEndsAt: row.lobby_ends_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    pausedAt: row.paused_at,
    nextTickAt: row.phase === 'running' ? row.next_tick_at : null,
    winnerPid: row.winner_pid,
    players,
    me:
      me && row.phase !== 'lobby'
        ? { pid: me.pid, hp: Math.max(0, me.hp), ap: me.ap, range: me.range, alive: me.alive }
        : me
          ? { pid: me.pid, hp: room.settings.startHp, ap: room.settings.startAp, range: room.settings.startRange, alive: true }
          : null,
    reveal: finished && me ? buildReveal(room.players, room.events) : null,
  };
}

/** A viewer's personal log (newest last), capped to the most recent `limit` entries. */
export function personalLog(room: RoomSnapshot, viewerUserId: number, limit = 500): LogEntry[] {
  const me = participantOf(room, viewerUserId);
  if (!me && room.row.phase !== 'lobby') return [];
  const pid = me?.pid ?? null;
  const out: LogEntry[] = [];
  for (const ev of room.events) {
    const e = visibleEntry(ev, pid);
    if (e) out.push(e);
  }
  return out.slice(-limit);
}
