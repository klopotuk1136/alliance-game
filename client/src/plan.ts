// The shared planning board of a group or private chat: a full-screen layer with a flat
// top-down snapshot of the map, drawing tools (move / attack / support arrows, pins,
// notes, ghost pieces), turn layers, undo/redo, erase and clear. Every edit is a small
// op sent over the room's WebSocket; the server validates it and sends it to every
// member, so everyone sees the same plan live.

import { hexKey, type Hex } from '../../shared/hex.ts';
import { PLAN_NOTE_MAX, PLAN_TURNS, type ArrowKind, type PinKind, type PlanEvent, type PlanItem, type PlanItemInput, type PlanPiece, type PlanState } from '../../shared/plan.ts';
import type { ClientMessage, RoomView } from '../../shared/protocol.ts';
import { confirmDialog } from './chat-groups.ts';
import { flagImg, h, onCloseTransient, replaceChildren, toast } from './dom.ts';
import { bindAttr, fmtDate, fmtTime, L, onLang, t, T, type Key } from './i18n.ts';
import { describe, PlanCanvas } from './plan-svg.ts';
import { icon, MenuButton } from './ui.ts';

type Tool = ArrowKind | PinKind | 'note' | 'ghost' | 'erase' | 'hand';

const TOOLS: Array<{ id: Tool; icon: string; group: string }> = [
  { id: 'move', icon: 'move', group: 'arrows' },
  { id: 'attack', icon: 'attack', group: 'arrows' },
  { id: 'support', icon: 'grant', group: 'arrows' },
  { id: 'target', icon: 'target', group: 'marks' },
  { id: 'defend', icon: 'shield', group: 'marks' },
  { id: 'rally', icon: 'flag', group: 'marks' },
  { id: 'note', icon: 'note', group: 'marks' },
  { id: 'ghost', icon: 'ghost', group: 'marks' },
  { id: 'erase', icon: 'eraser', group: 'edit' },
  { id: 'hand', icon: 'hand', group: 'edit' },
];
/** Phones: the arrow kinds and the pins share one toolbar button each (a small menu picks). */
type ToolGroup = 'arrows' | 'marks';
const GROUPS: Record<ToolGroup, Tool[]> = { arrows: ['move', 'attack', 'support'], marks: ['target', 'defend', 'rally'] };
const groupOf = (tool: Tool): ToolGroup | null => (GROUPS.arrows.includes(tool) ? 'arrows' : GROUPS.marks.includes(tool) ? 'marks' : null);
const toolIcon = (id: Tool): string => TOOLS.find((x) => x.id === id)?.icon ?? 'move';
const toolLabel = (id: Tool): Key => `plan.tool.${id}`;
const toolHint = (id: Tool): Key => `plan.hint.${id}`;

/** Author colours: readable on the ink-navy board, distinct from each other. */
const PALETTE = ['#e8c987', '#6fb3e8', '#7cc98f', '#e88a6a', '#b99ae8', '#56c7c0', '#e891b8', '#d9b54a'];

type Hist = { kind: 'add'; id: number; input: PlanItemInput } | { kind: 'erase'; input: PlanItemInput; id: number };

function inputOf(it: PlanItem): PlanItemInput {
  const { id: _id, author: _a, ts: _t, ...rest } = it;
  return rest as PlanItemInput;
}

export interface PlanBoardOpts {
  channel: string;
  send(msg: ClientMessage): void;
  state(): RoomView | null;
  /** Name of the chat (group name or the other player). */
  title(): string;
  /** pids of the chat's members, in order (decides author colours). */
  members(): number[];
  onClose(): void;
}

export class PlanBoard {
  readonly channel: string;
  private readonly o: PlanBoardOpts;
  private plan: PlanState | null = null;
  private turn = 1;
  private tool: Tool = 'move';
  private selected: number | null = null;
  private undoStack: Hist[] = [];
  private redoStack: Hist[] = [];
  private readonly pending = new Map<string, (item: PlanItem) => void>();
  private cidSeq = 0;
  private closed = false;
  private readonly returnTo = document.activeElement as HTMLElement | null;

  private readonly canvas = new PlanCanvas();
  private readonly root: HTMLElement;
  private readonly subEl = h('span', { class: 'plan-sub' });
  private readonly turnsEl = h('div', { class: 'segmented plan-turns', role: 'radiogroup', 'aria-label': L('plan.turnGroup') });
  private readonly toolBtns = new Map<Tool, HTMLButtonElement>();
  private readonly undoBtn = h('button', { class: 'plan-tool act', type: 'button', title: L('plan.undoTitle'), 'aria-label': L('plan.undo') }, icon('undo'), h('span', null, T('plan.undo')));
  private readonly redoBtn = h('button', { class: 'plan-tool act', type: 'button', title: L('plan.redoTitle'), 'aria-label': L('plan.redo') }, icon('redo'), h('span', null, T('plan.redo')));
  private readonly clearMenu: MenuButton<'turn' | 'all'>;
  /** Phone toolbar: grouped tools + an overflow for undo / redo / clear (desktop keeps the full column). */
  private readonly groupLast: Record<ToolGroup, Tool> = { arrows: 'move', marks: 'target' };
  private readonly groupBtns = new Map<ToolGroup, { menu: MenuButton<Tool>; iconEl: HTMLElement }>();
  private readonly moreMenu: MenuButton<'undo' | 'redo' | 'turn' | 'all'>;
  private readonly offTransient: () => void;
  private readonly snapEl = h('div', { class: 'plan-snap' });
  private readonly bannerEl = h('div', { class: 'plan-banner hidden', role: 'status' });
  private readonly infoEl = h('div', { class: 'plan-info hidden', role: 'status' });
  private readonly hintEl = h('div', { class: 'plan-hint', 'aria-live': 'polite' });
  private readonly legendEl = h('div', { class: 'plan-legend' });
  private readonly noteForm: HTMLFormElement;
  private readonly noteInput = h('input', { class: 'plan-note-input', maxlength: PLAN_NOTE_MAX, placeholder: L('plan.notePlaceholder'), autocomplete: 'off', 'aria-label': L('plan.noteLabel') });
  private noteCell: Hex | null = null;
  private readonly stage: HTMLElement;
  private readonly offLang: () => void;

  // gesture state
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: { id: number; x0: number; y0: number; lastX: number; lastY: number; cell: Hex | null; moved: boolean; itemId: number | null; piece: PlanPiece | null } | null = null;
  private pinch: { dist: number; mx: number; my: number } | null = null;

  constructor(o: PlanBoardOpts) {
    this.o = o;
    this.channel = o.channel;

    // Tools
    const tools = h('div', { class: 'plan-tools', role: 'toolbar', 'aria-label': L('plan.tools') });
    let lastGroup = '';
    for (const tool of TOOLS) {
      if (lastGroup && tool.group !== lastGroup) tools.appendChild(h('span', { class: 'plan-sep', 'aria-hidden': 'true' }));
      lastGroup = tool.group;
      const b = h('button', { class: `plan-tool t-${tool.id}`, type: 'button', title: L(toolHint(tool.id)), 'aria-pressed': 'false' }, icon(tool.icon), h('span', null, T(toolLabel(tool.id))));
      b.addEventListener('click', () => this.setTool(tool.id));
      this.toolBtns.set(tool.id, b);
      tools.appendChild(b);
    }
    this.clearMenu = new MenuButton<'turn' | 'all'>({
      trigger: [icon('trash'), h('span', null, T('plan.clear'))],
      label: t('plan.clearLabel'),
      title: t('plan.clearTitle'),
      cls: 'plan-tool act plan-clear',
      minWidth: 210,
      options: () => [
        { value: 'turn', label: t('plan.clearTurn', { n: this.turn }), lead: () => icon('trash') },
        { value: 'all', label: t('plan.clearAll'), lead: () => icon('trash') },
      ],
      onPick: (v) => void this.clear(v === 'all' ? null : this.turn),
    });
    bindAttr(this.clearMenu.el, 'title', 'plan.clearTitle');
    this.undoBtn.addEventListener('click', () => this.undo());
    this.redoBtn.addEventListener('click', () => this.redo());
    tools.append(h('span', { class: 'plan-sep', 'aria-hidden': 'true' }), this.undoBtn, this.redoBtn, this.clearMenu.el);

    // Phone toolbar (CSS shows these ≤760 px and hides the single arrow/pin buttons and the edit row)
    const groupDefs: Array<[ToolGroup, Key, Key]> = [
      ['arrows', 'plan.group.arrows', 'plan.group.arrowsTitle'],
      ['marks', 'plan.group.marks', 'plan.group.marksTitle'],
    ];
    for (const [group, label, title] of groupDefs) {
      const iconEl = h('span', { class: 'plan-group-icon' }, icon(toolIcon(this.groupLast[group])));
      const menu = new MenuButton<Tool>({
        trigger: [iconEl, h('span', null, T(label)), h('span', { class: 'plan-caret', 'aria-hidden': 'true' })],
        label: L(title),
        title: L(title),
        cls: `plan-tool plan-group g-${group}`,
        minWidth: 190,
        options: () =>
          GROUPS[group].map((id) => ({ value: id, label: t(toolLabel(id)), lead: () => icon(toolIcon(id)), hint: id === this.tool ? '✓' : undefined })),
        onPick: (id) => this.setTool(id),
      });
      // First tap on an inactive group picks its last tool at once; a tap on the active one opens the choice.
      menu.el.addEventListener(
        'click',
        (ev) => {
          if (groupOf(this.tool) === group) return;
          ev.stopImmediatePropagation();
          ev.preventDefault();
          this.setTool(this.groupLast[group]);
        },
        true,
      );
      this.groupBtns.set(group, { menu, iconEl });
    }
    this.moreMenu = new MenuButton<'undo' | 'redo' | 'turn' | 'all'>({
      trigger: [icon('more'), h('span', null, T('plan.more'))],
      label: L('plan.moreLabel'),
      title: L('plan.moreLabel'),
      cls: 'plan-tool plan-more',
      minWidth: 220,
      options: () => [
        { value: 'undo', label: t('plan.undo'), lead: () => icon('undo'), disabled: !this.undoStack.length },
        { value: 'redo', label: t('plan.redo'), lead: () => icon('redo'), disabled: !this.redoStack.length },
        { value: 'turn', label: t('plan.clearTurn', { n: this.turn }), lead: () => icon('trash'), disabled: !this.plan?.items.some((i) => i.turn === this.turn) },
        { value: 'all', label: t('plan.clearAll'), lead: () => icon('trash'), disabled: !this.plan?.items.length },
      ],
      onPick: (v) => {
        if (v === 'undo') this.undo();
        else if (v === 'redo') this.redo();
        else void this.clear(v === 'all' ? null : this.turn);
      },
    });
    tools.prepend(this.groupBtns.get('arrows')!.menu.el, this.groupBtns.get('marks')!.menu.el);
    tools.append(this.moreMenu.el);

    // Turn layers
    for (let turn = 1; turn <= PLAN_TURNS; turn++) {
      const b = h('button', { class: 'seg', type: 'button', role: 'radio', 'data-turn': turn });
      b.addEventListener('click', () => this.setTurn(turn));
      b.addEventListener('keydown', (ev) => {
        const d = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        ev.preventDefault();
        const next = ((turn - 1 + d + PLAN_TURNS) % PLAN_TURNS) + 1;
        this.setTurn(next);
        (this.turnsEl.querySelector(`[data-turn="${next}"]`) as HTMLElement | null)?.focus();
      });
      this.turnsEl.appendChild(b);
    }

    // Note form
    const noteCancel = h('button', { class: 'btn ghost small', type: 'button' }, T('plan.cancel'));
    this.noteForm = h(
      'form',
      { class: 'plan-note hidden' },
      icon('note'),
      this.noteInput,
      h('button', { class: 'btn primary small', type: 'submit' }, T('plan.addNote')),
      noteCancel,
    );
    this.noteForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = this.noteInput.value.trim();
      if (text && this.noteCell) this.add({ kind: 'note', turn: this.turn, at: [this.noteCell.q, this.noteCell.r], text });
      this.hideNote();
    });
    noteCancel.addEventListener('click', () => this.hideNote());

    const fitBtn = h('button', { class: 'btn ghost small plan-fit', type: 'button', title: L('plan.fit'), 'aria-label': L('plan.fit') }, icon('fit'));
    fitBtn.addEventListener('click', () => this.canvas.fit());
    this.stage = h(
      'div',
      { class: 'plan-stage' },
      this.canvas.el,
      h('div', { class: 'plan-stage-top' }, this.snapEl, fitBtn),
      this.bannerEl,
      this.noteForm,
      this.infoEl,
      this.hintEl,
      h('div', { class: 'plan-loading' }, T('plan.loading')),
    );

    const closeBtn = h('button', { class: 'btn ghost small plan-close', type: 'button', 'aria-label': L('plan.close') }, icon('close'));
    closeBtn.addEventListener('click', () => this.close());
    this.root = h(
      'div',
      { class: 'plan-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': L('plan.dialog'), tabindex: '-1' },
      h(
        'header',
        { class: 'plan-head' },
        h('div', { class: 'plan-title' }, icon('map'), h('div', null, h('h2', null, T('plan.title')), this.subEl)),
        this.turnsEl,
        closeBtn,
      ),
      h('div', { class: 'plan-body' }, tools, this.stage, this.legendEl),
    );
    this.root.classList.add('loading');
    this.offTransient = onCloseTransient(() => this.close());

    this.bindPointer();
    this.root.addEventListener('keydown', (ev) => this.key(ev));
    document.body.appendChild(this.root);
    document.documentElement.classList.add('pf-locked');
    requestAnimationFrame(() => this.root.classList.add('in'));
    this.root.focus({ preventScroll: true });
    this.setTool('move');
    this.setTurn(1);
    // Language switch: re-render the text; tool, turn, selection, undo/redo and the view stay.
    this.offLang = onLang(() => {
      this.setTool(this.tool);
      this.select(this.selected, true);
      this.refresh();
    });
  }

  // ---------------------------------------------------------------- data in

  setPlan(plan: PlanState): void {
    const first = !this.plan;
    this.plan = plan;
    this.root.classList.remove('loading');
    if (first) this.canvas.fit();
    this.refresh();
  }

  apply(ev: PlanEvent): void {
    const plan = this.plan;
    if (!plan) return;
    switch (ev.op) {
      case 'add': {
        if (plan.items.some((i) => i.id === ev.item.id)) return;
        plan.items.push(ev.item);
        const cb = ev.cid ? this.pending.get(ev.cid) : undefined;
        if (cb && ev.cid) {
          this.pending.delete(ev.cid);
          cb(ev.item);
        }
        break;
      }
      case 'del':
        plan.items = plan.items.filter((i) => !ev.ids.includes(i.id));
        if (this.selected !== null && ev.ids.includes(this.selected)) this.select(null);
        break;
      case 'clear':
        plan.items = plan.items.filter((i) => ev.turn !== null && i.turn !== ev.turn);
        if (ev.by !== this.myPid()) toast(ev.turn === null ? t('plan.clearedAll', { name: this.nameOf(ev.by) }) : t('plan.clearedTurn', { name: this.nameOf(ev.by), n: ev.turn }), 'info');
        this.undoStack = [];
        this.redoStack = [];
        this.select(null);
        break;
      case 'snapshot':
        plan.snapshot = ev.snapshot;
        break;
    }
    this.refresh();
  }

  /** Re-renders everything (also called when the room state or member list changes). */
  refresh(): void {
    if (this.closed) return;
    this.subEl.textContent = this.o.title();
    const plan = this.plan;
    for (const b of this.turnsEl.querySelectorAll<HTMLButtonElement>('[data-turn]')) {
      const turn = Number(b.dataset.turn);
      const n = plan ? plan.items.filter((i) => i.turn === turn).length : 0;
      replaceChildren(b, t(this.o.state()?.rules.mode === 'blitz' ? 'plan.turnBlitz' : 'plan.turn', { n: turn }), n ? h('span', { class: 'plan-count' }, String(n)) : null);
    }
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
    this.clearMenu.disabled = !plan?.items.length;
    if (!plan) return;
    const st = this.o.state();
    this.canvas.render({
      radius: plan.snapshot.radius,
      pieces: plan.snapshot.pieces,
      items: plan.items,
      turn: this.turn,
      myPid: this.myPid(),
      myRange: st?.me && st.phase !== 'lobby' ? st.me.range : null,
      colorOf: (pid) => this.colorOf(pid),
      nameOf: (pid) => this.nameOf(pid),
      selected: this.selected,
    });
    this.renderSnap();
    this.renderLegend();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.offLang();
    this.offTransient();
    this.root.classList.remove('in');
    const done = (): void => this.root.remove();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else setTimeout(done, 180);
    if (!document.querySelector('.pf-layer')) document.documentElement.classList.remove('pf-locked');
    this.o.onClose();
    if (this.returnTo?.isConnected) this.returnTo.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- helpers

  private myPid(): number | null {
    return this.o.state()?.me?.pid ?? null;
  }

  private nameOf(pid: number): string {
    const st = this.o.state();
    return st?.players.find((p) => p.pid === pid)?.nickname ?? this.plan?.snapshot.pieces.find((p) => p.pid === pid)?.nickname ?? t('plan.someone');
  }

  private colorOf(pid: number): string {
    const i = this.o.members().indexOf(pid);
    return PALETTE[(i >= 0 ? i : pid) % PALETTE.length];
  }

  private pieceAt(h: Hex | null): PlanPiece | null {
    if (!h || !this.plan) return null;
    return this.plan.snapshot.pieces.find((p) => p.q === h.q && p.r === h.r) ?? null;
  }

  private itemById(id: number | null): PlanItem | undefined {
    return id === null ? undefined : this.plan?.items.find((i) => i.id === id);
  }

  private setTool(tool: Tool): void {
    const same = tool === this.tool;
    this.tool = tool;
    for (const [id, b] of this.toolBtns) {
      b.classList.toggle('on', id === tool);
      b.setAttribute('aria-pressed', String(id === tool));
    }
    this.root.dataset.tool = tool;
    this.hintEl.textContent = t(toolHint(tool));
    const g = groupOf(tool);
    if (g) this.groupLast[g] = tool;
    for (const [group, b] of this.groupBtns) {
      b.menu.el.classList.toggle('on', group === g);
      b.menu.el.dataset.tool = this.groupLast[group];
      replaceChildren(b.iconEl, icon(toolIcon(this.groupLast[group])));
    }
    if (same) return;
    if (tool !== 'note') this.hideNote();
    if (tool !== 'hand' && tool !== 'erase') this.select(null);
  }

  private setTurn(turn: number): void {
    this.turn = turn;
    for (const b of this.turnsEl.querySelectorAll<HTMLButtonElement>('[data-turn]')) {
      const on = Number(b.dataset.turn) === turn;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    this.select(null);
    this.refresh();
  }

  private select(id: number | null, quiet = false): void {
    const changed = id !== this.selected;
    this.selected = id;
    if (changed && this.plan && !quiet) this.refresh();
    const it = this.itemById(id);
    if (!it) {
      this.infoEl.classList.add('hidden');
      return;
    }
    replaceChildren(
      this.infoEl,
      h('span', { class: 'plan-swatch', style: `background:${this.colorOf(it.author)}` }),
      h('span', null, describe(it, (p) => this.nameOf(p))),
      h('time', null, planTime(it.ts)),
    );
    this.infoEl.classList.remove('hidden');
  }

  private renderSnap(): void {
    const plan = this.plan!;
    const snap = plan.snapshot;
    const refresh = h('button', { class: 'btn ghost small plan-refresh', type: 'button', title: t('plan.refreshTitle') }, icon('refresh'), h('span', null, t('plan.refresh')));
    refresh.addEventListener('click', () => this.o.send({ type: 'plan_op', channel: this.channel, op: { op: 'snapshot' } }));
    replaceChildren(
      this.snapEl,
      h('span', { class: 'plan-snap-text' }, snap.by !== null ? t('plan.snapBy', { time: planTime(snap.at), name: this.nameOf(snap.by) }) : t('plan.snap', { time: planTime(snap.at) })),
      refresh,
    );

    // Diff: have pieces moved since the snapshot?
    const st = this.o.state();
    let moved = 0;
    if (st && st.phase !== 'lobby') {
      const now = new Map(st.players.filter((p) => p.alive && p.q !== null && p.r !== null).map((p) => [p.pid, hexKey({ q: p.q!, r: p.r! })]));
      const then = new Map(snap.pieces.map((p) => [p.pid, hexKey(p)]));
      for (const [pid, k] of now) if (then.get(pid) !== k) moved++;
      for (const pid of then.keys()) if (!now.has(pid)) moved++;
    }
    if (moved) {
      const btn = h('button', { class: 'btn small primary', type: 'button' }, icon('refresh'), t('plan.refreshSnapshot'));
      btn.addEventListener('click', () => this.o.send({ type: 'plan_op', channel: this.channel, op: { op: 'snapshot' } }));
      replaceChildren(
        this.bannerEl,
        icon('alert'),
        h('span', null, t('plan.moved', { n: moved })),
        btn,
      );
      this.bannerEl.classList.remove('hidden');
    } else {
      this.bannerEl.classList.add('hidden');
    }
  }

  private renderLegend(): void {
    const me = this.myPid();
    const members = this.o.members();
    const authors = new Set([...members, ...(this.plan?.items.map((i) => i.author) ?? [])]);
    const st = this.o.state();
    replaceChildren(
      this.legendEl,
      h('h3', { class: 'plan-legend-title' }, t('plan.whoDrew')),
      h(
        'ul',
        { class: 'plan-authors' },
        [...authors].map((pid) => {
          const p = st?.players.find((x) => x.pid === pid);
          const n = this.plan?.items.filter((i) => i.author === pid).length ?? 0;
          return h(
            'li',
            { class: members.includes(pid) ? '' : 'gone' },
            h('span', { class: 'plan-swatch', style: `background:${this.colorOf(pid)}` }),
            p ? flagImg(p.flag) : null,
            h('span', { class: 'plan-author-name' }, pid === me ? t('plan.you') : this.nameOf(pid)),
            n ? h('span', { class: 'plan-count' }, String(n)) : null,
          );
        }),
      ),
      h('h3', { class: 'plan-legend-title' }, t('plan.arrows')),
      h(
        'ul',
        { class: 'plan-kinds' },
        h('li', null, h('span', { class: 'plan-kind k-move', 'aria-hidden': 'true' }), t('plan.kindMove')),
        h('li', null, h('span', { class: 'plan-kind k-attack', 'aria-hidden': 'true' }), t('plan.kindAttack')),
        h('li', null, h('span', { class: 'plan-kind k-support', 'aria-hidden': 'true' }), t('plan.kindSupport')),
      ),
      h('p', { class: 'plan-legend-note' }, t('plan.legendNote')),
    );
  }

  // ---------------------------------------------------------------- edits

  private add(input: PlanItemInput, onAdded?: (item: PlanItem) => void): void {
    const cid = `c${++this.cidSeq}`;
    this.pending.set(cid, (item) => {
      if (onAdded) onAdded(item);
      else {
        this.undoStack.push({ kind: 'add', id: item.id, input });
        this.redoStack = [];
        this.refresh();
      }
    });
    this.o.send({ type: 'plan_op', channel: this.channel, op: { op: 'add', item: input, cid } });
  }

  private erase(id: number): void {
    const it = this.itemById(id);
    if (!it) return;
    this.o.send({ type: 'plan_op', channel: this.channel, op: { op: 'del', ids: [id] } });
    this.undoStack.push({ kind: 'erase', input: inputOf(it), id });
    this.redoStack = [];
  }

  private undo(): void {
    const h0 = this.undoStack.pop();
    if (!h0) return;
    if (h0.kind === 'add') {
      this.o.send({ type: 'plan_op', channel: this.channel, op: { op: 'del', ids: [h0.id] } });
      this.redoStack.push(h0);
    } else {
      this.add(h0.input, (item) => {
        this.redoStack.push({ kind: 'erase', input: h0.input, id: item.id });
        this.refresh();
      });
    }
    this.refresh();
  }

  private redo(): void {
    const h0 = this.redoStack.pop();
    if (!h0) return;
    if (h0.kind === 'add') {
      this.add(h0.input, (item) => {
        this.undoStack.push({ kind: 'add', id: item.id, input: h0.input });
        this.refresh();
      });
    } else {
      this.o.send({ type: 'plan_op', channel: this.channel, op: { op: 'del', ids: [h0.id] } });
      this.undoStack.push(h0);
    }
    this.refresh();
  }

  private async clear(turn: number | null): Promise<void> {
    const yes = await confirmDialog({
      title: turn === null ? t('plan.clearAllQ') : t('plan.clearTurnQ', { n: turn }),
      text: t('plan.clearText'),
      confirm: t('plan.clear'),
      danger: true,
    });
    if (yes) this.o.send({ type: 'plan_op', channel: this.channel, op: { op: 'clear', turn } });
  }

  private showNote(cell: Hex): void {
    this.noteCell = cell;
    this.noteInput.value = '';
    this.noteForm.classList.remove('hidden');
    this.noteInput.focus();
  }

  private hideNote(): void {
    this.noteCell = null;
    this.noteForm.classList.add('hidden');
  }

  // ---------------------------------------------------------------- input

  private key(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      if (document.querySelector('.pf-layer, .lb-pop:not([hidden])')) return;
      ev.preventDefault();
      if (!this.noteForm.classList.contains('hidden')) this.hideNote();
      else this.close();
      return;
    }
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === 'z' && !(ev.target instanceof HTMLInputElement)) {
      ev.preventDefault();
      if (ev.shiftKey) this.redo();
      else this.undo();
    } else if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      this.redo();
    }
  }

  private bindPointer(): void {
    const svg = this.canvas.el;
    svg.addEventListener('pointerdown', (ev) => {
      if (!this.plan) return;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      svg.setPointerCapture(ev.pointerId);
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (this.pointers.size === 2) {
        // Two fingers: pinch-zoom and pan; drop whatever one finger started.
        this.gesture = null;
        this.canvas.clearPreview();
        const [a, b] = [...this.pointers.values()];
        this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        return;
      }
      if (this.pointers.size > 2) return;
      const cell = this.canvas.cellAt(ev.clientX, ev.clientY);
      const hit = (ev.target as Element).closest?.('[data-id]');
      this.gesture = {
        id: ev.pointerId,
        x0: ev.clientX,
        y0: ev.clientY,
        lastX: ev.clientX,
        lastY: ev.clientY,
        cell,
        moved: false,
        itemId: hit ? Number(hit.getAttribute('data-id')) : null,
        piece: this.pieceAt(cell),
      };
      if (cell && (this.tool === 'move' || this.tool === 'attack' || this.tool === 'support')) this.canvas.previewArrow(cell, cell, this.tool, this.colorOf(this.myPid() ?? 0));
    });
    svg.addEventListener('pointermove', (ev) => {
      if (this.pointers.has(ev.pointerId)) this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        this.canvas.panBy(mx - this.pinch.mx, my - this.pinch.my);
        if (this.pinch.dist > 0) this.canvas.zoomAt(mx, my, dist / this.pinch.dist);
        this.pinch = { dist, mx, my };
        return;
      }
      const g = this.gesture;
      if (!g || g.id !== ev.pointerId) {
        if (ev.pointerType === 'mouse') this.canvas.setHover(this.canvas.cellAt(ev.clientX, ev.clientY));
        return;
      }
      if (!g.moved && Math.hypot(ev.clientX - g.x0, ev.clientY - g.y0) > 6) g.moved = true;
      const cell = this.canvas.cellAt(ev.clientX, ev.clientY);
      if (ev.pointerType === 'mouse') this.canvas.setHover(cell);
      const color = this.colorOf(this.myPid() ?? 0);
      if (this.tool === 'hand' || (this.tool === 'erase' && g.moved)) {
        this.canvas.panBy(ev.clientX - g.lastX, ev.clientY - g.lastY);
      } else if ((this.tool === 'move' || this.tool === 'attack' || this.tool === 'support') && g.cell && cell) {
        this.canvas.previewArrow(g.cell, cell, this.tool, color);
      } else if (this.tool === 'ghost' && g.piece && cell && g.moved) {
        this.canvas.previewGhost(g.piece, cell, color);
      }
      g.lastX = ev.clientX;
      g.lastY = ev.clientY;
    });
    const end = (ev: PointerEvent, cancelled: boolean): void => {
      this.pointers.delete(ev.pointerId);
      if (this.pinch) {
        if (this.pointers.size < 2) this.pinch = null;
        return;
      }
      const g = this.gesture;
      if (!g || g.id !== ev.pointerId) return;
      this.gesture = null;
      this.canvas.clearPreview();
      if (cancelled || !this.plan) return;
      const cell = this.canvas.cellAt(ev.clientX, ev.clientY);
      this.finish(g, cell);
    };
    svg.addEventListener('pointerup', (ev) => end(ev, false));
    svg.addEventListener('pointercancel', (ev) => end(ev, true));
    svg.addEventListener('pointerleave', (ev) => {
      if (ev.pointerType === 'mouse') this.canvas.setHover(null);
    });
    svg.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        this.canvas.zoomAt(ev.clientX, ev.clientY, Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0018)));
      },
      { passive: false },
    );
  }

  private finish(g: NonNullable<PlanBoard['gesture']>, cell: Hex | null): void {
    const tool = this.tool;
    const turn = this.turn;
    if (tool === 'move' || tool === 'attack' || tool === 'support') {
      if (g.cell && cell && hexKey(g.cell) !== hexKey(cell)) this.add({ kind: tool, turn, from: [g.cell.q, g.cell.r], to: [cell.q, cell.r] });
      else if (!g.moved && g.itemId !== null) this.select(g.itemId);
      else if (!g.moved) this.flashHint();
      return;
    }
    if (tool === 'target' || tool === 'defend' || tool === 'rally') {
      if (!g.moved && g.cell) this.add({ kind: 'pin', turn, at: [g.cell.q, g.cell.r], pin: tool });
      return;
    }
    if (tool === 'note') {
      if (!g.moved && g.cell) this.showNote(g.cell);
      return;
    }
    if (tool === 'ghost') {
      if (g.piece && cell && hexKey(cell) !== hexKey(g.piece)) this.add({ kind: 'ghost', turn, at: [cell.q, cell.r], pid: g.piece.pid });
      else if (!g.moved) this.flashHint();
      return;
    }
    if (tool === 'erase') {
      if (!g.moved && g.itemId !== null) {
        const it = this.itemById(g.itemId);
        if (it && it.turn === this.turn) this.erase(g.itemId);
        else if (it) toast(t('plan.eraseOtherTurn', { n: it.turn }), 'info');
      }
      return;
    }
    // hand: tap a mark to see who drew it
    if (!g.moved) this.select(g.itemId);
  }

  private flashHint(): void {
    this.hintEl.classList.remove('flash');
    void this.hintEl.offsetWidth;
    this.hintEl.classList.add('flash');
  }
}

/** "14:05:09" today, "12 Mar 14:05" on another day — in the current language. */
function planTime(ts: number): string {
  const today = new Date(ts).toDateString() === new Date().toDateString();
  return today ? fmtTime(ts, true) : `${fmtDate(ts)} ${fmtTime(ts)}`;
}
