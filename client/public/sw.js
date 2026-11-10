// Alliance service worker: shows push notifications (server/push.ts) and opens the room on
// click. It caches nothing — the game needs the network anyway.
//
// A push carries { kind, params, room, roomName, tag, url, lang, ts } (shared/push.ts); the text
// is written here, in the language the player chose when turning notifications on.

const RU_FORMS = new Intl.PluralRules('ru');
const ru = (n, one, few, many) => {
  const f = RU_FORMS.select(n);
  return f === 'one' ? one : f === 'few' ? few : many;
};
const quote = (s, lang) => (lang === 'ru' ? `«${s}»` : `“${s}”`);

const TEXTS = {
  en: {
    chat: (p) => {
      const what = p.sticker ? 'sent a sticker' : null;
      if (p.where === 'dm') return what ? `${p.from} (private) ${what}` : `${p.from} (private): ${p.text}`;
      if (p.where === 'group') return what ? `${p.from} in ${p.group} ${what}` : `${p.from} in ${p.group}: ${p.text}`;
      return what ? `${p.from} ${what}` : `${p.from}: ${p.text}`;
    },
    chatMany: (p) => (p.from ? `${p.n} new messages, the latest from ${p.from}` : `${p.n} new messages`),
    hit: (p) => (p.by ? `${p.by} attacked you: −${p.n} HP` : `You were attacked: −${p.n} HP`),
    granted: (p) => (p.by ? `${p.by} gave you +${p.n} AP` : `You received +${p.n} AP`),
    eliminated: (p) => (p.by ? `You were eliminated by ${p.by}` : 'You were eliminated'),
    tick: (p) => `+${p.n} AP — your move`,
    start: () => 'The game has started. Your move!',
    soon: (p) => `The game starts in ${p.min} min`,
    end: (p) =>
      p.result === 'won' ? 'You won the game!' : p.result === 'peace' ? 'Peace is signed — a shared victory' : p.winner ? `${p.winner} won the game` : 'The game is over',
    peace: (p) => `${p.by} proposes peace`,
    blitzTurn: (p) => `Turn ${p.turn} — give your orders`,
    blitzHurry: () => '10 seconds left in this turn — confirm your orders',
    test: () => 'Notifications work. See you at the table.',
  },
  ru: {
    chat: (p) => {
      const text = p.sticker ? 'стикер' : p.text;
      if (p.where === 'dm') return `${p.from} (лично): ${text}`;
      if (p.where === 'group') return `${p.from} в ${quote(p.group, 'ru')}: ${text}`;
      return `${p.from}: ${text}`;
    },
    chatMany: (p) => {
      const n = `${p.n} ${ru(p.n, 'новое сообщение', 'новых сообщения', 'новых сообщений')}`;
      return p.from ? `${n}, последнее — от ${p.from}` : n;
    },
    hit: (p) => (p.by ? `Атака от ${p.by}: −${p.n} ОЗ` : `Вас атаковали: −${p.n} ОЗ`),
    granted: (p) => (p.by ? `Подарок от ${p.by}: +${p.n} ОД` : `Вам передали +${p.n} ОД`),
    eliminated: (p) => (p.by ? `Вы выбыли из партии. Последний удар — ${p.by}` : 'Вы выбыли из партии'),
    tick: (p) => `+${p.n} ОД — ваш ход`,
    start: () => 'Партия началась. Ваш ход!',
    soon: (p) => `Партия начнётся через ${p.min} мин`,
    end: (p) =>
      p.result === 'won' ? 'Вы победили!' : p.result === 'peace' ? 'Мир подписан — общая победа' : p.winner ? `Победитель — ${p.winner}` : 'Партия окончена',
    peace: (p) => `${p.by} предлагает мир`,
    blitzTurn: (p) => `Раунд ${p.turn} — отдайте приказы`,
    blitzHurry: () => 'До конца раунда 10 секунд — подтвердите приказы',
    test: () => 'Уведомления работают. До встречи за столом.',
  },
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  event.waitUntil(show(data));
});

async function show(data) {
  const lang = data && data.lang === 'ru' ? 'ru' : 'en';
  const texts = TEXTS[lang];
  const kind = data && texts[data.kind] ? data.kind : 'test';
  const params = (data && data.params) || {};
  const roomName = data && data.roomName;
  const body = texts[kind](params, roomName);
  const urgent = kind === 'hit' || kind === 'eliminated' || kind === 'blitzHurry' || kind === 'soon';
  await self.registration.showNotification(roomName || 'Alliance', {
    body,
    tag: (data && data.tag) || kind,
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    lang,
    timestamp: (data && data.ts) || Date.now(),
    requireInteraction: kind === 'blitzHurry',
    vibrate: urgent ? [120, 60, 120] : [60],
    data: { url: (data && data.url) || '/', room: data && data.room },
  });
  if (self.navigator && 'setAppBadge' in self.navigator) {
    const open = await self.registration.getNotifications();
    self.navigator.setAppBadge(open.length).catch(() => undefined);
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(focusOrOpen(url));
});

async function focusOrOpen(url) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // The room already open somewhere: bring that tab forward.
  const same = windows.find((w) => w.url.split('#')[0].replace(/\/$/, '') === url.replace(/\/$/, ''));
  if (same) return same.focus();
  // Any Alliance tab: send it to the room (the app routes client-side).
  const any = windows.find((w) => new URL(w.url).origin === self.location.origin);
  if (any) {
    try {
      const nav = await any.navigate(url);
      return (nav || any).focus();
    } catch {
      // navigate() refused (uncontrolled tab): open a new one below
    }
  }
  return self.clients.openWindow(url);
}

self.addEventListener('notificationclose', () => {
  if (self.navigator && 'setAppBadge' in self.navigator) {
    self.registration.getNotifications().then((open) => self.navigator.setAppBadge(open.length).catch(() => undefined));
  }
});
