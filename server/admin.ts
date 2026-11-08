// Admin commands. They are only reachable through a local socket inside the server's
// container (used by `alliance <command>`), never through the web port.

import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { SETTING_KEYS, SETTING_RULES, type GameSettings } from '../shared/settings.ts';
import type { Auth } from './auth.ts';
import type { Store } from './db.ts';
import { RoomError, type Room } from './room.ts';
import type { RoomManager } from './rooms.ts';
import type { LogEntry } from '../shared/protocol.ts';
import { revealEntry } from './views.ts';

export interface AdminDeps {
  rooms: RoomManager;
  auth: Auth;
  store: Store;
  now: () => number;
  log: (msg: string) => void;
}

export const ADMIN_HELP = `Alliance admin commands  (run as: alliance <command> ...)

Overview
  status                               Rooms and users at a glance
  rooms                                List all rooms
  room <code>                          Full room state, including hidden stats
  log <code> [count]                   Full event history of a room (default last 50)

Users
  users                                List accounts
  user-create <username> <password>    Create an account
  user-passwd <username> <password>    Set a new password (logs the user out everywhere)
  user-delete <username>               Delete an account (not while in an unfinished game)

Rooms
  room-create <name...> --owner <user> Create a room; the owner joins it and can start it
  room-delete <code>                   Delete a room and its history
  start <code>                         Start the game now (skips the rest of the lobby)
  pause <code> | resume <code>         Pause / resume a running game
  reset <code>                         Back to the lobby; keeps players, wipes the game
  tick <code>                          Give every alive player AP right now
  set <code> key=value ...             Change settings of one room
  player-set <code> <nick|pid> hp=N ap=N range=N
                                       Change a player's hidden stats (testing)

Defaults for new rooms
  defaults                             Show default settings and what each one means
  defaults-set key=value ...           Change defaults (stored in the database)
`;

function table(rows: Array<Array<string | number>>): string {
  if (rows.length === 0) return '';
  const cells = rows.map((r) => r.map(String));
  const widths = cells[0].map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  return cells.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

function fmtTime(ts: number | null, zone: string, now: number): string {
  if (ts === null) return '-';
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(ts));
  const diff = Math.round((ts - now) / 1000);
  const abs = Math.abs(diff);
  const rel =
    abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.floor(abs / 60)}m ${abs % 60}s` : `${Math.floor(abs / 3600)}h ${Math.floor((abs % 3600) / 60)}m`;
  return `${local} (${diff >= 0 ? 'in ' + rel : rel + ' ago'})`;
}

function parseAssignments(args: string[]): Record<string, string> {
  if (args.length === 0) throw new RoomError('Give at least one key=value');
  const out: Record<string, string> = {};
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq <= 0) throw new RoomError(`Expected key=value, got "${a}"`);
    out[a.slice(0, eq)] = a.slice(eq + 1);
  }
  return out;
}

function need(args: string[], count: number, usage: string): void {
  if (args.length < count) throw new RoomError(`Usage: alliance ${usage}`);
}

function nextEventText(room: Room, now: number): string {
  const zone = room.settings.timezone;
  if (room.phase === 'lobby') {
    return room.row.lobby_ends_at === null ? 'lobby: waiting for creator' : `lobby ends ${fmtTime(room.row.lobby_ends_at, zone, now)}`;
  }
  if (room.phase === 'running') return `next AP ${fmtTime(room.row.next_tick_at, zone, now)}`;
  if (room.phase === 'paused') return `paused ${fmtTime(room.row.paused_at, zone, now)}`;
  const winner = room.row.winner_pid !== null ? room.players.get(room.row.winner_pid)?.nickname : undefined;
  return `winner: ${winner ?? '-'}`;
}

function roomsTable(deps: AdminDeps): string {
  const now = deps.now();
  const rooms = [...deps.rooms.rooms.values()];
  if (rooms.length === 0) return 'No rooms yet.';
  return table([
    ['CODE', 'NAME', 'PHASE', 'PLAYERS', 'ALIVE', 'INFO'],
    ...rooms.map((r) => [
      r.code,
      r.row.name,
      r.phase,
      r.players.size,
      r.phase === 'lobby' ? '-' : [...r.players.values()].filter((p) => p.alive).length,
      nextEventText(r, now),
    ]),
  ]);
}

function settingsText(s: GameSettings): string {
  return SETTING_KEYS.map((k) => `  ${k}=${s[k]}`).join('\n');
}

function nameOf(room: Room, pid: number | undefined): string {
  if (pid === undefined) return '?';
  return room.players.get(pid)?.nickname ?? `#${pid}`;
}

function historyLine(room: Room, e: LogEntry, now: number): string {
  const t = fmtTime(e.ts, room.settings.timezone, now).split(' (')[0];
  const a = nameOf(room, e.actor);
  const tg = nameOf(room, e.target);
  switch (e.type) {
    case 'start':
      return `${t}  game started`;
    case 'attack':
      return `${t}  ${a} attacked ${tg} (-${e.amount} HP, ${e.value} left)`;
    case 'grant':
      return `${t}  ${a} gave ${tg} ${e.amount} AP`;
    case 'upgrade':
      return `${t}  ${a} upgraded range to ${e.value}`;
    case 'eliminate':
      return `${t}  ${tg} was eliminated by ${e.actor !== undefined ? a : 'the admin'}`;
    case 'tick':
      return `${t}  everyone received ${e.amount} AP`;
    case 'pause':
      return `${t}  paused`;
    case 'resume':
      return `${t}  resumed`;
    case 'finish':
      return `${t}  game over, winner: ${e.target !== undefined ? tg : '-'}`;
    case 'adjust':
      return `${t}  admin changed ${tg}'s stats`;
    default:
      return `${t}  ${e.type}`;
  }
}

function roomDetails(deps: AdminDeps, room: Room): string {
  const now = deps.now();
  const zone = room.settings.timezone;
  const creator = deps.store.userById(room.row.creator_id)?.username ?? '?';
  const lines = [
    `Room ${room.code} "${room.row.name}"   phase: ${room.phase}   creator: ${creator}`,
    `Created ${fmtTime(room.row.created_at, zone, now)}`,
    `Started ${fmtTime(room.row.started_at, zone, now)}`,
    nextEventText(room, now),
    '',
  ];
  if (room.players.size === 0) {
    lines.push('No players.');
  } else {
    lines.push(
      table([
        ['PID', 'NICKNAME', 'USER', 'FLAG', 'POS', 'HP', 'AP', 'RANGE', 'STATUS'],
        ...[...room.players.values()].map((p) => [
          p.pid,
          p.nickname,
          deps.store.userById(p.userId)?.username ?? '?',
          p.flag,
          p.q === null ? '-' : `${p.q},${p.r}`,
          room.phase === 'lobby' ? '-' : p.hp,
          room.phase === 'lobby' ? '-' : p.ap,
          room.phase === 'lobby' ? '-' : p.range,
          room.phase === 'lobby'
            ? 'in lobby'
            : p.alive
              ? 'alive'
              : `out (by ${p.eliminatedBy !== null ? nameOf(room, p.eliminatedBy) : 'admin'})`,
        ]),
      ]),
    );
  }
  lines.push('', 'Settings:', settingsText(room.settings));
  return lines.join('\n');
}

function findPlayer(room: Room, ref: string): number {
  const byName = room.playerByNickname(ref);
  if (byName) return byName.pid;
  const pid = Number(ref);
  if (Number.isInteger(pid) && room.players.has(pid)) return pid;
  throw new RoomError(`No player "${ref}" in room ${room.code}`);
}

export async function runAdminCommand(deps: AdminDeps, argv: string[]): Promise<string> {
  const [cmd = 'help', ...args] = argv;
  const { rooms, store, auth } = deps;
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      return ADMIN_HELP;

    case 'status':
      return `Users: ${store.listUsers().length}   Rooms: ${rooms.rooms.size}\n\n${roomsTable(deps)}`;

    case 'rooms':
      return roomsTable(deps);

    case 'room':
      need(args, 1, 'room <code>');
      return roomDetails(deps, rooms.require(args[0]));

    case 'log': {
      need(args, 1, 'log <code> [count]');
      const room = rooms.require(args[0]);
      const count = args[1] ? Math.max(1, Number(args[1]) || 50) : 50;
      const now = deps.now();
      const lines = room.events
        .map((ev) => revealEntry(ev))
        .filter((e): e is LogEntry => e !== null)
        .slice(-count)
        .map((e) => historyLine(room, e, now));
      return lines.length ? lines.join('\n') : 'No events yet.';
    }

    case 'users': {
      const users = store.listUsers();
      if (users.length === 0) return 'No users yet.';
      const now = deps.now();
      return table([
        ['ID', 'USERNAME', 'CREATED', 'ROOMS'],
        ...users.map((u) => [
          u.id,
          u.username,
          fmtTime(u.created_at, 'UTC', now).split(' (')[0] + ' UTC',
          [...rooms.rooms.values()].filter((r) => r.participantOf(u.id)).map((r) => r.code).join(' ') || '-',
        ]),
      ]);
    }

    case 'user-create': {
      need(args, 2, 'user-create <username> <password>');
      const user = await auth.createUser(args[0], args[1]);
      return `Created user ${user.username} (id ${user.id}).`;
    }

    case 'user-passwd':
      need(args, 2, 'user-passwd <username> <password>');
      await auth.setPassword(args[0], args[1]);
      return `Password changed for ${args[0]}; their sessions were logged out.`;

    case 'user-delete': {
      need(args, 1, 'user-delete <username>');
      const user = store.userByName(args[0]);
      if (!user) throw new RoomError(`No user "${args[0]}"`);
      const active = [...rooms.rooms.values()].filter((r) => r.phase !== 'finished' && r.participantOf(user.id));
      if (active.length) {
        throw new RoomError(`${user.username} is in unfinished rooms: ${active.map((r) => r.code).join(', ')}. Delete or finish those first.`);
      }
      store.deleteUser(user.id);
      return `Deleted user ${user.username}.`;
    }

    case 'room-create': {
      const ownerIdx = args.indexOf('--owner');
      if (ownerIdx < 0 || !args[ownerIdx + 1]) throw new RoomError('Usage: alliance room-create <name...> --owner <username>');
      const ownerName = args[ownerIdx + 1];
      const name = args.filter((_, i) => i !== ownerIdx && i !== ownerIdx + 1).join(' ');
      const owner = store.userByName(ownerName);
      if (!owner) throw new RoomError(`No user "${ownerName}"`);
      const room = rooms.create({ id: owner.id, username: owner.username }, name);
      deps.log(`admin created room ${room.code}`);
      return `Created room ${room.code} "${room.row.name}" owned by ${owner.username}. Link: /r/${room.code}`;
    }

    case 'room-delete':
      need(args, 1, 'room-delete <code>');
      rooms.delete(args[0]);
      deps.log(`admin deleted room ${args[0]}`);
      return `Deleted room ${args[0]}.`;

    case 'start': {
      need(args, 1, 'start <code>');
      const room = rooms.require(args[0]);
      room.startGame();
      deps.log(`admin started room ${room.code}`);
      return `Room ${room.code} started with ${room.players.size} players.`;
    }

    case 'pause': {
      need(args, 1, 'pause <code>');
      rooms.require(args[0]).pause();
      return `Room ${args[0]} paused.`;
    }

    case 'resume': {
      need(args, 1, 'resume <code>');
      const room = rooms.require(args[0]);
      room.resume();
      return `Room ${args[0]} resumed; ${nextEventText(room, deps.now())}.`;
    }

    case 'reset': {
      need(args, 1, 'reset <code>');
      const room = rooms.require(args[0]);
      room.reset();
      deps.log(`admin reset room ${room.code}`);
      return `Room ${room.code} is back in the lobby; ${nextEventText(room, deps.now())}.`;
    }

    case 'tick': {
      need(args, 1, 'tick <code>');
      const room = rooms.require(args[0]);
      room.tick();
      return `Gave ${room.settings.apPerTick} AP to every alive player in ${room.code}.`;
    }

    case 'set': {
      need(args, 2, 'set <code> key=value ...');
      const room = rooms.require(args[0]);
      room.updateSettings(parseAssignments(args.slice(1)));
      return `Updated ${room.code}.\n${settingsText(room.settings)}\n${nextEventText(room, deps.now())}`;
    }

    case 'player-set': {
      need(args, 3, 'player-set <code> <nick|pid> hp=N ap=N range=N');
      const room = rooms.require(args[0]);
      const pid = findPlayer(room, args[1]);
      const changes: { hp?: number; ap?: number; range?: number } = {};
      for (const [k, v] of Object.entries(parseAssignments(args.slice(2)))) {
        if (k !== 'hp' && k !== 'ap' && k !== 'range') throw new RoomError(`Unknown stat "${k}" (use hp, ap, range)`);
        if (!/^-?\d+$/.test(v)) throw new RoomError(`${k} must be a whole number`);
        changes[k] = Number(v);
      }
      room.adjustPlayer(pid, changes);
      const p = room.players.get(pid)!;
      return `${p.nickname}: hp=${p.hp} ap=${p.ap} range=${p.range}${p.alive ? '' : ' (eliminated)'}`;
    }

    case 'defaults': {
      const d = rooms.defaults();
      return (
        'Default settings for new rooms:\n' +
        table(SETTING_KEYS.map((k) => [`  ${k}`, String(d[k]), SETTING_RULES[k].help])) +
        '\n\nChange with: alliance defaults-set key=value ...   (existing rooms: alliance set <code> key=value)'
      );
    }

    case 'defaults-set': {
      const overrides = parseAssignments(args);
      try {
        rooms.setDefaults(overrides);
      } catch (err) {
        throw new RoomError((err as Error).message);
      }
      return `Defaults updated.\n${settingsText(rooms.defaults())}`;
    }

    default:
      throw new RoomError(`Unknown command "${cmd}". Run "alliance help".`);
  }
}

export function startAdminServer(path: string, deps: AdminDeps): Server {
  if (process.platform !== 'win32' && existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 64 * 1024) sock.destroy();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      let argv: string[] = [];
      try {
        const parsed = JSON.parse(line) as { argv?: unknown };
        argv = Array.isArray(parsed.argv) ? parsed.argv.map(String) : [];
      } catch {
        sock.end(JSON.stringify({ ok: false, output: 'Bad request' }) + '\n');
        return;
      }
      runAdminCommand(deps, argv)
        .then((output) => sock.end(JSON.stringify({ ok: true, output }) + '\n'))
        .catch((err: unknown) => {
          const known = err instanceof RoomError || (err as { status?: number }).status !== undefined;
          if (!known) deps.log(`admin command failed: ${(err as Error).stack ?? err}`);
          sock.end(JSON.stringify({ ok: false, output: known ? (err as Error).message : `Error: ${(err as Error).message}` }) + '\n');
        });
    });
    sock.on('error', () => undefined);
  });
  server.listen(path, () => {
    if (process.platform !== 'win32') {
      try {
        chmodSync(path, 0o600);
      } catch {
        // ignore
      }
    }
  });
  server.on('error', (err) => deps.log(`admin socket error: ${err.message}`));
  return server;
}
