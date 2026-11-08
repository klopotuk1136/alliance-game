import './style.css';
import { ApiError, clearToken, fetchMe, getToken } from './api.ts';
import { showAuth } from './auth.ts';
import { showHome } from './home.ts';
import { setRouter } from './nav.ts';
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
    user = await fetchMe();
  } catch (err) {
    if (gen !== generation) return;
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      void route();
      return;
    }
    app.textContent = "Can't reach the server. Retrying…";
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
