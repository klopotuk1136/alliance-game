import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../db.ts';
import { RoomError } from '../room.ts';
import { RoomManager } from '../rooms.ts';
import { makeEnv, RecordingSink } from './helpers.ts';

function setup(path?: string) {
  const env = makeEnv(path);
  const mgr = new RoomManager(env.ctx);
  const alice = env.user('alice');
  const bob = env.user('bob');
  const carol = env.user('carol');
  const room = mgr.create(alice, 'Friday game');
  return { ...env, mgr, room, alice, bob, carol };
}

/** Puts players at fixed cells with given AP, for deterministic fights. */
function place(room: ReturnType<typeof setup>['room'], spots: Record<string, [number, number, number]>) {
  for (const [nick, [q, r, ap]] of Object.entries(spots)) {
    const p = room.playerByNickname(nick)!;
    p.q = q;
    p.r = r;
    p.ap = ap;
  }
}

test('creator joins automatically; others join with unique nickname and flag', () => {
  const { room, alice, bob, carol } = setup();
  assert.equal(room.phase, 'lobby');
  assert.equal(room.participantOf(alice.id)?.nickname, 'alice');
  room.join(bob);
  room.join(carol);
  assert.equal(room.players.size, 3);
  const flags = [...room.players.values()].map((p) => p.flag);
  assert.equal(new Set(flags).size, 3);

  assert.throws(() => room.setProfile(bob.id, 'ALICE', undefined), RoomError);
  assert.throws(() => room.setProfile(bob.id, undefined, room.participantOf(alice.id)!.flag), RoomError);
  assert.throws(() => room.setProfile(bob.id, undefined, 'not-a-flag'), RoomError);
  assert.throws(() => room.setProfile(bob.id, '   ', undefined), RoomError);
  room.setProfile(bob.id, '  Kingdom   of Bob ', 'fr');
  assert.equal(room.participantOf(bob.id)?.nickname, 'Kingdom of Bob');
  assert.equal(room.participantOf(bob.id)?.flag, 'fr');
});

test('only the creator starts, and only with 2+ players', () => {
  const { room, alice, bob } = setup();
  assert.throws(() => room.requestStart(alice.id), /At least 2 players/);
  room.join(bob);
  assert.throws(() => room.requestStart(bob.id), /Only the room creator/);
  room.requestStart(alice.id);
  assert.equal(room.phase, 'running');
  assert.notEqual(room.row.next_tick_at, null);
  for (const p of room.players.values()) assert.notEqual(p.q, null);
});

test('nobody can join after the start; leaving and kicking only in the lobby', () => {
  const { room, alice, bob, carol, user } = setup();
  room.join(bob);
  room.join(carol);
  assert.throws(() => room.leave(alice.id), /creator/);
  room.leave(carol.id);
  assert.equal(room.players.size, 2);
  room.join(carol);
  assert.throws(() => room.kick(bob.id, room.participantOf(carol.id)!.pid), /Only the room creator/);
  room.kick(alice.id, room.participantOf(carol.id)!.pid);
  assert.equal(room.participantOf(carol.id), undefined);
  room.requestStart(alice.id);
  assert.throws(() => room.join(user('dave')), /already started/);
  assert.throws(() => room.leave(bob.id), RoomError);
});

test('room is full at maxPlayers', () => {
  const { room, bob, carol, user } = setup();
  room.updateSettings({ maxPlayers: '3' });
  room.join(bob);
  room.join(carol);
  assert.throws(() => room.join(user('dave')), /full/);
});

test('lobby starts automatically at the deadline', () => {
  const { room, bob, clock } = setup();
  room.join(bob);
  clock.t = room.row.lobby_ends_at!;
  room.processTime();
  assert.equal(room.phase, 'running');
});

test('lobby deadline with one player waits for the creator', () => {
  const { room, clock, alice, bob } = setup();
  clock.t = room.row.lobby_ends_at! + 1;
  room.processTime();
  assert.equal(room.phase, 'lobby');
  assert.equal(room.row.lobby_ends_at, null);
  room.join(bob);
  room.processTime();
  assert.equal(room.phase, 'lobby');
  room.requestStart(alice.id);
  assert.equal(room.phase, 'running');
});

test('a full game: attacks, elimination, winner, reveal, reset', () => {
  const { room, alice, bob, carol } = setup();
  room.join(bob);
  room.join(carol);
  room.requestStart(alice.id);
  place(room, { alice: [0, 0, 10], bob: [1, 0, 10], carol: [-1, 0, 10] });
  const pid = (n: string) => room.playerByNickname(n)!.pid;

  for (let i = 0; i < 3; i++) assert.ok(room.act(null, alice.id, i, { type: 'attack', target: pid('bob') }).ok);
  assert.equal(room.playerByNickname('bob')!.alive, false);
  assert.equal(room.playerByNickname('bob')!.eliminatedBy, pid('alice'));
  assert.equal(room.phase, 'running');
  assert.equal(room.act(null, bob.id, 9, { type: 'upgrade' }).ok, false);

  for (let i = 0; i < 3; i++) assert.ok(room.act(null, carol.id, i, { type: 'attack', target: pid('alice') }).ok);
  assert.equal(room.phase, 'finished');
  assert.equal(room.row.winner_pid, pid('carol'));
  assert.equal(room.act(null, carol.id, 99, { type: 'upgrade' }).ok, false);

  room.reset();
  assert.equal(room.phase, 'lobby');
  assert.equal(room.players.size, 3);
  assert.equal(room.events.length, 0);
  assert.equal(room.row.winner_pid, null);
});

test('paused games reject actions and skip ticks; resume reschedules', () => {
  const { room, alice, bob, clock } = setup();
  room.join(bob);
  room.requestStart(alice.id);
  room.pause();
  assert.equal(room.act(null, alice.id, 1, { type: 'upgrade' }).ok, false);
  clock.t += 3 * 24 * 3600 * 1000;
  room.processTime();
  assert.equal(room.participantOf(alice.id)!.ap, 0);
  room.resume();
  assert.ok(room.row.next_tick_at! > clock.t);
  assert.equal(room.participantOf(alice.id)!.ap, 0);
});

test('missed daily ticks are granted after downtime; missed interval ticks are not', () => {
  const daily = setup();
  daily.room.join(daily.bob);
  daily.room.requestStart(daily.alice.id);
  // Simulate the server being down for 3 days, then restarting.
  daily.clock.t += 3 * 24 * 3600 * 1000 + 60_000;
  const restarted = new RoomManager(daily.ctx);
  restarted.loadAll();
  const room = restarted.get(daily.room.code)!;
  assert.equal(room.participantOf(daily.alice.id)!.ap, 3);
  assert.equal(room.participantOf(daily.bob.id)!.ap, 3);
  assert.ok(room.row.next_tick_at! > daily.clock.t);

  const interval = setup();
  interval.room.updateSettings({ tickMode: 'interval', tickIntervalSec: '30' });
  interval.room.join(interval.bob);
  interval.room.requestStart(interval.alice.id);
  interval.clock.t += 10 * 60_000;
  interval.room.processTime();
  assert.equal(interval.room.participantOf(interval.alice.id)!.ap, 1);
});

test('everything survives a restart (database file)', () => {
  const path = join(tmpdir(), `alliance-test-${process.pid}-${Date.now()}.db`);
  try {
    const env = setup(path);
    env.room.join(env.bob);
    env.room.join(env.carol);
    env.room.requestStart(env.alice.id);
    place(env.room, { alice: [0, 0, 5], bob: [2, 0, 5], carol: [-3, 0, 5] });
    const bobPid = env.room.playerByNickname('bob')!.pid;
    env.room.act(null, env.alice.id, 1, { type: 'attack', target: bobPid });
    env.room.act(null, env.alice.id, 2, { type: 'upgrade' });
    const before = [...env.room.players.values()].map((p) => ({ ...p }));
    const code = env.room.code;
    env.store.close();

    const store = new Store(path);
    const mgr = new RoomManager({ ...env.ctx, store });
    mgr.loadAll();
    const room = mgr.get(code)!;
    assert.equal(room.phase, 'running');
    assert.deepEqual([...room.players.values()], before);
    assert.equal(room.events.filter((e) => e.type === 'attack').length, 1);
    store.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(path + suffix, { force: true });
      } catch {
        // Windows may keep the file locked briefly; it's in the temp dir anyway.
      }
    }
  }
});

test('settings: validation, gridRadius only in lobby, schedule change reschedules', () => {
  const { room, alice, bob, clock } = setup();
  assert.throws(() => room.updateSettings({ startHp: 'abc' }), RoomError);
  assert.throws(() => room.updateSettings({ nope: '1' }), RoomError);
  assert.throws(() => room.updateSettings({ timezone: 'Mars/Olympus' }), RoomError);
  room.updateSettings({ gridRadius: '8', startHp: '5' });
  room.join(bob);
  room.requestStart(alice.id);
  assert.equal(room.participantOf(bob.id)!.hp, 5);
  assert.throws(() => room.updateSettings({ gridRadius: '4' }), /lobby/);
  room.updateSettings({ tickMode: 'interval', tickIntervalSec: '10' });
  assert.equal(room.row.next_tick_at, clock.t + 10_000);
});

test('sinks get a full state on attach and lobby updates live', () => {
  const { room, alice, bob } = setup();
  const sa = new RecordingSink(alice);
  room.attach(sa);
  assert.equal(sa.updates()[0].resetLog, true);
  assert.equal(sa.lastStateMsg()!.players.length, 1);
  room.join(bob);
  assert.equal(sa.lastStateMsg()!.players.length, 2);
});

test('the creator can change settings in the lobby, and they shape the game', () => {
  const { room, alice, bob, clock } = setup();
  room.join(bob);
  const sb = new RecordingSink(bob);
  room.attach(sb);
  room.updateSettingsAsCreator(alice.id, {
    maxPlayers: 4,
    gridRadius: '4',
    startHp: 5,
    startAp: 2,
    startRange: 1,
    tickMode: 'interval',
    tickIntervalSec: 3600,
    apPerTick: 2,
  });
  // Other players see the new rules right away.
  const rules = sb.lastStateMsg()!.rules;
  assert.deepEqual([rules.maxPlayers, rules.gridRadius, rules.startHp, rules.tickMode], [4, 4, 5, 'interval']);

  room.requestStart(alice.id);
  for (const p of room.players.values()) {
    assert.deepEqual([p.hp, p.ap, p.range], [5, 2, 1]);
    assert.ok(Math.max(Math.abs(p.q!), Math.abs(p.r!), Math.abs(p.q! + p.r!)) <= 4, 'spawned inside the smaller map');
  }
  assert.equal(room.row.next_tick_at, clock.t + 3600_000);
  clock.t += 3600_000;
  room.processTime();
  assert.equal(room.participantOf(alice.id)!.ap, 4);
});

test('only the creator, only in the lobby, only sensible values', () => {
  const { room, alice, bob, carol } = setup();
  room.join(bob);
  room.join(carol);
  assert.throws(() => room.updateSettingsAsCreator(bob.id, { startHp: 5 }), /Only the room creator/);
  assert.throws(() => room.updateSettingsAsCreator(alice.id, { maxPlayers: 2 }), /3 players have already joined/);
  assert.throws(() => room.updateSettingsAsCreator(alice.id, { gridRadius: 2, maxPlayers: 10 }), /can't fit 10 players/);
  assert.throws(() => room.updateSettingsAsCreator(alice.id, { startRange: 10 }), /can't fit/);
  assert.throws(() => room.updateSettingsAsCreator(alice.id, { tickTime: '25:00' }), /HH:MM/);
  assert.throws(() => room.updateSettingsAsCreator(alice.id, { costMove: { evil: true } }), /Invalid value/);
  assert.throws(() => room.updateSettingsAsCreator(alice.id, ['x']), /No changes/);
  // A failed change leaves everything as it was.
  assert.equal(room.settings.maxPlayers, 10);
  assert.equal(room.settings.gridRadius, 6);
  room.requestStart(alice.id);
  assert.throws(() => room.updateSettingsAsCreator(alice.id, { startHp: 5 }), /only be changed in the lobby/);
});

test('changing the lobby length moves the automatic start, never into the past', () => {
  const { room, alice, clock } = setup();
  const opened = room.row.lobby_started_at;
  room.updateSettingsAsCreator(alice.id, { lobbyDurationSec: 2 * 86400 });
  assert.equal(room.row.lobby_ends_at, opened + 2 * 86400_000);
  clock.t += 3600_000;
  room.updateSettingsAsCreator(alice.id, { lobbyDurationSec: 600 });
  assert.equal(room.row.lobby_ends_at, clock.t + 60_000);
});
