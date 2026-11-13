import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFigure, findBlobs, sampleColor, PLA_BASIC_GRAY } from '../js/vision.js';

const W = 160;
const H = 120;

function frame(bg = [200, 120, 60]) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) px.set([...bg, 255], i * 4);
  return px;
}
function rect(px, x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px.set([...rgb, 255], (y * W + x) * 4);
}
const gray = [PLA_BASIC_GRAY.r, PLA_BASIC_GRAY.g, PLA_BASIC_GRAY.b];

test('finds an upright gray figure and reports its position and size', () => {
  const px = frame();
  rect(px, 100, 30, 16, 40, gray); // right of center
  const d = detectFigure(px, W, H);
  assert.ok(d.found);
  assert.ok(Math.abs(d.target.cx - 108 / W) < 0.02);
  assert.ok(Math.abs(d.target.size - 40 / H) < 0.03);
});

test('a darker, shaded figure still matches within tolerance', () => {
  const px = frame();
  rect(px, 40, 30, 14, 36, gray.map((v) => v - 30));
  assert.ok(detectFigure(px, W, H).found);
});

test('colored objects are ignored', () => {
  const px = frame([20, 30, 40]);
  rect(px, 60, 20, 16, 40, [180, 60, 60]);
  rect(px, 90, 20, 16, 40, [60, 150, 60]);
  assert.equal(detectFigure(px, W, H).found, false);
});

test('a wide gray floor band is rejected and the figure above it is chosen', () => {
  const px = frame();
  rect(px, 0, 95, W, 25, gray); // floor
  rect(px, 70, 40, 14, 34, gray); // figure, not touching the floor
  const d = detectFigure(px, W, H);
  assert.ok(d.found);
  assert.ok(Math.abs(d.target.cx - 77 / W) < 0.02);
  assert.equal(d.candidates.length, 1);
});

test('a flat gray box (wrong shape) is rejected', () => {
  const px = frame();
  rect(px, 40, 60, 60, 12, gray);
  assert.equal(detectFigure(px, W, H).found, false);
});

test('tracking prefers the blob near the previous target', () => {
  const px = frame();
  rect(px, 20, 30, 14, 34, gray);
  rect(px, 120, 30, 15, 36, gray); // slightly bigger
  const free = detectFigure(px, W, H);
  assert.ok(free.target.cx > 0.5);
  const tracked = detectFigure(px, W, H, {}, { cx: 27 / W, cy: 47 / H });
  assert.ok(tracked.target.cx < 0.5);
});

test('a close figure cut by the frame edges is still accepted', () => {
  const px = frame();
  rect(px, 50, 0, 70, H, gray); // fills the height, wide
  const d = detectFigure(px, W, H);
  assert.ok(d.found);
  assert.ok(d.target.size > 0.95);
});

test('calibrating on a different gray makes it the reference', () => {
  const px = frame();
  const other = [90, 95, 100];
  rect(px, 60, 30, 14, 36, other);
  assert.equal(detectFigure(px, W, H).found, false);
  const ref = sampleColor(px, W, H, 66, 45);
  assert.deepEqual(ref, { r: 90, g: 95, b: 100 });
  assert.ok(detectFigure(px, W, H, { ref }).found);
});

test('findBlobs separates components and gives inclusive boxes', () => {
  const m = new Uint8Array(10 * 4);
  [0, 1, 10, 11, 8, 9].forEach((i) => (m[i] = 1));
  const b = findBlobs(m, 10, 4);
  assert.equal(b.length, 2);
  assert.deepEqual([b[0].x0, b[0].x1, b[0].y0, b[0].y1, b[0].area], [0, 1, 0, 1, 4]);
});
