// HTTP: a small JSON API (accounts, room list, room creation), flag images, and the
// built browser client (with a single-page-app fallback for /r/<code> links).

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { Auth, AuthError } from './auth.ts';
import { FLAG_CODES, FLAGS, FLAGS_DIR } from './flags.ts';
import { RoomError } from './room.ts';
import type { RoomManager } from './rooms.ts';
import type { UserRow } from './db.ts';

export interface HttpDeps {
  auth: Auth;
  rooms: RoomManager;
  staticDir: string;
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
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
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

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

export function createHttpServer(deps: HttpDeps): Server {
  const authLimiter = new RateLimiter(30, 10 * 60 * 1000);
  const staticRoot = resolve(deps.staticDir);

  function requireUser(req: IncomingMessage): UserRow {
    const user = deps.auth.userByToken(bearer(req));
    if (!user) throw new HttpError(401, 'Please log in');
    return user;
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    const ip = req.socket.remoteAddress ?? '?';

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
      return sendJson(res, 200, { user: { id: user.id, username: user.username } });
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
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    const work = path.startsWith('/api/')
      ? api(req, res, path)
      : Promise.resolve().then(() => (path.startsWith('/flags/') ? serveFlag(res, path) : serveStatic(res, path)));
    work.catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError || err instanceof AuthError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof RoomError) return sendJson(res, 400, { error: err.message });
      deps.log(`HTTP ${req.method} ${path} failed: ${(err as Error).stack ?? err}`);
      sendJson(res, 500, { error: 'Server error' });
    });
  });
}
