// Server startup options. Every option has a command-line flag and most have an
// environment variable, so Docker and local runs can be configured the same way.

import { dirname, join, resolve } from 'node:path';

export function defaultAdminSocket(): string {
  if (process.env.ALLIANCE_ADMIN_SOCKET) return process.env.ALLIANCE_ADMIN_SOCKET;
  return process.platform === 'win32' ? '\\\\.\\pipe\\alliance-admin' : '/tmp/alliance-admin.sock';
}

export interface ServerOptions {
  port: number;
  host: string;
  db: string;
  adminSocket: string;
  staticDir: string;
  /** Folder of chat sticker images (see stickers/README.md). */
  stickersDir: string;
  /** Uploaded profile pictures; defaults to avatars/ next to the database (the data volume). */
  avatarsDir: string;
  testMode: boolean;
  trustProxy: boolean;
  /** Overrides for the default settings of new rooms (`--set key=value`). */
  overrides: Record<string, string>;
  help: boolean;
}

export const SERVER_HELP = `Alliance game server

Usage: node server/main.ts [options]

Options:
  --port <n>            HTTP/WebSocket port (env PORT, default 8080)
  --host <addr>         Address to bind (env HOST, default 0.0.0.0)
  --db <path>           SQLite database file (env ALLIANCE_DB, default ./data/alliance.db)
  --admin-socket <path> Socket the admin CLI talks to (env ALLIANCE_ADMIN_SOCKET)
  --static <dir>        Built browser client (default ./dist/client)
  --stickers <dir>      Chat sticker images (env ALLIANCE_STICKERS, default ./stickers)
  --avatars <dir>       Uploaded profile pictures (env ALLIANCE_AVATARS,
                        default: an avatars folder next to the database)
  --test-mode           New rooms tick AP every 30 s and their lobby lasts 10 min
  --trust-proxy         Behind a reverse proxy: rate-limit by X-Real-IP / X-Forwarded-For
                        (env TRUST_PROXY=1; automatic on Railway)
  --set key=value       Default setting for new rooms; repeatable
                        (e.g. --set tickIntervalSec=10 --set startHp=5)
  --help                Show this help

Settings for existing rooms are changed with the admin CLI:  alliance set <room> key=value
`;

export function parseServerArgs(argv: string[]): ServerOptions {
  const opts: ServerOptions = {
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? '0.0.0.0',
    db: process.env.ALLIANCE_DB ?? './data/alliance.db',
    adminSocket: defaultAdminSocket(),
    staticDir: './dist/client',
    stickersDir: process.env.ALLIANCE_STICKERS ?? './stickers',
    avatarsDir: process.env.ALLIANCE_AVATARS ?? '',
    testMode: process.env.ALLIANCE_TEST_MODE === '1',
    // Railway always runs the app behind its proxy (RAILWAY_ENVIRONMENT_ID is set there).
    trustProxy: process.env.TRUST_PROXY === '1' || process.env.RAILWAY_ENVIRONMENT_ID !== undefined,
    overrides: {},
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--port':
        opts.port = Number(value());
        break;
      case '--host':
        opts.host = value();
        break;
      case '--db':
        opts.db = value();
        break;
      case '--admin-socket':
        opts.adminSocket = value();
        break;
      case '--static':
        opts.staticDir = value();
        break;
      case '--stickers':
        opts.stickersDir = value();
        break;
      case '--avatars':
        opts.avatarsDir = value();
        break;
      case '--test-mode':
        opts.testMode = true;
        break;
      case '--trust-proxy':
        opts.trustProxy = true;
        break;
      case '--set': {
        const v = value();
        const eq = v.indexOf('=');
        if (eq <= 0) throw new Error(`--set expects key=value, got "${v}"`);
        opts.overrides[v.slice(0, eq)] = v.slice(eq + 1);
        break;
      }
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option "${arg}" (see --help)`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) throw new Error('Invalid --port');
  opts.staticDir = resolve(opts.staticDir);
  opts.stickersDir = resolve(opts.stickersDir);
  opts.avatarsDir = resolve(opts.avatarsDir || join(opts.db === ':memory:' ? '.' : dirname(opts.db), 'avatars'));
  return opts;
}
