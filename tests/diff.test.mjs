// A screen counts as changed only when it looks different, not when its bytes do (JPEG and anti-aliasing noise).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../src/config.mjs';
import { decodeImage, sameScreen } from '../src/image.mjs';
import { readShots } from '../src/lib.mjs';
import { classify, publishBaseline, publishBranch, readBaseline } from '../src/publish.mjs';
import { makeShots, png, tempDir } from './helpers.mjs';

// Rendered by Chromium as JPEG at quality 80, as `snap` writes them (see fixtures/README.md).
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => readFileSync(path.join(FIXTURES, `${name}.jpg`));
const balance = (name) => [{ flow: 'money', step: 'balance', title: 'Balance', body: fixture(name) }];

function seed() {
  const data = tempDir('data-');

  publishBaseline({ data, shots: makeShots(balance('balance')), platform: 'web', commit: 'aaaaaaa', subject: 'x (#1)', date: '2026-11-20T10:00:00Z' });

  return data;
}

function statusOf(name, tolerance) {
  const data = seed();
  const { screens } = classify(readShots(makeShots(balance(name))), readBaseline(data, 'web').screens, {
    baselineDir: path.join(data, 'baseline', 'web'),
    ...(tolerance ? { tolerance } : {}),
  });

  return screens[0].status;
}

test('decodes JPEG and PNG to RGBA pixels', () => {
  const jpeg = decodeImage(fixture('balance'));

  assert.equal(jpeg.width, 320);
  assert.equal(jpeg.height, 96);
  assert.equal(jpeg.data.length, 320 * 96 * 4);

  const image = decodeImage(png(3, 2, (x, y) => [x * 10, y * 20, 30, 255]));

  assert.deepEqual([image.width, image.height], [3, 2]);
  assert.deepEqual([...image.data.subarray((1 * 3 + 2) * 4, (1 * 3 + 2) * 4 + 4)], [20, 20, 30, 255]);
});

test('noise along the sidebar edge reads unchanged', () => {
  assert.equal(statusOf('balance-edge-noise'), 'unchanged');
});

test('a minus sign that disappears reads changed', () => {
  assert.equal(statusOf('balance-no-minus'), 'changed');
});

test('a decimal point that turns into a comma reads changed (five pixels at 1x)', () => {
  assert.equal(statusOf('balance-comma'), 'changed');
});

test('the tolerance is a knob: threshold 0 sees the noise, a pixel allowance hides the comma', () => {
  assert.equal(statusOf('balance-edge-noise', { threshold: 0, maxPixels: 0 }), 'changed');
  assert.equal(statusOf('balance-comma', { threshold: 40, maxPixels: 10 }), 'unchanged');
});

test('PNG pairs: faint differences pass, strong ones and other sizes do not', () => {
  const base = png(4, 4, () => [200, 200, 200, 255]);
  const faint = png(4, 4, (x, y) => (x === 1 && y === 1 ? [230, 200, 200, 255] : [200, 200, 200, 255]));
  const strong = png(4, 4, (x, y) => (x === 1 && y === 1 ? [90, 200, 200, 255] : [200, 200, 200, 255]));
  const wider = png(5, 4, () => [200, 200, 200, 255]);
  const tolerance = { threshold: 40, maxPixels: 0 };

  assert.equal(sameScreen(base, faint, tolerance), true);
  assert.equal(sameScreen(base, strong, tolerance), false);
  assert.equal(sameScreen(base, wider, tolerance), false);
});

test('anything that will not decode falls back to the bytes', () => {
  const tolerance = { threshold: 40, maxPixels: 0 };

  assert.equal(sameScreen(Buffer.from('not an image'), Buffer.from('not an image either'), tolerance), false);
  assert.equal(sameScreen(fixture('balance'), Buffer.from('truncated'), tolerance), false);
});

test('a noise-only baseline run keeps the picture it had and commits nothing', () => {
  const data = seed();
  const before = readFileSync(path.join(data, 'baseline/web/manifest.json'), 'utf8');
  const image = readFileSync(path.join(data, 'baseline/web/money/balance.jpg'));
  const summary = publishBaseline({
    data,
    shots: makeShots(balance('balance-edge-noise')),
    platform: 'web',
    commit: 'bbbbbbb',
    subject: 'y (#2)',
    date: '2026-11-25T10:00:00Z',
  });

  assert.deepEqual(summary, { new: 0, changed: 0, unchanged: 1, removed: 0 });
  assert.equal(readFileSync(path.join(data, 'baseline/web/manifest.json'), 'utf8'), before, 'manifest untouched');
  assert.ok(readFileSync(path.join(data, 'baseline/web/money/balance.jpg')).equals(image), 'baseline picture kept');
});

test('a noise-only PR run lists nothing as changed; a real change still shows', () => {
  const data = seed();
  const noise = publishBranch({ data, shots: makeShots(balance('balance-edge-noise')), repo: 'app', platform: 'web', branch: 'b', commit: 'c' });

  assert.deepEqual(noise, { new: 0, changed: 0, unchanged: 1, removed: 0 });
  const real = publishBranch({ data, shots: makeShots(balance('balance-no-minus')), repo: 'app', platform: 'web', branch: 'b', commit: 'd' });

  assert.deepEqual(real, { new: 0, changed: 1, unchanged: 0, removed: 0 });
});

test('a PR run honours the configured tolerance', () => {
  const data = seed();
  const summary = publishBranch({
    data,
    shots: makeShots(balance('balance-edge-noise')),
    repo: 'app',
    platform: 'web',
    branch: 'b',
    commit: 'c',
    tolerance: { threshold: 0, maxPixels: 0 },
  });

  assert.equal(summary.changed, 1);
});

test('config: the change tolerance has defaults and is checked', () => {
  assert.deepEqual(normalizeConfig({}).changes, { threshold: 40, maxPixels: 0 });
  assert.deepEqual(normalizeConfig({ changes: { maxPixels: 25 } }).changes, { threshold: 40, maxPixels: 25 });
  assert.deepEqual(normalizeConfig({ changes: { threshold: 0 } }).changes, { threshold: 0, maxPixels: 0 });
  assert.throws(() => normalizeConfig({ changes: { threshold: 255 } }), /threshold/);
  assert.throws(() => normalizeConfig({ changes: { threshold: -1 } }), /threshold/);
  assert.throws(() => normalizeConfig({ changes: { threshold: 12.5 } }), /threshold/);
  assert.throws(() => normalizeConfig({ changes: { maxPixels: -3 } }), /maxPixels/);
  assert.throws(() => normalizeConfig({ changes: { maxPixels: '10' } }), /maxPixels/);
  assert.throws(() => normalizeConfig({ changes: { treshold: 30 } }), /treshold/);
  assert.throws(() => normalizeConfig({ changes: 40 }), /changes/);
});
