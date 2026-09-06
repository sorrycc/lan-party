/* Dodgeball keeps its matches apart. PLAY AGAIN restarts the host's snapshot numbering at 1 while the last snapshots of
   the finished match are still on the wire, so a client that took one of those would show the old winner and then drop
   every snapshot of the new match until its numbering climbed past the old one - the whole match, for a long match. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, buildRoster } from '../client/games/dodgeball/index.js';

const sfx = new Proxy({}, { get: () => () => {} });
const SESSION = { players: [{ id: 1, name: 'HOST', avatar: 0, team: 'blue' }, { id: 2, name: 'PAL', avatar: 1, team: 'red' }], myId: 2, opts: {} };
const roster = () => buildRoster(SESSION);
const host = matchId => new Game(roster(), { opts: {}, sfx, isHost: true, online: true, myId: 1, matchId });
const client = matchId => new Game(roster(), { opts: {}, sfx, isHost: false, online: true, myId: 2, matchId });
const wire = msg => JSON.parse(JSON.stringify(msg));      // what actually crosses the network
const relay = (from, to, n = 1) => { for (let i = 0; i < n; i++) { from.update(1 / 30); to.applySnapshot(wire(from.packSnapshot())); } };

test('a straggler from the finished match cannot freeze the next one', () => {
  const a = host(0xA11CE), pal = client(0xA11CE);
  relay(a, pal, 30);
  assert.equal(pal.lastSeq, 30);

  a.endRound('blue'); a.endRound('blue');                  // first to 2: the match is over
  assert.equal(a.matchWinner, 'blue');
  for (let i = 0; i < 4000; i++) a.packSnapshot();          // a long match: the counter is far ahead
  const straggler = wire(a.packSnapshot());                 // sent one frame before the host learned about PLAY AGAIN
  assert.equal(straggler.q, 4031);

  const b = host(0xB0B), pal2 = client(0xB0B);              // PLAY AGAIN: every machine builds a new game
  pal2.applySnapshot(straggler);
  assert.equal(pal2.matchWinner, null, 'the old winner must not reappear');
  assert.equal(pal2.lastSeq, -1, 'the sequence guard must not be poisoned');

  relay(b, pal2, 5);
  assert.equal(pal2.lastSeq, 5, 'the new match plays on');
  assert.equal(pal2.round, 1); assert.equal(pal2.matchWinner, null);
  assert.equal(pal2.phase, b.phase);
});

test('a seed of zero is a real match id, not a missing one', () => {
  const a = host(0), pal = client(0), other = host(777);
  pal.applySnapshot(wire(other.packSnapshot()));
  assert.equal(pal.lastSeq, -1, 'a stamped snapshot from another match, whatever its number');
  relay(a, pal, 3);
  assert.equal(pal.lastSeq, 3);

  const pal777 = client(777);                              // and the other way round: a zero stamp is not a wildcard
  pal777.applySnapshot(wire(a.packSnapshot()));
  assert.equal(pal777.lastSeq, -1);
});

test('inside a match the newest snapshot still wins and late ones are dropped', () => {
  const a = host(7), pal = client(7);
  relay(a, pal, 4);
  const late = wire(a.packSnapshot()); late.q = 2;
  pal.applySnapshot(late);
  assert.equal(pal.lastSeq, 4);
});

test('a host from an older build, whose snapshots carry no stamp, is still followed', () => {
  const a = host(7), pal = client(7);
  const msg = wire(a.packSnapshot()); delete msg.mid;
  pal.applySnapshot(msg);
  assert.equal(pal.lastSeq, 1);
});
