// Notifications on this device: the player's switches, Web Push (service worker
// client/public/sw.js + server/push.ts), in-app sounds, and the "(3) Alliance" tab badge.
//
// - Tab visible: no system notifications (the server doesn't push to a visible room); the
//   page plays a sound and shows its usual toasts.
// - Tab hidden but open: the server pushes a system notification; the page counts the alert
//   in the tab title and puts a dot on the favicon.
// - Site closed: the server's push reaches the service worker.
//
// Other screens (blitz) call `alert(kind)` for their own moments.

import { DEFAULT_PUSH_PREFS, normalizePrefs, type PushCategory, type PushPrefs, type PushSubscribeRequest } from '../../shared/push.ts';
import { api, getToken } from './api.ts';
import { lang, onLang, setTitleBadge } from './i18n.ts';
import { installAudioUnlock, playSound, type SoundKind } from './notify-sound.ts';

export interface NotifyPrefs {
  /** System notifications (Web Push) wanted on this device. */
  push: boolean;
  /** What to be alerted about (system notifications and sounds alike). */
  cats: PushPrefs;
  sound: boolean;
  /** 0..1 */
  volume: number;
}

const STORE_KEY = 'alliance.notify';
const OFFER_KEY = 'alliance.notifyOfferDismissed';
const DEFAULTS: NotifyPrefs = { push: false, cats: { ...DEFAULT_PUSH_PREFS }, sound: true, volume: 0.6 };

/** Which switch a sound belongs to. */
const SOUND_CATEGORY: Record<SoundKind, PushCategory> = {
  chat: 'chat',
  dm: 'chat',
  hit: 'attacks',
  fall: 'attacks',
  ap: 'ap',
  start: 'game',
  peace: 'game',
  turn: 'game',
  hurry: 'game',
};

function load(): NotifyPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<NotifyPrefs> | null;
    if (raw && typeof raw === 'object') {
      return {
        push: raw.push === true,
        cats: normalizePrefs(raw.cats),
        sound: raw.sound !== false,
        volume: typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : DEFAULTS.volume,
      };
    }
  } catch {
    /* storage blocked or garbage */
  }
  return { ...DEFAULTS, cats: { ...DEFAULTS.cats } };
}

let prefs = load();
const listeners = new Set<() => void>();

export function notifyPrefs(): NotifyPrefs {
  return prefs;
}

/** Changes switches; saved on this device, and pushed to the server when notifications are on. */
export function setNotifyPrefs(change: Partial<NotifyPrefs>): void {
  prefs = { ...prefs, ...change, cats: { ...prefs.cats, ...(change.cats ?? {}) } };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    /* storage blocked */
  }
  if (change.cats && prefs.push) void syncPush();
  for (const fn of listeners) fn();
}

export function onNotifyChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------- platform

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
}

export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

/** Opened from the home screen (iOS only delivers web push to home-screen apps). */
export function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export type PushState = 'unsupported' | 'ios-browser' | 'denied' | 'off' | 'on';

export function pushState(): PushState {
  if (isIos() && !isStandalone()) return 'ios-browser';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return prefs.push && Notification.permission === 'granted' ? 'on' : 'off';
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  registration ??= navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
    console.warn('service worker registration failed', err);
    registration = null;
    return null;
  });
  return registration;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

let serverKey: Promise<string> | null = null;

function fetchKey(): Promise<string> {
  serverKey ??= api<{ publicKey: string }>('GET', '/api/push/key')
    .then((r) => r.publicKey)
    .catch((err) => {
      serverKey = null;
      throw err;
    });
  return serverKey;
}

/** This browser's subscription for the server's current key (made if missing, renewed if the key changed). */
async function subscription(create: boolean): Promise<PushSubscription | null> {
  const reg = await swRegistration();
  if (!reg) return null;
  const key = b64urlToBytes(await fetchKey());
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return sub;
}

async function sendSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('Incomplete push subscription');
  const body: PushSubscribeRequest = {
    subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
    lang: lang(),
    prefs: prefs.cats,
  };
  await api('POST', '/api/push/subscribe', body);
}

/**
 * Turns system notifications on. Must run inside a click/tap handler: the browser's permission
 * prompt only opens after a user gesture. Resolves to the resulting state.
 */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return pushState();
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') {
    setNotifyPrefs({ push: false });
    return pushState();
  }
  const sub = await subscription(true);
  if (!sub) throw new Error('No service worker');
  await sendSubscription(sub);
  setNotifyPrefs({ push: true });
  return pushState();
}

export async function disablePush(): Promise<void> {
  setNotifyPrefs({ push: false });
  try {
    const reg = await swRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await api('DELETE', '/api/push/subscribe', { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe();
  } catch {
    /* already gone */
  }
}

/** Re-sends this device's subscription (after login, a language switch or a switch change). */
export async function syncPush(): Promise<void> {
  if (!pushSupported() || !getToken()) return;
  if (!prefs.push || Notification.permission !== 'granted') return;
  try {
    const sub = await subscription(true);
    if (sub) await sendSubscription(sub);
  } catch (err) {
    console.warn('push sync failed', err);
  }
}

/** Logging out: this device stops getting that account's notifications. Call before the token is cleared. */
export function forgetDevice(): void {
  if (!pushSupported() || !getToken()) return;
  void (async () => {
    const token = getToken();
    const reg = await swRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub || !token) return;
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
      keepalive: true,
    }).catch(() => undefined);
  })();
}

export async function sendTestNotification(): Promise<number> {
  const r = await api<{ sent: number }>('POST', '/api/push/test');
  return r.sent;
}

// ---------------------------------------------------------------- in-app alerts

let unseen = 0;
/** The room on screen (room.ts); returning to the tab clears that room's notifications. */
let activeRoom: string | null = null;

export function setActiveRoom(code: string | null): void {
  activeRoom = code;
}
let faviconLink: HTMLLinkElement | null = null;
let dotIcon: string | null = null;

function favicon(): HTMLLinkElement | null {
  faviconLink ??= document.querySelector('link[rel="icon"]');
  return faviconLink;
}

/** The favicon with a crimson dot, drawn once. */
async function dottedIcon(): Promise<string | null> {
  if (dotIcon) return dotIcon;
  const img = new Image();
  img.src = '/favicon.svg';
  try {
    await img.decode();
  } catch {
    return null;
  }
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  g.drawImage(img, 0, 0, 64, 64);
  g.beginPath();
  g.arc(48, 16, 13, 0, Math.PI * 2);
  g.fillStyle = '#0a0e15';
  g.fill();
  g.beginPath();
  g.arc(48, 16, 10, 0, Math.PI * 2);
  g.fillStyle = '#d0463c';
  g.fill();
  dotIcon = c.toDataURL('image/png');
  return dotIcon;
}

function paintBadge(): void {
  setTitleBadge(unseen);
  const link = favicon();
  if (!link) return;
  if (unseen === 0) {
    link.type = 'image/svg+xml';
    link.href = '/favicon.svg';
  } else {
    void dottedIcon().then((url) => {
      if (url && unseen > 0) {
        link.type = 'image/png';
        link.href = url;
      }
    });
  }
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (unseen > 0) nav.setAppBadge?.(unseen).catch(() => undefined);
  else nav.clearAppBadge?.().catch(() => undefined);
}

/**
 * Something happened that the player cares about. Visible tab: a sound. Hidden tab: one more
 * in the title badge (the system notification comes from the server's push).
 */
export function alert(kind: SoundKind): void {
  if (!prefs.cats[SOUND_CATEGORY[kind]]) return;
  if (document.visibilityState === 'visible') {
    if (prefs.sound) playSound(kind, prefs.volume);
  } else {
    unseen++;
    paintBadge();
  }
}

/** Plays a sound regardless of the switches (settings preview). */
export function previewSound(kind: SoundKind): void {
  playSound(kind, prefs.volume, true);
}

// ---------------------------------------------------------------- offer card bookkeeping

export function offerDismissed(): boolean {
  try {
    return localStorage.getItem(OFFER_KEY) === '1';
  } catch {
    return true;
  }
}

export function dismissOffer(): void {
  try {
    localStorage.setItem(OFFER_KEY, '1');
  } catch {
    /* storage blocked */
  }
}

// ---------------------------------------------------------------- startup

let started = false;

/** Once per page: audio unlock, service worker, badge reset on return, language follow-up. */
export function startNotifications(): void {
  if (started) return;
  started = true;
  installAudioUnlock();
  if (pushSupported()) void swRegistration();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && unseen > 0) {
      unseen = 0;
      paintBadge();
      // The notifications about the room now on screen are old news.
      const room = activeRoom;
      if (room) {
        void swRegistration().then(async (reg) => {
          for (const n of (await reg?.getNotifications()) ?? []) if ((n.data as { room?: string } | null)?.room === room) n.close();
        });
      }
    }
  });
  // The service worker writes notification text in the language saved with the subscription.
  onLang(() => void syncPush());
}
