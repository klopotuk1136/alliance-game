import type { ServerMessage } from '../../shared/protocol.ts';
import { Store, type UserRow } from '../db.ts';
import { FLAG_CODES } from '../flags.ts';
import type { RoomContext, Sink } from '../room.ts';

export const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);

export function seededRng(seed = 12345): () => number {
  let s = seed >>> 0;
  return () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TestEnv {
  clock: { t: number };
  store: Store;
  ctx: RoomContext;
  user(name: string): UserRow;
}

export function makeEnv(path = ':memory:', start = T0): TestEnv {
  const clock = { t: start };
  const store = new Store(path);
  const ctx: RoomContext = { store, now: () => clock.t, rng: seededRng(), flagCodes: FLAG_CODES, log: () => undefined };
  return {
    clock,
    store,
    ctx,
    user(name: string): UserRow {
      return store.userByName(name) ?? store.createUser(name, 'scrypt$00$00', clock.t);
    },
  };
}

export class RecordingSink implements Sink {
  userId: number;
  username: string;
  lastState?: string;
  messages: ServerMessage[] = [];
  constructor(user: { id: number; username: string }) {
    this.userId = user.id;
    this.username = user.username;
  }
  send(msg: ServerMessage): void {
    this.messages.push(JSON.parse(JSON.stringify(msg)) as ServerMessage);
  }
  updates(): Array<Extract<ServerMessage, { type: 'update' }>> {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: 'update' }> => m.type === 'update');
  }
  lastStateMsg() {
    const withState = this.updates().filter((m) => m.state);
    return withState[withState.length - 1]?.state;
  }
}
