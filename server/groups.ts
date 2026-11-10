// Group chats and shared plans of one room. Membership is enforced here: only a group's
// members ever receive its messages, its member list or its plan, and a member reads
// the group's messages from the moment they joined it (secret alliances stay secret).
//
// Plans: one shared board per group chat (and per private chat). The snapshot holds only
// public map data — where each living piece stands, which every player of the room
// already sees — never HP, AP or range (see views.ts).

import { inGrid } from '../shared/hex.ts';
import {
  dmChannel,
  GROUP_NAME_MAX,
  groupChannel,
  GROUPS_PER_ROOM,
  parseChannel,
  PLAN_MAX_ITEMS,
  PLAN_NOTE_MAX,
  PLAN_TURNS,
  type Cell,
  type ChatGroup,
  type ChatSys,
  type PlanEvent,
  type PlanItem,
  type PlanItemInput,
  type PlanSnapshot,
  type PlanState,
} from '../shared/plan.ts';
import type { ChatMessage, ServerMessage } from '../shared/protocol.ts';
import type { RoomRow, Store } from './db.ts';
import type { PlayerState } from './engine.ts';

/** What a group hub needs from its room (server/room.ts). */
export interface GroupHost {
  row: RoomRow;
  players: Map<number, PlayerState>;
  readonly sinks: Iterable<{ userId: number; send(msg: ServerMessage): void }>;
  readonly gridRadius: number;
  participantOf(userId: number): PlayerState | undefined;
  /** Throws when the user is sending too fast (shared with the chat flood limit). */
  floodCheck(userId: number): void;
  /** Stores a chat message and delivers it to whoever may read it. */
  postChat(msg: Omit<ChatMessage, 'id'>): ChatMessage;
  store: Store;
  now(): number;
  fail(message: string): never;
}

interface Group extends ChatGroup {
  /** pid → the last chat id before they joined; they read the group's messages after it. */
  since: Map<number, number>;
}

/** Plan edit flood limit per user: PLAN_BURST ops per PLAN_WINDOW_MS. */
const PLAN_BURST = 40;
const PLAN_WINDOW_MS = 10_000;
/** "X updated the plan" lines in the chat: at most one per channel per this long. */
const PLAN_NOTICE_MS = 3 * 60_000;
const PIN_KINDS = new Set(['target', 'defend', 'rally']);
const ARROW_KINDS = new Set(['move', 'attack', 'support']);

export function cleanGroupName(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new TypeError('bad name');
  const s = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

export class GroupHub {
  private readonly host: GroupHost;
  private readonly groups = new Map<number, Group>();
  private readonly plans = new Map<string, PlanState>();
  private readonly planTimes = new Map<number, number[]>();
  private readonly planNoticeAt = new Map<string, number>();

  constructor(host: GroupHost) {
    this.host = host;
    for (const g of host.store.loadGroups(host.row.id)) this.groups.set(g.id, g);
  }

  // ---------------------------------------------------------------- queries

  isMember(groupId: number, pid: number): boolean {
    return this.groups.get(groupId)?.members.includes(pid) ?? false;
  }

  /** The groups `pid` belongs to, as that member sees them. */
  groupsOf(pid: number): ChatGroup[] {
    const out: ChatGroup[] = [];
    for (const g of this.groups.values()) {
      if (g.members.includes(pid)) out.push({ id: g.id, name: g.name, members: [...g.members], createdBy: g.createdBy, createdAt: g.createdAt });
    }
    return out;
  }

  /** Sends a browser the list of its user's groups. */
  sendGroups(sink: { userId: number; send(msg: ServerMessage): void }): void {
    const pid = this.host.participantOf(sink.userId)?.pid;
    sink.send({ type: 'groups', groups: pid === undefined ? [] : this.groupsOf(pid) });
  }

  private pushGroups(pids: Iterable<number>): void {
    const set = new Set(pids);
    for (const sink of this.host.sinks) {
      const pid = this.host.participantOf(sink.userId)?.pid;
      if (pid !== undefined && set.has(pid)) this.sendGroups(sink);
    }
  }

  private me(userId: number): PlayerState {
    const me = this.host.participantOf(userId);
    if (!me) this.host.fail('Join the room to chat');
    return me;
  }

  private group(groupId: unknown, pid: number): Group {
    const g = isInt(groupId) ? this.groups.get(groupId) : undefined;
    // Same answer whether the group doesn't exist or you're not in it: no probing.
    if (!g || !g.members.includes(pid)) this.host.fail('You are not in that group');
    return g;
  }

  private pids(raw: unknown, exclude: Set<number>): number[] {
    if (!Array.isArray(raw) || raw.length > 64) this.host.fail('Pick the players to add');
    const out: number[] = [];
    for (const v of raw) {
      if (!isInt(v) || !this.host.players.has(v)) this.host.fail('That player is not in this room');
      if (!exclude.has(v) && !out.includes(v)) out.push(v);
    }
    return out;
  }

  private name(raw: unknown): string {
    let name: string;
    try {
      name = cleanGroupName(raw);
    } catch {
      this.host.fail('That group name is not valid');
    }
    if ([...name].length > GROUP_NAME_MAX) this.host.fail(`Group name is too long (max ${GROUP_NAME_MAX} characters)`);
    return name;
  }

  private sys(g: Group, from: PlayerState, sys: ChatSys): void {
    this.host.postChat({ ts: this.host.now(), from: from.pid, fromName: from.nickname, to: null, text: '', group: g.id, sys });
  }

  // ---------------------------------------------------------------- group changes

  create(userId: number, rawName: unknown, rawMembers: unknown): ChatGroup {
    const me = this.me(userId);
    const others = this.pids(rawMembers, new Set([me.pid]));
    if (others.length < 2) this.host.fail('A group needs at least two other players');
    const name = this.name(rawName);
    if (this.groups.size >= GROUPS_PER_ROOM) this.host.fail('This room has too many groups already');
    this.host.floodCheck(userId);
    const now = this.host.now();
    const store = this.host.store;
    const since = store.lastChatId(this.host.row.id);
    const members = [me.pid, ...others];
    const id = store.transaction(() => {
      const gid = store.insertGroup(this.host.row.id, name, me.pid, now);
      for (const pid of members) store.addGroupMember(gid, pid, since, now);
      return gid;
    });
    const g: Group = { id, name, members, createdBy: me.pid, createdAt: now, since: new Map(members.map((p) => [p, since])) };
    this.groups.set(id, g);
    this.pushGroups(members);
    this.sys(g, me, { kind: 'created' });
    return this.groupsOf(me.pid).find((x) => x.id === id)!;
  }

  rename(userId: number, groupId: unknown, rawName: unknown): void {
    const me = this.me(userId);
    const g = this.group(groupId, me.pid);
    const name = this.name(rawName);
    if (name === g.name) return;
    this.host.floodCheck(userId);
    this.host.store.renameGroup(g.id, name);
    g.name = name;
    this.pushGroups(g.members);
    this.sys(g, me, { kind: 'renamed', name });
  }

  add(userId: number, groupId: unknown, rawMembers: unknown): void {
    const me = this.me(userId);
    const g = this.group(groupId, me.pid);
    const added = this.pids(rawMembers, new Set(g.members));
    if (!added.length) return;
    this.host.floodCheck(userId);
    const now = this.host.now();
    const store = this.host.store;
    // New members read from here on, not the group's earlier messages.
    const since = store.lastChatId(this.host.row.id);
    store.transaction(() => {
      for (const pid of added) store.addGroupMember(g.id, pid, since, now);
    });
    for (const pid of added) {
      g.members.push(pid);
      g.since.set(pid, since);
    }
    this.pushGroups(g.members);
    this.sys(g, me, { kind: 'added', pids: added });
  }

  leave(userId: number, groupId: unknown): void {
    const me = this.me(userId);
    const g = this.group(groupId, me.pid);
    this.removeMember(g, me);
  }

  /** A player left the room (lobby): they leave all their groups. */
  removePlayer(p: PlayerState): void {
    for (const g of [...this.groups.values()]) if (g.members.includes(p.pid)) this.removeMember(g, p);
    // Their private-chat plans go too.
    for (const key of [...this.plans.keys()]) {
      const c = parseChannel(key);
      if (c?.kind === 'dm' && (c.a === p.pid || c.b === p.pid)) this.plans.delete(key);
    }
  }

  private removeMember(g: Group, p: PlayerState): void {
    const store = this.host.store;
    store.removeGroupMember(g.id, p.pid);
    g.members = g.members.filter((x) => x !== p.pid);
    g.since.delete(p.pid);
    this.pushGroups([p.pid]);
    if (g.members.length === 0) {
      store.deleteGroup(g.id);
      store.deletePlan(this.host.row.id, groupChannel(g.id));
      this.groups.delete(g.id);
      this.plans.delete(groupChannel(g.id));
      return;
    }
    this.pushGroups(g.members);
    this.sys(g, p, { kind: 'left' });
  }

  // ---------------------------------------------------------------- plans

  /** pids that may see and edit a channel's plan; throws if `pid` is not one of them. */
  private planMembers(channel: unknown, pid: number): { key: string; members: number[]; groupId: number | null } {
    const c = parseChannel(channel);
    if (c?.kind === 'group') {
      const g = this.group(c.id, pid);
      return { key: groupChannel(g.id), members: g.members, groupId: g.id };
    }
    if (c?.kind === 'dm' && (c.a === pid || c.b === pid)) {
      const other = c.a === pid ? c.b : c.a;
      if (this.host.players.has(other)) return { key: dmChannel(c.a, c.b), members: [c.a, c.b], groupId: null };
    }
    this.host.fail('You are not in that chat');
  }

  /** The map as every player of the room sees it now: living pieces and where they stand. */
  snapshot(by: number | null): PlanSnapshot {
    const pieces = [...this.host.players.values()]
      .filter((p) => p.alive && p.q !== null && p.r !== null)
      .map((p) => ({ pid: p.pid, nickname: p.nickname, flag: p.flag, q: p.q!, r: p.r! }));
    return { at: this.host.now(), by, radius: this.host.gridRadius, pieces };
  }

  private plan(key: string): PlanState {
    let plan = this.plans.get(key);
    if (plan) return plan;
    const stored = this.host.store.loadPlan(this.host.row.id, key);
    if (stored) plan = { channel: key, ...stored };
    else {
      plan = { channel: key, snapshot: this.snapshot(null), items: [] };
      this.host.store.savePlanSnapshot(this.host.row.id, key, plan.snapshot);
    }
    this.plans.set(key, plan);
    return plan;
  }

  /** Sends a browser the whole plan of a channel its user is in. */
  planOpen(sink: { userId: number; send(msg: ServerMessage): void }, channel: unknown): void {
    const me = this.me(sink.userId);
    const { key } = this.planMembers(channel, me.pid);
    sink.send({ type: 'plan', plan: this.plan(key) });
  }

  /** Applies one plan edit and broadcasts it to the channel's members. */
  planOp(userId: number, channel: unknown, raw: unknown): PlanEvent | null {
    const me = this.me(userId);
    const { key, members, groupId } = this.planMembers(channel, me.pid);
    if (!raw || typeof raw !== 'object') this.host.fail('That plan edit is not valid');
    const op = raw as Record<string, unknown>;
    const now = this.host.now();
    const recent = (this.planTimes.get(userId) ?? []).filter((t) => now - t < PLAN_WINDOW_MS);
    if (recent.length >= PLAN_BURST) this.host.fail('You are editing the plan too fast');
    recent.push(now);
    this.planTimes.set(userId, recent);

    const plan = this.plan(key);
    const store = this.host.store;
    const roomId = this.host.row.id;
    let event: PlanEvent | null = null;
    switch (op.op) {
      case 'add': {
        if (plan.items.length >= PLAN_MAX_ITEMS) this.host.fail(`The plan is full (max ${PLAN_MAX_ITEMS} marks). Erase some first.`);
        const item = this.validItem(op.item, plan.snapshot);
        const id = store.insertPlanItem(roomId, key, me.pid, now, item);
        const full = { ...item, id, author: me.pid, ts: now } as PlanItem;
        plan.items.push(full);
        const cid = typeof op.cid === 'string' && op.cid.length <= 24 ? op.cid : undefined;
        event = cid ? { op: 'add', item: full, cid } : { op: 'add', item: full };
        break;
      }
      case 'del': {
        if (!Array.isArray(op.ids) || op.ids.length > PLAN_MAX_ITEMS) this.host.fail('That plan edit is not valid');
        const want = new Set(op.ids.filter(isInt));
        const ids = plan.items.filter((i) => want.has(i.id)).map((i) => i.id);
        if (!ids.length) return null;
        store.deletePlanItems(roomId, key, ids);
        plan.items = plan.items.filter((i) => !want.has(i.id));
        event = { op: 'del', ids, by: me.pid };
        break;
      }
      case 'clear': {
        const turn = op.turn === null || op.turn === undefined ? null : op.turn;
        if (turn !== null && !(isInt(turn) && turn >= 1 && turn <= PLAN_TURNS)) this.host.fail('That plan edit is not valid');
        const gone = plan.items.filter((i) => turn === null || i.turn === turn).map((i) => i.id);
        if (!gone.length) return null;
        store.deletePlanItems(roomId, key, gone);
        plan.items = plan.items.filter((i) => !gone.includes(i.id));
        event = { op: 'clear', turn, by: me.pid };
        break;
      }
      case 'snapshot': {
        plan.snapshot = this.snapshot(me.pid);
        store.savePlanSnapshot(roomId, key, plan.snapshot);
        event = { op: 'snapshot', snapshot: plan.snapshot };
        break;
      }
      default:
        this.host.fail('That plan edit is not valid');
    }
    const memberSet = new Set(members);
    for (const sink of this.host.sinks) {
      const pid = this.host.participantOf(sink.userId)?.pid;
      if (pid !== undefined && memberSet.has(pid)) sink.send({ type: 'plan_op', channel: key, event });
    }
    if (event.op !== 'del') this.planNotice(key, me, groupId, members);
    return event;
  }

  /** One "X updated the plan" line in the chat, at most every few minutes per channel. */
  private planNotice(key: string, me: PlayerState, groupId: number | null, members: number[]): void {
    const now = this.host.now();
    const last = this.planNoticeAt.get(key);
    if (last !== undefined && now - last < PLAN_NOTICE_MS) return;
    this.planNoticeAt.set(key, now);
    const sys: ChatSys = { kind: 'plan' };
    if (groupId !== null) {
      this.host.postChat({ ts: now, from: me.pid, fromName: me.nickname, to: null, text: '', group: groupId, sys });
    } else {
      const other = members.find((p) => p !== me.pid)!;
      this.host.postChat({ ts: now, from: me.pid, fromName: me.nickname, to: other, text: '', sys });
    }
  }

  private cell(v: unknown, radius: number): Cell {
    if (!Array.isArray(v) || v.length !== 2 || !isInt(v[0]) || !isInt(v[1])) this.host.fail('That cell is not on the map');
    const c: Cell = [v[0], v[1]];
    if (!inGrid({ q: c[0], r: c[1] }, radius)) this.host.fail('That cell is not on the map');
    return c;
  }

  private validItem(raw: unknown, snap: PlanSnapshot): PlanItemInput {
    if (!raw || typeof raw !== 'object') this.host.fail('That plan edit is not valid');
    const it = raw as Record<string, unknown>;
    const turn = it.turn;
    if (!isInt(turn) || turn < 1 || turn > PLAN_TURNS) this.host.fail('That plan edit is not valid');
    const radius = snap.radius;
    const kind = it.kind;
    if (typeof kind === 'string' && ARROW_KINDS.has(kind)) {
      const from = this.cell(it.from, radius);
      const to = this.cell(it.to, radius);
      if (from[0] === to[0] && from[1] === to[1]) this.host.fail('An arrow needs two different cells');
      return { kind: kind as 'move', turn, from, to };
    }
    if (kind === 'pin') {
      if (typeof it.pin !== 'string' || !PIN_KINDS.has(it.pin)) this.host.fail('That plan edit is not valid');
      return { kind, turn, at: this.cell(it.at, radius), pin: it.pin as 'target' };
    }
    if (kind === 'note') {
      const text = typeof it.text === 'string' ? cleanGroupName(it.text) : '';
      if (!text) this.host.fail('A note needs some text');
      if ([...text].length > PLAN_NOTE_MAX) this.host.fail(`A note can be at most ${PLAN_NOTE_MAX} characters`);
      return { kind, turn, at: this.cell(it.at, radius), text };
    }
    if (kind === 'ghost') {
      if (!isInt(it.pid) || !snap.pieces.some((p) => p.pid === it.pid)) this.host.fail('That piece is not on the plan');
      return { kind, turn, at: this.cell(it.at, radius), pid: it.pid };
    }
    this.host.fail('That plan edit is not valid');
  }
}
