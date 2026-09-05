# LAN Party

Browser party games for everyone on the same Wi-Fi. One person runs the server, everyone else opens a URL.
Ships with **Frostline Kart**, a snowy kart racer with items, CPU karts and up to 8 players.

## Run

```bash
npm install
npm start
```

The server prints the addresses it is reachable on, for example:

```
LAN party server running with 1 game(s): Frostline Kart
Open one of these on every machine:
  http://localhost:3000   (this machine)
  http://192.168.8.112:3000
```

1. One person opens the page, picks a name, a colour and a game, and presses **CREATE ROOM**.
2. Everyone else opens the LAN address, enters the 4-letter room code and presses **JOIN ROOM**. A room plays one game; the code implies which.
3. Players press **READY**; the host adjusts the game's options and presses **START GAME**.
4. Afterwards the host can restart (`R`) or send everyone back to the lobby (`Esc`).

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
```

The server never simulates a game. It keeps the lobby roster and relays in-game messages between the players in a room.
Frostline Kart runs its simulation on the host's browser for CPU karts, items and the clock, and on each player's browser for their own kart.

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

### Game module contract

```js
export async function create({ mount, audio, send, hooks }) {
  // mount: element you own. Build your canvas/HUD into it; empty it in destroy().
  // audio: shared synth from core/audio.js - audio.beep(), audio.noise(), audio.whenReady(ctx => ...)
  // send(msg): relay a JSON message ({ t: 'yourType', ... }) to the other players; a no-op when solo
  // hooks.onRestart() / hooks.onExit(): call these for R / ESC and result-screen buttons; the shell decides what they mean
  return {
    start(session),   // { players: [{ id, name, avatar }], myId, hostId, isHost, online, opts } - may be called again to restart
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
