// Per-room game settings. Every room copies the server defaults when it is created;
// the admin CLI can change both the defaults and any single room's settings.

export type TickMode = 'daily' | 'interval';

export interface GameSettings {
  /** Radius of the hexagonal grid (6 => 127 cells). */
  gridRadius: number;
  /** Maximum number of players that can join a room's lobby. */
  maxPlayers: number;
  startHp: number;
  startAp: number;
  startRange: number;
  /** Minimum hex distance between spawn points. 0 = automatic (startRange + 1). */
  minSpawnDistance: number;
  costMove: number;
  costAttack: number;
  costGrant: number;
  costUpgrade: number;
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
}

export const DEFAULT_SETTINGS: GameSettings = {
  gridRadius: 6,
  maxPlayers: 10,
  startHp: 3,
  startAp: 0,
  startRange: 2,
  minSpawnDistance: 0,
  costMove: 1,
  costAttack: 1,
  costGrant: 1,
  costUpgrade: 2,
  attackDamage: 1,
  grantAmount: 1,
  upgradeAmount: 1,
  apPerTick: 1,
  tickMode: 'daily',
  tickTime: '20:00',
  timezone: 'Europe/Berlin',
  tickIntervalSec: 30,
  lobbyDurationSec: 24 * 60 * 60,
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
  gridRadius: { kind: 'int', min: 2, max: 30, help: 'grid radius in cells' },
  maxPlayers: { kind: 'int', min: 2, max: 100, help: 'max players per room' },
  startHp: { kind: 'int', min: 1, max: 1000, help: 'starting HP' },
  startAp: { kind: 'int', min: 0, max: 1000, help: 'starting AP' },
  startRange: { kind: 'int', min: 1, max: 100, help: 'starting attack distance' },
  minSpawnDistance: { kind: 'int', min: 0, max: 100, help: 'min distance between spawns (0 = startRange + 1)' },
  costMove: { kind: 'int', min: 0, max: 100, help: 'AP cost of moving 1 cell' },
  costAttack: { kind: 'int', min: 0, max: 100, help: 'AP cost of an attack' },
  costGrant: { kind: 'int', min: 0, max: 100, help: 'AP cost of granting AP' },
  costUpgrade: { kind: 'int', min: 0, max: 100, help: 'AP cost of a range upgrade' },
  attackDamage: { kind: 'int', min: 1, max: 100, help: 'damage per attack' },
  grantAmount: { kind: 'int', min: 1, max: 100, help: 'AP received by the target of a grant' },
  upgradeAmount: { kind: 'int', min: 1, max: 100, help: 'range gained per upgrade' },
  apPerTick: { kind: 'int', min: 0, max: 1000, help: 'AP given to every alive player per tick' },
  tickMode: { kind: 'enum', values: ['daily', 'interval'], help: 'daily (at tickTime) or interval (every tickIntervalSec)' },
  tickTime: { kind: 'time', help: 'daily tick time, HH:MM' },
  timezone: { kind: 'zone', help: 'IANA time zone for tickTime, e.g. Europe/Berlin' },
  tickIntervalSec: { kind: 'int', min: 1, max: 7 * 24 * 3600, help: 'seconds between ticks in interval mode' },
  lobbyDurationSec: { kind: 'int', min: 10, max: 30 * 24 * 3600, help: 'lobby length in seconds before auto-start' },
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
