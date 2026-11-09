// Chat panel, shared by the lobby and the game screen: a room-wide channel plus one
// private channel per player you talk to. The server decides who receives what; this
// only sorts incoming messages into tabs and keeps unread counts.

import { CHAT_MAX, type ChatMessage, type PublicPlayer, type RoomView } from '../../shared/protocol.ts';
import { flagImg, h, replaceChildren, toast } from './dom.ts';
import { clockTime } from './format.ts';
import { profileTrigger } from './profile.ts';
import { hasStickers, loadStickers, onStickersChange, StickerPicker, stickerById, stickerName, stickersLoaded, stickerUrl } from './stickers.ts';
import { emptyState, icon, MenuButton, type ListOption } from './ui.ts';

/** 'all' = the room-wide channel; a number = the private channel with that player. */
type Channel = 'all' | number;

export class ChatPanel {
  readonly el: HTMLElement;
  private readonly sendFn: (to: number | null, text: string, sticker?: string) => void;
  private state: RoomView | null = null;
  private messages: ChatMessage[] = [];
  private active: Channel = 'all';
  /** Private channels shown as tabs (ones with messages, plus any the player opened). */
  private readonly opened = new Set<number>();
  private readonly unread = new Map<Channel, number>();
  private readonly stickers: StickerPicker;
  /** Sticker images by message id, reused across renders so animations don't restart. */
  private readonly stickerEls = new Map<number, HTMLElement>();
  /** Messages that arrived live (not from history): their sticker pops in once. */
  private readonly fresh = new Set<number>();

  private readonly tabsEl = h('div', { class: 'chat-tabs', role: 'tablist' });
  private readonly picker: MenuButton<string>;
  /** Called for each message from someone else (the game screen badges its Chat tab). */
  onIncoming: () => void = () => undefined;
  private readonly listEl = h('ol', { class: 'chat-list' });
  private readonly input = h('textarea', { class: 'chat-input', rows: 1, maxlength: CHAT_MAX, placeholder: 'Message everyone…' });
  private readonly sendBtn = h('button', { class: 'btn primary send-btn', type: 'submit', 'aria-label': 'Send' }, icon('send'), h('span', { class: 'send-label' }, 'Send'));

  constructor(send: (to: number | null, text: string, sticker?: string) => void) {
    this.sendFn = send;
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
      trigger: [icon('whisper'), h('span', null, 'Whisper')],
      label: 'Send a private message',
      title: 'Start a private conversation',
      cls: 'small ghost chat-picker',
      emptyText: 'Nobody else is here yet',
      options: () => this.pickerOptions(),
      onPick: (v) => this.open(v === 'all' ? 'all' : Number(v)),
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
      h('div', { class: 'card-head chat-head' }, h('h2', { class: 'card-title' }, 'Chat'), this.picker.el),
      this.tabsEl,
      this.listEl,
      form,
    );
  }

  /** New room state: players' names and whether the viewer may chat at all. */
  update(state: RoomView): void {
    this.state = state;
    this.el.classList.toggle('hidden', !state.participant);
    this.render();
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
      if (channel !== 'all') this.opened.add(channel);
      if (!reset && m.sticker) this.fresh.add(m.id);
      if (reset || m.from === myPid) continue;
      this.onIncoming();
      if (channel !== this.active) {
        this.unread.set(channel, (this.unread.get(channel) ?? 0) + 1);
        if (channel !== 'all') {
          const from = this.player(m.from);
          const what = m.sticker ? 'sent a sticker' : `whispers: ${preview(m.text)}`;
          toast(`${this.nameOf(m.from, m.fromName)} ${what}`, 'info', 3500, from ? flagImg(from.flag) : icon('whisper'));
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

  // ---------------------------------------------------------------- helpers

  private myPid(): number | null {
    return this.state?.me?.pid ?? null;
  }

  private player(pid: number): PublicPlayer | undefined {
    return this.state?.players.find((p) => p.pid === pid);
  }

  private nameOf(pid: number, fallback?: string): string {
    return this.player(pid)?.nickname ?? fallback ?? this.messages.find((m) => m.from === pid)?.fromName ?? 'someone';
  }

  private channelOf(m: ChatMessage): Channel {
    if (m.to === null) return 'all';
    return m.from === this.myPid() ? m.to : m.from;
  }

  private pickerOptions(): ListOption[] {
    const st = this.state;
    if (!st) return [];
    const myPid = this.myPid();
    const others = st.players.filter((p) => p.pid !== myPid).sort((a, b) => a.nickname.localeCompare(b.nickname));
    if (!others.length) return [];
    return [
      { value: 'all', label: 'Everyone', hint: 'room channel', lead: () => icon('users') },
      ...others.map((p) => ({
        value: String(p.pid),
        label: p.nickname,
        hint: this.opened.has(p.pid) ? 'open' : p.alive ? '' : 'out',
        lead: () => flagImg(p.flag),
      })),
    ];
  }

  private open(channel: Channel): void {
    if (channel !== 'all') this.opened.add(channel);
    this.active = channel;
    this.unread.delete(channel);
    this.render(true);
    this.input.focus();
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (!text) return;
    if (this.active !== 'all' && !this.player(this.active)) {
      toast('That player has left the room', 'error');
      return;
    }
    this.sendFn(this.active === 'all' ? null : this.active, text);
    this.input.value = '';
    this.autosize();
  }

  /** Sends a sticker straight away to the open conversation. */
  private sendSticker(id: string): void {
    if (this.active !== 'all' && !this.player(this.active)) {
      toast('That player has left the room', 'error');
      return;
    }
    this.sendFn(this.active === 'all' ? null : this.active, '', id);
    // Back to typing on desktop; on touch screens that would pop the keyboard up.
    if (!matchMedia('(pointer: coarse)').matches) this.input.focus({ preventScroll: true });
  }

  /** The sticker image of a message (kept between renders), or a small placeholder if it's gone. */
  private stickerEl(m: ChatMessage & { sticker: string }): HTMLElement {
    const cached = this.stickerEls.get(m.id);
    if (cached) return cached;
    const name = stickerName(m.sticker);
    const missing = (): HTMLElement => h('span', { class: 'chat-sticker-missing', role: 'img', 'aria-label': `Sticker: ${name}` }, 'sticker', h('small', null, name));
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

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`;
  }

  // ---------------------------------------------------------------- rendering

  private render(scroll = false): void {
    const st = this.state;
    if (!st) return;
    const myPid = this.myPid();
    if (this.active !== 'all' && !this.opened.has(this.active)) this.active = 'all';

    // Tabs: everyone, then private conversations in order of their latest message.
    const lastAt = new Map<number, number>();
    for (const m of this.messages) {
      const c = this.channelOf(m);
      if (c !== 'all') lastAt.set(c, m.id);
    }
    const dms = [...this.opened].sort((a, b) => (lastAt.get(b) ?? Infinity) - (lastAt.get(a) ?? Infinity));
    const tab = (channel: Channel, label: Array<Node | string>): HTMLElement => {
      const count = this.unread.get(channel) ?? 0;
      const btn = h(
        'button',
        { class: `chat-tab ${channel === this.active ? 'active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(channel === this.active) },
        label,
        count ? h('span', { class: 'chat-unread' }, count > 99 ? '99+' : String(count)) : null,
      );
      btn.addEventListener('click', () => this.open(channel));
      return btn;
    };
    replaceChildren(
      this.tabsEl,
      tab('all', [icon('users'), 'Everyone']),
      dms.map((pid) => {
        const p = this.player(pid);
        return tab(pid, [p ? flagImg(p.flag) : icon('whisper'), this.nameOf(pid)]);
      }),
    );

    // Picker: start a private conversation with anyone else in the room.
    this.picker.disabled = !st.players.some((p) => p.pid !== myPid);

    // Messages of the active channel.
    const atBottom = this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight < 40;
    const shown = this.messages.filter((m) => this.channelOf(m) === this.active);
    replaceChildren(
      this.listEl,
      shown.length
        ? shown.map((m, i) => {
            const p = this.player(m.from);
            // Same author within 3 minutes: one group, the name and time are shown once.
            const prev = shown[i - 1];
            const cont = prev !== undefined && prev.from === m.from && m.ts - prev.ts < 180_000;
            return h(
              'li',
              { class: `chat-msg ${m.from === myPid ? 'mine' : 'theirs'} ${m.sticker ? 'is-sticker' : ''} ${cont ? 'cont' : ''}` },
              h(
                'div',
                { class: 'chat-meta' },
                m.from !== myPid && p?.username
                  ? profileTrigger(
                      h('button', { class: 'chat-author pf-name', type: 'button', title: `@${p.username}: view profile` }, flagImg(p.flag), this.nameOf(m.from, m.fromName)),
                      p.username,
                      { nickname: p.nickname, flag: p.flag },
                    )
                  : h('span', { class: 'chat-author' }, p ? flagImg(p.flag) : null, m.from === myPid ? 'You' : this.nameOf(m.from, m.fromName)),
                h('time', null, clockTime(m.ts)),
              ),
              m.sticker ? this.stickerEl(m as ChatMessage & { sticker: string }) : h('div', { class: 'chat-text' }, m.text),
            );
          })
        : h(
            'li',
            { class: 'chat-empty' },
            this.active === 'all'
              ? emptyState('No messages yet', 'Say hi. Every alliance starts with a word.')
              : emptyState(`A private line to ${this.nameOf(this.active)}`, 'Only the two of you can read this conversation.', 'private'),
          ),
    );
    if (scroll || atBottom) this.listEl.scrollTop = this.listEl.scrollHeight;
    this.el.classList.toggle('private', this.active !== 'all');

    const target = this.active === 'all' ? null : this.player(this.active);
    this.input.placeholder = this.active === 'all' ? 'Message everyone…' : `Private message to ${target?.nickname ?? this.nameOf(this.active)}…`;
    const canSend = this.active === 'all' || !!target;
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
