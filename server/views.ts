// The ONLY place where room state is turned into data for a client. Every message a
// browser receives is built here, per viewer, so this file decides what stays secret:
// other players' HP, AP and range never leave the server until the game is finished.

import { normalizeCounts } from '../shared/costs.ts';
import type { LogEntry, PeaceView, PublicPlayer, RatingChange, Reveal, RevealPlayer, RoomView } from '../shared/protocol.ts';
import type { GameSettings, RevealMode } from '../shared/settings.ts';
import type { RoomRow, StoredEvent } from './db.ts';
import type { PlayerState } from './engine.ts';
import type { BlitzGiftView, BlitzShotView, BlitzTurnView, BlitzView } from '../shared/blitz.ts';
import { chargeOf, type BlitzState, type BlitzTurnReport } from './blitz.ts';

export interface RoomSnapshot {
  row: RoomRow;
  settings: GameSettings;
  players: Map<number, PlayerState>;
  events: StoredEvent[];
  /** Rating changes once a rated game is finished (Room caches them). */
  ratings?: RatingChange[] | null;
  /** Whether a finished game here changes ratings. */
  rated?: boolean;
  /** Username and avatar file of an account; without it players carry neither. */
  userBrief?(userId: number): { username: string; avatar: string | null } | undefined;
  /** Blitz rooms once started (server/blitz.ts). */
  blitz?: BlitzState | null;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function pair(v: unknown): [number, number] | undefined {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
    ? [v[0], v[1]]
    : undefined;
}

function pids(v: unknown): number[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : undefined;
}

/** Parses a room's stored peace column. */
export function parsePeace(raw: string | null | undefined): PeaceView | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as PeaceView;
    return v && typeof v.proposer === 'number' && Array.isArray(v.signers) ? v : null;
  } catch {
    return null;
  }
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
      return strip({ ...base, type: 'finish', target: ev.target ?? undefined, pids: pids(ev.data.peace) });
    case 'peace-propose':
    case 'peace-sign':
    case 'peace-decline':
      return strip({ ...base, type: ev.type, actor: ev.actor ?? undefined });
    case 'peace-cancel':
      // Cancelled by an attack: everyone learns an attack happened, never by whom.
      return { ...base, type: 'peace-cancel' };
    case 'eliminate':
      return strip({ ...base, type: 'eliminate', actor: ev.actor ?? undefined, target: ev.target ?? undefined, at: pair(ev.data.at) });
    case 'turn':
      // Blitz: a turn resolved. Shots land on the open board, so their count is public.
      return { ...base, type: 'turn', value: num(ev.data.turn), amount: num(ev.data.hits) ?? 0, extra: num(ev.data.misses) ?? 0 };
    case 'charge':
      // Blitz: charge levels are public on purpose (a charged attacker can be dodged).
      return strip({ ...base, type: 'charge', actor: ev.actor ?? undefined, value: num(ev.data.level) });
    default:
      return null;
  }
}

/**
 * What one player sees of an event in their personal log (null = nothing). `reveal` is the
 * room's revealActions setting: with 'hidden' (default) victims never learn who hit them and
 * receivers never learn who gave them AP; with 'attacks' every participant sees each attack
 * with its attacker as it happens; with 'all' AP gifts too.
 */
export function visibleEntry(ev: StoredEvent, viewerPid: number | null, reveal: RevealMode = 'hidden'): LogEntry | null {
  const pub = publicEntry(ev);
  if (pub) return pub;
  if (viewerPid === null) return null;
  const base = { id: ev.id, ts: ev.ts };
  const attacksPublic = reveal === 'attacks' || reveal === 'all';
  const grantsPublic = reveal === 'all';
  switch (ev.type) {
    case 'attack':
      if (ev.actor === viewerPid) return { ...base, type: 'attack', target: ev.target ?? undefined, amount: num(ev.data.damage) };
      if (ev.target === viewerPid) {
        // The victim learns they were hit; by whom only when attacks are public.
        return attacksPublic
          ? strip({ ...base, type: 'hit', actor: ev.actor ?? undefined, amount: num(ev.data.damage) })
          : { ...base, type: 'hit', amount: num(ev.data.damage) };
      }
      if (attacksPublic) return strip({ ...base, type: 'attack', actor: ev.actor ?? undefined, target: ev.target ?? undefined, amount: num(ev.data.damage) });
      return null;
    case 'grant':
      if (ev.actor === viewerPid) return { ...base, type: 'grant', target: ev.target ?? undefined, amount: num(ev.data.amount) };
      if (ev.target === viewerPid) {
        // Grants are anonymous for the receiver unless gifts are public.
        return grantsPublic
          ? strip({ ...base, type: 'granted', actor: ev.actor ?? undefined, amount: num(ev.data.amount) })
          : { ...base, type: 'granted', amount: num(ev.data.amount) };
      }
      if (grantsPublic) return strip({ ...base, type: 'grant', actor: ev.actor ?? undefined, target: ev.target ?? undefined, amount: num(ev.data.amount) });
      return null;
    case 'upgrade':
      if (ev.actor === viewerPid) return { ...base, type: 'upgrade', value: num(ev.data.range) };
      return null;
    case 'miss':
      // Blitz: a shot into a cell nobody stood on. The shooter learns it; others only with public attacks.
      if (ev.actor === viewerPid) return strip({ ...base, type: 'miss', at: pair(ev.data.cell), amount: num(ev.data.damage) });
      if (attacksPublic) return strip({ ...base, type: 'miss', actor: ev.actor ?? undefined, at: pair(ev.data.cell), amount: num(ev.data.damage) });
      return null;
    case 'gift-lost':
      if (ev.actor === viewerPid) return strip({ ...base, type: 'gift-lost', at: pair(ev.data.cell), amount: num(ev.data.amount) });
      if (grantsPublic) return strip({ ...base, type: 'gift-lost', actor: ev.actor ?? undefined, at: pair(ev.data.cell), amount: num(ev.data.amount) });
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
    case 'peace-cancel':
      return strip({ ...base, type: 'peace-cancel', actor: ev.actor ?? undefined });
    case 'miss':
      return strip({ ...base, type: 'miss', actor: ev.actor ?? undefined, at: pair(ev.data.cell), amount: num(ev.data.damage) });
    case 'gift-lost':
      return strip({ ...base, type: 'gift-lost', actor: ev.actor ?? undefined, at: pair(ev.data.cell), amount: num(ev.data.amount) });
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
    ? [...room.players.values()].map((p) => {
        const pub: PublicPlayer = {
          pid: p.pid,
          nickname: p.nickname,
          flag: p.flag,
          alive: p.alive,
          q: p.alive ? p.q : null,
          r: p.alive ? p.r : null,
          eliminatedBy: p.eliminatedBy,
          eliminatedAt: p.eliminatedAt,
          isCreator: p.userId === row.creator_id,
        };
        const brief = room.userBrief?.(p.userId);
        if (brief) {
          pub.username = brief.username;
          if (brief.avatar) pub.avatar = `/avatars/${brief.avatar}`;
        }
        return pub;
      })
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
    peace: me && (row.phase === 'running' || row.phase === 'paused' || finished) ? parsePeace(row.peace) : null,
    rated: room.rated ?? row.rated !== 0,
    ratings: finished && me ? (room.ratings ?? null) : null,
    players,
    me:
      me && row.phase !== 'lobby'
        ? { pid: me.pid, hp: Math.max(0, me.hp), ap: me.ap, range: me.range, alive: me.alive, used: normalizeCounts(me.used) }
        : me
          ? { pid: me.pid, hp: room.settings.startHp, ap: room.settings.startAp, range: room.settings.startRange, alive: true }
          : null,
    reveal: finished && me ? buildReveal(room.players, room.events) : null,
    // classic rooms carry no blitz key at all
    ...((): { blitz?: BlitzView } => {
      const b = blitzView(room, me, canSeePlayers);
      return b ? { blitz: b } : {};
    })(),
  };
}

/**
 * Blitz: the turn, its clock, who confirmed (never what), everyone's charge, and the
 * viewer's own orders. Other players' orders never leave the server before resolution.
 */
function blitzView(room: RoomSnapshot, me: PlayerState | undefined, canSee: boolean): BlitzView | null {
  const st = room.blitz;
  const { row } = room;
  if (!st || room.settings.mode !== 'blitz' || row.phase === 'lobby' || !canSee) return null;
  const alive = [...room.players.values()].filter((p) => p.alive);
  const charges: Record<number, number> = {};
  for (const p of alive) charges[p.pid] = chargeOf(st, p.pid);
  const planning = (row.phase === 'running' || row.phase === 'paused') && !!me?.alive;
  const finished = row.phase === 'finished';
  return {
    turn: st.turn,
    deadline: row.phase === 'running' ? row.next_tick_at : null,
    planningFrom: row.phase === 'running' ? st.planningFrom : null,
    confirmed: st.confirmed.filter((pid) => alive.some((p) => p.pid === pid)),
    charges,
    myOrders: planning && me ? (st.orders[String(me.pid)] ?? []) : null,
    myConfirmed: planning && !!me && st.confirmed.includes(me.pid),
    // After the game everything is revealed, like the end-screen history.
    last: st.last && me ? blitzTurnView(st.last, me.pid, finished ? 'all' : room.settings.revealActions) : null,
  };
}

/** One resolved turn as `viewer` may see it: moves and impact cells are public; who shot and how hard is not. */
export function blitzTurnView(r: BlitzTurnReport, viewer: number | null, reveal: RevealMode): BlitzTurnView {
  const attacksPublic = reveal === 'attacks' || reveal === 'all';
  const grantsPublic = reveal === 'all';
  const shots: BlitzShotView[] = r.shots.map((s) => {
    const mine = s.pid === viewer;
    const onMe = s.victim !== null && s.victim === viewer;
    const v: BlitzShotView = { cell: s.cell, hit: s.victim !== null, mine };
    if (mine || attacksPublic) {
      v.pid = s.pid;
      v.from = s.from;
    }
    if (mine || onMe || attacksPublic) {
      v.damage = s.damage;
      v.charged = s.charged;
    }
    if (onMe) v.onMe = true;
    return v;
  });
  const gifts: BlitzGiftView[] = [];
  for (const g of r.gifts) {
    const mine = g.pid === viewer;
    const toMe = g.to !== null && g.to === viewer;
    if (!mine && !toMe && !grantsPublic) continue;
    const v: BlitzGiftView = { cell: g.cell, to: g.to, amount: g.amount, mine };
    if (mine || grantsPublic) {
      v.pid = g.pid;
      v.from = g.from;
    }
    gifts.push(v);
  }
  const out: BlitzTurnView = {
    turn: r.turn,
    resolvedAt: r.resolvedAt,
    moves: r.moves.map((m) => ({ ...m })),
    shots,
    gifts,
    charges: r.charges.map((c) => ({ ...c })),
    eliminated: r.eliminated.map((e) => ({ ...e })),
  };
  if (viewer !== null) {
    const range = r.ranges.find((x) => x.pid === viewer);
    if (range) out.myRange = range.range;
    const dmg = r.shots.filter((s) => s.victim === viewer).reduce((a, s) => a + s.damage, 0);
    if (dmg) out.myDamage = dmg;
    const got = r.gifts.filter((g) => g.to === viewer).reduce((a, g) => a + g.amount, 0);
    if (got) out.myGifts = got;
  }
  return out;
}

/** A viewer's personal log (newest last), capped to the most recent `limit` entries. */
export function personalLog(room: RoomSnapshot, viewerUserId: number, limit = 500): LogEntry[] {
  const me = participantOf(room, viewerUserId);
  if (!me && room.row.phase !== 'lobby') return [];
  const pid = me?.pid ?? null;
  const out: LogEntry[] = [];
  for (const ev of room.events) {
    const e = visibleEntry(ev, pid, room.settings.revealActions);
    if (e) out.push(e);
  }
  return out.slice(-limit);
}
