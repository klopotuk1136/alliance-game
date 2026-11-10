import type { RoomSummary, RoomsResponse, UserInfo } from '../../shared/protocol.ts';
import { ROOM_NAME_MAX } from '../../shared/protocol.ts';
import { api } from './api.ts';
import { h, replaceChildren, toast } from './dom.ts';
import { countdown } from './format.ts';
import { navigate } from './nav.ts';
import { leaderboardLink } from './leaderboard.ts';
import { profileHint, userMenu } from './profile.ts';
import { emptyState, icon, logo } from './ui.ts';
import { has, L, onLang, t, T } from './i18n.ts';
import { langSwitch } from './lang-switch.ts';
import { notifyBell } from './notify-panel.ts';
import { tutorialCard } from './tutorial.ts';

function phaseLabel(phase: string): string {
  const key = `home.phase.${phase}`;
  return has(key) ? t(key) : phase;
}

/** "Blitz · 60 s" on blitz rooms (the turn length in minutes when it is a whole number of them). */
function blitzBadge(sec: number | undefined): HTMLElement {
  const s = sec ?? 60;
  const whole = s >= 60 && s % 60 === 0;
  const label = whole ? t('home.blitzMin', { n: s / 60 }) : t('home.blitzSec', { n: s });
  const time = whole ? t('home.turnMin', { n: s / 60 }) : t('home.turnSec', { n: s });
  return h('span', { class: 'badge blitz-badge', title: t('home.blitzTitle', { time }) }, icon('bolt'), label);
}

/** Home: create a room, your rooms, open lobbies. */
export function showHome(app: HTMLElement, user: UserInfo): () => void {
  const mineList = h('div', { class: 'room-list' }, h('div', { class: 'skeleton' }));
  const openList = h('div', { class: 'room-list' }, h('div', { class: 'skeleton' }));
  const nameInput = h('input', { placeholder: L('home.roomNamePlaceholder'), maxlength: ROOM_NAME_MAX, required: true, 'aria-label': L('home.roomName') });
  const createBtn = h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), T('home.createRoomBtn'));
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
      status = r.lobbyEndsAt ? t('home.startsIn', { time: countdown(r.lobbyEndsAt - (Date.now() + serverOffset)) }) : t('home.waitingCreator');
    } else if (r.phase === 'finished') {
      status = r.winner ? t('home.winner', { name: r.winner }) : t('home.finished');
    } else if (r.alive === false) {
      status = t('home.youAreOut');
    } else if (r.alive) {
      status = t('home.youAreAlive');
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
          h('span', null, t('home.by', { name: r.creator })),
          h('span', { class: 'dot-sep', 'aria-hidden': 'true' }),
          h('span', { class: 'num' }, icon('users'), `${r.players}/${r.maxPlayers}`),
          status ? [h('span', { class: 'dot-sep', 'aria-hidden': 'true' }), h('span', { class: 'num' }, status)] : null,
        ),
      ),
      h(
        'div',
        { class: 'room-card-side' },
        r.mode === 'blitz' ? blitzBadge(r.blitzTurnSec) : null,
        h('span', { class: `badge ${r.phase}` }, phaseLabel(r.phase)),
        open ? h('span', { class: 'btn small secondary' }, t('home.open')) : icon('chevron', 'room-go'),
      ),
    );
  }

  function render(): void {
    if (!data) return;
    replaceChildren(mineList, data.mine.length ? data.mine.map((r) => roomCard(r, false)) : emptyState(t('home.noRoomsTitle'), t('home.noRoomsText')));
    replaceChildren(
      openList,
      data.open.length ? data.open.map((r) => roomCard(r, true)) : emptyState(t('home.noLobbiesTitle'), t('home.noLobbiesText')),
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
        leaderboardLink(),
        notifyBell(),
        langSwitch(),
        userMenu(user),
      ),
      h(
        'main',
        { class: 'home' },
        profileHint(user),
        h(
          'section',
          { class: 'card framed create-card' },
          h('p', { class: 'eyebrow' }, T('home.eyebrow')),
          h('h1', { class: 'display' }, T('home.createTitle')),
          h('p', { class: 'muted' }, T('home.createText')),
          createForm,
        ),
        tutorialCard(),
        h('section', { class: 'home-section' }, h('h2', { class: 'section-title' }, T('home.yourRooms')), mineList),
        h('section', { class: 'home-section' }, h('h2', { class: 'section-title' }, T('home.openLobbies')), openList),
      ),
    ),
  );

  void load();
  const poll = setInterval(() => void load(), 5000);
  const tick = setInterval(render, 1000);
  const offLang = onLang(render);
  return () => {
    offLang();
    clearInterval(poll);
    clearInterval(tick);
  };
}
