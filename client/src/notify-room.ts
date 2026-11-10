// Which moments in a room deserve a sound (visible tab) or a title badge (hidden tab):
// incoming chat, being hit, AP, start/end, peace proposals. See notify.ts.

import type { ChatMessage, LogEntry, RoomView, UserInfo } from '../../shared/protocol.ts';
import { alert } from './notify.ts';
import type { SoundKind } from './notify-sound.ts';

export { setActiveRoom } from './notify.ts';

function myPid(state: RoomView, user: UserInfo): number | null {
  return state.me?.pid ?? state.players.find((p) => p.username === user.username)?.pid ?? null;
}

/** New chat lines (not the history on connect). */
export function alertsForChat(messages: ChatMessage[], state: RoomView, user: UserInfo): void {
  if (!state.participant) return;
  const me = myPid(state, user);
  let kind: SoundKind | null = null;
  for (const m of messages) {
    if (m.from === me || m.sys) continue;
    // A private or group message outranks the room-wide chat.
    if (m.to !== null || m.group !== undefined) kind = 'dm';
    else kind ??= 'chat';
  }
  if (kind) alert(kind);
}

const PRIORITY: SoundKind[] = ['fall', 'hit', 'start', 'peace', 'ap'];

/** New log entries: the most important one of a batch makes the sound. */
export function alertsForEntries(entries: LogEntry[], state: RoomView, user: UserInfo): void {
  if (!state.participant) return;
  const me = myPid(state, user);
  const kinds = new Set<SoundKind>();
  for (const e of entries) {
    switch (e.type) {
      case 'hit':
        kinds.add('hit');
        break;
      case 'eliminate':
        if (e.target === me) kinds.add('fall');
        break;
      case 'granted':
      case 'tick':
        kinds.add('ap');
        break;
      case 'start':
      case 'finish':
        kinds.add('start');
        break;
      case 'peace-propose':
        if (e.actor !== me) kinds.add('peace');
        break;
      default:
        break;
    }
  }
  const kind = PRIORITY.find((k) => kinds.has(k));
  if (kind) alert(kind);
}
