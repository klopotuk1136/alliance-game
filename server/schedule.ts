// AP tick scheduling: either daily at a wall-clock time in a time zone (DST-aware),
// or every N seconds (test mode).

import type { GameSettings } from '../shared/settings.ts';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function wallClock(instant: number, zone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(instant))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Offset of `zone` from UTC at `instant`, in ms (e.g. +3600000 for CET). */
function zoneOffset(instant: number, zone: string): number {
  const w = wallClock(instant, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - (instant - (((instant % 1000) + 1000) % 1000));
}

/** The UTC instant at which the clock in `zone` shows the given wall time. Day overflow is allowed. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = guess - zoneOffset(guess, zone);
  const second = guess - zoneOffset(first, zone);
  return second;
}

export function nextDailyTick(after: number, tickTime: string, zone: string): number {
  const [hh, mm] = tickTime.split(':').map(Number);
  const today = wallClock(after, zone);
  for (let i = 0; i <= 2; i++) {
    const t = zonedTimeToUtc(today.year, today.month, today.day + i, hh, mm, zone);
    if (t > after) return t;
  }
  // Unreachable in practice; fall back to 24h later.
  return after + 24 * 3600 * 1000;
}

/** The first scheduled tick strictly after `after`. */
export function nextTickAfter(settings: GameSettings, after: number): number {
  if (settings.tickMode === 'interval') return after + settings.tickIntervalSec * 1000;
  return nextDailyTick(after, settings.tickTime, settings.timezone);
}
