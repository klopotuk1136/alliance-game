// Server entry point:  node server/main.ts [--test-mode] [--port 8080] [--db path] ...

import { randomInt } from 'node:crypto';
import { startAdminServer } from './admin.ts';
import { Auth } from './auth.ts';
import { parseServerArgs, SERVER_HELP } from './config.ts';
import { Store } from './db.ts';
import { FLAG_CODES } from './flags.ts';
import { createHttpServer } from './http.ts';
import { RoomManager } from './rooms.ts';
import { attachWebSocket } from './ws.ts';
import { TEST_MODE_SETTINGS } from '../shared/settings.ts';

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

let opts;
try {
  opts = parseServerArgs(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
if (opts.help) {
  console.log(SERVER_HELP);
  process.exit(0);
}

const overrides: Record<string, string> = {};
if (opts.testMode) {
  for (const [k, v] of Object.entries(TEST_MODE_SETTINGS)) overrides[k] = String(v);
}
Object.assign(overrides, opts.overrides);

const store = new Store(opts.db);
const now = (): number => Date.now();
const ctx = {
  store,
  now,
  rng: () => randomInt(0, 0xffffffff) / 0xffffffff,
  flagCodes: FLAG_CODES,
  log,
};

let rooms: RoomManager;
try {
  rooms = new RoomManager(ctx, overrides);
} catch (err) {
  console.error(`Invalid setting: ${(err as Error).message}`);
  process.exit(1);
}
rooms.loadAll();
const auth = new Auth(store, now);

const server = createHttpServer({ auth, rooms, staticDir: opts.staticDir, log });
const wss = attachWebSocket(server, { auth, rooms, log });
const admin = startAdminServer(opts.adminSocket, { rooms, auth, store, now, log });

const onListenError = (err: NodeJS.ErrnoException): void => {
  console.error(
    err.code === 'EADDRINUSE' ? `Port ${opts.port} is already in use. Stop the other server or pass --port.` : `Server error: ${err.message}`,
  );
  process.exit(1);
};
server.on('error', onListenError);
wss.on('error', onListenError);

server.listen(opts.port, opts.host, () => {
  log(`Alliance server on http://localhost:${opts.port}${opts.testMode ? '  [TEST MODE]' : ''}`);
  log(`Database: ${opts.db}   rooms loaded: ${rooms.rooms.size}`);
  if (Object.keys(overrides).length) log(`Default overrides: ${JSON.stringify(overrides)}`);
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log(`${signal} received, shutting down`);
  for (const ws of wss.clients) ws.close(1012, 'Server restarting');
  admin.close();
  server.close();
  store.close();
  setTimeout(() => process.exit(0), 200).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
