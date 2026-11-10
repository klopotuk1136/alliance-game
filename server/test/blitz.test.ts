import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BLITZ_REPLAY_MS, checkBlitzOrders, type BlitzOrder } from '../../shared/blitz.ts';
import { DEFAULT_SETTINGS, type GameSettings } from '../../shared/settings.ts';
import { newBlitzState, resolveTurn } from '../blitz.ts';
import type { PlayerState, Players } from '../engine.ts';
import { Store } from '../db.ts';
import { RoomError } from '../room.ts';
import { RoomManager } from '../rooms.ts';
import { makeEnv, RecordingSink } from './helpers.ts';

const S: GameSettings = { ...DEFAULT_SETTINGS, mode: 'blitz', escalateAttack: 'off', escalateGrant: 'off' };

function pl(pid: number, q: number, r: number, extra: Partial<PlayerState> = {}): PlayerState {
  return { pid, userId: pid, nickname: `p${pid}`, flag: 'xx', joinedAt: 0, q, r, hp: 3, ap: 10, range: 2, alive: true, eliminatedAt: null, eliminatedBy: null, ...extra };
}

function board(...ps: PlayerState[]): Players {
  return new Map(ps.map((p) => [p.pid, p]));
}

function run(players: Players, orders: Record<number, BlitzOrder[]>, charge: Record<number, number> = {}, settings = S) {
  const st = newBlitzState();
  st.turn = 1;
  for (const [pid, list] of Object.entries(orders)) st.orders[pid] = list;
  for (const [pid, c] of Object.entries(charge)) st.charge[pid] = c;
  const out = resolveTurn(players, settings, st, 1000);
  return { ...out, st };
}

const at = (p: PlayerState): [number | null, number | null] => [p.q, p.r];

test('blitz moves: into the same cell → both bounce; swapping → both bounce', () => {
  const a = pl(1, 0, 0);
  const b = pl(2, 2, 0);
  run(board(a, b), { 1: [{ type: 'move', q: 1, r: 0 }], 2: [{ type: 'move', q: 1, r: 0 }] });
  assert.deepEqual(at(a), [0, 0]);
  assert.deepEqual(at(b), [2, 0]);

  const c = pl(1, 0, 0);
  const d = pl(2, 1, 0);
  const { report } = run(board(c, d), { 1: [{ type: 'move', q: 1, r: 0 }], 2: [{ type: 'move', q: 0, r: 0 }] });
  assert.deepEqual(at(c), [0, 0]);
  assert.deepEqual(at(d), [1, 0]);
  assert.ok(report.moves.every((m) => m.bounced));
});

test('blitz moves: following someone who leaves is fine; into a stayer bounces (and cascades)', () => {
  // a → b's cell, b moves away: both succeed
  const a = pl(1, 0, 0);
  const b = pl(2, 1, 0);
  run(board(a, b), { 1: [{ type: 'move', q: 1, r: 0 }], 2: [{ type: 'move', q: 2, r: 0 }] });
  assert.deepEqual(at(a), [1, 0]);
  assert.deepEqual(at(b), [2, 0]);

  // a → b's cell, b → c's cell, c stays: b bounces, so a bounces too
  const x = pl(1, 0, 0);
  const y = pl(2, 1, 0);
  const z = pl(3, 2, 0);
  run(board(x, y, z), { 1: [{ type: 'move', q: 1, r: 0 }], 2: [{ type: 'move', q: 2, r: 0 }] });
  assert.deepEqual(at(x), [0, 0]);
  assert.deepEqual(at(y), [1, 0]);
  assert.deepEqual(at(z), [2, 0]);

  // a three-way rotation is not a swap: everyone moves
  const r1 = pl(1, 0, 0);
  const r2 = pl(2, 1, 0);
  const r3 = pl(3, 0, 1);
  run(board(r1, r2, r3), { 1: [{ type: 'move', q: 1, r: 0 }], 2: [{ type: 'move', q: 0, r: 1 }], 3: [{ type: 'move', q: 0, r: 0 }] });
  assert.deepEqual([at(r1), at(r2), at(r3)], [[1, 0], [0, 1], [0, 0]]);
});

test('blitz attacks hit the cell after the moves: a dodge makes it a miss, stepping in takes the hit', () => {
  const shooter = pl(1, 0, 0);
  const runner = pl(2, 2, 0);
  const { report, events } = run(board(shooter, runner), { 1: [{ type: 'attack', q: 2, r: 0 }], 2: [{ type: 'move', q: 2, r: -1 }] });
  assert.equal(runner.hp, 3);
  assert.equal(report.shots[0].victim, null);
  assert.ok(events.some((e) => e.type === 'miss' && e.actor === 1));

  const s2 = pl(1, 0, 0);
  const walker = pl(2, 2, 0);
  run(board(s2, walker), { 1: [{ type: 'attack', q: 1, r: 0 }], 2: [{ type: 'move', q: 1, r: 0 }] });
  assert.equal(walker.hp, 2);
});

test('blitz damage stacks; charge adds to the first shot and is spent even on a miss', () => {
  const a = pl(1, 0, 0);
  const b = pl(2, 2, 0);
  const t = pl(3, 1, 1, { hp: 5 });
  const { st } = run(board(a, b, t), { 1: [{ type: 'attack', q: 1, r: 1 }, { type: 'attack', q: 1, r: 1 }], 2: [{ type: 'attack', q: 1, r: 1 }] }, { 1: 2 });
  // a: (1 + 2) + 1, b: 1
  assert.equal(t.hp, 0);
  assert.equal(t.alive, false);
  assert.equal(t.eliminatedBy, 1);
  assert.equal(st.charge['1'], 0);

  const m = pl(1, 0, 0);
  const n = pl(2, 2, 0);
  const r = run(board(m, n), { 1: [{ type: 'attack', q: 1, r: 0 }] }, { 1: 3 });
  assert.equal(r.report.shots[0].damage, 4);
  assert.equal(r.report.shots[0].victim, null);
  assert.equal(r.st.charge['1'], 0);
});

test('blitz charge banks after the shots (not usable the same turn) and is capped', () => {
  const a = pl(1, 0, 0);
  const b = pl(2, 1, 0, { hp: 10 });
  const { st } = run(board(a, b), { 1: [{ type: 'charge' }, { type: 'attack', q: 1, r: 0 }] });
  assert.equal(b.hp, 9);
  assert.equal(st.charge['1'], 1);

  const c = pl(1, 0, 0);
  const d = pl(2, 3, 0);
  const r = run(board(c, d), { 1: [{ type: 'charge' }, { type: 'charge' }] }, { 1: 2 });
  assert.equal(r.st.charge['1'], 3);
  // the planner refuses going over the cap
  const check = checkBlitzOrders([{ type: 'charge' }, { type: 'charge' }], { settings: S, pos: { q: 0, r: 0 }, ap: 10, range: 2, charge: 2 });
  assert.equal(check.ok, false);
  // ...but an attack this turn spends the old charge first
  assert.equal(checkBlitzOrders([{ type: 'attack', q: 1, r: 0 }, { type: 'charge' }], { settings: S, pos: { q: 0, r: 0 }, ap: 10, range: 2, charge: 3 }).ok, true);
});

test('blitz gifts land on whoever stands on the cell after the moves; empty cell = lost', () => {
  const g = pl(1, 0, 0, { ap: 5 });
  const friend = pl(2, 2, 0, { ap: 1 });
  run(board(g, friend), { 1: [{ type: 'grant', q: 1, r: 0 }], 2: [{ type: 'move', q: 1, r: 0 }] });
  // 1 − 1 for the move + 1 gift
  assert.equal(friend.ap, 1);
  assert.equal(g.ap, 4);

  const g2 = pl(1, 0, 0, { ap: 5 });
  const f2 = pl(2, 2, 0, { ap: 1 });
  const { events } = run(board(g2, f2), { 1: [{ type: 'grant', q: 2, r: 0 }], 2: [{ type: 'move', q: 3, r: 0 }] });
  assert.equal(f2.ap, 0);
  assert.equal(f2.q, 3);
  assert.equal(g2.ap, 4);
  assert.ok(events.some((e) => e.type === 'gift-lost'));
});

test('blitz range-ups resolve first; mutual kills end in a draw', () => {
  const a = pl(1, 0, 0, { hp: 1 });
  const b = pl(2, 3, 0, { hp: 1 });
  run(board(a, b), { 1: [{ type: 'upgrade' }, { type: 'attack', q: 3, r: 0 }], 2: [{ type: 'upgrade' }, { type: 'attack', q: 0, r: 0 }] });
  assert.equal(a.range, 3);
  assert.equal(a.alive, false);
  assert.equal(b.alive, false);
});

test('blitz planner: AP budget, one move, neighbours only, range from the start cell, max orders', () => {
  const ctx = { settings: S, pos: { q: 0, r: 0 }, ap: 2, range: 2, charge: 0 };
  assert.equal(checkBlitzOrders([{ type: 'attack', q: 2, r: 0 }, { type: 'attack', q: 1, r: 0 }], ctx).ok, true);
  assert.match((checkBlitzOrders([{ type: 'attack', q: 2, r: 0 }, { type: 'attack', q: 1, r: 0 }, { type: 'charge' }], ctx) as { error: string }).error, /Not enough AP/);
  assert.match((checkBlitzOrders([{ type: 'move', q: 1, r: 0 }, { type: 'move', q: 0, r: 1 }], ctx) as { error: string }).error, /one move/);
  assert.match((checkBlitzOrders([{ type: 'move', q: 2, r: 0 }], ctx) as { error: string }).error, /neighbouring/);
  assert.match((checkBlitzOrders([{ type: 'attack', q: 3, r: 0 }], ctx) as { error: string }).error, /Out of range/);
  assert.equal(checkBlitzOrders([{ type: 'upgrade' }, { type: 'attack', q: 3, r: 0 }], { ...ctx, ap: 3 }).ok, true);
  assert.match((checkBlitzOrders([{ type: 'attack', q: 0, r: 0 }], ctx) as { error: string }).error, /own cell/);
  const five = Array.from({ length: 5 }, () => ({ type: 'charge' }));
  assert.match((checkBlitzOrders(five, { ...ctx, ap: 50 }) as { error: string }).error, /Too many orders/);
  assert.equal(checkBlitzOrders([{ type: 'nuke' }], ctx).ok, false);
});

// ---------------------------------------------------------------- the room around it

function blitzRoom() {
  const env = makeEnv();
  const mgr = new RoomManager(env.ctx);
  const alice = env.user('alice');
  const bob = env.user('bob');
  const carol = env.user('carol');
  const room = mgr.create(alice, 'Blitz night');
  room.updateSettings({ mode: 'blitz', blitzTurnSec: '30', escalateAttack: 'off' });
  room.join(bob);
  room.join(carol);
  return { ...env, mgr, room, alice, bob, carol };
}

function seat(room: ReturnType<typeof blitzRoom>['room'], spots: Record<string, [number, number]>) {
  for (const [nick, [q, r]] of Object.entries(spots)) {
    const p = room.playerByNickname(nick)!;
    p.q = q;
    p.r = r;
  }
}

test('blitz room: turn 1 gives AP; classic actions are refused; the timer resolves queued orders', () => {
  const { room, clock, alice, bob } = blitzRoom();
  room.requestStart(alice.id);
  assert.equal(room.blitz?.turn, 1);
  assert.equal(room.participantOf(alice.id)!.ap, 2);
  assert.equal(room.row.next_tick_at, clock.t + 30_000);
  const r = room.act(null, alice.id, 1, { type: 'upgrade' });
  assert.equal(r.ok, false);
  seat(room, { alice: [0, 0], bob: [2, 0], carol: [-3, 0] });
  // queued but never confirmed: still runs at the deadline
  room.orders(alice.id, [{ type: 'attack', q: 2, r: 0 }], false);
  room.orders(bob.id, [{ type: 'charge' }], true);
  clock.t += 30_000;
  room.processTime();
  assert.equal(room.blitz?.turn, 2);
  assert.equal(room.participantOf(bob.id)!.hp, 2);
  assert.equal(room.blitz?.charge[String(room.participantOf(bob.id)!.pid)], 1);
  // next deadline leaves room for the replay
  assert.equal(room.row.next_tick_at, clock.t + BLITZ_REPLAY_MS + 30_000);
  // AP: 2 − 1 + 2
  assert.equal(room.participantOf(alice.id)!.ap, 3);
  assert.throws(() => room.orders(alice.id, [{ type: 'attack', q: 5, r: 0 }], true), RoomError);
});

test('blitz room: late orders for a turn that already resolved are refused', () => {
  const { room, alice, bob, carol } = blitzRoom();
  room.requestStart(alice.id);
  room.orders(alice.id, [], true, 1);
  room.orders(bob.id, [], true, 1);
  room.orders(carol.id, [], true, 1);
  assert.equal(room.blitz?.turn, 2);
  assert.throws(() => room.orders(alice.id, [{ type: 'charge' }], true, 1), /already over/);
  room.orders(alice.id, [{ type: 'charge' }], false, 2);
  assert.equal(room.blitz?.orders[String(room.participantOf(alice.id)!.pid)]?.length, 1);
});

test('blitz room: the turn ends early when every alive player confirmed', () => {
  const { room, alice, bob, carol } = blitzRoom();
  room.requestStart(alice.id);
  room.orders(alice.id, [], true);
  room.orders(bob.id, [], true);
  assert.equal(room.blitz?.turn, 1);
  room.orders(carol.id, [], false);
  assert.equal(room.blitz?.turn, 1);
  room.orders(carol.id, [], true);
  assert.equal(room.blitz?.turn, 2);
  assert.deepEqual(room.blitz?.confirmed, []);
});

test('blitz room: other players never see your orders, only that you confirmed', () => {
  const { room, alice, bob, carol } = blitzRoom();
  const sa = new RecordingSink(alice);
  const sb = new RecordingSink(bob);
  room.attach(sa);
  room.attach(sb);
  room.requestStart(alice.id);
  seat(room, { alice: [0, 0], bob: [2, 0], carol: [-3, 0] });
  room.refreshViews();
  const before = sb.messages.length;
  room.orders(alice.id, [{ type: 'attack', q: 2, r: 0 }], false);
  // bob's view didn't change at all: nothing is sent to him
  assert.equal(sb.messages.length, before);
  room.orders(alice.id, [{ type: 'attack', q: 2, r: 0 }, { type: 'charge' }], true);
  const all = JSON.stringify(sb.messages);
  assert.ok(!all.includes('"attack","q":2'), 'bob must not see alice’s orders');
  const bv = sb.lastStateMsg()!.blitz!;
  assert.deepEqual(bv.confirmed, [room.participantOf(alice.id)!.pid]);
  assert.deepEqual(bv.myOrders, []);
  const av = sa.lastStateMsg()!.blitz!;
  assert.equal(av.myOrders?.length, 2);
  assert.equal(av.myConfirmed, true);
  // reconnect: a fresh tab gets the queued orders and the clock back
  const again = new RecordingSink(alice);
  room.attach(again);
  const rv = again.lastStateMsg()!.blitz!;
  assert.equal(rv.myOrders?.length, 2);
  assert.equal(rv.deadline, room.row.next_tick_at);
  // after resolution: hidden attacks show the impact cell but not the shooter to bob
  room.orders(bob.id, [], true);
  room.orders(carol.id, [], true);
  const last = sb.lastStateMsg()!.blitz!.last!;
  assert.equal(last.shots.length, 1);
  assert.equal(last.shots[0].hit, true);
  assert.equal(last.shots[0].onMe, true);
  assert.equal(last.shots[0].pid, undefined);
  assert.equal(last.shots[0].from, undefined);
  // carol (a bystander) doesn't even learn the damage
  const sc = new RecordingSink(carol);
  room.attach(sc);
  const cs = sc.lastStateMsg()!.blitz!.last!.shots[0];
  assert.equal(cs.damage, undefined);
  assert.equal(cs.hit, true);
});

test('blitz room: peace still works between turns, and shots tear open talks up', () => {
  const { room, alice, bob, carol } = blitzRoom();
  room.requestStart(alice.id);
  seat(room, { alice: [0, 0], bob: [2, 0], carol: [-3, 0] });
  room.peace(alice.id, 'propose');
  room.orders(alice.id, [{ type: 'attack', q: 1, r: 0 }], true);
  room.orders(bob.id, [], true);
  room.orders(carol.id, [], true);
  assert.equal(room.openPeace(), null);
  room.peace(bob.id, 'propose');
  room.peace(alice.id, 'sign');
  room.peace(carol.id, 'sign');
  assert.equal(room.phase, 'finished');
});

test('blitz room: pause keeps the turn clock; mode is fixed once started', () => {
  const { room, clock, alice } = blitzRoom();
  room.requestStart(alice.id);
  clock.t += 10_000;
  room.pause();
  clock.t += 600_000;
  room.resume();
  assert.equal(room.row.next_tick_at, clock.t + 20_000);
  assert.throws(() => room.updateSettings({ mode: 'classic' }), /mode/);
});

test('blitz room: queued orders, confirmations, charges and the clock survive a restart', () => {
  const path = join(tmpdir(), `alliance-blitz-${process.pid}-${Date.now()}.db`);
  try {
    const env = makeEnv(path);
    const mgr = new RoomManager(env.ctx);
    const alice = env.user('alice');
    const bob = env.user('bob');
    const room = mgr.create(alice, 'Blitz restart');
    room.updateSettings({ mode: 'blitz' });
    room.join(bob);
    room.requestStart(alice.id);
    room.orders(alice.id, [{ type: 'charge' }], true);
    const deadline = room.row.next_tick_at;
    const again = new RoomManager({ ...env.ctx, store: new Store(path) });
    again.loadAll();
    const back = again.get(room.code)!;
    assert.equal(back.blitz?.turn, 1);
    assert.deepEqual(back.blitz?.orders[String(back.participantOf(alice.id)!.pid)], [{ type: 'charge' }]);
    assert.deepEqual(back.blitz?.confirmed, [back.participantOf(alice.id)!.pid]);
    assert.equal(back.row.next_tick_at, deadline);
    back.orders(bob.id, [], true);
    assert.equal(back.blitz?.turn, 2);
    assert.equal(back.blitz?.charge[String(back.participantOf(alice.id)!.pid)], 1);
  } finally {
    rmSync(path, { force: true });
  }
});

test('blitz room: no hidden stats, foreign orders or hidden shooters in any message', () => {
  const { room, alice, bob, carol } = blitzRoom();
  const sinks = [alice, bob, carol].map((u) => {
    const s = new RecordingSink(u);
    room.attach(s);
    return s;
  });
  room.requestStart(alice.id);
  seat(room, { alice: [0, 0], bob: [2, 0], carol: [-2, 0] });
  for (const p of room.players.values()) p.range = 5;
  room.refreshViews();
  const pid = (u: { id: number }) => room.participantOf(u.id)!.pid;
  room.orders(alice.id, [{ type: 'attack', q: 2, r: 0 }, { type: 'grant', q: -2, r: 0 }], true);
  room.orders(bob.id, [{ type: 'charge' }], true);
  room.orders(carol.id, [{ type: 'move', q: -2, r: 1 }, { type: 'attack', q: 0, r: 0 }], true);
  room.orders(alice.id, [{ type: 'charge' }], true);
  room.orders(bob.id, [{ type: 'attack', q: 0, r: 0 }], true);
  room.orders(carol.id, [], true);
  const HIDDEN = new Set(['hp', 'ap', 'range']);
  const walk = (v: unknown, viewer: number, path: string): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, viewer, `${path}[${i}]`));
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'me' && x) {
        assert.equal((x as { pid: number }).pid, viewer);
        continue;
      }
      assert.ok(!HIDDEN.has(k), `${k} leaked at ${path}.${k}`);
      if (k === 'shots') {
        for (const s of x as Array<{ mine: boolean; pid?: number; from?: unknown; damage?: number; onMe?: boolean }>) {
          if (!s.mine) assert.equal(s.pid, undefined, `shooter leaked at ${path}`);
          if (!s.mine && !s.onMe) assert.equal(s.damage, undefined, `damage leaked at ${path}`);
        }
      }
      if (k === 'gifts') for (const g of x as Array<{ mine: boolean; to: number | null }>) assert.ok(g.mine || g.to === viewer, `foreign gift at ${path}`);
      walk(x, viewer, `${path}.${k}`);
    }
  };
  for (const [i, u] of [alice, bob, carol].entries()) {
    const viewer = pid(u);
    for (const m of sinks[i].messages) {
      walk(m, viewer, m.type);
      if (m.type === 'update' && m.state?.blitz?.myOrders) {
        // only ever your own queue: compare against what this player sent
        for (const o of m.state.blitz.myOrders) assert.ok(u === alice || o.type !== 'grant', 'someone else’s order in myOrders');
      }
    }
  }
  // the charge is public on purpose
  assert.equal(sinks[2].lastStateMsg()!.blitz!.charges[pid(bob)], 0);
});
