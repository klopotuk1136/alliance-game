// Blitz mode in the browser: the order planner (queue, AP budget, confirm, who is still
// planning), the ghost orders on the board, the turn replay and the turn summary.
// game.ts owns the screen and hands blitz rooms over to this panel; the rules and prices
// are the server's own (shared/blitz.ts), so the planner refuses exactly what it would.

import {
  blitzChargeAfter,
  blitzNextCost,
  blitzRange,
  checkBlitzOrders,
  type BlitzOrder,
  type BlitzOrderKind,
  type BlitzTurnView,
  type BlitzView,
} from '../../shared/blitz.ts';
import { hexDistance, hexRing, type Hex } from '../../shared/hex.ts';
import type { PublicPlayer, RoomView } from '../../shared/protocol.ts';
import type { ActionMenuItem } from './board-menu.ts';
import { flagImg, h, replaceChildren, toast } from './dom.ts';
import { errorText } from './errors.ts';
import { countdown } from './format.ts';
import { fmtList, t, type Key } from './i18n.ts';
import type { HexMap, OrderMark } from './map.ts';
import { alert } from './notify.ts';
import { icon } from './ui.ts';

export interface BlitzHost {
  readonly map: HexMap;
  send(orders: BlitzOrder[], confirm: boolean, turn: number): void;
  serverNow(): number;
  /** Re-renders the game screen (the board shows what mapPlayers/mapCharges say). */
  redraw(): void;
  pulse(stat: 'hp' | 'ap' | 'range'): void;
  hitFlash(): void;
}

const KIND_ICON: Record<BlitzOrderKind, string> = { move: 'move', attack: 'attack', grant: 'grant', upgrade: 'range', charge: 'bolt' };
const MENU_LABEL: Record<BlitzOrderKind, Key> = {
  move: 'blitz.menu.move',
  attack: 'blitz.menu.attack',
  grant: 'blitz.menu.grant',
  upgrade: 'blitz.menu.upgrade',
  charge: 'blitz.menu.charge',
};

const sameHex = (a: Hex | null | undefined, b: Hex | null | undefined): boolean => !!a && !!b && a.q === b.q && a.r === b.r;
const hexOf = (p: [number, number]): Hex => ({ q: p[0], r: p[1] });

interface ReplayFrame {
  players: PublicPlayer[];
  charges: Record<number, number>;
}

export class BlitzPanel {
  /** The planner (lives in the actions card: a side panel on desktop, the bottom bar on phones). */
  readonly el = h('div', { class: 'blitz-panel', 'aria-label': t('blitz.plannerLabel') });
  /** The previous turn, explained. */
  readonly summaryEl = h('section', { class: 'card blitz-summary hidden', 'aria-live': 'polite' });
  /** A caption over the board while a turn replays ("Moves", "Shots"…). */
  readonly stageEl = h('div', { class: 'blitz-stage', 'aria-hidden': 'true' });

  private readonly host: BlitzHost;
  private st: RoomView | null = null;
  private view: BlitzView | null = null;
  private orders: BlitzOrder[] = [];
  private confirmed = false;
  private lastSent = 0;
  private sentKey = '';
  private replayedTurn = -1;
  /** The turn the summary card explains: only once its replay has played (no spoilers). */
  private summaryTurn = 0;
  private frame: ReplayFrame | null = null;
  private replayEnds = 0;
  private timers: number[] = [];
  private listOpen = false;
  /** Turns whose "your orders" / "10 s left" sound has played (never on the first look). */
  private soundedTurn = -1;
  private hurriedTurn = -1;

  private readonly turnEl = h('strong', { class: 'blitz-turn-n display' });
  private readonly clockLabel = h('span', { class: 'blitz-clock-label' });
  private readonly timeEl = h('strong', { class: 'blitz-time display', 'aria-live': 'off' });
  private readonly barEl = h('i', { class: 'blitz-bar-fill' });
  private readonly apEl = h('div', { class: 'blitz-ap' });
  private readonly listEl = h('ol', { class: 'blitz-orders' });
  private readonly toggleBtn = h('button', { class: 'blitz-toggle', type: 'button', 'aria-expanded': 'false' });
  private readonly confirmBtn = h('button', { class: 'btn primary blitz-confirm', type: 'button' });
  private readonly clearBtn = h('button', { class: 'btn ghost small blitz-clear', type: 'button' });
  private readonly waitEl = h('div', { class: 'blitz-wait' });

  constructor(host: BlitzHost) {
    this.host = host;
    this.toggleBtn.addEventListener('click', () => {
      this.listOpen = !this.listOpen;
      this.render();
    });
    this.confirmBtn.addEventListener('click', () => this.toggleConfirm());
    this.clearBtn.addEventListener('click', () => this.clear());
    replaceChildren(
      this.el,
      h(
        'div',
        { class: 'blitz-head' },
        h('div', { class: 'blitz-turn' }, h('span', { class: 'eyebrow' }, t('blitz.turn')), this.turnEl),
        h('div', { class: 'blitz-clock' }, this.clockLabel, this.timeEl),
      ),
      h('div', { class: 'blitz-bar', 'aria-hidden': 'true' }, this.barEl),
      h('div', { class: 'blitz-mid' }, this.apEl, this.toggleBtn),
      this.listEl,
      h('div', { class: 'blitz-foot' }, this.confirmBtn, this.clearBtn),
      this.waitEl,
    );
  }

  destroy(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers = [];
  }

  // ---------------------------------------------------------------- state

  /** Call with every new room state, BEFORE the screen re-renders. */
  update(st: RoomView): void {
    const prevTurn = this.view?.turn;
    this.st = st;
    const v = st.blitz ?? null;
    this.view = v;
    if (!v) return;
    const serverKey = JSON.stringify(v.myOrders ?? []);
    // keep a local edit that is still on its way; otherwise the server's queue wins
    if (v.turn !== prevTurn || serverKey === this.sentKey || Date.now() - this.lastSent > 1200) {
      this.orders = v.myOrders ? v.myOrders.map((o) => ({ ...o })) : [];
      this.confirmed = v.myConfirmed;
    }
    if (this.replayedTurn === -1) {
      // first look at this room (or a reconnect): no replay, the summary has a Replay button
      this.replayedTurn = v.last?.turn ?? 0;
      this.summaryTurn = this.replayedTurn;
    } else if (v.last && v.last.turn > this.replayedTurn) {
      this.replayedTurn = v.last.turn;
      this.replay(v.last);
    }
    this.render();
  }

  get active(): boolean {
    return !!this.view;
  }

  /** ms until the running replay ends (0 when none). */
  replayLeft(): number {
    return Math.max(0, this.replayEnds - Date.now());
  }

  private me(): { pid: number; pos: Hex; ap: number; range: number } | null {
    const st = this.st;
    const me = st?.me;
    if (!st || !me || !me.alive) return null;
    const p = st.players.find((x) => x.pid === me.pid);
    if (!p || p.q === null || p.r === null) return null;
    return { pid: me.pid, pos: { q: p.q, r: p.r }, ap: me.ap, range: me.range };
  }

  private canPlan(): boolean {
    return !!this.st && this.st.phase === 'running' && !!this.view?.myOrders && !!this.me();
  }

  private myCharge(): number {
    const me = this.st?.me;
    return me ? (this.view?.charges[me.pid] ?? 0) : 0;
  }

  // ---------------------------------------------------------------- what the board shows

  /** Players for the board: a replay frame while a turn plays back, else the real state. */
  mapPlayers(st: RoomView): PublicPlayer[] {
    return this.frame?.players ?? st.players;
  }

  mapCharges(): Record<number, number> | null {
    return this.frame?.charges ?? this.view?.charges ?? null;
  }

  /** Range shown on the board: queued range-ups already count. */
  mapRange(st: RoomView): number {
    return blitzRange(st.rules, st.me?.range ?? 0, this.orders);
  }

  /** Your queued orders as ghosts (none during a replay or when you can't plan). */
  marks(): OrderMark[] {
    const me = this.me();
    if (!me || this.frame || !this.canPlan() || !this.st) return [];
    const rules = this.st.rules;
    let charge = this.myCharge();
    const out: OrderMark[] = [];
    for (const o of this.orders) {
      if (o.type === 'move') out.push({ kind: 'move', from: me.pos, to: { q: o.q, r: o.r } });
      else if (o.type === 'attack') {
        out.push({ kind: 'attack', from: me.pos, to: { q: o.q, r: o.r }, label: `−${rules.attackDamage + charge}` });
        charge = 0;
      } else if (o.type === 'grant') out.push({ kind: 'grant', from: me.pos, to: { q: o.q, r: o.r }, label: `+${rules.grantAmount}` });
      else if (o.type === 'upgrade') out.push({ kind: 'upgrade', from: me.pos, to: me.pos, label: t('blitz.mark.range', { n: rules.upgradeAmount }) });
      else out.push({ kind: 'charge', from: me.pos, to: me.pos, label: 'ϟ+1' });
    }
    return out;
  }

  // ---------------------------------------------------------------- planning

  private candidate(kind: BlitzOrderKind, cell: Hex | null): BlitzOrder[] | null {
    let o: BlitzOrder;
    if (kind === 'upgrade' || kind === 'charge') o = { type: kind };
    else if (!cell) return null;
    else o = { type: kind, q: cell.q, r: cell.r };
    // a second move replaces the first: you re-aim your step
    if (kind === 'move') return [...this.orders.filter((x) => x.type !== 'move'), o];
    return [...this.orders, o];
  }

  private check(orders: BlitzOrder[]): ReturnType<typeof checkBlitzOrders> | null {
    const me = this.me();
    if (!me || !this.st) return null;
    return checkBlitzOrders(orders, { settings: this.st.rules, pos: me.pos, ap: me.ap, range: me.range, charge: this.myCharge() });
  }

  private blockedReason(): string | null {
    const st = this.st;
    if (!st) return null;
    if (st.phase === 'paused') return t('err.paused');
    if (st.phase !== 'running') return t('err.gameOver');
    if (!st.me?.alive) return t('game.reason.out');
    return null;
  }

  /** Board menu rows for `cell` in a blitz game (same shape as the classic menu). */
  menuItems(cell: Hex | null): ActionMenuItem[] {
    const st = this.st;
    if (!st) return [];
    const blocked = this.blockedReason();
    const kinds: BlitzOrderKind[] = ['move', 'attack', 'grant', 'upgrade', 'charge'];
    return kinds
      .filter((k) => k !== 'charge' || st.rules.blitzChargeCap > 0)
      .map((kind) => {
        const cost = blitzNextCost(st.rules, this.orders.filter((o) => kind !== 'move' || o.type !== 'move'), kind);
        let reason: string | null = blocked;
        if (!reason) {
          const cand = this.candidate(kind, cell);
          if (!cand) reason = t('game.reason.pickCell');
          else {
            const res = this.check(cand);
            if (res && !res.ok) reason = errorText(res.error);
          }
        }
        const label = kind === 'move' && this.orders.some((o) => o.type === 'move') ? t('blitz.menu.moveReplace') : t(MENU_LABEL[kind], { n: st.rules.attackDamage + this.myCharge() });
        return { kind, label, cost, enabled: !reason, ...(reason ? { reason } : {}) };
      });
  }

  /** Adds an order (keys, buttons, board menu, double-click). */
  queue(kind: BlitzOrderKind, cell: Hex | null): void {
    const blocked = this.blockedReason();
    if (blocked) {
      toast(blocked, 'error');
      return;
    }
    const cand = this.candidate(kind, cell);
    if (!cand) {
      toast(t(window.matchMedia('(hover: none)').matches ? 'game.toast.tapCell' : 'game.toast.pointCell'), 'error');
      return;
    }
    const res = this.check(cand);
    if (!res) return;
    if (!res.ok) {
      toast(errorText(res.error), 'error');
      if (cell) this.host.map.deny(cell);
      return;
    }
    if (kind === 'move' && cell) this.host.map.hop(cell);
    this.setOrders(res.orders, false);
  }

  private setOrders(orders: BlitzOrder[], confirm: boolean): void {
    this.orders = orders;
    this.confirmed = confirm;
    this.sentKey = JSON.stringify(orders);
    this.lastSent = Date.now();
    this.host.send(orders, confirm, this.view?.turn ?? 0);
    this.host.redraw();
  }

  private remove(i: number): void {
    if (!this.canPlan()) return;
    this.setOrders(this.orders.filter((_, k) => k !== i), false);
  }

  private clear(): void {
    if (!this.canPlan() || !this.orders.length) return;
    this.setOrders([], false);
  }

  private toggleConfirm(): void {
    if (!this.canPlan()) return;
    this.setOrders(this.orders, !this.confirmed);
  }

  /** Enter = confirm / edit (from game.ts's key handler). */
  confirmKey(): void {
    this.toggleConfirm();
  }

  // ---------------------------------------------------------------- rendering

  private orderText(o: BlitzOrder, damage: number): string {
    const st = this.st!;
    const me = this.me();
    if (o.type === 'upgrade') return t('blitz.order.upgrade', { n: st.rules.upgradeAmount });
    if (o.type === 'charge') return t('blitz.order.charge');
    const cell = { q: o.q, r: o.r };
    const who = st.players.find((p) => p.alive && sameHex({ q: p.q ?? NaN, r: p.r ?? NaN }, cell) && p.pid !== st.me?.pid);
    const d = me ? hexDistance(me.pos, cell) : 0;
    if (o.type === 'move') return who ? t('blitz.order.moveInto', { name: who.nickname }) : t('blitz.order.move');
    if (o.type === 'attack') return who ? t('blitz.order.attackAt', { name: who.nickname, n: damage }) : t('blitz.order.attackCell', { d, n: damage });
    return who ? t('blitz.order.grantAt', { name: who.nickname, n: st.rules.grantAmount }) : t('blitz.order.grantCell', { d, n: st.rules.grantAmount });
  }

  render(): void {
    const st = this.st;
    const v = this.view;
    if (!st || !v) return;
    const me = this.me();
    const can = this.canPlan();
    this.el.classList.toggle('can-plan', can);
    this.el.classList.toggle('confirmed', this.confirmed && can);
    this.el.classList.toggle('open', this.listOpen);
    this.turnEl.textContent = String(v.turn);

    const res = me ? this.check(this.orders) : null;
    const spent = res && res.ok ? res.total : 0;
    const left = me ? me.ap - spent : 0;
    const charge = this.myCharge();
    const after = blitzChargeAfter(charge, this.orders);
    replaceChildren(
      this.apEl,
      me
        ? [
            h('span', { class: 'blitz-ap-left' }, h('span', { class: 'eyebrow' }, t('blitz.apLeft')), h('strong', { class: 'display' }, String(left)), h('span', { class: 'muted' }, t('blitz.apOf', { n: me.ap }))),
            st.rules.blitzChargeCap > 0
              ? h(
                  'span',
                  { class: `blitz-charge-now${charge ? ' on' : ''}`, title: t('blitz.chargeTitle', { cap: st.rules.blitzChargeCap }) },
                  icon('bolt'),
                  after !== charge ? t('blitz.chargeAfter', { a: charge, b: after }) : t('blitz.chargeNow', { n: charge }),
                )
              : null,
          ]
        : h('span', { class: 'muted small' }, st.me && !st.me.alive ? t('blitz.spectating') : t('blitz.notPlaying')),
    );
    this.toggleBtn.textContent = '';
    this.toggleBtn.append(
      h('span', null, this.orders.length ? t('blitz.ordersN', { n: this.orders.length }) : t('blitz.noOrdersShort')),
      icon('chevron', 'blitz-chev'),
    );
    this.toggleBtn.setAttribute('aria-expanded', String(this.listOpen));
    this.toggleBtn.hidden = !can;

    let charged = charge;
    const costs = res && res.ok ? res.costs : [];
    replaceChildren(
      this.listEl,
      !can
        ? null
        : this.orders.length
          ? this.orders.map((o, i) => {
              const dmg = st.rules.attackDamage + (o.type === 'attack' ? charged : 0);
              if (o.type === 'attack') charged = 0;
              const rm = h('button', { class: 'blitz-rm', type: 'button', 'aria-label': t('blitz.remove'), title: t('blitz.remove') }, icon('close'));
              rm.addEventListener('click', () => this.remove(i));
              return h(
                'li',
                { class: `blitz-order k-${o.type}` },
                h('span', { class: 'blitz-n' }, String(i + 1)),
                h('span', { class: 'blitz-ic' }, icon(KIND_ICON[o.type])),
                h('span', { class: 'blitz-text' }, this.orderText(o, dmg)),
                h('span', { class: 'blitz-cost' }, t('unit.ap', { n: costs[i] ?? 0 })),
                rm,
              );
            })
          : h('li', { class: 'blitz-empty muted' }, t(window.matchMedia('(hover: none)').matches ? 'blitz.emptyTouch' : 'blitz.empty')),
    );

    this.confirmBtn.hidden = !can;
    this.clearBtn.hidden = !can || !this.orders.length || this.confirmed;
    replaceChildren(this.confirmBtn, icon(this.confirmed ? 'edit' : 'check'), h('span', null, t(this.confirmed ? 'blitz.edit' : this.orders.length ? 'blitz.confirm' : 'blitz.confirmNone')));
    this.clearBtn.textContent = t('blitz.clear');

    // who is still planning (never what)
    const alive = st.players.filter((p) => p.alive);
    const done = new Set(v.confirmed);
    const waiting = alive.filter((p) => !done.has(p.pid)).length;
    replaceChildren(
      this.waitEl,
      st.phase === 'running'
        ? [
            h('span', { class: 'blitz-wait-text' }, waiting ? t('blitz.waiting', { n: waiting }) : t('blitz.allReady')),
            h(
              'span',
              { class: 'peace-seals blitz-seals', role: 'list', 'aria-label': t('blitz.readyList') },
              alive.map((p) =>
                h(
                  'span',
                  { class: `peace-seal${done.has(p.pid) ? ' signed' : ''}`, role: 'listitem', title: t(done.has(p.pid) ? 'blitz.sealReady' : 'blitz.sealPlanning', { name: p.nickname }) },
                  h('span', { class: 'seal' }, flagImg(p.flag)),
                  done.has(p.pid) ? icon('check', 'peace-tick') : null,
                ),
              ),
            ),
          ]
        : null,
    );
    this.renderSummary();
    this.tick();
  }

  /** The big turn clock; called every 250 ms. Returns [label, value] for the top bar. */
  tick(): [string, string] {
    const st = this.st;
    const v = this.view;
    if (!st || !v) return ['', ''];
    let label: string;
    let value: string;
    let frac = 0;
    const now = this.host.serverNow();
    if (st.phase === 'paused') {
      label = t('blitz.clock.paused');
      value = '—';
    } else if (st.phase !== 'running' || v.deadline === null) {
      label = t('blitz.clock.over');
      value = '';
    } else if (this.frame || (v.planningFrom !== null && now < v.planningFrom)) {
      label = t('blitz.clock.resolving');
      value = countdown(v.deadline - now);
      frac = 1;
    } else {
      label = this.confirmed ? t('blitz.clock.ready') : t('blitz.clock.planning');
      value = countdown(v.deadline - now);
      const total = st.rules.blitzTurnSec * 1000;
      frac = Math.max(0, Math.min(1, (v.deadline - now) / total));
    }
    this.clockLabel.textContent = label;
    this.timeEl.textContent = value;
    this.barEl.style.transform = `scaleX(${frac.toFixed(4)})`;
    const urgent = st.phase === 'running' && v.deadline !== null && v.deadline - now < 10_000 && !this.frame;
    this.el.classList.toggle('urgent', urgent);
    this.sounds(now);
    return [t('blitz.topLabel', { n: v.turn }), value];
  }

  /** A sound when planning of a new turn opens (turn 1 has the start sound), and at 10 s left. */
  private sounds(now: number): void {
    const st = this.st;
    const v = this.view;
    if (!st || !v) return;
    if (this.soundedTurn === -1) {
      // first look at the room (or a reconnect): stay quiet about the turn already running
      this.soundedTurn = v.turn;
      if (v.deadline !== null && v.deadline - now < 10_000) this.hurriedTurn = v.turn;
      return;
    }
    if (!this.canPlan() || v.deadline === null || this.frame) return;
    const planning = v.planningFrom === null || now >= v.planningFrom;
    if (planning && v.turn > this.soundedTurn) {
      this.soundedTurn = v.turn;
      if (v.turn > 1) alert('turn');
    }
    if (planning && v.turn > this.hurriedTurn && !this.confirmed && v.deadline - now < 10_000 && v.deadline > now) {
      this.hurriedTurn = v.turn;
      alert('hurry');
    }
  }

  // ---------------------------------------------------------------- summary

  private name(pid: number | null | undefined): string {
    if (pid === null || pid === undefined) return t('common.someone');
    return this.st?.players.find((p) => p.pid === pid)?.nickname ?? t('common.someone');
  }

  private summaryLines(last: BlitzTurnView): string[] {
    const st = this.st!;
    const myPid = st.me?.pid ?? null;
    const lines: string[] = [];
    for (const s of last.shots.filter((x) => x.mine)) {
      const victim = s.hit ? st.players.find((p) => p.q === s.cell[0] && p.r === s.cell[1])?.pid ?? last.eliminated.find((e) => e.at[0] === s.cell[0] && e.at[1] === s.cell[1])?.pid : undefined;
      lines.push(s.hit ? t('blitz.sum.myHit', { name: this.name(victim), n: s.damage ?? 1 }) : t('blitz.sum.myMiss', { n: s.damage ?? 1 }));
    }
    if (last.myDamage) lines.push(t('blitz.sum.hitMe', { n: last.myDamage }));
    for (const g of last.gifts) {
      if (g.mine) lines.push(g.to !== null ? t('blitz.sum.myGift', { name: this.name(g.to), n: g.amount }) : t('blitz.sum.giftLost', { n: g.amount }));
    }
    if (last.myGifts) lines.push(t('blitz.sum.gotGift', { n: last.myGifts }));
    // a shot into the cell you just left: you dodged it
    const mine = last.moves.find((m) => m.pid === myPid && !m.bounced);
    if (mine && last.shots.some((s) => !s.mine && !s.hit && s.cell[0] === mine.from[0] && s.cell[1] === mine.from[1])) lines.push(t('blitz.sum.dodged'));
    for (const m of last.moves.filter((x) => x.bounced)) lines.push(m.pid === myPid ? t('blitz.sum.youBounced') : t('blitz.sum.bounced', { name: this.name(m.pid) }));
    for (const c of last.charges) lines.push(c.pid === myPid ? t('blitz.sum.youCharged', { n: c.level }) : t('blitz.sum.charged', { name: this.name(c.pid), n: c.level }));
    if (last.myRange) lines.push(t('blitz.sum.range', { n: last.myRange }));
    for (const e of last.eliminated) {
      lines.push(
        e.pid === myPid
          ? t('blitz.sum.youOut')
          : e.by === myPid
            ? t('blitz.sum.youKilled', { name: this.name(e.pid) })
            : e.by !== null
              ? t('blitz.sum.outBy', { name: this.name(e.pid), by: this.name(e.by) })
              : t('blitz.sum.out', { name: this.name(e.pid) }),
      );
    }
    if (!lines.length) lines.push(last.moves.length ? t('blitz.sum.quietMoves', { n: last.moves.length }) : t('blitz.sum.quiet'));
    return lines;
  }

  private headline(last: BlitzTurnView): string {
    const hits = last.shots.filter((s) => s.hit).length;
    const misses = last.shots.length - hits;
    if (!last.shots.length) return t('blitz.sum.noShots', { turn: last.turn });
    if (!hits || !misses) return t('blitz.sum.headOne', { turn: last.turn, what: hits ? t('blitz.sum.hits', { n: hits }) : t('blitz.sum.misses', { n: misses }) });
    return t('blitz.sum.head', { turn: last.turn, hits: t('blitz.sum.hits', { n: hits }), misses: t('blitz.sum.misses', { n: misses }) });
  }

  private renderSummary(): void {
    const last = this.view?.last;
    const show = !!last && last.turn <= this.summaryTurn;
    this.summaryEl.classList.toggle('hidden', !show);
    if (!last || !show) return;
    const again = h('button', { class: 'btn ghost small', type: 'button', title: t('blitz.replayTitle') }, icon('refresh'), t('blitz.replay'));
    again.addEventListener('click', () => {
      if (!this.frame && this.view?.last) this.replay(this.view.last);
    });
    replaceChildren(
      this.summaryEl,
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, t('blitz.sum.title', { n: last.turn })), again),
      h('p', { class: 'blitz-sum-head' }, this.headline(last)),
      h('ul', { class: 'blitz-sum-list' }, this.summaryLines(last).map((line) => h('li', null, line))),
    );
  }

  // ---------------------------------------------------------------- replay

  private later(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, ms));
  }

  private stage(text: string | null): void {
    this.stageEl.textContent = text ?? '';
    this.stageEl.classList.toggle('on', !!text);
  }

  private offBoard(): Hex {
    const ring = hexRing((this.st?.rules.gridRadius ?? 6) + 3);
    return ring[Math.floor(Math.random() * ring.length)];
  }

  /**
   * Plays a resolved turn on the board: everyone's moves hop together (bounces push back),
   * then the shots land on their cells (hits explode, misses puff), gifts fly, charges glow,
   * and the fallen topple. Built from the turn report alone, so it also works after a reconnect.
   */
  replay(last: BlitzTurnView): void {
    const st = this.st;
    if (!st) return;
    for (const id of this.timers) clearTimeout(id);
    this.timers = [];
    const map = this.host.map;
    const myPid = st.me?.pid ?? null;
    const fallen = new Map(last.eliminated.map((e) => [e.pid, e]));
    const moved = new Map(last.moves.map((m) => [m.pid, m]));
    const posAfter = (p: PublicPlayer): Hex | null => {
      const e = fallen.get(p.pid);
      if (e) return hexOf(e.at);
      return p.alive && p.q !== null && p.r !== null ? { q: p.q, r: p.r } : null;
    };
    const frameAt = (before: boolean): PublicPlayer[] =>
      st.players.map((p) => {
        let pos = posAfter(p);
        const m = moved.get(p.pid);
        if (before && m && !m.bounced) pos = hexOf(m.from);
        if (!pos) return p;
        return { ...p, alive: true, q: pos.q, r: pos.r };
      });
    const finalCharges = { ...(this.view?.charges ?? {}) };
    const startCharges: Record<number, number> = { ...finalCharges };
    for (const c of last.charges) startCharges[c.pid] = c.before;

    const pre = frameAt(true);
    const mid = frameAt(false);
    this.frame = { players: pre, charges: startCharges };
    this.host.redraw();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const k = reduced ? 0.5 : 1;
    let t0 = 250 * k;

    // 1. moves (and bounces) all at once
    this.later(t0, () => {
      this.stage(t('blitz.stage.moves', { n: last.turn }));
      this.frame = { players: mid, charges: startCharges };
      this.host.redraw();
      for (const m of last.moves) if (m.bounced) map.bounce(m.pid, hexOf(m.to));
      if (last.myRange && myPid !== null) {
        const me = mid.find((p) => p.pid === myPid);
        if (me && me.q !== null && me.r !== null) map.ring({ q: me.q, r: me.r }, 'range');
        this.host.pulse('range');
      }
    });
    t0 += (last.moves.length ? 900 : 300) * k;

    // 2. shots land on their cells
    if (last.shots.length) {
      this.later(t0, () => this.stage(t('blitz.stage.shots')));
      last.shots.forEach((s, i) => {
        this.later(t0 + i * 160 * k, () => {
          const from = s.from ? hexOf(s.from) : this.offBoard();
          const cell = hexOf(s.cell);
          map.strike(from, cell, s.hit, s.damage ?? 1);
          if (s.hit) map.float(cell, s.damage !== undefined ? `−${s.damage}` : '✸', 'bad');
          else map.float(cell, t('blitz.float.miss'), 'info');
          if (s.onMe && myPid !== null) {
            this.later(650 * k, () => {
              map.shake(myPid);
              this.host.pulse('hp');
              this.host.hitFlash();
            });
          }
        });
      });
      t0 += (last.shots.length * 160 + 1100) * k;
    }

    // 3. gifts
    if (last.gifts.length) {
      this.later(t0, () => {
        this.stage(t('blitz.stage.gifts'));
        for (const g of last.gifts) {
          const from = g.from ? hexOf(g.from) : this.offBoard();
          const cell = hexOf(g.cell);
          map.shot(from, cell, 'grant');
          map.float(cell, g.to !== null ? `+${g.amount}` : t('blitz.float.lost'), g.to !== null ? 'good' : 'info');
          if (g.to === myPid) this.host.pulse('ap');
        }
      });
      t0 += 900 * k;
    }

    // 4. charges glow, the fallen topple
    this.later(t0, () => {
      if (last.charges.length) this.stage(t('blitz.stage.charges'));
      for (const c of last.charges) {
        const p = mid.find((x) => x.pid === c.pid);
        if (p && p.q !== null && p.r !== null) map.float({ q: p.q, r: p.r }, `ϟ+${c.level}`, 'info');
      }
      this.frame = { players: mid, charges: finalCharges };
      this.host.redraw();
    });
    t0 += (last.charges.length ? 600 : 100) * k;
    this.later(t0, () => {
      this.frame = null;
      for (const e of last.eliminated) map.burst(hexOf(e.at));
      this.host.redraw();
      if (last.eliminated.length) this.stage(t('blitz.stage.fallen', { names: fmtList(last.eliminated.map((e) => this.name(e.pid))) }));
    });
    t0 += (last.eliminated.length ? 1100 : 200) * k;
    this.later(t0, () => {
      this.stage(null);
      this.summaryTurn = Math.max(this.summaryTurn, last.turn);
      const lines = this.summaryLines(last);
      toast(`${this.headline(last)} ${lines[0] ?? ''}`.trim(), last.myDamage ? 'error' : 'info', 3200);
      this.host.redraw();
    });
    this.replayEnds = Date.now() + t0;
  }
}
