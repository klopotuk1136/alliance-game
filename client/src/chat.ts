// Chat panel, shared by the lobby and the game screen: the room-wide channel, group chats
// and one private channel per player you talk to. The server decides who receives what
// (group membership included); this sorts incoming messages into channels, keeps unread
// counts and opens the shared plan of a group or private chat.

import { dmChannel, groupChannel, type ChatGroup, type PlanEvent, type PlanState } from '../../shared/plan.ts';
import { CHAT_MAX, type ChatMessage, type ClientMessage, type PublicPlayer, type RoomView, type ServerMessage } from '../../shared/protocol.ts';
import { confirmDialog, namesList, openMembersDialog, openRenameDialog } from './chat-groups.ts';
import { flagImg, h, replaceChildren, toast } from './dom.ts';
import { bindAttr, fmtDate, fmtTime, L, onLang, t, T } from './i18n.ts';
import type { PlanBoard } from './plan.ts';
import { profileTrigger } from './profile.ts';
import { hasStickers, loadStickers, onStickersChange, StickerPicker, stickerById, stickerName, stickersLoaded, stickerUrl } from './stickers.ts';
import { emptyState, icon, MenuButton, type ListOption } from './ui.ts';

/** 'all' = the room-wide channel; 'p:<pid>' = private chat with that player; 'g:<id>' = a group. */
type Channel = string;
const ALL: Channel = 'all';
const dmKey = (pid: number): Channel => `p:${pid}`;
const groupKey = (id: number): Channel => `g:${id}`;

type GroupMenu = 'plan' | 'rename' | 'add' | 'leave';

export class ChatPanel {
  readonly el: HTMLElement;
  private readonly sendMsg: (msg: ClientMessage) => void;
  private state: RoomView | null = null;
  private messages: ChatMessage[] = [];
  private groups: ChatGroup[] = [];
  private active: Channel = ALL;
  /** Private channels shown as tabs (ones with messages, plus any the player opened). */
  private readonly opened = new Set<number>();
  private readonly unread = new Map<Channel, number>();
  private readonly stickers: StickerPicker;
  /** Sticker images by message id, reused across renders so animations don't restart. */
  private readonly stickerEls = new Map<number, HTMLElement>();
  /** Messages that arrived live (not from history): their sticker pops in once. */
  private readonly fresh = new Set<number>();
  /** Group id we just created: open it as soon as the server confirms. */
  private openNewGroup = false;
  private plan: PlanBoard | null = null;

  private readonly tabsEl = h('div', { class: 'chat-tabs', role: 'tablist', 'aria-label': L('chat.tabsLabel') });
  private readonly chanHead = h('div', { class: 'chat-chan hidden' });
  private readonly picker: MenuButton<string>;
  private readonly newGroupBtn = h('button', { class: 'btn small ghost chat-new-group', type: 'button', title: L('chat.newGroup'), 'aria-label': L('chat.newGroup') }, icon('users'), h('span', { class: 'chat-new-label' }, T('chat.groupBtn')));
  /** Called for each message from someone else (the game screen badges its Chat tab). */
  onIncoming: () => void = () => undefined;
  private readonly listEl = h('ol', { class: 'chat-list' });
  private readonly input = h('textarea', { class: 'chat-input', rows: 1, maxlength: CHAT_MAX, placeholder: t('chat.placeholderAll') });
  private readonly sendBtn = h('button', { class: 'btn primary send-btn', type: 'submit', 'aria-label': L('chat.send') }, icon('send'), h('span', { class: 'send-label' }, T('chat.send')));

  constructor(send: (msg: ClientMessage) => void) {
    this.sendMsg = send;
    this.stickers = new StickerPicker((id) => this.sendSticker(id));
    this.stickers.available = false;
    const form = h('form', { class: 'chat-form' }, this.input, this.stickers.button, this.sendBtn);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.submit();
    });
    // Enter sends, Shift+Enter starts a new line.
    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener('input', () => this.autosize());
    this.picker = new MenuButton<string>({
      trigger: [icon('whisper'), h('span', null, T('chat.whisper'))],
      label: t('chat.whisperLabel'),
      title: t('chat.whisperTitle'),
      cls: 'small ghost chat-picker',
      emptyText: L('chat.whisperEmpty'),
      options: () => this.pickerOptions(),
      onPick: (v) => this.open(v === ALL ? ALL : dmKey(Number(v))),
    });
    bindAttr(this.picker.el, 'title', 'chat.whisperTitle');
    this.newGroupBtn.addEventListener('click', () => this.createGroup());
    // The panel lives as long as the room page. A language switch re-renders tabs, the
    // channel head and the message list; the draft, the open channel and an open plan stay.
    onLang(() => {
      const top = this.listEl.scrollTop;
      const atBottom = this.listEl.scrollHeight - top - this.listEl.clientHeight < 40;
      this.render();
      if (!atBottom) this.listEl.scrollTop = top;
    });

    // The catalog gives sticker URLs and sizes; the picker button shows once there are any.
    onStickersChange(() => {
      for (const [id, el] of this.stickerEls) {
        const m = this.messages.find((x) => x.id === id);
        if (!m?.sticker || el.getAttribute('src') !== stickerUrl(m.sticker)) this.stickerEls.delete(id);
      }
      this.render();
    });
    loadStickers()
      .catch(() => undefined)
      .finally(() => this.render());

    this.el = h(
      'section',
      { class: 'card chat-card hidden' },
      h('div', { class: 'card-head chat-head' }, h('h2', { class: 'card-title' }, T('chat.title')), h('div', { class: 'chat-head-actions' }, this.newGroupBtn, this.picker.el)),
      this.tabsEl,
      this.chanHead,
      this.listEl,
      form,
    );
  }

  /** New room state: players' names and whether the viewer may chat at all. */
  update(state: RoomView): void {
    this.state = state;
    this.el.classList.toggle('hidden', !state.participant);
    if (!state.participant) this.closePlan();
    this.render();
    this.plan?.refresh();
  }

  /** Messages from the server; `reset` replaces the whole history. */
  addMessages(messages: ChatMessage[], reset: boolean): void {
    if (reset) {
      this.messages = [];
      this.opened.clear();
      this.unread.clear();
      this.stickerEls.clear();
      this.fresh.clear();
    }
    const myPid = this.myPid();
    for (const m of messages) {
      this.messages.push(m);
      const channel = this.channelOf(m);
      if (channel.startsWith('p:')) this.opened.add(Number(channel.slice(2)));
      if (!reset && m.sticker) this.fresh.add(m.id);
      if (reset || m.from === myPid) continue;
      if (m.sys && m.sys.kind !== 'plan') continue;
      this.onIncoming();
      if (channel !== this.active) {
        this.unread.set(channel, (this.unread.get(channel) ?? 0) + 1);
        if (channel !== ALL && !m.sys) {
          const from = this.player(m.from);
          const who = this.nameOf(m.from, m.fromName);
          let text: string;
          if (m.group !== undefined) {
            const where = this.groupName(this.groups.find((g) => g.id === m.group));
            text = m.sticker ? t('chat.toastGroupSticker', { who, where }) : t('chat.toastGroupText', { who, where, text: preview(m.text) });
          } else {
            text = m.sticker ? t('chat.toastDmSticker', { who }) : t('chat.toastDmText', { who, text: preview(m.text) });
          }
          toast(text, 'info', 3500, from ? flagImg(from.flag) : icon('whisper'));
        }
      }
    }
    if (this.messages.length > 1000) {
      this.messages = this.messages.slice(-1000);
      const keep = new Set(this.messages.map((m) => m.id));
      for (const id of this.stickerEls.keys()) if (!keep.has(id)) this.stickerEls.delete(id);
    }
    this.render(true);
  }

  /** Group and plan messages from the server (see shared/plan.ts). */
  handle(msg: Extract<ServerMessage, { type: 'groups' | 'plan' | 'plan_op' }>): void {
    if (msg.type === 'groups') {
      const before = new Set(this.groups.map((g) => g.id));
      this.groups = msg.groups;
      const added = this.groups.filter((g) => !before.has(g.id));
      if (this.openNewGroup && added.length) {
        this.openNewGroup = false;
        this.open(groupKey(added[added.length - 1].id));
      }
      // A group we're no longer in: close its plan.
      if (this.plan && this.plan.channel.startsWith('g:') && !this.groups.some((g) => groupChannel(g.id) === this.plan?.channel)) this.closePlan();
      this.render();
      this.plan?.refresh();
      return;
    }
    if (msg.type === 'plan') {
      if (this.plan?.channel === msg.plan.channel) this.plan.setPlan(msg.plan as PlanState);
      return;
    }
    if (this.plan?.channel === msg.channel) this.plan.apply(msg.event as PlanEvent);
  }

  // ---------------------------------------------------------------- helpers

  private myPid(): number | null {
    return this.state?.me?.pid ?? null;
  }

  private player(pid: number): PublicPlayer | undefined {
    return this.state?.players.find((p) => p.pid === pid);
  }

  private nameOf(pid: number, fallback?: string): string {
    return this.player(pid)?.nickname ?? fallback ?? this.messages.find((m) => m.from === pid)?.fromName ?? t('common.someone');
  }

  private groupName(g: ChatGroup | undefined): string {
    if (!g) return t('chat.aGroup');
    if (g.name) return g.name;
    const me = this.myPid();
    return namesList(g.members.filter((p) => p !== me).map((p) => this.nameOf(p)));
  }

  private channelOf(m: ChatMessage): Channel {
    if (m.group !== undefined) return groupKey(m.group);
    if (m.to === null) return ALL;
    return dmKey(m.from === this.myPid() ? m.to : m.from);
  }

  private activeGroup(): ChatGroup | undefined {
    if (!this.active.startsWith('g:')) return undefined;
    const id = Number(this.active.slice(2));
    return this.groups.find((g) => g.id === id);
  }

  private activeDm(): number | null {
    return this.active.startsWith('p:') ? Number(this.active.slice(2)) : null;
  }

  private pickerOptions(): ListOption[] {
    const st = this.state;
    if (!st) return [];
    const myPid = this.myPid();
    const others = st.players.filter((p) => p.pid !== myPid).sort((a, b) => a.nickname.localeCompare(b.nickname));
    if (!others.length) return [];
    return [
      { value: ALL, label: t('chat.everyone'), hint: t('chat.everyoneHint'), lead: () => icon('users') },
      ...others.map((p) => ({
        value: String(p.pid),
        label: p.nickname,
        hint: this.opened.has(p.pid) ? t('chat.hintOpen') : p.alive ? '' : t('chat.hintOut'),
        lead: () => flagImg(p.flag),
      })),
    ];
  }

  private open(channel: Channel): void {
    if (channel.startsWith('p:')) this.opened.add(Number(channel.slice(2)));
    this.active = channel;
    this.unread.delete(channel);
    this.render(true);
    if (!matchMedia('(pointer: coarse)').matches) this.input.focus();
  }

  /** Who the open conversation goes to: `{ to, group }` for a chat message, or null if it can't be sent. */
  private target(): { to: number | null; group?: number } | null {
    if (this.active === ALL) return { to: null };
    const g = this.activeGroup();
    if (g) return { to: null, group: g.id };
    const pid = this.activeDm();
    if (pid !== null && this.player(pid)) return { to: pid };
    return null;
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (!text) return;
    const dest = this.target();
    if (!dest) {
      toast(t('chat.playerLeft'), 'error');
      return;
    }
    this.sendMsg({ type: 'chat', to: dest.to, text, ...(dest.group !== undefined ? { group: dest.group } : {}) });
    this.input.value = '';
    this.autosize();
  }

  /** Sends a sticker straight away to the open conversation. */
  private sendSticker(id: string): void {
    const dest = this.target();
    if (!dest) {
      toast(t('chat.playerLeft'), 'error');
      return;
    }
    this.sendMsg({ type: 'chat', to: dest.to, text: '', sticker: id, ...(dest.group !== undefined ? { group: dest.group } : {}) });
    // Back to typing on desktop; on touch screens that would pop the keyboard up.
    if (!matchMedia('(pointer: coarse)').matches) this.input.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- groups & plans

  private createGroup(): void {
    const me = this.myPid();
    const candidates = (this.state?.players ?? []).filter((p) => p.pid !== me);
    if (candidates.length < 2) {
      toast(t('chat.groupNeedsTwo'), 'error');
      return;
    }
    openMembersDialog({
      mode: 'create',
      candidates,
      onSubmit: (name, pids) => {
        this.openNewGroup = true;
        this.sendMsg({ type: 'group_create', name, members: pids });
      },
    });
  }

  private groupAction(g: ChatGroup, action: GroupMenu): void {
    if (action === 'plan') {
      void this.openPlan(groupChannel(g.id));
    } else if (action === 'rename') {
      openRenameDialog(g.name, this.groupName({ ...g, name: '' }), (name) => this.sendMsg({ type: 'group_rename', group: g.id, name }));
    } else if (action === 'add') {
      const candidates = (this.state?.players ?? []).filter((p) => !g.members.includes(p.pid));
      openMembersDialog({ mode: 'add', candidates, onSubmit: (_name, pids) => this.sendMsg({ type: 'group_add', group: g.id, members: pids }) });
    } else if (action === 'leave') {
      void confirmDialog({
        title: t('chat.leaveTitle'),
        text: t('chat.leaveText'),
        confirm: t('chat.leaveConfirm'),
        danger: true,
      }).then((yes) => {
        if (!yes) return;
        this.sendMsg({ type: 'group_leave', group: g.id });
        if (this.active === groupKey(g.id)) this.active = ALL;
        this.render(true);
      });
    }
  }

  private async openPlan(channel: string): Promise<void> {
    if (this.plan?.channel === channel) return;
    this.closePlan();
    const { PlanBoard } = await import('./plan.ts');
    const board = new PlanBoard({
      channel,
      send: (msg) => this.sendMsg(msg),
      state: () => this.state,
      title: () => this.planTitle(channel),
      members: () => this.planMembers(channel),
      onClose: () => {
        if (this.plan === board) this.plan = null;
      },
    });
    this.plan = board;
    this.sendMsg({ type: 'plan_open', channel });
  }

  private closePlan(): void {
    const p = this.plan;
    this.plan = null;
    p?.close();
  }

  private planTitle(channel: string): string {
    if (channel.startsWith('g:')) return this.groupName(this.groups.find((g) => groupChannel(g.id) === channel));
    const me = this.myPid();
    const other = channel
      .slice(2)
      .split(':')
      .map(Number)
      .find((p) => p !== me);
    return other !== undefined ? this.nameOf(other) : t('chat.privateChat');
  }

  private planMembers(channel: string): number[] {
    if (channel.startsWith('g:')) return this.groups.find((g) => groupChannel(g.id) === channel)?.members ?? [];
    return channel.slice(2).split(':').map(Number);
  }

  private renderChannelHead(): void {
    const g = this.activeGroup();
    const dm = this.activeDm();
    const me = this.myPid();
    this.chanHead.classList.toggle('hidden', !g && dm === null);
    if (!g && dm === null) {
      replaceChildren(this.chanHead);
      return;
    }
    const planBtn = h('button', { class: 'btn small chat-plan-btn', type: 'button', title: t('chat.planBtnTitle') }, icon('map'), h('span', null, t('chat.planBtn')));
    if (g) {
      planBtn.addEventListener('click', () => this.groupAction(g, 'plan'));
      const others = g.members.filter((p) => p !== me);
      const menu = new MenuButton<GroupMenu>({
        trigger: [icon('more')],
        label: t('chat.groupOptions'),
        title: t('chat.groupOptions'),
        cls: 'small ghost chat-chan-menu',
        minWidth: 200,
        options: () => [
          { value: 'rename', label: t('chat.renameGroup'), lead: () => icon('edit') },
          { value: 'add', label: t('chat.addMembers'), lead: () => icon('plus') },
          { value: 'leave', label: t('chat.leaveGroup'), lead: () => icon('logout') },
        ],
        onPick: (v) => this.groupAction(g, v),
      });
      menu.el.setAttribute('aria-label', t('chat.groupOptions'));
      replaceChildren(
        this.chanHead,
        h(
          'div',
          { class: 'chat-chan-who' },
          h('span', { class: 'chat-chan-flags', 'aria-hidden': 'true' }, g.members.slice(0, 5).map((pid) => {
            const p = this.player(pid);
            return p ? flagImg(p.flag) : null;
          })),
          h(
            'div',
            { class: 'chat-chan-text' },
            h('strong', { class: 'chat-chan-name' }, this.groupName(g)),
            h('span', { class: 'chat-chan-sub' }, g.name ? t('chat.groupSubNamed', { names: others.map((p) => this.nameOf(p)).join(', ') }) : t('chat.groupSubCount', { n: g.members.length })),
          ),
        ),
        planBtn,
        menu.el,
      );
    } else if (dm !== null) {
      planBtn.addEventListener('click', () => {
        if (me === null) return;
        void this.openPlan(dmChannel(me, dm));
      });
      planBtn.disabled = !this.player(dm);
      const p = this.player(dm);
      replaceChildren(
        this.chanHead,
        h(
          'div',
          { class: 'chat-chan-who' },
          h('span', { class: 'chat-chan-flags', 'aria-hidden': 'true' }, p ? flagImg(p.flag) : icon('whisper')),
          h('div', { class: 'chat-chan-text' }, h('strong', { class: 'chat-chan-name' }, this.nameOf(dm)), h('span', { class: 'chat-chan-sub' }, t('chat.dmSub'))),
        ),
        planBtn,
      );
    }
  }

  // ---------------------------------------------------------------- messages

  /** The sticker image of a message (kept between renders), or a small placeholder if it's gone. */
  private stickerEl(m: ChatMessage & { sticker: string }): HTMLElement {
    const cached = this.stickerEls.get(m.id);
    if (cached) return cached;
    const name = stickerName(m.sticker);
    const missing = (): HTMLElement => h('span', { class: 'chat-sticker-missing', role: 'img', 'aria-label': t('chat.stickerAria', { name }) }, t('chat.stickerMissing'), h('small', null, name));
    let el: HTMLElement;
    if (stickersLoaded() && !stickerById(m.sticker)) {
      el = missing();
    } else {
      const info = stickerById(m.sticker);
      const img = h('img', {
        class: 'chat-sticker',
        src: stickerUrl(m.sticker),
        alt: name,
        title: name,
        decoding: 'async',
        draggable: 'false',
        width: info?.w ?? null,
        height: info?.h ?? null,
      });
      img.addEventListener('error', () => {
        const ph = missing();
        img.replaceWith(ph);
        this.stickerEls.set(m.id, ph);
      });
      el = img;
    }
    if (this.fresh.delete(m.id)) {
      el.classList.add('pop');
      el.addEventListener('animationend', () => el.classList.remove('pop'), { once: true });
    }
    this.stickerEls.set(m.id, el);
    return el;
  }

  /** A line written by the server: "Anna created the group", "Boris updated the plan". */
  private sysLine(m: ChatMessage): HTMLElement {
    const sys = m.sys!;
    const me = this.myPid();
    const mine = m.from === me;
    const who = this.nameOf(m.from, m.fromName);
    let text: string;
    switch (sys.kind) {
      case 'created':
        text = mine ? t('chat.sysCreatedYou') : t('chat.sysCreated', { who });
        break;
      case 'added': {
        const names = (sys.pids ?? []).map((p) => (p === me ? t('common.you') : this.nameOf(p))).join(', ');
        text = mine ? t('chat.sysAddedYou', { names }) : t('chat.sysAdded', { who, names });
        break;
      }
      case 'left':
        text = mine ? t('chat.sysLeftYou') : t('chat.sysLeft', { who });
        break;
      case 'renamed':
        if (sys.name) text = mine ? t('chat.sysRenamedYou', { name: sys.name }) : t('chat.sysRenamed', { who, name: sys.name });
        else text = mine ? t('chat.sysUnnamedYou') : t('chat.sysUnnamed', { who });
        break;
      case 'plan':
        text = mine ? t('chat.sysPlanYou') : t('chat.sysPlan', { who });
        break;
    }
    const li = h('li', { class: `chat-sys ${sys.kind}` }, h('span', null, text), h('time', null, chatTime(m.ts)));
    if (sys.kind === 'plan') {
      const btn = h('button', { class: 'chat-sys-open', type: 'button' }, icon('map'), t('chat.openPlan'));
      btn.addEventListener('click', () => {
        if (m.group !== undefined) void this.openPlan(groupChannel(m.group));
        else if (m.to !== null) void this.openPlan(dmChannel(m.from, m.to));
      });
      li.append(btn);
    }
    return li;
  }

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`;
  }

  // ---------------------------------------------------------------- rendering

  private render(scroll = false): void {
    const st = this.state;
    if (!st) return;
    const myPid = this.myPid();
    if (this.active.startsWith('p:') && !this.opened.has(Number(this.active.slice(2)))) this.active = ALL;
    if (this.active.startsWith('g:') && !this.activeGroup()) this.active = ALL;

    // Tabs: everyone, then groups and private conversations, most recently active first.
    const lastAt = new Map<Channel, number>();
    for (const m of this.messages) lastAt.set(this.channelOf(m), m.id);
    const chans: Channel[] = [...this.groups.map((g) => groupKey(g.id)), ...[...this.opened].map(dmKey)];
    chans.sort((a, b) => (lastAt.get(b) ?? Infinity) - (lastAt.get(a) ?? Infinity));
    const tab = (channel: Channel, label: Array<Node | string | null>, cls = ''): HTMLElement => {
      const count = this.unread.get(channel) ?? 0;
      const on = channel === this.active;
      const btn = h(
        'button',
        { class: `chat-tab ${cls} ${on ? 'active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(on) },
        label,
        count ? h('span', { class: 'chat-unread', 'aria-label': t('chat.unread', { n: count }) }, count > 99 ? '99+' : String(count)) : null,
      );
      btn.addEventListener('click', () => this.open(channel));
      return btn;
    };
    replaceChildren(
      this.tabsEl,
      tab(ALL, [icon('users'), t('chat.everyone')]),
      chans.map((c) => {
        if (c.startsWith('g:')) {
          const g = this.groups.find((x) => groupKey(x.id) === c)!;
          return tab(c, [h('span', { class: 'chat-tab-hex', 'aria-hidden': 'true' }, icon('hex')), h('span', { class: 'chat-tab-name' }, this.groupName(g))], 'group');
        }
        const pid = Number(c.slice(2));
        const p = this.player(pid);
        return tab(c, [p ? flagImg(p.flag) : icon('whisper'), h('span', { class: 'chat-tab-name' }, this.nameOf(pid))]);
      }),
    );
    const activeTab = this.tabsEl.querySelector<HTMLElement>('.chat-tab.active');
    // Only the tab strip scrolls sideways — scrollIntoView would also scroll the page (phones jumped to the chat on load).
    if (activeTab && scroll) {
      const sr = this.tabsEl.getBoundingClientRect();
      const tr = activeTab.getBoundingClientRect();
      if (tr.left < sr.left) this.tabsEl.scrollLeft += tr.left - sr.left - 8;
      else if (tr.right > sr.right) this.tabsEl.scrollLeft += tr.right - sr.right + 8;
    }

    // Picker: start a private conversation with anyone else in the room.
    const others = st.players.filter((p) => p.pid !== myPid).length;
    this.picker.disabled = others < 1;
    this.newGroupBtn.disabled = others < 2;
    this.renderChannelHead();

    // Messages of the active channel.
    const atBottom = this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight < 40;
    const shown = this.messages.filter((m) => this.channelOf(m) === this.active);
    const g = this.activeGroup();
    replaceChildren(
      this.listEl,
      shown.length
        ? shown.map((m, i) => {
            if (m.sys) return this.sysLine(m);
            const p = this.player(m.from);
            // Same author within 3 minutes: one group, the name and time are shown once.
            const prev = shown[i - 1];
            const cont = prev !== undefined && !prev.sys && prev.from === m.from && m.ts - prev.ts < 180_000;
            return h(
              'li',
              { class: `chat-msg ${m.from === myPid ? 'mine' : 'theirs'} ${m.sticker ? 'is-sticker' : ''} ${cont ? 'cont' : ''}` },
              h(
                'div',
                { class: 'chat-meta' },
                m.from !== myPid && p?.username
                  ? profileTrigger(
                      h('button', { class: 'chat-author pf-name', type: 'button', title: t('chat.viewProfile', { username: p.username }) }, flagImg(p.flag), this.nameOf(m.from, m.fromName)),
                      p.username,
                      { nickname: p.nickname, flag: p.flag },
                    )
                  : h('span', { class: 'chat-author' }, p ? flagImg(p.flag) : null, m.from === myPid ? t('chat.you') : this.nameOf(m.from, m.fromName)),
                h('time', null, chatTime(m.ts)),
              ),
              m.sticker ? this.stickerEl(m as ChatMessage & { sticker: string }) : h('div', { class: 'chat-text' }, m.text),
            );
          })
        : h(
            'li',
            { class: 'chat-empty' },
            this.active === ALL
              ? emptyState(t('chat.emptyAllTitle'), t('chat.emptyAllText'))
              : g
                ? emptyState(this.groupName(g), t('chat.emptyGroupText'), 'private')
                : emptyState(t('chat.emptyDmTitle', { name: this.nameOf(this.activeDm() ?? -1) }), t('chat.emptyDmText'), 'private'),
          ),
    );
    if (scroll || atBottom) this.listEl.scrollTop = this.listEl.scrollHeight;
    this.el.classList.toggle('private', this.activeDm() !== null);
    this.el.classList.toggle('group', !!g);

    const dest = this.target();
    const dm = this.activeDm();
    this.input.placeholder =
      this.active === ALL ? t('chat.placeholderAll') : g ? t('chat.placeholderGroup') : t('chat.placeholderDm', { name: this.nameOf(dm ?? -1) });
    const canSend = dest !== null;
    this.input.disabled = !canSend;
    this.sendBtn.disabled = !canSend;
    this.stickers.available = hasStickers();
    this.stickers.disabled = !canSend;
  }
}

function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** "14:05:09" today, "12 Mar 14:05" on another day — in the current language. */
function chatTime(ts: number): string {
  const today = new Date(ts).toDateString() === new Date().toDateString();
  return today ? fmtTime(ts, true) : `${fmtDate(ts)} ${fmtTime(ts)}`;
}
