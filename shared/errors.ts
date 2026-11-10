// Stable codes for the errors a player can see. The server keeps writing plain English
// messages (tests, logs and old clients rely on them); at the boundary (HTTP JSON, WebSocket
// notices and action results) it adds `code` + `params` found by matching the message
// against these templates, so the client can show the error in the player's language.
// A message that matches nothing is sent as before and shown in English.

export const ERROR_TEMPLATES = {
  // auth
  usernameRequired: 'Username is required',
  usernameFormat: 'Username must be 3-20 characters: letters, digits, _ . -',
  passwordShort: 'Password must be at least 6 characters',
  passwordLong: 'Password is too long',
  usernameTaken: 'That username is taken',
  wrongLogin: 'Wrong username or password',
  pleaseLogIn: 'Please log in',
  pleaseLogInAgain: 'Please log in again',
  tooManyAttempts: 'Too many attempts, try again in a few minutes',
  tooManyChanges: 'Too many changes, try again in a few minutes',
  tooManyUploads: 'Too many uploads, try again in a few minutes',
  // generic
  serverError: 'Server error',
  notFound: 'Not found',
  requestTooLarge: 'Request too large',
  invalidJson: 'Invalid JSON',
  cantReachServer: "Can't reach the server",
  requestFailed: 'Request failed ({status})',
  // profile
  imageTooLarge: 'The image is too large (max {max} KB)',
  imageEmpty: 'The image is empty',
  imageType: 'Only PNG, JPEG or WebP images can be used',
  imageUnreadable: 'The image could not be read or has an unexpected size',
  noSuchUser: 'No such user',
  displayNameText: 'Display name must be text',
  displayNameLong: 'Display name is too long (max {max} characters)',
  bioText: 'Bio must be text',
  bioLong: 'Bio is too long (max {max} characters)',
  telegramText: 'Telegram must be text',
  telegramEmpty: 'Enter your Telegram username',
  telegramChars: 'Telegram usernames use only letters, digits and _',
  telegramShort: 'Telegram usernames are at least 5 characters',
  telegramLongName: 'Telegram usernames are at most 32 characters',
  telegramStart: 'Telegram usernames start with a letter',
  telegramEnd: "Telegram usernames can't end with _",
  // rooms + lobby
  roomNameRequired: 'Room name is required',
  roomNameLong: 'Room name is too long (max {max} characters)',
  noRoom: 'No room with code "{code}"',
  roomNotFound: 'Room not found',
  roomDeleted: 'This room was deleted',
  authTimeout: 'Authentication timed out',
  nicknameRequired: 'Nickname is required',
  nicknameEmpty: 'Nickname cannot be empty',
  nicknameLong: 'Nickname is too long (max {max} characters)',
  alreadyStartedNoJoin: 'This game has already started; no one new can join',
  roomFull: 'This room is full',
  leaveOnlyLobby: 'You can only leave while the room is in the lobby',
  creatorCantLeave: "The room's creator can't leave the lobby",
  onlyCreatorRemoves: 'Only the room creator can remove players',
  removeOnlyLobby: 'Players can only be removed in the lobby',
  noSuchPlayer: 'No such player',
  cantRemoveSelf: "You can't remove yourself",
  fixedAfterStart: 'Nickname and flag are fixed once the game starts',
  joinFirst: 'Join the room first',
  nicknameTaken: 'That nickname is taken in this room',
  unknownFlag: 'Unknown flag',
  flagTaken: 'That flag is taken by {name}',
  onlyCreatorStarts: 'Only the room creator can start the game',
  alreadyStarted: 'The game has already started',
  needTwoPlayers: 'At least 2 players are needed to start',
  cantPlaceRing: "Can't place {players} players evenly around a ring at least {dist} cells apart on a radius-{radius} grid; increase gridRadius",
  cantFitGrid: "Can't fit {players} players at least {dist} cells apart on a radius-{radius} grid; increase gridRadius",
  // settings
  onlyCreatorSettings: 'Only the room creator can change the game settings',
  settingsOnlyLobby: 'Game settings can only be changed in the lobby',
  noChanges: 'No changes to save',
  invalidValue: 'Invalid value for {key}',
  radiusOnlyLobby: 'gridRadius can only be changed while the room is in the lobby',
  maxBelowJoined: "{n} players have already joined, so max players can't be lower than that",
  cantSeatRing: "A radius-{radius} map can't seat {players} players evenly around a ring at least {dist} cells apart. Make the map bigger, the room smaller, or use random spawns.",
  cantFitMap: "A radius-{radius} map can't fit {players} players at least {dist} cells apart. Make the map bigger or the room smaller.",
  settingRange: '{key} must be between {min} and {max}',
  settingOneOf: '{key} must be one of: {values}',
  settingTime: '{key} must look like HH:MM (24h)',
  settingZone: '{key}: unknown time zone "{zone}"',
  unknownSetting: 'Unknown setting "{key}". Known settings: {keys}',
  lobbyEndPast: 'The start time must be in the future',
  lobbyEndFar: 'The start time can be at most 30 days ahead',
  // chat + groups + plan
  joinToChat: 'Join the room to chat',
  notInGroup: 'You are not in that group',
  notInChat: 'You are not in that chat',
  playerNotInRoom: 'That player is not in this room',
  cantMessageSelf: "You can't message yourself",
  stickerUnavailable: 'That sticker is not available',
  messageEmpty: 'Message is empty',
  messageLong: 'Message is too long (max {max} characters)',
  chatTooFast: 'You are sending messages too fast',
  pickPlayersToAdd: 'Pick the players to add',
  groupNameInvalid: 'That group name is not valid',
  groupNameLong: 'Group name is too long (max {max} characters)',
  groupTooSmall: 'A group needs at least two other players',
  tooManyGroups: 'This room has too many groups already',
  planEditInvalid: 'That plan edit is not valid',
  planTooFast: 'You are editing the plan too fast',
  planFull: 'The plan is full (max {max} marks). Erase some first.',
  cellOffMap: 'That cell is not on the map',
  arrowSameCell: 'An arrow needs two different cells',
  noteEmpty: 'A note needs some text',
  noteLong: 'A note can be at most {max} characters',
  pieceNotOnPlan: 'That piece is not on the plan',
  // game + actions + peace
  notStarted: "The game hasn't started yet",
  paused: 'The game is paused',
  gameOver: 'The game is over',
  notInGame: 'You are not in this game',
  eliminated: 'You have been eliminated',
  unknownAction: 'Unknown action',
  pickCell: 'Pick a cell to move to',
  offMap: "You can't move off the map",
  neighbourOnly: 'You can only move to a neighbouring cell',
  cellOccupied: 'That cell is occupied',
  notEnoughAp: 'Not enough AP (need {cost}, you have {have})',
  pickTarget: 'Pick a player to target',
  cantTargetSelf: "You can't target yourself",
  targetNotOnMap: 'That player is not on the map',
  outOfRange: 'Out of range (your range is {range})',
  peaceAliveOnly: 'Only players still on the map can sign peace',
  peaceOpen: 'A peace proposal is already open: sign or decline it',
  peaceNoneToSign: 'There is no peace proposal to sign',
  peaceSigned: 'You have already signed',
  peaceNoneToDecline: 'There is no peace proposal to decline',
  peaceUnknown: 'Unknown peace action',
  statsOnlyGame: 'Stats can only be changed during a game',
  playerEliminated: '{name} has been eliminated',
  // blitz
  blitzUseOrders: 'This game is played in turns: queue orders instead',
  notBlitz: 'This is not a blitz game',
  ordersList: 'Orders must be a list',
  tooManyOrders: 'Too many orders (max {max} per turn)',
  unknownOrder: 'Unknown order',
  oneMove: 'Only one move per turn',
  ownCell: "You can't target your own cell",
  chargeOff: 'Charging is off in this game',
  chargeCap: 'Charge is capped at +{max}',
  modeLobbyOnly: 'The game mode can only be changed while the room is in the lobby',
  turnOver: 'That turn is already over',
} as const;

export type ErrorCode = keyof typeof ERROR_TEMPLATES;
export type ErrorParams = Record<string, string>;

/** Fields the server adds next to an English error message. */
export interface ErrorInfo {
  code?: ErrorCode;
  params?: ErrorParams;
}

interface Matcher {
  code: ErrorCode;
  re: RegExp;
  names: string[];
}

let matchers: Matcher[] | null = null;

function build(): Matcher[] {
  return (Object.entries(ERROR_TEMPLATES) as Array<[ErrorCode, string]>).map(([code, tpl]) => {
    const names: string[] = [];
    const src = tpl
      .split(/(\{\w+\})/)
      .map((part) => {
        const m = /^\{(\w+)\}$/.exec(part);
        if (m) {
          names.push(m[1]);
          return '(.+?)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('');
    return { code, re: new RegExp(`^${src}$`, 's'), names };
  });
}

/** The code and parameters of a known English error message, or null. */
export function errorInfo(message: string): { code: ErrorCode; params: ErrorParams } | null {
  matchers ??= build();
  for (const m of matchers) {
    const hit = m.re.exec(message);
    if (!hit) continue;
    const params: ErrorParams = {};
    m.names.forEach((name, i) => (params[name] = hit[i + 1]));
    return { code: m.code, params };
  }
  return null;
}

/** `{ code, params }` to spread next to a message (empty when it is not a known one). */
export function errorFields(message: string): ErrorInfo {
  const info = errorInfo(message);
  return info ? { code: info.code, ...(Object.keys(info.params).length ? { params: info.params } : {}) } : {};
}
