import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FollowController, State, mix, manualDrive } from '../js/follow.js';

const none = { found: false };
const seen = (cx, size) => ({ found: true, cx, size });
const DT = 66;

// Feed detections one frame apart. dets may be a function of the frame index.
function run(ctrl, dets, t0 = 0, ctx = {}) {
  let out;
  let t = t0;
  const events = [];
  for (let i = 0; i < dets.length; i++) {
    out = ctrl.update(typeof dets[i] === 'function' ? dets[i](i) : dets[i], t, ctx);
    if (out.event) events.push(out.event);
    t += DT;
  }
  return { out, t, events };
}
const still = (n, cx = 0.5, size = 0.2) => Array(n).fill(seen(cx, size));

// Drive the controller until it is stopped in front of a standing person (GREET).
function toGreet(ctrl) {
  const a = run(ctrl, still(25)); // watch, then approach
  assert.equal(a.out.state, State.APPROACH);
  const b = run(ctrl, still(8, 0.5, 0.9), a.t);
  assert.equal(b.out.state, State.GREET);
  return b;
}

test('mix keeps both wheels within 100 and preserves the ratio', () => {
  assert.deepEqual(mix(80, 40), { left: 100, right: 33 });
  assert.deepEqual(mix(0, -30), { left: -30, right: 30 });
});

test('searches by spinning in steps, toward the last seen side', () => {
  const c = new FollowController();
  const a = c.update(none, 0);
  assert.equal(a.state, State.SEARCH);
  assert.ok(a.left > 0 && a.right < 0); // default: spin right
  const b = c.update(none, 400); // inside the pause
  assert.deepEqual([b.left, b.right], [0, 0]);
});

test('rests after the search timeout and then looks again', () => {
  const c = new FollowController({ searchTimeoutMs: 1000, restMs: 2000 });
  c.update(none, 0);
  const r = c.update(none, 1500);
  assert.deepEqual([r.state, r.left, r.right], [State.REST, 0, 0]);
  assert.equal(c.update(none, 4000).state, State.SEARCH);
});

test('stops to watch a person, then approaches one who is standing still', () => {
  const c = new FollowController();
  c.update(none, 0);
  const first = c.update(seen(0.5, 0.2), DT);
  assert.deepEqual([first.state, first.left, first.right], [State.WATCH, 0, 0]);
  const early = run(c, still(6), 2 * DT); // not watched long enough yet
  assert.deepEqual([early.out.state, early.out.left], [State.WATCH, 0]);
  const { out } = run(c, still(20), early.t);
  assert.equal(out.state, State.APPROACH);
  assert.ok(out.left > 30 && out.left === out.right); // centered: straight ahead
});

test('does not chase a walking person', () => {
  const c = new FollowController();
  // walking sideways across the view, far away
  const walk = Array.from({ length: 60 }, (_, i) => seen(0.2 + 0.01 * i, 0.2));
  const { out } = run(c, walk);
  assert.equal(out.state, State.WATCH);
  assert.deepEqual([out.left, out.right], [0, 0]);
  assert.equal(c.moving, true);
});

test('approaches once a walking person stops', () => {
  const c = new FollowController();
  const walk = Array.from({ length: 30 }, (_, i) => seen(0.3 + 0.01 * i, 0.2));
  const a = run(c, walk);
  assert.equal(a.out.state, State.WATCH);
  const b = run(c, still(25, 0.6, 0.2), a.t);
  assert.equal(b.out.state, State.APPROACH);
});

test('stays stopped and greets when a walking person comes close', () => {
  const c = new FollowController();
  const coming = Array.from({ length: 40 }, (_, i) => seen(0.5, 0.15 + 0.016 * i));
  const { out, events } = run(c, coming);
  assert.equal(out.state, State.GREET);
  assert.deepEqual([out.left, out.right], [0, 0]);
  assert.deepEqual(events, ['greet']);
  // never drove toward them on the way
  const c2 = new FollowController();
  let t = 0;
  for (const d of coming) {
    const o = c2.update(d, t);
    assert.deepEqual([o.left, o.right], [0, 0]);
    t += DT;
  }
});

test('looks elsewhere when a walker never comes close', () => {
  const c = new FollowController({ watchMaxMs: 2000 });
  const pacing = Array.from({ length: 60 }, (_, i) => seen(0.5 + 0.2 * Math.sin(i / 3), 0.2));
  const { out, t } = run(c, pacing);
  assert.equal(out.state, State.SEARCH);
  // and does not lock onto the same person again right away
  assert.equal(c.update(seen(0.5, 0.2), t).state, State.SEARCH);
});

test('steers toward a standing person and turns in place when they are far to the side', () => {
  const c = new FollowController();
  const { out: right } = run(c, still(30, 0.7));
  assert.equal(right.state, State.APPROACH);
  assert.ok(right.left > right.right);
  const c2 = new FollowController();
  const { out: hardLeft } = run(c2, still(30, 0.05));
  assert.ok(hardLeft.left < 0 && hardLeft.right > 0);
  assert.equal(hardLeft.left + hardLeft.right, 0); // pure rotation
});

test('slows down as the person gets closer, stops in front of them and greets once', () => {
  const c = new FollowController();
  const far = run(c, still(25)).out.left;
  const near = run(c, still(5, 0.5, 0.65), 2000).out.left;
  assert.ok(near < far && near > 0);
  // the old stop size (60 %) no longer stops it: it keeps coming closer
  const closer = run(c, still(5, 0.5, 0.7), 2500).out;
  assert.ok(closer.state === State.APPROACH && closer.left > 0);
  const { out, events } = run(c, still(8, 0.5, 0.9), 3000);
  assert.deepEqual([out.state, out.left, out.right], [State.GREET, 0, 0]);
  assert.deepEqual(events, ['greet']);
});

test('no response after greeting: turns away, drives on, then searches again', () => {
  const c = new FollowController({ greetWaitMs: 3000, passTurnMs: 600, passDriveMs: 800 });
  const g = toGreet(c);
  const waiting = c.update(seen(0.5, 0.7), g.t + 2000);
  assert.deepEqual([waiting.state, waiting.left, waiting.right], [State.GREET, 0, 0]);
  const t0 = g.t + 3100;
  const pass = c.update(seen(0.5, 0.7), t0);
  assert.deepEqual([pass.state, pass.event], [State.PASS, 'pass']);
  const turning = c.update(none, t0 + 100);
  assert.ok(turning.left + turning.right === 0 && turning.left !== 0); // spinning away
  const driving = c.update(none, t0 + 900);
  assert.ok(driving.left > 0 && driving.left === driving.right); // straight on
  assert.equal(c.update(none, t0 + 1500).state, State.SEARCH);
});

test('stops again when someone is close while driving on', () => {
  const c = new FollowController({ greetWaitMs: 1000, passTurnMs: 300, passDriveMs: 3000 });
  const g = toGreet(c);
  let t = g.t + 1100;
  c.update(none, t); // -> PASS
  t += 400; // past the turn
  assert.ok(c.update(none, t).left > 0);
  const { out, events } = run(c, still(4, 0.5, 0.7), t + DT);
  assert.deepEqual([out.state, out.left, out.right], [State.GREET, 0, 0]);
  assert.deepEqual(events, ['greet']);
});

test('never moves while someone is using the screen, in any state', () => {
  const c = new FollowController();
  const a = run(c, still(25)); // approaching, wheels turning
  assert.ok(a.out.left > 0);
  const busy = run(c, still(40), a.t, { interacting: true });
  assert.deepEqual([busy.out.state, busy.out.left, busy.out.right], [State.ENGAGED, 0, 0]);
  // far longer than the greeting wait: still there
  const later = c.update(seen(0.5, 0.2), busy.t + 60000, { interacting: true });
  assert.deepEqual([later.state, later.left, later.right], [State.ENGAGED, 0, 0]);
  // interaction over: move on
  const done = c.update(seen(0.5, 0.2), busy.t + 60100, { interacting: false });
  assert.deepEqual([done.state, done.event], [State.PASS, 'pass']);
});

test('a touch during the greeting keeps the robot there', () => {
  const c = new FollowController({ greetWaitMs: 3000 });
  const g = toGreet(c);
  const o = c.update(seen(0.5, 0.7), g.t + 5000, { interacting: true });
  assert.deepEqual([o.state, o.left], [State.ENGAGED, 0]);
});

test('short dropouts keep the last command; longer ones stop and search again', () => {
  const c = new FollowController();
  const { out: going, t } = run(c, still(25));
  const dropout = c.update(none, t + 100);
  assert.deepEqual([dropout.left, dropout.right], [going.left, going.right]);
  const lost = c.update(none, t + 600);
  assert.deepEqual([lost.state, lost.left], [State.LOST, 0]);
  assert.equal(c.update(none, t + 2000).state, State.SEARCH);
});

test('manual drive: forward, spin, and car-like reverse turning', () => {
  assert.deepEqual(manualDrive(0, 1, 60), { left: 60, right: 60 });
  assert.deepEqual(manualDrive(1, 0, 60), { left: 42, right: -42 });
  const back = manualDrive(1, -1, 60);
  assert.ok(back.left < back.right && back.left < 0);
});
