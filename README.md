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

The interface speaks English and Russian: the EN / RU switch in the top bar (or the account menu on phones) changes it on the fly; the first visit follows the browser language.

1. Someone signs up, creates a room and shares its link (`/r/<code>`).
2. Friends open the link, log in or create an account, and join. In the lobby everyone
   picks a nickname and a country flag.
3. While the room is in the lobby, its creator can change the game settings in the
   **Game settings** card: room size, map size, spawn mode, secrecy, starting HP/AP/range,
   the AP schedule (daily at a time in a time zone, or every N minutes), AP costs, rising
   prices and effects, and the lobby length. Everyone else sees the settings read-only and
   gets a notice when they change. The server refuses combinations that can't work, such as
   a map too small for the room.
4. The game starts automatically when the lobby time runs out (24 hours by default), or
   earlier when the creator presses **Start**. If the creator still has unsaved changes in
   the settings form, Start saves them first (and doesn't start if they are refused).
   Nobody can join after that, and the settings are fixed (only the admin tool can still
   change them).
5. Players spawn at random, at least `range + 1` cells apart (out of everyone's range). With
   **Spawn: Even ring** everyone starts at the same distance from the centre, evenly spread
   around one ring (about two thirds of the way to the edge, or further in if the spacing
   needs it); who gets which seat is random.
6. With the default settings, every living player gets 1 AP every day at 20:00 Central
   European time.
7. The last player alive wins, or everyone alive signs **peace** (below) and they all share
   the victory. The end screen reveals everything: final stats, who attacked or helped
   whom, and each player's rating change.

With the default settings:

| Action        | Key | Cost | What it does                                  |
| ------------- | --- | ---- | --------------------------------------------- |
| Move          | 1   | 1 AP | Step to a free neighbouring cell              |
| Attack        | 2   | 1 AP | 1 damage to a player within your range        |
| Give AP       | 3   | 1 AP | Another player within your range gets 1 AP    |
| Range +1      | 4   | 2 AP | Your attack range grows by 1                  |

**Rising prices:** by default attacks and AP gifts get more expensive the more you use them
between two AP deliveries: the 1st attack costs 1 AP, the 2nd 2 AP, the 3rd 3 AP, and so on
(cost × n). Every AP delivery resets the counters. Moves and range upgrades keep a fixed
price. Each action can be switched between fixed and rising in the settings. The action
buttons show the current price and the next one ("2 AP · next 3").

**Peace:** any player still on the map can propose peace (proposing signs it). It passes
when every player still alive has signed: the game ends and they all share the victory.
Anyone can decline (which cancels it), and any attack by anyone while a proposal is open
cancels it too (everyone sees "an attack broke the peace talks", not who attacked).

**Rating:** every finished game outside test mode changes ratings (Elo, everyone starts at
1000). Places: the winner (or every peace signer) is 1st, the others by elimination order,
later is better. Each pair of players counts as one duel (better place wins, same place is
a draw) with K = 32 / (players − 1). Win points: 1 for a win, 1/n each for a peace among n
players. See the **Leaderboard** (top bar, or `/leaderboard`); your rating is on your
profile.

On a computer, point at a cell and press the key. Actions fire instantly. On a phone, tap
a cell, then tap an action button.

**Chat:** everyone in the room shares the **Everyone** channel, and you can open a private
conversation with any player (the **Private message…** menu). Private messages are only
ever sent to their two players; the reveal at the end of the game does not include them.
Chat works in the lobby, during the game (also once you're eliminated) and after it.

**What you see:** everyone's position, and your own HP, AP and range. You never see other
players' stats. When you're hit you lose HP but don't learn who did it (the shot comes from
beyond the edge of the map). AP you receive is anonymous too. Eliminations are public,
including who dealt the final hit. The **Secrecy** setting can change this: *Attacks
public* names every attacker to everyone as it happens, *Attacks + gifts* does the same for
AP gifts.

## Blitz mode

The room's creator can switch **Mode** from *Classic* to *Blitz* in the lobby. Classic is
everything above: act whenever you like, AP arrives on a schedule. Blitz is played in
**turns where everyone moves at the same time**:

1. **Planning.** A big clock counts down the turn (60 seconds by default; the creator can
   set 20 s – 10 min). Everyone queues secret **orders**: *Move* to a neighbouring cell,
   *Strike* a **cell** within range, *Give AP* to a cell, *Range +1* and *Charge*. The
   planner shows your AP left and refuses what the server would refuse. Your orders are
   drawn on the board as ghosts (a path for the move, a target ring with the damage for a
   strike, a green arc for a gift). Nobody else sees them — they only see *that* you
   confirmed (the seals under the planner).
2. **Confirm.** The turn ends early once every player still alive has confirmed. You can
   change your mind until then (*Change orders*). When the clock runs out, every queued
   order runs whether you confirmed it or not; no orders = do nothing.
3. **Resolution**, always in this order:
   1. *Range +1* (it already counts for this turn's strikes);
   2. **moves, all at once.** Two players stepping into the same cell both bounce back;
      two players swapping cells both bounce back; stepping into a cell whose occupant
      stays (or bounces) bounces you back; stepping into a cell someone else is leaving is
      fine. Bounces can chain;
   3. **strikes hit the cell, after the moves**: whoever stands there takes the damage, an
      empty cell is a miss. So aim where your target *will be*. Several strikes on one
      cell add up. A strike never hurts its own shooter;
   4. AP gifts land on whoever stands on the cell after the moves (lost on an empty cell or
      on a player eliminated this turn);
   5. charges bank;
   6. eliminations all at once, then the win check. If the last players knock each other
      out in the same turn, nobody wins (a draw; for the rating they share the place).
4. **Replay.** The board plays the turn back: pieces hop together (bounces push back),
   strikes fly to their cells (hits explode, misses puff on the empty tile), gifts float
   over, charges glow, the fallen topple. The *Turn N* card explains it in words and can
   replay it. Then the next planning phase starts (the clock waits for the replay).

**Charge:** an order costing `costCharge` AP (1). Each charge adds +1 damage to your **next**
strike, up to `blitzChargeCap` (+3). Charges bank at the end of the turn, so they power
the following turns' strikes, not this one's. Your first strike of a turn spends the whole
charge, **even if it misses**. Everyone sees everyone's charge (a glowing piece with a ϟ+N
badge), so a target knows a heavy blow is coming and can try to dodge.

**AP and prices:** every alive player gets `blitzApPerTurn` (2) AP at the start of each
turn; unspent AP carries over. Rising prices work per turn (the counters reset each turn).
AP is paid when the turn resolves, in the order of your queue. At most one move and
`blitzMaxOrders` (4) orders per turn. Ranges are measured from where you stand when the
turn begins.

**What you see:** moves and the cells strikes landed on are public (they are on the board).
Who fired, and how hard, follows the *Secrecy* setting: hidden by default (shots come from
beyond the map's edge), except for the shooter and the victim, who learn the damage.
Gifts are seen by giver and receiver only (everyone with *Attacks + gifts*). The end screen
reveals everything. Peace, chat, group chats, plans and ratings work as in classic; any
strike fired while peace talks are open tears them up.

On a computer: point at a cell and press 1–5 (5 = Charge), right-click a cell for the menu,
double-click to move there, Enter to confirm. On a phone: tap a cell and an action, or
long-press a cell; the bar at the bottom shows the clock, your AP and orders (tap
*N orders* to open the list) and the Confirm button.

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
| `alliance chat <code> [n]` | Chat of a room, private messages included |
| `alliance users` | List accounts with rating, rated games and win points |
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
| `spawnMode` | random | `random`, or `equidistant` (everyone on one ring around the centre) |
| `revealActions` | hidden | `hidden`, `attacks` (everyone sees who attacks whom), `all` (gifts too) |
| `costMove` / `costAttack` / `costGrant` / `costUpgrade` | 1 / 1 / 1 / 2 | AP costs (base price) |
| `escalateMove` / `escalateAttack` / `escalateGrant` / `escalateUpgrade` | off / on / on / off | `on` = the nth use between two AP ticks costs cost × n |
| `attackDamage` / `grantAmount` / `upgradeAmount` | 1 / 1 / 1 | Effect sizes |
| `apPerTick` | 1 | AP each living player gets per tick |
| `tickMode` | daily | `daily` (at `tickTime`) or `interval` (every `tickIntervalSec`) |
| `tickTime` / `timezone` | 20:00 / Europe/Berlin | Daily tick time; follows summer time |
| `tickIntervalSec` | 30 | Seconds between ticks in interval mode |
| `lobbyDurationSec` | 86400 | Lobby length before the automatic start |
| `mode` | classic | `classic` or `blitz` (simultaneous turns). Only in the lobby |
| `blitzTurnSec` | 60 | Blitz: seconds to plan a turn (20–600); ends early when everyone confirmed |
| `blitzApPerTurn` | 2 | Blitz: AP every alive player gets each turn |
| `costCharge` / `blitzChargeCap` | 1 / 3 | Blitz: AP per Charge, and the most charge a player can hold (0 = off) |
| `blitzMaxOrders` | 4 | Blitz: orders per player per turn |

Server startup flags (`node server/main.ts --help`): `--port`, `--db`, `--test-mode`, `--trust-proxy`,
`--set key=value` (defaults for new rooms), `--admin-socket`, `--static`.

### Rules for edge cases

- Blitz: a paused game keeps the turn's remaining time (at least 10 s after resuming). An
  admin `tick` gives AP as usual. Turn state (queued orders, confirmations, charges, the last
  turn's report) is saved in the database, so a restart or a reconnect restores your orders
  and the clock.

- Actions are handled one at a time, in the order the server receives them. Each is
  checked against the current state.
- If the server is down at 20:00, the missed daily AP is given when it comes back. In
  interval (test) mode, missed ticks are skipped.
- While a game is paused, nobody can act and no AP is given. Missed ticks are skipped.
- If the lobby time runs out with fewer than 2 players, the room waits for its creator to
  start it.
- Rising-price counters reset on every AP delivery, including a manual `alliance tick`.
- If a player is eliminated while a peace proposal is open and everyone left has signed,
  the peace passes.
- Test-mode servers (`--test-mode`) never change ratings, and rooms created there stay
  unrated.

## Deploy to Railway

The repo is ready for [Railway](https://railway.com): `railway.json` tells it to build the
`Dockerfile` (tests run during the build) and to health-check `/api/flags`.

1. In Railway: **New Project → Deploy from GitHub repo**, pick this repository. Every push
   to `main` deploys again.
2. Open the service → **Settings → Volumes** (or right-click the service → *Attach volume*)
   and mount a volume at **`/data`**. The database lives there; without it every deploy
   starts from an empty database.
3. **Variables**: add `RAILWAY_RUN_UID=0`. Railway mounts volumes as root, and the
   container normally runs as the unprivileged `node` user, which then can't write the
   database.
4. **Settings → Networking → Generate Domain** to get a public `https://….up.railway.app`
   address. WebSockets work over it without extra setup.

Railway sets `PORT` itself, and the server detects it runs behind Railway's proxy, so the
login rate limit counts real client IPs. Keep a single replica: the game state lives in
one process and one SQLite file.

Admin commands run inside the container through the Railway CLI:

```bash
railway ssh            # in the linked project directory
alliance status
```

For a test deployment, set the start command (Settings → Deploy → Custom Start Command)
to `node server/main.ts --test-mode`.

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
server/   engine.ts (rules), blitz.ts (blitz turns), room.ts (lobby, game, timers), views.ts (what each player
          may see), db.ts (SQLite), http.ts, ws.ts, admin.ts + cli.ts (admin tool)
client/   browser code: lobby, map (SVG), game screen
```

Built with Node's built-in SQLite and TypeScript support, `ws` for WebSockets, Vite for
the browser bundle, and country flags from
[flag-icons](https://github.com/lipis/flag-icons) (MIT).
