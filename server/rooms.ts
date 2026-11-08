// Keeps all rooms in memory, creates new ones, and holds the default settings for new rooms
// (built-in defaults <- defaults saved by the admin CLI <- server startup flags).

import { randomInt } from 'node:crypto';
import { ROOM_NAME_MAX, type RoomSummary, type RoomsResponse } from '../shared/protocol.ts';
import { applySettingOverrides, DEFAULT_SETTINGS, normalizeSettings, type GameSettings } from '../shared/settings.ts';
import type { RoomRow, Store } from './db.ts';
import { Room, RoomError, type RoomContext } from './room.ts';

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const DEFAULTS_KEY = 'defaults';

export function cleanRoomName(raw: unknown): string {
  if (typeof raw !== 'string') throw new RoomError('Room name is required');
  const s = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim();
  if (!s) throw new RoomError('Room name is required');
  if ([...s].length > ROOM_NAME_MAX) throw new RoomError(`Room name is too long (max ${ROOM_NAME_MAX} characters)`);
  return s;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly ctx: RoomContext;
  private readonly startupOverrides: Record<string, string>;

  constructor(ctx: RoomContext, startupOverrides: Record<string, string> = {}) {
    this.ctx = ctx;
    this.startupOverrides = startupOverrides;
    // Validate early so a bad --set flag fails at startup.
    this.defaults();
  }

  get store(): Store {
    return this.ctx.store;
  }

  /** Loads every room from the database and catches up on anything that came due while down. */
  loadAll(): void {
    for (const row of this.ctx.store.loadRooms()) {
      const room = new Room(this.ctx, row, this.ctx.store.loadParticipants(row.id), this.ctx.store.loadEvents(row.id));
      this.rooms.set(row.code, room);
    }
    for (const room of this.rooms.values()) room.processTime();
  }

  /** Defaults saved via the admin CLI (without startup flags). */
  savedDefaults(): Record<string, string | number> {
    const raw = this.ctx.store.getKv(DEFAULTS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string | number>) : {};
  }

  defaults(): GameSettings {
    const saved = normalizeSettings({ ...DEFAULT_SETTINGS, ...this.savedDefaults() });
    return applySettingOverrides(saved, this.startupOverrides);
  }

  setDefaults(overrides: Record<string, string>): void {
    // Validate against the current defaults first.
    applySettingOverrides(this.defaults(), overrides);
    const next = { ...this.savedDefaults(), ...overrides };
    this.ctx.store.setKv(DEFAULTS_KEY, JSON.stringify(next));
  }

  get(code: unknown): Room | undefined {
    return typeof code === 'string' ? this.rooms.get(code.toLowerCase()) : undefined;
  }

  require(code: string): Room {
    const room = this.get(code);
    if (!room) throw new RoomError(`No room with code "${code}"`);
    return room;
  }

  create(creator: { id: number; username: string }, name: unknown): Room {
    const cleanName = cleanRoomName(name);
    const settings = this.defaults();
    const now = this.ctx.now();
    let code: string;
    do {
      code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    const row: Omit<RoomRow, 'id'> = {
      code,
      name: cleanName,
      creator_id: creator.id,
      phase: 'lobby',
      settings: JSON.stringify(settings),
      created_at: now,
      lobby_started_at: now,
      lobby_ends_at: now + settings.lobbyDurationSec * 1000,
      started_at: null,
      finished_at: null,
      paused_at: null,
      next_tick_at: null,
      last_tick_at: null,
      winner_pid: null,
    };
    const id = this.ctx.store.insertRoom(row);
    const room = new Room(this.ctx, { ...row, id }, [], []);
    this.rooms.set(code, room);
    room.join(creator);
    room.scheduleWake();
    return room;
  }

  delete(code: string): void {
    const room = this.require(code);
    room.dispose();
    this.ctx.store.deleteRoom(room.row.id);
    this.rooms.delete(room.code);
  }

  summary(room: Room, userId: number): RoomSummary {
    const me = room.participantOf(userId);
    const creator = room.participantOf(room.row.creator_id);
    const winner = room.row.winner_pid !== null ? room.players.get(room.row.winner_pid) : undefined;
    return {
      code: room.code,
      name: room.row.name,
      phase: room.phase,
      players: room.players.size,
      maxPlayers: room.settings.maxPlayers,
      lobbyEndsAt: room.row.lobby_ends_at,
      creator: creator?.nickname ?? this.ctx.store.userById(room.row.creator_id)?.username ?? '?',
      joined: me !== undefined,
      alive: me && room.phase !== 'lobby' ? me.alive : null,
      winner: winner?.nickname ?? null,
    };
  }

  listFor(userId: number): RoomsResponse {
    const open: RoomSummary[] = [];
    const mine: RoomSummary[] = [];
    for (const room of this.rooms.values()) {
      const joined = room.participantOf(userId) !== undefined;
      if (joined) mine.push(this.summary(room, userId));
      else if (room.phase === 'lobby') open.push(this.summary(room, userId));
    }
    mine.reverse();
    open.reverse();
    return { open, mine, serverNow: this.ctx.now() };
  }
}
