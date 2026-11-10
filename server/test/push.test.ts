// Push notifications (server/push.ts): VAPID keys survive restarts, subscriptions are stored
// per device, chat is batched per room, visible viewers get nothing, secrets stay secret, and
// dead subscriptions are dropped.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import type { PushPayload, PushSubscriptionJson } from '../../shared/push.ts';
import { Store } from '../db.ts';
import { CHAT_WINDOW_MS, loadVapidKeys, PushService, type SendOptions } from '../push.ts';
import { RoomManager } from '../rooms.ts';
import { makeEnv, RecordingSink } from './helpers.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const KEYS = { publicKey: 'BPub', privateKey: 'priv' };

function sub(n: number | string, host = 'fcm.googleapis.com'): PushSubscriptionJson {
  return { endpoint: `https://${host}/fcm/send/device-${n}`, keys: { p256dh: `BKey${n}`, auth: `auth${n}` } };
}

interface Sent {
  endpoint: string;
  payload: PushPayload;
  opts: SendOptions;
}

function setup(fail?: (endpoint: string) => number | null) {
  const env = makeEnv();
  const sent: Sent[] = [];
  let mgr: RoomManager | undefined;
  const push = new PushService({
    store: env.store,
    keys: KEYS,
    now: () => env.clock.t,
    log: () => undefined,
    room: (code) => mgr?.get(code),
    send: async (s, body, opts) => {
      const status = fail?.(s.endpoint) ?? null;
      if (status) throw Object.assign(new Error(`status ${status}`), { statusCode: status });
      sent.push({ endpoint: s.endpoint, payload: JSON.parse(body) as PushPayload, opts });
    },
  });
  env.ctx.notify = push;
  mgr = new RoomManager(env.ctx);
  const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((n) => env.user(n));
  const room = mgr.create(alice, 'Пятничное предательство');
  room.join(bob);
  room.join(carol);
  push.subscribe(alice.id, sub('a'), 'en', {});
  push.subscribe(bob.id, sub('b'), 'ru', {});
  push.subscribe(carol.id, sub('c'), 'en', {});
  const to = (u: { id: number }) => sent.filter((s) => s.endpoint.endsWith(`device-${u.id === alice.id ? 'a' : u.id === bob.id ? 'b' : 'c'}`));
  return { ...env, push, mgr, room, alice, bob, carol, sent, to };
}

test('VAPID keys are generated once, stored in the db and reused after a restart; env overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-'));
  dirs.push(dir);
  const path = join(dir, 'game.db');
  let made = 0;
  const gen = () => {
    made++;
    return { publicKey: `pub${made}`, privateKey: `priv${made}` };
  };
  const s1 = new Store(path);
  const first = loadVapidKeys(s1, {}, gen);
  assert.equal(first.source, 'new');
  assert.equal(made, 1);
  s1.close();

  const s2 = new Store(path);
  const second = loadVapidKeys(s2, {}, gen);
  assert.equal(second.source, 'db');
  assert.equal(made, 1, 'no new pair after a restart');
  assert.equal(second.publicKey, first.publicKey);
  assert.equal(second.privateKey, first.privateKey);
  const env = loadVapidKeys(s2, { VAPID_PUBLIC: 'envPub', VAPID_PRIVATE: 'envPriv' }, gen);
  assert.deepEqual([env.source, env.publicKey, env.privateKey], ['env', 'envPub', 'envPriv']);
  s2.close();
});

test('subscriptions: one row per device, re-subscribing updates it, foreign hosts refused, unsubscribe', () => {
  const { push, alice, bob } = setup();
  push.subscribe(alice.id, sub('a2'), 'ru', { chat: false });
  assert.equal(push.subscriptionsOf(alice.id).length, 2);
  const second = push.subscriptionsOf(alice.id).find((s) => s.endpoint.endsWith('a2'))!;
  assert.equal(second.lang, 'ru');
  assert.equal(second.prefs.chat, false);
  assert.equal(second.prefs.attacks, true);

  // Same browser, now logged in as bob: the device moves to bob.
  push.subscribe(bob.id, sub('a2'), 'en', {});
  assert.equal(push.subscriptionsOf(alice.id).length, 1);
  assert.equal(push.subscriptionsOf(bob.id).length, 2);

  assert.throws(() => push.subscribe(alice.id, sub('x', 'evil.example.com'), 'en', {}), /Unknown push service/);
  assert.throws(() => push.subscribe(alice.id, { endpoint: 'http://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } }, 'en', {}), /Unknown push service/);
  assert.throws(() => push.subscribe(alice.id, { endpoint: 'https://fcm.googleapis.com/x' }, 'en', {}), /Invalid subscription/);

  assert.equal(push.unsubscribe(alice.id, sub('b').endpoint), false, "can't remove someone else's device");
  assert.equal(push.unsubscribe(bob.id, sub('a2').endpoint), true);
  assert.equal(push.subscriptionsOf(bob.id).length, 1);

  for (let i = 0; i < 14; i++) push.subscribe(alice.id, sub(`many${i}`), 'en', {});
  assert.equal(push.subscriptionsOf(alice.id).length, 10, 'only the newest 10 devices are kept');
});

test('chat: first message at once, more within the window become one "N new messages" push', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { push, room, alice, bob, to } = setup();
    room.chat(alice.id, null, 'first');
    await push.settle();
    assert.equal(to(bob).length, 1);
    assert.deepEqual(to(bob)[0].payload.params, { from: 'alice', where: 'all', text: 'first' });
    assert.equal(to(bob)[0].payload.lang, 'ru');
    assert.equal(to(bob)[0].payload.tag, `chat:${room.code}`);
    assert.equal(to(bob)[0].payload.url, `/r/${room.code}`);
    assert.equal(to(alice).length, 0, 'never to the sender');

    room.chat(alice.id, null, 'second');
    room.chat(alice.id, null, 'third');
    await push.settle();
    assert.equal(to(bob).length, 1, 'batched while the window is open');

    mock.timers.tick(CHAT_WINDOW_MS);
    await push.settle();
    assert.equal(to(bob).length, 2);
    assert.equal(to(bob)[1].payload.kind, 'chatMany');
    assert.equal(to(bob)[1].payload.params.n, 3);
    assert.equal(to(bob)[1].payload.tag, `chat:${room.code}`, 'replaces the first notification');

    // A quiet window closes the batch; the next message is pushed at once again.
    mock.timers.tick(CHAT_WINDOW_MS);
    room.chat(alice.id, null, 'later');
    await push.settle();
    assert.equal(to(bob).length, 3);
    assert.equal(to(bob)[2].payload.kind, 'chat');
    push.close();
  } finally {
    mock.timers.reset();
  }
});

test('a private message reaches only its reader', async () => {
  const { push, room, alice, bob, carol, to } = setup();
  const bobPid = room.participantOf(bob.id)!.pid;
  room.chat(alice.id, bobPid, 'psst');
  await push.settle();
  assert.equal(to(bob)[0].payload.params.where, 'dm');
  assert.equal(to(carol).length, 0);
  push.close();
});

test('nothing is pushed to a user who has the room open and visible; hidden tabs still get it', async () => {
  const { push, room, alice, bob, carol, to } = setup();
  const bobTab = new RecordingSink(bob);
  room.attach(bobTab);
  const carolTab = new RecordingSink(carol);
  carolTab.visible = false;
  room.attach(carolTab);
  room.chat(alice.id, null, 'hi');
  await push.settle();
  assert.equal(to(bob).length, 0, 'visible tab: in-app sound instead');
  assert.equal(to(carol).length, 1, 'hidden tab: system notification');

  // notify() (the API for other engines) checks presence by room code too.
  push.notify(bob.id, 'blitzTurn', { room: room.code, roomName: room.row.name, turn: 2 });
  bobTab.visible = false;
  push.notify(bob.id, 'blitzTurn', { room: room.code, roomName: room.row.name, turn: 3 });
  await push.settle();
  assert.equal(to(bob).length, 1);
  assert.deepEqual(to(bob)[0].payload.params, { turn: 3 });
  push.close();
});

test('game events: start, AP tick, a secret hit names nobody, categories switch kinds off', async () => {
  const { push, room, alice, bob, carol, to, sent } = setup();
  push.subscribe(carol.id, sub('c'), 'en', { ap: false });
  room.startGame();
  await push.settle();
  assert.deepEqual(
    sent.map((s) => s.payload.kind),
    ['start', 'start', 'start'],
  );
  sent.length = 0;

  room.tick();
  await push.settle();
  assert.deepEqual(to(alice).map((s) => [s.payload.kind, s.payload.params.n]), [['tick', 1]]);
  assert.equal(to(carol).length, 0, 'carol switched AP notifications off');
  sent.length = 0;

  const a = room.participantOf(alice.id)!;
  a.ap = 10;
  a.range = 100;
  const bobPid = room.participantOf(bob.id)!.pid;
  const res = room.act(null, alice.id, 1, { type: 'attack', target: bobPid });
  assert.equal(res.ok, true);
  await push.settle();
  assert.equal(to(bob).length, 1);
  assert.equal(to(bob)[0].payload.kind, 'hit');
  assert.equal(to(bob)[0].payload.params.by, undefined, 'hidden attacks never name the attacker');
  assert.equal(to(carol).length, 0, 'bystanders learn nothing');
  push.close();
});

test('expired subscriptions (404/410) are removed; other failures keep them', async () => {
  const { push, alice, bob } = setup((endpoint) => (endpoint.endsWith('device-b') ? 410 : endpoint.endsWith('device-a') ? 500 : null));
  push.test(alice.id);
  push.test(bob.id);
  await push.settle();
  assert.equal(push.subscriptionsOf(bob.id).length, 0);
  assert.equal(push.subscriptionsOf(alice.id).length, 1);
  push.close();
});

test('lobby: one "starts in 5 minutes" reminder per deadline', async () => {
  const { push, room, clock, sent } = setup();
  clock.t = room.row.lobby_ends_at! - 4.5 * 60_000;
  push.remindLobbies([room]);
  push.remindLobbies([room]);
  await push.settle();
  assert.deepEqual(sent.map((s) => [s.payload.kind, s.payload.params.min]), [
    ['soon', 5],
    ['soon', 5],
    ['soon', 5],
  ]);
  push.close();
});

// ---------------------------------------------------------------- blitz turns

function blitzSetup() {
  const env = setup();
  env.room.updateSettings({ mode: 'blitz', blitzTurnSec: '30', escalateAttack: 'off' });
  return env;
}

const kinds = (list: Sent[]) => list.map((s) => s.payload.kind);

test('blitz: turn 1 is the start push; later turns are announced once to every alive player', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { push, room, alice, bob, carol, sent, to } = blitzSetup();
    room.startGame();
    await push.settle();
    assert.deepEqual(kinds(sent), ['start', 'start', 'start'], 'no separate "turn 1" push');
    sent.length = 0;
    // everybody confirms → early end → turn 2 announced
    room.orders(alice.id, [], true);
    room.orders(bob.id, [], true);
    room.orders(carol.id, [], true);
    await push.settle();
    assert.equal(room.blitz?.turn, 2);
    assert.deepEqual(kinds(sent), ['blitzTurn', 'blitzTurn', 'blitzTurn']);
    assert.deepEqual(to(bob)[0].payload.params, { turn: 2 });
    assert.equal(to(bob)[0].payload.lang, 'ru');
    sent.length = 0;
    // more commits in the same turn send nothing new
    room.orders(alice.id, [{ type: 'charge' }], false);
    room.refreshViews();
    await push.settle();
    assert.deepEqual(kinds(sent), []);
    push.close();
  } finally {
    mock.timers.reset();
  }
});

test('blitz: "10 s left" goes only to alive players who have not confirmed, once per turn', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { push, room, clock, alice, bob, sent, to } = blitzSetup();
    room.startGame();
    await push.settle();
    sent.length = 0;
    room.orders(alice.id, [], true);
    clock.t += 19_000;
    mock.timers.tick(19_000);
    await push.settle();
    assert.deepEqual(kinds(sent), [], 'not yet');
    clock.t += 1_000;
    mock.timers.tick(1_000);
    await push.settle();
    assert.deepEqual(kinds(sent), ['blitzHurry', 'blitzHurry']);
    assert.equal(to(alice).length, 0, 'alice already confirmed');
    assert.equal(to(bob)[0].opts.TTL, 10);
    sent.length = 0;
    // a confirm after the hurry doesn't re-arm it
    room.orders(bob.id, [], true);
    clock.t += 5_000;
    mock.timers.tick(5_000);
    await push.settle();
    assert.deepEqual(kinds(sent), []);
    push.close();
  } finally {
    mock.timers.reset();
  }
});

test('blitz: early end, pause and deletion cancel the hurry; resume re-arms it on the new deadline', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { push, room, clock, mgr, alice, bob, carol, sent } = blitzSetup();
    room.startGame();
    await push.settle();
    sent.length = 0;

    // early end: the turn-1 hurry never fires, turn 2's is armed instead
    clock.t += 5_000;
    mock.timers.tick(5_000);
    for (const u of [alice, bob, carol]) room.orders(u.id, [], true);
    await push.settle();
    sent.length = 0;
    clock.t += 15_000;
    mock.timers.tick(15_000);
    await push.settle();
    assert.deepEqual(kinds(sent), [], 'turn 1 hurry was cancelled; turn 2 is still far off');

    // pause in the middle of turn 2, wait well past its old deadline: nothing
    room.pause();
    clock.t += 60_000;
    mock.timers.tick(60_000);
    await push.settle();
    assert.deepEqual(kinds(sent), []);
    // resume: at least 10 s left → the hurry follows the new deadline
    room.resume();
    const left = room.row.next_tick_at! - clock.t;
    clock.t += left - 10_000;
    mock.timers.tick(left - 10_000);
    await push.settle();
    assert.deepEqual(kinds(sent), ['blitzHurry', 'blitzHurry', 'blitzHurry']);
    sent.length = 0;

    // deletion: the next turn's timer is gone with the room
    clock.t += 10_000;
    mock.timers.tick(10_000);
    room.processTime();
    await push.settle();
    assert.equal(room.blitz?.turn, 3);
    sent.length = 0;
    mgr.delete(room.code);
    clock.t += 60_000;
    mock.timers.tick(60_000);
    await push.settle();
    assert.deepEqual(kinds(sent), []);
    push.close();
  } finally {
    mock.timers.reset();
  }
});

test('blitz: after a restart a running turn is not announced again and a passed hurry is dropped', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { push, room, clock, alice, bob, carol, sent, ctx, store } = blitzSetup();
    room.startGame();
    for (const u of [alice, bob, carol]) room.orders(u.id, [], true);
    await push.settle();
    assert.equal(room.blitz?.turn, 2);
    push.close();
    sent.length = 0;

    // "restart" 25 s into turn 2 (planning began 4.5 s after the resolve; 30 s turn)
    clock.t += 25_000;
    const fresh = new PushService({ store, keys: KEYS, now: () => clock.t, log: () => undefined, room: () => room, send: async (s, body, opts) => void sent.push({ endpoint: s.endpoint, payload: JSON.parse(body) as PushPayload, opts }) });
    ctx.notify = fresh;
    fresh.watchLobbies(() => [room]);
    room.refreshViews();
    mock.timers.tick(1);
    await fresh.settle();
    assert.deepEqual(kinds(sent), [], 'turn 2 already announced before the restart; 9.5 s left is past the hurry point');

    // the next turn works as usual
    clock.t += 10_000;
    mock.timers.tick(10_000);
    room.processTime();
    await fresh.settle();
    assert.deepEqual(kinds(sent), ['blitzTurn', 'blitzTurn', 'blitzTurn']);
    fresh.close();
  } finally {
    mock.timers.reset();
  }
});
