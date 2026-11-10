// Messages exchanged between browser and server. Everything a client can ever learn
// about a room arrives through these shapes, so hidden stats must never appear here
// except in `me` (your own stats) and `reveal` (only once the game is finished).

import type { ActionCounts } from './costs.ts';
import type { GameSettings } from './settings.ts';
import type { ChatGroup, ChatSys, PlanEvent, PlanOp, PlanState } from './plan.ts';
import type { ErrorInfo } from './errors.ts';
import type { BlitzOrder, BlitzView } from './blitz.ts';

export type Phase = 'lobby' | 'running' | 'paused' | 'finished';

export type GameAction =
  | { type: 'move'; q: number; r: number }
  | { type: 'attack'; target: number }
  | { type: 'grant'; target: number }
  | { type: 'upgrade' };

export type ClientMessage =
  | { type: 'hello'; token: string; room: string }
  | { type: 'join' }
  | { type: 'leave' }
  | { type: 'profile'; nickname?: string; flag?: string }
  | { type: 'kick'; pid: number }
  /**
   * Room creator only. With `settings`, those unsaved form values are saved first (same
   * checks as a `settings` message); if they are refused, the game does not start.
   */
  | { type: 'start'; settings?: Record<string, string | number> }
  /** Peace: any alive player proposes (and signs), signs an open proposal, or declines it. */
  | { type: 'peace'; op: 'propose' | 'sign' | 'decline' }
  /** Room creator only, lobby only: new values for game settings. */
  | { type: 'settings'; changes: Record<string, string | number> }
  | { type: 'act'; id: number; action: GameAction }
  /**
   * Blitz: replaces your whole order queue for the current turn. `confirm` true = done
   * planning (the turn ends early once every alive player confirmed); false re-opens it.
   */
  | { type: 'orders'; orders: BlitzOrder[]; confirm?: boolean; turn?: number }
  /**
   * `to` = a player's pid for a private message, null for the room-wide chat.
   * With `sticker` (an id from GET /api/stickers) the message is that sticker and `text` is ignored.
   */
  | { type: 'chat'; to: number | null; text: string; sticker?: string; group?: number }
  | { type: 'ping'; t: number }
  /** The tab became visible / hidden: push notifications skip players who are looking at the room. */
  | { type: 'visibility'; visible: boolean }
  | GroupClientMessage;

/** Group chats and plans (shared/plan.ts). `group` on a chat message sends it to that group. */
export type GroupClientMessage =
  /** `members`: pids of 2+ other players; `name` optional ('' = the members' names). */
  | { type: 'group_create'; name?: string; members: number[] }
  | { type: 'group_rename'; group: number; name: string }
  | { type: 'group_add'; group: number; members: number[] }
  | { type: 'group_leave'; group: number }
  /** Asks for the whole plan of a channel ("g:<id>" or "d:<pid>:<pid>"). */
  | { type: 'plan_open'; channel: string }
  | { type: 'plan_op'; channel: string; op: PlanOp };

export interface PublicPlayer {
  pid: number;
  nickname: string;
  flag: string;
  alive: boolean;
  /** Position on the grid; null in the lobby and after elimination. */
  q: number | null;
  r: number | null;
  eliminatedBy: number | null;
  eliminatedAt: number | null;
  isCreator: boolean;
  /** The player's login name; opens their public profile (GET /api/users/<username>/profile). */
  username?: string;
  /** URL of the player's profile picture, when they set one. */
  avatar?: string;
}

export interface MyStats {
  pid: number;
  hp: number;
  ap: number;
  range: number;
  alive: boolean;
  /** Uses of each action since the last AP tick; prices escalate with them (shared/costs.ts). */
  used?: ActionCounts;
}

/** An open peace proposal (while running), or the signed peace (once finished by peace). */
export interface PeaceView {
  proposer: number;
  proposedAt: number;
  /** Players who signed, in signing order (the proposer first). */
  signers: number[];
  /** true once every alive player signed and the game ended in a shared victory. */
  signed: boolean;
}

/** One player's rating change from a finished, rated game. */
export interface RatingChange {
  pid: number;
  /** 1 = best; tied players share a place (peace signers all share 1st). */
  place: number;
  before: number;
  after: number;
  delta: number;
  /** 1 for an outright win, 1/n for each of n peace signers, else 0. */
  winPoints: number;
}

export interface RevealPlayer {
  pid: number;
  hp: number;
  ap: number;
  range: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  apGiven: number;
  apReceived: number;
  upgrades: number;
}

export interface Reveal {
  players: RevealPlayer[];
  history: LogEntry[];
}

export interface RoomView {
  code: string;
  name: string;
  phase: Phase;
  serverNow: number;
  rules: GameSettings;
  isCreator: boolean;
  /** Whether the viewer has joined this room. */
  participant: boolean;
  lobbyEndsAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  pausedAt: number | null;
  nextTickAt: number | null;
  winnerPid: number | null;
  /** Open peace proposal, or the signed peace after a peace ending; null otherwise. */
  peace: PeaceView | null;
  /** Whether this room's result changes ratings (test-mode rooms never do). */
  rated: boolean;
  /** Rating changes of every player once a rated game is finished; null otherwise. */
  ratings: RatingChange[] | null;
  players: PublicPlayer[];
  me: MyStats | null;
  reveal: Reveal | null;
  /** Blitz rooms once the game started: turn, timer, confirmations, charges, your orders. */
  blitz?: BlitzView | null;
}

export type LogType =
  | 'start'
  | 'move'
  | 'attack'
  | 'hit'
  | 'grant'
  | 'granted'
  | 'upgrade'
  | 'eliminate'
  | 'tick'
  | 'pause'
  | 'resume'
  | 'finish'
  | 'adjust'
  | 'peace-propose'
  | 'peace-sign'
  | 'peace-decline'
  | 'peace-cancel'
  // blitz: a turn resolved (value = turn, amount = hits, extra = misses), your shot missed
  // (at = cell), your gift landed on an empty cell, someone's charge (actor, value = level)
  | 'turn'
  | 'miss'
  | 'gift-lost'
  | 'charge';

/**
 * One line of a player's event log. Which fields are filled depends on who is looking:
 * a victim's `hit` entry never carries the attacker, a `granted` entry never carries the giver.
 */
export interface LogEntry {
  id: number;
  ts: number;
  type: LogType;
  actor?: number;
  target?: number;
  amount?: number;
  value?: number;
  at?: [number, number];
  /** Peace signers, on a `finish` entry that ended the game in peace. */
  pids?: number[];
  /** Blitz `turn` entries: how many shots missed. */
  extra?: number;
}

/**
 * A chat line. Room-wide messages (`to` null) go to every participant; private ones only
 * to their sender and recipient.
 */
export interface ChatMessage {
  id: number;
  ts: number;
  from: number;
  /** Sender's nickname when the message was sent (they may have left the lobby since). */
  fromName: string;
  to: number | null;
  /** Empty for a sticker message. */
  text: string;
  /** Sticker id (see StickerInfo) when the message is a sticker. */
  sticker?: string;
  /** Set when the message belongs to a group chat (then `to` is null). */
  group?: number;
  /** A line written by the server (group created, member added, plan updated…); `text` is empty. */
  sys?: ChatSys;
}

export interface ActionResult extends ErrorInfo {
  id: number;
  ok: boolean;
  error?: string;
}

export type ServerMessage =
  | {
      type: 'update';
      state?: RoomView;
      entries?: LogEntry[];
      /** true when `entries` replaces the whole log (initial load / reconnect). */
      resetLog?: boolean;
      result?: ActionResult;
    }
  | {
      type: 'chat';
      messages: ChatMessage[];
      /** true when `messages` replaces the whole history (initial load / after joining). */
      reset?: boolean;
    }
  | ({ type: 'notice'; message: string; level: 'error' | 'info' } & ErrorInfo)
  | ({ type: 'fatal'; message: string } & ErrorInfo)
  | { type: 'pong'; t: number; serverNow: number }
  /** The viewer's group chats in this room (the whole list, each time it changes). */
  | { type: 'groups'; groups: ChatGroup[] }
  | { type: 'plan'; plan: PlanState }
  | { type: 'plan_op'; channel: string; event: PlanEvent };

// ---- HTTP API ----

export interface UserInfo {
  id: number;
  username: string;
}

/** What anyone logged in may see of an account (GET /api/users/<username>/profile). */
export interface PublicProfile {
  username: string;
  /** Shown instead of the username where set; the username still logs in. */
  displayName: string | null;
  bio: string | null;
  /** Telegram handle without "@"; link to https://t.me/<handle>. */
  telegram: string | null;
  avatarUrl: string | null;
  joinedAt: number;
  /** Games started (lobbies that never started don't count) and won. */
  games: number;
  wins: number;
  /** Elo rating from rated games (starts at 1000), rounded. */
  rating: number;
  /** Rated games played; test-mode games don't count. */
  ratedGames: number;
  /** 1 per outright win, 1/n per shared peace among n players (rated games only). */
  winPoints: number;
}

export interface LeaderboardEntry {
  rank: number;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  rating: number;
  games: number;
  wins: number;
  winPoints: number;
}

/** GET /api/leaderboard: everyone with at least one rated game, best rating first. */
export interface LeaderboardResponse {
  players: LeaderboardEntry[];
}

/** Your own profile (GET /api/me, PATCH /api/profile, avatar upload/removal). */
export interface MyProfile extends PublicProfile {
  updatedAt: number | null;
}

export interface MeResponse {
  user: UserInfo;
  profile: MyProfile;
}

export interface AuthResponse {
  token: string;
  user: UserInfo;
}

export interface RoomSummary {
  code: string;
  name: string;
  phase: Phase;
  players: number;
  maxPlayers: number;
  lobbyEndsAt: number | null;
  creator: string;
  joined: boolean;
  alive: boolean | null;
  winner: string | null;
  /** Game mode; blitz rooms also carry their turn length (seconds). */
  mode?: 'classic' | 'blitz';
  blitzTurnSec?: number;
}

export interface RoomsResponse {
  open: RoomSummary[];
  mine: RoomSummary[];
  serverNow: number;
}

/** A chat sticker: an image file in the server's stickers/ folder. */
export interface StickerInfo {
  /** "<pack folder>/<file>" or "<file>" for the default pack; what a chat message carries. */
  id: string;
  /** Shown as alt text: the file name without extension. */
  name: string;
  /** Versioned by content, so it can be cached forever. */
  url: string;
  w?: number;
  h?: number;
}

export interface StickerPack {
  id: string;
  title: string;
  /** URL of the pack's cover sticker. */
  cover: string;
  stickers: StickerInfo[];
}

export interface StickersResponse {
  packs: StickerPack[];
}

export interface FlagInfo {
  code: string;
  name: string;
}

export const NICKNAME_MAX = 20;
export const ROOM_NAME_MAX = 40;
export const CHAT_MAX = 500;
