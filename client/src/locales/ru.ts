import type { Key, Msg } from './en.ts';
import { auth } from './ru/auth.ts';
import { board } from './ru/board.ts';
import { chat } from './ru/chat.ts';
import { common } from './ru/common.ts';
import { errors } from './ru/errors.ts';
import { game } from './ru/game.ts';
import { home } from './ru/home.ts';
import { log } from './ru/log.ts';
import { lobby } from './ru/lobby.ts';
import { plan } from './ru/plan.ts';
import { profile } from './ru/profile.ts';
import { settings } from './ru/settings.ts';
import { notify } from './ru/notify.ts';
import { blitz } from './ru/blitz.ts';

export const ru: Record<Key, Msg> = { ...common, ...errors, ...auth, ...home, ...lobby, ...settings, ...profile, ...game, ...log, ...board, ...chat, ...plan, ...notify, ...blitz };
