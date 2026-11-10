// One game room: lobby, game state, timers and the connected browsers. All changes go
// through `commit`, which writes them to SQLite and then pushes per-player updates.

import { CHAT_MAX, NICKNAME_MAX, type ActionResult, type ChatMessage, type GameAction, type PeaceView, type RatingChange, type ServerMessage } from '../shared/protocol.ts';
import { applySettingOverrides, effectiveSpawnDistance, LOBBY_MAX_AHEAD_MS, LOBBY_MIN_AHEAD_MS, normalizeSettings, type GameSettings } from '../shared/settings.ts';
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
import { GroupHub, type GroupHost } from './groups.ts';
import { checkBlitzOrders } from '../shared/blitz.ts';
import { beginTurn, chargeOf, newBlitzState, parseBlitzState, resolveTurn, type BlitzState } from './blitz.ts';
import { errorFields } from '../shared/errors.ts';
import { eloChanges, placements, winPoints } from './rating.ts';
import { nextTickAfter } from './schedule.ts';
import { buildView, parsePeace, participantOf, personalLog, visibleEntry, type RoomSnapshot } from './views.ts';

/** A connected browser tab (or a test double). */
export interface Sink {
  userId: number;
  username: string;
  send(msg: ServerMessage): void;
  /** Serialized last state sent, used to skip updates that change nothing for this viewer. */
  lastState?: string;
  /** false while the browser tab is hidden (client 'visibility' message); push notifications skip visible viewers. */
  visible?: boolean;
}

/** Push notifications (server/push.ts) learn about room events and chat through this. */
export interface RoomNotifier {
  /** Stored events of one commit, in order. */
  events(room: Room, events: StoredEvent[]): void;
  chat(room: Room, msg: ChatMessage): void;
  /** Blitz rooms, after every commit and on deletion: turn announcements and the hurry timer. */
  blitz?(room: Room): void;
}

export interface RoomContext {
  store: Store;
  now: () => number;
  rng: () => number;
  flagCodes: Set<string>;
  log: (msg: string) => void;
  /** Test-mode server: games here never change ratings. */
  testMode?: boolean;
  /** Known chat stickers (server/stickers.ts); without it sticker messages are refused. */
  stickers?: { has(id: string): boolean };
  /** Push notifications; without it nothing is pushed (tests, old setups). */
  notify?: RoomNotifier;
}

/** An error whose message is safe and meant to be shown to the user. */
export class RoomError extends Error {}

const SCHEDULE_KEYS = ['tickMode', 'tickTime', 'timezone', 'tickIntervalSec'];
/** Settings that decide whether everyone fits on the map at the start. */
const FIT_KEYS = ['gridRadius', 'maxPlayers', 'startRange', 'minSpawnDistance', 'spawnMode'];
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How many past chat messages a browser gets when it connects. */
const CHAT_HISTORY = 300;
/** Chat flood limit per user: at most CHAT_BURST messages per CHAT_WINDOW_MS. */
const CHAT_BURST = 8;
const CHAT_WINDOW_MS = 10_000;

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

export function cleanChatText(raw: unknown): string {
  if (typeof raw !== 'string') throw new RoomError('Message is empty');
  const s = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // Control characters except newlines, and bidi overrides that could garble other lines.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!s) throw new RoomError('Message is empty');
  if ([...s].length > CHAT_MAX) throw new RoomError(`Message is too long (max ${CHAT_MAX} characters)`);
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
  /** Recent chat send times per user, for the flood limit. */
  private readonly chatTimes = new Map<number, number[]>();
  /** Rating changes of the finished game (views.ts shows them on the end screen). */
  ratings: RatingChange[] | null = null;
  /** Group chats and plans (server/groups.ts). */
  readonly groups: GroupHub;
  /** Blitz rooms once started: the turn, secret orders and charges (stored in rooms.blitz). */
  blitz: BlitzState | null = null;

  constructor(ctx: RoomContext, row: RoomRow, players: PlayerState[], events: StoredEvent[]) {
    this.ctx = ctx;
    this.row = row;
    this.row.peace ??= null;
    this.row.rated ??= 1;
    this.settings = normalizeSettings(JSON.parse(row.settings));
    this.players = new Map(players.map((p) => [p.pid, p]));
    this.events = events;
    this.blitz = row.phase !== 'lobby' && this.settings.mode === 'blitz' ? (parseBlitzState(row.blitz) ?? newBlitzState()) : null;
    if (row.phase === 'finished' && row.started_at !== null) {
      const list = ctx.store.ratingChanges(row.id, row.started_at);
      this.ratings = list.length ? list : null;
    }
    this.groups = new GroupHub(this.groupHost());
  }

  get code(): string {
    return this.row.code;
  }

  /** Whether this room's games change ratings: never on a test-mode server or for test rooms. */
  get rated(): boolean {
    return this.row.rated !== 0 && !this.ctx.testMode;
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
    this.groups.sendGroups(sink);
    this.sendChatHistory(sink);
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
      nickname: this.uniqueNickname(this.defaultNickname(user)),
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
    this.refreshChat(user.id);
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

  /**
   * The creator's Start button. Unsaved settings from the creator's form come along and are
   * saved first with the usual checks; if they are refused, the game doesn't start.
   */
  requestStart(byUserId: number, unsavedSettings?: unknown): void {
    if (byUserId !== this.row.creator_id) throw new RoomError('Only the room creator can start the game');
    if (this.phase !== 'lobby') throw new RoomError('The game has already started');
    if (unsavedSettings !== undefined && unsavedSettings !== null) {
      const changes = unsavedSettings as Record<string, unknown>;
      const differs =
        typeof changes === 'object' &&
        Object.entries(changes).some(([k, v]) => String((this.settings as unknown as Record<string, unknown>)[k]) !== String(v));
      if (differs) this.updateSettingsAsCreator(byUserId, unsavedSettings);
    }
    if (this.players.size < 2) throw new RoomError('At least 2 players are needed to start');
    this.startGame();
  }

  private removeParticipant(pid: number): void {
    const userId = this.players.get(pid)?.userId;
    const leaving = this.players.get(pid);
    if (leaving) this.groups.removePlayer(leaving);
    this.ctx.store.deleteParticipant(pid);
    this.players.delete(pid);
    this.commit([]);
    if (userId !== undefined) this.refreshChat(userId);
  }

  /** The account's display name when it has one (and it fits a nickname), else the username. */
  private defaultNickname(user: { id: number; username: string }): string {
    const display = this.ctx.store.userById(user.id)?.display_name;
    if (display) {
      try {
        return cleanNickname([...display].slice(0, NICKNAME_MAX).join(''));
      } catch {
        // fall back to the username
      }
    }
    return user.username;
  }

  /** Username and avatar for the room view (views.ts). */
  userBrief(userId: number): { username: string; avatar: string | null } | undefined {
    return this.ctx.store.userBrief(userId);
  }

  /** Re-sends the view to everyone whose view changed (e.g. a player's new avatar). */
  refreshViews(): void {
    if (!this.deleted) this.broadcast([]);
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

  // ---------------------------------------------------------------- chat

  /**
   * Sends a chat message: room-wide when `to` is null, otherwise privately to that player.
   * With a `sticker` id the message is that sticker (and `text` is ignored).
   */
  chat(userId: number, to: unknown, text: unknown, sticker?: unknown, group?: unknown): ChatMessage {
    const me = this.participantOf(userId);
    if (!me) throw new RoomError('Join the room to chat');
    let toPid: number | null = null;
    let groupId: number | undefined;
    if (group !== null && group !== undefined) {
      // Group message: only its members may send or read it.
      if (typeof group !== 'number' || !this.groups.isMember(group, me.pid)) throw new RoomError('You are not in that group');
      groupId = group;
    } else if (to !== null && to !== undefined) {
      const target = typeof to === 'number' ? this.players.get(to) : undefined;
      if (!target) throw new RoomError('That player is not in this room');
      if (target.pid === me.pid) throw new RoomError("You can't message yourself");
      toPid = target.pid;
    }
    let clean = '';
    let stickerId: string | undefined;
    if (sticker !== undefined && sticker !== null) {
      if (typeof sticker !== 'string' || sticker.length > 300 || !this.ctx.stickers?.has(sticker)) throw new RoomError('That sticker is not available');
      stickerId = sticker;
    } else {
      clean = cleanChatText(text);
    }
    this.floodCheck(userId);
    return this.postChat({
      ts: this.ctx.now(),
      from: me.pid,
      fromName: me.nickname,
      to: toPid,
      text: clean,
      ...(stickerId ? { sticker: stickerId } : {}),
      ...(groupId !== undefined ? { group: groupId } : {}),
    });
  }

  /** Throws when the user sent more than CHAT_BURST messages (or group changes) in the window. */
  floodCheck(userId: number): void {
    const now = this.ctx.now();
    const recent = (this.chatTimes.get(userId) ?? []).filter((t) => now - t < CHAT_WINDOW_MS);
    if (recent.length >= CHAT_BURST) throw new RoomError('You are sending messages too fast');
    recent.push(now);
    this.chatTimes.set(userId, recent);
  }

  /** Stores a message and sends it to exactly those who may read it. */
  postChat(m: Omit<ChatMessage, 'id'>): ChatMessage {
    const msg = this.ctx.store.insertChat(this.row.id, m);
    for (const sink of this.sinks) {
      const pid = this.participantOf(sink.userId)?.pid;
      if (pid === undefined) continue;
      const reads =
        msg.group !== undefined ? this.groups.isMember(msg.group, pid) : msg.to === null || pid === msg.from || pid === msg.to;
      if (reads) sink.send({ type: 'chat', messages: [msg] });
    }
    this.notifySafely(() => this.ctx.notify?.chat(this, msg));
    return msg;
  }

  /** A failing notifier must never break the game. */
  private notifySafely(fn: () => void): void {
    if (!this.ctx.notify) return;
    try {
      fn();
    } catch (err) {
      this.ctx.log(`room ${this.code}: notify failed: ${(err as Error).stack ?? err}`);
    }
  }

  /** The room as server/groups.ts sees it. */
  private groupHost(): GroupHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const room = this;
    return {
      get row() {
        return room.row;
      },
      get players() {
        return room.players;
      },
      get sinks() {
        return room.sinks;
      },
      get gridRadius() {
        return room.settings.gridRadius;
      },
      get store() {
        return room.ctx.store;
      },
      participantOf: (userId) => room.participantOf(userId),
      floodCheck: (userId) => room.floodCheck(userId),
      postChat: (m) => room.postChat(m),
      now: () => room.ctx.now(),
      fail: (message) => {
        throw new RoomError(message);
      },
    };
  }

  /** Replaces a browser's chat with what its user may read now (nothing for non-participants). */
  private sendChatHistory(sink: Sink): void {
    const pid = this.participantOf(sink.userId)?.pid;
    const messages = pid === undefined ? [] : this.ctx.store.chatFor(this.row.id, pid, CHAT_HISTORY);
    sink.send({ type: 'chat', messages, reset: true });
  }

  /** After someone joins or leaves: their open tabs get (or lose) the chat history. */
  private refreshChat(userId: number): void {
    for (const sink of this.sinks) {
      if (sink.userId !== userId) continue;
      this.groups.sendGroups(sink);
      this.sendChatHistory(sink);
    }
  }

  // ---------------------------------------------------------------- game actions

  act(sink: Sink | null, userId: number, id: number, action: GameAction): ActionResult {
    const reply = (result: ActionResult): ActionResult => {
      if (!result.ok) sink?.send({ type: 'update', result: result.error ? { ...result, ...errorFields(result.error) } : result });
      return result;
    };
    if (this.phase === 'lobby') return reply({ id, ok: false, error: "The game hasn't started yet" });
    if (this.phase === 'paused') return reply({ id, ok: false, error: 'The game is paused' });
    if (this.phase === 'finished') return reply({ id, ok: false, error: 'The game is over' });
    const me = this.participantOf(userId);
    if (!me) return reply({ id, ok: false, error: 'You are not in this game' });
    if (this.blitz) return reply({ id, ok: false, error: 'This game is played in turns: queue orders instead' });

    const now = this.ctx.now();
    const outcome = applyAction(this.players, this.settings, me.pid, action, now);
    if (!outcome.ok) return reply({ id, ok: false, error: outcome.error });
    const events = outcome.events;
    if (action.type === 'attack' && this.openPeace()) {
      // Any attack while a peace proposal is open tears it up.
      this.row.peace = null;
      events.push({ ts: now, type: 'peace-cancel', actor: me.pid, target: null, data: { reason: 'attack' } });
    }
    if (alivePlayers(this.players).length <= 1) events.push(this.finish(now));
    const result: ActionResult = { id, ok: true };
    this.commit(events, sink ? { sink, result } : undefined);
    this.afterFinish();
    return result;
  }

  // ---------------------------------------------------------------- blitz orders

  /**
   * Blitz: replaces the player's order queue for this turn (validated like the planner does),
   * and confirms or re-opens it. Nobody else learns the orders; others only see the
   * confirmation flag. When every alive player has confirmed, the turn resolves at once.
   */
  orders(userId: number, raw: unknown, confirm: unknown, turn?: unknown): void {
    if (!this.blitz) throw new RoomError('This is not a blitz game');
    if (this.phase === 'lobby') throw new RoomError("The game hasn't started yet");
    if (this.phase === 'paused') throw new RoomError('The game is paused');
    if (this.phase === 'finished') throw new RoomError('The game is over');
    const me = this.participantOf(userId);
    if (!me) throw new RoomError('You are not in this game');
    const pos = positionOf(me);
    if (!me.alive || !pos) throw new RoomError('You have been eliminated');
    const st = this.blitz;
    // orders written for a turn that has already resolved must not land on the next one
    if (typeof turn === 'number' && turn !== st.turn) throw new RoomError('That turn is already over');
    const check = checkBlitzOrders(raw, { settings: this.settings, pos, ap: me.ap, range: me.range, charge: chargeOf(st, me.pid) });
    if (!check.ok) throw new RoomError(check.error);
    st.orders[String(me.pid)] = check.orders;
    const done = confirm === true;
    st.confirmed = st.confirmed.filter((pid) => pid !== me.pid);
    if (done) st.confirmed.push(me.pid);
    if (this.allConfirmed()) {
      this.resolveBlitz(this.ctx.now());
      return;
    }
    this.commit([]);
  }

  private allConfirmed(): boolean {
    if (!this.blitz || this.phase !== 'running') return false;
    const alive = alivePlayers(this.players);
    return alive.length > 0 && alive.every((p) => this.blitz!.confirmed.includes(p.pid));
  }

  /** Resolves the current blitz turn, then ends the game or opens the next turn. */
  private resolveBlitz(now: number): void {
    const st = this.blitz;
    if (!st || this.phase !== 'running') return;
    const { events, attacked } = resolveTurn(this.players, this.settings, st, now);
    if (attacked && this.openPeace()) {
      // Shots fired while peace talks were open tear them up (who fired stays secret).
      this.row.peace = null;
      events.push({ ts: now, type: 'peace-cancel', actor: null, target: null, data: { reason: 'attack' } });
    }
    if (alivePlayers(this.players).length <= 1) {
      events.push(this.finish(now));
    } else {
      // A holdout eliminated this turn may have been the last one missing from the peace.
      const done = this.peaceComplete(now);
      if (done) events.push(done);
      else {
        this.row.last_tick_at = now;
        this.row.next_tick_at = beginTurn(this.players, this.settings, st, now, true);
      }
    }
    this.commit(events);
    this.afterFinish();
    this.scheduleWake();
  }

  // ---------------------------------------------------------------- peace

  /** The open (unsigned) peace proposal, if any. */
  openPeace(): PeaceView | null {
    const p = parsePeace(this.row.peace);
    return p && !p.signed ? p : null;
  }

  /**
   * Peace: any alive player proposes (which also signs it), signs an open proposal, or
   * declines it (which cancels it). When every alive player has signed, the game ends and
   * they all share the victory.
   */
  peace(userId: number, op: unknown): void {
    if (this.phase === 'lobby') throw new RoomError("The game hasn't started yet");
    if (this.phase === 'paused') throw new RoomError('The game is paused');
    if (this.phase === 'finished') throw new RoomError('The game is over');
    const me = this.participantOf(userId);
    if (!me) throw new RoomError('You are not in this game');
    if (!me.alive) throw new RoomError('Only players still on the map can sign peace');
    const now = this.ctx.now();
    const open = this.openPeace();
    const events: GameEvent[] = [];
    switch (op) {
      case 'propose': {
        if (open) throw new RoomError('A peace proposal is already open: sign or decline it');
        const next: PeaceView = { proposer: me.pid, proposedAt: now, signers: [me.pid], signed: false };
        this.row.peace = JSON.stringify(next);
        events.push({ ts: now, type: 'peace-propose', actor: me.pid, target: null, data: {} });
        break;
      }
      case 'sign': {
        if (!open) throw new RoomError('There is no peace proposal to sign');
        if (open.signers.includes(me.pid)) throw new RoomError('You have already signed');
        open.signers.push(me.pid);
        this.row.peace = JSON.stringify(open);
        events.push({ ts: now, type: 'peace-sign', actor: me.pid, target: null, data: {} });
        break;
      }
      case 'decline': {
        if (!open) throw new RoomError('There is no peace proposal to decline');
        this.row.peace = null;
        events.push({ ts: now, type: 'peace-decline', actor: me.pid, target: null, data: {} });
        break;
      }
      default:
        throw new RoomError('Unknown peace action');
    }
    const done = this.peaceComplete(now);
    if (done) events.push(done);
    this.commit(events);
    this.afterFinish();
  }

  /** Ends the game in peace if an open proposal now has every alive player's signature. */
  private peaceComplete(now: number): GameEvent | null {
    const open = this.openPeace();
    if (!open || this.phase === 'finished') return null;
    const alive = alivePlayers(this.players);
    if (alive.length < 2 || !alive.every((p) => open.signers.includes(p.pid))) return null;
    const signers = alive.map((p) => p.pid);
    this.row.peace = JSON.stringify({ ...open, signers: open.signers.filter((pid) => signers.includes(pid)), signed: true } satisfies PeaceView);
    return this.finish(now, signers);
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
      peace: null,
    });
    this.ratings = null;
    this.blitz = null;
    if (this.settings.mode === 'blitz') {
      // Turn 1 starts at once: everyone gets the turn's AP and the planning clock runs.
      this.blitz = newBlitzState();
      this.row.next_tick_at = beginTurn(this.players, this.settings, this.blitz, now, false);
    }
    this.commit([ev]);
    this.scheduleWake();
  }

  /** Ends the game: the last player standing wins, or with `peaceSigners` every signer shares the win. */
  private finish(now: number, peaceSigners?: number[]): GameEvent {
    const winner = peaceSigners ? undefined : alivePlayers(this.players)[0];
    if (!peaceSigners) this.row.peace = null;
    Object.assign(this.row, {
      phase: 'finished',
      finished_at: now,
      paused_at: null,
      next_tick_at: null,
      winner_pid: winner?.pid ?? null,
    });
    this.clearTimer();
    return { ts: now, type: 'finish', actor: null, target: winner?.pid ?? null, data: peaceSigners ? { peace: peaceSigners } : {} };
  }

  /**
   * After a commit that may have ended the game: records ratings (rated rooms only, once per
   * game) and pushes the views again so everyone's end screen shows the changes.
   */
  private afterFinish(push = true): void {
    if (this.phase !== 'finished' || this.ratings || !this.rated || this.row.started_at === null) return;
    const list = [...this.players.values()];
    if (list.length < 2) return;
    const standings = placements(list);
    const userOf = new Map(list.map((p) => [p.pid, p.userId]));
    const before = this.ctx.store.ratingsOf(list.map((p) => p.userId));
    const byPid = new Map(list.map((p) => [p.pid, before.get(p.userId) ?? 1000]));
    const deltas = eloChanges(standings, byPid);
    const points = winPoints(standings);
    const firsts = standings.filter((s) => s.place === 1).length;
    this.ctx.store.recordRatedGame(
      this.row.id,
      this.row.started_at,
      this.row.finished_at ?? this.ctx.now(),
      standings.map((s) => ({
        userId: userOf.get(s.pid)!,
        pid: s.pid,
        place: s.place,
        players: list.length,
        before: byPid.get(s.pid)!,
        after: byPid.get(s.pid)! + (deltas.get(s.pid) ?? 0),
        winPoints: points.get(s.pid) ?? 0,
        won: s.place === 1 && firsts === 1,
      })),
    );
    const changes = this.ctx.store.ratingChanges(this.row.id, this.row.started_at);
    this.ratings = changes.length ? changes : null;
    if (this.ratings && push) this.broadcast([]);
  }

  pause(): void {
    if (this.phase !== 'running') throw new RoomError(`Can't pause a room that is ${this.phase}`);
    const now = this.ctx.now();
    this.row.phase = 'paused';
    this.row.paused_at = now;
    if (this.blitz) this.blitz.pausedLeft = Math.max(0, (this.row.next_tick_at ?? now) - now);
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
    if (this.blitz) {
      // Blitz: the turn goes on with the time it had left (at least 10 s to look around).
      this.row.next_tick_at = now + Math.max(10_000, this.blitz.pausedLeft ?? this.settings.blitzTurnSec * 1000);
      this.blitz.pausedLeft = null;
    }
    this.commit([{ ts: now, type: 'resume', actor: null, target: null, data: {} }]);
    this.scheduleWake();
  }

  /** Back to the lobby: keeps participants (nicknames, flags) and settings, wipes the game. */
  reset(): void {
    const now = this.ctx.now();
    clearGameState(this.players);
    if (this.settings.lobbyMode === 'time') {
      // The exact start moment belonged to the last lobby; the new one counts its length again.
      this.settings = { ...this.settings, lobbyMode: 'duration' };
      this.row.settings = JSON.stringify(this.settings);
    }
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
      peace: null,
    });
    this.ratings = null;
    this.blitz = null;
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
    let endsAt: number | undefined;
    for (const [key, value] of Object.entries(changes as Record<string, unknown>)) {
      if (typeof value !== 'string' && typeof value !== 'number') throw new RoomError(`Invalid value for ${key}`);
      // Not a setting: the exact lobby end (ms since epoch) for lobbyMode 'time'.
      if (key === 'lobbyEndsAt') endsAt = this.checkLobbyEnd(value);
      else overrides[key] = String(value);
    }
    if (Object.keys(overrides).length === 0 && endsAt === undefined) return;
    this.updateSettings(overrides, endsAt);
  }

  /** An exact lobby end from the creator: a moment in the future, at most 30 days ahead. */
  private checkLobbyEnd(value: string | number): number {
    const at = Number(value);
    if (!Number.isFinite(at)) throw new RoomError('Invalid value for lobbyEndsAt');
    const now = this.ctx.now();
    if (at < now + LOBBY_MIN_AHEAD_MS) throw new RoomError('The start time must be in the future');
    if (at > now + LOBBY_MAX_AHEAD_MS) throw new RoomError('The start time can be at most 30 days ahead');
    return Math.round(at);
  }

  /** Validates and applies setting changes (admin CLI, or the creator via updateSettingsAsCreator). */
  updateSettings(overrides: Record<string, string>, lobbyEndsAt?: number): void {
    const keys = Object.keys(overrides);
    if (this.phase !== 'lobby' && keys.includes('gridRadius')) {
      throw new RoomError('gridRadius can only be changed while the room is in the lobby');
    }
    if (this.phase !== 'lobby' && keys.includes('mode')) {
      throw new RoomError('The game mode can only be changed while the room is in the lobby');
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
        if (!canFit(next.maxPlayers, next.gridRadius, dist, this.ctx.rng, next.spawnMode)) {
          throw new RoomError(
            next.spawnMode === 'equidistant'
              ? `A radius-${next.gridRadius} map can't seat ${next.maxPlayers} players evenly around a ring at least ${dist} cells apart. Make the map bigger, the room smaller, or use random spawns.`
              : `A radius-${next.gridRadius} map can't fit ${next.maxPlayers} players at least ${dist} cells apart. Make the map bigger or the room smaller.`,
          );
        }
      }
    }
    const now = this.ctx.now();
    this.settings = next;
    this.row.settings = JSON.stringify(next);
    if (this.phase === 'lobby' && lobbyEndsAt !== undefined) {
      // An exact start moment (validated by checkLobbyEnd); the lobby is now in 'time' mode.
      if (next.lobbyMode !== 'time') {
        next = { ...next, lobbyMode: 'time' };
        this.settings = next;
        this.row.settings = JSON.stringify(next);
      }
      this.row.lobby_ends_at = lobbyEndsAt;
    } else if (this.phase === 'lobby' && next.lobbyMode === 'duration' && (keys.includes('lobbyDurationSec') || keys.includes('lobbyMode'))) {
      // Counted from when the lobby opened, but never less than a minute from now.
      this.row.lobby_ends_at = Math.max(this.row.lobby_started_at + next.lobbyDurationSec * 1000, now + 60_000);
    }
    if (this.phase === 'running' && !this.blitz && keys.some((k) => SCHEDULE_KEYS.includes(k))) {
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
      // Also when paused: otherwise the room would resume with one player left and never end.
      if (alivePlayers(this.players).length <= 1) events.push(this.finish(now));
      else {
        // The eliminated player may have been the last one who hadn't signed peace yet.
        const done = this.peaceComplete(now);
        if (done) events.push(done);
      }
    }
    this.commit(events);
    this.afterFinish();
    // Blitz: the eliminated player may have been the last one not yet confirmed.
    if (this.allConfirmed()) this.resolveBlitz(now);
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
    if (this.blitz && this.phase === 'running' && this.row.next_tick_at !== null && now >= this.row.next_tick_at) {
      // Blitz: the planning time is up — every queued order runs, confirmed or not.
      this.resolveBlitz(now);
    } else if (this.phase === 'running' && this.row.next_tick_at !== null && now >= this.row.next_tick_at) {
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
    this.notifySafely(() => this.ctx.notify?.blitz?.(this));
    for (const sink of this.sinks) sink.send({ type: 'fatal', message: 'This room was deleted', code: 'roomDeleted' });
    this.sinks.clear();
  }

  // ---------------------------------------------------------------- persistence & broadcast

  private commit(newEvents: GameEvent[], reply?: { sink: Sink; result: ActionResult }): void {
    const store = this.ctx.store;
    // A game that just ended gets its ratings first, so the finishing update already carries them.
    this.afterFinish(false);
    this.row.blitz = this.blitz ? JSON.stringify(this.blitz) : null;
    const stored = store.transaction(() => {
      store.updateRoom(this.row);
      for (const p of this.players.values()) store.updateParticipant(p);
      return newEvents.map((e) => store.insertEvent(this.row.id, e));
    });
    this.events.push(...stored);
    this.broadcast(stored, reply);
    if (stored.length) this.notifySafely(() => this.ctx.notify?.events(this, stored));
    if (this.blitz || this.settings.mode === 'blitz') this.notifySafely(() => this.ctx.notify?.blitz?.(this));
  }

  private broadcast(stored: StoredEvent[], reply?: { sink: Sink; result: ActionResult }): void {
    const now = this.ctx.now();
    for (const sink of this.sinks) {
      const state = buildView(this, sink.userId, now);
      const key = stateKey(state);
      const pid = this.participantOf(sink.userId)?.pid ?? null;
      const mayLog = pid !== null || this.phase === 'lobby';
      const entries = mayLog ? stored.map((e) => visibleEntry(e, pid, this.settings.revealActions)).filter((e) => e !== null) : [];
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
