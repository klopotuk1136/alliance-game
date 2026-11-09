import type { RoomSummary, RoomsResponse, UserInfo } from '../../shared/protocol.ts';
import { ROOM_NAME_MAX } from '../../shared/protocol.ts';
import { api } from './api.ts';
import { h, replaceChildren, toast } from './dom.ts';
import { countdown } from './format.ts';
import { navigate } from './nav.ts';
import { profileHint, userMenu } from './profile.ts';
import { emptyState, icon, logo } from './ui.ts';

const PHASE_LABEL: Record<string, string> = {
  lobby: 'Lobby',
  running: 'In progress',
  paused: 'Paused',
  finished: 'Finished',
};

/** Home: create a room, your rooms, open lobbies. */
export function showHome(app: HTMLElement, user: UserInfo): () => void {
  const mineList = h('div', { class: 'room-list' }, h('div', { class: 'skeleton' }));
  const openList = h('div', { class: 'room-list' }, h('div', { class: 'skeleton' }));
  const nameInput = h('input', { placeholder: 'e.g. Friday night betrayal', maxlength: ROOM_NAME_MAX, required: true, 'aria-label': 'Room name' });
  const createBtn = h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Create room');
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
      h('span', { class: 'room-hex', 'aria-hidden': 'true' }, icon('hex')),
      h(
        'div',
        { class: 'room-card-main' },
        h('strong', { class: 'room-card-name' }, r.name),
        h(
          'span',
          { class: 'room-card-meta' },
          h('span', null, `by ${r.creator}`),
          h('span', { class: 'dot-sep', 'aria-hidden': 'true' }),
          h('span', { class: 'num' }, icon('users'), `${r.players}/${r.maxPlayers}`),
          status ? [h('span', { class: 'dot-sep', 'aria-hidden': 'true' }), h('span', { class: 'num' }, status)] : null,
        ),
      ),
      h(
        'div',
        { class: 'room-card-side' },
        h('span', { class: `badge ${r.phase}` }, PHASE_LABEL[r.phase]),
        open ? h('span', { class: 'btn small secondary' }, 'Open') : icon('chevron', 'room-go'),
      ),
    );
  }

  function render(): void {
    if (!data) return;
    replaceChildren(mineList, data.mine.length ? data.mine.map((r) => roomCard(r, false)) : emptyState("You haven't joined any rooms yet", 'Create one above, or open a lobby a friend shared.'));
    replaceChildren(
      openList,
      data.open.length ? data.open.map((r) => roomCard(r, true)) : emptyState('No open lobbies right now', 'Create one and share the link. Every alliance starts with an invitation.'),
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
        logo(true),
        h('div', { class: 'spacer' }),
        userMenu(user),
      ),
      h(
        'main',
        { class: 'home' },
        profileHint(user),
        h(
          'section',
          { class: 'card framed create-card' },
          h('p', { class: 'eyebrow' }, 'New campaign'),
          h('h1', { class: 'display' }, 'Create a room'),
          h('p', { class: 'muted' }, 'You get a link to share with your friends. The game starts when the lobby time runs out (24 hours), or earlier when you start it.'),
          createForm,
        ),
        h('section', { class: 'home-section' }, h('h2', { class: 'section-title' }, 'Your rooms'), mineList),
        h('section', { class: 'home-section' }, h('h2', { class: 'section-title' }, 'Open lobbies'), openList),
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
