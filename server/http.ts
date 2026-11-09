// HTTP: a small JSON API (accounts, room list, room creation), flag images, and the
// built browser client (with a single-page-app fallback for /r/<code> links).

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { Auth, AuthError } from './auth.ts';
import { FLAG_CODES, FLAGS, FLAGS_DIR } from './flags.ts';
import { RoomError } from './room.ts';
import type { RoomManager } from './rooms.ts';
import type { StickerLibrary } from './stickers.ts';
import type { UserRow } from './db.ts';
import { ProfileError, type Profiles } from './profile.ts';
import { AVATAR_MAX_BYTES } from '../shared/profile.ts';

export interface HttpDeps {
  auth: Auth;
  rooms: RoomManager;
  /** Chat stickers; without it /api/stickers is empty and /stickers/* is 404. */
  stickers?: StickerLibrary;
  /** Player profiles; without it /api/profile* is 404 and /api/me has no profile. */
  profiles?: Profiles;
  staticDir: string;
  /** Behind a reverse proxy (Railway, nginx...): take the client IP from X-Forwarded-For. */
  trustProxy?: boolean;
  log: (msg: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Sliding-window limiter for login/registration attempts per IP. */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  allow(key: string): boolean {
    const now = Date.now();
    if (this.hits.size > 1000) this.prune(now);
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
  /** Forgets keys with no hits inside the window, so the map doesn't grow forever. */
  private prune(now: number): void {
    for (const [key, list] of this.hits) {
      if (list.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024) throw new HttpError(413, 'Request too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/**
 * The client's IP. Behind a proxy that is X-Real-IP (set by the proxy, replacing anything the
 * client sent), or else the last X-Forwarded-For entry: the one the proxy itself appended
 * (earlier entries come from the client and can be forged).
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return real.trim();
    const fwd = req.headers['x-forwarded-for'];
    const last = fwd ? (Array.isArray(fwd) ? fwd.join(',') : fwd).split(',').pop()?.trim() : undefined;
    if (last) return last;
  }
  return req.socket.remoteAddress ?? '?';
}

/** A raw request body (avatar upload), refused early when it is over `max` bytes. */
async function readBinary(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    req.resume();
    throw new HttpError(413, `The image is too large (max ${Math.round(max / 1024)} KB)`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, `The image is too large (max ${Math.round(max / 1024)} KB)`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

export function createHttpServer(deps: HttpDeps): Server {
  const authLimiter = new RateLimiter(30, 10 * 60 * 1000);
  const avatarLimiter = new RateLimiter(12, 10 * 60 * 1000);
  const profileLimiter = new RateLimiter(60, 10 * 60 * 1000);
  const staticRoot = resolve(deps.staticDir);

  function requireUser(req: IncomingMessage): UserRow {
    const user = deps.auth.userByToken(bearer(req));
    if (!user) throw new HttpError(401, 'Please log in');
    return user;
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    const ip = clientIp(req, deps.trustProxy ?? false);

    if (method === 'POST' && (path === '/api/register' || path === '/api/login')) {
      if (!authLimiter.allow(ip)) throw new HttpError(429, 'Too many attempts, try again in a few minutes');
      const body = await readJson(req);
      const result =
        path === '/api/register'
          ? await deps.auth.register(body.username, body.password)
          : await deps.auth.login(body.username, body.password);
      return sendJson(res, 200, result);
    }
    if (method === 'POST' && path === '/api/logout') {
      const token = bearer(req);
      if (token) deps.auth.logout(token);
      return sendJson(res, 200, {});
    }
    if (method === 'GET' && path === '/api/me') {
      const user = requireUser(req);
      const profile = deps.profiles ? { ...deps.profiles.publicOf(user), updatedAt: user.profile_updated_at ?? null } : undefined;
      return sendJson(res, 200, { user: { id: user.id, username: user.username }, profile });
    }
    if (deps.profiles && path.startsWith('/api/profile')) {
      const profiles = deps.profiles;
      const user = requireUser(req);
      if (path === '/api/profile' && method === 'PATCH') {
        if (!profileLimiter.allow(`u${user.id}`)) throw new HttpError(429, 'Too many changes, try again in a few minutes');
        const body = await readJson(req);
        return sendJson(res, 200, { profile: profiles.update(user.id, body) });
      }
      if (path === '/api/profile/avatar' && method === 'POST') {
        if (!avatarLimiter.allow(`u${user.id}`)) throw new HttpError(429, 'Too many uploads, try again in a few minutes');
        const buf = await readBinary(req, AVATAR_MAX_BYTES);
        const profile = profiles.setAvatar(user.id, buf);
        deps.log(`avatar of ${user.username} set to ${profile.avatarUrl}`);
        return sendJson(res, 200, { profile });
      }
      if (path === '/api/profile/avatar' && method === 'DELETE') {
        return sendJson(res, 200, { profile: profiles.removeAvatar(user.id) });
      }
      if (path === '/api/profile' && method === 'GET') return sendJson(res, 200, { profile: profiles.mine(user.id) });
      throw new HttpError(404, 'Not found');
    }
    const profileMatch = /^\/api\/users\/([^/]{1,64})\/profile$/.exec(path);
    if (deps.profiles && method === 'GET' && profileMatch) {
      requireUser(req);
      let name: string;
      try {
        name = decodeURIComponent(profileMatch[1]);
      } catch {
        throw new HttpError(400, 'Bad username');
      }
      return sendJson(res, 200, { profile: deps.profiles.byUsername(name) });
    }
    if (method === 'GET' && path === '/api/rooms') {
      const user = requireUser(req);
      return sendJson(res, 200, deps.rooms.listFor(user.id));
    }
    if (method === 'POST' && path === '/api/rooms') {
      const user = requireUser(req);
      const body = await readJson(req);
      const room = deps.rooms.create({ id: user.id, username: user.username }, body.name);
      deps.log(`room ${room.code} "${room.row.name}" created by ${user.username}`);
      return sendJson(res, 200, { code: room.code });
    }
    if (method === 'GET' && path === '/api/stickers') {
      return sendJson(res, 200, deps.stickers?.list() ?? { packs: [] });
    }
    if (method === 'GET' && path === '/api/flags') {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return sendJson(res, 200, FLAGS);
    }
    throw new HttpError(404, 'Not found');
  }

  function serveFile(res: ServerResponse, file: string, cache: string): void {
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': cache,
      'Content-Length': statSync(file).size,
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(file).pipe(res);
  }

  function serveFlag(res: ServerResponse, path: string): void {
    const m = /^\/flags\/(1x1|4x3)\/([a-z-]+)\.svg$/.exec(path);
    if (!m || !FLAG_CODES.has(m[2])) throw new HttpError(404, 'Not found');
    serveFile(res, join(FLAGS_DIR, m[1], `${m[2]}.svg`), 'public, max-age=604800');
  }

  /** /avatars/<hash>.<ext>: content-addressed, so cached forever; the name pattern keeps paths safe. */
  function serveAvatar(req: IncomingMessage, res: ServerResponse, path: string): void {
    const name = path.slice('/avatars/'.length);
    const f = deps.profiles?.avatarStore.file(name);
    if (!f || (req.method !== 'GET' && req.method !== 'HEAD')) throw new HttpError(404, 'Not found');
    const etag = `"${name.slice(0, 32)}"`;
    const headers = {
      'Content-Type': f.type,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': f.size });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(f.path).on('error', () => res.destroy()).pipe(res);
  }

  /** /stickers/<pack>/<file>: only files in the sticker index, so nothing else on disk is reachable. */
  function serveSticker(req: IncomingMessage, res: ServerResponse, path: string, query: string): void {
    let id: string;
    try {
      id = decodeURIComponent(path.slice('/stickers/'.length));
    } catch {
      throw new HttpError(400, 'Bad path');
    }
    const f = deps.stickers?.file(id);
    if (!f || (req.method !== 'GET' && req.method !== 'HEAD')) throw new HttpError(404, 'Not found');
    // A URL with the right ?v=<content hash> never changes; anything else revalidates daily.
    const versioned = new URLSearchParams(query).get('v') === f.hash;
    const headers = {
      'Content-Type': f.type,
      'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=86400',
      ETag: f.etag,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };
    if (req.headers['if-none-match'] === f.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    let size: number;
    try {
      size = statSync(f.path).size;
    } catch {
      throw new HttpError(404, 'Not found');
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(f.path).on('error', () => res.destroy()).pipe(res);
  }

  function serveStatic(res: ServerResponse, path: string): void {
    const index = join(staticRoot, 'index.html');
    if (!existsSync(index)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('The browser client is not built yet. Run "npm run build" (Docker does this for you).');
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw new HttpError(400, 'Bad path');
    }
    const file = resolve(staticRoot, '.' + decoded);
    if ((file === staticRoot || file.startsWith(staticRoot + sep)) && existsSync(file) && statSync(file).isFile()) {
      const cache = decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      return serveFile(res, file, cache);
    }
    if (extname(decoded) === '' || decoded.startsWith('/r/')) return serveFile(res, index, 'no-cache');
    throw new HttpError(404, 'Not found');
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    const work = path.startsWith('/api/')
      ? api(req, res, path)
      : Promise.resolve().then(() =>
          path.startsWith('/flags/')
            ? serveFlag(res, path)
            : path.startsWith('/stickers/')
              ? serveSticker(req, res, path, url.search)
              : path.startsWith('/avatars/')
                ? serveAvatar(req, res, path)
                : serveStatic(res, path),
        );
    work.catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError || err instanceof AuthError || err instanceof ProfileError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof RoomError) return sendJson(res, 400, { error: err.message });
      deps.log(`HTTP ${req.method} ${path} failed: ${(err as Error).stack ?? err}`);
      sendJson(res, 500, { error: 'Server error' });
    });
  });
}
