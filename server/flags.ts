// Country flags come from the flag-icons package (MIT). We serve its SVG files directly
// because flag emoji don't render on Windows.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { FlagInfo } from '../shared/protocol.ts';

const require = createRequire(import.meta.url);

/** Organisations rather than countries or regions. */
const EXCLUDED = new Set(['asean', 'cefta', 'eac', 'eu', 'arab', 'pc', 'un', 'xx']);

export const FLAGS_DIR = join(dirname(require.resolve('flag-icons/package.json')), 'flags');

interface CountryJson {
  code: string;
  name: string;
}

function loadFlags(): FlagInfo[] {
  const raw = JSON.parse(readFileSync(join(dirname(FLAGS_DIR), 'country.json'), 'utf8')) as CountryJson[];
  return raw
    .filter((c) => !EXCLUDED.has(c.code))
    .map((c) => ({ code: c.code, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const FLAGS: FlagInfo[] = loadFlags();
export const FLAG_CODES: Set<string> = new Set(FLAGS.map((f) => f.code));

export function flagName(code: string): string {
  return FLAGS.find((f) => f.code === code)?.name ?? code;
}
