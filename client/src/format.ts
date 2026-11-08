import type { LogEntry } from '../../shared/protocol.ts';

export function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** "3d 04:12:09", "04:12:09" or "12:09". */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(total / 86400);
  const hh = Math.floor((total % 86400) / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  if (d > 0) return `${d}d ${two(hh)}:${two(mm)}:${two(ss)}`;
  if (hh > 0) return `${two(hh)}:${two(mm)}:${two(ss)}`;
  return `${two(mm)}:${two(ss)}`;
}

export function clockTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `${time}:${two(d.getSeconds())}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

type NameFn = (pid: number | undefined) => string;

/** Text for one line of the player's own log. */
export function personalText(e: LogEntry, name: NameFn, myPid: number | null): string {
  switch (e.type) {
    case 'start':
      return 'The game has started. Good luck!';
    case 'attack':
      return `You attacked ${name(e.target)}.`;
    case 'hit':
      return `You were hit! −${e.amount ?? 1} HP`;
    case 'grant':
      return `You gave ${e.amount ?? 1} AP to ${name(e.target)}.`;
    case 'granted':
      return `Someone gave you ${e.amount ?? 1} AP.`;
    case 'upgrade':
      return `Your attack range is now ${e.value}.`;
    case 'eliminate': {
      const by = e.actor === undefined ? 'the admin' : e.actor === myPid ? 'you' : name(e.actor);
      if (e.target === myPid) return `You were eliminated by ${by}.`;
      if (e.actor === myPid) return `You eliminated ${name(e.target)}!`;
      return `${name(e.target)} was eliminated by ${by}.`;
    }
    case 'tick':
      return `Everyone received ${e.amount ?? 1} AP.`;
    case 'pause':
      return 'The game was paused.';
    case 'resume':
      return 'The game was resumed.';
    case 'finish':
      return e.target === undefined ? 'The game is over.' : e.target === myPid ? 'You won the game!' : `${name(e.target)} won the game!`;
    case 'adjust':
      return 'An admin changed your stats.';
    default:
      return e.type;
  }
}

/** Text for one line of the full history shown after the game ends. */
export function historyText(e: LogEntry, name: NameFn): string {
  switch (e.type) {
    case 'attack':
      return `${name(e.actor)} attacked ${name(e.target)} (−${e.amount ?? 1} HP, ${e.value ?? '?'} left)`;
    case 'grant':
      return `${name(e.actor)} gave ${e.amount ?? 1} AP to ${name(e.target)}`;
    case 'upgrade':
      return `${name(e.actor)} upgraded range to ${e.value}`;
    case 'eliminate':
      return `${name(e.target)} was eliminated by ${e.actor === undefined ? 'the admin' : name(e.actor)}`;
    case 'adjust':
      return `Admin changed ${name(e.target)}'s stats`;
    case 'finish':
      return e.target === undefined ? 'Game over' : `${name(e.target)} won`;
    default:
      return personalText(e, name, null);
  }
}

export function logKind(e: LogEntry): string {
  switch (e.type) {
    case 'hit':
    case 'eliminate':
      return 'bad';
    case 'granted':
    case 'tick':
      return 'good';
    case 'finish':
    case 'start':
      return 'big';
    default:
      return '';
  }
}
