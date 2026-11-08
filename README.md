# Alliance

A small browser game for a group of friends. Every player is a country on a hexagonal map.
You talk, form alliances, betray each other, and spend action points to move, attack,
help allies or extend your reach. The last country standing wins.

## Run it

Everything runs in Docker, both locally and on a server.

```bash
docker compose up -d --build
```

Then open <http://localhost:8080>. Data lives in the `alliance-data` Docker volume, so
restarting or rebuilding the container loses nothing.

### Test mode

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build
```

In test mode new rooms give AP every **30 seconds** and their lobby lasts 10 minutes. A
separate database file is used, so test games don't mix with real ones. To change other
defaults, add `--set key=value` flags to the command in `docker-compose.test.yml`
(for example `"--set", "tickIntervalSec=10"`).

**Playing as several players on one machine:** each browser tab keeps its own login. Open
a new window, click **Log out** there, and log in (or sign up) as another player. The
other windows stay logged in as before. `sh scripts/seed-test-users.sh` creates four test
accounts (alice, bob, carol, dave; the password is in the script).

The admin tool speeds up testing: `alliance player-set <room> <nick> ap=10` gives a player
AP, and `alliance start <room>` skips the lobby.

To wipe all test data: `docker compose down`, then `docker volume rm alliance-game_alliance-data`
(this deletes the real-game database too, since both files live in that volume).

## How a game works

1. Someone signs up, creates a room and shares its link (`/r/<code>`).
2. Friends open the link, log in or create an account, and join. In the lobby everyone
   picks a nickname and a country flag.
3. While the room is in the lobby, its creator can change the game settings in the
   **Game settings** card: room size, map size, starting HP/AP/range, the AP schedule
   (daily at a time in a time zone, or every N minutes), AP costs and effects, and the
   lobby length. Everyone else sees the settings read-only and gets a notice when they
   change. The server refuses combinations that can't work, such as a map too small for
   the room.
4. The game starts automatically when the lobby time runs out (24 hours by default), or
   earlier when the creator presses **Start**. Nobody can join after that, and the
   settings are fixed (only the admin tool can still change them).
5. Players spawn at random, at least `range + 1` cells apart (out of everyone's range).
6. With the default settings, every living player gets 1 AP every day at 20:00 Central
   European time.
7. The last player alive wins. The winner screen reveals everything: final stats and who
   attacked or helped whom.

With the default settings:

| Action        | Key | Cost | What it does                                  |
| ------------- | --- | ---- | --------------------------------------------- |
| Move          | 1   | 1 AP | Step to a free neighbouring cell              |
| Attack        | 2   | 1 AP | 1 damage to a player within your range        |
| Give AP       | 3   | 1 AP | Another player within your range gets 1 AP    |
| Range +1      | 4   | 2 AP | Your attack range grows by 1                  |

On a computer, point at a cell and press the key. Actions fire instantly. On a phone, tap
a cell, then tap an action button.

**What you see:** everyone's position, and your own HP, AP and range. You never see other
players' stats. When you're hit you lose HP but don't learn who did it. AP you receive is
anonymous too. Eliminations are public, including who dealt the final hit.

## Admin command-line tool

Run admin commands inside the container:

```bash
docker compose exec game alliance help
```

| Command | What it does |
| --- | --- |
| `alliance status` | Rooms and users at a glance |
| `alliance room <code>` | Full room state, including hidden stats |
| `alliance log <code> [n]` | Full event history of a room |
| `alliance users` | List accounts |
| `alliance user-create <user> <password>` | Create an account |
| `alliance user-passwd <user> <password>` | Reset a password |
| `alliance user-delete <user>` | Delete an account |
| `alliance room-create <name> --owner <user>` | Create a room for someone |
| `alliance room-delete <code>` | Delete a room |
| `alliance start <code>` | Start a lobby now |
| `alliance pause <code>` / `resume <code>` | Pause or resume a game |
| `alliance reset <code>` | Back to the lobby; keeps players, wipes the game |
| `alliance tick <code>` | Give everyone AP right now |
| `alliance set <code> key=value ...` | Change one room's settings |
| `alliance player-set <code> <nick> hp=N ap=N range=N` | Edit a player's stats (testing) |
| `alliance defaults` | Default settings for new rooms, with explanations |
| `alliance defaults-set key=value ...` | Change the defaults |

The admin tool only works from inside the container. It is not reachable through the web
port.

### Settings

Every room copies the defaults when it is created. The creator can change them in the
lobby; the admin can change any room at any time with
`alliance set <code> key=value`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `gridRadius` | 6 | Map radius (6 = 127 cells, fine for ~10 players). Only in the lobby |
| `maxPlayers` | 10 | Players per room |
| `startHp` / `startAp` / `startRange` | 3 / 0 / 2 | Starting stats |
| `minSpawnDistance` | 0 | Min distance between spawns; 0 = startRange + 1 |
| `costMove` / `costAttack` / `costGrant` / `costUpgrade` | 1 / 1 / 1 / 2 | AP costs |
| `attackDamage` / `grantAmount` / `upgradeAmount` | 1 / 1 / 1 | Effect sizes |
| `apPerTick` | 1 | AP each living player gets per tick |
| `tickMode` | daily | `daily` (at `tickTime`) or `interval` (every `tickIntervalSec`) |
| `tickTime` / `timezone` | 20:00 / Europe/Berlin | Daily tick time; follows summer time |
| `tickIntervalSec` | 30 | Seconds between ticks in interval mode |
| `lobbyDurationSec` | 86400 | Lobby length before the automatic start |

Server startup flags (`node server/main.ts --help`): `--port`, `--db`, `--test-mode`,
`--set key=value` (defaults for new rooms), `--admin-socket`, `--static`.

### Rules for edge cases

- Actions are handled one at a time, in the order the server receives them. Each is
  checked against the current state.
- If the server is down at 20:00, the missed daily AP is given when it comes back. In
  interval (test) mode, missed ticks are skipped.
- While a game is paused, nobody can act and no AP is given. Missed ticks are skipped.
- If the lobby time runs out with fewer than 2 players, the room waits for its creator to
  start it.

## Development without Docker

Needs Node.js 24 or newer.

```bash
npm install
npm test            # unit tests, including the "no hidden stats leak" test
npm run typecheck
npm run build       # builds the browser client into dist/client
npm run start:test  # server on :8080 in test mode
npm run admin -- status
```

For hot reload of the browser code, run `npm run dev:client` next to the server and open
<http://localhost:5173>.

## Project layout

```
shared/   hex math, settings, message types (used by server and browser)
server/   engine.ts (rules), room.ts (lobby, game, timers), views.ts (what each player
          may see), db.ts (SQLite), http.ts, ws.ts, admin.ts + cli.ts (admin tool)
client/   browser code: lobby, map (SVG), game screen
```

Built with Node's built-in SQLite and TypeScript support, `ws` for WebSockets, Vite for
the browser bundle, and country flags from
[flag-icons](https://github.com/lipis/flag-icons) (MIT).
