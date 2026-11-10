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
import { countryName, countryNameIn, L, onLang, t, T } from './i18n.ts';
import { langSwitch } from './lang-switch.ts';
import { notifyBell } from './notify-panel.ts';
import { startAtText } from './lobby-time.ts';

export class LobbyView {
  readonly el: HTMLElement;
  private readonly ctx: RoomCtx;
  private state!: RoomView;
  private flags: FlagInfo[] = [];
  private readonly flagButtons = new Map<string, HTMLButtonElement>();
  private readonly timer: number;
  private confirmingStart = false;
  private readonly offLang: () => void;

  private readonly titleEl = h('h1', { class: 'lobby-title display' });
  private readonly statusEl = h('p', { class: 'lobby-status' });
  private readonly countEl = h('span', { class: 'count-pill' });
  private readonly shareInput = h('input', { class: 'share-input', readonly: true, 'aria-label': L('lobby.inviteLink') });
  private readonly controlsEl = h('div', { class: 'lobby-controls' });
  private readonly playersEl = h('ul', { class: 'lobby-players' });
  private readonly sideEl = h('div', { class: 'lobby-side' });
  private readonly nickInput = h('input', { id: 'nick-input', maxlength: NICKNAME_MAX, placeholder: L('lobby.nickPlaceholder'), autocomplete: 'off' });
  private readonly flagSearchField = searchField(L('lobby.searchCountries'), L('lobby.searchFlags'));
  private readonly flagSearch = this.flagSearchField.input;
  private readonly flagGrid = h('div', { class: 'flag-grid', role: 'group', 'aria-label': L('lobby.flags') }, h('p', { class: 'muted' }, T('lobby.loadingFlags')));
  private readonly flagEmpty = h('p', { class: 'flag-empty', hidden: true }, T('lobby.noCountry'));
  private readonly myFlagEl = h('div', { class: 'my-flag' });
  private readonly profileCard: HTMLElement;
  private readonly joinCard: HTMLElement;
  private readonly settings: SettingsPanel;
  private rulesKey = '';
  /** Live 3D preview of the board: grows/shrinks with Map radius, players stand around it. */
  private readonly preview = new HexMap({ preview: true });
  private readonly previewTitle = h('strong', null, T('lobby.theMap'));
  private previewRadius = -1;

  constructor(ctx: RoomCtx) {
    this.ctx = ctx;
    this.settings = new SettingsPanel((changes) => this.ctx.send({ type: 'settings', changes }));
    this.settings.onRadiusPreview = (r) => this.setPreviewRadius(r);
    // The Start button says whether it will also save the creator's unsaved settings.
    this.settings.onDirtyChange = () => {
      if (this.state) this.render();
    };
    this.shareInput.value = `${location.origin}/r/${ctx.code}`;
    const copyBtn = h('button', { class: 'btn secondary', type: 'button' }, icon('copy'), T('lobby.copyLink'));
    copyBtn.addEventListener('click', () => this.copyLink());

    const saveNick = (): void => {
      const value = this.nickInput.value.trim();
      const mine = this.myPlayer();
      if (mine && value && value !== mine.nickname) this.ctx.send({ type: 'profile', nickname: value });
    };
    const nickForm = h('form', { class: 'nick-form' }, this.nickInput, h('button', { class: 'btn secondary', type: 'submit' }, T('common.save')));
    nickForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      saveNick();
    });
    this.nickInput.addEventListener('blur', saveNick);
    this.flagSearch.addEventListener('input', () => this.filterFlags());

    this.profileCard = h(
      'section',
      { class: 'card framed profile-card' },
      h('h2', { class: 'card-title' }, T('lobby.yourCountry')),
      h('label', { class: 'field-label', for: 'nick-input' }, T('lobby.nickname')),
      nickForm,
      h('span', { class: 'field-label' }, T('lobby.flag')),
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
        h('button', { class: 'btn ghost small back-btn', title: L('app.backToRooms'), 'aria-label': L('app.backToRooms'), onclick: () => navigate('/') }, icon('back'), h('span', { class: 'back-label' }, T('lb.rooms'))),
        h('div', { class: 'topbar-divider', 'aria-hidden': 'true' }),
        logo(true),
        h('div', { class: 'spacer' }),
        notifyBell(),
        langSwitch(),
        userMenu(ctx.user),
      ),
      h(
        'main',
        { class: 'lobby-page' },
        h(
          'section',
          { class: 'card framed lobby-head' },
          h('p', { class: 'eyebrow' }, h('span', { class: 'badge lobby' }, T('lobby.lobby')), T('lobby.room', { code: ctx.code.toUpperCase() })),
          this.titleEl,
          this.statusEl,
          h('div', { class: 'share-row' }, h('div', { class: 'share-field' }, icon('link'), this.shareInput), copyBtn),
          this.controlsEl,
        ),
        h(
          'section',
          { class: 'card framed lobby-map', 'aria-label': L('lobby.mapPreview') },
          h(
            'div',
            { class: 'lobby-map-caption' },
            h('span', { class: 'eyebrow' }, T('lobby.mapPreview')),
            this.previewTitle,
            h('span', { class: 'muted' }, T('lobby.placesHint')),
          ),
          this.preview.el,
        ),
        h(
          'div',
          { class: 'lobby-grid' },
          h(
            'div',
            { class: 'lobby-main' },
            h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, T('lobby.players')), this.countEl), this.playersEl),
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
      .catch(() => replaceChildren(this.flagGrid, h('p', { class: 'form-error' }, T('lobby.flagsFailed'))));

    this.timer = window.setInterval(() => this.renderStatus(), 500);
    this.offLang = onLang(() => {
      for (const f of this.flags) {
        const btn = this.flagButtons.get(f.code);
        if (btn) btn.setAttribute('aria-label', countryName(f.code, f.name));
      }
      if (this.previewRadius >= 0) this.previewTitle.textContent = t('lobby.radius', { r: this.previewRadius, cells: cellCount(this.previewRadius) });
      if (this.state) this.render();
    });
  }

  destroy(): void {
    this.offLang();
    clearInterval(this.timer);
    this.preview.destroy();
  }

  private setPreviewRadius(r: number): void {
    if (r === this.previewRadius) return;
    this.previewRadius = r;
    this.preview.setRadius(r);
    this.previewTitle.textContent = t('lobby.radius', { r, cells: cellCount(r) });
  }

  update(state: RoomView): void {
    const key = JSON.stringify(state.rules);
    if (this.rulesKey && key !== this.rulesKey) {
      toast(state.isCreator ? t('lobby.settingsSaved') : t('lobby.settingsChanged'), state.isCreator ? 'good' : 'info', 3000);
    }
    this.rulesKey = key;
    this.state = state;
    this.render();
    this.settings.update(state.rules, state.isCreator, state.players.length, state.lobbyEndsAt);
    this.preview.roster(state.players, state.me?.pid ?? null);
  }

  private myPlayer() {
    const pid = this.state?.me?.pid;
    return pid === undefined ? undefined : this.state.players.find((p) => p.pid === pid);
  }

  private async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.shareInput.value);
      toast(t('lobby.linkCopied'), 'good');
    } catch {
      this.shareInput.select();
      toast(t('lobby.pressCopy'), 'info');
    }
  }

  private buildFlagGrid(): void {
    this.flagButtons.clear();
    const buttons = this.flags.map((f) => {
      const btn = h('button', { class: 'flag-btn', type: 'button', title: countryName(f.code, f.name), 'aria-label': countryName(f.code, f.name), 'aria-pressed': 'false', 'data-code': f.code }, flagImg(f.code));
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
      btn.hidden = q !== '' && !this.flagMatches(f, q);
      if (!btn.hidden) shown++;
    }
    this.flagEmpty.hidden = shown > 0 || this.flags.length === 0;
  }

  /** A search matches the English or Russian country name (or the ISO code). */
  private flagMatches(f: FlagInfo, q: string): boolean {
    if (f.code === q || f.name.toLowerCase().includes(q)) return true;
    return countryNameIn('ru', f.code, f.name).toLowerCase().replace(/ё/g, 'е').includes(q.replace(/ё/g, 'е'));
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
            // "Starts at 21:00 UTC+3 (22:00 your time)." — the moment, then the countdown.
            h('span', { class: 'lobby-start-at' }, startAtText(st.lobbyEndsAt, st.rules)),
            ' ',
            ...withSlot(
              st.isCreator ? t('lobby.autoStartYou') : t('lobby.autoStartOther', { name: creator?.nickname ?? t('lobby.theCreator') }),
              h('strong', { class: 'countdown' }, countdown(left)),
            ),
          ),
        );
      } else {
        replaceChildren(this.statusEl, icon('clock'), h('span', null, t('lobby.starting')));
      }
    } else {
      replaceChildren(
        this.statusEl,
        icon('clock'),
        h(
          'span',
          null,
          st.isCreator ? t('lobby.overYou') : t('lobby.overOther', { name: creator?.nickname ?? t('lobby.theCreator') }),
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
      const unsaved = this.settings.dirtyCount;
      const start = h('button', { class: 'btn primary', type: 'button' }, unsaved ? t('lobby.saveAndStart') : t('lobby.startNow'));
      if (st.players.length < 2) controls.push(h('span', { class: 'controls-note' }, t('lobby.waitingOneMore')));
      if (unsaved) {
        const review = h('button', { class: 'linkish', type: 'button' }, t('lobby.review'));
        review.addEventListener('click', () => this.settings.reveal());
        controls.push(
          h(
            'span',
            { class: 'controls-note unsaved-note', role: 'status' },
            icon('alert'),
            h('span', null, t('lobby.unsaved', { n: unsaved })),
            review,
          ),
        );
      }
      start.disabled = st.players.length < 2;
      start.title = start.disabled ? t('lobby.needTwo') : '';
      if (this.confirmingStart) {
        start.textContent = unsaved ? t('lobby.confirmSaveStart', { n: st.players.length }) : t('lobby.confirmStart', { n: st.players.length });
        start.classList.add('confirm');
      }
      start.addEventListener('click', () => {
        if (this.confirmingStart) {
          this.confirmingStart = false;
          // Unsaved form values go with the start: the server saves them (or refuses) first.
          const pending = this.settings.pending();
          if ('error' in pending) {
            toast(pending.error, 'error');
            this.settings.reveal();
            this.render();
            return;
          }
          const changes = pending.changes;
          this.ctx.send(Object.keys(changes).length ? { type: 'start', settings: changes } : { type: 'start' });
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
      const leave = h('button', { class: 'btn secondary', type: 'button' }, t('lobby.leave'));
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
            ? h('button', { class: 'btn ghost small kick', type: 'button', title: t('lobby.removeName', { name: p.nickname }), 'aria-label': t('lobby.removeName', { name: p.nickname }), onclick: () => this.ctx.send({ type: 'kick', pid: p.pid }) }, icon('close'), h('span', { class: 'hide-xs' }, t('lobby.remove')))
            : null;
        return h(
          'li',
          { class: p.pid === mine?.pid ? 'is-me' : '' },
          playerSeal(p, this.ctx.user),
          playerNameButton(p, this.ctx.user),
          p.isCreator ? h('span', { class: 'tag brass' }, icon('crown'), t('lobby.creator')) : null,
          p.pid === mine?.pid ? h('span', { class: 'tag good' }, t('common.you')) : null,
          h('span', { class: 'spacer' }),
          kick,
        );
      }),
    );

    // Side: profile editor or join
    if (st.participant && mine) {
      if (this.sideEl.firstChild !== this.profileCard) replaceChildren(this.sideEl, this.profileCard);
      if (document.activeElement !== this.nickInput) this.nickInput.value = mine.nickname;
      const flagName = countryName(mine.flag, this.flags.find((f) => f.code === mine.flag)?.name ?? mine.flag);
      replaceChildren(
        this.myFlagEl,
        h('span', { class: 'seal big' }, flagImg(mine.flag, 'flag big')),
        h('span', { class: 'my-flag-text' }, h('strong', null, flagName), h('span', { class: 'muted small' }, t('lobby.yourBanner'))),
      );
      const owners = new Map(st.players.map((p) => [p.flag, p]));
      for (const [code, btn] of this.flagButtons) {
        const owner = owners.get(code);
        const name = countryName(code, this.flags.find((f) => f.code === code)?.name ?? code);
        btn.classList.toggle('mine', owner?.pid === mine.pid);
        btn.classList.toggle('taken', !!owner && owner.pid !== mine.pid);
        btn.setAttribute('aria-pressed', String(owner?.pid === mine.pid));
        if (owner && owner.pid !== mine.pid) btn.setAttribute('aria-disabled', 'true');
        else btn.removeAttribute('aria-disabled');
        btn.title = owner && owner.pid !== mine.pid ? t('lobby.flagTakenBy', { country: name, name: owner.nickname }) : name;
      }
    } else {
      const full = st.players.length >= st.rules.maxPlayers;
      const join = h('button', { class: 'btn primary wide', type: 'button' }, full ? t('lobby.full') : t('lobby.join'));
      join.disabled = full;
      join.addEventListener('click', () => this.ctx.send({ type: 'join' }));
      replaceChildren(
        this.joinCard,
        h('h2', { class: 'card-title' }, t('lobby.wantToPlay')),
        h('p', { class: 'muted' }, t('lobby.joinText')),
        join,
      );
      if (this.sideEl.firstChild !== this.joinCard) replaceChildren(this.sideEl, this.joinCard);
    }
  }
}

/** Splits a sentence at its `{slot}` and puts `node` there (e.g. a live countdown inside a sentence). */
function withSlot(text: string, node: Node): Array<string | Node> {
  const i = text.indexOf('{slot}');
  if (i < 0) return [text, ' ', node];
  return [text.slice(0, i), node, text.slice(i + 6)];
}
