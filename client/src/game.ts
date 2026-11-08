// The in-game screen: map, own stats, actions (keys 1-4 or buttons), players, log,
// and the winner screen with the full reveal.

import { hexDistance, type Hex } from '../../shared/hex.ts';
import type { ActionResult, GameAction, LogEntry, PublicPlayer, RoomView } from '../../shared/protocol.ts';
import type { GameSettings } from '../../shared/settings.ts';
import { flagImg, h, replaceChildren, toast } from './dom.ts';
import { clockTime, countdown, historyText, logKind, personalText } from './format.ts';
import { HexMap } from './map.ts';
import { logout, navigate } from './nav.ts';
import type { RoomCtx } from './room.ts';

type ActionKind = 'move' | 'attack' | 'grant' | 'upgrade';

interface ActionDef {
  kind: ActionKind;
  key: string;
  icon: string;
  label: (r: GameSettings) => string;
  cost: (r: GameSettings) => number;
}

const ACTIONS: ActionDef[] = [
  { kind: 'move', key: '1', icon: '➜', label: () => 'Move', cost: (r) => r.costMove },
  { kind: 'attack', key: '2', icon: '⚔', label: (r) => (r.attackDamage > 1 ? `Attack (−${r.attackDamage})` : 'Attack'), cost: (r) => r.costAttack },
  { kind: 'grant', key: '3', icon: '✚', label: (r) => `Give ${r.grantAmount} AP`, cost: (r) => r.costGrant },
  { kind: 'upgrade', key: '4', icon: '◎', label: (r) => `Range +${r.upgradeAmount}`, cost: (r) => r.costUpgrade },
];

const KEY_TO_ACTION: Record<string, ActionKind> = {
  Digit1: 'move',
  Digit2: 'attack',
  Digit3: 'grant',
  Digit4: 'upgrade',
  Numpad1: 'move',
  Numpad2: 'attack',
  Numpad3: 'grant',
  Numpad4: 'upgrade',
};

const PHASE_LABEL: Record<string, string> = { running: 'Live', paused: 'Paused', finished: 'Game over', lobby: 'Lobby' };

const isTouch = (): boolean => window.matchMedia('(hover: none)').matches;

export class GameView {
  readonly el: HTMLElement;
  private readonly ctx: RoomCtx;
  private readonly map = new HexMap();
  private state!: RoomView;
  private log: LogEntry[] = [];
  private reqId = 0;
  private readonly pending = new Map<number, { kind: ActionKind; cell: Hex | null }>();
  private readonly lastPos = new Map<number, Hex>();
  private winnerShown = false;
  private readonly timer: number;

  private readonly titleEl = h('strong', { class: 'room-name' });
  private readonly phaseEl = h('span', { class: 'badge' });
  private readonly timerEl = h('strong', { class: 'timer-value' }, '--:--');
  private readonly timerLabel = h('span', { class: 'muted' }, 'Next AP in');
  private readonly resultsBtn = h('button', { class: 'btn small hidden' }, 'Results');
  private readonly bannerEl = h('div', { class: 'banner hidden' });
  private readonly meFlag = h('div', { class: 'me-flag' });
  private readonly meName = h('div', { class: 'me-name' });
  private readonly hpEl = h('div', { class: 'stat-value hp' });
  private readonly apEl = h('div', { class: 'stat-value ap' });
  private readonly rangeEl = h('div', { class: 'stat-value range' });
  private readonly actionBtns = new Map<ActionKind, HTMLButtonElement>();
  private readonly infoEl = h('div', { class: 'cell-info' });
  private readonly playersEl = h('ul', { class: 'players' });
  private readonly logEl = h('ol', { class: 'log' });
  private readonly overlay = h('div', { class: 'overlay hidden' });
  private readonly onKey = (ev: KeyboardEvent): void => this.handleKey(ev);

  constructor(ctx: RoomCtx) {
    this.ctx = ctx;
    this.map.onHover = () => this.renderInfo();
    this.map.onSelect = () => this.renderInfo();

    const actionsEl = h('div', { class: 'actions' });
    for (const a of ACTIONS) {
      const btn = h(
        'button',
        { class: `action action-${a.kind}`, type: 'button' },
        h('span', { class: 'action-icon' }, a.icon),
        h('span', { class: 'action-label' }),
        h('span', { class: 'action-cost' }),
        h('kbd', { class: 'kbd' }, a.key),
      );
      // pointerdown would be faster, but click keeps scrolling on phones from firing actions.
      btn.addEventListener('click', () => this.doAction(a.kind));
      this.actionBtns.set(a.kind, btn);
      actionsEl.appendChild(btn);
    }
    this.resultsBtn.addEventListener('click', () => this.showWinner());

    this.el = h(
      'div',
      { class: 'game' },
      h(
        'header',
        { class: 'topbar game-top' },
        h('button', { class: 'btn ghost small', onclick: () => navigate('/') }, '← Rooms'),
        h('div', { class: 'room-title' }, this.titleEl, this.phaseEl),
        h('div', { class: 'spacer' }),
        this.resultsBtn,
        h('div', { class: 'ap-timer' }, this.timerLabel, this.timerEl),
        h('button', { class: 'btn ghost small logout', title: 'Log out of this tab', onclick: () => logout() }, 'Log out'),
      ),
      h(
        'div',
        { class: 'game-body' },
        h('div', { class: 'map-col' }, h('div', { class: 'map-wrap' }, this.map.el), this.infoEl),
        h(
          'aside',
          { class: 'side' },
          this.bannerEl,
          h(
            'section',
            { class: 'me-card card' },
            h('div', { class: 'me-head' }, this.meFlag, this.meName),
            h(
              'div',
              { class: 'stats' },
              h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'HP'), this.hpEl),
              h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'AP'), this.apEl),
              h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Range'), this.rangeEl),
            ),
          ),
          h('section', { class: 'actions-card card' }, actionsEl, h('p', { class: 'hint kbd-hint' }, 'Point at a cell and press 1–4. No confirmation: actions fire instantly.')),
          h('section', { class: 'players-card card' }, h('h3', null, 'Players'), this.playersEl),
          h('section', { class: 'log-card card' }, h('h3', null, 'Your log'), this.logEl),
        ),
      ),
      this.overlay,
    );

    window.addEventListener('keydown', this.onKey);
    this.timer = window.setInterval(() => this.renderTimer(), 250);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey);
    clearInterval(this.timer);
  }

  update(state: RoomView, log: LogEntry[], fresh: LogEntry[], result?: ActionResult): void {
    const prevPos = new Map(this.lastPos);
    this.state = state;
    this.log = log;
    this.map.setRadius(state.rules.gridRadius);
    this.renderAll();
    if (result) this.handleResult(result);
    for (const e of fresh) this.animate(e, prevPos);
    this.lastPos.clear();
    for (const p of state.players) if (p.alive && p.q !== null && p.r !== null) this.lastPos.set(p.pid, { q: p.q, r: p.r });
    if (state.phase === 'finished' && !this.winnerShown) {
      this.winnerShown = true;
      this.showWinner();
    }
  }

  /** Called for results that arrive without a state change (failed actions). */
  result(result: ActionResult): void {
    this.handleResult(result);
  }

  // ---------------------------------------------------------------- helpers

  private player(pid: number | undefined): PublicPlayer | undefined {
    return pid === undefined ? undefined : this.state.players.find((p) => p.pid === pid);
  }

  private readonly name = (pid: number | undefined): string => this.player(pid)?.nickname ?? 'someone';

  private posOf(pid: number | undefined): Hex | null {
    const p = this.player(pid);
    return p && p.alive && p.q !== null && p.r !== null ? { q: p.q, r: p.r } : null;
  }

  private playerAt(cell: Hex): PublicPlayer | undefined {
    return this.state.players.find((p) => p.alive && p.q === cell.q && p.r === cell.r);
  }

  private canAct(): boolean {
    return this.state.phase === 'running' && !!this.state.me?.alive;
  }

  private pulse(el: HTMLElement, cls: string): void {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // ---------------------------------------------------------------- actions

  private handleKey(ev: KeyboardEvent): void {
    if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (ev.key === 'Escape') {
      this.map.setSelected(null);
      if (!this.overlay.classList.contains('hidden')) this.overlay.classList.add('hidden');
      return;
    }
    const kind = KEY_TO_ACTION[ev.code];
    if (!kind) return;
    ev.preventDefault();
    this.doAction(kind);
  }

  private doAction(kind: ActionKind): void {
    const st = this.state;
    if (!st) return;
    if (st.phase !== 'running') {
      toast(st.phase === 'paused' ? 'The game is paused' : 'The game is over', 'error');
      return;
    }
    const me = st.me;
    if (!me || !me.alive) {
      toast("You've been eliminated: you can watch, but not act", 'error');
      return;
    }
    const cell = kind === 'upgrade' ? null : (this.map.hovered ?? this.map.selected);
    if (kind !== 'upgrade' && !cell) {
      toast(isTouch() ? 'Tap a cell first' : 'Point at a cell first', 'error');
      return;
    }
    let action: GameAction;
    if (kind === 'move') {
      action = { type: 'move', q: cell!.q, r: cell!.r };
    } else if (kind === 'attack' || kind === 'grant') {
      const target = this.playerAt(cell!);
      if (!target) {
        this.map.flashCell(cell!);
        toast('No player there', 'error');
        return;
      }
      if (target.pid === me.pid) {
        toast("That's you", 'error');
        return;
      }
      action = { type: kind, target: target.pid };
    } else {
      action = { type: 'upgrade' };
    }
    const id = ++this.reqId;
    this.pending.set(id, { kind, cell });
    this.ctx.send({ type: 'act', id, action });
  }

  private handleResult(result: ActionResult): void {
    const req = this.pending.get(result.id);
    this.pending.delete(result.id);
    if (result.ok) return;
    toast(result.error ?? 'Action failed', 'error');
    if (req?.cell) this.map.flashCell(req.cell);
  }

  // ---------------------------------------------------------------- animations

  private animate(e: LogEntry, prevPos: Map<number, Hex>): void {
    const myPid = this.state.me?.pid ?? null;
    const where = (pid: number | undefined | null): Hex | null =>
      pid === undefined || pid === null ? null : (this.posOf(pid) ?? prevPos.get(pid) ?? null);
    const myPos = where(myPid);
    switch (e.type) {
      case 'attack': {
        const to = where(e.target);
        if (myPos && to) this.map.shot(myPos, to, 'attack');
        if (to) this.map.float(to, `−${e.amount ?? 1}`, 'bad');
        break;
      }
      case 'hit':
        if (myPid !== null) this.map.shake(myPid);
        if (myPos) this.map.float(myPos, `−${e.amount ?? 1} HP`, 'bad');
        this.pulse(this.hpEl, 'pulse-bad');
        this.pulse(this.el, 'hit-flash');
        break;
      case 'grant': {
        const to = where(e.target);
        if (myPos && to) this.map.shot(myPos, to, 'grant');
        if (to) this.map.float(to, `+${e.amount ?? 1}`, 'good');
        break;
      }
      case 'granted':
        if (myPos) this.map.float(myPos, `+${e.amount ?? 1} AP`, 'good');
        this.pulse(this.apEl, 'pulse-good');
        toast(`Someone gave you ${e.amount ?? 1} AP`, 'good');
        break;
      case 'upgrade':
        if (myPos) this.map.ring(myPos, 'range');
        this.pulse(this.rangeEl, 'pulse-good');
        break;
      case 'eliminate': {
        const at = e.at ? { q: e.at[0], r: e.at[1] } : where(e.target);
        if (at) this.map.burst(at);
        toast(personalText(e, this.name, myPid), e.target === myPid ? 'error' : 'info', 4000);
        break;
      }
      case 'tick':
        if (myPos && this.state.me?.alive) this.map.float(myPos, `+${e.amount ?? 1} AP`, 'good');
        this.pulse(this.apEl, 'pulse-good');
        toast(`Everyone received ${e.amount ?? 1} AP`, 'good');
        break;
      case 'start':
        toast('The game has started!', 'good', 3000);
        break;
      case 'pause':
        toast('The game was paused', 'info', 3000);
        break;
      case 'resume':
        toast('The game was resumed', 'good', 3000);
        break;
      case 'adjust':
        toast('An admin changed your stats', 'info');
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- rendering

  private renderAll(): void {
    const st = this.state;
    const me = st.me;
    const mePub = this.player(me?.pid);
    const myPos = this.posOf(me?.pid);
    const canAct = this.canAct();

    this.titleEl.textContent = st.name;
    this.phaseEl.textContent = PHASE_LABEL[st.phase] ?? st.phase;
    this.phaseEl.className = `badge ${st.phase}`;
    this.resultsBtn.classList.toggle('hidden', st.phase !== 'finished');
    this.el.classList.toggle('dead', !!me && !me.alive);
    this.el.classList.toggle('inactive', !canAct);

    // Banner
    let banner: HTMLElement | null = null;
    if (st.phase === 'finished') {
      const w = this.player(st.winnerPid ?? undefined);
      banner = h('div', null, w ? (w.pid === me?.pid ? 'You won the game! 🏆' : `Game over: ${w.nickname} won.`) : 'Game over.');
    } else if (me && !me.alive) {
      const by = mePub?.eliminatedBy ?? null;
      banner = h('div', null, `You were eliminated${by !== null ? ` by ${this.name(by)}` : ''}. You can keep watching.`);
    } else if (st.phase === 'paused') {
      banner = h('div', null, 'The game is paused by the admin.');
    }
    this.bannerEl.classList.toggle('hidden', !banner);
    if (banner) replaceChildren(this.bannerEl, banner);

    // Me
    if (mePub) {
      replaceChildren(this.meFlag, flagImg(mePub.flag, 'flag big'));
      this.meName.textContent = mePub.nickname;
    }
    if (me) {
      const hp = me.hp;
      replaceChildren(
        this.hpEl,
        hp <= 8 ? h('span', { class: 'hearts' }, '♥'.repeat(hp) || '–') : h('span', null, `♥ ${hp}`),
      );
      this.apEl.textContent = String(me.ap);
      this.rangeEl.textContent = String(me.range);
    }

    // Actions
    for (const a of ACTIONS) {
      const btn = this.actionBtns.get(a.kind)!;
      const cost = a.cost(st.rules);
      (btn.querySelector('.action-label') as HTMLElement).textContent = a.label(st.rules);
      (btn.querySelector('.action-cost') as HTMLElement).textContent = `${cost} AP`;
      btn.disabled = !canAct;
      btn.classList.toggle('poor', !!me && me.ap < cost);
    }

    // Players
    const sorted = [...st.players].sort((a, b) => Number(b.alive) - Number(a.alive) || a.nickname.localeCompare(b.nickname));
    replaceChildren(
      this.playersEl,
      sorted.map((p) => {
        const pos = this.posOf(p.pid);
        const dist = myPos && pos ? hexDistance(myPos, pos) : null;
        const inRange = dist !== null && me ? dist <= me.range && p.pid !== me.pid : false;
        let detail: string;
        if (!p.alive) detail = p.eliminatedBy !== null ? `out, by ${this.name(p.eliminatedBy)}` : 'out';
        else if (p.pid === me?.pid) detail = 'you';
        else detail = dist !== null ? `${dist} away` : '';
        return h(
          'li',
          { class: `player ${p.alive ? '' : 'out'} ${p.pid === me?.pid ? 'is-me' : ''}` },
          flagImg(p.flag),
          h('span', { class: 'player-name' }, p.nickname),
          inRange ? h('span', { class: 'in-range-dot', title: 'In your range' }, '◉') : null,
          h('span', { class: 'player-detail' }, detail),
        );
      }),
    );

    // Log (newest first)
    const recent = this.log.slice(-200).reverse();
    replaceChildren(
      this.logEl,
      recent.length
        ? recent.map((e) =>
            h('li', { class: `log-entry ${logKind(e)}` }, h('time', null, clockTime(e.ts)), h('span', null, personalText(e, this.name, me?.pid ?? null))),
          )
        : h('li', { class: 'empty' }, 'Nothing yet.'),
    );

    this.map.render({ players: st.players, myPid: me?.pid ?? null, myPos, range: me?.range ?? 0, showRange: canAct });
    this.renderInfo();
    this.renderTimer();
  }

  private renderTimer(): void {
    const st = this.state;
    if (!st) return;
    if (st.phase === 'running' && st.nextTickAt !== null) {
      this.timerLabel.textContent = 'Next AP in';
      this.timerEl.textContent = countdown(st.nextTickAt - this.ctx.serverNow());
    } else if (st.phase === 'paused') {
      this.timerLabel.textContent = 'AP timer';
      this.timerEl.textContent = 'paused';
    } else {
      this.timerLabel.textContent = '';
      this.timerEl.textContent = '';
    }
  }

  private renderInfo(): void {
    const st = this.state;
    if (!st) return;
    const cell = this.map.hovered ?? this.map.selected;
    const myPos = this.posOf(st.me?.pid);
    if (!cell) {
      replaceChildren(
        this.infoEl,
        h('span', { class: 'muted' }, isTouch() ? 'Tap a cell, then pick an action below.' : 'Point at a cell, then press 1 move · 2 attack · 3 give AP · 4 upgrade range.'),
      );
      return;
    }
    const dist = myPos ? hexDistance(myPos, cell) : null;
    const occupant = this.playerAt(cell);
    const parts: Array<HTMLElement | string> = [];
    if (occupant) {
      parts.push(flagImg(occupant.flag), h('strong', null, occupant.nickname));
      if (occupant.pid === st.me?.pid) parts.push(h('span', { class: 'muted' }, '(you)'));
      else if (dist !== null && st.me) {
        parts.push(dist <= st.me.range ? h('span', { class: 'tag good' }, 'in range') : h('span', { class: 'tag' }, 'out of range'));
      }
    } else {
      parts.push(h('span', { class: 'muted' }, 'Empty cell'));
      if (dist === 1 && this.canAct()) parts.push(h('span', { class: 'tag good' }, 'you can move here'));
    }
    if (dist !== null && dist > 0) parts.push(h('span', { class: 'muted' }, `${dist} ${dist === 1 ? 'cell' : 'cells'} away`));
    replaceChildren(this.infoEl, ...parts);
  }

  // ---------------------------------------------------------------- winner screen

  private showWinner(): void {
    const st = this.state;
    if (st.phase !== 'finished') return;
    const winner = this.player(st.winnerPid ?? undefined);
    const reveal = st.reveal;
    const close = h('button', { class: 'btn primary', onclick: () => this.overlay.classList.add('hidden') }, 'Close');
    const rows = reveal
      ? [...reveal.players]
          .sort((a, b) => {
            const pa = this.player(a.pid);
            const pb = this.player(b.pid);
            if (a.pid === st.winnerPid) return -1;
            if (b.pid === st.winnerPid) return 1;
            return (pb?.eliminatedAt ?? 0) - (pa?.eliminatedAt ?? 0);
          })
          .map((r) => {
            const p = this.player(r.pid);
            return h(
              'tr',
              { class: r.pid === st.winnerPid ? 'winner-row' : '' },
              h('td', { class: 'who' }, p ? flagImg(p.flag) : null, p?.nickname ?? '?'),
              h('td', null, String(r.hp)),
              h('td', null, String(r.ap)),
              h('td', null, String(r.range)),
              h('td', null, String(r.kills)),
              h('td', null, String(r.damageDealt)),
              h('td', null, String(r.damageTaken)),
              h('td', null, String(r.apGiven)),
              h('td', null, String(r.apReceived)),
              h('td', null, String(r.upgrades)),
              h('td', { class: 'muted' }, p && !p.alive ? (p.eliminatedBy !== null ? `by ${this.name(p.eliminatedBy)}` : 'admin') : '—'),
            );
          })
      : [];
    const history = reveal ? reveal.history.filter((e) => e.type !== 'tick') : [];

    replaceChildren(
      this.overlay,
      h(
        'div',
        { class: 'card winner-card', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'trophy' }, '🏆'),
        winner
          ? h('h2', { class: 'winner-title' }, flagImg(winner.flag, 'flag big'), winner.pid === st.me?.pid ? 'You won!' : `${winner.nickname} wins!`)
          : h('h2', null, 'Game over'),
        reveal
          ? [
              h('h3', null, 'Final stats'),
              h(
                'div',
                { class: 'table-wrap' },
                h(
                  'table',
                  { class: 'reveal-table' },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      ['Player', 'HP', 'AP', 'Range', 'Kills', 'Dmg dealt', 'Dmg taken', 'AP given', 'AP got', 'Upgrades', 'Out'].map((t) => h('th', null, t)),
                    ),
                  ),
                  h('tbody', null, rows),
                ),
              ),
              h('h3', null, 'What really happened'),
              h(
                'ol',
                { class: 'history' },
                history.map((e) => h('li', { class: logKind(e) }, h('time', null, clockTime(e.ts)), h('span', null, historyText(e, this.name)))),
              ),
            ]
          : null,
        h('div', { class: 'winner-actions' }, close),
      ),
    );
    this.overlay.classList.remove('hidden');
  }
}
