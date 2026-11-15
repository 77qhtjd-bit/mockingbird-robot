import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDrive, encodeHeight } from '../js/robot-link.js';

test('drive packet: seq little-endian, wheels as clamped int8', () => {
  assert.deepEqual([...encodeDrive(0x1234, 50, -50)], [0x34, 0x12, 50, 206]);
  assert.deepEqual([...encodeDrive(1, 250, -999)], [1, 0, 100, 156]);
  assert.deepEqual([...encodeDrive(2, NaN, 0)], [2, 0, 0, 0]);
});

test('height packet: one byte, 0..100', () => {
  assert.deepEqual([...encodeHeight(62.4)], [62]);
  assert.deepEqual([...encodeHeight(-5)], [0]);
  assert.deepEqual([...encodeHeight(300)], [100]);
  assert.deepEqual([...encodeHeight(NaN)], [0]);
});
