// Lobby start at an exact time: the creator sends lobbyEndsAt (ms) with the settings; the server
// keeps it as the room's absolute deadline and checks it is in the future and ≤ 30 days ahead.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoomManager } from '../rooms.ts';
import { makeEnv } from './helpers.ts';

function setup() {
  const env = makeEnv();
  const mgr = new RoomManager(env.ctx);
  const alice = env.user('alice');
  const bob = env.user('bob');
  const room = mgr.create(alice, 'Timed');
  room.join(bob);
  return { ...env, room, alice, bob };
}

test('an exact start time becomes the lobby deadline and switches the lobby to time mode', () => {
  const { room, alice, clock } = setup();
  const at = clock.t + 3 * 3600_000;
  room.updateSettingsAsCreator(alice.id, { lobbyEndsAt: at, lobbyMode: 'time', lobbyZone: 'Europe/Moscow' });
  assert.equal(room.row.lobby_ends_at, at);
  assert.equal(room.settings.lobbyMode, 'time');
  assert.equal(room.settings.lobbyZone, 'Europe/Moscow');

  // Changing the lobby length in time mode leaves the exact deadline alone.
  room.updateSettingsAsCreator(alice.id, { lobbyDurationSec: 600 });
  assert.equal(room.row.lobby_ends_at, at);

  // Back to a duration: counted from when the lobby opened again.
  room.updateSettingsAsCreator(alice.id, { lobbyMode: 'duration' });
  assert.equal(room.row.lobby_ends_at, Math.max(room.row.lobby_started_at + 600_000, clock.t + 60_000));
});

test('the start time must be in the future and at most 30 days ahead; only the creator sets it', () => {
  const { room, alice, bob, clock } = setup();
  const before = room.row.lobby_ends_at;
  assert.throws(() => room.updateSettingsAsCreator(alice.id, { lobbyEndsAt: clock.t - 1000 }), /must be in the future/);
  assert.throws(() => room.updateSettingsAsCreator(alice.id, { lobbyEndsAt: clock.t + 31 * 86400_000 }), /at most 30 days/);
  assert.throws(() => room.updateSettingsAsCreator(alice.id, { lobbyEndsAt: 'soon' }), /Invalid value/);
  assert.throws(() => room.updateSettingsAsCreator(bob.id, { lobbyEndsAt: clock.t + 3600_000 }), /Only the room creator/);
  assert.equal(room.row.lobby_ends_at, before);
});

test('the game starts by itself at the exact time', () => {
  const { room, alice, clock } = setup();
  const at = clock.t + 2 * 3600_000;
  room.updateSettingsAsCreator(alice.id, { lobbyEndsAt: at });
  clock.t = at;
  room.processTime();
  assert.equal(room.phase, 'running');
  room.dispose();
});
