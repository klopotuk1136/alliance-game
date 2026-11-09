// Chat tests: room-wide messages reach every participant, private ones only their two
// players (across all their tabs and after reconnecting), and outsiders see nothing.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { ChatMessage, ServerMessage } from '../../shared/protocol.ts';
import { cleanChatText, RoomError } from '../room.ts';
import { Store } from '../db.ts';
import { RoomManager } from '../rooms.ts';
import { STICKER_MAX_BYTES, StickerLibrary } from '../stickers.ts';
import { makeEnv, RecordingSink } from './helpers.ts';

function setup() {
  const env = makeEnv();
  const mgr = new RoomManager(env.ctx);
  const [alice, bob, carol, dave] = ['alice', 'bob', 'carol', 'dave'].map((n) => env.user(n));
  const room = mgr.create(alice, 'Chat test');
  room.join(bob);
  room.join(carol);
  return { ...env, mgr, room, alice, bob, carol, dave };
}

/** Every chat text a browser has received, in order. */
function texts(sink: RecordingSink): string[] {
  return sink.messages
    .filter((m): m is Extract<ServerMessage, { type: 'chat' }> => m.type === 'chat')
    .flatMap((m: { messages: ChatMessage[] }) => m.messages.map((c) => c.text));
}

test('room-wide messages reach all participants; private ones only sender and recipient', () => {
  const { room, alice, bob, carol, dave } = setup();
  const sinks = { alice: new RecordingSink(alice), alice2: new RecordingSink(alice), bob: new RecordingSink(bob), carol: new RecordingSink(carol), dave: new RecordingSink(dave) };
  for (const s of Object.values(sinks)) room.attach(s);
  const bobPid = room.participantOf(bob.id)!.pid;

  room.chat(alice.id, null, 'hello everyone');
  room.chat(alice.id, bobPid, 'secret deal: attack carol');

  assert.deepEqual(texts(sinks.alice), ['hello everyone', 'secret deal: attack carol']);
  assert.deepEqual(texts(sinks.alice2), ['hello everyone', 'secret deal: attack carol']);
  assert.deepEqual(texts(sinks.bob), ['hello everyone', 'secret deal: attack carol']);
  assert.deepEqual(texts(sinks.carol), ['hello everyone']);
  assert.deepEqual(texts(sinks.dave), [], 'a lobby visitor who has not joined reads nothing');

  // Reconnecting brings back the same history, still filtered.
  const carolAgain = new RecordingSink(carol);
  room.attach(carolAgain);
  assert.deepEqual(texts(carolAgain), ['hello everyone']);
  const bobAgain = new RecordingSink(bob);
  room.attach(bobAgain);
  assert.deepEqual(texts(bobAgain), ['hello everyone', 'secret deal: attack carol']);
});

test('joining loads the history; leaving clears it', () => {
  const { room, alice, dave } = setup();
  const daveTab = new RecordingSink(dave);
  room.attach(daveTab);
  room.chat(alice.id, null, 'before dave');
  assert.deepEqual(texts(daveTab), []);

  room.join(dave);
  const afterJoin = daveTab.messages.at(-1) as Extract<ServerMessage, { type: 'chat' }>;
  assert.equal(afterJoin.type, 'chat');
  assert.equal(afterJoin.reset, true);
  assert.deepEqual(afterJoin.messages.map((m) => m.text), ['before dave']);

  room.leave(dave.id);
  const afterLeave = daveTab.messages.at(-1) as Extract<ServerMessage, { type: 'chat' }>;
  assert.equal(afterLeave.reset, true);
  assert.deepEqual(afterLeave.messages, []);
  assert.throws(() => room.chat(dave.id, null, 'hi'), /Join the room/);
});

test('chat works in every phase, eliminated players included', () => {
  const { room, alice, bob, carol } = setup();
  room.requestStart(alice.id);
  room.adjustPlayer(room.participantOf(carol.id)!.pid, { hp: 0 });
  assert.equal(room.chat(carol.id, null, 'gg, I am out').text, 'gg, I am out');
  room.adjustPlayer(room.participantOf(bob.id)!.pid, { hp: 0 });
  assert.equal(room.phase, 'finished');
  assert.equal(room.chat(bob.id, room.participantOf(alice.id)!.pid, 'well played').to, room.participantOf(alice.id)!.pid);
});

test('bad recipients, empty or long messages and flooding are refused', () => {
  const { room, alice, bob, clock } = setup();
  const me = room.participantOf(alice.id)!.pid;
  assert.throws(() => room.chat(alice.id, me, 'hi me'), /yourself/);
  assert.throws(() => room.chat(alice.id, 99999, 'hi'), /not in this room/);
  assert.throws(() => room.chat(alice.id, 'x', 'hi'), RoomError);
  assert.throws(() => room.chat(alice.id, null, '   \n '), /empty/);
  assert.throws(() => room.chat(alice.id, null, 42), /empty/);
  assert.throws(() => room.chat(alice.id, null, 'x'.repeat(501)), /too long/);

  for (let i = 0; i < 8; i++) room.chat(bob.id, null, `msg ${i}`);
  assert.throws(() => room.chat(bob.id, null, 'one too many'), /too fast/);
  clock.t += 10_001;
  room.chat(bob.id, null, 'calm again');
});

test('message text is cleaned', () => {
  assert.equal(cleanChatText('  hi\r\nthere\n\n\n\nfriend\t!  '), 'hi\nthere\n\nfriend !');
  assert.equal(cleanChatText('a‮b\u0007c'), 'abc');
  assert.equal(cleanChatText('👨‍👩‍👧 привет'), '👨‍👩‍👧 привет');
});

test('deleting a room deletes its chat', () => {
  const { room, alice, mgr, store } = setup();
  room.chat(alice.id, null, 'hello');
  const id = room.row.id;
  mgr.delete(room.code);
  assert.deepEqual(store.chatAll(id, 10), []);
});

// ---------------------------------------------------------------- stickers

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** A sticker folder in a temp dir: a default-pack file, a pack with pack.json, and junk to ignore. */
function stickerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'alliance-stickers-'));
  tempDirs.push(dir);
  // 1×1 PNG and a 3×2 GIF header are enough: the library only reads sizes and hashes.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([3, 0, 2, 0]), Buffer.alloc(20)]);
  writeFileSync(join(dir, 'wave.png'), png);
  writeFileSync(join(dir, 'notes.txt'), 'not a sticker');
  mkdirSync(join(dir, 'war-room'));
  writeFileSync(join(dir, 'war-room', '02-salute.gif'), gif);
  writeFileSync(join(dir, 'war-room', '01-big_deal.png'), png);
  writeFileSync(join(dir, 'war-room', 'huge.png'), Buffer.alloc(STICKER_MAX_BYTES + 1));
  writeFileSync(join(dir, 'war-room', 'pack.json'), JSON.stringify({ title: 'War room', order: 1, cover: '02-salute.gif' }));
  mkdirSync(join(dir, '.hidden'));
  writeFileSync(join(dir, '.hidden', 'x.png'), png);
  return dir;
}

test('the sticker library reads packs, names, sizes and skips what it must', () => {
  const logs: string[] = [];
  const lib = new StickerLibrary(stickerDir(), (m) => logs.push(m));
  lib.scan();
  const { packs } = lib.list();
  assert.deepEqual(packs.map((p) => [p.id, p.title]), [['default', 'Stickers'], ['war-room', 'War room']]);
  const war = packs[1];
  assert.deepEqual(war.stickers.map((s) => [s.id, s.name]), [['war-room/01-big_deal.png', '01 big deal'], ['war-room/02-salute.gif', '02 salute']]);
  assert.equal(war.cover, war.stickers[1].url);
  assert.deepEqual([war.stickers[1].w, war.stickers[1].h], [3, 2]);
  assert.match(war.stickers[0].url, /^\/stickers\/war-room\/01-big_deal\.png\?v=[0-9a-f]{12}$/);
  assert.ok(lib.has('wave.png') && lib.has('war-room/02-salute.gif'));
  assert.ok(!lib.has('war-room/huge.png'), 'files over the size cap are skipped');
  assert.ok(logs.some((l) => l.includes('huge.png')), 'and logged');
  assert.ok(!lib.has('notes.txt') && !lib.has('.hidden/x.png') && !lib.has('../wave.png'));
  assert.equal(lib.file('war-room/02-salute.gif')?.type, 'image/gif');
});

test('sticker messages: validated, stored, broadcast and private like text', () => {
  const { room, alice, bob, carol, ctx, store } = setup();
  const lib = new StickerLibrary(stickerDir());
  lib.scan();
  ctx.stickers = lib;
  const sinks = { alice: new RecordingSink(alice), bob: new RecordingSink(bob), carol: new RecordingSink(carol) };
  for (const s of Object.values(sinks)) room.attach(s);
  const bobPid = room.participantOf(bob.id)!.pid;

  const pub = room.chat(alice.id, null, 'ignored', 'war-room/02-salute.gif');
  assert.equal(pub.sticker, 'war-room/02-salute.gif');
  assert.equal(pub.text, '');
  room.chat(alice.id, bobPid, '', 'wave.png');

  const stickersOf = (sink: RecordingSink) =>
    sink.messages.filter((m): m is Extract<ServerMessage, { type: 'chat' }> => m.type === 'chat').flatMap((m) => m.messages.map((c) => c.sticker));
  assert.deepEqual(stickersOf(sinks.bob), ['war-room/02-salute.gif', 'wave.png']);
  assert.deepEqual(stickersOf(sinks.carol), ['war-room/02-salute.gif'], 'a private sticker stays private');

  // Persisted: history after reconnecting has them, plain text messages have no sticker field.
  room.chat(alice.id, null, 'plain');
  const again = new RecordingSink(bob);
  room.attach(again);
  const history = (again.messages.at(-1) as Extract<ServerMessage, { type: 'chat' }>).messages;
  assert.deepEqual(history.map((m) => m.sticker ?? m.text), ['war-room/02-salute.gif', 'wave.png', 'plain']);
  assert.equal('sticker' in history[2], false);
  assert.equal(store.chatAll(room.row.id, 10)[1].sticker, 'wave.png');

  // Unknown ids, path tricks and wrong types are refused.
  for (const bad of ['nope.png', '../wave.png', 'war-room/huge.png', 42, '']) {
    assert.throws(() => room.chat(alice.id, null, 'x', bad), /sticker is not available/);
  }
  // The flood limit counts stickers too.
  for (let i = 0; i < 8; i++) room.chat(bob.id, null, '', 'wave.png');
  assert.throws(() => room.chat(bob.id, null, '', 'wave.png'), /too fast/);
});

test('an old database without the sticker column is migrated and keeps its rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alliance-db-'));
  tempDirs.push(dir);
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE rooms (id INTEGER PRIMARY KEY);
    CREATE TABLE chat (id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL, ts INTEGER NOT NULL, from_pid INTEGER NOT NULL,
      from_name TEXT NOT NULL, to_pid INTEGER, text TEXT NOT NULL);
    INSERT INTO rooms (id) VALUES (1);
    INSERT INTO chat (room_id, ts, from_pid, from_name, to_pid, text) VALUES (1, 5, 1, 'old', NULL, 'from before stickers');`);
  old.close();
  const store = new Store(path);
  store.insertChat(1, { ts: 6, from: 1, fromName: 'old', to: null, text: '', sticker: 'wave.png' });
  assert.deepEqual(
    store.chatAll(1, 10).map((m) => [m.text, m.sticker]),
    [['from before stickers', undefined], ['', 'wave.png']],
  );
  store.close();
});
