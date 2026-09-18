# LAN Party

Browser party games for everyone on the same Wi-Fi. One person runs the server, everyone else opens a URL.
Ships with **Frostline Kart**, a snowy kart racer with shells, bananas and item boxes, coins, Grand Prix cups, CPU karts and up to 8 players, **Dodgeball 3v3**,
a top-down gym dodgeball match where friends pick a side (or join the host's) and CPU bodies fill the rest,
**Fable Theft Auto 5.1**, a voxel crime sandbox where up to 8 players share one procedurally generated city (free roam with a hit to pull off, Most Wanted, where one player carries the mark and everyone else hunts it, a three-lap street race through checkpoints where anything goes, or a deathmatch in a fenced-off square of blocks: first to the kill cap, no stars for it),
**Crossy Farm Car**, a hop-across-the-farm race where up to 8 cars dodge the same herds until the last one is flattened,
**Hog the Throne**, a pig party for up to 4 hogs: a few bumpy minigames, then a king-of-the-hill finale for the crown, and
**Loaded Dice**, a one-button dice duel for two (or a solo run against a ladder of CPU fighters): time one press on a sweeping bar to pick your move and rig your roll.

## Run

```bash
npm install
npm start
```

The server prints the addresses it is reachable on, for example:

```
LAN party server running with 6 game(s): Frostline Kart, Dodgeball 3v3, Fable Theft Auto 5.1, Crossy Farm Car, Hog the Throne, Loaded Dice
Open one of these on every machine:
  http://localhost:3000   (this machine)
  http://192.168.8.112:3000
```

1. One person opens the page, picks a name, a colour and a game, and presses **CREATE ROOM**.
2. Everyone else opens the LAN address, enters the 4-letter room code and presses **JOIN ROOM**. A room plays one game; the code implies which.
3. In a team game the lobby shows one column per side. Click a side to switch, or use **JOIN HOST'S TEAM** / **JOIN OTHER TEAM**; sides lock once you press READY.
4. Players press **READY**; the host adjusts the game's options and presses **START GAME**.
5. Afterwards the host can restart (`R`) or send everyone back to the lobby (`Esc`).

**PLAY SOLO** runs the selected game without a room, if the game allows a single player; the game's options appear under the game list as **SOLO OPTIONS** and apply to every solo restart.

**Phones and tablets.** The lobby shows the join link as a QR code: scan it with the phone's camera and the start screen opens with the room
code filled in. Every game has touch controls. For the best experience on an iPhone or iPad, open the LAN address in
Safari once and use Share → **Add to Home Screen**: launched from there the game runs full screen in landscape with no browser bar and no
back-swipe gesture. (Safari cannot go full screen on an iPhone any other way.) While a game is running the page holds a screen wake lock, so the phone
does not dim or lock mid-game (iOS 16.4 and later; it is taken again when the page comes back from the background), and it asks for its sound to be
played as media, so the game is heard with the ring/silent switch on silent (iOS 17 and later).

Use `PORT=4000 npm start` to change the port. `npm test` runs the node tests (the snapshot clock, the Kart and Hog wire formats, the QR encoder, the touch controls, the Fable Theft Auto movement code, its host simulation run headless, its arena and its killcam, the Loaded Dice duel rules). `npm run icons` redraws the home-screen icons.
`FAKE_LAG_MS=60 FAKE_JITTER_MS=40 npm start` delays every relayed in-game message by that much, to try the netcode on a pretend bad Wi-Fi.

## Layout

```
server/
  index.js        HTTP + WebSocket bootstrap, prints the LAN addresses
  static.js       serves client/ (path-traversal safe) plus three.js and cannon-es from node_modules
  rooms.js        rooms and lobby state machine; knows nothing about any particular game
client/
  index.html      the shell: menu, lobby, and an empty #stage the game mounts into
  app.js          shell logic: picks the game, runs the lobby, drives the game lifecycle
  style.css       shell styles (games may rely on the body font and .btn)
  manifest.webmanifest, icons/   home-screen install (icons are drawn by scripts/make-icons.js)
  core/           shared by shell and games
    net.js        WebSocket client          audio.js   WebAudio synth (unlocked once by the shell)
    input.js      keyboard state            touch.js   multi-touch steering pad / thumb stick and hold buttons (Pointer Events)
    qr.js         QR encoder for the lobby's join link    loop.js    rAF loop + fixed-step helper
    interp.js     snapshot buffers + the per-sender clock (sender timestamps, jitter, adaptive delay)
    ticker.js     a worker-driven timer that keeps ticking in a hidden tab    math.js    clamp / lerp / seeded rng
    ui.js         toasts, escaping, stylesheet loading   prefs.js  name / colour / last game
    avatars.js    the shared colour palette players pick from
  games/
    registry.js   the game manifest (see below)
    kart/         Frostline Kart: index.js (game module), net.js (the wire format, testable in node), kart.css (its HUD)
    dodgeball/    Dodgeball 3v3: index.js (game module) + dodgeball.css (its HUD)
    gta/          Fable Theft Auto 5.1: index.js (game module: lifecycle, input, HUD, netcode glue),
                  world.js (the seeded city + instanced pools), entities.js (how peds and cars draw),
                  motion.js (walking and driving from keys or a thumb stick, shared by host and prediction), sim.js (the host's simulation),
                  remote.js (a client's copy), predict.js (a client's own body), race.js (the street race's seeded course, its lap plan and sat-nav, testable in node), arena.js (the deathmatch's seeded arena, its spawn points and the fence's numbers, testable in node), bots.js (the deathmatch's CPU players: the seeded roster and the brain, testable in node), replay.js (the killcam's ring of frames, testable in node), fx.js, font.js, gta.css
    crossy/       Crossy Farm Car: index.js (game module) + crossy.css (its HUD)
    dice/         Loaded Dice: index.js (game module: the canvas, the solo run, the duel's two ends, touch, the cards), rules.js (the duel's rules: bars, grading, rolls, the outcome; testable in node), dice.css
    hog/          Hog the Throne: index.js (game module: physics, minigames, netcode glue, HUD), net.js (the roster and the wire format, testable in node), hog.css
test/             node --test: the snapshot clock, the Kart and Hog wire formats, the QR encoder, the touch controls, the Fable Theft Auto movement code, its simulation, its CPU players and its killcam, the Loaded Dice duel rules
scripts/          make-icons.js draws client/icons/*.png with no dependencies
```

The server never simulates a game. It keeps the lobby roster and relays in-game messages between the players in a room.
Frostline Kart runs its simulation on the host's browser for CPU karts, items and the clock, and on each player's browser for their own kart.
Each machine broadcasts what it drives as two streams: motion (pose, velocity, controls, effect flags) 30 times a second from a worker timer that keeps
ticking when the tab is hidden, and status (laps, items, timers) 5 times a second or as soon as something discrete changes. Every message carries the
sender's clock, and the receiver maps it through a per-sender clock that measures the link's jitter, so a burst of late packets keeps its real spacing.
Everyone else's karts and the host's shells are dead-reckoned to the present with the same kinematics the owner runs, so contact and hits happen where
the other kart really is; the correction a fresh snapshot brings is hidden in a visual offset that decays over a few frames, and on a jittery link the
clock backs the display off a little so there is usually a later snapshot to interpolate toward instead. Players ping each other once a second, and half
the best round trip is how far past its snapshots each sender's present is placed. A client shows a ghost of its own thrown item
at once and hands it over to the host's copy when that arrives.
Dodgeball is host-authoritative: the host's browser simulates everything, the other players send their input to the host and render its 30 Hz snapshots.
Fable Theft Auto is host-authoritative too, with delta snapshots: the host sends each player only the pedestrians, cars and pickups near them that changed since the last tick, plus a per-player HUD block and the one-shot events (shots, crashes, deaths) every machine turns into its own particles and sounds. Clients predict their own body with the same movement code the host runs (`motion.js`) and reconcile against the host's acknowledged input, which hides the round trip. The city itself is generated from a fixed seed, so it never travels over the network. The host's lobby picks the mode: the **sandbox** (a hit to pull off, then free roam, most cash wins) or **Most Wanted** (after a few seconds one player is the mark: it pays by the second and always has two stars on it, killing the mark pays a bounty and takes it, and the round is still scored on cash; it needs two players, so solo it is the sandbox) or the **deathmatch** (everyone is fair game with friendly fire on, a player kill adds no wanted star, there are no world events and the cabs take no fares, the round ends the moment someone reaches the lobby's kill cap (`killCap`, 10, 20 or 30) or when the clock runs out, standings are by kills and the mode block carries the cap and the leader; it needs two players too). The deathmatch is fought in an **arena** (`arena.js`): three blocks a side plus the roads around them, drawn from the round's seed so every machine fences off the same square and nothing about it travels. Everyone starts on foot at one of its eight sidewalk corners, a respawn is the corner farthest from everyone else who is alive with no hospital bill, the crowd and the traffic are the arena's own and far thinner (`ARENA_CIVS`, `ARENA_TRAFFIC`, and anything that wanders a margin outside is culled), a dozen or so cars are parked on its streets and none of the city's landmarks are set, and the city's crates are replaced by the arena's (a sniper and a rocket launcher in two opposite corners, ammo in the other two, health at the middle block, back in `ARENA_CRATE_RESPAWN` seconds). Four translucent red walls stand on its edge and the minimap dims the rest of the city; a player outside it has `OUT_WARN_T` seconds on a countdown to get back (the seconds ride in the block), then the fence takes `OUT_DMG_PER_S` a second in half-second bites until they are in or dead, and a death that way is its own cause (`fence`: LEFT THE ARENA in the feed and on the card). The arena has its own pace: the police stay out of it (nothing in a deathmatch earns a star, not a civilian, not a carjacking, and the HUD draws no stars), the traffic never leaves it (a car at an intersection only picks the arena's own roads, so it loops the edge and turns back where a road leaves), what a fence death drops lands just inside, the wait after a death is `DM_WASTED_T` seconds instead of `WASTED_T` (still long enough for the killcam), and the awards skip the chase, the driving and the loot. **CPU players** (`bots.js`) fill a deathmatch up to four players while the lobby's `fillAI` is on (so a deathmatch alone is a deathmatch, not the sandbox), their names and colours drawn from the round's seed so the host and every client lay out the same roster (bots come after the humans, their ids start with `bot:`, and no client is made for them); the host runs each bot's brain every tick and it writes its input where the network would (the stick, the bits, the camera yaw, the click counter), so a bot goes through exactly the movement, the guns, the damage, the feed, the killcam and the awards a human does, and shows as CPU on the results card. A bot walks (it never takes a car), hunts the nearest live player, keeps a fighting distance and strafes, routes along the road grid when it cannot see its target (never back to the node behind it, and a sidestep when it is stuck), goes for a health crate when hurt, reloads an empty mag and swaps a dry gun, and shoots with an aim error, a reaction delay, a cadence and an engagement range set by `botSkill` (easy, normal, hard; `BOT_SKILLS`). The lobby also sets the guns (off, and the only ways to die are a bumper and the LPPD: nobody carries a gun, no crate grows, nothing drops off a cop, and the HUD and the touch buttons lose their weapon parts), the starting kit (`loadout`: the pistol alone, the three basic guns, or all five; the kit is what a player keeps through a death and what refills at the hospital, anything else they picked up is dropped in the street, so in a pistol-only round a shotgun lies where its owner fell), the traffic and the police (`traffic` and `cops`, each a factor on the caps and the spawn rates, see `TRAFFIC_LEVELS` and `COP_LEVELS` in `sim.js`) and the race's laps (`laps`, 1 to 5; the option shows in every mode and matters only on a race day). In either mode the host runs world events every minute or two (an armored truck that spills cash when blown open, an airdrop of cash, ammo and health over a park) that the whole room is told about, four stars put roadblocks across the road ahead of a driver and five bring the SWAT van, and everyone sees arrows at the edge of the screen for the other players, the mark and the event. A player who dies sees who did it and how, and the camera follows the killer; when another player did it there is a killcam first (`replay.js`): every machine keeps the last three and a half seconds of what it drew in a ring (the pose of every pedestrian and car it knows, nothing travels for it), and half a second after the death, once the fall has been seen, that ring is played back through the same views, letterboxed, from behind the killer the way the killer saw it, before the death camera takes over until the respawn. Every death goes into a feed in the top-left corner of every screen (killer, a gun icon or a verb, victim; the cops, the traffic or a crash when nobody did it), along with the room's news (`news` events in `sim.js`: a sniper or a rocket found, five stars, a five-star escape, a trip to the precinct, the truck blown open and by whom, the airdrop down, three fares in a row, someone leaving), the mark changing hands, the world events and race finishes; a line stays eight seconds, five show on a monitor and three on a phone. The host also keeps a tally through the round (deaths and who did it, the length of each chase, fares in a row, cash off the street, crashes at the wheel, distance and top speed, race lap times) and sends the awards once, in the `over` event, for the results card to show under the standings: fastest lap (a race day leads with it), most kills, nemesis (who wasted whom the most), most wasted, longest chase, best cabbie, speed demon, safest driver (the fewest crashes among those who drove far enough) and biggest looter, each with a bar to clear, at most six. Everyone starts with a pistol, a shotgun and an SMG; a sniper rifle and a rocket launcher (a hitscan shot with a blast around the hit) come out of the crates at the end of the pier and in the parks, grow back two minutes after being taken, ride in the airdrop, and are dropped in the street when their owner dies. A car takes three passengers besides the driver: F beside a friend's car gets in (a player at the wheel is never jacked), passengers shoot out of their window while the driver drives, and a passenger's body is not predicted, the host's car simply carries it. Besides the cars there is a bus in the traffic (twice a sedan's length, so it collides along four spheres down its side instead of two, see `carOffs` in `motion.js`; seven ride along) and motorcycles parked around the city and by the Ferris wheel (nimble, light, one pillion; the rider sits in the open, drawn in the saddle from a flag on the wire, and a hard enough hit throws everyone off and hurts them). Each car type may set its own steering rate (`turn`). At the wheel of a taxi (three wait at the rank by Diamond Plaza) or the ambulance a job starts by itself: a fare waves from a corner a block or two away (a patient lies there), it gets in when the car stops beside it, and a destination is named with a timer and a price by the metre (the hospital for a patient); a fast run tips, every delivery in a row adds to the next, and a fare that is hurt, kept waiting or left in the car is gone with the streak. The job's target rides in the per-player block and drives the minimap route, the marker column and the edge arrow the mission target used to have to itself. The third mode is the **street race**: the course (`race.js`) is six intersections drawn from the round's seed, so every machine lays out the same one and it never travels; everyone starts at the wheel on a grid below the line on Ender Ave, a countdown holds them (the host ignores input and the clients do not predict a move), then it is three laps through the checkpoints in order and back across the line, with guns, traffic and cops all in play. The first one home starts a twenty-second grace for the rest, the standings are the finishing order and then progress along the course (laps, checkpoints, the fraction of the leg, ranked by the host and carried in the block), a wasted racer is back at the wheel of a fresh car at the last checkpoint, and there are no world events or fares on a race day. The lap is planned once from the seed (`planLap` in `race.js`): every leg is the shortest road path that never reverses at an intersection and prefers to go straight, leaves each checkpoint the way the previous leg arrived, and comes back across the line heading +z the way the grid faces, so all three laps drive the same roads; the course itself is drawn again while any leg doubles back on the one before it. A sat-nav (`raceRoute` + `raceGuide`, local to every machine) shows the rest of the current leg and the whole of the next one: a trail of arrows on the road with a bigger one at each intersection pointing the way out (the checkpoint's included), and on the HUD the next turn, how far it is and the road it takes, or, while the checkpoint is nearer than any turn, the checkpoint and under it the turn that follows it (THEN LEFT). A driver who has left the planned roads is routed back to the checkpoint from the intersection ahead of the bonnet, arriving the planned way, so the instruction is never a U-turn inside the city; a wasted racer's fresh car faces the way the plan leaves its checkpoint.
Hog the Throne is host-authoritative like Dodgeball: the host's browser runs the pig physics (cannon-es) and every CPU brain and sends 30 Hz snapshots (the pigs, the current minigame's state and the effects since the last one); the other players send their stick and HOP as a wish and each DASH press as a message, and render the snapshots interpolated a little in the past. The plan of minigames is drawn from the round's seed.
Loaded Dice is host-authoritative and turn-shaped, so nothing is streamed: the host sends each round's two bars, every machine sweeps its own cursor on its own clock (the press is graded where the finger is, so the link's latency is not in it) and answers with where the cursor was, and the host rolls for both and sends the outcome once the two picks are in, or the sweep's deadline has passed.
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

## Hog the Throne

Up to 4 hogs; empty slots are CPU pigs when the host leaves "fill empty slots with CPU" on (a lone player always gets one to bump).
WASD / arrows to move, Space to hop (hold it to keep hopping), Shift or E to butt-dash, M to toggle sound, R to play again (host), Esc to leave.
The host picks **MINIGAMES BEFORE THE THRONE** (2, 3 or 4) in the lobby or under SOLO OPTIONS; they are drawn from Whirly Bacon (hop the spinning
bar, last pig standing), Balloon Butt (butt-dash pigs to pop their three balloons, keep yours), Crumble Cake (the floor is cake and it falls; falling
with it is out) and Truffle Rush (snort up the most truffles; a dash makes a pig drop up to three). Each minigame banks bonus seconds for the finale,
**The Throne**: a king-of-the-hill hill with a throne on top; the pig that sat on it longest, bonus included, hogs it. A pig knocked off the world in
the finale respawns at the edge. A player who drops out mid-game is taken over by a CPU.

On a touch screen (iPhone, iPad, any tablet) the left part of the screen is a thumb stick: touch anywhere there and drag; it centres when the finger
lifts. **HOP** (hold to keep hopping) and **DASH** sit under the right thumb; a press that cannot do anything shakes the button. The ☰ button opens a
card with sound and, for the host, play again and leave. On a touch screen the player chips sit under the round title, out of the thumbs' way;
a phone held upright is asked to rotate, and on a phone in landscape everything is a size smaller. The renderer runs without antialiasing and with a smaller shadow map on phones and tablets.

## Loaded Dice

One button: Space (or Enter / Z / X), a click, or a tap. A cursor sweeps across the rig bar; press while it is over a slot to take that move and rig the
die (+1, or +2 on the bright middle of the slot). A press on bare bar is a fumble that rolls a 1, and a bar left to run out is a plain attack. Roll 3 or
more to land the move, the die's top face is a crit, and every rigged press builds a combo that speeds the bar up. M toggles sound, R plays again (host), Esc leaves.

With **two players** it is a duel between them. Both bars sweep at once and the dice are thrown when both have pressed; each player sees the other's
slots on a small bar under their hearts, but not which one they picked. Swords attack (two attacks clash and the higher roll lands), shields block
swords (a top-face block parries for damage, a top-face attack breaks the block), skulls break a shield and daze the other side (narrow slots next
round), hearts heal, **>>** speeds the OTHER player's bar and **<<** slows your own. A landed roll of 6 or more hits for an extra half heart, and a
combo gives a landed roll a chance to jump to the top face. The lobby sets how many duels win the match (`wins`), the hearts (`hearts`) and the dice
(`dice`: a D4 that grows every three rounds up to a D20, or a fixed D6 / D12 / D20). The avatar picks each fighter's head, body and weapon, and its
colour is the tunic's. A player who leaves forfeits. **Alone** (PLAY SOLO, or a room of one) it is a run against a ladder of CPU fighters whose next
move shows in a bubble: perks on level up, bigger dice, and a best score kept per browser.

On a touch screen (iPhone, iPad, any tablet) a tap anywhere on the screen is the button, taken the moment the finger lands, and a perk card is picked
by tapping it. The ☰ button opens a card with sound, **HOW TO PLAY** and, for the host, play again and leave; a card over a solo run pauses it (a
duel goes on underneath). The picture is fitted inside the safe-area insets, a phone held upright is asked to rotate, and on a phone-sized view the
hearts, the stats, the bar and the cards are drawn larger so they can be read and hit.

## Frostline Kart

Arrows / WASD to drive, M to toggle sound, R for the next race (host), Esc to leave. Press the throttle once the **1** is on screen and keep
holding it through GO for a rocket start: a line under the number asks for the hold, turns green while one that will fire is in progress, and
says so when a press came too early, which lifting and pressing again inside that last second puts right.
F3 (or I) opens a stats panel: frame time breakdown, message rates, every sender's snapshot spacing and jitter, and how many corrections the remote karts
needed; the top of the screen always shows FPS and, on a client, how old the host's data is, the jitter and the host's frame rate. L cycles the detail
level (auto, high, medium, low): each step lowers the pixel ratio, medium thins the pines and the snow, low also turns the point lights off; auto
lowers the level by itself when the frame rate stays under 40. Phones and tablets start on medium, without antialiasing and without the HUD blur.

On a touch screen (iPad, iPhone, any tablet) the kart accelerates by itself and the left part of the screen is a steering pad: touch anywhere
there and drag left or right. The first few millimetres of a drag do nothing, so a thumb settling on the glass does not twitch the kart, and
the steering is finest near the centre while full lock is still one thumb's travel away; **STEERING** in the ☰ menu sets how long that travel
is (low, normal, high) and is remembered per browser. **BRAKE** and **ITEM** sit under the right thumb, and the item slot at the top left is a
second ITEM button. Both work like the key: touch to deploy, lift to throw; drag downward (or hold BRAKE) before lifting to throw the other
way, and the arrow on the button shows which way the throw will go. A press with nothing to use shakes the button.

For the rocket start, hold a finger anywhere except an ITEM button or the ☰ once the **1** appears, and keep it there through GO: the steering
pad, BRAKE and the bare screen all count, and a thumb parked on BRAKE for it does not brake when the race starts, only when it is lifted and
pressed again. The very first race on a device opens with a **HOW TO PLAY** card that covers all of this and steps aside when the 1 comes up;
the ☰ button brings it back, along with sound, detail level, steering, the stats panel and, for the host, restart and leave. A phone held
upright is asked to rotate; the HUD is laid out for landscape and everything is a size smaller on a phone-height screen.

Space (or Enter / E) works the item slot. Shells, bananas and bob-ombs are carried: press to deploy one so it trails behind the kart
(a triple orbits it) where it blocks incoming shells, release to throw it. Hold the brake (↓ / S) while releasing to throw the other way:
shells backward, a banana or bob-omb forward. Everything else fires on press; the golden mushroom and fire flower fire on every press
until their timer runs out. Shift is unused, reserved for a future drift key.

Items are rolled by how far you are behind the leader, not by place: coins, bananas and green shells at the front; red shells, triples,
fire flowers and bob-ombs mid-pack; stars, golden mushrooms, bloopers, blue shells, lightning and bullet bills at the back. Only one
blue shell and one lightning strike are ever in play at a time. Coins on the road raise top speed by about one percent each up to ten
and a hit scatters three. The blue shell flies over the field and dives on the leader; a bob-omb blows up on contact or after its fuse;
a blooper inks everyone ahead of the thrower; a bullet bill drives your kart down the racing line at almost double speed, immune to everything.

Options (in the lobby, or under SOLO OPTIONS on the start screen): a single race or a **Grand Prix** of four races on the four track
variants (Frostline, Reverse, Mirror, Mirror Reverse) scored 15-12-10-9-8-7-6-5 with a trophy screen at the end, engine class
(50cc / 100cc / 150cc), laps (1 to 5), CPU difficulty and whether CPUs fill the empty slots. The host moves a cup on a few seconds after
everyone has finished (or by pressing R once they have finished themselves). Every colour is a kart with a weight class, shown on the
countdown card: light karts launch and turn better, heavy karts are faster on the straights and shove lighter karts aside.

## Dodgeball 3v3

Blue vs red, first to 2 (or 3) rounds. Arrows / WASD to move, Shift to sprint (watch the stamina bar), Space to throw at the nearest enemy once your arm is ready, M to toggle sound.
Balls start on the centre line; a live ball that touches an enemy sends them to the bench, and after 45 seconds the line drops so either side can cross.
Up to 6 players, 3 per side; empty slots are CPU bodies when the host leaves "fill empty slots with CPU" on. A player who drops out mid-match is taken over by a CPU.

On a touch screen (iPhone, iPad, any tablet) the left part of the screen is a thumb stick: touch anywhere there and drag; how far the finger
moves sets the speed, and it centres when it lifts. **SPRINT** (hold) and **THROW** sit under the right thumb. A tap on THROW throws at the
nearest enemy, like Space; drag it before lifting and the throw goes the way the finger went instead, with an arrow from your body showing where.
A press with no ball in hand shakes the button. The ☰ button opens a card with sound and, for the host, play again and leave. A phone held
upright is asked to rotate; in landscape on a phone the score and the status float over the crowd so the court fills the screen, and the
names on the court are drawn larger. An online host keeps the match running from a worker timer while its tab is hidden.

## Fable Theft Auto 5.1

Los Pixeles, a procedurally generated voxel city, shared by up to 8 players. WASD to move or drive, mouse to look and aim, left click to shoot,
1 / 2 / 3 or the wheel to switch weapon, R to reload, F to enter or exit a car, Shift to sprint, Space to jump or handbrake, M to toggle sound.
Click once at the start of a round to grab the mouse; Esc releases it and opens the pause card (the city keeps running for everyone else).
F3 or I opens a stats panel (frame time breakdown, host frame rate, snapshot rate and bandwidth, input lag); the corner always shows FPS and, on a client, the input lag and the host's FPS.
L cycles the graphics detail (high, medium, low, auto); auto mode drops a level by itself when the frame rate stays under 40.
Clients predict their own walking and driving locally and are corrected by the host, so your own character answers the keys at once even though everything else is shown a few frames behind.
The crosshair turns red while a shot would take someone: shots that miss narrowly still hit the nearest pedestrian within a small cone of the crosshair.

On a touch screen (iPhone, iPad, any tablet) the left part of the screen is a thumb stick: touch anywhere there and drag to walk, push it all the way to run,
and in a car push forward for gas, back for the brake and reverse, and sideways to steer. The rest of the screen is a look surface: drag to turn and aim.
**FIRE** sits under the right thumb and is held to shoot; drag on it to aim while shooting, and it turns red while the shot would lock on. **JUMP** is the
handbrake in a car, **USE** says what it would do (ENTER, JACK, EXIT, TURN IN) and lights up when there is something to use, **WEAPON** cycles the guns and
**RELOAD** lights up when the magazine can be topped up. The ☰ button pauses: sound, detail level, look sensitivity (LOW, NORMAL, HIGH, remembered per browser),
the stats panel, the controls card and, for the host, restart and leave. A touch player's shots get a wider lock-on cone than a mouse's. Phones and tablets start
on MEDIUM detail, the HUD keeps clear of the notch and the home indicator, a phone held upright is asked to rotate, and on a phone in landscape the mission text
folds away after the intro so the objective and the map have the screen.
Everyone starts on Ender Ave with a sports car in their colour. The Downtown Hit mission is shared: the first player to reach Diamond Plaza flushes Vinny out,
whoever whacks him collects the $5000 and the heat. Wanted levels are per player and the cops chase whoever they can see. Players can shoot and run each other over
unless the host turns friendly fire off; a wasted player respawns at the hospital minus $300. Rounds are timed (5, 10, 15 minutes or unlimited) and end with a scoreboard ranked by cash, then kills.

Losing the stars: stay out of the cops' sight for long enough and they drop one at a time; a blue **bribe** pickup (hidden in the parks, behind the precinct and by the
Ferris wheel, and sometimes dropped by a dead cop) takes one star off; the **Pay 'n' Spray** downtown, marked in cyan on the map, clears them all for $100 a star
when you stop a car in its bay, and repaints the car; or walk up to the precinct door with F to **turn yourself in**: the same fine, capped at what you carry, plus your spare ammo.

Earning it straight: take a cab from the **taxi rank** by Diamond Plaza (yellow T on the map) or the **ambulance** outside the hospital and the job starts as you drive off. Fares wave from street corners, patients lie on them; stop beside one, it gets in, and the objective names where it goes with the seconds you have. Fares pay by the metre, a fast run tips, and each delivery in a row adds to the next. Keep it waiting, hurt it or get out of the car and it is gone.

## Crossy Farm Car

Everyone starts on the same farm and hops forward through traffic, rivers and stampede tracks; the round ends when every car is dead, and the standings are furthest row first, coins second.
Arrows / WASD / Space to hop (hold a key to keep hopping), swipe or tap on a phone, M to toggle sound. Logs carry you; drifting off the edge counts.
Stop moving and a UFO comes for you. Cars pass through each other. Dead players watch whoever is furthest ahead; the host presses `R` for another round.
Your lobby colour picks your vehicle.
