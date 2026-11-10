// Ratings: multiplayer Elo by final placement. Every pair of players in a finished game is
// one comparison (better place = win, same place = draw), and each player's change is the
// sum over their pairs scaled by K / (n − 1), so a 10-player game moves ratings about as
// much as a duel. Everyone starts at 1000. Pure functions; db.ts stores the results.

import type { PlayerState } from './engine.ts';

export const START_RATING = 1000;
export const ELO_K = 32;

export interface Standing {
  pid: number;
  /** 1 = best. Equal places are draws. */
  place: number;
}

/** Expected score of a player rated `a` against one rated `b`. */
export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

/** Rating change per pid for one finished game. `ratings` holds everyone's rating before it. */
export function eloChanges(standings: Standing[], ratings: Map<number, number>, k = ELO_K): Map<number, number> {
  const out = new Map<number, number>();
  const n = standings.length;
  if (n < 2) {
    for (const s of standings) out.set(s.pid, 0);
    return out;
  }
  for (const me of standings) {
    const mine = ratings.get(me.pid) ?? START_RATING;
    let sum = 0;
    for (const other of standings) {
      if (other.pid === me.pid) continue;
      const score = me.place < other.place ? 1 : me.place === other.place ? 0.5 : 0;
      sum += score - expectedScore(mine, ratings.get(other.pid) ?? START_RATING);
    }
    out.set(me.pid, (k / (n - 1)) * sum);
  }
  return out;
}

/**
 * Final places: survivors share 1st (the winner, or every peace signer); eliminated players
 * follow, later elimination = better place. Players eliminated at the same moment tie.
 */
export function placements(players: Iterable<PlayerState>): Standing[] {
  const list = [...players];
  const alive = list.filter((p) => p.alive);
  const out: Standing[] = alive.map((p) => ({ pid: p.pid, place: 1 }));
  const out_ = list.filter((p) => !p.alive).sort((a, b) => (b.eliminatedAt ?? 0) - (a.eliminatedAt ?? 0));
  let place = alive.length + 1;
  out_.forEach((p, i) => {
    if (i > 0 && (out_[i - 1].eliminatedAt ?? 0) !== (p.eliminatedAt ?? 0)) place = alive.length + 1 + i;
    out.push({ pid: p.pid, place });
  });
  return out;
}

/** Win points of one game: 1 for a sole survivor, 1/n each when n survivors signed peace. */
export function winPoints(standings: Standing[]): Map<number, number> {
  const firsts = standings.filter((s) => s.place === 1).length;
  return new Map(standings.map((s) => [s.pid, s.place === 1 && firsts > 0 ? 1 / firsts : 0]));
}
