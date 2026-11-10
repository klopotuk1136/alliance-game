// Notification UI: the bell in the top bars, the settings panel (popover on desktop, bottom
// sheet on phones), the friendly explainer before the browser's permission prompt, the
// "Add to Home Screen" steps for iOS, and a one-time offer card in rooms.

import { PUSH_CATEGORIES, type PushCategory } from '../../shared/push.ts';
import { h, replaceChildren, s, toast } from './dom.ts';
import { L, onLang, t, T, type Key } from './i18n.ts';
import {
  disablePush,
  dismissOffer,
  enablePush,
  notifyPrefs,
  offerDismissed,
  onNotifyChange,
  previewSound,
  pushState,
  sendTestNotification,
  setNotifyPrefs,
  type PushState,
} from './notify.ts';
import type { SoundKind } from './notify-sound.ts';
import { openLayer, type Layer } from './profile.ts';
import { icon } from './ui.ts';

const BELL = 'M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2H5ZM10 20.5a2.2 2.2 0 0 0 4 0M12 3.5v2';
const BELL_OFF = 'M6.5 16.5V11c0-1 .3-2 .8-2.8M9.5 6.1A5.5 5.5 0 0 1 17.5 11v4M5 18.5h12.5M10 20.5a2.2 2.2 0 0 0 4 0M4 4l16 16';
const SPEAKER = 'M4 9.5h3.5L12 6v12l-4.5-3.5H4ZM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11';

function svgIcon(d: string, cls = ''): SVGSVGElement {
  return s('svg', { class: `icon ${cls}`.trim(), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, s('path', { d }));
}

const CAT_TEXT: Record<PushCategory, [Key, Key]> = {
  chat: ['nt.cat.chat', 'nt.cat.chatHint'],
  attacks: ['nt.cat.attacks', 'nt.cat.attacksHint'],
  ap: ['nt.cat.ap', 'nt.cat.apHint'],
  game: ['nt.cat.game', 'nt.cat.gameHint'],
};
/** The sound each switch previews. */
const CAT_SOUND: Record<PushCategory, SoundKind> = { chat: 'dm', attacks: 'hit', ap: 'ap', game: 'start' };

/** An on/off switch: a button with role="switch". */
function toggle(label: Node, hint: Node | null, on: boolean, onChange: (on: boolean) => void, disabled = false): { el: HTMLElement; set(on: boolean): void } {
  const id = `nt-sw-${++uid}`;
  const btn = h('button', { class: 'nt-switch', type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-labelledby': id, disabled }, h('span', { class: 'nt-knob', 'aria-hidden': 'true' }));
  const set = (v: boolean): void => {
    btn.setAttribute('aria-checked', String(v));
  };
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    set(next);
    onChange(next);
  });
  const el = h('div', { class: 'nt-row' }, h('div', { class: 'nt-row-text' }, h('span', { class: 'nt-row-label', id }, label), hint ? h('span', { class: 'nt-row-hint' }, hint) : null), btn);
  return { el, set };
}
let uid = 0;

/** The bell icon (also used by the account menu). */
export function bellIcon(): SVGSVGElement {
  return svgIcon(BELL);
}

// ---------------------------------------------------------------- bell

/** The top-bar bell; the slash shows when system notifications are off on this device. */
export function notifyBell(cls = ''): HTMLElement {
  const btn = h('button', { class: `btn ghost small nt-bell ${cls}`.trim(), type: 'button', title: L('nt.bell'), 'aria-label': L('nt.bell') });
  const paint = (): void => {
    const st = pushState();
    replaceChildren(btn, svgIcon(st === 'on' ? BELL : BELL_OFF));
    btn.classList.toggle('on', st === 'on');
  };
  paint();
  btn.addEventListener('click', () => openNotifySettings(btn));
  const off = onNotifyChange(() => {
    if (!btn.isConnected) return off();
    paint();
  });
  return btn;
}

// ---------------------------------------------------------------- settings panel

let open: Layer | null = null;

export function openNotifySettings(anchor: HTMLElement | null): void {
  open?.close();
  const status = h('div', { class: 'nt-status' });
  const explainer = h('div', { class: 'nt-explain-slot' });
  const prefs = notifyPrefs();

  const master = toggle(T('nt.system'), T('nt.systemHint'), pushState() === 'on', (on) => {
    if (on) showExplainer();
    else {
      void disablePush().then(() => {
        toast(t('nt.turnedOff'), 'info');
        paint();
      });
    }
  });

  const showExplainer = (): void => {
    if (Notification.permission === 'granted') {
      void turnOn();
      return;
    }
    const allow = h('button', { class: 'btn primary', type: 'button' }, T('nt.explain.allow'));
    const later = h('button', { class: 'btn ghost', type: 'button' }, T('nt.explain.later'));
    allow.addEventListener('click', () => void turnOn());
    later.addEventListener('click', () => {
      replaceChildren(explainer);
      paint();
    });
    replaceChildren(explainer, explainerCard(allow, later));
    allow.focus({ preventScroll: true });
  };

  const turnOn = async (): Promise<void> => {
    try {
      const st = await enablePush();
      replaceChildren(explainer);
      if (st === 'on') toast(t('nt.turnedOn'), 'good');
    } catch (err) {
      console.warn(err);
      toast(t('nt.enableFail'), 'error');
    }
    paint();
  };

  const cats = h(
    'div',
    { class: 'nt-cats', role: 'group', 'aria-label': L('nt.cats') },
    PUSH_CATEGORIES.map((c) => {
      const [label, hint] = CAT_TEXT[c];
      const row = toggle(T(label), T(hint), prefs.cats[c], (on) => {
        setNotifyPrefs({ cats: { ...notifyPrefs().cats, [c]: on } });
        if (on && notifyPrefs().sound) previewSound(CAT_SOUND[c]);
      });
      return row.el;
    }),
  );

  const volume = h('input', {
    class: 'nt-volume',
    type: 'range',
    min: '0',
    max: '100',
    step: '5',
    value: String(Math.round(prefs.volume * 100)),
    'aria-label': L('nt.volume'),
  });
  volume.addEventListener('input', () => setNotifyPrefs({ volume: Number(volume.value) / 100 }));
  volume.addEventListener('change', () => previewSound('ap'));
  const listen = h('button', { class: 'btn ghost small nt-listen', type: 'button', title: L('nt.preview'), 'aria-label': L('nt.preview') }, svgIcon(SPEAKER));
  listen.addEventListener('click', () => previewSound('dm'));
  const volumeRow = h('div', { class: 'nt-volume-row' }, h('span', { class: 'nt-row-hint' }, T('nt.volume')), volume, listen);
  const sound = toggle(T('nt.sound'), T('nt.soundHint'), prefs.sound, (on) => {
    setNotifyPrefs({ sound: on });
    volumeRow.classList.toggle('off', !on);
    if (on) previewSound('chat');
  });
  volumeRow.classList.toggle('off', !prefs.sound);

  const testBtn = h('button', { class: 'btn secondary nt-test', type: 'button' }, svgIcon(BELL), T('nt.test'));
  testBtn.addEventListener('click', async () => {
    if (pushState() !== 'on') {
      toast(t('nt.testNone'), 'info');
      return;
    }
    testBtn.disabled = true;
    try {
      await sendTestNotification();
      toast(t('nt.testSent'), 'good');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      testBtn.disabled = false;
    }
  });

  const paint = (): void => {
    const st = pushState();
    master.set(st === 'on');
    const masterBtn = master.el.querySelector('button')!;
    masterBtn.disabled = st === 'unsupported' || st === 'ios-browser' || st === 'denied';
    replaceChildren(status, statusBlock(st));
    foot.hidden = st !== 'on';
  };

  const foot = h('div', { class: 'nt-foot' }, testBtn);
  const close = h('button', { class: 'btn ghost small pf-x', type: 'button', 'aria-label': L('nt.close'), title: L('nt.close') }, icon('close'));
  const content = h(
    'div',
    { class: 'nt-panel' },
    h(
      'div',
      { class: 'nt-head' },
      h('span', { class: 'nt-head-mark', 'aria-hidden': 'true' }, svgIcon(BELL)),
      h('div', { class: 'nt-head-text' }, h('h2', { class: 'nt-title display' }, T('nt.title')), h('p', { class: 'nt-sub' }, T('nt.sub'))),
      close,
    ),
    h('section', { class: 'nt-section' }, master.el, status, explainer),
    h('section', { class: 'nt-section' }, h('p', { class: 'nt-eyebrow' }, T('nt.cats')), cats),
    h('section', { class: 'nt-section' }, sound.el, volumeRow),
    foot,
  );
  paint();
  const layer = openLayer({ label: t('nt.title'), content, kind: anchor ? 'popover' : 'modal', anchor, cls: 'nt-layer', onClose: () => (open = null) });
  close.addEventListener('click', () => layer.close());
  open = layer;
  const offLang = onLang(() => (layer.panel.isConnected ? paint() : offLang()));
}

function statusBlock(st: PushState): HTMLElement | null {
  switch (st) {
    case 'on':
      return h('p', { class: 'nt-state on' }, icon('check'), T('nt.status.on'));
    case 'off':
      return h('p', { class: 'nt-state' }, T('nt.status.off'));
    case 'denied':
      return h('p', { class: 'nt-state warn' }, icon('lock'), T('nt.status.denied'));
    case 'unsupported':
      return h('p', { class: 'nt-state warn' }, icon('info'), T('nt.status.unsupported'));
    case 'ios-browser':
      return iosSteps();
  }
}

function iosSteps(): HTMLElement {
  const share = 'M12 3.5v11M8 7.5l4-4 4 4M7 11H5.5v9.5h13V11H17';
  return h(
    'div',
    { class: 'nt-ios' },
    h('p', { class: 'nt-ios-title' }, T('nt.ios.title')),
    h('p', { class: 'nt-ios-text' }, T('nt.ios.text')),
    h(
      'ol',
      { class: 'nt-ios-steps' },
      h('li', null, h('span', { class: 'nt-ios-ico', 'aria-hidden': 'true' }, svgIcon(share)), h('span', null, T('nt.ios.step1'))),
      h('li', null, h('span', { class: 'nt-ios-ico', 'aria-hidden': 'true' }, icon('plus')), h('span', null, T('nt.ios.step2'))),
      h('li', null, h('span', { class: 'nt-ios-ico', 'aria-hidden': 'true' }, svgIcon(BELL)), h('span', null, T('nt.ios.step3'))),
    ),
  );
}

function explainerCard(allow: HTMLElement, later: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'nt-explain', role: 'group', 'aria-label': L('nt.explain.title') },
    h('div', { class: 'nt-explain-seal', 'aria-hidden': 'true' }, svgIcon(BELL)),
    h('div', { class: 'nt-explain-body' }, h('p', { class: 'nt-explain-title' }, T('nt.explain.title')), h('p', { class: 'nt-explain-text' }, T('nt.explain.text'))),
    h('div', { class: 'nt-explain-actions' }, allow, later),
  );
}

// ---------------------------------------------------------------- offer card in rooms

let offerEl: HTMLElement | null = null;

/**
 * Once a player has joined a room: a small card offering notifications (only when they could be
 * turned on with one tap, and only until the player answers it).
 */
export function maybeOfferNotifications(): void {
  if (offerEl?.isConnected || offerDismissed()) return;
  const st = pushState();
  if (st !== 'off' || Notification.permission !== 'default') return;
  const on = h('button', { class: 'btn primary small', type: 'button' }, T('nt.offer.on'));
  const later = h('button', { class: 'btn ghost small', type: 'button' }, T('nt.offer.later'));
  const card = h(
    'aside',
    { class: 'nt-offer', role: 'dialog', 'aria-label': L('nt.offer.title') },
    h('div', { class: 'nt-explain-seal', 'aria-hidden': 'true' }, svgIcon(BELL)),
    h('div', { class: 'nt-offer-body' }, h('p', { class: 'nt-explain-title' }, T('nt.offer.title')), h('p', { class: 'nt-explain-text' }, T('nt.offer.text'))),
    h('div', { class: 'nt-offer-actions' }, on, later),
  );
  const remove = (): void => {
    card.classList.remove('in');
    setTimeout(() => card.remove(), 200);
    offerEl = null;
  };
  on.addEventListener('click', () => {
    // The browser's prompt follows this tap directly (the card is the explainer).
    dismissOffer();
    remove();
    enablePush()
      .then((st) => {
        if (st === 'on') toast(t('nt.turnedOn'), 'good');
      })
      .catch(() => toast(t('nt.enableFail'), 'error'));
  });
  later.addEventListener('click', () => {
    dismissOffer();
    remove();
  });
  // In the page flow, so it never covers (or pushes away) the chat input or the phone's action
  // bar: wide game screens put it under the log in the left column (the log gives up the room),
  // narrower ones in the side column above your country card (phones: the top of the screen,
  // like the banner), the lobby at the top of its main column. Elsewhere it floats in a corner.
  const roster = document.querySelector('.game[data-layout="wide"] .roster');
  const side = document.querySelector('.game .side');
  const meCard = side?.querySelector(':scope > .me-card');
  const lobbyMain = document.querySelector('.lobby-main');
  if (roster) roster.append(card);
  else if (side && meCard) side.insertBefore(card, meCard);
  else if (lobbyMain) lobbyMain.prepend(card);
  else {
    card.classList.add('nt-offer-float');
    document.body.appendChild(card);
  }
  offerEl = card;
  requestAnimationFrame(() => card.classList.add('in'));
}

/** Leaving a room: the offer card goes with it (it comes back next time unless answered). */
export function hideOffer(): void {
  offerEl?.remove();
  offerEl = null;
}
