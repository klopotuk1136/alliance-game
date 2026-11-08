import { clearToken } from './api.ts';

let router: () => void = () => undefined;

export function setRouter(fn: () => void): void {
  router = fn;
}

export function navigate(path: string): void {
  if (location.pathname !== path) history.pushState(null, '', path);
  router();
}

/** Logs this tab out (other tabs keep their own login). */
export function logout(): void {
  clearToken();
  router();
}
