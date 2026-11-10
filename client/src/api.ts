// HTTP API helpers and login token storage.
//
// The token lives in sessionStorage (one per tab) so that several browser windows on the
// same machine can be logged in as different players. A copy in localStorage lets a
// freshly opened tab start out logged in as the last account used.

import type { ErrorInfo } from '../../shared/errors.ts';
import type { FlagInfo, MeResponse } from '../../shared/protocol.ts';
import { errorText } from './errors.ts';

const SESSION_KEY = 'alliance.token';
const LAST_KEY = 'alliance.lastToken';

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function getToken(): string | null {
  let token = safe(() => sessionStorage.getItem(SESSION_KEY), null);
  if (!token) {
    token = safe(() => localStorage.getItem(LAST_KEY), null);
    if (token) safe(() => sessionStorage.setItem(SESSION_KEY, token!), undefined);
  }
  return token;
}

export function setToken(token: string): void {
  safe(() => sessionStorage.setItem(SESSION_KEY, token), undefined);
  safe(() => localStorage.setItem(LAST_KEY, token), undefined);
}

export function clearToken(): void {
  const token = safe(() => sessionStorage.getItem(SESSION_KEY), null);
  safe(() => sessionStorage.removeItem(SESSION_KEY), undefined);
  if (token && safe(() => localStorage.getItem(LAST_KEY), null) === token) {
    safe(() => localStorage.removeItem(LAST_KEY), undefined);
  }
}

export class ApiError extends Error {
  readonly status: number;
  /** The server's English message; `message` is it in the current language. */
  readonly english: string;
  readonly info: ErrorInfo;
  constructor(status: number, message: string, info: ErrorInfo = {}) {
    super(message);
    this.status = status;
    this.english = message;
    this.info = info;
    Object.defineProperty(this, 'message', { get: () => errorText(this.english, this.info), configurable: true });
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const binary = body instanceof Blob;
  if (body !== undefined) headers['Content-Type'] = binary ? body.type || 'application/octet-stream' : 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "Can't reach the server");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string } & ErrorInfo;
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, { code: data.code, params: data.params });
  return data as T;
}

/** The account and its profile (`profile` is missing only on an older server). */
export function fetchMe(): Promise<MeResponse> {
  return api<MeResponse>('GET', '/api/me');
}

let flagsPromise: Promise<FlagInfo[]> | null = null;

export function fetchFlags(): Promise<FlagInfo[]> {
  flagsPromise ??= api<FlagInfo[]>('GET', '/api/flags').catch((err) => {
    flagsPromise = null;
    throw err;
  });
  return flagsPromise;
}
