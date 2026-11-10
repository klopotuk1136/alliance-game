import type { LogEntry } from '../../shared/protocol.ts';
import { fmtDate, fmtList, fmtTime, t } from './i18n.ts';

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
  if (d > 0) return `${t('unit.d', { n: d })} ${two(hh)}:${two(mm)}:${two(ss)}`;
  if (hh > 0) return `${two(hh)}:${two(mm)}:${two(ss)}`;
  return `${two(mm)}:${two(ss)}`;
}

export function clockTime(ts: number): string {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return fmtTime(ts, true);
  return `${fmtDate(ts)} ${fmtTime(ts)}`;
}

type NameFn = (pid: number | undefined) => string;

/** Text for one line of the player's own log. */
export function personalText(e: LogEntry, name: NameFn, myPid: number | null): string {
  const n = e.amount ?? 1;
  switch (e.type) {
    case 'start':
      return t('log.start');
    case 'attack':
      // With public attacks you also see other players' attacks (they carry the attacker).
      if (e.actor !== undefined && e.actor !== myPid) return t('log.attackOther', { actor: name(e.actor), target: name(e.target) });
      return t('log.attackYou', { target: name(e.target) });
    case 'hit':
      if (e.actor !== undefined) return t('log.hitBy', { actor: name(e.actor), n });
      return t('log.hit', { n });
    case 'grant':
      if (e.actor !== undefined && e.actor !== myPid) return t('log.grantOther', { actor: name(e.actor), n, target: name(e.target) });
      return t('log.grantYou', { n, target: name(e.target) });
    case 'granted':
      if (e.actor !== undefined) return t('log.grantedBy', { actor: name(e.actor), n });
      return t('log.granted', { n });
    case 'upgrade':
      return t('log.upgrade', { n: e.value ?? '?' });
    case 'eliminate': {
      const admin = e.actor === undefined;
      if (e.target === myPid) return admin ? t('log.elimYouAdmin') : t('log.elimYouBy', { by: name(e.actor) });
      if (e.actor === myPid) return t('log.elimByYou', { target: name(e.target) });
      return admin ? t('log.elimAdmin', { target: name(e.target) }) : t('log.elimBy', { target: name(e.target), by: name(e.actor) });
    }
    case 'tick':
      return t('log.tick', { n });
    case 'pause':
      return t('log.pause');
    case 'resume':
      return t('log.resume');
    case 'finish':
      if (e.pids) return t('log.finishPeace');
      return e.target === undefined ? t('log.finishOver') : e.target === myPid ? t('log.finishYou') : t('log.finishWon', { name: name(e.target) });
    case 'adjust':
      return t('log.adjust');
    case 'peace-propose':
      return e.actor === myPid ? t('log.proposeYou') : t('log.propose', { actor: name(e.actor) });
    case 'peace-sign':
      return e.actor === myPid ? t('log.signYou') : t('log.sign', { actor: name(e.actor) });
    case 'peace-decline':
      return e.actor === myPid ? t('log.declineYou') : t('log.decline', { actor: name(e.actor) });
    case 'peace-cancel':
      return t('log.cancel');
    // blitz
    case 'turn':
      return t('log.turn', { turn: e.value ?? '?', hits: t('blitz.sum.hits', { n: e.amount ?? 0 }), misses: t('blitz.sum.misses', { n: e.extra ?? 0 }) });
    case 'miss':
      return e.actor !== undefined && e.actor !== myPid ? t('log.missOther', { actor: name(e.actor) }) : t('log.missYou', { n });
    case 'gift-lost':
      return e.actor !== undefined && e.actor !== myPid ? t('log.giftLostOther', { actor: name(e.actor) }) : t('log.giftLostYou', { n });
    case 'charge':
      return e.actor === myPid ? t('log.chargeYou', { n: e.value ?? 1 }) : t('log.charge', { actor: name(e.actor), n: e.value ?? 1 });
    default:
      return e.type;
  }
}

/** Text for one line of the full history shown after the game ends. */
export function historyText(e: LogEntry, name: NameFn): string {
  const n = e.amount ?? 1;
  switch (e.type) {
    case 'attack':
      return t('log.h.attack', { actor: name(e.actor), target: name(e.target), n, left: e.value ?? '?' });
    case 'grant':
      return t('log.h.grant', { actor: name(e.actor), n, target: name(e.target) });
    case 'upgrade':
      return t('log.h.upgrade', { actor: name(e.actor), n: e.value ?? '?' });
    case 'eliminate':
      return e.actor === undefined ? t('log.h.elimAdmin', { target: name(e.target) }) : t('log.h.elim', { target: name(e.target), by: name(e.actor) });
    case 'adjust':
      return t('log.h.adjust', { target: name(e.target) });
    case 'finish':
      if (e.pids) return t('log.h.peace', { names: fmtList(e.pids.map((pid) => name(pid))) });
      return e.target === undefined ? t('log.h.over') : t('log.h.won', { name: name(e.target) });
    case 'peace-cancel':
      return e.actor !== undefined ? t('log.h.cancelBy', { actor: name(e.actor) }) : t('log.h.cancel');
    case 'peace-propose':
      return t('log.h.propose', { actor: name(e.actor) });
    case 'peace-sign':
      return t('log.h.sign', { actor: name(e.actor) });
    case 'peace-decline':
      return t('log.h.decline', { actor: name(e.actor) });
    case 'miss':
      return t('log.h.miss', { actor: name(e.actor), n });
    case 'gift-lost':
      return t('log.h.giftLost', { actor: name(e.actor), n });
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
    case 'peace-sign':
      return 'good';
    case 'peace-propose':
      return 'peace';
    case 'peace-decline':
    case 'peace-cancel':
      return 'bad';
    case 'turn':
      return 'turn';
    case 'charge':
      return 'charge';
    case 'finish':
    case 'start':
      return 'big';
    default:
      return '';
  }
}
