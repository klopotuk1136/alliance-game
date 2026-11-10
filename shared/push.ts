// Push notifications: what the server sends to a browser's service worker (client/public/sw.js)
// and the HTTP shapes around subscribing. The server sends a kind + params; the service worker
// writes the text in the subscriber's language (stored with the subscription).

/** Every kind of notification. The service worker has a text for each (sw.js TEXTS). */
export type PushKind =
  /** One chat message: params from, text (or sticker=1), where = 'all' | 'dm' | 'group', group (name). */
  | 'chat'
  /** Several chat messages in one room within the batching window: params n. */
  | 'chatMany'
  /** You were attacked: params n (damage), by (attacker's nickname, only when attacks are public). */
  | 'hit'
  /** Someone gave you AP: params n, by (only when gifts are public). */
  | 'granted'
  /** You were eliminated: params by (when known). */
  | 'eliminated'
  /** AP tick: params n. */
  | 'tick'
  /** The game started. */
  | 'start'
  /** The lobby starts in about params.min minutes. */
  | 'soon'
  /** The game ended: params result = 'won' | 'peace' | 'lost', winner (nickname) when someone won. */
  | 'end'
  /** A peace proposal: params by. */
  | 'peace'
  /** Blitz: a new turn began: params turn. (Sent by the blitz engine through PushService.notify.) */
  | 'blitzTurn'
  /** Blitz: 10 seconds left and you haven't confirmed your orders. */
  | 'blitzHurry'
  /** The "Test notification" button. */
  | 'test';

/** The four switches in the notification settings. */
export type PushCategory = 'chat' | 'attacks' | 'ap' | 'game';
export const PUSH_CATEGORIES: PushCategory[] = ['chat', 'attacks', 'ap', 'game'];

export const KIND_CATEGORY: Record<PushKind, PushCategory | null> = {
  chat: 'chat',
  chatMany: 'chat',
  hit: 'attacks',
  eliminated: 'attacks',
  granted: 'ap',
  tick: 'ap',
  start: 'game',
  soon: 'game',
  end: 'game',
  peace: 'game',
  blitzTurn: 'game',
  blitzHurry: 'game',
  test: null,
};

export type PushPrefs = Record<PushCategory, boolean>;
export const DEFAULT_PUSH_PREFS: PushPrefs = { chat: true, attacks: true, ap: true, game: true };

export type PushLang = 'en' | 'ru';

/** The JSON a push message carries (the service worker reads it). */
export interface PushPayload {
  kind: PushKind;
  params: Record<string, string | number>;
  /** Room code and name, when the notification is about a room. */
  room?: string;
  roomName?: string;
  /** Notifications with the same tag replace each other (one per room for chat). */
  tag: string;
  /** Page opened on click. */
  url: string;
  lang: PushLang;
  ts: number;
}

/** A browser PushSubscription as JSON (PushSubscription.toJSON()). */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** POST /api/push/subscribe body. */
export interface PushSubscribeRequest {
  subscription: PushSubscriptionJson;
  lang: PushLang;
  prefs: Partial<PushPrefs>;
}

export function normalizePrefs(raw: unknown): PushPrefs {
  const out: PushPrefs = { ...DEFAULT_PUSH_PREFS };
  if (raw && typeof raw === 'object') {
    for (const c of PUSH_CATEGORIES) {
      const v = (raw as Record<string, unknown>)[c];
      if (typeof v === 'boolean') out[c] = v;
    }
  }
  return out;
}
