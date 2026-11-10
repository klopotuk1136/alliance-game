// Player profiles: display name, bio, Telegram handle and avatar on top of the account.
// The username stays the login and never changes. Avatars are cropped and resized in the
// browser (there are no image libraries here); the server only checks what arrives (type by
// magic bytes, size, dimensions) and stores it by content hash in the data folder next to
// the database, so it survives rebuilds of the app image.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AVATAR_MAX_BYTES, AVATAR_SIZE, parseBio, parseDisplayName, parseTelegram } from '../shared/profile.ts';
import type { MyProfile, PublicProfile } from '../shared/protocol.ts';
import type { ProfileFields, Store, UserRow } from './db.ts';
import { imageSize } from './stickers.ts';

export class ProfileError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const AVATAR_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};
/** Uploads are meant to be 256×256; anything far bigger is not from our cropper. */
const AVATAR_MAX_SIDE = AVATAR_SIZE * 4;
/** Stored file names: 32 hex characters of SHA-256 plus the type's extension. */
export const AVATAR_FILE = /^[0-9a-f]{32}\.(png|jpg|webp)$/;

/** The image type by its first bytes (never by name or Content-Type); null if not PNG/JPEG/WebP. */
export function sniffAvatar(buf: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function avatarUrl(file: string | null | undefined): string | null {
  return file ? `/avatars/${file}` : null;
}

/** Avatar files on disk, named by content hash. */
export class AvatarStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Validates an upload and writes it; returns the stored file name. */
  save(buf: Buffer): string {
    if (buf.length === 0) throw new ProfileError('The image is empty');
    if (buf.length > AVATAR_MAX_BYTES) throw new ProfileError(`The image is too large (max ${Math.round(AVATAR_MAX_BYTES / 1024)} KB)`, 413);
    const ext = sniffAvatar(buf);
    if (!ext) throw new ProfileError('Only PNG, JPEG or WebP images can be used', 415);
    const size = imageSize(buf);
    if (!size || size.w < 16 || size.h < 16 || size.w > AVATAR_MAX_SIDE || size.h > AVATAR_MAX_SIDE) {
      throw new ProfileError('The image could not be read or has an unexpected size');
    }
    const name = `${createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${ext}`;
    const path = join(this.dir, name);
    if (!existsSync(path)) {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, path);
    }
    return name;
  }

  /** Absolute path of a stored avatar, or undefined (bad name or missing file). */
  file(name: string): { path: string; type: string; size: number } | undefined {
    if (!AVATAR_FILE.test(name)) return undefined;
    const path = join(this.dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) return undefined;
      return { path, type: AVATAR_TYPES[name.slice(name.lastIndexOf('.') + 1)], size: st.size };
    } catch {
      return undefined;
    }
  }

  remove(name: string): void {
    if (!AVATAR_FILE.test(name)) return;
    rmSync(join(this.dir, name), { force: true });
  }
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new ProfileError(r.error);
  return r.value;
}

export class Profiles {
  private readonly store: Store;
  private readonly avatars: AvatarStore;
  private readonly now: () => number;
  /** Called after a change that rooms show (avatar), so open rooms can refresh. */
  onAvatarChange: (userId: number) => void = () => undefined;

  constructor(store: Store, avatars: AvatarStore, now: () => number) {
    this.store = store;
    this.avatars = avatars;
    this.now = now;
  }

  get avatarStore(): AvatarStore {
    return this.avatars;
  }

  publicOf(user: UserRow): PublicProfile {
    const stats = this.store.userStats(user.id);
    const rated = this.store.ratingStats(user.id);
    return {
      username: user.username,
      displayName: user.display_name ?? null,
      bio: user.bio ?? null,
      telegram: user.telegram ?? null,
      avatarUrl: avatarUrl(user.avatar),
      joinedAt: user.created_at,
      games: stats.games,
      wins: stats.wins,
      rating: rated.rating,
      ratedGames: rated.ratedGames,
      winPoints: rated.winPoints,
    };
  }

  mine(userId: number): MyProfile {
    const user = this.store.userById(userId);
    if (!user) throw new ProfileError('No such user', 404);
    return { ...this.publicOf(user), updatedAt: user.profile_updated_at ?? null };
  }

  byUsername(username: string): PublicProfile {
    const user = this.store.userByName(username);
    if (!user) throw new ProfileError('No such player', 404);
    return this.publicOf(user);
  }

  /** Changes only the fields present in `body`; null or "" clears a field. */
  update(userId: number, body: Record<string, unknown>): MyProfile {
    const user = this.store.userById(userId);
    if (!user) throw new ProfileError('No such user', 404);
    const next: ProfileFields = { display_name: user.display_name, bio: user.bio, telegram: user.telegram };
    if ('displayName' in body) next.display_name = unwrap(parseDisplayName(body.displayName));
    if ('bio' in body) next.bio = unwrap(parseBio(body.bio));
    if ('telegram' in body) next.telegram = unwrap(parseTelegram(body.telegram));
    this.store.updateProfile(userId, next, this.now());
    return this.mine(userId);
  }

  setAvatar(userId: number, buf: Buffer): MyProfile {
    const user = this.store.userById(userId);
    if (!user) throw new ProfileError('No such user', 404);
    const name = this.avatars.save(buf);
    this.store.setAvatar(userId, name, this.now());
    if (user.avatar && user.avatar !== name) this.dropIfUnused(user.avatar);
    this.onAvatarChange(userId);
    return this.mine(userId);
  }

  removeAvatar(userId: number): MyProfile {
    const user = this.store.userById(userId);
    if (!user) throw new ProfileError('No such user', 404);
    if (user.avatar) {
      this.store.setAvatar(userId, null, this.now());
      this.dropIfUnused(user.avatar);
      this.onAvatarChange(userId);
    }
    return this.mine(userId);
  }

  private dropIfUnused(name: string): void {
    if (this.store.avatarUsers(name) === 0) this.avatars.remove(name);
  }
}
