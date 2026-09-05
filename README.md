# LAN Party

Browser party games for everyone on the same Wi-Fi. One person runs the server, everyone else opens a URL.
Ships with **Frostline Kart**, a snowy kart racer with items, CPU karts and up to 8 players, **Dodgeball 3v3**,
a top-down gym dodgeball match where friends pick a side (or join the host's) and CPU bodies fill the rest,
**Fable Theft Auto 5.1**, a voxel crime sandbox where up to 8 players share one procedurally generated city, and
**Crossy Farm Car**, a hop-across-the-farm race where up to 8 cars dodge the same herds until the last one is flattened.

## Run

```bash
npm install
npm start
```

The server prints the addresses it is reachable on, for example:

```
LAN party server running with 4 game(s): Frostline Kart, Dodgeball 3v3, Fable Theft Auto 5.1, Crossy Farm Car
Open one of these on every machine:
  http://localhost:3000   (this machine)
  http://192.168.8.112:3000
```

1. One person opens the page, picks a name, a colour and a game, and presses **CREATE ROOM**.
2. Everyone else opens the LAN address, enters the 4-letter room code and presses **JOIN ROOM**. A room plays one game; the code implies which.
3. In a team game the lobby shows one column per side. Click a side to switch, or use **JOIN HOST'S TEAM** / **JOIN OTHER TEAM**; sides lock once you press READY.
4. Players press **READY**; the host adjusts the game's options and presses **START GAME**.
5. Afterwards the host can restart (`R`) or send everyone back to the lobby (`Esc`).

**PLAY SOLO** runs the selected game without a room, if the game allows a single player.

Use `PORT=4000 npm start` to change the port.

## Layout

```
server/
  index.js        HTTP + WebSocket bootstrap, prints the LAN addresses
  static.js       serves client/ (path-traversal safe) plus three.js from node_modules
  rooms.js        rooms and lobby state machine; knows nothing about any particular game
client/
  index.html      the shell: menu, lobby, and an empty #stage the game mounts into
  app.js          shell logic: picks the game, runs the lobby, drives the game lifecycle
  style.css       shell styles (games may rely on the body font and .btn)
  core/           shared by shell and games
    net.js        WebSocket client          audio.js   WebAudio synth (unlocked once by the shell)
    input.js      keyboard state            loop.js    rAF loop + fixed-step helper
    interp.js     snapshot interpolation    math.js    clamp / lerp / seeded rng
    ui.js         toasts, escaping, stylesheet loading   prefs.js  name / colour / last game
    avatars.js    the shared colour palette players pick from
  games/
    registry.js   the game manifest (see below)
    kart/         Frostline Kart: index.js (game module) + kart.css (its HUD)
    dodgeball/    Dodgeball 3v3: index.js (game module) + dodgeball.css (its HUD)
    gta/          Fable Theft Auto 5.1: index.js (game module: lifecycle, input, HUD, netcode glue),
                  world.js (the seeded city + instanced pools), entities.js (how peds and cars draw),
                  motion.js (walking and driving, shared by host and prediction), sim.js (the host's simulation),
                  remote.js (a client's copy), predict.js (a client's own body), fx.js, font.js, gta.css
    crossy/       Crossy Farm Car: index.js (game module) + crossy.css (its HUD)
```

The server never simulates a game. It keeps the lobby roster and relays in-game messages between the players in a room.
Frostline Kart runs its simulation on the host's browser for CPU karts, items and the clock, and on each player's browser for their own kart.
Dodgeball is host-authoritative: the host's browser simulates everything, the other players send their input to the host and render its 30 Hz snapshots.
Fable Theft Auto is host-authoritative too, with delta snapshots: the host sends each player only the pedestrians, cars and pickups near them that changed since the last tick, plus a per-player HUD block and the one-shot events (shots, crashes, deaths) every machine turns into its own particles and sounds. Clients predict their own body with the same movement code the host runs (`motion.js`) and reconcile against the host's acknowledged input, which hides the round trip. The city itself is generated from a fixed seed, so it never travels over the network.
Crossy Farm Car works like Kart: every machine simulates its own car and broadcasts 20 Hz snapshots of it. The farm is generated from the round's seed (`session.seed`) and everything that moves on it is a function of the world clock, which the host carries in its snapshots, so nobody ever sends a cow.

## Adding a game

1. Create `client/games/<id>/index.js` exporting `create(ctx)` (contract below) and put its stylesheet next to it.
2. Add an entry to `client/games/registry.js`:

```js
{
  id: 'pong', title: 'Frost Pong', tagline: 'FIRST TO 7',
  minPlayers: 2, maxPlayers: 2,
  options: [{ key: 'speed', type: 'select', label: 'BALL SPEED', default: 'normal',
              choices: [{ value: 'slow', label: 'Slow' }, { value: 'normal', label: 'Normal' }, { value: 'fast', label: 'Fast' }] }],
  load: () => import('./pong/index.js'),
}
```

The server reads the same file for player limits and option validation, so nothing else needs to change. Option types are `bool`, `number` (`min`, `max`, `step`) and `select` (`choices`). The host edits them in the lobby; they arrive in `session.opts`.

A team game adds `teams: [{ id, label, color }]` and `teamSize` (max players per side). The server then auto-balances newcomers, lets players switch sides in the lobby (`{ t: 'lobby', team }`) until they are READY, caps each side at `teamSize`, and every entry in `session.players` carries a `team`. What to do with an empty side is the game's call; Dodgeball fills it with CPU bodies.

### Game module contract

```js
export async function create({ mount, audio, send, hooks }) {
  // mount: element you own. Build your canvas/HUD into it; empty it in destroy().
  // audio: shared synth from core/audio.js - audio.beep(), audio.noise(), audio.whenReady(ctx => ...)
  // send(msg): relay a JSON message ({ t: 'yourType', ... }) to the other players; a no-op when solo
  // hooks.onRestart() / hooks.onExit(): call these for R / ESC and result-screen buttons; the shell decides what they mean
  return {
    start(session),   // { players: [{ id, name, avatar, team? }], myId, hostId, isHost, online, opts, seed } - may be called again to restart
                      // seed: a fresh 32-bit number per round, the same on every machine - generate your world from it with core/math.js makeRng
    stop(),           // round over, back to the lobby: hide, stop your loop, stay ready for another start()
    destroy(),        // free everything: DOM, listeners, WebGL, audio nodes
    onNetMessage(m),  // a relayed message from another player; m.from is their id
    playerLeft(id),   // someone dropped out mid-round
  };
}
```

Rules of the road:

- Do nothing at module load time; do everything inside `create()`. Only one game is mounted at a time.
- `avatar` is an index into `core/avatars.js`. Map it to whatever your game needs (the kart game maps it to a kart skin).
- Message names `create join joined lobby opt start end leave left closed error` belong to the lobby. Anything else is relayed as-is; add `to: <playerId>` to send to one player only.
- Detach every `window` listener and cancel your animation frame in `stop()`/`destroy()`. The shell unmounts the game when the room closes or the player returns to the menu.

## Frostline Kart controls

Arrows / WASD to drive, Space to use an item, M to toggle sound. Hold the throttle as the countdown hits GO for a rocket start.

## Dodgeball 3v3

Blue vs red, first to 2 (or 3) rounds. Arrows / WASD to move, Shift to sprint (watch the stamina bar), Space to throw at the nearest enemy once your arm is ready, M to toggle sound.
Balls start on the centre line; a live ball that touches an enemy sends them to the bench, and after 45 seconds the line drops so either side can cross.
Up to 6 players, 3 per side; empty slots are CPU bodies when the host leaves "fill empty slots with CPU" on. A player who drops out mid-match is taken over by a CPU.

## Fable Theft Auto 5.1

Los Pixeles, a procedurally generated voxel city, shared by up to 8 players. WASD to move or drive, mouse to look and aim, left click to shoot,
1 / 2 / 3 or the wheel to switch weapon, R to reload, F to enter or exit a car, Shift to sprint, Space to jump or handbrake, M to toggle sound.
Click once at the start of a round to grab the mouse; Esc releases it and opens the pause card (the city keeps running for everyone else).
F3 or I opens a stats panel (frame time breakdown, host frame rate, snapshot rate and bandwidth, input lag); the corner always shows FPS and, on a client, the input lag and the host's FPS.
L cycles the graphics detail (high, medium, low, auto); auto mode drops a level by itself when the frame rate stays under 40.
Clients predict their own walking and driving locally and are corrected by the host, so your own character answers the keys at once even though everything else is shown a few frames behind.
Everyone starts on Ender Ave with a sports car in their colour. The Downtown Hit mission is shared: the first player to reach Diamond Plaza flushes Vinny out,
whoever whacks him collects the $5000 and the heat. Wanted levels are per player and the cops chase whoever they can see. Players can shoot and run each other over
unless the host turns friendly fire off; a wasted player respawns at the hospital minus $300. Rounds are timed (5, 10, 15 minutes or unlimited) and end with a scoreboard ranked by cash, then kills.

## Crossy Farm Car

Everyone starts on the same farm and hops forward through traffic, rivers and stampede tracks; the round ends when every car is dead, and the standings are furthest row first, coins second.
Arrows / WASD / Space to hop (hold a key to keep hopping), swipe or tap on a phone, M to toggle sound. Logs carry you; drifting off the edge counts.
Stop moving and a UFO comes for you. Cars pass through each other. Dead players watch whoever is furthest ahead; the host presses `R` for another round.
Your lobby colour picks your vehicle.
