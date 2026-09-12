/* The killcam: every machine keeps the last few seconds of what it drew (the pose of every pedestrian and car it
   knows, and where each player's body and car are) in a ring, and when a player is wasted by another player the
   ring is played back through the same views, seen from behind the killer the way the killer saw it. Nothing
   travels over the network for this: the host records its simulation, a client records its interpolated copy.
   The frames hold plain state objects (the fields PedView.draw and CarView.draw read, see entities.js) and the
   view that draws them, so a playback frame is drawn with `st.view.draw(st, dt, t)`. Testable in node. */
import { angDiff } from './world.js';

export const REPLAY_KEEP = 3.5;   // seconds of the past kept in the ring, and the most a playback shows
export const REPLAY_MIN = 1.2;    // a shorter clip than this is not worth showing
export const REPLAY_RATE = 30;    // frames recorded per second, at most
export const REPLAY_DELAY = 0.5;  // the death is shown live this long (the fall) before the playback starts

/* the fields the views read, copied out of a live entity (host: sim.js Ped / Car; client: remote.js entries) */
const pedState = e => ({ cls: 'ped', id: e.id, view: e.view, kind: e.kind, x: e.x, y: e.y, z: e.z, yaw: e.yaw, dead: !!e.dead, deadT: e.deadT || 0, moving: e.moving || 0, hitT: e.hitT || 0,
  armRaise: e.armRaise || 0, camPitch: e.camPitch || 0, gun: e.gun || null, down: !!e.down, ride: !!e.ride, seat: e.seat | 0, inCar: e.inCar ? (e.inCar.type ? { type: e.inCar.type } : true) : null });
const carState = e => ({ cls: 'car', id: e.id, view: e.view, type: e.type, x: e.x, y: e.y, z: e.z, yaw: e.yaw, steer: e.steer || 0, vF: e.vF || 0, speed: e.speed || 0, dead: !!e.dead, lights: !!e.lights, smoking: !!e.smoking, burn: !!e.burn });

export function createReplay() {
  const ring = []; // { t, ents: Map id -> state, P: [{ pedId, carId, camPitch }] } oldest first
  let lastT = -Infinity, play = null;

  /* one rendered frame: `ents` iterates the live entities (anything with a `view` and a `cls` of ped or car), `blocks` the
     per-player HUD blocks (pedId, carId, camPitch); `now` is the local clock in seconds */
  function record(now, ents, blocks) {
    if (now - lastT < 1 / REPLAY_RATE - 1e-3) return false; // (a little slack, so a 60 Hz loop records every other frame, not every third) // (recording goes on during a playback, so a death soon after has its own clip)
    lastT = now;
    const m = new Map();
    for (const e of ents) {
      if (!e.view || e.view.released) continue;
      if (e.cls === 'ped') m.set(e.id, pedState(e)); else if (e.cls === 'car') m.set(e.id, carState(e));
    }
    const P = (blocks || []).map(b => { const s = b && m.get(b.pedId); if (s) s.camPitch = b.camPitch || 0; return { pedId: b ? b.pedId : -1, carId: b ? b.carId : -1 }; }); // the block knows where a player looks
    ring.push({ t: now, ents: m, P });
    while (ring.length && ring[0].t < now - REPLAY_KEEP) ring.shift();
    return true;
  }

  /* start playing the ring back from behind player `killer`; false when there is too little, or the killer is not in the last frame */
  function start(killer, now) {
    if (play || ring.length < 2) return false;
    const clip = ring.filter(f => f.t >= now - REPLAY_KEEP);
    if (clip.length < 2 || clip[clip.length - 1].t - clip[0].t < REPLAY_MIN) return false;
    const last = clip[clip.length - 1], pk = last.P[killer];
    if (!pk || !last.ents.has(pk.pedId)) return false;
    play = { clip, killer, t0: clip[0].t, dur: last.t - clip[0].t, at: 0 };
    return true;
  }
  const stop = () => { play = null; };
  const reset = () => { ring.length = 0; lastT = -Infinity; play = null; };

  /* the states to draw `dt` further into the playback, interpolated between the two recorded frames around that moment, and
     the camera: { subj: { x, y, z, inCar }, yaw, pitch } from behind the killer's body or car. `done` once the clip has run out. */
  function frame(dt) {
    if (!play) return null;
    play.at += dt;
    const tp = play.t0 + play.at, clip = play.clip;
    let i = 0; while (i < clip.length - 2 && clip[i + 1].t <= tp) i++;
    const a = clip[i], b = clip[i + 1], f = b.t > a.t ? Math.max(0, Math.min(1, (tp - a.t) / (b.t - a.t))) : 0;
    const states = [];
    for (const sa of a.ents.values()) {
      const sb = b.ents.get(sa.id);
      if (!sb || f <= 0) { states.push(sa); continue; }
      const s = { ...sa }; s.x += (sb.x - sa.x) * f; s.y += (sb.y - sa.y) * f; s.z += (sb.z - sa.z) * f; s.yaw += angDiff(sb.yaw, sa.yaw) * f;
      if (sa.cls === 'car') { s.steer += (sb.steer - sa.steer) * f; s.vF += (sb.vF - sa.vF) * f; s.speed = Math.abs(s.vF); }
      else if (f > 0.5) { s.dead = sb.dead; s.deadT = sb.deadT; s.moving = sb.moving; s.armRaise = sb.armRaise; s.hitT = sb.hitT; s.gun = sb.gun; s.inCar = sb.inCar; s.ride = sb.ride; }
      states.push(s);
    }
    const pk = a.P[play.killer] || { pedId: -1, carId: -1 };
    const ped = states.find(s => s.id === pk.pedId) || null, car = pk.carId >= 0 ? states.find(s => s.id === pk.carId) || null : null;
    const cam = ped ? { subj: { x: ped.x, y: ped.y, z: ped.z, inCar: car, dead: false }, yaw: car ? car.yaw : ped.yaw, pitch: car ? 0.22 : ped.camPitch } : null;
    return { states, cam, done: play.at >= play.dur, progress: Math.min(1, play.at / play.dur) };
  }
  return { record, start, stop, reset, frame, get active() { return !!play; }, get killer() { return play ? play.killer : -1; }, get progress() { return play ? Math.min(1, play.at / play.dur) : 0; }, get frames() { return ring.length; }, get span() { return ring.length ? ring[ring.length - 1].t - ring[0].t : 0; } };
}
