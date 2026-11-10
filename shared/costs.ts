// Action prices, shared by the server (which charges them) and the browser (which shows
// them). With escalation on for an action, the nth use of that action within one AP
// period costs base × n (1×, 2×, 3× …). Every AP tick starts a new period: the counters
// go back to zero.

import type { GameSettings } from './settings.ts';

export type CostKind = 'move' | 'attack' | 'grant' | 'upgrade';

export const COST_KINDS: readonly CostKind[] = ['move', 'attack', 'grant', 'upgrade'];

/** How many times a player used each action since the last AP tick. */
export type ActionCounts = Record<CostKind, number>;

export function emptyCounts(): ActionCounts {
  return { move: 0, attack: 0, grant: 0, upgrade: 0 };
}

/** Reads stored counters defensively (old rows have none). */
export function normalizeCounts(raw: unknown): ActionCounts {
  const out = emptyCounts();
  if (raw && typeof raw === 'object') {
    for (const k of COST_KINDS) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v;
    }
  }
  return out;
}

export function baseCost(s: GameSettings, kind: CostKind): number {
  switch (kind) {
    case 'move':
      return s.costMove;
    case 'attack':
      return s.costAttack;
    case 'grant':
      return s.costGrant;
    case 'upgrade':
      return s.costUpgrade;
  }
}

export function escalates(s: GameSettings, kind: CostKind): boolean {
  switch (kind) {
    case 'move':
      return s.escalateMove === 'on';
    case 'attack':
      return s.escalateAttack === 'on';
    case 'grant':
      return s.escalateGrant === 'on';
    case 'upgrade':
      return s.escalateUpgrade === 'on';
  }
}

/** Price of the next use of `kind`, after `used` uses in this AP period. */
export function actionCost(s: GameSettings, kind: CostKind, used = 0): number {
  const base = baseCost(s, kind);
  return escalates(s, kind) ? base * (Math.max(0, used) + 1) : base;
}

/** Price of the use after the next one (for the "next: 3" hint); equals actionCost when flat. */
export function nextActionCost(s: GameSettings, kind: CostKind, used = 0): number {
  return actionCost(s, kind, used + 1);
}
