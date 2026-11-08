import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hexDistance } from '../../shared/hex.ts';
import { DEFAULT_SETTINGS, type GameSettings } from '../../shared/settings.ts';
import { applyAction, applyTick, canFit, spawnPositions, startGame, type PlayerState, type Players } from '../engine.ts';
import { seededRng } from './helpers.ts';

const S: GameSettings = { ...DEFAULT_SETTINGS };
const NOW = 1_000_000;

function player(pid: number, q: number, r: number, extra: Partial<PlayerState> = {}): PlayerState {
  return {
    pid,
    userId: pid,
    nickname: `p${pid}`,
    flag: 'de',
    joinedAt: 0,
    q,
    r,
    hp: 3,
    ap: 5,
    range: 2,
    alive: true,
    eliminatedAt: null,
    eliminatedBy: null,
    ...extra,
  };
}

function world(...list: PlayerState[]): Players {
  return new Map(list.map((p) => [p.pid, p]));
}

test('move to a neighbouring cell costs 1 AP', () => {
  const w = world(player(1, 0, 0));
  const res = applyAction(w, S, 1, { type: 'move', q: 1, r: 0 }, NOW);
  assert.equal(res.ok, true);
  assert.deepEqual([w.get(1)!.q, w.get(1)!.r, w.get(1)!.ap], [1, 0, 4]);
});

test('illegal moves are rejected and change nothing', () => {
  const w = world(player(1, 6, 0), player(2, 5, 0, { ap: 0 }));
  const before = JSON.stringify([...w.values()]);
  const cases = [
    { type: 'move' as const, q: 4, r: 0 }, // two cells away
    { type: 'move' as const, q: 5, r: 0 }, // occupied
    { type: 'move' as const, q: 7, r: 0 }, // off the grid
    { type: 'move' as const, q: 6, r: 0 }, // own cell (distance 0)
  ];
  for (const action of cases) {
    const res = applyAction(w, S, 1, action, NOW);
    assert.equal(res.ok, false, JSON.stringify(action));
  }
  const noAp = applyAction(w, S, 2, { type: 'move', q: 4, r: 0 }, NOW);
  assert.equal(noAp.ok, false);
  assert.match((noAp as { error: string }).error, /Not enough AP/);
  assert.equal(JSON.stringify([...w.values()]), before);
});

test('attack range is inclusive', () => {
  const w = world(player(1, 0, 0), player(2, 2, 0), player(3, -3, 0));
  assert.equal(applyAction(w, S, 1, { type: 'attack', target: 2 }, NOW).ok, true);
  assert.equal(w.get(2)!.hp, 2);
  const far = applyAction(w, S, 1, { type: 'attack', target: 3 }, NOW);
  assert.equal(far.ok, false);
  assert.match((far as { error: string }).error, /Out of range/);
  assert.equal(w.get(3)!.hp, 3);
});

test('a player at 0 HP is eliminated and removed from the grid', () => {
  const w = world(player(1, 0, 0), player(2, 1, 0, { hp: 1 }), player(3, -2, 0));
  const res = applyAction(w, S, 1, { type: 'attack', target: 2 }, NOW);
  assert.ok(res.ok);
  assert.deepEqual(
    res.events.map((e) => e.type),
    ['attack', 'eliminate'],
  );
  const victim = w.get(2)!;
  assert.equal(victim.alive, false);
  assert.equal(victim.q, null);
  assert.equal(victim.eliminatedBy, 1);
  // The cell is free again and the dead player can't be targeted or act.
  assert.equal(applyAction(w, S, 1, { type: 'move', q: 1, r: 0 }, NOW).ok, true);
  assert.equal(applyAction(w, S, 3, { type: 'attack', target: 2 }, NOW).ok, false);
  assert.equal(applyAction(w, S, 2, { type: 'upgrade' }, NOW).ok, false);
});

test('grant moves AP to another player in range', () => {
  const w = world(player(1, 0, 0, { ap: 3 }), player(2, 0, 2, { ap: 0 }));
  assert.ok(applyAction(w, S, 1, { type: 'grant', target: 2 }, NOW).ok);
  assert.equal(w.get(1)!.ap, 2);
  assert.equal(w.get(2)!.ap, 1);
});

test('upgrade costs 2 AP and adds 1 range', () => {
  const w = world(player(1, 0, 0, { ap: 3 }));
  assert.ok(applyAction(w, S, 1, { type: 'upgrade' }, NOW).ok);
  assert.deepEqual([w.get(1)!.ap, w.get(1)!.range], [1, 3]);
  assert.equal(applyAction(w, S, 1, { type: 'upgrade' }, NOW).ok, false);
});

test('you cannot target yourself or garbage', () => {
  const w = world(player(1, 0, 0), player(2, 1, 0));
  assert.equal(applyAction(w, S, 1, { type: 'attack', target: 1 }, NOW).ok, false);
  assert.equal(applyAction(w, S, 1, { type: 'grant', target: 1 }, NOW).ok, false);
  assert.equal(applyAction(w, S, 1, { type: 'attack', target: 99 }, NOW).ok, false);
  assert.equal(applyAction(w, S, 1, { type: 'attack', target: 'x' } as never, NOW).ok, false);
  assert.equal(applyAction(w, S, 1, { type: 'nuke' } as never, NOW).ok, false);
  assert.equal(applyAction(w, S, 1, { type: 'move', q: 0.5, r: 0 } as never, NOW).ok, false);
});

test('custom costs from settings are respected', () => {
  const custom = { ...S, costAttack: 3, attackDamage: 2 };
  const w = world(player(1, 0, 0, { ap: 3 }), player(2, 1, 0));
  assert.ok(applyAction(w, custom, 1, { type: 'attack', target: 2 }, NOW).ok);
  assert.deepEqual([w.get(1)!.ap, w.get(2)!.hp], [0, 1]);
});

test('tick gives AP to alive players only', () => {
  const w = world(player(1, 0, 0, { ap: 0 }), player(2, 1, 0, { ap: 0, alive: false, q: null, r: null }));
  applyTick(w, S, NOW);
  assert.equal(w.get(1)!.ap, 1);
  assert.equal(w.get(2)!.ap, 0);
});

test('spawns are at least startRange + 1 apart, so nobody starts in range', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const spots = spawnPositions(10, 6, 3, seededRng(seed));
    assert.ok(spots, `seed ${seed}`);
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) assert.ok(hexDistance(spots[i], spots[j]) >= 3);
    }
  }
});

test('startGame gives starting stats and refuses when players do not fit', () => {
  const w = world(player(1, null as never, null as never), player(2, null as never, null as never));
  const ev = startGame(w, S, seededRng(1), NOW);
  assert.equal(typeof ev, 'object');
  for (const p of w.values()) {
    assert.deepEqual([p.hp, p.ap, p.range, p.alive], [3, 0, 2, true]);
    assert.notEqual(p.q, null);
  }
  const crowded = new Map(Array.from({ length: 12 }, (_, i) => [i + 1, player(i + 1, 0, 0)]));
  const err = startGame(crowded, { ...S, gridRadius: 2 }, seededRng(1), NOW);
  assert.equal(typeof err, 'string');
  assert.equal(startGame(world(player(1, 0, 0)), S, seededRng(1), NOW), 'At least 2 players are needed to start');
});

test('canFit matches what the map can hold', () => {
  assert.equal(canFit(10, 6, 3, seededRng(1)), true);
  assert.equal(canFit(10, 2, 3, seededRng(1)), false);
  assert.equal(canFit(200, 6, 1, seededRng(1)), false); // more players than cells
  assert.equal(canFit(2, 2, 5, seededRng(1)), false); // radius 2 is only 4 cells across
  assert.equal(canFit(2, 2, 4, seededRng(1)), true);
  // Large maps stay fast.
  const t = Date.now();
  canFit(100, 30, 6, seededRng(1));
  assert.ok(Date.now() - t < 2000);
});
