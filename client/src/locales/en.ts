// The English dictionary: the source of truth for keys. Each area lives in ./en/<area>.ts;
// ./ru/<area>.ts must provide exactly the same keys (typecheck fails otherwise).
import { auth } from './en/auth.ts';
import { board } from './en/board.ts';
import { chat } from './en/chat.ts';
import { common } from './en/common.ts';
import { errors } from './en/errors.ts';
import { game } from './en/game.ts';
import { home } from './en/home.ts';
import { log } from './en/log.ts';
import { lobby } from './en/lobby.ts';
import { plan } from './en/plan.ts';
import { profile } from './en/profile.ts';
import { settings } from './en/settings.ts';
import { notify } from './en/notify.ts';
import { blitz } from './en/blitz.ts';

export type { Msg } from './types.ts';

export const en = { ...common, ...errors, ...auth, ...home, ...lobby, ...settings, ...profile, ...game, ...log, ...board, ...chat, ...plan, ...notify, ...blitz };

export type Key = keyof typeof en;
