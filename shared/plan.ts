// Group chats and their shared planning boards: the shapes both the server and the
// browser use, plus the limits the server enforces.
//
// A plan belongs to one chat channel ("g:<group id>" or "d:<pid>:<pid>" for a private
// chat, smaller pid first). It is a snapshot of the public map (where every piece stood
// when someone opened or refreshed it) plus drawn items: arrows, pins, notes and ghost
// pieces, each on one of PLAN_TURNS layers ("turn +1, +2, +3").

/** [q, r] of a hex cell. */
export type Cell = [number, number];

export type ArrowKind = 'move' | 'attack' | 'support';
export type PinKind = 'target' | 'defend' | 'rally';

export type PlanItemInput =
  | { kind: ArrowKind; turn: number; from: Cell; to: Cell }
  | { kind: 'pin'; turn: number; at: Cell; pin: PinKind }
  | { kind: 'note'; turn: number; at: Cell; text: string }
  /** A copy of a piece (by pid) showing where it should stand. */
  | { kind: 'ghost'; turn: number; at: Cell; pid: number };

export type PlanItem = PlanItemInput & {
  id: number;
  /** pid of the player who drew it. */
  author: number;
  ts: number;
};

/** A piece on the snapshot: only what every player of the room sees on the map anyway. */
export interface PlanPiece {
  pid: number;
  nickname: string;
  flag: string;
  q: number;
  r: number;
}

export interface PlanSnapshot {
  at: number;
  /** pid of the player who took it; null when it was taken automatically (first open). */
  by: number | null;
  radius: number;
  pieces: PlanPiece[];
}

export interface PlanState {
  channel: string;
  snapshot: PlanSnapshot;
  items: PlanItem[];
}

/** An edit sent by a browser. `cid` comes back with the resulting item (for undo). */
export type PlanOp =
  | { op: 'add'; item: PlanItemInput; cid?: string }
  | { op: 'del'; ids: number[] }
  /** turn null = every layer. */
  | { op: 'clear'; turn: number | null }
  | { op: 'snapshot' };

/** An edit as the server broadcasts it to every member. */
export type PlanEvent =
  | { op: 'add'; item: PlanItem; cid?: string }
  | { op: 'del'; ids: number[]; by: number }
  | { op: 'clear'; turn: number | null; by: number }
  | { op: 'snapshot'; snapshot: PlanSnapshot };

/** A group chat inside a room. Only its members ever learn that it exists. */
export interface ChatGroup {
  id: number;
  /** '' = no custom name; show the members' names instead. */
  name: string;
  /** pids, in the order they joined. */
  members: number[];
  createdBy: number;
  createdAt: number;
}

/** A line the server writes into a chat on its own ("Anna added Boris"). */
export interface ChatSys {
  kind: 'created' | 'added' | 'left' | 'renamed' | 'plan';
  /** Who was added (for 'added'). */
  pids?: number[];
  /** The new name (for 'renamed'; '' = back to the members' names). */
  name?: string;
}

export const PLAN_TURNS = 3;
export const PLAN_MAX_ITEMS = 200;
export const PLAN_NOTE_MAX = 60;
export const GROUP_NAME_MAX = 32;
/** Groups per room, so a room can't be flooded with them. */
export const GROUPS_PER_ROOM = 60;

export function groupChannel(id: number): string {
  return `g:${id}`;
}

export function dmChannel(a: number, b: number): string {
  return a < b ? `d:${a}:${b}` : `d:${b}:${a}`;
}

export type ParsedChannel = { kind: 'group'; id: number } | { kind: 'dm'; a: number; b: number };

export function parseChannel(raw: unknown): ParsedChannel | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  let m = /^g:(\d{1,12})$/.exec(raw);
  if (m) return { kind: 'group', id: Number(m[1]) };
  m = /^d:(\d{1,12}):(\d{1,12})$/.exec(raw);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a < b ? { kind: 'dm', a, b } : null;
  }
  return null;
}
