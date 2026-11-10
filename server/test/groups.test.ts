// Group chats and plans: membership is enforced by the server (only members receive a
// group's messages, member list and plan), new members read from when they joined,
// plan edits are validated, and everything survives a restart.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PLAN_MAX_ITEMS, type PlanEvent, type PlanState } from '../../shared/plan.ts';
import type { ChatMessage, ServerMessage } from '../../shared/protocol.ts';
import { RoomManager } from '../rooms.ts';
import { makeEnv, RecordingSink } from './helpers.ts';

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

function of<T extends ServerMessage['type']>(sink: RecordingSink, type: T): Array<Msg<T>> {
  return sink.messages.filter((m): m is Msg<T> => m.type === type);
}

function chatTexts(sink: RecordingSink): string[] {
  return of(sink, 'chat').flatMap((m) => m.messages.filter((c) => !c.sys).map((c: ChatMessage) => c.text));
}

function lastGroups(sink: RecordingSink) {
  return of(sink, 'groups').at(-1)?.groups ?? [];
}

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setup(path = ':memory:') {
  const env = makeEnv(path);
  const mgr = new RoomManager(env.ctx);
  const [alice, bob, carol, dave, erin] = ['alice', 'bob', 'carol', 'dave', 'erin'].map((n) => env.user(n));
  const room = mgr.create(alice, 'Groups test');
  for (const u of [bob, carol, dave]) room.join(u);
  const pid = (u: { id: number }) => room.participantOf(u.id)!.pid;
  return { ...env, mgr, room, alice, bob, carol, dave, erin, pid };
}

test('only group members receive its messages and learn it exists', () => {
  const { room, alice, bob, carol, dave, erin, pid } = setup();
  const sinks = [alice, bob, carol, dave, erin].map((u) => new RecordingSink(u));
  for (const s of sinks) room.attach(s);
  const [sa, sb, sc, sd, se] = sinks;

  const g = room.groups.create(alice.id, 'Northern pact', [pid(bob), pid(carol)]);
  assert.deepEqual(g.members, [pid(alice), pid(bob), pid(carol)]);
  assert.equal(lastGroups(sb)[0]?.name, 'Northern pact');
  assert.deepEqual(lastGroups(sd), [], 'dave was sent no group');
  assert.equal(of(sd, 'groups').length, 1, 'dave only got the initial empty list');

  room.chat(bob.id, null, 'we strike dave at dawn', undefined, g.id);
  assert.deepEqual(chatTexts(sa), ['we strike dave at dawn']);
  assert.deepEqual(chatTexts(sc), ['we strike dave at dawn']);
  assert.deepEqual(chatTexts(sd), []);
  assert.deepEqual(chatTexts(se), [], 'a visitor who has not joined reads nothing');

  // Non-members can neither post nor probe.
  assert.throws(() => room.chat(dave.id, null, 'let me in', undefined, g.id), /not in that group/);
  assert.throws(() => room.chat(dave.id, null, 'x', undefined, 99999), /not in that group/);
  assert.throws(() => room.groups.add(dave.id, g.id, [pid(dave)]), /not in that group/);
  assert.throws(() => room.groups.rename(dave.id, g.id, 'mine'), /not in that group/);
  assert.throws(() => room.groups.planOpen(sd, `g:${g.id}`), /not in that/);
  assert.throws(() => room.groups.planOp(dave.id, `g:${g.id}`, { op: 'snapshot' }), /not in that/);

  // Reconnect: the history is still filtered.
  const daveAgain = new RecordingSink(dave);
  room.attach(daveAgain);
  assert.deepEqual(chatTexts(daveAgain), []);
  const carolAgain = new RecordingSink(carol);
  room.attach(carolAgain);
  assert.deepEqual(chatTexts(carolAgain), ['we strike dave at dawn']);
});

test('groups need two others; names are cleaned and limited', () => {
  const { room, alice, bob, carol, pid } = setup();
  assert.throws(() => room.groups.create(alice.id, '', [pid(bob)]), /two other players/);
  assert.throws(() => room.groups.create(alice.id, '', [pid(bob), pid(alice)]), /two other players/);
  assert.throws(() => room.groups.create(alice.id, '', [pid(bob), 424242]), /not in this room/);
  assert.throws(() => room.groups.create(alice.id, 'x'.repeat(33), [pid(bob), pid(carol)]), /too long/);
  const g = room.groups.create(alice.id, '  Iron‮  league ', [pid(bob), pid(carol)]);
  assert.equal(g.name, 'Iron league');
});

test('new members read from when they joined; leavers stop receiving', () => {
  const { room, alice, bob, carol, dave, pid } = setup();
  const g = room.groups.create(alice.id, '', [pid(bob), pid(carol)]);
  room.chat(alice.id, null, 'before dave', undefined, g.id);
  const sd = new RecordingSink(dave);
  room.attach(sd);
  room.groups.add(carol.id, g.id, [pid(dave)]);
  assert.equal(lastGroups(sd)[0]?.id, g.id);
  room.chat(bob.id, null, 'welcome dave', undefined, g.id);
  assert.deepEqual(chatTexts(sd), ['welcome dave']);
  const sdAgain = new RecordingSink(dave);
  room.attach(sdAgain);
  assert.deepEqual(chatTexts(sdAgain), ['welcome dave'], 'history starts when dave was added');
  const sys = of(sdAgain, 'chat').flatMap((m) => m.messages).filter((m) => m.sys);
  assert.deepEqual(sys.map((m) => m.sys!.kind), ['added']);

  room.groups.leave(bob.id, g.id);
  const sb = new RecordingSink(bob);
  room.attach(sb);
  assert.deepEqual(lastGroups(sb), []);
  room.chat(alice.id, null, 'bob is gone', undefined, g.id);
  assert.ok(!chatTexts(sb).includes('bob is gone'));
  assert.throws(() => room.chat(bob.id, null, 'wait', undefined, g.id), /not in that group/);
});

test('eliminated players keep their groups and may still talk and plan (like the room chat)', () => {
  const { room, alice, bob, carol, pid } = setup();
  const g = room.groups.create(alice.id, '', [pid(bob), pid(carol)]);
  room.requestStart(alice.id);
  room.adjustPlayer(pid(carol), { hp: 0 });
  assert.equal(room.chat(carol.id, null, 'avenge me', undefined, g.id).group, g.id);
  room.groups.planOp(carol.id, `g:${g.id}`, { op: 'add', item: { kind: 'pin', turn: 1, at: [0, 0], pin: 'rally' } });
});

test('leaving the lobby removes a player from their groups', () => {
  const { room, alice, bob, carol, dave, pid } = setup();
  const g = room.groups.create(alice.id, '', [pid(bob), pid(dave)]);
  const davePid = pid(dave);
  room.leave(dave.id);
  const sa = new RecordingSink(alice);
  room.attach(sa);
  assert.ok(!lastGroups(sa)[0]!.members.includes(davePid));
  // Two members are left; when they leave too the group is gone.
  room.groups.leave(bob.id, g.id);
  room.groups.leave(alice.id, g.id);
  const sc = new RecordingSink(carol);
  room.attach(sc);
  assert.deepEqual(lastGroups(sc), []);
});

test('plan edits are validated, broadcast to members only, and limited', () => {
  const { room, alice, bob, carol, dave, pid, clock } = setup();
  room.requestStart(alice.id);
  const g = room.groups.create(alice.id, '', [pid(bob), pid(carol)]);
  const ch = `g:${g.id}`;
  const sb = new RecordingSink(bob);
  const sd = new RecordingSink(dave);
  room.attach(sb);
  room.attach(sd);

  room.groups.planOpen(sb, ch);
  const plan = of(sb, 'plan')[0]!.plan as PlanState;
  assert.equal(plan.snapshot.pieces.length, 4);
  for (const p of plan.snapshot.pieces) {
    // Public data only: never HP, AP or range.
    assert.deepEqual(Object.keys(p).sort(), ['flag', 'nickname', 'pid', 'q', 'r']);
  }
  const radius = plan.snapshot.radius;

  const ev = room.groups.planOp(alice.id, ch, { op: 'add', item: { kind: 'attack', turn: 2, from: [0, 0], to: [1, 0] }, cid: 'c1' })!;
  assert.equal(ev.op, 'add');
  const got = of(sb, 'plan_op').map((m) => m.event as PlanEvent);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.op === 'add' && got[0]!.item.author, pid(alice));
  assert.equal(got[0]!.op === 'add' && got[0]!.cid, 'c1');
  assert.equal(of(sd, 'plan_op').length, 0, 'non-members get no plan edits');

  const bad: unknown[] = [
    { op: 'add', item: { kind: 'move', turn: 1, from: [0, 0], to: [radius + 1, 0] } },
    { op: 'add', item: { kind: 'move', turn: 1, from: [0, 0], to: [0, 0] } },
    { op: 'add', item: { kind: 'move', turn: 4, from: [0, 0], to: [1, 0] } },
    { op: 'add', item: { kind: 'move', turn: 1, from: [0.5, 0], to: [1, 0] } },
    { op: 'add', item: { kind: 'laser', turn: 1, at: [0, 0] } },
    { op: 'add', item: { kind: 'pin', turn: 1, at: [0, 0], pin: 'nuke' } },
    { op: 'add', item: { kind: 'note', turn: 1, at: [0, 0], text: '   ' } },
    { op: 'add', item: { kind: 'note', turn: 1, at: [0, 0], text: 'x'.repeat(61) } },
    { op: 'add', item: { kind: 'ghost', turn: 1, at: [0, 0], pid: 999999 } },
    { op: 'clear', turn: 7 },
    { op: 'boom' },
    null,
  ];
  for (const op of bad) assert.throws(() => room.groups.planOp(alice.id, ch, op), /not valid|not on the map|different cells|needs some text|at most|not on the plan/, JSON.stringify(op));

  room.groups.planOp(bob.id, ch, { op: 'add', item: { kind: 'note', turn: 1, at: [1, -1], text: 'hold here' } });
  room.groups.planOp(bob.id, ch, { op: 'add', item: { kind: 'ghost', turn: 1, at: [0, 1], pid: pid(carol) } });

  // Undo-style delete, clear one layer, then the size limit.
  const id = (ev as Extract<PlanEvent, { op: 'add' }>).item.id;
  room.groups.planOp(bob.id, ch, { op: 'del', ids: [id] });
  room.groups.planOp(bob.id, ch, { op: 'clear', turn: 1 });
  const sa = new RecordingSink(alice);
  room.attach(sa);
  room.groups.planOpen(sa, ch);
  assert.deepEqual(of(sa, 'plan')[0]!.plan.items, []);

  // DM plans: only the two players.
  const dm = `d:${Math.min(pid(alice), pid(bob))}:${Math.max(pid(alice), pid(bob))}`;
  room.groups.planOp(alice.id, dm, { op: 'add', item: { kind: 'pin', turn: 1, at: [0, 0], pin: 'target' } });
  assert.throws(() => room.groups.planOp(carol.id, dm, { op: 'snapshot' }), /not in that chat/);
  assert.throws(() => room.groups.planOpen(sd, `d:${pid(bob)}:${pid(alice)}`), /not in that chat/, 'unsorted keys are refused');

  // The limit (spread over time to stay under the edit-rate limit).
  clock.t += 11_000;
  for (let i = 0; i < PLAN_MAX_ITEMS; i++) {
    if (i % 30 === 29) clock.t += 11_000;
    room.groups.planOp(alice.id, ch, { op: 'add', item: { kind: 'pin', turn: 1 + (i % 3), at: [0, 0], pin: 'rally' } });
  }
  assert.throws(() => room.groups.planOp(alice.id, ch, { op: 'add', item: { kind: 'pin', turn: 1, at: [0, 0], pin: 'rally' } }), /plan is full/);
});

test('plan edits are rate limited and post one debounced chat line', () => {
  const env = setup();
  const { room, alice, bob, carol, pid, clock } = env;
  const g = room.groups.create(alice.id, '', [pid(bob), pid(carol)]);
  const ch = `g:${g.id}`;
  const sb = new RecordingSink(bob);
  room.attach(sb);
  for (let i = 0; i < 5; i++) room.groups.planOp(alice.id, ch, { op: 'add', item: { kind: 'pin', turn: 1, at: [0, 0], pin: 'rally' } });
  const planLines = () => of(sb, 'chat').flatMap((m) => m.messages).filter((m) => m.sys?.kind === 'plan');
  assert.equal(planLines().length, 1, 'one notice for a burst of edits');
  clock.t += 3 * 60_000 + 1;
  room.groups.planOp(alice.id, ch, { op: 'add', item: { kind: 'pin', turn: 1, at: [0, 0], pin: 'rally' } });
  assert.equal(planLines().length, 2);
  for (let i = 0; i < 39; i++) room.groups.planOp(alice.id, ch, { op: 'add', item: { kind: 'pin', turn: 1, at: [0, 0], pin: 'rally' } });
  assert.throws(() => room.groups.planOp(alice.id, ch, { op: 'snapshot' }), /too fast/);
});

test('groups, messages and plans survive a restart; deleting the room removes them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-groups-'));
  dirs.push(dir);
  const path = join(dir, 'g.db');
  const a = setup(path);
  const g = a.room.groups.create(a.alice.id, 'Pact', [a.pid(a.bob), a.pid(a.carol)]);
  a.room.chat(a.bob.id, null, 'persist me', undefined, g.id);
  a.room.groups.planOp(a.alice.id, `g:${g.id}`, { op: 'add', item: { kind: 'support', turn: 3, from: [0, 0], to: [0, 1] } });
  const code = a.room.code;
  a.store.close();

  const env = makeEnv(path);
  const mgr = new RoomManager(env.ctx);
  mgr.loadAll();
  const room = mgr.get(code)!;
  const bob = env.user('bob');
  const dave = env.user('dave');
  const sb = new RecordingSink(bob);
  room.attach(sb);
  assert.equal(lastGroups(sb)[0]?.name, 'Pact');
  assert.deepEqual(chatTexts(sb), ['persist me']);
  room.groups.planOpen(sb, `g:${g.id}`);
  const plan = of(sb, 'plan')[0]!.plan;
  assert.equal(plan.items.length, 1);
  assert.deepEqual(plan.items[0]!.kind, 'support');
  const sd = new RecordingSink(dave);
  room.attach(sd);
  assert.deepEqual(lastGroups(sd), []);
  assert.deepEqual(chatTexts(sd), []);

  const roomId = room.row.id;
  mgr.delete(code);
  assert.deepEqual(env.store.loadGroups(roomId), []);
  assert.equal(env.store.loadPlan(roomId, `g:${g.id}`), undefined);
  env.store.close();
});
