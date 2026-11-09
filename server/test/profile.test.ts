// Profile tests: field validation, Telegram normalization, avatar checks (magic bytes, size,
// cleanup), migration of an old database, room defaults and the HTTP endpoints.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { parseBio, parseDisplayName, parseTelegram, telegramUrl } from '../../shared/profile.ts';
import type { MeResponse, MyProfile, PublicProfile } from '../../shared/protocol.ts';
import { Auth } from '../auth.ts';
import { Store } from '../db.ts';
import { createHttpServer } from '../http.ts';
import { AvatarStore, ProfileError, Profiles, sniffAvatar } from '../profile.ts';
import { RoomManager } from '../rooms.ts';
import { makeEnv, RecordingSink } from './helpers.ts';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'alliance-profile-'));
  tempDirs.push(d);
  return d;
}

/** A real (tiny, valid) PNG of the given size. */
function png(w: number, h: number, seed = 0): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h, seed);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('telegram handles are normalized from any common form and validated', () => {
  for (const input of ['@alliance_bot', 'alliance_bot', 't.me/alliance_bot', 'https://t.me/alliance_bot', 'http://telegram.me/alliance_bot/', ' https://www.t.me/alliance_bot?start=1 ']) {
    assert.deepEqual(parseTelegram(input), { ok: true, value: 'alliance_bot' }, input);
  }
  assert.deepEqual(parseTelegram(''), { ok: true, value: null });
  assert.deepEqual(parseTelegram(null), { ok: true, value: null });
  for (const bad of ['abc', '@abcd', 'a'.repeat(33), '1alliance', '_alliance', 'alliance_', 'all-iance', 'allïance', 't.me/', 'https://t.me/a b c', 42]) {
    assert.equal(parseTelegram(bad).ok, false, String(bad));
  }
  assert.ok(parseTelegram('a'.repeat(32)).ok);
  assert.equal(telegramUrl('alliance_bot'), 'https://t.me/alliance_bot');
});

test('display name and bio are cleaned and length-checked', () => {
  assert.deepEqual(parseDisplayName('  Grand   Vizier  '), { ok: true, value: 'Grand Vizier' });
  assert.deepEqual(parseDisplayName('Zar\u202e\u0007ina'), { ok: true, value: 'Zarina' });
  assert.deepEqual(parseDisplayName('   '), { ok: true, value: null });
  assert.equal(parseDisplayName('x'.repeat(24)).ok, true);
  assert.equal(parseDisplayName('x'.repeat(25)).ok, false);
  assert.equal(parseDisplayName(5).ok, false);
  assert.deepEqual(parseBio('line one  \r\n\r\n\r\n\r\nline two\u0000'), { ok: true, value: 'line one\n\nline two' });
  assert.equal(parseBio('b'.repeat(300)).ok, true);
  assert.equal(parseBio('b'.repeat(301)).ok, false);
});

test('avatars: only PNG/JPEG/WebP by magic bytes, size-limited, deduplicated and cleaned up', () => {
  const dir = tempDir();
  const env = makeEnv();
  const profiles = new Profiles(env.store, new AvatarStore(dir), env.ctx.now);
  const changed: number[] = [];
  profiles.onAvatarChange = (id) => changed.push(id);
  const alice = env.user('alice');
  const bob = env.user('bob');

  assert.equal(sniffAvatar(png(64, 64)), 'png');
  assert.equal(sniffAvatar(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
  assert.equal(sniffAvatar(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'binary')), 'webp');
  assert.equal(sniffAvatar(Buffer.from('GIF89a......')), null);
  assert.equal(sniffAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);

  const rejects = (buf: Buffer, status: number): void => {
    assert.throws(() => profiles.setAvatar(alice.id, buf), (e: unknown) => e instanceof ProfileError && e.status === status);
  };
  rejects(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 415);
  rejects(Buffer.from('GIF89a\x10\x00\x10\x00'), 415);
  rejects(Buffer.alloc(0), 400);
  rejects(Buffer.concat([png(64, 64), Buffer.alloc(300 * 1024)]), 413);
  rejects(png(4096, 4), 400); // not what our cropper makes
  assert.deepEqual(readdirSync(dir).filter((f) => !f.endsWith('.tmp')), [], 'nothing written for rejected uploads');

  const first = profiles.setAvatar(alice.id, png(256, 256, 1));
  assert.match(first.avatarUrl ?? '', /^\/avatars\/[0-9a-f]{32}\.png$/);
  const firstFile = first.avatarUrl!.slice('/avatars/'.length);
  assert.ok(existsSync(join(dir, firstFile)));
  // Bob uploads the same picture: one shared file.
  assert.equal(profiles.setAvatar(bob.id, png(256, 256, 1)).avatarUrl, first.avatarUrl);
  // Alice replaces hers: the old file stays while Bob still uses it...
  const second = profiles.setAvatar(alice.id, png(256, 256, 2));
  assert.notEqual(second.avatarUrl, first.avatarUrl);
  assert.ok(existsSync(join(dir, firstFile)));
  // ...and goes once nobody does.
  profiles.removeAvatar(bob.id);
  assert.ok(!existsSync(join(dir, firstFile)));
  profiles.removeAvatar(alice.id);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(profiles.mine(alice.id).avatarUrl, null);
  assert.deepEqual(changed, [alice.id, bob.id, alice.id, bob.id, alice.id]);

  // Served file names are strictly the hash pattern: no paths.
  const store = new AvatarStore(dir);
  assert.equal(store.file('../db.sqlite'), undefined);
  assert.equal(store.file('..%2f..%2fetc%2fpasswd'), undefined);
});

test('profile updates change only the given fields; bad values are refused', () => {
  const env = makeEnv();
  const profiles = new Profiles(env.store, new AvatarStore(tempDir()), env.ctx.now);
  const u = env.user('carol');
  let p = profiles.update(u.id, { displayName: ' Carol of Arc ', bio: 'Never trust a neighbour.', telegram: 'https://t.me/carol_arc' });
  assert.equal(p.displayName, 'Carol of Arc');
  assert.equal(p.telegram, 'carol_arc');
  assert.equal(p.updatedAt, env.clock.t);
  p = profiles.update(u.id, { telegram: '' });
  assert.equal(p.telegram, null);
  assert.equal(p.displayName, 'Carol of Arc', 'untouched fields stay');
  assert.throws(() => profiles.update(u.id, { telegram: 'abc' }), ProfileError);
  assert.throws(() => profiles.update(u.id, { displayName: 'x'.repeat(30) }), ProfileError);
  assert.equal(profiles.mine(u.id).displayName, 'Carol of Arc', 'a refused update changes nothing');
  assert.equal(profiles.byUsername('CAROL').username, 'carol');
  assert.throws(() => profiles.byUsername('nobody'), (e: unknown) => e instanceof ProfileError && e.status === 404);
});

test('an old database without profile columns is migrated and keeps its users', () => {
  const path = join(tempDir(), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO users (username, pass_hash, created_at) VALUES ('veteran', 'scrypt$00$00', 1000);`);
  old.close();
  const store = new Store(path);
  const row = store.userByName('veteran');
  assert.equal(row?.created_at, 1000);
  assert.equal(row?.display_name, null);
  assert.equal(row?.avatar, null);
  store.updateProfile(row!.id, { display_name: 'Old Guard', bio: null, telegram: null }, 2000);
  store.close();
  // Opening it again (columns already there) is a no-op.
  const again = new Store(path);
  assert.equal(again.userByName('veteran')?.display_name, 'Old Guard');
  again.close();
});

test('rooms: the display name is the default nickname; players carry username and avatar', () => {
  const env = makeEnv();
  const profiles = new Profiles(env.store, new AvatarStore(tempDir()), env.ctx.now);
  const mgr = new RoomManager(env.ctx);
  profiles.onAvatarChange = (id) => mgr.refreshUser(id);
  const alice = env.user('alice');
  const bob = env.user('bob');
  const dave = env.user('dave');
  profiles.update(bob.id, { displayName: 'Bobby the Magnificent' }); // 21 chars: fine as a display name, cut to 20 for a nickname
  profiles.update(dave.id, { displayName: 'alice' }); // collides with alice's nickname → made unique
  const room = mgr.create(alice, 'Profiles');
  room.join(bob);
  room.join(dave);
  const names = [...room.players.values()].map((p) => p.nickname);
  assert.deepEqual(names, ['alice', 'Bobby the Magnificen', 'alice2']);

  const sink = new RecordingSink(alice);
  room.attach(sink);
  const before = sink.lastStateMsg()!;
  assert.deepEqual(before.players.map((p) => p.username), ['alice', 'bob', 'dave']);
  assert.ok(before.players.every((p) => p.avatar === undefined));

  // A new avatar reaches open rooms right away.
  profiles.setAvatar(bob.id, png(256, 256, 3));
  const after = sink.lastStateMsg()!;
  assert.match(after.players[1].avatar ?? '', /^\/avatars\/[0-9a-f]{32}\.png$/);

  // A room nickname set by hand stays, whatever the profile says later.
  room.setProfile(bob.id, 'Bob', undefined);
  profiles.update(bob.id, { displayName: 'Robert' });
  assert.equal(room.participantOf(bob.id)?.nickname, 'Bob');
});

test('HTTP: /api/me, PATCH /api/profile, avatar upload/removal, public profiles, /avatars', async () => {
  const dir = tempDir();
  const env = makeEnv();
  const auth = new Auth(env.store, env.ctx.now);
  const profiles = new Profiles(env.store, new AvatarStore(dir), env.ctx.now);
  const mgr = new RoomManager(env.ctx);
  const server = createHttpServer({ auth, rooms: mgr, profiles, staticDir: dir, log: () => undefined });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { token } = await auth.register('erin', 'secret123');
    const headers = { Authorization: `Bearer ${token}` };
    const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

    const me = await json<MeResponse>(await fetch(`${base}/api/me`, { headers }));
    assert.equal(me.user.username, 'erin');
    assert.equal(me.profile.displayName, null);

    assert.equal((await fetch(`${base}/api/profile`, { method: 'PATCH', body: '{}' })).status, 401, 'writes need a login');
    let res = await fetch(`${base}/api/profile`, { method: 'PATCH', headers, body: JSON.stringify({ displayName: 'Erin', telegram: '@erin_tg' }) });
    assert.equal(res.status, 200);
    assert.equal((await json<{ profile: MyProfile }>(res)).profile.telegram, 'erin_tg');
    res = await fetch(`${base}/api/profile`, { method: 'PATCH', headers, body: JSON.stringify({ telegram: 'no' }) });
    assert.equal(res.status, 400);

    res = await fetch(`${base}/api/profile/avatar`, { method: 'POST', headers, body: new Uint8Array(Buffer.from('<svg/>')) });
    assert.equal(res.status, 415);
    res = await fetch(`${base}/api/profile/avatar`, { method: 'POST', headers, body: new Uint8Array(Buffer.alloc(400 * 1024, 1)) });
    assert.equal(res.status, 413);
    const img = png(256, 256, 9);
    res = await fetch(`${base}/api/profile/avatar`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: new Uint8Array(img) });
    assert.equal(res.status, 200);
    const url = (await json<{ profile: MyProfile }>(res)).profile.avatarUrl!;

    const file = await fetch(`${base}${url}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.match(file.headers.get('cache-control') ?? '', /immutable/);
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), img);
    assert.equal((await fetch(`${base}/avatars/..%2F..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${base}/avatars/0123456789abcdef0123456789abcdef.png`)).status, 404);

    assert.equal((await fetch(`${base}/api/users/erin/profile`)).status, 401);
    const pub = (await json<{ profile: PublicProfile & Record<string, unknown> }>(await fetch(`${base}/api/users/ERIN/profile`, { headers }))).profile;
    assert.deepEqual(
      { ...pub, joinedAt: 0 },
      { username: 'erin', displayName: 'Erin', bio: null, telegram: 'erin_tg', avatarUrl: url, joinedAt: 0, games: 0, wins: 0 },
    );
    assert.equal((await fetch(`${base}/api/users/ghost/profile`, { headers })).status, 404);

    res = await fetch(`${base}/api/profile/avatar`, { method: 'DELETE', headers });
    assert.equal((await json<{ profile: MyProfile }>(res)).profile.avatarUrl, null);
    assert.equal((await fetch(`${base}${url}`)).status, 404);
  } finally {
    server.close();
  }
});
