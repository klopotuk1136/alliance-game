// SQLite persistence (Node's built-in node:sqlite). The server keeps the live state in
// memory and writes every change through to this database, so a restart loses nothing.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Phase } from '../shared/protocol.ts';
import type { EventData, EventType, GameEvent, PlayerState } from './engine.ts';

export interface UserRow {
  id: number;
  username: string;
  pass_hash: string;
  created_at: number;
}

export interface RoomRow {
  id: number;
  code: string;
  name: string;
  creator_id: number;
  phase: Phase;
  settings: string;
  created_at: number;
  lobby_started_at: number;
  lobby_ends_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  paused_at: number | null;
  next_tick_at: number | null;
  last_tick_at: number | null;
  winner_pid: number | null;
}

export interface StoredEvent extends GameEvent {
  id: number;
}

interface ParticipantRow {
  id: number;
  room_id: number;
  user_id: number;
  nickname: string;
  flag: string;
  joined_at: number;
  q: number | null;
  r: number | null;
  hp: number;
  ap: number;
  atk_range: number;
  alive: number;
  eliminated_at: number | null;
  eliminated_by: number | null;
}

interface EventRow {
  id: number;
  room_id: number;
  ts: number;
  type: string;
  actor: number | null;
  target: number | null;
  data: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  creator_id INTEGER NOT NULL,
  phase TEXT NOT NULL,
  settings TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  lobby_started_at INTEGER NOT NULL,
  lobby_ends_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  paused_at INTEGER,
  next_tick_at INTEGER,
  last_tick_at INTEGER,
  winner_pid INTEGER
);
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  flag TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  q INTEGER,
  r INTEGER,
  hp INTEGER NOT NULL DEFAULT 0,
  ap INTEGER NOT NULL DEFAULT 0,
  atk_range INTEGER NOT NULL DEFAULT 0,
  alive INTEGER NOT NULL DEFAULT 1,
  eliminated_at INTEGER,
  eliminated_by INTEGER,
  UNIQUE (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor INTEGER,
  target INTEGER,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_room ON events(room_id, id);
`;

function toPlayer(row: ParticipantRow): PlayerState {
  return {
    pid: row.id,
    userId: row.user_id,
    nickname: row.nickname,
    flag: row.flag,
    joinedAt: row.joined_at,
    q: row.q,
    r: row.r,
    hp: row.hp,
    ap: row.ap,
    range: row.atk_range,
    alive: row.alive === 1,
    eliminatedAt: row.eliminated_at,
    eliminatedBy: row.eliminated_by,
  };
}

function toEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    ts: row.ts,
    type: row.type as EventType,
    actor: row.actor,
    target: row.target,
    data: JSON.parse(row.data) as EventData,
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` inside a transaction; rolls back if it throws. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- users & sessions ----

  createUser(username: string, passHash: string, now: number): UserRow {
    const res = this.db
      .prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)')
      .run(username, passHash, now);
    return { id: Number(res.lastInsertRowid), username, pass_hash: passHash, created_at: now };
  }

  userByName(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }

  userById(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  listUsers(): UserRow[] {
    return this.db.prepare('SELECT * FROM users ORDER BY id').all() as unknown as UserRow[];
  }

  setPassword(userId: number, passHash: string): void {
    this.db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(passHash, userId);
  }

  deleteUser(userId: number): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  createSession(tokenHash: string, userId: number, now: number): void {
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)').run(tokenHash, userId, now);
  }

  userBySession(tokenHash: string): UserRow | undefined {
    return this.db
      .prepare('SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?')
      .get(tokenHash) as UserRow | undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteUserSessions(userId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  // ---- key/value ----

  getKv(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // ---- rooms ----

  insertRoom(row: Omit<RoomRow, 'id'>): number {
    const res = this.db
      .prepare(
        `INSERT INTO rooms (code, name, creator_id, phase, settings, created_at, lobby_started_at, lobby_ends_at,
           started_at, finished_at, paused_at, next_tick_at, last_tick_at, winner_pid)
         VALUES (:code, :name, :creator_id, :phase, :settings, :created_at, :lobby_started_at, :lobby_ends_at,
           :started_at, :finished_at, :paused_at, :next_tick_at, :last_tick_at, :winner_pid)`,
      )
      .run({ ...row });
    return Number(res.lastInsertRowid);
  }

  updateRoom(row: RoomRow): void {
    this.db
      .prepare(
        `UPDATE rooms SET name = :name, phase = :phase, settings = :settings, lobby_started_at = :lobby_started_at,
           lobby_ends_at = :lobby_ends_at, started_at = :started_at, finished_at = :finished_at, paused_at = :paused_at,
           next_tick_at = :next_tick_at, last_tick_at = :last_tick_at, winner_pid = :winner_pid
         WHERE id = :id`,
      )
      .run({
        id: row.id,
        name: row.name,
        phase: row.phase,
        settings: row.settings,
        lobby_started_at: row.lobby_started_at,
        lobby_ends_at: row.lobby_ends_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
        paused_at: row.paused_at,
        next_tick_at: row.next_tick_at,
        last_tick_at: row.last_tick_at,
        winner_pid: row.winner_pid,
      });
  }

  deleteRoom(roomId: number): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE room_id = ?').run(roomId);
      this.db.prepare('DELETE FROM participants WHERE room_id = ?').run(roomId);
      this.db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
    });
  }

  loadRooms(): RoomRow[] {
    return this.db.prepare('SELECT * FROM rooms ORDER BY id').all() as unknown as RoomRow[];
  }

  // ---- participants ----

  insertParticipant(roomId: number, p: Omit<PlayerState, 'pid'>): number {
    const res = this.db
      .prepare(
        `INSERT INTO participants (room_id, user_id, nickname, flag, joined_at, q, r, hp, ap, atk_range, alive, eliminated_at, eliminated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(roomId, p.userId, p.nickname, p.flag, p.joinedAt, p.q, p.r, p.hp, p.ap, p.range, p.alive ? 1 : 0, p.eliminatedAt, p.eliminatedBy);
    return Number(res.lastInsertRowid);
  }

  updateParticipant(p: PlayerState): void {
    this.db
      .prepare(
        `UPDATE participants SET nickname = ?, flag = ?, q = ?, r = ?, hp = ?, ap = ?, atk_range = ?, alive = ?,
           eliminated_at = ?, eliminated_by = ? WHERE id = ?`,
      )
      .run(p.nickname, p.flag, p.q, p.r, p.hp, p.ap, p.range, p.alive ? 1 : 0, p.eliminatedAt, p.eliminatedBy, p.pid);
  }

  deleteParticipant(pid: number): void {
    this.db.prepare('DELETE FROM participants WHERE id = ?').run(pid);
  }

  loadParticipants(roomId: number): PlayerState[] {
    const rows = this.db.prepare('SELECT * FROM participants WHERE room_id = ? ORDER BY id').all(roomId) as unknown as ParticipantRow[];
    return rows.map(toPlayer);
  }

  roomsOfUser(userId: number): number[] {
    const rows = this.db.prepare('SELECT room_id FROM participants WHERE user_id = ?').all(userId) as unknown as Array<{ room_id: number }>;
    return rows.map((r) => r.room_id);
  }

  // ---- events ----

  insertEvent(roomId: number, ev: GameEvent): StoredEvent {
    const res = this.db
      .prepare('INSERT INTO events (room_id, ts, type, actor, target, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(roomId, ev.ts, ev.type, ev.actor, ev.target, JSON.stringify(ev.data));
    return { ...ev, id: Number(res.lastInsertRowid) };
  }

  loadEvents(roomId: number): StoredEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE room_id = ? ORDER BY id').all(roomId) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  deleteEvents(roomId: number): void {
    this.db.prepare('DELETE FROM events WHERE room_id = ?').run(roomId);
  }
}
