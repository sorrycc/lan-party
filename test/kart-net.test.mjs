/* Frostline Kart wire codecs round-trip and stay small. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { F, packMotion, unpackMotion, packStatus, unpackStatus, statusKey, packHaz, unpackHaz, kartFlags, NET_HZ, STATUS_HZ } from '../client/games/kart/net.js';

const kart = { id: 3, x: 12.345, z: -67.891, h: 1.23456, vx: 10.5, vz: -3.25, vf: 11.0, steer: -0.5, throttle: 1, lap: 2, cpNext: 7, boost: 0.8, spin: 0, spinAng: 3.1, star: 0, shrink: 0, bullet: 0, ink: 2.5, item: 'red', itemN: 3, held: true, coins: 6, roulette: 0, finished: false, finishTime: 0, offroad: true };

test('motion packs to ten numbers and unpacks within rounding', () => {
  const a = packMotion(kart); assert.equal(a.length, 10); assert.ok(JSON.stringify(a).length < 90);
  const m = unpackMotion(JSON.parse(JSON.stringify(a)));
  assert.equal(m.i, 3); assert.ok(Math.abs(m.x - kart.x) < 0.006 && Math.abs(m.z - kart.z) < 0.006 && Math.abs(m.h - kart.h) < 0.0006);
  assert.equal(m.th, 1); assert.equal(m.st, -0.5);
  assert.equal(m.fl, F.BOOST | F.INK | F.OFFROAD); assert.equal(kartFlags({ ...kart, finished: true, star: 1 }) & (F.FINISHED | F.STAR), F.FINISHED | F.STAR);
});

test('status carries the discrete state and the timers', () => {
  const s = unpackStatus(JSON.parse(JSON.stringify(packStatus(kart))));
  assert.equal(s.i, 3); assert.equal(s.lp, 2); assert.equal(s.cp, 7); assert.equal(s.it, 'red'); assert.equal(s.ic, 3); assert.equal(s.he, true); assert.equal(s.co, 6);
  assert.equal(s.bo, 0.8); assert.equal(s.ik, 2.5); assert.equal(s.sp, 0); assert.equal(s.fi, false);
  const none = unpackStatus(packStatus({ ...kart, item: null, itemN: 0, held: false })); assert.equal(none.it, null); assert.equal(none.he, false);
});

test('statusKey changes on the discrete fields and effect starts, not on motion', () => {
  const k0 = statusKey(kart);
  assert.equal(statusKey({ ...kart, x: 99, vf: 0, h: 2 }), k0);
  assert.notEqual(statusKey({ ...kart, coins: 7 }), k0); assert.notEqual(statusKey({ ...kart, spin: 1.5 }), k0); assert.notEqual(statusKey({ ...kart, item: null, itemN: 0 }), k0);
});

test('hazards round-trip with type, owner, velocity, flight and homing data', () => {
  const red = { id: 5, type: 'red', owner: 2, x: 1.5, z: 2.5, vx: 30, vz: 40, air: 0, fly: false, vy: 0, h: 0.75, target: { id: 1 }, fuse: 0 };
  let h = unpackHaz(JSON.parse(JSON.stringify(packHaz(red))));
  assert.equal(h.id, 5); assert.equal(h.ty, 'red'); assert.equal(h.o, 2); assert.equal(h.vx, 30); assert.equal(h.h, 0.75); assert.equal(h.tg, -1); assert.equal(h.vy, 0);
  const banana = { id: 6, type: 'banana', owner: 0, x: 0, z: 0, vx: 20, vz: 0, air: 1.2, fly: true, vy: 5.5, h: 0, target: null, fuse: 0 };
  h = unpackHaz(packHaz(banana)); assert.equal(h.ty, 'banana'); assert.equal(h.a, 1.2); assert.equal(h.vy, 5.5);
  const blue = { id: 7, type: 'blue', owner: 4, x: 0, z: 0, vx: 0, vz: 68, air: 2.5, fly: false, vy: 0, h: 0, target: 3, fuse: 0 };
  h = unpackHaz(packHaz(blue)); assert.equal(h.tg, 3);
  const bomb = { id: 8, type: 'bomb', owner: 4, x: 0, z: 0, vx: 0, vz: 0, air: 0, fly: false, vy: 0, h: 0, target: null, fuse: 1.234 };
  h = unpackHaz(packHaz(bomb)); assert.equal(h.f, 1.23);
});

test('rates divide evenly', () => { assert.equal(NET_HZ % STATUS_HZ, 0); });
