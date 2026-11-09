import '@fontsource-variable/inter';
import '@fontsource-variable/fraunces';
import './style.css';
import { ApiError, clearToken, fetchMe, getToken } from './api.ts';
import { showAuth } from './auth.ts';
import { h, replaceChildren } from './dom.ts';
import { showHome } from './home.ts';
import { setRouter } from './nav.ts';
import { setMyProfile } from './profile.ts';
import { showRoom } from './room.ts';

const app = document.getElementById('app')!;
let cleanup: (() => void) | null = null;
let generation = 0;

async function route(): Promise<void> {
  const gen = ++generation;
  cleanup?.();
  cleanup = null;
  const roomMatch = /^\/r\/([a-z0-9]+)\/?$/i.exec(location.pathname);
  if (!getToken()) {
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
    replaceChildren(app, h('div', { class: 'loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), "Can't reach the server. Retrying…"));
    setTimeout(() => {
      if (gen === generation) void route();
    }, 3000);
    return;
  }
  if (gen !== generation) return;
  cleanup = roomMatch ? showRoom(app, roomMatch[1].toLowerCase(), user) : showHome(app, user);
}

setRouter(() => void route());
window.addEventListener('popstate', () => void route());
void route();
