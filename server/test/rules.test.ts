// Rules added in wave 3: escalating prices, equidistant spawns, start with unsaved settings,
// public attacks, peace, and Elo ratings.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionCost, nextActionCost } from '../../shared/costs.ts';
import { hexDistance, hexRing } from '../../shared/hex.ts';
import type { LogEntry } from '../../shared/protocol.ts';
import { DEFAULT_SETTINGS, type GameSettings } from '../../shared/settings.ts';
import { applyAction, applyTick, canFit, equidistantPositions, equidistantRing, type PlayerState, type Players } from '../engine.ts';
import { eloChanges, expectedScore, placements, winPoints } from '../rating.ts';
import { RoomError } from '../room.ts';
import { RoomManager } from '../rooms.ts';
import { makeEnv, RecordingSink, seededRng } from './helpers.ts';

const S: GameSettings = { ...DEFAULT_SETTINGS };

function player(pid: number, q: number, r: number, extra: Partial<PlayerState> = {}): PlayerState {
  return { pid, userId: pid, nickname: `p${pid}`, flag: 'de', joinedAt: 0, q, r, hp: 3, ap: 20, range: 3, alive: true, eliminatedAt: null, eliminatedBy: null, ...extra };
}
const world = (...list: PlayerState[]): Players => new Map(list.map((p) => [p.pid, p]));

// ---------------------------------------------------------------- escalation

test('shared cost function: escalating actions cost base × n, flat ones stay', () => {
  assert.equal(actionCost(S, 'attack', 0), 1);
  assert.equal(actionCost(S, 'attack', 1), 2);
  assert.equal(actionCost(S, 'attack', 2), 3);
  assert.equal(nextActionCost(S, 'attack', 0), 2);
  assert.equal(actionCost(S, 'grant', 3), 4);
  assert.equal(actionCost(S, 'move', 5), 1);
  assert.equal(actionCost(S, 'upgrade', 5), 2);
  const flat = { ...S, escalateAttack: 'off' as const, costAttack: 3 };
  assert.equal(actionCost(flat, 'attack', 4), 3);
  const steep = { ...S, escalateUpgrade: 'on' as const };
  assert.equal(actionCost(steep, 'upgrade', 2), 6);
});

test('attacks and gifts escalate within one AP period and reset on the tick', () => {
  const w = world(player(1, 0, 0, { hp: 10 }), player(2, 1, 0, { hp: 10 }));
  const me = w.get(1)!;
  for (const expected of [1, 2, 3]) {
    const before = me.ap;
    assert.equal(applyAction(w, S, 1, { type: 'attack', target: 2 }, 1).ok, true);
    assert.equal(before - me.ap, expected);
  }
  assert.equal(me.ap, 14);
  // Gifts have their own counter.
  assert.equal(applyAction(w, S, 1, { type: 'grant', target: 2 }, 1).ok, true);
  assert.equal(me.ap, 13);
  // Moves stay flat.
  applyAction(w, S, 1, { type: 'move', q: -1, r: 0 }, 1);
  applyAction(w, S, 1, { type: 'move', q: 0, r: 0 }, 1);
  assert.equal(me.ap, 11);
  assert.deepEqual(me.used, { move: 2, attack: 3, grant: 1, upgrade: 0 });
  // Not enough for the 4th attack (4 AP) once AP is low: the error names the real price.
  me.ap = 3;
  const res = applyAction(w, S, 1, { type: 'attack', target: 2 }, 1);
  assert.deepEqual(res, { ok: false, error: 'Not enough AP (need 4, you have 3)' });
  assert.equal(me.used?.attack, 3, 'a refused action does not count');
  applyTick(w, S, 2);
  assert.deepEqual(me.used, { move: 0, attack: 0, grant: 0, upgrade: 0 });
  const before = me.ap;
  applyAction(w, S, 1, { type: 'attack', target: 2 }, 3);
  assert.equal(before - me.ap, 1);
});

test('the room view exposes your own counters and they survive a reload', () => {
  const env = makeEnv();
  const mgr = new RoomManager(env.ctx);
  const alice = env.user('alice');
  const bob = env.user('bob');
  const room = mgr.create(alice, 'Prices');
  room.join(bob);
  room.requestStart(alice.id);
  Object.assign(room.playerByNickname('alice')!, { q: 0, r: 0, ap: 10 });
  Object.assign(room.playerByNickname('bob')!, { q: 1, r: 0, hp: 9 });
  room.act(null, alice.id, 1, { type: 'attack', target: room.playerByNickname('bob')!.pid });
  room.act(null, alice.id, 2, { type: 'attack', target: room.playerByNickname('bob')!.pid });
  const sink = new RecordingSink(alice);
  room.attach(sink);
  assert.equal(sink.lastStateMsg()?.me?.used?.attack, 2);
  assert.equal(room.playerByNickname('alice')!.ap, 7);
  const mgr2 = new RoomManager(env.ctx);
  mgr2.loadAll();
  assert.equal(mgr2.get(room.code)!.playerByNickname('alice')!.used?.attack, 2);
});

// ---------------------------------------------------------------- spawns

test('hexRing walks all 6k cells at distance k', () => {
  for (const k of [1, 2, 5]) {
    const ring = hexRing(k);
    assert.equal(ring.length, 6 * k);
    assert.equal(new Set(ring.map((c) => `${c.q},${c.r}`)).size, 6 * k);
    for (const c of ring) assert.equal(hexDistance(c, { q: 0, r: 0 }), k);
  }
});

test('equidistant spawns: same distance from the centre, spread out, refused when they cannot fit', () => {
  const rng = seededRng(7);
  for (const n of [2, 3, 5, 10]) {
    const spots = equidistantPositions(n, 6, 3, rng)!;
    assert.ok(spots, `${n} players fit`);
    const k = hexDistance(spots[0], { q: 0, r: 0 });
    assert.ok(k >= 1 && k <= 6);
    for (const s of spots) assert.equal(hexDistance(s, { q: 0, r: 0 }), k);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert.ok(hexDistance(spots[i], spots[j]) >= 3);
  }
  assert.equal(equidistantRing(2, 6, 3), 4, 'two thirds of the way out');
  // 12 players 5 apart don't fit on a radius-4 ring.
  assert.equal(equidistantRing(12, 4, 5), null);
  assert.equal(canFit(12, 4, 5, rng, 'equidistant'), false);
});

test('equidistant mode in a room: validated on save, everyone on one ring at start', () => {
  const env = makeEnv();
  const mgr = new RoomManager(env.ctx);
  const [alice, bob, carol, dave] = ['alice', 'bob', 'carol', 'dave'].map((n) => env.user(n));
  const room = mgr.create(alice, 'Ring');
  assert.throws(() => room.updateSettingsAsCreator(alice.id, { spawnMode: 'equidistant', gridRadius: 3, maxPlayers: 12 }), /evenly around a ring/);
  room.updateSettingsAsCreator(alice.id, { spawnMode: 'equidistant', maxPlayers: 4 });
  for (const u of [bob, carol, dave]) room.join(u);
  room.requestStart(alice.id);
  const dists = [...room.players.values()].map((p) => hexDistance({ q: p.q!, r: p.r! }, { q: 0, r: 0 }));
  assert.equal(new Set(dists).size, 1);
});

// ---------------------------------------------------------------- start with unsaved settings

test('Start saves the unsaved settings first, and refuses to start when they are invalid', () => {
  const env = makeEnv();
  const mgr = new RoomManager(env.ctx);
  const alice = env.user('alice');
  const bob = env.user('bob');
  const room = mgr.create(alice, 'Unsaved');
  room.join(bob);
  assert.throws(() => room.requestStart(bob.id, { startHp: 9 }), /Only the room creator/);
  assert.throws(() => room.requestStart(alice.id, { startHp: 0 }), RoomError);
  assert.equal(room.phase, 'lobby', 'invalid settings: no start');
  assert.equal(room.settings.startHp, 3);
  room.requestStart(alice.id, { startHp: 9, costAttack: 2 });
  assert.equal(room.phase, 'running');
  assert.equal(room.settings.startHp, 9);
  for (const p of room.players.values()) assert.equal(p.hp, 9);
});

// ---------------------------------------------------------------- reveal setting

function entriesOf(sink: RecordingSink): LogEntry[] {
  return sink.updates().flatMap((u) => u.entries ?? []);
}

function fight(reveal: GameSettings['revealActions']) {
  const env = makeEnv();
  const mgr = new RoomManager(env.ctx);
  const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((n) => env.user(n));
  const room = mgr.create(alice, 'Reveal');
  room.join(bob);
  room.join(carol);
  room.updateSettingsAsCreator(alice.id, { revealActions: reveal });
  room.requestStart(alice.id);
  const sinks = { alice: new RecordingSink(alice), bob: new RecordingSink(bob), carol: new RecordingSink(carol) };
  for (const s of Object.values(sinks)) room.attach(s);
  Object.assign(room.playerByNickname('alice')!, { q: 0, r: 0, ap: 10 });
  Object.assign(room.playerByNickname('bob')!, { q: 1, r: 0, hp: 9 });
  Object.assign(room.playerByNickname('carol')!, { q: -1, r: 0 });
  const pid = (n: string) => room.playerByNickname(n)!.pid;
  for (const s of Object.values(sinks)) s.messages = [];
  room.act(null, alice.id, 1, { type: 'attack', target: pid('bob') });
  room.act(null, alice.id, 2, { type: 'grant', target: pid('carol') });
  return { sinks, pid };
}

test('revealActions hidden: victims and receivers never learn who; bystanders see nothing', () => {
  const { sinks } = fight('hidden');
  const bobHit = entriesOf(sinks.bob).find((e) => e.type === 'hit')!;
  assert.equal(bobHit.actor, undefined);
  assert.equal(entriesOf(sinks.carol).find((e) => e.type === 'granted')!.actor, undefined);
  assert.equal(entriesOf(sinks.carol).some((e) => e.type === 'attack'), false);
  assert.equal(entriesOf(sinks.bob).some((e) => e.type === 'grant'), false);
});

test('revealActions attacks: everyone sees who attacked whom, gifts stay anonymous', () => {
  const { sinks, pid } = fight('attacks');
  assert.equal(entriesOf(sinks.bob).find((e) => e.type === 'hit')!.actor, pid('alice'));
  const seen = entriesOf(sinks.carol).find((e) => e.type === 'attack')!;
  assert.deepEqual([seen.actor, seen.target], [pid('alice'), pid('bob')]);
  assert.equal(entriesOf(sinks.carol).find((e) => e.type === 'granted')!.actor, undefined);
  assert.equal(entriesOf(sinks.bob).some((e) => e.type === 'grant'), false);
});

test('revealActions all: gifts name the giver too', () => {
  const { sinks, pid } = fight('all');
  assert.equal(entriesOf(sinks.carol).find((e) => e.type === 'granted')!.actor, pid('alice'));
  const seen = entriesOf(sinks.bob).find((e) => e.type === 'grant')!;
  assert.deepEqual([seen.actor, seen.target], [pid('alice'), pid('carol')]);
});

// ---------------------------------------------------------------- peace

function threeAlive(testMode = false) {
  const env = makeEnv();
  env.ctx.testMode = testMode;
  const mgr = new RoomManager(env.ctx);
  const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((n) => env.user(n));
  const room = mgr.create(alice, 'Peace');
  room.join(bob);
  room.join(carol);
  room.requestStart(alice.id);
  Object.assign(room.playerByNickname('alice')!, { q: 0, r: 0, ap: 10 });
  Object.assign(room.playerByNickname('bob')!, { q: 1, r: 0, ap: 10 });
  Object.assign(room.playerByNickname('carol')!, { q: -1, r: 0, ap: 10 });
  return { env, mgr, room, alice, bob, carol, pid: (n: string) => room.playerByNickname(n)!.pid };
}

test('peace passes when every alive player signs: shared victory, 1/n win points each', () => {
  const { env, room, alice, bob, carol, pid } = threeAlive();
  const sink = new RecordingSink(bob);
  room.attach(sink);
  room.peace(alice.id, 'propose');
  assert.throws(() => room.peace(bob.id, 'propose'), /already open/);
  assert.throws(() => room.peace(alice.id, 'sign'), /already signed/);
  room.peace(bob.id, 'sign');
  assert.equal(room.phase, 'running');
  assert.deepEqual(sink.lastStateMsg()?.peace?.signers, [pid('alice'), pid('bob')]);
  room.peace(carol.id, 'sign');
  assert.equal(room.phase, 'finished');
  assert.equal(room.row.winner_pid, null);
  const view = sink.lastStateMsg()!;
  assert.equal(view.peace?.signed, true);
  assert.deepEqual([...view.peace!.signers].sort(), [pid('alice'), pid('bob'), pid('carol')].sort());
  const finish = entriesOf(sink).find((e) => e.type === 'finish')!;
  assert.deepEqual([...finish.pids!].sort(), [pid('alice'), pid('bob'), pid('carol')].sort());
  // Rated: equal ratings and a three-way tie leave ratings unchanged; 1/3 win point each.
  assert.equal(view.ratings?.length, 3);
  for (const r of view.ratings!) {
    assert.equal(r.place, 1);
    assert.equal(r.delta, 0);
    assert.ok(Math.abs(r.winPoints - 1 / 3) < 1e-9);
  }
  assert.equal(env.store.ratingStats(alice.id).ratedGames, 1);
  assert.equal(env.store.ratingStats(alice.id).winPoints, 0.33);
  assert.throws(() => room.peace(alice.id, 'propose'), /over/);
});

test('an attack or a decline cancels an open peace proposal, with a log line for everyone', () => {
  const { room, alice, bob, carol, pid } = threeAlive();
  const sink = new RecordingSink(carol);
  room.attach(sink);
  room.peace(alice.id, 'propose');
  room.peace(carol.id, 'sign');
  room.act(null, bob.id, 1, { type: 'attack', target: pid('alice') });
  assert.equal(room.openPeace(), null);
  const cancel = entriesOf(sink).find((e) => e.type === 'peace-cancel')!;
  assert.equal(cancel.actor, undefined, 'the cancel line never names the attacker');
  room.peace(bob.id, 'propose');
  room.peace(alice.id, 'decline');
  assert.equal(room.openPeace(), null);
  assert.equal(entriesOf(sink).find((e) => e.type === 'peace-decline')!.actor, pid('alice'));
  assert.throws(() => room.peace(alice.id, 'sign'), /no peace proposal/);
  assert.equal(room.phase, 'running');
});

test('eliminated players cannot sign; peace completes when the last holdout is eliminated', () => {
  const { room, alice, bob, carol, pid } = threeAlive();
  room.peace(alice.id, 'propose');
  room.peace(bob.id, 'sign');
  room.adjustPlayer(pid('carol'), { hp: 0 });
  assert.equal(room.phase, 'finished');
  assert.deepEqual(room.ratings?.find((r) => r.pid === pid('carol'))?.place, 3);
  assert.throws(() => room.peace(carol.id, 'sign'), RoomError);
});

// ---------------------------------------------------------------- ratings

test('Elo math: pairwise, K scaled by 1/(n-1), ties are draws, zero-sum', () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
  assert.ok(Math.abs(expectedScore(1200, 1000) - 0.7597) < 1e-3);
  const r = new Map([
    [1, 1000],
    [2, 1000],
  ]);
  const duel = eloChanges([{ pid: 1, place: 1 }, { pid: 2, place: 2 }], r);
  assert.equal(duel.get(1), 16);
  assert.equal(duel.get(2), -16);
  const four = new Map([1, 2, 3, 4].map((p) => [p, 1000]));
  const d = eloChanges(
    [
      { pid: 1, place: 1 },
      { pid: 2, place: 2 },
      { pid: 3, place: 3 },
      { pid: 4, place: 4 },
    ],
    four,
  );
  // Winner beats 3 → 32/3 × (3 × 0.5) = 16; second: 32/3 × (2 − 1.5) = 5.33…
  assert.ok(Math.abs(d.get(1)! - 16) < 1e-9);
  assert.ok(Math.abs(d.get(2)! - 16 / 3) < 1e-9);
  assert.ok(Math.abs([...d.values()].reduce((a, b) => a + b, 0)) < 1e-9);
  const tie = eloChanges([{ pid: 1, place: 1 }, { pid: 2, place: 1 }], r);
  assert.equal(tie.get(1), 0);
  // An upset moves more than an expected win.
  const uneven = new Map([
    [1, 1200],
    [2, 1000],
  ]);
  const upset = eloChanges([{ pid: 2, place: 1 }, { pid: 1, place: 2 }], uneven);
  assert.ok(upset.get(2)! > 16);
});

test('placements: winner first, later elimination = better place, simultaneous = tie', () => {
  const ps = [
    player(1, 0, 0),
    player(2, 0, 0, { alive: false, eliminatedAt: 50 }),
    player(3, 0, 0, { alive: false, eliminatedAt: 10 }),
    player(4, 0, 0, { alive: false, eliminatedAt: 10 }),
    player(5, 0, 0, { alive: false, eliminatedAt: 5 }),
  ];
  assert.deepEqual(
    placements(ps).map((s) => [s.pid, s.place]),
    [
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 3],
      [5, 5],
    ],
  );
  const wp = winPoints(placements(ps));
  assert.equal(wp.get(1), 1);
  assert.equal(wp.get(2), 0);
});

test('a won game updates ratings once; test-mode rooms never touch ratings', () => {
  const { env, room, alice, bob, carol, pid } = threeAlive();
  room.adjustPlayer(pid('carol'), { hp: 0 });
  env.clock.t += 1000;
  room.adjustPlayer(pid('bob'), { hp: 0 });
  assert.equal(room.phase, 'finished');
  const a = env.store.ratingStats(alice.id);
  const b = env.store.ratingStats(bob.id);
  const c = env.store.ratingStats(carol.id);
  assert.equal(a.rating, 1016);
  assert.equal(b.rating, 1000);
  assert.equal(c.rating, 984);
  assert.deepEqual([a.ratedGames, a.ratedWins, a.winPoints], [1, 1, 1]);
  assert.deepEqual(env.store.leaderboard().map((e) => [e.rank, e.username]), [
    [1, 'alice'],
    [2, 'bob'],
    [3, 'carol'],
  ]);
  // Rating changes are on the end screen.
  const sink = new RecordingSink(bob);
  room.attach(sink);
  assert.deepEqual(sink.lastStateMsg()?.ratings?.map((r) => r.delta), [16, 0, -16]);

  const t = threeAlive(true);
  assert.equal(t.room.row.rated, 0);
  t.room.adjustPlayer(t.pid('carol'), { hp: 0 });
  t.room.adjustPlayer(t.pid('bob'), { hp: 0 });
  assert.equal(t.room.phase, 'finished');
  assert.equal(t.env.store.ratingStats(t.alice.id).ratedGames, 0);
  assert.equal(t.env.store.ratingStats(t.alice.id).rating, 1000);
  const ts = new RecordingSink(t.alice);
  t.room.attach(ts);
  assert.equal(ts.lastStateMsg()?.rated, false);
  assert.equal(ts.lastStateMsg()?.ratings, null);
});
