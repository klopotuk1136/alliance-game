// Room page controller: owns the WebSocket, keeps the latest state and log, and switches
// between the lobby screen, the game screen and "not in this game".

import type { ActionResult, ClientMessage, LogEntry, RoomView, ServerMessage, UserInfo } from '../../shared/protocol.ts';
import { clearToken, getToken } from './api.ts';
import { h, replaceChildren, toast } from './dom.ts';
import { GameView } from './game.ts';
import { LobbyView } from './lobby.ts';
import { navigate } from './nav.ts';

export interface RoomCtx {
  code: string;
  user: UserInfo;
  send(msg: ClientMessage): void;
  /** Current time on the server's clock. */
  serverNow(): number;
}

type View =
  | { kind: 'lobby'; view: LobbyView }
  | { kind: 'game'; view: GameView }
  | { kind: 'outside'; el: HTMLElement };

export function showRoom(app: HTMLElement, code: string, user: UserInfo): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retries = 0;
  let retryTimer = 0;
  let state: RoomView | null = null;
  let log: LogEntry[] = [];
  let offset = 0;
  let current: View | null = null;

  const banner = h('div', { class: 'conn-banner hidden' }, 'Connection lost. Reconnecting…');
  const host = h('div', { class: 'room-host' }, h('div', { class: 'loading' }, 'Connecting…'));
  replaceChildren(app, banner, host);

  const ctx: RoomCtx = {
    code,
    user,
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else toast('Not connected yet', 'error');
    },
    serverNow: () => Date.now() + offset,
  };

  function message(text: string): void {
    stopped = true;
    destroyView();
    replaceChildren(
      host,
      h(
        'main',
        { class: 'center-msg' },
        h('div', { class: 'card' }, h('p', null, text), h('button', { class: 'btn primary', onclick: () => navigate('/') }, 'Back to rooms')),
      ),
    );
  }

  function destroyView(): void {
    if (current?.kind === 'lobby' || current?.kind === 'game') current.view.destroy();
    current = null;
  }

  function render(fresh: LogEntry[], result?: ActionResult): void {
    if (!state) return;
    const kind: View['kind'] = state.phase === 'lobby' ? 'lobby' : state.participant ? 'game' : 'outside';
    if (!current || current.kind !== kind) {
      destroyView();
      fresh = [];
      if (kind === 'lobby') current = { kind, view: new LobbyView(ctx) };
      else if (kind === 'game') current = { kind, view: new GameView(ctx) };
      else {
        current = {
          kind,
          el: h(
            'main',
            { class: 'center-msg' },
            h(
              'div',
              { class: 'card' },
              h('h2', null, state.name),
              h('p', null, 'This game has already started, and only its players can see it.'),
              h('button', { class: 'btn primary', onclick: () => navigate('/') }, 'Back to rooms'),
            ),
          ),
        };
      }
      replaceChildren(host, current.kind === 'outside' ? current.el : current.view.el);
    }
    if (current.kind === 'lobby') current.view.update(state);
    else if (current.kind === 'game') current.view.update(state, log, fresh, result);
  }

  function handle(msg: ServerMessage): void {
    if (msg.type === 'fatal') {
      if (msg.message === 'Please log in again') {
        clearToken();
        navigate(location.pathname);
        return;
      }
      message(msg.message);
      ws?.close();
      return;
    }
    if (msg.type === 'notice') {
      toast(msg.message, msg.level === 'error' ? 'error' : 'info', 3000);
      return;
    }
    if (msg.type !== 'update') return;
    let fresh: LogEntry[] = [];
    if (msg.resetLog) log = msg.entries ? [...msg.entries] : [];
    else if (msg.entries) {
      log.push(...msg.entries);
      fresh = msg.entries;
    }
    if (msg.state) {
      state = msg.state;
      offset = state.serverNow - Date.now();
    }
    if (msg.state || fresh.length) render(fresh, msg.result);
    else if (msg.result && current?.kind === 'game') current.view.result(msg.result);
  }

  function connect(): void {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${location.host}/ws`);
    ws = socket;
    socket.onopen = () => {
      retries = 0;
      banner.classList.add('hidden');
      socket.send(JSON.stringify({ type: 'hello', token: getToken() ?? '', room: code } satisfies ClientMessage));
    };
    socket.onmessage = (ev) => {
      try {
        handle(JSON.parse(String(ev.data)) as ServerMessage);
      } catch (err) {
        console.error(err);
      }
    };
    socket.onclose = () => {
      if (stopped || ws !== socket) return;
      banner.classList.remove('hidden');
      retryTimer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retries++));
    };
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    ws?.close();
    destroyView();
  };
}
