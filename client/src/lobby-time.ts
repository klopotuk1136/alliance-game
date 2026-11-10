// The lobby's exact start time: wall-clock date/time in a chosen time zone <-> an instant, and
// "Starts at 21:00 UTC+3 (22:00 your time)" text. Mirrors server/schedule.ts (DST-aware).

import type { GameSettings } from '../../shared/settings.ts';
import { locale, t } from './i18n.ts';

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function parts(instant: number, zone: string): Record<string, number> {
  const out: Record<string, number> = {};
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  for (const p of f.formatToParts(new Date(instant))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  if (out.hour === 24) out.hour = 0;
  return out;
}

function offset(instant: number, zone: string): number {
  const w = parts(instant, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - (instant - (((instant % 1000) + 1000) % 1000));
}

/** "2026-11-12" + "21:00" in `zone` -> ms since epoch (NaN when the input is incomplete). */
export function zonedToInstant(date: string, time: string, zone: string): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!d || !tm) return NaN;
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(tm[1]), Number(tm[2]), 0);
  try {
    const first = guess - offset(guess, zone);
    return guess - offset(first, zone);
  } catch {
    return NaN;
  }
}

const two = (n: number): string => String(n).padStart(2, '0');

/** ms -> { date: "2026-11-12", time: "21:00" } on the clock of `zone`. */
export function instantToZoned(instant: number, zone: string): { date: string; time: string } {
  try {
    const w = parts(instant, zone);
    return { date: `${w.year}-${two(w.month)}-${two(w.day)}`, time: `${two(w.hour)}:${two(w.minute)}` };
  } catch {
    return { date: '', time: '' };
  }
}

/** "UTC+3", "UTC−5:30", "UTC" at that moment. */
export function zoneOffsetLabel(instant: number, zone: string): string {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date(instant)).find((p) => p.type === 'timeZoneName')?.value ?? '';
    return name === 'GMT' ? 'UTC' : name.replace('GMT', 'UTC').replace('-', '−');
  } catch {
    return zone;
  }
}

/** "21:00" or "21:00, 12 Nov" (the date when it isn't today on that clock). */
export function clockAt(instant: number, zone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(zone ? { timeZone: zone } : {}) };
  const time = new Intl.DateTimeFormat(locale(), opts).format(instant);
  const day = (ms: number): string => new Intl.DateTimeFormat('en-CA', { ...(zone ? { timeZone: zone } : {}), year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  if (day(instant) === day(Date.now())) return time;
  const date = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', ...(zone ? { timeZone: zone } : {}) }).format(instant);
  return `${time}, ${date}`;
}

/**
 * "Starts at 21:00 UTC+3 (22:00 your time)." for an exact start in another zone, or
 * "Starts at 22:00." when the viewer's clock says the same (or the lobby counts a length).
 */
export function startAtText(endsAt: number, rules: GameSettings): string {
  const local = clockAt(endsAt);
  if (rules.lobbyMode !== 'time') return t('lobby.startAt', { time: local });
  const there = clockAt(endsAt, rules.lobbyZone);
  const sameClock = there === local && zoneOffsetLabel(endsAt, rules.lobbyZone) === zoneOffsetLabel(endsAt, browserZone());
  if (sameClock) return t('lobby.startAt', { time: local });
  return t('lobby.startAtBoth', { time: `${there} ${zoneOffsetLabel(endsAt, rules.lobbyZone)}`, local });
}
