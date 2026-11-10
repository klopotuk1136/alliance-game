// Web Push: notifications that reach a player even when the site is closed.
//
// - VAPID keys come from the environment (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or the short
//   VAPID_PUBLIC / VAPID_PRIVATE), else from the db's kv table; on the very first start they are
//   generated and stored there, so they survive restarts as long as the db does (Docker volume).
// - Every device a user turns notifications on for is one row in push_subs (endpoint, keys,
//   language, category switches). Push services answer 404/410 for a dead subscription; that row
//   is dropped.
// - Rooms report their events and chat through RoomNotifier (server/room.ts). A user who has the
//   room open in a visible tab gets nothing pushed (the tab plays sounds and shows toasts itself).
// - Chat is batched per user and room: the first message is pushed at once, more within
//   CHAT_WINDOW_MS replace it with "N new messages in <room>" when the window closes.
// - Whatever a player sees in a notification is exactly what their own log shows (views.ts
//   visibleEntry), so secret attackers and anonymous gifts stay secret.
//
// - Blitz rooms call blitz(room) after every commit: a new turn (from turn 2; turn 1 is the
//   'start' push) is announced once to every alive player, and one timer per room sends
//   "10 s left" to alive players who haven't confirmed. Pause, early end, finish and deletion
//   cancel or re-arm it. After a restart nothing is remembered, so a turn is only announced
//   while it is fresh and a hurry whose moment has passed is dropped: never a double send.
// Other code can call `push.notify(userId, kind, payload)` directly.

import type { ChatMessage } from '../shared/protocol.ts';
import {
  KIND_CATEGORY,
  normalizePrefs,
  type PushKind,
  type PushLang,
  type PushPayload,
  type PushPrefs,
  type PushSubscriptionJson,
} from '../shared/push.ts';
import type { Store, StoredEvent } from './db.ts';
import type { Room, RoomNotifier, Sink } from './room.ts';
import { visibleEntry } from './views.ts';

export const CHAT_WINDOW_MS = 20_000;
/** Blitz: "hurry" goes out this long before a turn's deadline. */
export const BLITZ_HURRY_MS = 10_000;
/** Blitz: a turn first seen later than this after its planning began isn't announced (a restart). */
const BLITZ_FRESH_MS = 5_000;
/** Blitz: a hurry timer that comes due this late is dropped (it may have gone out before a restart). */
const BLITZ_HURRY_LATE_MS = 1_000;
/** "Starts in 5 minutes" reminder for lobbies that last longer than this. */
export const SOON_MS = 5 * 60_000;
const SOON_SWEEP_MS = 30_000;
const MAX_SUBS_PER_USER = 10;
const PREVIEW_MAX = 140;

/** Push service hosts a subscription may point at (anything else would let us POST anywhere). */
const PUSH_HOSTS = ['.googleapis.com', '.mozilla.com', '.mozaws.net', '.push.apple.com', '.notify.windows.com'];

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface SendOptions {
  TTL: number;
  urgency: 'low' | 'normal' | 'high';
  topic?: string;
}

/** Sends one encrypted push. Throws an error with `statusCode` when the push service refuses. */
export type PushSender = (sub: PushSubscriptionJson, body: string, opts: SendOptions) => Promise<void>;

export class PushInputError extends Error {}

interface SubRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  lang: string;
  prefs: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'en',
  prefs TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
);
CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id);
`;

const KV_KEY = 'push.vapid';

/**
 * The server's VAPID key pair: environment first, then the db, else a new pair that is stored
 * in the db (so every later start, and every subscription made with it, keeps working).
 */
export function loadVapidKeys(store: Store, env: Record<string, string | undefined>, generate: () => VapidKeys): VapidKeys & { source: 'env' | 'db' | 'new' } {
  const pub = env.VAPID_PUBLIC_KEY ?? env.VAPID_PUBLIC;
  const priv = env.VAPID_PRIVATE_KEY ?? env.VAPID_PRIVATE;
  if (pub && priv) return { publicKey: pub.trim(), privateKey: priv.trim(), source: 'env' };
  const stored = store.getKv(KV_KEY);
  if (stored) {
    try {
      const k = JSON.parse(stored) as VapidKeys;
      if (typeof k.publicKey === 'string' && typeof k.privateKey === 'string' && k.publicKey && k.privateKey) return { ...k, source: 'db' };
    } catch {
      // unreadable: make a new pair below
    }
  }
  const fresh = generate();
  store.setKv(KV_KEY, JSON.stringify({ publicKey: fresh.publicKey, privateKey: fresh.privateKey }));
  return { ...fresh, source: 'new' };
}

/** The web-push library as a PushSender (loaded lazily, so tests never need it). */
export async function webPushSender(keys: VapidKeys, subject: string): Promise<PushSender> {
  const wp = await import('web-push');
  const vapidDetails = { subject, publicKey: keys.publicKey, privateKey: keys.privateKey };
  return async (sub, body, opts) => {
    await wp.sendNotification(sub, body, { ...opts, vapidDetails, timeout: 15_000 });
  };
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const wp = await import('web-push');
  return wp.generateVAPIDKeys();
}

/** The base64url alphabet, the only characters a push `topic` may use (max 32). */
function topic(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return [...flat].length > PREVIEW_MAX ? [...flat].slice(0, PREVIEW_MAX - 1).join('') + '…' : flat;
}

/** Whether `userId` has `room` open in a visible tab. */
export function watching(sinks: Iterable<Sink>, userId: number): boolean {
  for (const s of sinks) if (s.userId === userId && s.visible !== false) return true;
  return false;
}

export interface PushDeps {
  store: Store;
  keys: VapidKeys;
  send: PushSender;
  now: () => number;
  log: (msg: string) => void;
  /** Finds a room by code (for notify() calls that name one), to skip players watching it. */
  room?: (code: string) => { sinks: Iterable<Sink> } | undefined;
  /** Accept subscriptions to any https host (tests, self-hosted push services). */
  anyHost?: boolean;
}

interface ChatBatch {
  room: Room;
  /** Messages since the window opened (the first one was pushed at once). */
  total: number;
  /** Messages not pushed yet. */
  pending: number;
  last: Record<string, string | number>;
  timer: NodeJS.Timeout;
}

/** One blitz room as push sees it: the turn it knows, and the pending "hurry" timer. */
interface BlitzWatch {
  turn: number;
  deadline: number | null;
  /** The turn a hurry was sent (or deliberately skipped) for. */
  hurried: number;
  timer: NodeJS.Timeout | null;
}

/** Extra fields of a notify() call: which room (for presence, the click URL and the tag). */
export interface NotifyPayload {
  room?: string;
  roomName?: string;
  /** Replaces an earlier notification with the same tag. Default: kind + room. */
  tag?: string;
  [param: string]: string | number | undefined;
}

export class PushService implements RoomNotifier {
  readonly publicKey: string;
  private readonly deps: PushDeps;
  private readonly batches = new Map<string, ChatBatch>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly reminded = new Set<string>();
  private readonly blitzRooms = new Map<string, BlitzWatch>();
  private sweep: NodeJS.Timeout | null = null;

  constructor(deps: PushDeps) {
    this.deps = deps;
    this.publicKey = deps.keys.publicKey;
    deps.store.db.exec(SCHEMA);
  }

  // ---------------------------------------------------------------- subscriptions

  /** Saves (or moves to this user, or updates) one device's subscription. */
  subscribe(userId: number, raw: unknown, lang: unknown, prefs: unknown): void {
    const sub = this.checkSubscription(raw);
    const l: PushLang = lang === 'ru' ? 'ru' : 'en';
    const p = JSON.stringify(normalizePrefs(prefs));
    const db = this.deps.store.db;
    db.prepare(
      `INSERT INTO push_subs (user_id, endpoint, p256dh, auth, lang, prefs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         lang = excluded.lang, prefs = excluded.prefs`,
    ).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, l, p, this.deps.now());
    // Keep the newest few devices per user.
    db.prepare(
      `DELETE FROM push_subs WHERE user_id = ? AND id NOT IN (SELECT id FROM push_subs WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
    ).run(userId, userId, MAX_SUBS_PER_USER);
  }

  unsubscribe(userId: number, endpoint: unknown): boolean {
    if (typeof endpoint !== 'string') throw new PushInputError('Invalid subscription');
    const res = this.deps.store.db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
    return Number(res.changes) > 0;
  }

  subscriptionsOf(userId: number): Array<{ endpoint: string; lang: PushLang; prefs: PushPrefs }> {
    const rows = this.deps.store.db.prepare('SELECT * FROM push_subs WHERE user_id = ? ORDER BY id').all(userId) as unknown as SubRow[];
    return rows.map((r) => ({ endpoint: r.endpoint, lang: r.lang === 'ru' ? 'ru' : 'en', prefs: normalizePrefs(safeJson(r.prefs)) }));
  }

  private checkSubscription(raw: unknown): PushSubscriptionJson {
    const s = raw as PushSubscriptionJson | null;
    const b64 = /^[A-Za-z0-9_-]+=*$/;
    if (
      !s ||
      typeof s !== 'object' ||
      typeof s.endpoint !== 'string' ||
      s.endpoint.length > 1000 ||
      !s.keys ||
      typeof s.keys.p256dh !== 'string' ||
      typeof s.keys.auth !== 'string' ||
      s.keys.p256dh.length > 200 ||
      s.keys.auth.length > 100 ||
      !b64.test(s.keys.p256dh) ||
      !b64.test(s.keys.auth)
    ) {
      throw new PushInputError('Invalid subscription');
    }
    let url: URL;
    try {
      url = new URL(s.endpoint);
    } catch {
      throw new PushInputError('Invalid subscription');
    }
    const host = url.hostname.toLowerCase();
    const known = PUSH_HOSTS.some((h) => host.endsWith(h));
    if (url.protocol !== 'https:' || (!known && !this.deps.anyHost)) throw new PushInputError('Unknown push service');
    return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
  }

  // ---------------------------------------------------------------- sending

  /**
   * Pushes one notification to every device of `userId` that has the kind's category on.
   * Skipped when the user has `payload.room` open in a visible tab. Public API for other
   * engines (blitz turns): `notify(userId, 'blitzTurn', { room, roomName, turn: 3 })`.
   */
  notify(userId: number, kind: PushKind, payload: NotifyPayload = {}): void {
    const { room, roomName, tag, ...rest } = payload;
    if (room && kind !== 'test') {
      const r = this.deps.room?.(room);
      if (r && watching(r.sinks, userId)) return;
    }
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) params[k] = v;
    this.deliver(userId, kind, params, room, roomName, tag);
  }

  /** Sends without the presence check (callers already did it). */
  private deliver(userId: number, kind: PushKind, params: Record<string, string | number>, room?: string, roomName?: string, tag?: string): void {
    const rows = this.deps.store.db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId) as unknown as SubRow[];
    if (!rows.length) return;
    const category = KIND_CATEGORY[kind];
    const opts = sendOptions(kind, room);
    for (const row of rows) {
      if (category && !normalizePrefs(safeJson(row.prefs))[category]) continue;
      const payload: PushPayload = {
        kind,
        params,
        ...(room ? { room } : {}),
        ...(roomName ? { roomName } : {}),
        tag: tag ?? (room ? `${kind === 'chatMany' ? 'chat' : kind}:${room}` : kind),
        url: room ? `/r/${room}` : '/',
        lang: row.lang === 'ru' ? 'ru' : 'en',
        ts: this.deps.now(),
      };
      const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      const p = this.deps
        .send(sub, JSON.stringify(payload), opts)
        .then(() => {
          this.deps.store.db.prepare('UPDATE push_subs SET last_ok_at = ? WHERE id = ?').run(this.deps.now(), row.id);
        })
        .catch((err: { statusCode?: number; message?: string }) => {
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            this.deps.store.db.prepare('DELETE FROM push_subs WHERE id = ?').run(row.id);
            this.deps.log(`push: dropped expired subscription ${row.id} of user ${row.user_id}`);
          } else {
            this.deps.log(`push: send to user ${row.user_id} failed: ${err?.statusCode ?? ''} ${err?.message ?? err}`);
          }
        })
        .finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
  }

  /** Resolves when every push started so far has finished (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** The "Test notification" button: every device of the user, whatever the switches say. */
  test(userId: number): number {
    const n = this.subscriptionsOf(userId).length;
    this.deliver(userId, 'test', {});
    return n;
  }

  // ---------------------------------------------------------------- rooms (RoomNotifier)

  chat(room: Room, msg: ChatMessage): void {
    if (msg.sys) return;
    let pids: number[];
    let where: 'all' | 'dm' | 'group' = 'all';
    let groupName = '';
    if (msg.group !== undefined) {
      const g = room.groups.groupsOf(msg.from).find((x) => x.id === msg.group);
      if (!g) return;
      pids = g.members;
      where = 'group';
      groupName = g.name || g.members.map((pid) => room.players.get(pid)?.nickname ?? '?').join(', ');
    } else if (msg.to !== null) {
      pids = [msg.to];
      where = 'dm';
    } else {
      pids = [...room.players.keys()];
    }
    const params: Record<string, string | number> = { from: msg.fromName, where };
    if (msg.sticker) params.sticker = 1;
    else params.text = preview(msg.text);
    if (groupName) params.group = preview(groupName);
    for (const pid of pids) {
      if (pid === msg.from) continue;
      const userId = room.players.get(pid)?.userId;
      if (userId === undefined || watching(room.sinks, userId)) continue;
      this.queueChat(room, userId, params);
    }
  }

  private queueChat(room: Room, userId: number, params: Record<string, string | number>): void {
    const key = `${userId}:${room.code}`;
    const batch = this.batches.get(key);
    if (batch) {
      batch.total++;
      batch.pending++;
      batch.last = params;
      return;
    }
    this.deliver(userId, 'chat', params, room.code, room.row.name);
    const b: ChatBatch = { room, total: 1, pending: 0, last: params, timer: this.chatTimer(key) };
    this.batches.set(key, b);
  }

  private chatTimer(key: string): NodeJS.Timeout {
    const t = setTimeout(() => this.flushChat(key), CHAT_WINDOW_MS);
    t.unref?.();
    return t;
  }

  /** End of a batching window: one "N new messages" push if more came, and a new window. */
  private flushChat(key: string): void {
    const b = this.batches.get(key);
    if (!b) return;
    const userId = Number(key.slice(0, key.indexOf(':')));
    if (b.pending === 0 || b.room.deleted) {
      this.batches.delete(key);
      return;
    }
    b.pending = 0;
    if (!watching(b.room.sinks, userId)) {
      this.deliver(userId, 'chatMany', { n: b.total, from: String(b.last.from ?? '') }, b.room.code, b.room.row.name);
    } else {
      // They opened the room meanwhile: they have read it.
      b.total = 0;
    }
    b.timer = this.chatTimer(key);
  }

  events(room: Room, events: StoredEvent[]): void {
    const reveal = room.settings.revealActions;
    const name = (pid: number | undefined): string => (pid === undefined ? '' : (room.players.get(pid)?.nickname ?? ''));
    for (const p of room.players.values()) {
      if (watching(room.sinks, p.userId)) continue;
      let hit = 0;
      let hitBy = '';
      let granted = 0;
      let grantedBy = '';
      let tick = 0;
      const out: Array<[PushKind, Record<string, string | number>]> = [];
      for (const ev of events) {
        const e = visibleEntry(ev, p.pid, reveal);
        if (!e) continue;
        switch (e.type) {
          case 'start':
            out.push(['start', {}]);
            break;
          case 'tick':
            if (p.alive) tick += e.amount ?? 1;
            break;
          case 'hit':
            hit += e.amount ?? 1;
            if (e.actor !== undefined) hitBy = name(e.actor);
            break;
          case 'granted':
            granted += e.amount ?? 1;
            if (e.actor !== undefined) grantedBy = name(e.actor);
            break;
          case 'eliminate':
            if (e.target === p.pid) {
              out.push(['eliminated', e.actor !== undefined && e.actor !== p.pid ? { by: name(e.actor) } : {}]);
              hit = 0;
            }
            break;
          case 'peace-propose':
            if (e.actor !== p.pid && p.alive) out.push(['peace', { by: name(e.actor) }]);
            break;
          case 'finish': {
            const result = e.pids ? (e.pids.includes(p.pid) ? 'peace' : 'lost') : e.target === p.pid ? 'won' : 'lost';
            out.push(['end', e.target !== undefined && e.target !== p.pid ? { result, winner: name(e.target) } : { result }]);
            break;
          }
          default:
            break;
        }
      }
      const eliminatedNow = out.some(([k]) => k === 'eliminated');
      if (hit > 0 && !eliminatedNow) out.unshift(['hit', hitBy ? { n: hit, by: hitBy } : { n: hit }]);
      if (granted > 0) out.push(['granted', grantedBy ? { n: granted, by: grantedBy } : { n: granted }]);
      if (tick > 0 && !out.some(([k]) => k === 'end')) out.push(['tick', { n: tick }]);
      for (const [kind, params] of out) this.deliver(p.userId, kind, params, room.code, room.row.name);
    }
  }

  /**
   * Every 30 s: "starts in 5 minutes" to everyone in a lobby that is about to start. Also picks
   * up blitz rooms that were running when the server started (their hurry timers), at once.
   */
  watchLobbies(rooms: () => Iterable<Room>): void {
    const run = (): void => {
      try {
        this.remindLobbies(rooms());
      } catch (err) {
        this.deps.log(`push: lobby reminder failed: ${(err as Error).message}`);
      }
    };
    try {
      for (const room of rooms()) if (room.blitz) this.blitz(room);
    } catch (err) {
      this.deps.log(`push: blitz pickup failed: ${(err as Error).message}`);
    }
    this.sweep = setInterval(run, SOON_SWEEP_MS);
    this.sweep.unref?.();
  }

  // ---------------------------------------------------------------- blitz

  /**
   * Called by a room after each commit (and when it is deleted). Announces a new blitz turn
   * once and keeps one "hurry" timer per room on the current deadline.
   */
  blitz(room: Room): void {
    const st = room.blitz;
    const w = this.blitzRooms.get(room.code);
    if (room.deleted || !st || room.phase === 'finished' || room.phase === 'lobby') {
      if (w?.timer) clearTimeout(w.timer);
      this.blitzRooms.delete(room.code);
      return;
    }
    const now = this.deps.now();
    const watch: BlitzWatch = w ?? { turn: 0, deadline: null, hurried: 0, timer: null };
    this.blitzRooms.set(room.code, watch);
    if (watch.turn !== st.turn) {
      const fresh = st.planningFrom !== null && now <= st.planningFrom + BLITZ_FRESH_MS;
      // Turn 1 begins with the game: the 'start' push already says so.
      if (st.turn > 1 && fresh && room.phase === 'running') {
        for (const p of room.players.values()) {
          if (p.alive) this.notify(p.userId, 'blitzTurn', { room: room.code, roomName: room.row.name, turn: st.turn });
        }
      }
      watch.turn = st.turn;
      watch.deadline = null;
      // First sight of a turn that is not fresh (a restart): its hurry may already be out.
      if (!fresh && w === undefined && (room.row.next_tick_at ?? 0) - BLITZ_HURRY_MS < now) watch.hurried = st.turn;
    }
    const deadline = room.phase === 'running' ? room.row.next_tick_at : null;
    if (deadline === watch.deadline && (watch.timer || deadline === null)) return;
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = null;
    watch.deadline = deadline;
    if (deadline === null || watch.hurried === st.turn) return;
    const delay = deadline - BLITZ_HURRY_MS - now;
    if (delay < -BLITZ_HURRY_LATE_MS) {
      watch.hurried = st.turn;
      return;
    }
    const turn = st.turn;
    watch.timer = setTimeout(() => {
      watch.timer = null;
      try {
        this.hurry(room, turn, deadline);
      } catch (err) {
        this.deps.log(`push: blitz hurry failed: ${(err as Error).message}`);
      }
    }, Math.max(0, delay));
    watch.timer.unref?.();
  }

  private hurry(room: Room, turn: number, deadline: number): void {
    const st = room.blitz;
    const watch = this.blitzRooms.get(room.code);
    if (!st || !watch || room.deleted || room.phase !== 'running' || st.turn !== turn || room.row.next_tick_at !== deadline) return;
    if (watch.hurried === turn) return;
    watch.hurried = turn;
    for (const p of room.players.values()) {
      if (p.alive && !st.confirmed.includes(p.pid)) this.notify(p.userId, 'blitzHurry', { room: room.code, roomName: room.row.name });
    }
  }

  remindLobbies(rooms: Iterable<Room>): void {
    const now = this.deps.now();
    for (const room of rooms) {
      const ends = room.row.lobby_ends_at;
      if (room.deleted || room.phase !== 'lobby' || ends === null || room.players.size < 2) continue;
      const left = ends - now;
      // Only lobbies that were open well before the last 5 minutes.
      if (left <= 0 || left > SOON_MS + SOON_SWEEP_MS || ends - room.row.lobby_started_at <= SOON_MS + 60_000) continue;
      const key = `${room.code}:${ends}`;
      if (this.reminded.has(key)) continue;
      this.reminded.add(key);
      if (this.reminded.size > 5000) this.reminded.clear();
      const min = Math.max(1, Math.round(left / 60_000));
      for (const p of room.players.values()) {
        if (!watching(room.sinks, p.userId)) this.deliver(p.userId, 'soon', { min }, room.code, room.row.name);
      }
    }
  }

  close(): void {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    for (const b of this.batches.values()) clearTimeout(b.timer);
    this.batches.clear();
    for (const w of this.blitzRooms.values()) if (w.timer) clearTimeout(w.timer);
    this.blitzRooms.clear();
  }
}

function sendOptions(kind: PushKind, room?: string): SendOptions {
  switch (kind) {
    case 'chat':
    case 'chatMany':
      return { TTL: 6 * 3600, urgency: 'normal', ...(room ? { topic: topic(`chat${room}`) } : {}) };
    case 'hit':
    case 'eliminated':
      return { TTL: 24 * 3600, urgency: 'high' };
    case 'tick':
      return { TTL: 12 * 3600, urgency: 'normal', ...(room ? { topic: topic(`tick${room}`) } : {}) };
    case 'soon':
      return { TTL: 300, urgency: 'high' };
    case 'blitzTurn':
      return { TTL: 120, urgency: 'high', ...(room ? { topic: topic(`turn${room}`) } : {}) };
    case 'blitzHurry':
      return { TTL: 10, urgency: 'high' };
    case 'start':
    case 'peace':
      return { TTL: 6 * 3600, urgency: 'high' };
    default:
      return { TTL: 24 * 3600, urgency: 'normal' };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export type { PushPrefs };
