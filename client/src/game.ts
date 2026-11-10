// The in-game screen: map, own stats, actions (keys 1-4 or buttons), chat, players, log,
// and the winner screen with the full reveal.

import { langSwitch } from './lang-switch.ts';
import { notifyBell } from './notify-panel.ts';
import { actionCost, escalates, nextActionCost } from '../../shared/costs.ts';
import { hexDistance, hexRing, inGrid, type Hex } from '../../shared/hex.ts';
import type { ActionResult, GameAction, LogEntry, PublicPlayer, RoomView } from '../../shared/protocol.ts';
import type { GameSettings } from '../../shared/settings.ts';
import { clearToasts, closeTransient, flagImg, h, replaceChildren, toast } from './dom.ts';
import { errorText } from './errors.ts';
import { fmtList, L, onLang, t, T, type Key } from './i18n.ts';
import { ActionMenu, type ActionMenuItem } from './board-menu.ts';
import { clockTime, countdown, historyText, logKind, personalText } from './format.ts';
import { HexMap, type CellGesture } from './map.ts';
import { navigate } from './nav.ts';
import { playerNameButton, playerSeal, userMenu } from './profile.ts';
import type { RoomCtx } from './room.ts';
import { icon } from './ui.ts';
import { BlitzPanel } from './blitz.ts';
import { blitzNextCost } from '../../shared/blitz.ts';

/** 'charge' exists only in blitz games (its button is hidden in classic ones). */
type ActionKind = 'move' | 'attack' | 'grant' | 'upgrade' | 'charge';

interface ActionDef {
  kind: ActionKind;
  key: string;
  icon: string;
  label: (r: GameSettings) => string;
  /** Phone tile label: one short line (the full label stays in the title / desktop). */
  short: (r: GameSettings) => string;
  cost: (r: GameSettings) => number;
}

const ACTIONS: ActionDef[] = [
  { kind: 'move', key: '1', icon: 'move', label: () => t('game.act.move'), short: () => t('game.actShort.move'), cost: (r) => r.costMove },
  {
    kind: 'attack',
    key: '2',
    icon: 'attack',
    label: (r) => (r.attackDamage > 1 ? t('game.act.attackDmg', { n: r.attackDamage }) : t('game.act.attack')),
    short: (r) => (r.attackDamage > 1 ? t('game.actShort.attackDmg', { n: r.attackDamage }) : t('game.actShort.attack')),
    cost: (r) => r.costAttack,
  },
  {
    kind: 'grant',
    key: '3',
    icon: 'grant',
    label: (r) => t('game.act.grant', { n: r.grantAmount }),
    short: (r) => (r.grantAmount > 1 ? t('game.actShort.grantN', { n: r.grantAmount }) : t('game.actShort.grant')),
    cost: (r) => r.costGrant,
  },
  { kind: 'upgrade', key: '4', icon: 'range', label: (r) => t('game.act.upgrade', { n: r.upgradeAmount }), short: (r) => t('game.actShort.upgrade', { n: r.upgradeAmount }), cost: (r) => r.costUpgrade },
  { kind: 'charge', key: '5', icon: 'bolt', label: () => t('blitz.act.charge'), short: () => t('blitz.actShort.charge'), cost: (r) => r.costCharge },
];

type DockTab = 'chat' | 'players' | 'log';
type Layout = 'wide' | 'mid' | 'phone';

/** ≥1200: three columns (roster · map · command). 901–1199: map + command with tabs. ≤900: phone flow. */
const WIDE = window.matchMedia('(min-width: 1200px)');
const PHONE = window.matchMedia('(max-width: 900px)');
const layoutNow = (): Layout => (WIDE.matches ? 'wide' : PHONE.matches ? 'phone' : 'mid');

const KEY_TO_ACTION: Record<string, ActionKind> = {
  Digit1: 'move',
  Digit2: 'attack',
  Digit3: 'grant',
  Digit4: 'upgrade',
  Numpad1: 'move',
  Numpad2: 'attack',
  Numpad3: 'grant',
  Numpad4: 'upgrade',
  Digit5: 'charge',
  Numpad5: 'charge',
};

const PHASE_LABEL: Record<string, Key> = { running: 'game.phase.running', paused: 'game.phase.paused', finished: 'game.phase.finished', lobby: 'game.phase.lobby' };

const isTouch = (): boolean => window.matchMedia('(hover: none)').matches;

/** A translated line with {k1}…{k4} replaced by <kbd>1</kbd>…<kbd>4</kbd>. */
function withKbds(text: string): Array<Node | string> {
  return text.split(/(\{k[1-4]\})/).map((part) => {
    const m = /^\{k([1-4])\}$/.exec(part);
    return m ? h('kbd', null, m[1]) : part;
  });
}

export class GameView {
  readonly el: HTMLElement;
  private readonly ctx: RoomCtx;
  private readonly map = new HexMap();
  private readonly menu = new ActionMenu();
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
  private readonly timerLabel = h('span', { class: 'timer-label' }, t('game.nextApIn'));
  private readonly resultsBtn = h('button', { class: 'btn small secondary hidden' }, icon('crown'), T('game.results'));
  private readonly bannerEl = h('div', { class: 'banner hidden' });
  /** Peace talks: the open proposal with its signatures, or a quiet "Propose peace". */
  private readonly peaceEl = h('section', { class: 'peace-card card hidden', 'aria-label': L('game.peaceLabel'), 'aria-live': 'polite' });
  private peaceKey = '';
  private ratingsKey = '';
  private readonly meFlag = h('div', { class: 'me-flag seal big' });
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
  private readonly roster = h('aside', { class: 'roster', 'aria-label': L('game.rosterLabel') });
  private readonly dock = h('div', { class: 'dock', 'data-tab': 'chat' });
  private readonly dockPanels = h('div', { class: 'dock-panels' });
  private readonly dockTabs = new Map<DockTab, HTMLButtonElement>();
  private readonly playersCard: HTMLElement;
  private readonly logCard: HTMLElement;
  private readonly playersCount = h('span', { class: 'count-pill' });
  private readonly playersTabCount = h('span', { class: 'dock-count' });
  private dockTab: DockTab = 'chat';
  private layout: Layout | null = null;
  private readonly onLayout = (): void => this.applyLayout();
  private readonly offLang: () => void;
  /** Blitz rooms: planner, ghost orders, turn replay and summary (client/src/blitz.ts). */
  private readonly blitz: BlitzPanel;
  private readonly modeEl = h('span', { class: 'badge blitz-badge hidden' });
  private readonly kbdHintEl = h('p', { class: 'hint kbd-hint' }, T('game.kbdHint'));

  constructor(ctx: RoomCtx) {
    this.ctx = ctx;
    this.map.onHover = () => this.renderInfo();
    this.map.onSelect = () => this.renderInfo();
    this.map.onMenu = (g) => this.openMenu(g);
    this.map.onActivate = (g) => this.quickMove(g);
    this.blitz = new BlitzPanel({
      map: this.map,
      send: (orders, confirm, turn) => this.ctx.send({ type: 'orders', orders, confirm, turn }),
      serverNow: () => this.ctx.serverNow(),
      redraw: () => {
        if (this.state) this.renderAll();
      },
      pulse: (stat) => this.pulse(stat === 'hp' ? this.hpEl : stat === 'ap' ? this.apEl : this.rangeEl, stat === 'hp' ? 'pulse-bad' : 'pulse-good'),
      hitFlash: () => this.pulse(this.el, 'hit-flash'),
    });

    const actionsEl = h('div', { class: 'actions' });
    for (const a of ACTIONS) {
      const btn = h(
        'button',
        { class: `action action-${a.kind}`, type: 'button', 'aria-keyshortcuts': a.key },
        h('span', { class: 'action-icon' }, icon(a.icon)),
        h('span', { class: 'action-label' }, h('span', { class: 'lbl-full' }), h('span', { class: 'lbl-short', 'aria-hidden': 'true' })),
        h('span', { class: 'action-cost' }),
        h('kbd', { class: 'kbd' }, a.key),
      );
      // pointerdown would be faster, but click keeps scrolling on phones from firing actions.
      btn.addEventListener('click', () => this.doAction(a.kind));
      this.actionBtns.set(a.kind, btn);
      actionsEl.appendChild(btn);
    }
    this.resultsBtn.addEventListener('click', () => this.showWinner());

    this.playersCard = h(
      'section',
      { class: 'players-card card', id: 'dock-players', role: 'tabpanel' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, T('game.players')), this.playersCount),
      this.playersEl,
    );
    this.logCard = h('section', { class: 'log-card card', id: 'dock-log', role: 'tabpanel' }, h('h2', { class: 'card-title' }, T('game.yourLog')), this.logEl);
    ctx.chat.el.id = 'dock-chat';
    ctx.chat.el.setAttribute('role', 'tabpanel');
    ctx.chat.onIncoming = () => {
      if (this.layout !== 'wide' && this.dockTab !== 'chat') this.dockTabs.get('chat')?.classList.add('unread');
    };

    const tabsEl = h('div', { class: 'dock-tabs', role: 'tablist', 'aria-label': L('game.sidePanel') });
    const tabDefs: Array<[DockTab, string, Key]> = [
      ['chat', 'chat', 'game.tab.chat'],
      ['players', 'users', 'game.tab.players'],
      ['log', 'log', 'game.tab.log'],
    ];
    for (const [tab, ic, label] of tabDefs) {
      const b = h(
        'button',
        { class: 'dock-tab', type: 'button', role: 'tab', 'aria-controls': `dock-${tab}` },
        icon(ic),
        h('span', null, T(label)),
        tab === 'players' ? this.playersTabCount : null,
        tab === 'chat' ? h('span', { class: 'dock-dot', 'aria-hidden': 'true' }) : null,
      );
      b.addEventListener('click', () => this.setDockTab(tab));
      b.addEventListener('keydown', (ev) => {
        const d = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        ev.preventDefault();
        const i = tabDefs.findIndex(([t]) => t === tab);
        const next = tabDefs[(i + d + tabDefs.length) % tabDefs.length][0];
        this.setDockTab(next);
        this.dockTabs.get(next)?.focus();
      });
      this.dockTabs.set(tab, b);
      tabsEl.appendChild(b);
    }
    this.dock.append(tabsEl, this.dockPanels);

    this.el = h(
      'div',
      { class: 'game' },
      h(
        'header',
        { class: 'topbar game-top' },
        h('button', { class: 'btn ghost small back-btn', title: L('app.backToRooms'), 'aria-label': L('app.backToRooms'), onclick: () => navigate('/') }, icon('back'), h('span', { class: 'hide-sm' }, T('game.rooms'))),
        h('div', { class: 'room-title' }, this.titleEl, this.modeEl, this.phaseEl),
        h('div', { class: 'spacer' }),
        this.resultsBtn,
        h('div', { class: 'ap-timer' }, icon('clock'), this.timerLabel, this.timerEl),
        notifyBell('game-bell'),
        langSwitch('game-lang'),
        userMenu(ctx.user, true),
      ),
      h(
        'div',
        { class: 'game-body' },
        this.roster,
        h('div', { class: 'map-col' }, h('div', { class: 'map-wrap' }, this.map.el, this.blitz.stageEl), this.infoEl),
        h(
          'aside',
          { class: 'side' },
          this.bannerEl,
          this.peaceEl,
          this.blitz.summaryEl,
          h(
            'section',
            { class: 'me-card card framed' },
            h('div', { class: 'me-head' }, this.meFlag, h('div', { class: 'me-id' }, h('span', { class: 'eyebrow' }, T('game.yourCountry')), this.meName)),
            h(
              'div',
              { class: 'stats' },
              h('div', { class: 'stat stat-hp' }, h('div', { class: 'stat-label' }, T('game.stat.hp')), this.hpEl),
              h('div', { class: 'stat stat-ap' }, h('div', { class: 'stat-label' }, T('game.stat.ap')), this.apEl),
              h('div', { class: 'stat stat-range' }, h('div', { class: 'stat-label' }, T('game.stat.range')), this.rangeEl),
            ),
          ),
          h('section', { class: 'actions-card card' }, this.blitz.el, actionsEl, this.kbdHintEl),
          this.dock,
        ),
      ),
      this.overlay,
    );
    this.applyLayout();
    this.setDockTab('chat');
    WIDE.addEventListener('change', this.onLayout);
    PHONE.addEventListener('change', this.onLayout);

    window.addEventListener('keydown', this.onKey);
    this.timer = window.setInterval(() => this.renderTimer(), 250);
    this.offLang = onLang(() => this.relocalize());
  }

  /** Language switch: re-render every text from the current state; the board, chat input,
   *  selection, dock tab and open panels stay as they are. */
  private relocalize(): void {
    if (!this.state) return;
    this.peaceKey = '';
    this.renderAll();
    if (this.state.phase === 'finished' && !this.overlay.classList.contains('hidden')) this.showWinner();
  }

  destroy(): void {
    WIDE.removeEventListener('change', this.onLayout);
    PHONE.removeEventListener('change', this.onLayout);
    window.removeEventListener('keydown', this.onKey);
    clearInterval(this.timer);
    this.offLang();
    this.blitz.destroy();
    this.menu.close();
    this.map.destroy();
  }

  update(state: RoomView, log: LogEntry[], fresh: LogEntry[], result?: ActionResult): void {
    const prevPos = new Map(this.lastPos);
    this.state = state;
    this.log = log;
    this.map.setRadius(state.rules.gridRadius);
    // blitz first: a new turn starts its replay, which decides what the board shows
    this.blitz.update(state);
    this.renderAll();
    if (result) this.handleResult(result);
    for (const e of fresh) this.animate(e, prevPos);
    this.lastPos.clear();
    for (const p of state.players) if (p.alive && p.q !== null && p.r !== null) this.lastPos.set(p.pid, { q: p.q, r: p.r });
    if (state.phase === 'finished' && !this.winnerShown) {
      this.winnerShown = true;
      // blitz: let the last turn play out on the board first
      const wait = this.blitz.replayLeft();
      if (wait > 0) window.setTimeout(() => this.showWinner(), wait + 300);
      else this.showWinner();
    } else if (state.phase === 'finished' && !this.overlay.classList.contains('hidden')) {
      // Late data for the open end screen (e.g. rating changes): redraw it.
      const key = JSON.stringify(state.ratings);
      if (key !== this.ratingsKey) this.showWinner();
    }
    this.ratingsKey = JSON.stringify(state.ratings);
  }

  /** Called for results that arrive without a state change (failed actions). */
  result(result: ActionResult): void {
    this.handleResult(result);
  }

  // ---------------------------------------------------------------- layout

  /** Moves the players and log cards between the left roster (wide) and the tabbed dock. */
  private applyLayout(): void {
    const layout = layoutNow();
    if (layout === this.layout) return;
    this.layout = layout;
    this.el.dataset.layout = layout;
    if (layout === 'wide') {
      this.roster.append(this.playersCard, this.logCard);
      this.dockPanels.append(this.ctx.chat.el);
    } else {
      this.dockPanels.append(this.ctx.chat.el, this.playersCard, this.logCard);
    }
    this.setDockTab(this.dockTab);
  }

  private setDockTab(tab: DockTab): void {
    this.dockTab = tab;
    this.dock.dataset.tab = tab;
    for (const [t, b] of this.dockTabs) {
      b.classList.toggle('active', t === tab);
      b.setAttribute('aria-selected', String(t === tab));
      b.tabIndex = t === tab ? 0 : -1;
      if (t === tab && t === 'chat') b.classList.remove('unread');
    }
  }

  // ---------------------------------------------------------------- helpers

  private player(pid: number | undefined): PublicPlayer | undefined {
    return pid === undefined ? undefined : this.state.players.find((p) => p.pid === pid);
  }

  private readonly name = (pid: number | undefined): string => this.player(pid)?.nickname ?? t('common.someone');

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

  /** A point beyond the map's edge in a random direction (secret attacks come from there). */
  private offBoard(): Hex {
    const ring = hexRing(this.state.rules.gridRadius + 3);
    return ring[Math.floor(Math.random() * ring.length)];
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
    if (ev.key === 'Enter' && this.isBlitz() && target?.tagName !== 'BUTTON' && target?.tagName !== 'A' && target?.tagName !== 'SELECT') {
      ev.preventDefault();
      this.blitz.confirmKey();
      return;
    }
    const kind = KEY_TO_ACTION[ev.code];
    if (!kind) return;
    if (kind === 'charge' && !this.isBlitz()) return;
    ev.preventDefault();
    this.doAction(kind);
  }

  private isBlitz(): boolean {
    return !!this.state?.blitz;
  }

  /** `at` = an explicit target (board menu, double-click); otherwise hovered ?? selected. */
  private doAction(kind: ActionKind, at?: Hex): void {
    const st = this.state;
    if (!st) return;
    if (st.blitz) {
      // blitz: every action becomes a queued order for this turn
      const cell = kind === 'upgrade' || kind === 'charge' ? null : (at ?? this.map.hovered ?? this.map.selected);
      this.blitz.queue(kind, cell);
      return;
    }
    if (kind === 'charge') return;
    if (st.phase !== 'running') {
      toast(t(st.phase === 'paused' ? 'err.paused' : 'err.gameOver'), 'error');
      return;
    }
    const me = st.me;
    if (!me || !me.alive) {
      toast(t('game.toast.eliminated'), 'error');
      return;
    }
    const cell = kind === 'upgrade' ? null : (at ?? this.map.hovered ?? this.map.selected);
    if (kind !== 'upgrade' && !cell) {
      toast(t(isTouch() ? 'game.toast.tapCell' : 'game.toast.pointCell'), 'error');
      return;
    }
    let action: GameAction;
    if (kind === 'move') {
      action = { type: 'move', q: cell!.q, r: cell!.r };
    } else if (kind === 'attack' || kind === 'grant') {
      const target = this.playerAt(cell!);
      if (!target) {
        this.map.flashCell(cell!);
        toast(t('game.toast.noPlayer'), 'error');
        return;
      }
      if (target.pid === me.pid) {
        toast(t('game.toast.thatsYou'), 'error');
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
    toast(result.error ? errorText(result.error, result) : t('game.toast.actionFailed'), 'error');
    if (req?.cell) this.map.flashCell(req.cell);
  }

  // ---------------------------------------------------------------- prices & action menu (rules)

  /** What `kind` costs you right now (prices can rise with each use until the next AP). */
  private price(kind: ActionKind): number {
    const st = this.state;
    if (st.blitz) return blitzNextCost(st.rules, st.blitz.myOrders ?? [], kind);
    if (kind === 'charge') return st.rules.costCharge;
    return actionCost(st.rules, kind, st.me?.used?.[kind] ?? 0);
  }

  /** The price after the next use, when it rises; null for fixed prices. */
  private nextPrice(kind: ActionKind): number | null {
    const st = this.state;
    if (kind === 'charge' || st.blitz || !escalates(st.rules, kind)) return null;
    const next = nextActionCost(st.rules, kind, st.me?.used?.[kind] ?? 0);
    return next === this.price(kind) ? null : next;
  }

  /**
   * Every action for `cell` with its current label, price and whether it can be done now
   * (mirrors the server's checks; the server still decides). Stable API for the board's
   * right-click / long-press menu. `cell` null = no cell picked (only Range +N can work).
   */
  getActionMenu(cell: Hex | null): ActionMenuItem[] {
    const st = this.state;
    if (!st) return [];
    if (st.blitz) return this.blitz.menuItems(cell);
    const me = st.me;
    const myPos = this.posOf(me?.pid);
    const dist = myPos && cell ? hexDistance(myPos, cell) : null;
    const occupant = cell ? this.playerAt(cell) : undefined;
    const isMe = !!occupant && occupant.pid === me?.pid;
    const blocked =
      st.phase === 'paused' ? t('err.paused') : st.phase !== 'running' ? t('err.gameOver') : !me?.alive ? t('game.reason.out') : null;
    return ACTIONS.filter((a) => a.kind !== 'charge').map((a): ActionMenuItem => {
      const cost = this.price(a.kind);
      let reason: string | null = blocked;
      if (!reason && a.kind === 'move') {
        if (!cell) reason = t('game.reason.pickCell');
        else if (!inGrid(cell, st.rules.gridRadius)) reason = t('err.offMap');
        else if (isMe) reason = t('game.toast.thatsYou');
        else if (occupant) reason = t('err.cellOccupied');
        else if (dist !== 1) reason = t('game.reason.tooFar');
      } else if (!reason && (a.kind === 'attack' || a.kind === 'grant')) {
        if (!cell || !occupant) reason = t(cell ? 'game.reason.emptyCell' : 'game.reason.pickPlayer');
        else if (isMe) reason = t('game.toast.thatsYou');
        else if (dist !== null && me && dist > me.range) reason = t('err.outOfRange', { range: me.range });
      }
      if (!reason && me && me.ap < cost) reason = t('err.notEnoughAp', { cost, have: me.ap });
      return { kind: a.kind, label: a.label(st.rules), cost, enabled: !reason, ...(reason ? { reason } : {}) };
    });
  }

  // ---------------------------------------------------------------- board menu & quick move

  /** The rows of the board's action menu for `cell` (the rules side's getActionMenu: live prices + reasons). */
  private actionMenu(cell: Hex): ActionMenuItem[] {
    return this.getActionMenu(cell);
  }

  private menuTitle(cell: Hex): Array<Node | string> {
    const st = this.state;
    const myPos = this.posOf(st.me?.pid);
    const dist = myPos ? hexDistance(myPos, cell) : null;
    const occupant = this.playerAt(cell);
    const parts: Array<Node | string> = occupant
      ? [h('span', { class: 'seal' }, flagImg(occupant.flag)), h('strong', null, occupant.nickname), occupant.pid === st.me?.pid ? h('span', { class: 'muted' }, t('game.youParen')) : null].filter((x): x is HTMLElement => !!x)
      : [icon('hex'), h('span', { class: 'muted' }, t('game.emptyCell'))];
    if (dist !== null && dist > 0) parts.push(h('span', { class: 'am-dist' }, t('game.cellsAway', { n: dist })));
    return parts;
  }

  /** Right-click / long-press on a cell: the action menu at the pointer. */
  private openMenu(g: CellGesture): void {
    if (!this.state) return;
    this.menu.open({
      x: g.x,
      y: g.y,
      touch: g.touch,
      cell: g.hex,
      title: this.menuTitle(g.hex),
      items: this.actionMenu(g.hex),
      onPick: (kind, cell) => this.doAction(kind, cell),
      onPreview: (kind, cell) => this.map.hint(kind, cell),
    });
  }

  /** Double-click / double-tap on a cell = move there when legal; otherwise say why. */
  private quickMove(g: CellGesture): void {
    if (!this.state) return;
    this.menu.close();
    if (this.state.blitz) {
      this.blitz.queue('move', g.hex);
      return;
    }
    const move = this.actionMenu(g.hex).find((x) => x.kind === 'move');
    if (move?.enabled) {
      this.map.hop(g.hex);
      this.doAction('move', g.hex);
      return;
    }
    this.map.deny(g.hex);
    toast(move?.reason ?? t('game.toast.cantMoveThere'), 'error');
  }

  // ---------------------------------------------------------------- animations

  private animate(e: LogEntry, prevPos: Map<number, Hex>): void {
    const myPid = this.state.me?.pid ?? null;
    // blitz: shots, gifts and falls are played by the turn replay (blitz.ts), not one by one
    if (this.state.blitz && ['attack', 'hit', 'grant', 'granted', 'upgrade', 'eliminate', 'tick', 'turn', 'miss', 'gift-lost', 'charge', 'start'].includes(e.type)) {
      if (e.type === 'start') toast(t('game.toast.start'), 'good', 3000);
      return;
    }
    const where = (pid: number | undefined | null): Hex | null =>
      pid === undefined || pid === null ? null : (this.posOf(pid) ?? prevPos.get(pid) ?? null);
    const myPos = where(myPid);
    switch (e.type) {
      case 'attack': {
        // Your own attack, or (public attacks) someone else's: the shot flies from the attacker.
        const from = e.actor !== undefined && e.actor !== myPid ? where(e.actor) : myPos;
        const to = where(e.target);
        if (from && to) this.map.shot(from, to, 'attack');
        if (to) this.map.float(to, `−${e.amount ?? 1}`, 'bad');
        break;
      }
      case 'hit': {
        // Public attacks: the shot comes from the attacker. Secret ones: from beyond the map's
        // edge in a random direction, so the effect never gives the attacker's position away.
        const from = e.actor !== undefined ? where(e.actor) : this.offBoard();
        if (from && myPos) this.map.shot(from, myPos, 'attack');
        if (myPid !== null) this.map.shake(myPid);
        if (myPos) this.map.float(myPos, t('game.float.hp', { n: e.amount ?? 1 }), 'bad');
        this.pulse(this.hpEl, 'pulse-bad');
        this.pulse(this.el, 'hit-flash');
        if (e.actor !== undefined) toast(personalText(e, this.name, myPid), 'error');
        break;
      }
      case 'grant': {
        const from = e.actor !== undefined && e.actor !== myPid ? where(e.actor) : myPos;
        const to = where(e.target);
        if (from && to) this.map.shot(from, to, 'grant');
        if (to) this.map.float(to, `+${e.amount ?? 1}`, 'good');
        break;
      }
      case 'granted': {
        const from = e.actor !== undefined ? where(e.actor) : null;
        if (from && myPos) this.map.shot(from, myPos, 'grant');
        if (myPos) this.map.float(myPos, t('game.float.ap', { n: e.amount ?? 1 }), 'good');
        this.pulse(this.apEl, 'pulse-good');
        toast(personalText(e, this.name, myPid).replace(/\.$/, ''), 'good');
        break;
      }
      case 'peace-propose':
      case 'peace-sign':
      case 'peace-decline':
      case 'peace-cancel':
        if (e.actor !== myPid) toast(personalText(e, this.name, myPid), e.type === 'peace-cancel' || e.type === 'peace-decline' ? 'error' : 'info', 4000);
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
      case 'tick': {
        if (myPos && this.state.me?.alive) this.map.float(myPos, t('game.float.ap', { n: e.amount ?? 1 }), 'good');
        this.pulse(this.apEl, 'pulse-good');
        const rising = ACTIONS.some((a) => a.kind !== 'charge' && escalates(this.state.rules, a.kind));
        toast(t(rising ? 'game.toast.tickRising' : 'game.toast.tick', { n: e.amount ?? 1 }), 'good');
        break;
      }
      case 'start':
        toast(t('game.toast.start'), 'good', 3000);
        break;
      case 'pause':
        toast(t('game.toast.pause'), 'info', 3000);
        break;
      case 'resume':
        toast(t('game.toast.resume'), 'good', 3000);
        break;
      case 'adjust':
        toast(t('game.toast.adjust'), 'info');
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
    const blitz = !!st.blitz;
    this.el.classList.toggle('is-blitz', blitz);
    this.modeEl.classList.toggle('hidden', !blitz);
    this.modeEl.textContent = t('blitz.badge');
    this.kbdHintEl.textContent = t(blitz ? 'blitz.kbdHint' : 'game.kbdHint');
    this.phaseEl.textContent = PHASE_LABEL[st.phase] ? t(PHASE_LABEL[st.phase]) : st.phase;
    this.phaseEl.className = `badge ${st.phase}`;
    this.resultsBtn.classList.toggle('hidden', st.phase !== 'finished');
    this.el.classList.toggle('dead', !!me && !me.alive);
    this.el.classList.toggle('inactive', !canAct);

    // Banner
    let banner: HTMLElement | null = null;
    if (st.phase === 'finished' && st.peace?.signed) {
      banner = h('div', { class: 'banner-row' }, icon('crown'), h('span', null, t('game.banner.peace')));
    } else if (st.phase === 'finished') {
      const w = this.player(st.winnerPid ?? undefined);
      banner = h('div', { class: 'banner-row' }, icon('crown'), h('span', null, w ? (w.pid === me?.pid ? t('game.banner.youWon') : t('game.banner.won', { name: w.nickname })) : t('game.banner.over')));
    } else if (me && !me.alive) {
      const by = mePub?.eliminatedBy ?? null;
      banner = h('div', { class: 'banner-row' }, icon('alert'), h('span', null, by !== null ? t('game.banner.elimBy', { name: this.name(by) }) : t('game.banner.elim')));
    } else if (st.phase === 'paused') {
      banner = h('div', { class: 'banner-row' }, icon('pause'), h('span', null, t('game.banner.paused')));
    }
    this.bannerEl.classList.toggle('hidden', !banner);
    this.bannerEl.dataset.kind = st.phase === 'finished' ? 'finished' : me && !me.alive ? 'dead' : 'paused';
    if (banner) replaceChildren(this.bannerEl, banner);

    this.renderPeace();

    // Me
    if (mePub) {
      replaceChildren(this.meFlag, flagImg(mePub.flag, 'flag big'));
      this.meName.textContent = mePub.nickname;
    }
    if (me) {
      const hp = me.hp;
      replaceChildren(
        this.hpEl,
        hp <= 0
          ? h('span', { class: 'hp-num' }, '0')
          : hp <= 6
            ? h('span', { class: 'hearts', 'aria-label': t('unit.hp', { n: hp }) }, Array.from({ length: hp }, () => icon('heart', 'heart')))
            : h('span', { class: 'hp-num' }, icon('heart', 'heart'), String(hp)),
      );
      this.apEl.textContent = String(me.ap);
      this.rangeEl.textContent = String(me.range);
    }

    // Actions
    for (const a of ACTIONS) {
      const btn = this.actionBtns.get(a.kind)!;
      btn.hidden = a.kind === 'charge' && (!blitz || st.rules.blitzChargeCap <= 0);
      const cost = this.price(a.kind);
      const next = this.nextPrice(a.kind);
      (btn.querySelector('.lbl-full') as HTMLElement).textContent = a.label(st.rules);
      (btn.querySelector('.lbl-short') as HTMLElement).textContent = a.short(st.rules);
      btn.setAttribute('aria-label', next !== null ? t('game.actionTitle', { label: a.label(st.rules), cost, next }) : `${a.label(st.rules)}, ${t('unit.ap', { n: cost })}`);
      replaceChildren(
        btn.querySelector('.action-cost') as HTMLElement,
        h('span', { class: 'cost-now' }, t('unit.ap', { n: cost })),
        next !== null
          ? h('span', { class: 'action-next', title: t('game.nextTitle') }, h('span', { class: 'lbl-full' }, t('game.next', { n: next })), h('span', { class: 'lbl-short' }, t('game.nextShort', { n: next })))
          : null,
      );
      btn.title = next !== null ? t('game.actionTitle', { label: a.label(st.rules), cost, next }) : '';
      btn.disabled = !canAct;
      btn.classList.toggle('poor', !!me && me.ap < cost);
    }

    // Players
    const alive = st.players.filter((p) => p.alive).length;
    this.playersCount.textContent = t('game.aliveCount', { alive, total: st.players.length });
    this.playersTabCount.textContent = String(alive);
    const sorted = [...st.players].sort((a, b) => Number(b.alive) - Number(a.alive) || a.nickname.localeCompare(b.nickname));
    replaceChildren(
      this.playersEl,
      sorted.map((p) => {
        const pos = this.posOf(p.pid);
        const dist = myPos && pos ? hexDistance(myPos, pos) : null;
        const inRange = dist !== null && me ? dist <= me.range && p.pid !== me.pid : false;
        let detail: string;
        if (!p.alive) detail = p.eliminatedBy !== null ? t('game.detail.outBy', { name: this.name(p.eliminatedBy) }) : t('game.detail.out');
        else if (p.pid === me?.pid) detail = t('game.detail.you');
        else detail = dist !== null ? t('game.detail.away', { n: dist }) : '';
        return h(
          'li',
          { class: `player ${p.alive ? '' : 'out'} ${p.pid === me?.pid ? 'is-me' : ''} ${inRange ? 'in-range' : ''}` },
          playerSeal(p, this.ctx.user),
          playerNameButton(p, this.ctx.user),
          inRange ? h('span', { class: 'tag range', title: t('game.inRangeTitle') }, t('game.inRange')) : null,
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
        : h('li', { class: 'empty' }, t('game.logEmpty')),
    );

    this.map.render({
      players: blitz ? this.blitz.mapPlayers(st) : st.players,
      myPid: me?.pid ?? null,
      myPos,
      range: blitz ? this.blitz.mapRange(st) : (me?.range ?? 0),
      showRange: canAct,
      myHp: me?.hp ?? null,
      charges: blitz ? this.blitz.mapCharges() : null,
    });
    if (blitz) {
      this.map.setOrders(this.blitz.marks());
      this.blitz.render();
    }
    this.renderInfo();
    this.renderTimer();
    const mc = this.menu.cell;
    if (mc) {
      if (canAct) this.menu.update(this.menuTitle(mc), this.actionMenu(mc));
      else this.menu.close();
    }
  }

  // ---------------------------------------------------------------- peace

  private renderPeace(): void {
    const st = this.state;
    const me = st.me;
    const live = st.phase === 'running' || st.phase === 'paused';
    const open = live && st.peace && !st.peace.signed ? st.peace : null;
    const canPropose = st.phase === 'running' && !!me?.alive;
    const key = JSON.stringify([st.phase, open, me?.alive, st.players.map((p) => p.alive)]);
    if (key === this.peaceKey) return;
    this.peaceKey = key;
    if (!open && !canPropose) {
      this.peaceEl.classList.add('hidden');
      return;
    }
    this.peaceEl.classList.remove('hidden');
    this.peaceEl.classList.toggle('open', !!open);
    const send = (op: 'propose' | 'sign' | 'decline') => this.ctx.send({ type: 'peace', op });
    if (!open) {
      const propose = h('button', { class: 'btn ghost small peace-propose', type: 'button' }, icon('flag'), t('game.peace.propose'));
      propose.addEventListener('click', () => send('propose'));
      replaceChildren(
        this.peaceEl,
        h('div', { class: 'peace-idle' }, h('span', { class: 'muted small' }, t('game.peace.idle')), propose),
      );
      return;
    }
    const alive = st.players.filter((p) => p.alive);
    const signed = new Set(open.signers);
    const iSigned = !!me && signed.has(me.pid);
    const seals = alive.map((p) =>
      h(
        'span',
        { class: `peace-seal${signed.has(p.pid) ? ' signed' : ''}`, title: t(signed.has(p.pid) ? 'game.peace.sealSigned' : 'game.peace.sealNot', { name: p.nickname }) },
        h('span', { class: 'seal' }, flagImg(p.flag)),
        signed.has(p.pid) ? icon('check', 'peace-tick') : null,
      ),
    );
    const buttons: HTMLElement[] = [];
    if (me?.alive && st.phase === 'running') {
      if (!iSigned) {
        const sign = h('button', { class: 'btn primary small', type: 'button' }, t('game.peace.sign'));
        sign.addEventListener('click', () => send('sign'));
        buttons.push(sign);
      }
      const decline = h('button', { class: 'btn secondary small', type: 'button' }, t(iSigned ? 'game.peace.withdraw' : 'game.peace.decline'));
      decline.addEventListener('click', () => send('decline'));
      buttons.push(decline);
    }
    const proposer = open.proposer === me?.pid ? t('game.peace.youProposed') : t('game.peace.proposed', { name: this.name(open.proposer) });
    replaceChildren(
      this.peaceEl,
      h('div', { class: 'peace-head' }, h('span', { class: 'eyebrow' }, t('game.peace.talks')), h('strong', { class: 'peace-title' }, proposer)),
      h('div', { class: 'peace-seals', role: 'list', 'aria-label': t('game.peace.signatures') }, seals),
      h(
        'p',
        { class: 'peace-note muted small' },
        h('span', null, t('game.peace.count', { signed: signed.size, total: alive.length })),
        ' ',
        h('span', { class: 'peace-more' }, t('game.peace.more')),
      ),
      buttons.length ? h('div', { class: 'peace-actions' }, buttons) : null,
    );
  }

  private renderTimer(): void {
    const st = this.state;
    if (!st) return;
    if (st.blitz) {
      const [label, value] = this.blitz.tick();
      this.timerLabel.textContent = label;
      this.timerEl.textContent = value;
      return;
    }
    if (st.phase === 'running' && st.nextTickAt !== null) {
      this.timerLabel.textContent = t('game.nextApIn');
      this.timerEl.textContent = countdown(st.nextTickAt - this.ctx.serverNow());
    } else if (st.phase === 'paused') {
      this.timerLabel.textContent = t('game.apTimer');
      this.timerEl.textContent = t('game.timerPaused');
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
      // Touch: one compact line (the full sentence stays as the accessible name / tooltip).
      replaceChildren(
        this.infoEl,
        icon('hex', 'info-hex'),
        isTouch()
          ? h('span', { class: 'muted info-tip', title: t('game.info.touch'), 'aria-label': t('game.info.touch') }, t('game.info.touchShort'))
          : h('span', { class: 'muted' }, withKbds(t(st.blitz ? 'blitz.info.keys' : 'game.info.keys'))),
      );
      return;
    }
    const dist = myPos ? hexDistance(myPos, cell) : null;
    const occupant = this.playerAt(cell);
    const parts: Array<Node | string> = [];
    if (occupant) {
      parts.push(h('span', { class: 'seal' }, flagImg(occupant.flag)), h('strong', null, occupant.nickname));
      if (occupant.pid === st.me?.pid) parts.push(h('span', { class: 'muted' }, t('game.youParen')));
      else if (dist !== null && st.me) {
        parts.push(dist <= st.me.range ? h('span', { class: 'tag good' }, t('game.inRange')) : h('span', { class: 'tag' }, t('game.outOfRange')));
      }
    } else {
      parts.push(icon('hex', 'info-hex'), h('span', { class: 'muted' }, t('game.emptyCell')));
      if (dist === 1 && this.canAct()) parts.push(h('span', { class: 'tag good' }, t('game.canMoveHere')));
    }
    if (dist !== null && dist > 0) parts.push(h('span', { class: 'cell-dist' }, t('game.cellsAway', { n: dist })));
    replaceChildren(this.infoEl, ...parts);
  }

  // ---------------------------------------------------------------- winner screen

  private showWinner(): void {
    const st = this.state;
    if (st.phase !== 'finished') return;
    if (this.overlay.classList.contains('hidden')) {
      // The end screen comes first: no sticker sheet, menu or toast stays on top of it.
      closeTransient();
      clearToasts();
    }
    const winner = this.player(st.winnerPid ?? undefined);
    const reveal = st.reveal;
    const peace = st.peace?.signed ? st.peace : null;
    const peaceSigners = peace ? peace.signers.map((pid) => this.player(pid)).filter((p): p is PublicPlayer => !!p) : [];
    const isFirst = (pid: number): boolean => pid === st.winnerPid || (!!peace && peace.signers.includes(pid));
    const ratingOf = new Map((st.ratings ?? []).map((r) => [r.pid, r]));
    const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');
    const myRating = st.me ? ratingOf.get(st.me.pid) : undefined;
    const close = h('button', { class: 'btn primary', onclick: () => this.overlay.classList.add('hidden') }, t('common.close'));
    const rows = reveal
      ? [...reveal.players]
          .sort((a, b) => {
            const pa = this.player(a.pid);
            const pb = this.player(b.pid);
            if (isFirst(a.pid) !== isFirst(b.pid)) return isFirst(a.pid) ? -1 : 1;
            return (pb?.eliminatedAt ?? 0) - (pa?.eliminatedAt ?? 0);
          })
          .map((r) => {
            const p = this.player(r.pid);
            const rc = ratingOf.get(r.pid);
            return h(
              'tr',
              { class: isFirst(r.pid) ? 'winner-row' : '' },
              h('td', { class: 'who' }, h('span', { class: 'who-inner' }, p ? flagImg(p.flag) : null, p?.nickname ?? '?')),
              h('td', null, String(r.hp)),
              h('td', null, String(r.ap)),
              h('td', null, String(r.range)),
              h('td', null, String(r.kills)),
              h('td', null, String(r.damageDealt)),
              h('td', null, String(r.damageTaken)),
              h('td', null, String(r.apGiven)),
              h('td', null, String(r.apReceived)),
              h('td', null, String(r.upgrades)),
              h('td', { class: 'muted' }, p && !p.alive ? (p.eliminatedBy !== null ? t('game.win.by', { name: this.name(p.eliminatedBy) }) : t('game.win.admin')) : '—'),
              ratingOf.size
                ? h(
                    'td',
                    { class: 'rating-cell' },
                    rc ? [String(rc.after), ' ', h('span', { class: `rating-delta ${rc.delta > 0 ? 'up' : rc.delta < 0 ? 'down' : ''}` }, signed(rc.delta))] : '—',
                  )
                : null,
            );
          })
      : [];
    const history = reveal ? reveal.history.filter((e) => e.type !== 'tick') : [];

    replaceChildren(
      this.overlay,
      h(
        'div',
        { class: 'card winner-card', role: 'dialog', 'aria-modal': 'true' },
        h('p', { class: 'eyebrow center' }, st.name),
        winner ? h('div', { class: 'winner-seal' }, h('span', { class: 'winner-hex' }, flagImg(winner.flag, 'flag big', '1x1')), icon('crown', 'winner-crown')) : null,
        peace
          ? h(
              'div',
              { class: 'peace-seals winner-peace' },
              peaceSigners.map((p) => h('span', { class: 'peace-seal signed', title: p.nickname }, h('span', { class: 'seal' }, flagImg(p.flag)))),
            )
          : null,
        peace
          ? h('h2', { class: 'winner-title display' }, t('game.win.peaceTitle'))
          : winner
            ? h('h2', { class: 'winner-title display' }, winner.pid === st.me?.pid ? t('game.win.youWon') : t('game.win.wins', { name: winner.nickname }))
            : h('h2', { class: 'winner-title display' }, t('game.win.over')),
        peace
          ? h('p', { class: 'winner-sub' }, t('game.win.signedBy', { names: fmtList(peaceSigners.map((p) => p.nickname)) }))
          : winner
            ? h('p', { class: 'winner-sub' }, t('game.win.lastStanding'))
            : null,
        myRating
          ? h(
              'p',
              { class: 'winner-rating' },
              h('span', { class: 'eyebrow' }, t('game.win.yourRating')),
              h('strong', { class: 'display' }, String(myRating.after)),
              h('span', { class: `rating-delta ${myRating.delta > 0 ? 'up' : myRating.delta < 0 ? 'down' : ''}` }, signed(myRating.delta)),
              h('a', { class: 'linkish', href: '/leaderboard', onclick: (ev: Event) => { ev.preventDefault(); navigate('/leaderboard'); } }, t('game.win.leaderboard')),
            )
          : !st.rated
            ? h('p', { class: 'winner-rating muted small' }, t('game.win.testGame'))
            : null,
        reveal
          ? [
              h('h3', { class: 'section-title' }, t('game.win.finalStats')),
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
                      [
                        ...(['game.col.player', 'game.col.hp', 'game.col.ap', 'game.col.range', 'game.col.kills', 'game.col.dealt', 'game.col.taken', 'game.col.given', 'game.col.got', 'game.col.upgrades', 'game.col.out'] as Key[]),
                        ...(ratingOf.size ? (['game.col.rating'] as Key[]) : []),
                      ].map((k) => h('th', null, t(k))),
                    ),
                  ),
                  h('tbody', null, rows),
                ),
              ),
              h('h3', { class: 'section-title' }, t('game.win.whatHappened')),
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
