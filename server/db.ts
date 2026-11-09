// SQLite persistence (Node's built-in node:sqlite). The server keeps the live state in
// memory and writes every change through to this database, so a restart loses nothing.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, Phase } from '../shared/protocol.ts';
import type { EventData, EventType, GameEvent, PlayerState } from './engine.ts';

export interface UserRow {
  id: number;
  username: string;
  pass_hash: string;
  created_at: number;
  /** Profile (all optional; null on accounts that never set one). */
  display_name: string | null;
  bio: string | null;
  telegram: string | null;
  /** "<content hash>.<ext>" of the avatar file in the avatars folder. */
  avatar: string | null;
  profile_updated_at: number | null;
}

export interface ProfileFields {
  display_name: string | null;
  bio: string | null;
  telegram: string | null;
}

/** The bits of a user a room view needs for every player (cached; see Store.userBrief). */
export interface UserBrief {
  username: string;
  avatar: string | null;
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

interface ChatRow {
  id: number;
  ts: number;
  from_pid: number;
  from_name: string;
  to_pid: number | null;
  text: string;
  sticker: string | null;
}

function toChat(r: ChatRow): ChatMessage {
  const msg: ChatMessage = { id: r.id, ts: r.ts, from: r.from_pid, fromName: r.from_name, to: r.to_pid, text: r.text };
  if (r.sticker) msg.sticker = r.sticker;
  return msg;
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
  created_at INTEGER NOT NULL,
  display_name TEXT,
  bio TEXT,
  telegram TEXT,
  avatar TEXT,
  profile_updated_at INTEGER
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
CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  from_pid INTEGER NOT NULL,
  from_name TEXT NOT NULL,
  to_pid INTEGER,
  text TEXT NOT NULL,
  sticker TEXT
);
CREATE INDEX IF NOT EXISTS chat_room ON chat(room_id, id);
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
    this.migrate();
  }

  /** Brings databases created by older versions up to the current schema (old rows stay as they are). */
  private migrate(): void {
    const chatCols = this.db.prepare('PRAGMA table_info(chat)').all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === 'sticker')) this.db.exec('ALTER TABLE chat ADD COLUMN sticker TEXT');
    const userCols = new Set((this.db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name));
    const profileCols: Array<[string, string]> = [
      ['display_name', 'TEXT'],
      ['bio', 'TEXT'],
      ['telegram', 'TEXT'],
      ['avatar', 'TEXT'],
      ['profile_updated_at', 'INTEGER'],
    ];
    for (const [name, type] of profileCols) {
      if (!userCols.has(name)) this.db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    }
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
    return {
      id: Number(res.lastInsertRowid),
      username,
      pass_hash: passHash,
      created_at: now,
      display_name: null,
      bio: null,
      telegram: null,
      avatar: null,
      profile_updated_at: null,
    };
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
    this.briefs.delete(userId);
  }

  // ---- profiles ----

  /** Username and avatar per user id, cached because every room view asks for each player. */
  private readonly briefs = new Map<number, UserBrief | null>();

  userBrief(userId: number): UserBrief | undefined {
    let b = this.briefs.get(userId);
    if (b === undefined) {
      const row = this.db.prepare('SELECT username, avatar FROM users WHERE id = ?').get(userId) as UserBrief | undefined;
      b = row ? { username: row.username, avatar: row.avatar } : null;
      if (this.briefs.size > 5000) this.briefs.clear();
      this.briefs.set(userId, b);
    }
    return b ?? undefined;
  }

  updateProfile(userId: number, fields: ProfileFields, now: number): void {
    this.db
      .prepare('UPDATE users SET display_name = ?, bio = ?, telegram = ?, profile_updated_at = ? WHERE id = ?')
      .run(fields.display_name, fields.bio, fields.telegram, now, userId);
  }

  setAvatar(userId: number, avatar: string | null, now: number): void {
    this.db.prepare('UPDATE users SET avatar = ?, profile_updated_at = ? WHERE id = ?').run(avatar, now, userId);
    this.briefs.delete(userId);
  }

  /** How many accounts use this avatar file (identical uploads share one file). */
  avatarUsers(avatar: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE avatar = ?').get(avatar) as { n: number };
    return Number(row.n);
  }

  /** Games a user took part in once they started, and how many of those they won. */
  userStats(userId: number): { games: number; wins: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS games, SUM(CASE WHEN rooms.winner_pid = participants.id THEN 1 ELSE 0 END) AS wins
         FROM participants JOIN rooms ON rooms.id = participants.room_id
         WHERE participants.user_id = ? AND rooms.started_at IS NOT NULL`,
      )
      .get(userId) as { games: number; wins: number | null };
    return { games: Number(row.games), wins: Number(row.wins ?? 0) };
  }

  createSession(tokenHash: string, userId: number, now: number): void {
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)').run(tokenHash, userId, now);
  }

  /** `created_at` doubles as "last refreshed": sessions older than `minCreatedAt` are expired. */
  userBySession(tokenHash: string, minCreatedAt: number): (UserRow & { session_at: number }) | undefined {
    return this.db
      .prepare(
        'SELECT users.*, sessions.created_at AS session_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.created_at >= ?',
      )
      .get(tokenHash, minCreatedAt) as (UserRow & { session_at: number }) | undefined;
  }

  touchSession(tokenHash: string, now: number): void {
    this.db.prepare('UPDATE sessions SET created_at = ? WHERE token_hash = ?').run(now, tokenHash);
  }

  deleteSessionsBefore(minCreatedAt: number): void {
    this.db.prepare('DELETE FROM sessions WHERE created_at < ?').run(minCreatedAt);
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
      this.db.prepare('DELETE FROM chat WHERE room_id = ?').run(roomId);
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

  // ---- chat ----

  insertChat(roomId: number, msg: Omit<ChatMessage, 'id'>): ChatMessage {
    const res = this.db
      .prepare('INSERT INTO chat (room_id, ts, from_pid, from_name, to_pid, text, sticker) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(roomId, msg.ts, msg.from, msg.fromName, msg.to, msg.text, msg.sticker ?? null);
    return { ...msg, id: Number(res.lastInsertRowid) };
  }

  /** The most recent messages `pid` may read (room-wide ones plus their own private ones), oldest first. */
  chatFor(roomId: number, pid: number, limit: number): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, from_pid, from_name, to_pid, text, sticker FROM chat
         WHERE room_id = ? AND (to_pid IS NULL OR from_pid = ? OR to_pid = ?)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(roomId, pid, pid, limit) as unknown as ChatRow[];
    return rows.reverse().map(toChat);
  }

  /** Every message of a room, private ones included (admin tool). */
  chatAll(roomId: number, limit: number): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT id, ts, from_pid, from_name, to_pid, text, sticker FROM chat WHERE room_id = ? ORDER BY id DESC LIMIT ?')
      .all(roomId, limit) as unknown as ChatRow[];
    return rows.reverse().map(toChat);
  }
}
