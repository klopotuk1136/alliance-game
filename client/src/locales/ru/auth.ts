import type { Translation } from '../types.ts';
import type { auth as EN } from '../en/auth.ts';

export const auth: Translation<typeof EN> = {
  'auth.logIn': 'Войти',
  'auth.createAccount': 'Создать аккаунт',
  'auth.registerHint': 'Имя: 3–20 латинских букв, цифр, _ . -   Пароль: не короче 6 символов.',
  'auth.username': 'Имя пользователя',
  'auth.password': 'Пароль',
  'auth.tagline1': 'Заключайте союзы. Предавайте друзей.',
  'auth.tagline2': 'Останьтесь последней страной на карте.',
  'auth.invitation': 'Приглашение',
  'auth.inviteText': 'Войдите или создайте аккаунт, чтобы открыть комнату, куда вас пригласили.',
  'auth.account': 'Аккаунт',
  'auth.foot': 'Дипломатия и предательство на гексагональной карте',
};
