// Accounts and login sessions. Passwords are stored as scrypt hashes; session tokens are
// random and only their SHA-256 hash is kept in the database.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { AuthResponse } from '../shared/protocol.ts';
import type { Store, UserRow } from './db.ts';

function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltHex, keyHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const key = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function validateUsername(username: unknown): string | null {
  if (typeof username !== 'string') return 'Username is required';
  if (!/^[A-Za-z0-9_.-]{3,20}$/.test(username)) {
    return 'Username must be 3-20 characters: letters, digits, _ . -';
  }
  return null;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 6) return 'Password must be at least 6 characters';
  if (password.length > 200) return 'Password is too long';
  return null;
}

/** A session that goes unused this long is expired; using it pushes the expiry forward. */
export const SESSION_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export class Auth {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
    store.deleteSessionsBefore(now() - SESSION_IDLE_MS);
  }

  async createUser(username: unknown, password: unknown): Promise<UserRow> {
    const uErr = validateUsername(username);
    if (uErr) throw new AuthError(uErr);
    const pErr = validatePassword(password);
    if (pErr) throw new AuthError(pErr);
    const name = username as string;
    if (this.store.userByName(name)) throw new AuthError('That username is taken', 409);
    const hash = await hashPassword(password as string);
    try {
      return this.store.createUser(name, hash, this.now());
    } catch {
      throw new AuthError('That username is taken', 409);
    }
  }

  async register(username: unknown, password: unknown): Promise<AuthResponse> {
    const user = await this.createUser(username, password);
    return this.issueSession(user);
  }

  async login(username: unknown, password: unknown): Promise<AuthResponse> {
    if (typeof username !== 'string' || typeof password !== 'string') throw new AuthError('Wrong username or password', 401);
    const user = this.store.userByName(username);
    if (!user || !(await verifyPassword(password, user.pass_hash))) {
      throw new AuthError('Wrong username or password', 401);
    }
    return this.issueSession(user);
  }

  logout(token: string): void {
    this.store.deleteSession(hashToken(token));
  }

  userByToken(token: unknown): UserRow | undefined {
    if (typeof token !== 'string' || token.length < 10 || token.length > 200) return undefined;
    const now = this.now();
    const hash = hashToken(token);
    const row = this.store.userBySession(hash, now - SESSION_IDLE_MS);
    if (!row) return undefined;
    // Refresh at most once a day, so lookups don't turn into a write each time.
    if (now - row.session_at > SESSION_REFRESH_MS) this.store.touchSession(hash, now);
    const { session_at: _, ...user } = row;
    return user;
  }

  async setPassword(username: string, password: string): Promise<void> {
    const user = this.store.userByName(username);
    if (!user) throw new AuthError(`No user "${username}"`, 404);
    const pErr = validatePassword(password);
    if (pErr) throw new AuthError(pErr);
    this.store.setPassword(user.id, await hashPassword(password));
    this.store.deleteUserSessions(user.id);
  }

  private issueSession(user: UserRow): AuthResponse {
    const token = randomBytes(32).toString('base64url');
    this.store.createSession(hashToken(token), user.id, this.now());
    return { token, user: { id: user.id, username: user.username } };
  }
}
