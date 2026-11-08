// One game room: lobby, game state, timers and the connected browsers. All changes go
// through `commit`, which writes them to SQLite and then pushes per-player updates.

import { NICKNAME_MAX, type ActionResult, type GameAction, type ServerMessage } from '../shared/protocol.ts';
import { applySettingOverrides, effectiveSpawnDistance, normalizeSettings, type GameSettings } from '../shared/settings.ts';
import type { RoomRow, Store, StoredEvent } from './db.ts';
import {
  alivePlayers,
  applyAction,
  applyTick,
  canFit,
  clearGameState,
  eliminate,
  positionOf,
  startGame,
  type GameEvent,
  type PlayerState,
} from './engine.ts';
import { nextTickAfter } from './schedule.ts';
import { buildView, participantOf, personalLog, visibleEntry, type RoomSnapshot } from './views.ts';

/** A connected browser tab (or a test double). */
export interface Sink {
  userId: number;
  username: string;
  send(msg: ServerMessage): void;
  /** Serialized last state sent, used to skip updates that change nothing for this viewer. */
  lastState?: string;
}

export interface RoomContext {
  store: Store;
  now: () => number;
  rng: () => number;
  flagCodes: Set<string>;
  log: (msg: string) => void;
}

/** An error whose message is safe and meant to be shown to the user. */
export class RoomError extends Error {}

const SCHEDULE_KEYS = ['tickMode', 'tickTime', 'timezone', 'tickIntervalSec'];
/** Settings that decide whether everyone fits on the map at the start. */
const FIT_KEYS = ['gridRadius', 'maxPlayers', 'startRange', 'minSpawnDistance'];
const MAX_TIMER_MS = 2 ** 31 - 1;

function stateKey(state: unknown): string {
  return JSON.stringify({ ...(state as object), serverNow: 0 });
}

export function cleanNickname(raw: unknown): string {
  if (typeof raw !== 'string') throw new RoomError('Nickname is required');
  const s = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) throw new RoomError('Nickname cannot be empty');
  if ([...s].length > NICKNAME_MAX) throw new RoomError(`Nickname is too long (max ${NICKNAME_MAX} characters)`);
  return s;
}

export class Room implements RoomSnapshot {
  row: RoomRow;
  settings: GameSettings;
  players: Map<number, PlayerState>;
  events: StoredEvent[];
  readonly sinks = new Set<Sink>();
  deleted = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly ctx: RoomContext;

  constructor(ctx: RoomContext, row: RoomRow, players: PlayerState[], events: StoredEvent[]) {
    this.ctx = ctx;
    this.row = row;
    this.settings = normalizeSettings(JSON.parse(row.settings));
    this.players = new Map(players.map((p) => [p.pid, p]));
    this.events = events;
  }

  get code(): string {
    return this.row.code;
  }

  get phase(): RoomRow['phase'] {
    return this.row.phase;
  }

  participantOf(userId: number): PlayerState | undefined {
    return participantOf(this, userId);
  }

  playerByNickname(name: string): PlayerState | undefined {
    const lower = name.toLowerCase();
    for (const p of this.players.values()) if (p.nickname.toLowerCase() === lower) return p;
    return undefined;
  }

  // ---------------------------------------------------------------- connections

  attach(sink: Sink): void {
    this.sinks.add(sink);
    const state = buildView(this, sink.userId, this.ctx.now());
    sink.lastState = stateKey(state);
    sink.send({ type: 'update', state, entries: personalLog(this, sink.userId), resetLog: true });
  }

  detach(sink: Sink): void {
    this.sinks.delete(sink);
  }

  // ---------------------------------------------------------------- lobby

  join(user: { id: number; username: string }): void {
    if (this.phase !== 'lobby') throw new RoomError('This game has already started; no one new can join');
    if (this.participantOf(user.id)) return;
    if (this.players.size >= this.settings.maxPlayers) throw new RoomError('This room is full');
    const p: Omit<PlayerState, 'pid'> = {
      userId: user.id,
      nickname: this.uniqueNickname(user.username),
      flag: this.randomFreeFlag(),
      joinedAt: this.ctx.now(),
      q: null,
      r: null,
      hp: 0,
      ap: 0,
      range: 0,
      alive: true,
      eliminatedAt: null,
      eliminatedBy: null,
    };
    const pid = this.ctx.store.insertParticipant(this.row.id, p);
    this.players.set(pid, { ...p, pid });
    this.commit([]);
  }

  leave(userId: number): void {
    if (this.phase !== 'lobby') throw new RoomError('You can only leave while the room is in the lobby');
    if (userId === this.row.creator_id) throw new RoomError("The room's creator can't leave the lobby");
    const p = this.participantOf(userId);
    if (!p) return;
    this.removeParticipant(p.pid);
  }

  kick(byUserId: number, pid: unknown): void {
    if (byUserId !== this.row.creator_id) throw new RoomError('Only the room creator can remove players');
    if (this.phase !== 'lobby') throw new RoomError('Players can only be removed in the lobby');
    const p = typeof pid === 'number' ? this.players.get(pid) : undefined;
    if (!p) throw new RoomError('No such player');
    if (p.userId === this.row.creator_id) throw new RoomError("You can't remove yourself");
    this.removeParticipant(p.pid);
  }

  setProfile(userId: number, nickname: unknown, flag: unknown): void {
    if (this.phase !== 'lobby') throw new RoomError('Nickname and flag are fixed once the game starts');
    const me = this.participantOf(userId);
    if (!me) throw new RoomError('Join the room first');
    if (nickname !== undefined) {
      const clean = cleanNickname(nickname);
      const other = this.playerByNickname(clean);
      if (other && other.pid !== me.pid) throw new RoomError('That nickname is taken in this room');
      me.nickname = clean;
    }
    if (flag !== undefined) {
      if (typeof flag !== 'string' || !this.ctx.flagCodes.has(flag)) throw new RoomError('Unknown flag');
      const owner = [...this.players.values()].find((p) => p.flag === flag);
      if (owner && owner.pid !== me.pid) throw new RoomError(`That flag is taken by ${owner.nickname}`);
      me.flag = flag;
    }
    this.commit([]);
  }

  requestStart(byUserId: number): void {
    if (byUserId !== this.row.creator_id) throw new RoomError('Only the room creator can start the game');
    this.startGame();
  }

  private removeParticipant(pid: number): void {
    this.ctx.store.deleteParticipant(pid);
    this.players.delete(pid);
    this.commit([]);
  }

  private uniqueNickname(base: string): string {
    const root = [...base].slice(0, NICKNAME_MAX).join('');
    if (!this.playerByNickname(root)) return root;
    for (let i = 2; ; i++) {
      const suffix = String(i);
      const candidate = [...root].slice(0, NICKNAME_MAX - suffix.length).join('') + suffix;
      if (!this.playerByNickname(candidate)) return candidate;
    }
  }

  private randomFreeFlag(): string {
    const taken = new Set([...this.players.values()].map((p) => p.flag));
    const free = [...this.ctx.flagCodes].filter((c) => !taken.has(c));
    return free[Math.floor(this.ctx.rng() * free.length)] ?? 'xx';
  }

  // ---------------------------------------------------------------- game actions

  act(sink: Sink | null, userId: number, id: number, action: GameAction): ActionResult {
    const reply = (result: ActionResult): ActionResult => {
      if (!result.ok) sink?.send({ type: 'update', result });
      return result;
    };
    if (this.phase === 'lobby') return reply({ id, ok: false, error: "The game hasn't started yet" });
    if (this.phase === 'paused') return reply({ id, ok: false, error: 'The game is paused' });
    if (this.phase === 'finished') return reply({ id, ok: false, error: 'The game is over' });
    const me = this.participantOf(userId);
    if (!me) return reply({ id, ok: false, error: 'You are not in this game' });

    const now = this.ctx.now();
    const outcome = applyAction(this.players, this.settings, me.pid, action, now);
    if (!outcome.ok) return reply({ id, ok: false, error: outcome.error });
    const events = outcome.events;
    if (alivePlayers(this.players).length <= 1) events.push(this.finish(now));
    const result: ActionResult = { id, ok: true };
    this.commit(events, sink ? { sink, result } : undefined);
    return result;
  }

  // ---------------------------------------------------------------- lifecycle

  startGame(): void {
    if (this.phase !== 'lobby') throw new RoomError('The game has already started');
    const now = this.ctx.now();
    const ev = startGame(this.players, this.settings, this.ctx.rng, now);
    if (typeof ev === 'string') throw new RoomError(ev);
    Object.assign(this.row, {
      phase: 'running',
      started_at: now,
      finished_at: null,
      paused_at: null,
      winner_pid: null,
      last_tick_at: null,
      next_tick_at: nextTickAfter(this.settings, now),
    });
    this.commit([ev]);
    this.scheduleWake();
  }

  private finish(now: number): GameEvent {
    const winner = alivePlayers(this.players)[0];
    Object.assign(this.row, {
      phase: 'finished',
      finished_at: now,
      paused_at: null,
      next_tick_at: null,
      winner_pid: winner?.pid ?? null,
    });
    this.clearTimer();
    return { ts: now, type: 'finish', actor: null, target: winner?.pid ?? null, data: {} };
  }

  pause(): void {
    if (this.phase !== 'running') throw new RoomError(`Can't pause a room that is ${this.phase}`);
    const now = this.ctx.now();
    this.row.phase = 'paused';
    this.row.paused_at = now;
    this.commit([{ ts: now, type: 'pause', actor: null, target: null, data: {} }]);
    this.scheduleWake();
  }

  resume(): void {
    if (this.phase !== 'paused') throw new RoomError(`Can't resume a room that is ${this.phase}`);
    const now = this.ctx.now();
    this.row.phase = 'running';
    this.row.paused_at = null;
    // AP ticks that would have happened during the pause are skipped.
    this.row.next_tick_at = nextTickAfter(this.settings, now);
    this.commit([{ ts: now, type: 'resume', actor: null, target: null, data: {} }]);
    this.scheduleWake();
  }

  /** Back to the lobby: keeps participants (nicknames, flags) and settings, wipes the game. */
  reset(): void {
    const now = this.ctx.now();
    clearGameState(this.players);
    Object.assign(this.row, {
      phase: 'lobby',
      lobby_started_at: now,
      lobby_ends_at: now + this.settings.lobbyDurationSec * 1000,
      started_at: null,
      finished_at: null,
      paused_at: null,
      next_tick_at: null,
      last_tick_at: null,
      winner_pid: null,
    });
    this.ctx.store.deleteEvents(this.row.id);
    this.events = [];
    this.commit([]);
    for (const sink of this.sinks) this.attach(sink);
    this.scheduleWake();
  }

  /** Manual AP tick (admin). Does not move the regular schedule. */
  tick(): void {
    if (this.phase !== 'running' && this.phase !== 'paused') throw new RoomError(`Can't tick a room that is ${this.phase}`);
    const now = this.ctx.now();
    const ev = applyTick(this.players, this.settings, now);
    this.row.last_tick_at = now;
    this.commit([ev]);
  }

  /** Settings change from the room's creator in the browser: only while in the lobby. */
  updateSettingsAsCreator(userId: number, changes: unknown): void {
    if (userId !== this.row.creator_id) throw new RoomError('Only the room creator can change the game settings');
    if (this.phase !== 'lobby') throw new RoomError('Game settings can only be changed in the lobby');
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new RoomError('No changes to save');
    const overrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(changes as Record<string, unknown>)) {
      if (typeof value !== 'string' && typeof value !== 'number') throw new RoomError(`Invalid value for ${key}`);
      overrides[key] = String(value);
    }
    if (Object.keys(overrides).length === 0) return;
    this.updateSettings(overrides);
  }

  /** Validates and applies setting changes (admin CLI, or the creator via updateSettingsAsCreator). */
  updateSettings(overrides: Record<string, string>): void {
    const keys = Object.keys(overrides);
    if (this.phase !== 'lobby' && keys.includes('gridRadius')) {
      throw new RoomError('gridRadius can only be changed while the room is in the lobby');
    }
    let next: GameSettings;
    try {
      next = applySettingOverrides(this.settings, overrides);
    } catch (err) {
      throw new RoomError((err as Error).message);
    }
    if (this.phase === 'lobby') {
      if (next.maxPlayers < this.players.size) {
        throw new RoomError(`${this.players.size} players have already joined, so max players can't be lower than that`);
      }
      if (keys.some((k) => FIT_KEYS.includes(k))) {
        const dist = effectiveSpawnDistance(next);
        if (!canFit(next.maxPlayers, next.gridRadius, dist, this.ctx.rng)) {
          throw new RoomError(
            `A radius-${next.gridRadius} map can't fit ${next.maxPlayers} players at least ${dist} cells apart. Make the map bigger or the room smaller.`,
          );
        }
      }
    }
    const now = this.ctx.now();
    this.settings = next;
    this.row.settings = JSON.stringify(next);
    if (this.phase === 'lobby' && keys.includes('lobbyDurationSec')) {
      // Counted from when the lobby opened, but never less than a minute from now.
      this.row.lobby_ends_at = Math.max(this.row.lobby_started_at + next.lobbyDurationSec * 1000, now + 60_000);
    }
    if (this.phase === 'running' && keys.some((k) => SCHEDULE_KEYS.includes(k))) {
      this.row.next_tick_at = nextTickAfter(next, now);
    }
    this.commit([]);
    this.scheduleWake();
  }

  /** Admin edit of a player's hidden stats (for testing). */
  adjustPlayer(pid: number, changes: { hp?: number; ap?: number; range?: number }): void {
    if (this.phase !== 'running' && this.phase !== 'paused') throw new RoomError('Stats can only be changed during a game');
    const p = this.players.get(pid);
    if (!p) throw new RoomError('No such player');
    if (!p.alive) throw new RoomError(`${p.nickname} has been eliminated`);
    const now = this.ctx.now();
    if (changes.hp !== undefined) p.hp = changes.hp;
    if (changes.ap !== undefined) p.ap = Math.max(0, changes.ap);
    if (changes.range !== undefined) p.range = Math.max(1, changes.range);
    const events: GameEvent[] = [{ ts: now, type: 'adjust', actor: null, target: pid, data: { ...changes } }];
    if (p.hp <= 0) {
      const at = positionOf(p)!;
      eliminate(p, null, now);
      events.push({ ts: now, type: 'eliminate', actor: null, target: pid, data: { at: [at.q, at.r] } });
      if (this.phase === 'running' && alivePlayers(this.players).length <= 1) events.push(this.finish(now));
    }
    this.commit(events);
  }

  // ---------------------------------------------------------------- time

  /** Handles everything that is due: lobby deadline and AP ticks (including missed daily ticks). */
  processTime(): void {
    if (this.deleted) return;
    const now = this.ctx.now();
    if (this.phase === 'lobby' && this.row.lobby_ends_at !== null && now >= this.row.lobby_ends_at) {
      let started = false;
      if (this.players.size >= 2) {
        try {
          this.startGame();
          started = true;
        } catch (err) {
          this.ctx.log(`room ${this.code}: automatic start failed: ${(err as Error).message}`);
        }
      }
      if (!started) {
        // Deadline passed without a start: wait for the creator to start the game.
        this.row.lobby_ends_at = null;
        this.commit([]);
      }
    }
    if (this.phase === 'running' && this.row.next_tick_at !== null && now >= this.row.next_tick_at) {
      const events: GameEvent[] = [];
      if (this.settings.tickMode === 'daily') {
        // Catch up on daily ticks missed while the server was down.
        let guard = 0;
        while (this.row.next_tick_at !== null && this.row.next_tick_at <= now && guard++ < 400) {
          events.push(applyTick(this.players, this.settings, this.row.next_tick_at));
          this.row.last_tick_at = this.row.next_tick_at;
          this.row.next_tick_at = nextTickAfter(this.settings, this.row.next_tick_at);
        }
      } else {
        events.push(applyTick(this.players, this.settings, now));
        this.row.last_tick_at = now;
        const interval = this.settings.tickIntervalSec * 1000;
        let next = this.row.next_tick_at + interval;
        if (next <= now) next = now + interval;
        this.row.next_tick_at = next;
      }
      this.commit(events);
    }
    this.scheduleWake();
  }

  scheduleWake(): void {
    this.clearTimer();
    if (this.deleted) return;
    let target: number | null = null;
    if (this.phase === 'lobby') target = this.row.lobby_ends_at;
    else if (this.phase === 'running') target = this.row.next_tick_at;
    if (target === null) return;
    const delay = Math.min(Math.max(0, target - this.ctx.now()), MAX_TIMER_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.processTime();
      } catch (err) {
        this.ctx.log(`room ${this.code}: timer error: ${(err as Error).stack}`);
      }
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.deleted = true;
    this.clearTimer();
    for (const sink of this.sinks) sink.send({ type: 'fatal', message: 'This room was deleted' });
    this.sinks.clear();
  }

  // ---------------------------------------------------------------- persistence & broadcast

  private commit(newEvents: GameEvent[], reply?: { sink: Sink; result: ActionResult }): void {
    const store = this.ctx.store;
    const stored = store.transaction(() => {
      store.updateRoom(this.row);
      for (const p of this.players.values()) store.updateParticipant(p);
      return newEvents.map((e) => store.insertEvent(this.row.id, e));
    });
    this.events.push(...stored);
    this.broadcast(stored, reply);
  }

  private broadcast(stored: StoredEvent[], reply?: { sink: Sink; result: ActionResult }): void {
    const now = this.ctx.now();
    for (const sink of this.sinks) {
      const state = buildView(this, sink.userId, now);
      const key = stateKey(state);
      const pid = this.participantOf(sink.userId)?.pid ?? null;
      const mayLog = pid !== null || this.phase === 'lobby';
      const entries = mayLog ? stored.map((e) => visibleEntry(e, pid)).filter((e) => e !== null) : [];
      const result = reply && reply.sink === sink ? reply.result : undefined;
      // Skip viewers for whom nothing visible changed, so hidden actions leave no trace.
      if (key === sink.lastState && entries.length === 0 && !result) continue;
      const msg: Extract<ServerMessage, { type: 'update' }> = { type: 'update' };
      if (key !== sink.lastState) msg.state = state;
      if (entries.length) msg.entries = entries;
      if (result) msg.result = result;
      sink.lastState = key;
      sink.send(msg);
    }
  }
}
