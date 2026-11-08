// Information-hiding tests: replays a game and inspects every message each browser
// received. Other players' HP, AP and range must never appear before the game is over,
// victims must never learn who hit them, and receivers must never learn who gave them AP.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerMessage } from '../../shared/protocol.ts';
import { RoomManager } from '../rooms.ts';
import { makeEnv, RecordingSink } from './helpers.ts';

const HIDDEN = new Set(['hp', 'ap', 'range']);

/** Walks a message and fails if a hidden stat appears anywhere except `me` (own) or `reveal`. */
function assertNoForeignStats(msg: unknown, viewerPid: number | null, allowReveal: boolean, path = ''): void {
  if (Array.isArray(msg)) {
    msg.forEach((v, i) => assertNoForeignStats(v, viewerPid, allowReveal, `${path}[${i}]`));
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  const obj = msg as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const here = path ? `${path}.${key}` : key;
    if (key === 'reveal' && value !== null) {
      assert.ok(allowReveal, `reveal sent before the game ended at ${here}`);
      continue;
    }
    if (key === 'me' && value !== null) {
      assert.equal((value as { pid: number }).pid, viewerPid, `someone else's stats in ${here}`);
      continue;
    }
    if (HIDDEN.has(key)) assert.fail(`hidden stat "${key}" leaked at ${here}: ${JSON.stringify(obj)}`);
    assertNoForeignStats(value, viewerPid, allowReveal, here);
  }
}

test('hidden stats and attackers never leak', () => {
  const env = makeEnv();
  const mgr = new RoomManager(env.ctx);
  const [alice, bob, carol, dave] = ['alice', 'bob', 'carol', 'dave'].map((n) => env.user(n));
  const room = mgr.create(alice, 'Leak test');
  room.join(bob);
  room.join(carol);

  const sinks = {
    alice: new RecordingSink(alice),
    alice2: new RecordingSink(alice), // second tab of the same player
    bob: new RecordingSink(bob),
    carol: new RecordingSink(carol),
    dave: new RecordingSink(dave), // looked at the lobby, never joined
  };
  for (const s of Object.values(sinks)) room.attach(s);

  room.requestStart(alice.id);
  const pid = (n: string) => room.playerByNickname(n)!.pid;
  const set = (n: string, q: number, r: number, ap: number) => {
    const p = room.playerByNickname(n)!;
    Object.assign(p, { q, r, ap });
  };
  // Alice in the middle, Bob and Carol both in her range and in each other's range.
  set('alice', 0, 0, 20);
  set('bob', 1, 0, 20);
  set('carol', 0, 1, 20);
  // Re-sync every tab after editing state behind the room's back.
  for (const s of Object.values(sinks)) room.attach(s);

  const aliceCountBefore = sinks.alice.messages.length;
  assert.ok(room.act(sinks.bob, bob.id, 1, { type: 'upgrade' }).ok);
  // Nothing visible changed for Alice, so she must not even get a message.
  assert.equal(sinks.alice.messages.length, aliceCountBefore, 'hidden action produced a message for a bystander');

  assert.ok(room.act(sinks.bob, bob.id, 2, { type: 'attack', target: pid('alice') }).ok);
  assert.ok(room.act(sinks.carol, carol.id, 3, { type: 'grant', target: pid('alice') }).ok);
  assert.ok(room.act(sinks.carol, carol.id, 4, { type: 'attack', target: pid('bob') }).ok);
  assert.ok(room.act(sinks.alice, alice.id, 5, { type: 'move', q: -1, r: 0 }).ok);
  room.tick();
  assert.ok(room.act(sinks.bob, bob.id, 6, { type: 'attack', target: pid('carol') }).ok);
  assert.ok(room.act(sinks.bob, bob.id, 7, { type: 'attack', target: pid('carol') }).ok);
  assert.ok(room.act(sinks.bob, bob.id, 8, { type: 'attack', target: pid('carol') }).ok); // carol eliminated by bob
  assert.equal(room.playerByNickname('carol')!.alive, false);

  // ---- before the game ends ----
  const viewers: Array<[keyof typeof sinks, number | null]> = [
    ['alice', pid('alice')],
    ['alice2', pid('alice')],
    ['bob', pid('bob')],
    ['carol', pid('carol')],
    ['dave', null],
  ];
  for (const [name, viewerPid] of viewers) {
    for (const msg of sinks[name].messages) assertNoForeignStats(msg, viewerPid, false);
  }

  const entriesOf = (s: RecordingSink) => s.updates().flatMap((m) => m.entries ?? []);
  const aliceEntries = entriesOf(sinks.alice);
  const hit = aliceEntries.find((e) => e.type === 'hit');
  const granted = aliceEntries.find((e) => e.type === 'granted');
  assert.ok(hit, 'alice should see that she was hit');
  assert.ok(granted, 'alice should see that she received AP');
  assert.equal(hit!.actor, undefined, 'victim learned the attacker');
  assert.equal(granted!.actor, undefined, 'receiver learned the giver');
  // Alice never hears about fights she was not part of, nor about Bob's upgrade.
  assert.ok(!aliceEntries.some((e) => e.type === 'attack' || e.type === 'upgrade' || e.type === 'grant'));
  // ...but everyone sees the elimination and who dealt the final hit.
  const elim = aliceEntries.find((e) => e.type === 'eliminate');
  assert.deepEqual([elim?.target, elim?.actor], [pid('carol'), pid('bob')]);
  // The second tab of the same player got the same log.
  assert.deepEqual(entriesOf(sinks.alice2).map((e) => e.id), aliceEntries.map((e) => e.id));

  // Bob sees his own attack on Carol (with target) but not who hit him.
  const bobEntries = entriesOf(sinks.bob);
  assert.ok(bobEntries.some((e) => e.type === 'attack' && e.target === pid('carol')));
  assert.ok(bobEntries.filter((e) => e.type === 'hit').every((e) => e.actor === undefined));

  // Dave (not in the game) sees neither players nor events once the game runs.
  const daveLast = sinks.dave.lastStateMsg()!;
  assert.equal(daveLast.phase, 'running');
  assert.equal(daveLast.players.length, 0);
  assert.equal(daveLast.me, null);
  assert.equal(entriesOf(sinks.dave).filter((e) => e.type !== 'start').length, 0);

  // Positions are public: Alice's last state shows Bob where he is.
  const aliceState = sinks.alice.lastStateMsg()!;
  const bobPub = aliceState.players.find((p) => p.pid === pid('bob'))!;
  assert.deepEqual([bobPub.q, bobPub.r], [1, 0]);
  assert.equal(aliceState.me!.hp, 2);

  // ---- finish the game: full reveal ----
  room.playerByNickname('alice')!.ap = 10;
  room.playerByNickname('alice')!.range = 5;
  while (room.phase !== 'finished') {
    assert.ok(room.act(sinks.alice, alice.id, 100, { type: 'attack', target: pid('bob') }).ok);
  }
  const finalState = sinks.alice.lastStateMsg()!;
  assert.equal(finalState.phase, 'finished');
  assert.equal(finalState.winnerPid, pid('alice'));
  assert.ok(finalState.reveal);
  assert.equal(finalState.reveal!.players.length, 3);
  const history = finalState.reveal!.history;
  assert.ok(history.some((e) => e.type === 'attack' && e.actor === pid('bob') && e.target === pid('alice')));
  assert.ok(history.some((e) => e.type === 'grant' && e.actor === pid('carol') && e.target === pid('alice')));
  assert.ok(history.some((e) => e.type === 'upgrade' && e.actor === pid('bob')));
  const bobStats = finalState.reveal!.players.find((p) => p.pid === pid('bob'))!;
  assert.equal(bobStats.kills, 1);
  assert.equal(bobStats.upgrades, 1);
  // Outsiders don't get the reveal either.
  assert.equal(sinks.dave.lastStateMsg()!.reveal, null);
});

test('failed actions are reported only to the sender', () => {
  const env = makeEnv();
  const mgr = new RoomManager(env.ctx);
  const alice = env.user('alice');
  const bob = env.user('bob');
  const room = mgr.create(alice, 'x');
  room.join(bob);
  const sa = new RecordingSink(alice);
  const sb = new RecordingSink(bob);
  room.attach(sa);
  room.attach(sb);
  room.requestStart(alice.id);
  const nb = sb.messages.length;
  const res = room.act(sa, alice.id, 7, { type: 'upgrade' });
  assert.equal(res.ok, false);
  const last = sa.messages[sa.messages.length - 1] as Extract<ServerMessage, { type: 'update' }>;
  assert.deepEqual(last.result, { id: 7, ok: false, error: 'Not enough AP (need 2, you have 0)' });
  assert.equal(sb.messages.length, nb);
});
