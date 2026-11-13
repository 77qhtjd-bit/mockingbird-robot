import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FollowController, State, mix, manualDrive } from '../js/follow.js';

const none = { found: false };
const seen = (cx, size) => ({ found: true, cx, size });

function run(ctrl, dets, t0 = 0, dt = 66) {
  let out;
  let t = t0;
  for (const d of dets) {
    out = ctrl.update(d, t);
    t += dt;
  }
  return { out, t };
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

test('holds still while a detection is being confirmed, then approaches', () => {
  const c = new FollowController();
  c.update(none, 0);
  const a = c.update(seen(0.5, 0.2), 66);
  assert.deepEqual([a.state, a.left, a.right], [State.SEARCH, 0, 0]);
  const { out } = run(c, [seen(0.5, 0.2), seen(0.5, 0.2)], 132);
  assert.equal(out.state, State.APPROACH);
  assert.ok(out.left > 30 && out.left === out.right); // centered: straight ahead
});

test('steers toward the figure and turns in place when it is far to the side', () => {
  const c = new FollowController();
  const { out: right } = run(c, Array(6).fill(seen(0.7, 0.2)));
  assert.ok(right.left > right.right);
  const c2 = new FollowController();
  const { out: hardLeft } = run(c2, Array(6).fill(seen(0.05, 0.2)));
  assert.ok(hardLeft.left < 0 && hardLeft.right > 0);
  assert.equal(hardLeft.left + hardLeft.right, 0); // pure rotation
});

test('slows down as the figure grows and stops at stopSize', () => {
  const c = new FollowController();
  const far = run(c, Array(5).fill(seen(0.5, 0.2))).out.left;
  const near = run(c, Array(5).fill(seen(0.5, 0.5)), 1000).out.left;
  assert.ok(near < far && near > 0);
  const { out } = run(c, Array(6).fill(seen(0.5, 0.7)), 2000);
  assert.deepEqual([out.state, out.left, out.right], [State.ARRIVED, 0, 0]);
});

test('short dropouts keep the last command; longer ones stop and search again', () => {
  const c = new FollowController();
  const { out: going, t } = run(c, Array(5).fill(seen(0.5, 0.2)));
  const dropout = c.update(none, t + 100);
  assert.deepEqual([dropout.left, dropout.right], [going.left, going.right]);
  const lost = c.update(none, t + 600);
  assert.deepEqual([lost.state, lost.left], [State.LOST, 0]);
  assert.equal(c.update(none, t + 2000).state, State.SEARCH);
});

test('re-approaches if the figure is moved away after arriving', () => {
  const c = new FollowController();
  const { t } = run(c, Array(6).fill(seen(0.5, 0.7)));
  assert.equal(c.state, State.ARRIVED);
  const { out } = run(c, Array(40).fill(seen(0.5, 0.3)), t);
  assert.equal(out.state, State.APPROACH);
});

test('gives up after the search timeout', () => {
  const c = new FollowController({ searchTimeoutMs: 1000 });
  c.update(none, 0);
  assert.equal(c.update(none, 1500).state, State.GAVE_UP);
  assert.equal(c.update(seen(0.5, 0.2), 1600).left, 0);
});

test('manual drive: forward, spin, and car-like reverse turning', () => {
  assert.deepEqual(manualDrive(0, 1, 60), { left: 60, right: 60 });
  assert.deepEqual(manualDrive(1, 0, 60), { left: 42, right: -42 });
  const back = manualDrive(1, -1, 60);
  assert.ok(back.left < back.right && back.left < 0);
});
