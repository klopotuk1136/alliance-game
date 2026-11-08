import type { RoomSummary, RoomsResponse, UserInfo } from '../../shared/protocol.ts';
import { ROOM_NAME_MAX } from '../../shared/protocol.ts';
import { api } from './api.ts';
import { h, replaceChildren, toast } from './dom.ts';
import { countdown } from './format.ts';
import { logout, navigate } from './nav.ts';

const PHASE_LABEL: Record<string, string> = {
  lobby: 'Lobby',
  running: 'In progress',
  paused: 'Paused',
  finished: 'Finished',
};

/** Home: create a room, your rooms, open lobbies. */
export function showHome(app: HTMLElement, user: UserInfo): () => void {
  const mineList = h('div', { class: 'room-list' });
  const openList = h('div', { class: 'room-list' });
  const nameInput = h('input', { placeholder: 'e.g. Friday night betrayal', maxlength: ROOM_NAME_MAX, required: true });
  const createBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Create room');
  let serverOffset = 0;
  let data: RoomsResponse | null = null;

  const createForm = h('form', { class: 'create-form' }, nameInput, createBtn);
  createForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    createBtn.disabled = true;
    try {
      const res = await api<{ code: string }>('POST', '/api/rooms', { name: nameInput.value });
      navigate(`/r/${res.code}`);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      createBtn.disabled = false;
    }
  });

  function roomCard(r: RoomSummary, open: boolean): HTMLElement {
    let status = '';
    if (r.phase === 'lobby') {
      status = r.lobbyEndsAt ? `starts in ${countdown(r.lobbyEndsAt - (Date.now() + serverOffset))}` : 'waiting for creator';
    } else if (r.phase === 'finished') {
      status = r.winner ? `winner: ${r.winner}` : 'finished';
    } else if (r.alive === false) {
      status = 'you are out';
    } else if (r.alive) {
      status = 'you are alive';
    }
    return h(
      'a',
      {
        class: `room-card phase-${r.phase}`,
        href: `/r/${r.code}`,
        onclick: (ev: MouseEvent) => {
          ev.preventDefault();
          navigate(`/r/${r.code}`);
        },
      },
      h('div', { class: 'room-card-main' }, h('strong', null, r.name), h('span', { class: 'muted' }, `by ${r.creator}`)),
      h(
        'div',
        { class: 'room-card-side' },
        h('span', { class: `badge ${r.phase}` }, PHASE_LABEL[r.phase]),
        h('span', { class: 'muted' }, `${r.players}/${r.maxPlayers} players`),
        status ? h('span', { class: 'muted small' }, status) : null,
        open ? h('span', { class: 'btn small' }, 'Open') : null,
      ),
    );
  }

  function render(): void {
    if (!data) return;
    replaceChildren(mineList, data.mine.length ? data.mine.map((r) => roomCard(r, false)) : h('p', { class: 'empty' }, "You haven't joined any rooms yet."));
    replaceChildren(
      openList,
      data.open.length ? data.open.map((r) => roomCard(r, true)) : h('p', { class: 'empty' }, 'No open lobbies right now. Create one and share the link!'),
    );
  }

  async function load(): Promise<void> {
    try {
      data = await api<RoomsResponse>('GET', '/api/rooms');
      serverOffset = data.serverNow - Date.now();
      render();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  replaceChildren(
    app,
    h(
      'div',
      { class: 'page' },
      h(
        'header',
        { class: 'topbar' },
        h('div', { class: 'logo small' }, h('span', { class: 'logo-mark' }, '⬢'), 'Alliance'),
        h('div', { class: 'spacer' }),
        h('span', { class: 'muted' }, user.username),
        h('button', { class: 'btn ghost small', onclick: () => logout() }, 'Log out'),
      ),
      h(
        'main',
        { class: 'home' },
        h('section', { class: 'card' }, h('h2', null, 'Create a room'), h('p', { class: 'muted' }, 'You get a link to share with your friends. The game starts when the lobby time runs out (24 hours), or earlier when you start it.'), createForm),
        h('section', { class: 'card' }, h('h2', null, 'Your rooms'), mineList),
        h('section', { class: 'card' }, h('h2', null, 'Open lobbies'), openList),
      ),
    ),
  );

  void load();
  const poll = setInterval(() => void load(), 5000);
  const tick = setInterval(render, 1000);
  return () => {
    clearInterval(poll);
    clearInterval(tick);
  };
}
