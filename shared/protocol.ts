// Messages exchanged between browser and server. Everything a client can ever learn
// about a room arrives through these shapes, so hidden stats must never appear here
// except in `me` (your own stats) and `reveal` (only once the game is finished).

import type { GameSettings } from './settings.ts';

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
  | { type: 'start' }
  /** Room creator only, lobby only: new values for game settings. */
  | { type: 'settings'; changes: Record<string, string | number> }
  | { type: 'act'; id: number; action: GameAction }
  /**
   * `to` = a player's pid for a private message, null for the room-wide chat.
   * With `sticker` (an id from GET /api/stickers) the message is that sticker and `text` is ignored.
   */
  | { type: 'chat'; to: number | null; text: string; sticker?: string }
  | { type: 'ping'; t: number };

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
  players: PublicPlayer[];
  me: MyStats | null;
  reveal: Reveal | null;
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
  | 'adjust';

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
}

export interface ActionResult {
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
  | { type: 'notice'; message: string; level: 'error' | 'info' }
  | { type: 'fatal'; message: string }
  | { type: 'pong'; t: number; serverNow: number };

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
