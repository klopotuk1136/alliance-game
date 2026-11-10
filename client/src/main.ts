import '@fontsource-variable/inter';
import '@fontsource-variable/fraunces';
import './style.css';
import { setTitle, T } from './i18n.ts';
import { ApiError, clearToken, fetchMe, getToken } from './api.ts';
import { showAuth } from './auth.ts';
import { closeTransient, h, replaceChildren } from './dom.ts';
import { showHome } from './home.ts';
import { showLeaderboard } from './leaderboard.ts';
import { setRouter } from './nav.ts';
import { setMyProfile } from './profile.ts';
import { showRoom } from './room.ts';
import { startNotifications, syncPush } from './notify.ts';

const app = document.getElementById('app')!;
startNotifications();
let pushSynced = false;
let cleanup: (() => void) | null = null;
let generation = 0;

async function route(): Promise<void> {
  const gen = ++generation;
  // A popover, menu or sheet never outlives its screen.
  closeTransient();
  cleanup?.();
  cleanup = null;
  const roomMatch = /^\/r\/([a-z0-9]+)\/?$/i.exec(location.pathname);
  if (!getToken()) {
    setTitle('app.title');
    cleanup = showAuth(app, () => void route(), roomMatch ? roomMatch[1].toLowerCase() : null);
    return;
  }
  let user;
  try {
    const me = await fetchMe();
    user = me.user;
    setMyProfile(me.profile, me.user);
  } catch (err) {
    if (gen !== generation) return;
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      void route();
      return;
    }
    replaceChildren(app, h('div', { class: 'loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), T('app.cantReach')));
    setTimeout(() => {
      if (gen === generation) void route();
    }, 3000);
    return;
  }
  if (gen !== generation) return;
  // Once per page after login: re-send this device's push subscription (keys, language, switches).
  if (!pushSynced) {
    pushSynced = true;
    void syncPush();
  }
  if (!roomMatch) setTitle(/^\/leaderboard\/?$/.test(location.pathname) ? 'app.titleLeaderboard' : 'app.title');
  cleanup = roomMatch
    ? showRoom(app, roomMatch[1].toLowerCase(), user)
    : /^\/leaderboard\/?$/.test(location.pathname)
      ? showLeaderboard(app, user)
      : showHome(app, user);
}

setRouter(() => void route());
window.addEventListener('popstate', () => void route());
void route();
