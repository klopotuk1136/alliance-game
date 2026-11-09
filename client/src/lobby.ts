// Lobby screen: share link, countdown to automatic start, participants, choose nickname
// and flag, join/leave, game settings, and (for the creator) start the game, remove
// players and change the settings.

import type { FlagInfo, RoomView } from '../../shared/protocol.ts';
import { NICKNAME_MAX } from '../../shared/protocol.ts';
import { fetchFlags } from './api.ts';
import { flagImg, h, replaceChildren, toast } from './dom.ts';
import { countdown } from './format.ts';
import { HexMap } from './map.ts';
import { navigate } from './nav.ts';
import { playerNameButton, playerSeal, userMenu } from './profile.ts';
import type { RoomCtx } from './room.ts';
import { SettingsPanel } from './settings-panel.ts';
import { icon, logo, searchField } from './ui.ts';
import { cellCount } from '../../shared/hex.ts';

export class LobbyView {
  readonly el: HTMLElement;
  private readonly ctx: RoomCtx;
  private state!: RoomView;
  private flags: FlagInfo[] = [];
  private readonly flagButtons = new Map<string, HTMLButtonElement>();
  private readonly timer: number;
  private confirmingStart = false;

  private readonly titleEl = h('h1', { class: 'lobby-title display' });
  private readonly statusEl = h('p', { class: 'lobby-status' });
  private readonly countEl = h('span', { class: 'count-pill' });
  private readonly shareInput = h('input', { class: 'share-input', readonly: true, 'aria-label': 'Invite link' });
  private readonly controlsEl = h('div', { class: 'lobby-controls' });
  private readonly playersEl = h('ul', { class: 'lobby-players' });
  private readonly sideEl = h('div', { class: 'lobby-side' });
  private readonly nickInput = h('input', { id: 'nick-input', maxlength: NICKNAME_MAX, placeholder: 'Your nickname', autocomplete: 'off' });
  private readonly flagSearchField = searchField('Search countries…', 'Search flags');
  private readonly flagSearch = this.flagSearchField.input;
  private readonly flagGrid = h('div', { class: 'flag-grid', role: 'group', 'aria-label': 'Flags' }, h('p', { class: 'muted' }, 'Loading flags…'));
  private readonly flagEmpty = h('p', { class: 'flag-empty', hidden: true }, 'No country matches that search.');
  private readonly myFlagEl = h('div', { class: 'my-flag' });
  private readonly profileCard: HTMLElement;
  private readonly joinCard: HTMLElement;
  private readonly settings: SettingsPanel;
  private rulesKey = '';
  /** Live 3D preview of the board: grows/shrinks with Map radius, players stand around it. */
  private readonly preview = new HexMap({ preview: true });
  private readonly previewTitle = h('strong', null, 'The map');
  private previewRadius = -1;

  constructor(ctx: RoomCtx) {
    this.ctx = ctx;
    this.settings = new SettingsPanel((changes) => this.ctx.send({ type: 'settings', changes }));
    this.settings.onRadiusPreview = (r) => this.setPreviewRadius(r);
    this.shareInput.value = `${location.origin}/r/${ctx.code}`;
    const copyBtn = h('button', { class: 'btn secondary', type: 'button' }, icon('copy'), 'Copy link');
    copyBtn.addEventListener('click', () => this.copyLink());

    const saveNick = (): void => {
      const value = this.nickInput.value.trim();
      const mine = this.myPlayer();
      if (mine && value && value !== mine.nickname) this.ctx.send({ type: 'profile', nickname: value });
    };
    const nickForm = h('form', { class: 'nick-form' }, this.nickInput, h('button', { class: 'btn secondary', type: 'submit' }, 'Save'));
    nickForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      saveNick();
    });
    this.nickInput.addEventListener('blur', saveNick);
    this.flagSearch.addEventListener('input', () => this.filterFlags());

    this.profileCard = h(
      'section',
      { class: 'card framed profile-card' },
      h('h2', { class: 'card-title' }, 'Your country'),
      h('label', { class: 'field-label', for: 'nick-input' }, 'Nickname'),
      nickForm,
      h('span', { class: 'field-label' }, 'Flag'),
      this.myFlagEl,
      this.flagSearchField.el,
      h('div', { class: 'flag-scroll' }, this.flagGrid, this.flagEmpty),
    );
    this.joinCard = h('section', { class: 'card framed join-card' });

    this.el = h(
      'div',
      { class: 'page' },
      h(
        'header',
        { class: 'topbar' },
        h('button', { class: 'btn ghost small back-btn', onclick: () => navigate('/') }, icon('back'), 'Rooms'),
        h('div', { class: 'topbar-divider', 'aria-hidden': 'true' }),
        logo(true),
        h('div', { class: 'spacer' }),
        userMenu(ctx.user),
      ),
      h(
        'main',
        { class: 'lobby-page' },
        h(
          'section',
          { class: 'card framed lobby-head' },
          h('p', { class: 'eyebrow' }, h('span', { class: 'badge lobby' }, 'Lobby'), `Room ${ctx.code.toUpperCase()}`),
          this.titleEl,
          this.statusEl,
          h('div', { class: 'share-row' }, h('div', { class: 'share-field' }, icon('link'), this.shareInput), copyBtn),
          this.controlsEl,
        ),
        h(
          'section',
          { class: 'card framed lobby-map', 'aria-label': 'Map preview' },
          h(
            'div',
            { class: 'lobby-map-caption' },
            h('span', { class: 'eyebrow' }, 'Map preview'),
            this.previewTitle,
            h('span', { class: 'muted' }, 'Players take their places when the game starts'),
          ),
          this.preview.el,
        ),
        h(
          'div',
          { class: 'lobby-grid' },
          h(
            'div',
            { class: 'lobby-main' },
            h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Players'), this.countEl), this.playersEl),
            ctx.chat.el,
          ),
          this.sideEl,
        ),
        this.settings.el,
      ),
    );

    fetchFlags()
      .then((flags) => {
        this.flags = flags;
        this.buildFlagGrid();
        if (this.state) this.render();
      })
      .catch(() => replaceChildren(this.flagGrid, h('p', { class: 'form-error' }, "Couldn't load flags.")));

    this.timer = window.setInterval(() => this.renderStatus(), 500);
  }

  destroy(): void {
    clearInterval(this.timer);
    this.preview.destroy();
  }

  private setPreviewRadius(r: number): void {
    if (r === this.previewRadius) return;
    this.previewRadius = r;
    this.preview.setRadius(r);
    this.previewTitle.textContent = `Radius ${r} · ${cellCount(r)} cells`;
  }

  update(state: RoomView): void {
    const key = JSON.stringify(state.rules);
    if (this.rulesKey && key !== this.rulesKey) {
      toast(state.isCreator ? 'Settings saved' : 'The room creator changed the game settings', state.isCreator ? 'good' : 'info', 3000);
    }
    this.rulesKey = key;
    this.state = state;
    this.render();
    this.settings.update(state.rules, state.isCreator, state.players.length);
    this.preview.roster(state.players, state.me?.pid ?? null);
  }

  private myPlayer() {
    const pid = this.state?.me?.pid;
    return pid === undefined ? undefined : this.state.players.find((p) => p.pid === pid);
  }

  private async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.shareInput.value);
      toast('Link copied', 'good');
    } catch {
      this.shareInput.select();
      toast('Press Ctrl+C to copy', 'info');
    }
  }

  private buildFlagGrid(): void {
    this.flagButtons.clear();
    const buttons = this.flags.map((f) => {
      const btn = h('button', { class: 'flag-btn', type: 'button', title: f.name, 'aria-label': f.name, 'aria-pressed': 'false', 'data-code': f.code }, flagImg(f.code));
      btn.addEventListener('click', () => {
        if (btn.classList.contains('taken')) return;
        this.ctx.send({ type: 'profile', flag: f.code });
      });
      this.flagButtons.set(f.code, btn);
      return btn;
    });
    replaceChildren(this.flagGrid, buttons);
    this.filterFlags();
  }

  private filterFlags(): void {
    const q = this.flagSearch.value.trim().toLowerCase();
    let shown = 0;
    for (const f of this.flags) {
      const btn = this.flagButtons.get(f.code);
      if (!btn) continue;
      btn.hidden = q !== '' && !f.name.toLowerCase().includes(q) && f.code !== q;
      if (!btn.hidden) shown++;
    }
    this.flagEmpty.hidden = shown > 0 || this.flags.length === 0;
  }

  private renderStatus(): void {
    const st = this.state;
    if (!st) return;
    const creator = st.players.find((p) => p.isCreator);
    if (st.lobbyEndsAt !== null) {
      const left = st.lobbyEndsAt - this.ctx.serverNow();
      if (left > 0) {
        replaceChildren(
          this.statusEl,
          icon('clock'),
          h(
            'span',
            null,
            'The game starts automatically in ',
            h('strong', { class: 'countdown' }, countdown(left)),
            st.isCreator ? ', or when you start it.' : `, or when ${creator?.nickname ?? 'the creator'} starts it.`,
          ),
        );
      } else {
        replaceChildren(this.statusEl, icon('clock'), h('span', null, 'Starting…'));
      }
    } else {
      replaceChildren(
        this.statusEl,
        icon('clock'),
        h(
          'span',
          null,
          st.isCreator
            ? 'The lobby time is over. Start the game once at least 2 players have joined.'
            : `The lobby time is over. Waiting for ${creator?.nickname ?? 'the creator'} to start the game.`,
        ),
      );
    }
  }

  private render(): void {
    const st = this.state;
    const mine = this.myPlayer();
    this.titleEl.textContent = st.name;
    this.countEl.textContent = `${st.players.length}/${st.rules.maxPlayers}`;
    this.renderStatus();

    // Controls
    const controls: HTMLElement[] = [];
    if (st.isCreator) {
      const start = h('button', { class: 'btn primary', type: 'button' }, 'Start the game now');
      if (st.players.length < 2) controls.push(h('span', { class: 'controls-note' }, 'Waiting for at least one more player'));
      start.disabled = st.players.length < 2;
      start.title = start.disabled ? 'At least 2 players are needed' : '';
      if (this.confirmingStart) {
        start.textContent = `Click again to start with ${st.players.length} players`;
        start.classList.add('confirm');
      }
      start.addEventListener('click', () => {
        if (this.confirmingStart) {
          this.confirmingStart = false;
          this.ctx.send({ type: 'start' });
          return;
        }
        // Two clicks: nobody can join once the game starts.
        this.confirmingStart = true;
        this.render();
        setTimeout(() => {
          if (!this.confirmingStart) return;
          this.confirmingStart = false;
          if (this.state.phase === 'lobby') this.render();
        }, 4000);
      });
      controls.unshift(start);
    } else if (st.participant) {
      const leave = h('button', { class: 'btn secondary', type: 'button' }, 'Leave room');
      leave.addEventListener('click', () => this.ctx.send({ type: 'leave' }));
      controls.push(leave);
    }
    replaceChildren(this.controlsEl, controls);

    // Players
    replaceChildren(
      this.playersEl,
      st.players.map((p) => {
        const kick =
          st.isCreator && !p.isCreator
            ? h('button', { class: 'btn ghost small kick', type: 'button', title: `Remove ${p.nickname}`, 'aria-label': `Remove ${p.nickname}`, onclick: () => this.ctx.send({ type: 'kick', pid: p.pid }) }, icon('close'), h('span', { class: 'hide-xs' }, 'Remove'))
            : null;
        return h(
          'li',
          { class: p.pid === mine?.pid ? 'is-me' : '' },
          playerSeal(p, this.ctx.user),
          playerNameButton(p, this.ctx.user),
          p.isCreator ? h('span', { class: 'tag brass' }, icon('crown'), 'creator') : null,
          p.pid === mine?.pid ? h('span', { class: 'tag good' }, 'you') : null,
          h('span', { class: 'spacer' }),
          kick,
        );
      }),
    );

    // Side: profile editor or join
    if (st.participant && mine) {
      if (this.sideEl.firstChild !== this.profileCard) replaceChildren(this.sideEl, this.profileCard);
      if (document.activeElement !== this.nickInput) this.nickInput.value = mine.nickname;
      const flagName = this.flags.find((f) => f.code === mine.flag)?.name ?? mine.flag;
      replaceChildren(
        this.myFlagEl,
        h('span', { class: 'seal big' }, flagImg(mine.flag, 'flag big')),
        h('span', { class: 'my-flag-text' }, h('strong', null, flagName), h('span', { class: 'muted small' }, 'Your banner on the map')),
      );
      const owners = new Map(st.players.map((p) => [p.flag, p]));
      for (const [code, btn] of this.flagButtons) {
        const owner = owners.get(code);
        const name = this.flags.find((f) => f.code === code)?.name ?? code;
        btn.classList.toggle('mine', owner?.pid === mine.pid);
        btn.classList.toggle('taken', !!owner && owner.pid !== mine.pid);
        btn.setAttribute('aria-pressed', String(owner?.pid === mine.pid));
        if (owner && owner.pid !== mine.pid) btn.setAttribute('aria-disabled', 'true');
        else btn.removeAttribute('aria-disabled');
        btn.title = owner && owner.pid !== mine.pid ? `${name}: taken by ${owner.nickname}` : name;
      }
    } else {
      const full = st.players.length >= st.rules.maxPlayers;
      const join = h('button', { class: 'btn primary wide', type: 'button' }, full ? 'This room is full' : 'Join this game');
      join.disabled = full;
      join.addEventListener('click', () => this.ctx.send({ type: 'join' }));
      replaceChildren(
        this.joinCard,
        h('h2', { class: 'card-title' }, 'Want to play?'),
        h('p', { class: 'muted' }, 'Join to pick your nickname and flag. You can leave any time before the game starts.'),
        join,
      );
      if (this.sideEl.firstChild !== this.joinCard) replaceChildren(this.sideEl, this.joinCard);
    }
  }
}
