// WebSocket endpoint (/ws). Each connection authenticates with its first message and is
// bound to one room. Messages are handled synchronously in arrival order, so the server
// never processes two actions at once.

import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';
import { errorFields } from '../shared/errors.ts';
import type { Auth } from './auth.ts';
import { RoomError, type Room, type Sink } from './room.ts';
import type { RoomManager } from './rooms.ts';

interface Connection extends Sink {
  room: Room;
}

export function attachWebSocket(server: Server, deps: { auth: Auth; rooms: RoomManager; log: (m: string) => void }): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024, perMessageDeflate: false });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws) => {
    let conn: Connection | null = null;
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    const send = (msg: ServerMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const fatal = (message: string): void => {
      send({ type: 'fatal', message, ...errorFields(message) });
      ws.close(4000, message.slice(0, 100));
    };
    const helloTimer = setTimeout(() => {
      if (!conn) fatal('Authentication timed out');
    }, 10_000);

    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (!conn) {
        if (msg.type !== 'hello') return fatal('Expected hello');
        clearTimeout(helloTimer);
        const user = deps.auth.userByToken(msg.token);
        if (!user) return fatal('Please log in again');
        const room = deps.rooms.get(msg.room);
        if (!room) return fatal('Room not found');
        conn = { userId: user.id, username: user.username, room, send };
        room.attach(conn);
        return;
      }

      const c = conn;
      if (c.room.deleted) return fatal('This room was deleted');
      try {
        switch (msg.type) {
          case 'ping':
            send({ type: 'pong', t: msg.t, serverNow: Date.now() });
            break;
          case 'visibility':
            c.visible = msg.visible !== false;
            break;
          case 'act':
            c.room.act(c, c.userId, typeof msg.id === 'number' ? msg.id : 0, msg.action);
            break;
          case 'orders':
            c.room.orders(c.userId, msg.orders, msg.confirm, msg.turn);
            break;
          case 'chat':
            c.room.chat(c.userId, msg.to, msg.text, msg.sticker, msg.group);
            break;
          case 'group_create':
            c.room.groups.create(c.userId, msg.name, msg.members);
            break;
          case 'group_rename':
            c.room.groups.rename(c.userId, msg.group, msg.name);
            break;
          case 'group_add':
            c.room.groups.add(c.userId, msg.group, msg.members);
            break;
          case 'group_leave':
            c.room.groups.leave(c.userId, msg.group);
            break;
          case 'plan_open':
            c.room.groups.planOpen(c, msg.channel);
            break;
          case 'plan_op':
            c.room.groups.planOp(c.userId, msg.channel, msg.op);
            break;
          case 'join':
            c.room.join({ id: c.userId, username: c.username });
            break;
          case 'leave':
            c.room.leave(c.userId);
            break;
          case 'profile':
            c.room.setProfile(c.userId, msg.nickname, msg.flag);
            break;
          case 'kick':
            c.room.kick(c.userId, msg.pid);
            break;
          case 'settings':
            c.room.updateSettingsAsCreator(c.userId, msg.changes);
            deps.log(`room ${c.room.code} settings changed by ${c.username}: ${JSON.stringify(msg.changes).slice(0, 300)}`);
            break;
          case 'start':
            c.room.requestStart(c.userId, msg.settings);
            deps.log(`room ${c.room.code} started by ${c.username}${msg.settings ? ` with unsaved settings ${JSON.stringify(msg.settings).slice(0, 300)}` : ''}`);
            break;
          case 'peace':
            c.room.peace(c.userId, msg.op);
            deps.log(`room ${c.room.code} peace ${String(msg.op)} by ${c.username}`);
            break;
          default:
            break;
        }
      } catch (err) {
        if (err instanceof RoomError) {
          send({ type: 'notice', level: 'error', message: err.message, ...errorFields(err.message) });
        } else {
          deps.log(`ws message failed: ${(err as Error).stack ?? err}`);
          send({ type: 'notice', level: 'error', message: 'Server error', code: 'serverError' });
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (conn) conn.room.detach(conn);
    });
  });

  // Drop connections that stopped answering pings (e.g. a phone that lost signal).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}
