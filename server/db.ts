// SQLite persistence (Node's built-in node:sqlite). The server keeps the live state in
// memory and writes every change through to this database, so a restart loses nothing.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChatGroup, PlanItem, PlanSnapshot } from '../shared/plan.ts';
import { normalizeCounts } from '../shared/costs.ts';
import type { ChatMessage, LeaderboardEntry, Phase, RatingChange } from '../shared/protocol.ts';
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
  /** Elo rating and rated-game counters (added by migration; see rating.ts). */
  rating?: number;
  rated_games?: number;
  rated_wins?: number;
  win_points?: number;
}

/** One player's result of one rated game, written when the game ends. */
export interface RatingRow {
  userId: number;
  pid: number;
  place: number;
  players: number;
  before: number;
  after: number;
  winPoints: number;
  won: boolean;
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
  /** JSON PeaceView of the open (or signed) peace proposal; null when there is none. */
  peace: string | null;
  /** 1 = the result changes ratings; 0 for rooms made on a test-mode server. */
  rated: number;
  /** Blitz rooms: JSON BlitzState (server/blitz.ts) — turn, secret orders, charges; null otherwise. */
  blitz?: string | null;
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
  used: string | null;
}

interface ChatRow {
  id: number;
  ts: number;
  from_pid: number;
  from_name: string;
  to_pid: number | null;
  text: string;
  sticker: string | null;
  group_id: number | null;
  sys: string | null;
}

function toChat(r: ChatRow): ChatMessage {
  const msg: ChatMessage = { id: r.id, ts: r.ts, from: r.from_pid, fromName: r.from_name, to: r.to_pid, text: r.text };
  if (r.sticker) msg.sticker = r.sticker;
  if (r.group_id !== null && r.group_id !== undefined) msg.group = r.group_id;
  if (r.sys) msg.sys = JSON.parse(r.sys) as ChatMessage['sys'];
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
CREATE TABLE IF NOT EXISTS rating_history (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  room_id INTEGER NOT NULL,
  game_started_at INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  place INTEGER NOT NULL,
  players INTEGER NOT NULL,
  rating_before REAL NOT NULL,
  rating_after REAL NOT NULL,
  win_points REAL NOT NULL,
  UNIQUE (user_id, room_id, game_started_at)
);
CREATE INDEX IF NOT EXISTS rating_history_room ON rating_history(room_id, game_started_at);
CREATE TABLE IF NOT EXISTS chat_groups (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_groups_room ON chat_groups(room_id, id);
CREATE TABLE IF NOT EXISTS chat_group_members (
  group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  pid INTEGER NOT NULL,
  -- the member reads the group's messages with an id above this (history from when they joined)
  since_id INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, pid)
);
CREATE TABLE IF NOT EXISTS plans (
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (room_id, channel)
);
CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  author INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_items_channel ON plan_items(room_id, channel, id);
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
    used: normalizeCounts(row.used ? safeJson(row.used) : null),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
    // Group chats: a message may belong to a group, and server-written lines carry `sys`.
    if (!chatCols.some((c) => c.name === 'group_id')) this.db.exec('ALTER TABLE chat ADD COLUMN group_id INTEGER');
    if (!chatCols.some((c) => c.name === 'sys')) this.db.exec('ALTER TABLE chat ADD COLUMN sys TEXT');
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
    // Ratings (rating.ts).
    const ratingCols: Array<[string, string]> = [
      ['rating', 'REAL NOT NULL DEFAULT 1000'],
      ['rated_games', 'INTEGER NOT NULL DEFAULT 0'],
      ['rated_wins', 'INTEGER NOT NULL DEFAULT 0'],
      ['win_points', 'REAL NOT NULL DEFAULT 0'],
    ];
    for (const [name, type] of ratingCols) {
      if (!userCols.has(name)) this.db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    }
    // Peace proposals and the rated flag on rooms; per-period action counters on players.
    const roomCols = new Set((this.db.prepare('PRAGMA table_info(rooms)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!roomCols.has('peace')) this.db.exec('ALTER TABLE rooms ADD COLUMN peace TEXT');
    if (!roomCols.has('rated')) this.db.exec('ALTER TABLE rooms ADD COLUMN rated INTEGER NOT NULL DEFAULT 1');
    // Blitz mode: per-turn state (orders, confirmations, charges, last turn's report).
    if (!roomCols.has('blitz')) this.db.exec('ALTER TABLE rooms ADD COLUMN blitz TEXT');
    const partCols = new Set((this.db.prepare('PRAGMA table_info(participants)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!partCols.has('used')) this.db.exec('ALTER TABLE participants ADD COLUMN used TEXT');
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
           started_at, finished_at, paused_at, next_tick_at, last_tick_at, winner_pid, peace, rated)
         VALUES (:code, :name, :creator_id, :phase, :settings, :created_at, :lobby_started_at, :lobby_ends_at,
           :started_at, :finished_at, :paused_at, :next_tick_at, :last_tick_at, :winner_pid, :peace, :rated)`,
      )
      .run({ ...row });
    return Number(res.lastInsertRowid);
  }

  updateRoom(row: RoomRow): void {
    this.db
      .prepare(
        `UPDATE rooms SET name = :name, phase = :phase, settings = :settings, lobby_started_at = :lobby_started_at,
           lobby_ends_at = :lobby_ends_at, started_at = :started_at, finished_at = :finished_at, paused_at = :paused_at,
           next_tick_at = :next_tick_at, last_tick_at = :last_tick_at, winner_pid = :winner_pid, peace = :peace,
           blitz = :blitz
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
        peace: row.peace ?? null,
        blitz: row.blitz ?? null,
      });
  }

  deleteRoom(roomId: number): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE room_id = ?').run(roomId);
      this.db.prepare('DELETE FROM chat WHERE room_id = ?').run(roomId);
      // rating_history stays: ratings already earned don't vanish with the room.
      this.db.prepare('DELETE FROM chat_group_members WHERE group_id IN (SELECT id FROM chat_groups WHERE room_id = ?)').run(roomId);
      this.db.prepare('DELETE FROM chat_groups WHERE room_id = ?').run(roomId);
      this.db.prepare('DELETE FROM plan_items WHERE room_id = ?').run(roomId);
      this.db.prepare('DELETE FROM plans WHERE room_id = ?').run(roomId);
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
           eliminated_at = ?, eliminated_by = ?, used = ? WHERE id = ?`,
      )
      .run(p.nickname, p.flag, p.q, p.r, p.hp, p.ap, p.range, p.alive ? 1 : 0, p.eliminatedAt, p.eliminatedBy, p.used ? JSON.stringify(p.used) : null, p.pid);
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

  // ---- ratings ----

  /** Current rating of every given user (1000 for anyone unknown). */
  ratingsOf(userIds: number[]): Map<number, number> {
    const out = new Map<number, number>();
    const stmt = this.db.prepare('SELECT rating FROM users WHERE id = ?');
    for (const id of userIds) {
      const row = stmt.get(id) as { rating: number } | undefined;
      out.set(id, row ? Number(row.rating) : 1000);
    }
    return out;
  }

  /**
   * Records one finished game's ratings. Idempotent per (room, game start): returns false
   * and changes nothing if this game was already rated.
   */
  recordRatedGame(roomId: number, gameStartedAt: number, ts: number, rows: RatingRow[]): boolean {
    return this.transaction(() => {
      const done = this.db.prepare('SELECT 1 FROM rating_history WHERE room_id = ? AND game_started_at = ? LIMIT 1').get(roomId, gameStartedAt);
      if (done) return false;
      const ins = this.db.prepare(
        `INSERT INTO rating_history (user_id, room_id, game_started_at, ts, pid, place, players, rating_before, rating_after, win_points)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const upd = this.db.prepare(
        'UPDATE users SET rating = ?, rated_games = rated_games + 1, rated_wins = rated_wins + ?, win_points = win_points + ? WHERE id = ?',
      );
      for (const r of rows) {
        ins.run(r.userId, roomId, gameStartedAt, ts, r.pid, r.place, r.players, r.before, r.after, r.winPoints);
        upd.run(r.after, r.won ? 1 : 0, r.winPoints, r.userId);
      }
      return true;
    });
  }

  /** Rating changes of one game (empty when it wasn't rated). */
  ratingChanges(roomId: number, gameStartedAt: number): RatingChange[] {
    const rows = this.db
      .prepare('SELECT pid, place, rating_before, rating_after, win_points FROM rating_history WHERE room_id = ? AND game_started_at = ? ORDER BY place, id')
      .all(roomId, gameStartedAt) as unknown as Array<{ pid: number; place: number; rating_before: number; rating_after: number; win_points: number }>;
    return rows.map((r) => ({
      pid: r.pid,
      place: r.place,
      before: Math.round(r.rating_before),
      after: Math.round(r.rating_after),
      delta: Math.round(r.rating_after) - Math.round(r.rating_before),
      winPoints: r.win_points,
    }));
  }

  /** Rating, rated games, outright wins and win points of one account. */
  ratingStats(userId: number): { rating: number; ratedGames: number; ratedWins: number; winPoints: number } {
    const row = this.db.prepare('SELECT rating, rated_games, rated_wins, win_points FROM users WHERE id = ?').get(userId) as
      | { rating: number; rated_games: number; rated_wins: number; win_points: number }
      | undefined;
    return {
      rating: Math.round(Number(row?.rating ?? 1000)),
      ratedGames: Number(row?.rated_games ?? 0),
      ratedWins: Number(row?.rated_wins ?? 0),
      winPoints: Math.round(Number(row?.win_points ?? 0) * 100) / 100,
    };
  }

  /** Everyone with at least one rated game, best rating first. */
  leaderboard(limit = 200): LeaderboardEntry[] {
    const rows = this.db
      .prepare(
        `SELECT username, display_name, avatar, rating, rated_games, rated_wins, win_points FROM users
         WHERE rated_games > 0 ORDER BY rating DESC, win_points DESC, username COLLATE NOCASE LIMIT ?`,
      )
      .all(limit) as unknown as Array<{
      username: string;
      display_name: string | null;
      avatar: string | null;
      rating: number;
      rated_games: number;
      rated_wins: number;
      win_points: number;
    }>;
    let rank = 0;
    let prev: number | null = null;
    return rows.map((r, i) => {
      const rating = Math.round(Number(r.rating));
      if (rating !== prev) rank = i + 1;
      prev = rating;
      return {
        rank,
        username: r.username,
        displayName: r.display_name,
        avatarUrl: r.avatar ? `/avatars/${r.avatar}` : null,
        rating,
        games: Number(r.rated_games),
        wins: Number(r.rated_wins),
        winPoints: Math.round(Number(r.win_points) * 100) / 100,
      };
    });
  }

  // ---- chat ----

  insertChat(roomId: number, msg: Omit<ChatMessage, 'id'>): ChatMessage {
    const res = this.db
      .prepare('INSERT INTO chat (room_id, ts, from_pid, from_name, to_pid, text, sticker, group_id, sys) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(roomId, msg.ts, msg.from, msg.fromName, msg.to, msg.text, msg.sticker ?? null, msg.group ?? null, msg.sys ? JSON.stringify(msg.sys) : null);
    return { ...msg, id: Number(res.lastInsertRowid) };
  }

  /**
   * The most recent messages `pid` may read, oldest first: room-wide ones, their own private
   * ones, and those of their groups sent since they joined each group.
   */
  chatFor(roomId: number, pid: number, limit: number): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT chat.id, ts, from_pid, from_name, to_pid, text, sticker, chat.group_id, sys FROM chat
         LEFT JOIN chat_group_members m ON m.group_id = chat.group_id AND m.pid = ?
         WHERE room_id = ? AND (
           (chat.group_id IS NULL AND (to_pid IS NULL OR from_pid = ? OR to_pid = ?))
           OR (m.pid IS NOT NULL AND chat.id > m.since_id)
         )
         ORDER BY chat.id DESC LIMIT ?`,
      )
      .all(pid, roomId, pid, pid, limit) as unknown as ChatRow[];
    return rows.reverse().map(toChat);
  }

  /** Every message of a room, private and group ones included (admin tool). */
  chatAll(roomId: number, limit: number): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT id, ts, from_pid, from_name, to_pid, text, sticker, group_id, sys FROM chat WHERE room_id = ? ORDER BY id DESC LIMIT ?')
      .all(roomId, limit) as unknown as ChatRow[];
    return rows.reverse().map(toChat);
  }

  /** Id of the newest chat message in the room (0 when there is none). */
  lastChatId(roomId: number): number {
    const row = this.db.prepare('SELECT MAX(id) AS id FROM chat WHERE room_id = ?').get(roomId) as { id: number | null };
    return Number(row.id ?? 0);
  }

  // ---- group chats ----

  loadGroups(roomId: number): Array<ChatGroup & { since: Map<number, number> }> {
    const groups = this.db
      .prepare('SELECT id, name, created_by, created_at FROM chat_groups WHERE room_id = ? ORDER BY id')
      .all(roomId) as unknown as Array<{ id: number; name: string; created_by: number; created_at: number }>;
    const members = this.db
      .prepare(
        `SELECT m.group_id, m.pid, m.since_id FROM chat_group_members m JOIN chat_groups g ON g.id = m.group_id
         WHERE g.room_id = ? ORDER BY m.joined_at, m.rowid`,
      )
      .all(roomId) as unknown as Array<{ group_id: number; pid: number; since_id: number }>;
    return groups.map((g) => {
      const mine = members.filter((m) => m.group_id === g.id);
      return {
        id: g.id,
        name: g.name,
        createdBy: g.created_by,
        createdAt: g.created_at,
        members: mine.map((m) => m.pid),
        since: new Map(mine.map((m) => [m.pid, m.since_id])),
      };
    });
  }

  insertGroup(roomId: number, name: string, createdBy: number, now: number): number {
    const res = this.db
      .prepare('INSERT INTO chat_groups (room_id, name, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(roomId, name, createdBy, now);
    return Number(res.lastInsertRowid);
  }

  renameGroup(groupId: number, name: string): void {
    this.db.prepare('UPDATE chat_groups SET name = ? WHERE id = ?').run(name, groupId);
  }

  deleteGroup(groupId: number): void {
    this.db.prepare('DELETE FROM chat_group_members WHERE group_id = ?').run(groupId);
    this.db.prepare('DELETE FROM chat_groups WHERE id = ?').run(groupId);
  }

  addGroupMember(groupId: number, pid: number, sinceId: number, now: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO chat_group_members (group_id, pid, since_id, joined_at) VALUES (?, ?, ?, ?)')
      .run(groupId, pid, sinceId, now);
  }

  removeGroupMember(groupId: number, pid: number): void {
    this.db.prepare('DELETE FROM chat_group_members WHERE group_id = ? AND pid = ?').run(groupId, pid);
  }

  // ---- plans ----

  loadPlan(roomId: number, channel: string): { snapshot: PlanSnapshot; items: PlanItem[] } | undefined {
    const row = this.db.prepare('SELECT snapshot FROM plans WHERE room_id = ? AND channel = ?').get(roomId, channel) as
      | { snapshot: string }
      | undefined;
    if (!row) return undefined;
    const items = this.db
      .prepare('SELECT id, author, ts, data FROM plan_items WHERE room_id = ? AND channel = ? ORDER BY id')
      .all(roomId, channel) as unknown as Array<{ id: number; author: number; ts: number; data: string }>;
    return {
      snapshot: JSON.parse(row.snapshot) as PlanSnapshot,
      items: items.map((r) => ({ ...(JSON.parse(r.data) as object), id: r.id, author: r.author, ts: r.ts }) as PlanItem),
    };
  }

  savePlanSnapshot(roomId: number, channel: string, snapshot: PlanSnapshot): void {
    this.db
      .prepare('INSERT INTO plans (room_id, channel, snapshot) VALUES (?, ?, ?) ON CONFLICT(room_id, channel) DO UPDATE SET snapshot = excluded.snapshot')
      .run(roomId, channel, JSON.stringify(snapshot));
  }

  /** Stores a drawn item; `data` is the item without id/author/ts. Returns the new id. */
  insertPlanItem(roomId: number, channel: string, author: number, ts: number, data: object): number {
    const res = this.db
      .prepare('INSERT INTO plan_items (room_id, channel, author, ts, data) VALUES (?, ?, ?, ?, ?)')
      .run(roomId, channel, author, ts, JSON.stringify(data));
    return Number(res.lastInsertRowid);
  }

  deletePlanItems(roomId: number, channel: string, ids: number[]): void {
    const stmt = this.db.prepare('DELETE FROM plan_items WHERE room_id = ? AND channel = ? AND id = ?');
    for (const id of ids) stmt.run(roomId, channel, id);
  }

  deletePlan(roomId: number, channel: string): void {
    this.db.prepare('DELETE FROM plan_items WHERE room_id = ? AND channel = ?').run(roomId, channel);
    this.db.prepare('DELETE FROM plans WHERE room_id = ? AND channel = ?').run(roomId, channel);
  }
}
