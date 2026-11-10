// Per-room game settings. Every room copies the server defaults when it is created;
// the admin CLI can change both the defaults and any single room's settings.

export type TickMode = 'daily' | 'interval';
/** 'random' = anywhere, at least minSpawnDistance apart; 'equidistant' = evenly around one ring. */
export type SpawnMode = 'random' | 'equidistant';
/** Who learns who attacked (and gave AP to) whom while the game runs. */
export type RevealMode = 'hidden' | 'attacks' | 'all';
export type OnOff = 'on' | 'off';
/** How the lobby deadline is set: a length from when it opened, or an exact moment. */
export type LobbyMode = 'duration' | 'time';
/** The furthest ahead an exact lobby start may be. */
export const LOBBY_MAX_AHEAD_MS = 30 * 24 * 3600 * 1000;
/** An exact lobby start must be at least this far in the future. */
export const LOBBY_MIN_AHEAD_MS = 60 * 1000;
/** classic = real-time actions with AP ticks; blitz = simultaneous turns with secret orders (server/blitz.ts). */
export type GameMode = 'classic' | 'blitz';

export interface GameSettings {
  /** classic (actions at once, AP on a schedule) or blitz (everyone plans orders, turns resolve together). */
  mode: GameMode;
  /** Radius of the hexagonal grid (6 => 127 cells). */
  gridRadius: number;
  /** Maximum number of players that can join a room's lobby. */
  maxPlayers: number;
  startHp: number;
  startAp: number;
  startRange: number;
  /** Minimum hex distance between spawn points. 0 = automatic (startRange + 1). */
  minSpawnDistance: number;
  spawnMode: SpawnMode;
  /** hidden = only the attacker knows; attacks = every attack names its attacker to everyone; all = gifts too. */
  revealActions: RevealMode;
  costMove: number;
  costAttack: number;
  costGrant: number;
  costUpgrade: number;
  /** Escalating prices: the nth use of the action between two AP ticks costs cost × n. */
  escalateMove: OnOff;
  escalateAttack: OnOff;
  escalateGrant: OnOff;
  escalateUpgrade: OnOff;
  attackDamage: number;
  grantAmount: number;
  upgradeAmount: number;
  /** AP given to every alive player on each tick. */
  apPerTick: number;
  /** 'daily' = once a day at tickTime in timezone; 'interval' = every tickIntervalSec seconds. */
  tickMode: TickMode;
  /** HH:MM, 24h clock, in `timezone`. */
  tickTime: string;
  /** IANA time zone name. Europe/Berlin follows CET/CEST. */
  timezone: string;
  tickIntervalSec: number;
  /** How long the lobby stays open before the game starts automatically. */
  lobbyDurationSec: number;
  /** 'duration' = the lobby ends lobbyDurationSec after it opened; 'time' = at an exact moment set by the creator. */
  lobbyMode: LobbyMode;
  /** IANA time zone the creator picked the exact start time in (shown next to the viewer's local time). */
  lobbyZone: string;
  /** Blitz: planning time per turn (a turn also ends once every alive player confirmed). */
  blitzTurnSec: number;
  /** Blitz: AP every alive player gets at the start of each turn. */
  blitzApPerTurn: number;
  /** Blitz: AP cost of one Charge order (+1 damage to your next attack). */
  costCharge: number;
  /** Blitz: the most charge a player can hold (0 = no charging). */
  blitzChargeCap: number;
  /** Blitz: the most orders one player can queue per turn. */
  blitzMaxOrders: number;
}

export const DEFAULT_SETTINGS: GameSettings = {
  mode: 'classic',
  gridRadius: 6,
  maxPlayers: 10,
  startHp: 3,
  startAp: 0,
  startRange: 2,
  minSpawnDistance: 0,
  spawnMode: 'random',
  revealActions: 'hidden',
  costMove: 1,
  costAttack: 1,
  costGrant: 1,
  costUpgrade: 2,
  escalateMove: 'off',
  escalateAttack: 'on',
  escalateGrant: 'on',
  escalateUpgrade: 'off',
  attackDamage: 1,
  grantAmount: 1,
  upgradeAmount: 1,
  apPerTick: 1,
  tickMode: 'daily',
  tickTime: '20:00',
  timezone: 'Europe/Berlin',
  tickIntervalSec: 30,
  lobbyDurationSec: 24 * 60 * 60,
  lobbyMode: 'duration',
  lobbyZone: 'Europe/Berlin',
  blitzTurnSec: 60,
  blitzApPerTurn: 2,
  costCharge: 1,
  blitzChargeCap: 3,
  blitzMaxOrders: 4,
};

/** Settings applied on top of the defaults by `--test-mode`. */
export const TEST_MODE_SETTINGS: Partial<GameSettings> = {
  tickMode: 'interval',
  tickIntervalSec: 30,
  lobbyDurationSec: 10 * 60,
};

interface IntRule {
  kind: 'int';
  min: number;
  max: number;
  help: string;
}
interface EnumRule {
  kind: 'enum';
  values: string[];
  help: string;
}
interface TimeRule {
  kind: 'time';
  help: string;
}
interface ZoneRule {
  kind: 'zone';
  help: string;
}
type Rule = IntRule | EnumRule | TimeRule | ZoneRule;

export const SETTING_RULES: Record<keyof GameSettings, Rule> = {
  mode: { kind: 'enum', values: ['classic', 'blitz'], help: 'classic (act any time, AP on a schedule) or blitz (simultaneous turns: secret orders, resolved together)' },
  gridRadius: { kind: 'int', min: 2, max: 30, help: 'grid radius in cells' },
  maxPlayers: { kind: 'int', min: 2, max: 100, help: 'max players per room' },
  startHp: { kind: 'int', min: 1, max: 1000, help: 'starting HP' },
  startAp: { kind: 'int', min: 0, max: 1000, help: 'starting AP' },
  startRange: { kind: 'int', min: 1, max: 100, help: 'starting attack distance' },
  minSpawnDistance: { kind: 'int', min: 0, max: 100, help: 'min distance between spawns (0 = startRange + 1)' },
  spawnMode: { kind: 'enum', values: ['random', 'equidistant'], help: 'random spots, or everyone evenly around one ring (same distance from the centre)' },
  revealActions: { kind: 'enum', values: ['hidden', 'attacks', 'all'], help: 'hidden (victims never learn who hit them), attacks (everyone sees who attacks whom), all (attacks and AP gifts)' },
  costMove: { kind: 'int', min: 0, max: 100, help: 'AP cost of moving 1 cell' },
  costAttack: { kind: 'int', min: 0, max: 100, help: 'AP cost of an attack' },
  costGrant: { kind: 'int', min: 0, max: 100, help: 'AP cost of granting AP' },
  costUpgrade: { kind: 'int', min: 0, max: 100, help: 'AP cost of a range upgrade' },
  escalateMove: { kind: 'enum', values: ['on', 'off'], help: 'on = the nth move between two AP ticks costs costMove × n' },
  escalateAttack: { kind: 'enum', values: ['on', 'off'], help: 'on = the nth attack between two AP ticks costs costAttack × n' },
  escalateGrant: { kind: 'enum', values: ['on', 'off'], help: 'on = the nth AP gift between two AP ticks costs costGrant × n' },
  escalateUpgrade: { kind: 'enum', values: ['on', 'off'], help: 'on = the nth range upgrade between two AP ticks costs costUpgrade × n' },
  attackDamage: { kind: 'int', min: 1, max: 100, help: 'damage per attack' },
  grantAmount: { kind: 'int', min: 1, max: 100, help: 'AP received by the target of a grant' },
  upgradeAmount: { kind: 'int', min: 1, max: 100, help: 'range gained per upgrade' },
  apPerTick: { kind: 'int', min: 0, max: 1000, help: 'AP given to every alive player per tick' },
  tickMode: { kind: 'enum', values: ['daily', 'interval'], help: 'daily (at tickTime) or interval (every tickIntervalSec)' },
  tickTime: { kind: 'time', help: 'daily tick time, HH:MM' },
  timezone: { kind: 'zone', help: 'IANA time zone for tickTime, e.g. Europe/Berlin' },
  tickIntervalSec: { kind: 'int', min: 1, max: 7 * 24 * 3600, help: 'seconds between ticks in interval mode' },
  lobbyDurationSec: { kind: 'int', min: 10, max: 30 * 24 * 3600, help: 'lobby length in seconds before auto-start' },
  lobbyMode: { kind: 'enum', values: ['duration', 'time'], help: 'duration (lobbyDurationSec after opening) or time (an exact start moment set by the creator)' },
  lobbyZone: { kind: 'zone', help: 'IANA time zone of the exact start time, e.g. Europe/Moscow' },
  blitzTurnSec: { kind: 'int', min: 20, max: 600, help: 'blitz: seconds to plan each turn (ends early when everyone confirmed)' },
  blitzApPerTurn: { kind: 'int', min: 0, max: 100, help: 'blitz: AP every alive player gets at the start of each turn' },
  costCharge: { kind: 'int', min: 0, max: 100, help: 'blitz: AP cost of a Charge (+1 damage to your next attack)' },
  blitzChargeCap: { kind: 'int', min: 0, max: 10, help: 'blitz: the most charge a player can hold (0 = no charging)' },
  blitzMaxOrders: { kind: 'int', min: 1, max: 10, help: 'blitz: the most orders a player can queue per turn' },
};

export const SETTING_KEYS = Object.keys(SETTING_RULES) as Array<keyof GameSettings>;

export function isSettingKey(key: string): key is keyof GameSettings {
  return Object.prototype.hasOwnProperty.call(SETTING_RULES, key);
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Parses and validates one setting value. Throws an Error with a readable message. */
export function parseSettingValue(key: string, raw: string | number): string | number {
  if (!isSettingKey(key)) {
    throw new Error(`Unknown setting "${key}". Known settings: ${SETTING_KEYS.join(', ')}`);
  }
  const rule = SETTING_RULES[key];
  const text = String(raw).trim();
  switch (rule.kind) {
    case 'int': {
      if (!/^-?\d+$/.test(text)) throw new Error(`${key} must be a whole number`);
      const n = Number(text);
      if (n < rule.min || n > rule.max) throw new Error(`${key} must be between ${rule.min} and ${rule.max}`);
      return n;
    }
    case 'enum':
      if (!rule.values.includes(text)) throw new Error(`${key} must be one of: ${rule.values.join(', ')}`);
      return text;
    case 'time': {
      const m = /^(\d{1,2}):(\d{2})$/.exec(text);
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`${key} must look like HH:MM (24h)`);
      return `${m[1].padStart(2, '0')}:${m[2]}`;
    }
    case 'zone':
      if (!isValidTimeZone(text)) throw new Error(`${key}: unknown time zone "${text}"`);
      return text;
  }
}

/** Applies "key=value" style overrides to a settings object, validating each one. */
export function applySettingOverrides(base: GameSettings, overrides: Record<string, string | number>): GameSettings {
  const next: Record<string, unknown> = { ...base };
  for (const [key, raw] of Object.entries(overrides)) {
    next[key] = parseSettingValue(key, raw);
  }
  return next as unknown as GameSettings;
}

/** Fills missing keys from defaults and drops unknown keys (used when loading stored JSON). */
export function normalizeSettings(stored: unknown): GameSettings {
  const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === 'object') {
    for (const key of SETTING_KEYS) {
      const value = (stored as Record<string, unknown>)[key];
      if (value === undefined) continue;
      try {
        result[key] = parseSettingValue(key, value as string | number);
      } catch {
        // keep default for invalid stored values
      }
    }
  }
  return result as unknown as GameSettings;
}

export function effectiveSpawnDistance(s: GameSettings): number {
  return s.minSpawnDistance > 0 ? s.minSpawnDistance : s.startRange + 1;
}
