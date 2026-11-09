// Profile field rules shared by the server (which enforces them) and the browser (which
// checks as you type). The username is the login and never changes; everything here is
// optional decoration on top of it.

export const DISPLAY_NAME_MAX = 24;
export const BIO_MAX = 300;
/** Avatars are cropped to a square of this size in the browser before upload. */
export const AVATAR_SIZE = 256;
export const AVATAR_MAX_BYTES = 300 * 1024;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Control/format characters and line/paragraph separators (bidi overrides included). */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Display name: trimmed, single-spaced, 1–24 characters; empty means "use the username". */
export function parseDisplayName(raw: unknown): Parsed<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Display name must be text' };
  const s = raw.normalize('NFC').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  if (!s) return { ok: true, value: null };
  if ([...s].length > DISPLAY_NAME_MAX) return { ok: false, error: `Display name is too long (max ${DISPLAY_NAME_MAX} characters)` };
  return { ok: true, value: s };
}

/** Bio: up to 300 characters, line breaks kept (at most one empty line in a row). */
export function parseBio(raw: unknown): Parsed<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Bio must be text' };
  const s = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[ ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!s) return { ok: true, value: null };
  if ([...s].length > BIO_MAX) return { ok: false, error: `Bio is too long (max ${BIO_MAX} characters)` };
  return { ok: true, value: s };
}

/**
 * Telegram: accepts "@handle", "handle", "t.me/handle", "https://t.me/handle" (also
 * telegram.me), stores the bare handle. Telegram usernames are 5–32 characters of
 * letters, digits and underscores, start with a letter and don't end with an underscore.
 */
export function parseTelegram(raw: unknown): Parsed<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Telegram must be text' };
  let s = raw.trim();
  if (!s) return { ok: true, value: null };
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const link = /^(?:t\.me|telegram\.me|telegram\.dog)\/(.*)$/i.exec(s);
  if (link) s = link[1].replace(/[/?#].*$/, '');
  s = s.replace(/^@/, '');
  if (!s) return { ok: false, error: 'Enter your Telegram username' };
  if (!/^[A-Za-z0-9_]+$/.test(s)) return { ok: false, error: 'Telegram usernames use only letters, digits and _' };
  if (s.length < 5) return { ok: false, error: 'Telegram usernames are at least 5 characters' };
  if (s.length > 32) return { ok: false, error: 'Telegram usernames are at most 32 characters' };
  if (!/^[A-Za-z]/.test(s)) return { ok: false, error: 'Telegram usernames start with a letter' };
  if (s.endsWith('_')) return { ok: false, error: "Telegram usernames can't end with _" };
  return { ok: true, value: s };
}

export function telegramUrl(handle: string): string {
  return `https://t.me/${encodeURIComponent(handle)}`;
}
