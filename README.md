# Frostline Kart

Snowy kart racer in the browser (Three.js), now with LAN multiplayer.

## Run

```bash
npm install
npm start
```

The server prints the addresses it is reachable on, for example:

```
Frostline Kart server running. Open one of these on every Mac:
  http://localhost:3000   (this machine)
  http://192.168.8.112:3000
```

1. One person opens the page, picks a name and kart, and presses **CREATE ROOM**.
2. Everyone else on the same network opens the LAN address, enters the 4-letter room code and presses **JOIN ROOM**.
3. Players press **READY**; the host presses **START RACE**. Empty slots are filled with CPU karts unless the host unticks that option.
4. After the race the host can restart (`R`) or send everyone back to the lobby (`Esc`).

**PLAY SOLO VS CPU** runs the original single-player race without a room.

Use `PORT=4000 npm start` to change the port.

## How it works

- `server.js` serves the static files and relays room messages over WebSocket. It keeps the lobby roster but never simulates the race.
- `game.js` is the engine. Each machine simulates only the karts it owns: your own kart, plus all CPU karts, shells, bananas, item boxes and the race clock if you are the host. Everything else is interpolated from 30 Hz snapshots.
- Hits are decided by the victim's machine, so what you see is what you get.
- If a player disconnects mid-race the host takes over their kart as a CPU. If the host leaves, the room closes.
- `app.js` is the menu and lobby; `net.js` is the WebSocket client.

## Controls

Arrows / WASD to drive, Space to use an item, M to toggle sound. Hold the throttle as the countdown hits GO for a rocket start.
