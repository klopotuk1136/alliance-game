// Leaderboard page (/leaderboard) and the small rating badges used on profile cards.
// Ratings are Elo by final placement (server/rating.ts); test-mode games never count.

import type { LeaderboardEntry, LeaderboardResponse, PublicProfile, UserInfo } from '../../shared/protocol.ts';
import { api } from './api.ts';
import { h, replaceChildren } from './dom.ts';
import { navigate } from './nav.ts';
import { avatarEl, openPublicProfile, userMenu } from './profile.ts';
import { emptyState, icon, logo } from './ui.ts';
import { fmtNumber, L, T } from './i18n.ts';
import { langSwitch } from './lang-switch.ts';
import { notifyBell } from './notify-panel.ts';

/** "2.33" / "1" / "0.5": win points with at most two decimals. */
export function formatPoints(n: number): string {
  return fmtNumber(Math.round(n * 100) / 100);
}

/** Rating · win points · rated games, for profile cards and the profile editor. */
export function ratingBadges(p: Pick<PublicProfile, 'rating' | 'ratedGames' | 'winPoints'>): HTMLElement {
  const cell = (label: Node, value: string, cls = '') => h('div', { class: `rb-cell ${cls}` }, h('span', { class: 'rb-value num' }, value), h('span', { class: 'rb-label' }, label));
  return h(
    'div',
    { class: 'rating-badges', title: p.ratedGames ? '' : L('lb.startsAt1000') },
    cell(T('lb.rating'), String(p.rating ?? 1000), 'rb-rating'),
    cell(T('lb.winPoints'), formatPoints(p.winPoints ?? 0)),
    cell(T('lb.ratedGames', { n: p.ratedGames ?? 0 }), String(p.ratedGames ?? 0)),
  );
}

/** A link to the leaderboard for top bars. */
export function leaderboardLink(): HTMLElement {
  return h(
    'a',
    {
      class: 'btn ghost small lb-link',
      href: '/leaderboard',
      title: L('lb.title'),
      onclick: (ev: MouseEvent) => {
        ev.preventDefault();
        navigate('/leaderboard');
      },
    },
    icon('crown'),
    h('span', { class: 'hide-sm' }, T('lb.title')),
  );
}

export function showLeaderboard(app: HTMLElement, user: UserInfo): () => void {
  const body = h('div', { class: 'lb-body', 'aria-busy': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  let stopped = false;

  replaceChildren(
    app,
    h(
      'div',
      { class: 'page' },
      h(
        'header',
        { class: 'topbar' },
        h('button', { class: 'btn ghost small back-btn', title: L('app.backToRooms'), 'aria-label': L('app.backToRooms'), onclick: () => navigate('/') }, icon('back'), h('span', { class: 'back-label' }, T('lb.rooms'))),
        h('div', { class: 'topbar-divider', 'aria-hidden': 'true' }),
        logo(true),
        h('div', { class: 'spacer' }),
        notifyBell(),
        langSwitch(),
        userMenu(user),
      ),
      h(
        'main',
        { class: 'leaderboard' },
        h(
          'section',
          { class: 'card framed lb-head' },
          h('p', { class: 'eyebrow' }, T('lb.eyebrow')),
          h('h1', { class: 'display' }, T('lb.title')),
          h('p', { class: 'muted' }, T('lb.intro')),
        ),
        body,
      ),
    ),
  );

  const row = (e: LeaderboardEntry): HTMLElement => {
    const name = e.displayName || e.username;
    const me = e.username.toLowerCase() === user.username.toLowerCase();
    const who = h(
      'button',
      { class: 'lb-who', type: 'button', title: L('lb.profileOf', { name }) },
      avatarEl(e.avatarUrl, name, 'sm'),
      h('span', { class: 'lb-name' }, h('strong', null, name), name !== e.username ? h('span', { class: 'muted small' }, `@${e.username}`) : null),
    );
    who.addEventListener('click', () => openPublicProfile(e.username, who, { me: user }));
    return h(
      'tr',
      { class: `${me ? 'is-me' : ''} ${e.rank <= 3 ? `top top-${e.rank}` : ''}` },
      h('td', { class: 'lb-rank num' }, e.rank <= 3 ? h('span', { class: 'lb-medal' }, String(e.rank)) : String(e.rank)),
      h('td', null, who),
      h('td', { class: 'num lb-rating' }, String(e.rating)),
      h('td', { class: 'num' }, formatPoints(e.winPoints)),
      h('td', { class: 'num' }, String(e.wins)),
      h('td', { class: 'num' }, String(e.games)),
    );
  };

  void api<LeaderboardResponse>('GET', '/api/leaderboard').then(
    (res) => {
      if (stopped) return;
      body.removeAttribute('aria-busy');
      if (!res.players.length) {
        replaceChildren(body, emptyState(T('lb.emptyTitle'), T('lb.emptyText')));
        return;
      }
      replaceChildren(
        body,
        h(
          'div',
          { class: 'card lb-card' },
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'lb-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', { class: 'lb-rank' }, '#'),
                  h('th', null, T('lb.player')),
                  h('th', { class: 'num' }, T('lb.rating')),
                  h('th', { class: 'num', title: L('lb.winPtsHint') }, T('lb.winPts')),
                  h('th', { class: 'num' }, T('lb.wins')),
                  h('th', { class: 'num' }, T('lb.games')),
                ),
              ),
              h('tbody', null, res.players.map(row)),
            ),
          ),
        ),
      );
    },
    (err: Error) => {
      if (stopped) return;
      body.removeAttribute('aria-busy');
      const msg = h('p', { class: 'form-error', role: 'alert' }, err.message);
      replaceChildren(body, msg);
    },
  );

  return () => {
    stopped = true;
  };
}
