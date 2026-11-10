// Server errors in the player's language: by the `code` the server sends next to its
// English message, or by matching the message against the shared templates (older
// servers, client-side checks). Anything unknown is shown as the English text.

import { errorInfo, type ErrorCode, type ErrorInfo } from '../../shared/errors.ts';
import { has, lang, t, type Params } from './i18n.ts';

export function errorText(message: string, info?: ErrorInfo | null): string {
  if (lang() === 'en') return message;
  let code: ErrorCode | undefined = info?.code;
  let params: Record<string, string> | undefined = info?.params;
  if (!code) {
    const found = errorInfo(message);
    if (!found) return message;
    code = found.code;
    params = found.params;
  }
  const key = `err.${code}`;
  if (!has(key)) return message;
  const p: Params = { ...params };
  // Settings errors name the setting by its key; show its label instead.
  if (typeof p.key === 'string') {
    const label = `set.${p.key}.label`;
    if (has(label)) p.key = t(label);
  }
  return t(key, p);
}
