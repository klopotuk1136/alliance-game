// English error texts are the server's own templates (shared/errors.ts).
import { ERROR_TEMPLATES, type ErrorCode } from '../../../../shared/errors.ts';

export const errors = Object.fromEntries(Object.entries(ERROR_TEMPLATES).map(([code, tpl]) => [`err.${code}`, tpl])) as Record<`err.${ErrorCode}`, string>;
