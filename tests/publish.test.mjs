// Cases 7 and 8 of jurnie-frontend/specs/journey-map/tasks.md.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { branchSlug, prFromSubject, prsFor, readShots } from '../src/lib.mjs';
import { classify, cleanup, publishBaseline, publishBranch, publishDesign, readBaseline } from '../src/publish.mjs';
import { makeShots, ONBOARDING, tempDir } from './helpers.mjs';

const T0 = '2026-11-20T10:00:00Z';
const T1 = '2026-11-24T12:00:00Z';

function seedBaseline() {
  const data = tempDir('data-');

  publishBaseline({ data, shots: makeShots(ONBOARDING), platform: 'web', commit: 'aaaaaaa1111', subject: 'feat(onboarding): journey (#400)', date: T0 });

  return data;
}

test('branch slugs and PR numbers', () => {
  assert.equal(branchSlug('feature/journey-map'), 'feature~journey-map');
  assert.equal(branchSlug('fix/a b#c'), 'fix~a+20b+23c');
  // One-to-one: these used to share a folder.
  assert.notEqual(branchSlug('a/b'), branchSlug('a--b'));
  assert.notEqual(branchSlug('a b'), branchSlug('a-b'));
  assert.notEqual(branchSlug('a+20b'), branchSlug('a b'));
  assert.equal(prFromSubject('feat(x): y (#123)'), 123);
  assert.equal(prFromSubject('chore: bump version to 1.5.18'), null);
});

test('case 7: classification by hash', () => {
  const baseline = readShots(makeShots(ONBOARDING));
  const run = readShots(
    makeShots([
      ONBOARDING[0],
      { ...ONBOARDING[1], body: 'calendar-v2' },
      ONBOARDING[3],
      { flow: 'onboarding', step: 'invite-team', title: 'Invite your team', body: 'invite-v1' },
    ])
  );
  const { screens, removed } = classify(run, baseline);
  const status = Object.fromEntries(screens.map((s) => [s.step, s.status]));

  assert.deepEqual(status, { welcome: 'unchanged', 'connect-calendar': 'changed', done: 'unchanged', 'invite-team': 'new' });
  assert.deepEqual(removed.map((r) => r.step), ['first-meeting']);
});

test('case 7: a branch run stores only new and changed screens, and replaces the previous run', () => {
  const data = seedBaseline();
  const first = makeShots([{ ...ONBOARDING[0], body: 'welcome-v2' }, ...ONBOARDING.slice(1)]);
  const summary1 = publishBranch({ data, shots: first, repo: 'jurnie-frontend', platform: 'web', branch: 'feature/x', pr: 12, commit: 'bbbbbbb', date: T1 });

  assert.deepEqual(summary1, { new: 0, changed: 1, unchanged: 3, removed: 0 });
  const dir = path.join(data, 'branches/jurnie-frontend/feature~x/web/onboarding');

  assert.deepEqual(readdirSync(dir), ['welcome.jpg']);

  // Second run: welcome is back to the baseline, calendar changed instead.
  const second = makeShots([ONBOARDING[0], { ...ONBOARDING[1], body: 'calendar-v3' }, ...ONBOARDING.slice(2)]);

  publishBranch({ data, shots: second, repo: 'jurnie-frontend', platform: 'web', branch: 'feature/x', commit: 'ccccccc', date: T1 });
  assert.deepEqual(readdirSync(dir), ['connect-calendar.jpg']);
  const record = JSON.parse(readFileSync(path.join(data, 'branches/jurnie-frontend/feature~x/branch.json'), 'utf8'));

  assert.equal(record.pr, 12, 'keeps the PR number from the earlier run');
  assert.equal(record.commit, 'ccccccc');
  assert.equal(record.platforms.web.screens.find((s) => s.step === 'welcome').status, 'unchanged');
  assert.ok(!('source' in record.platforms.web.screens[0]), 'no local paths leak into the manifest');
});

test('case 8: baseline moves replaced and removed versions to history', () => {
  const data = seedBaseline();
  const before = readBaseline(data, 'web');

  assert.equal(before.screens.length, 4);
  assert.equal(before.screens[0].addedPr, 400);

  const run = makeShots([ONBOARDING[0], { ...ONBOARDING[1], body: 'calendar-v2' }, ONBOARDING[3]]);
  const summary = publishBaseline({ data, shots: run, platform: 'web', commit: 'ddddddd2222', subject: 'feat(onboarding): calendar step (#455)', date: T1 });

  assert.deepEqual(summary, { new: 0, changed: 1, unchanged: 2, removed: 1 });
  const after = readBaseline(data, 'web');
  const calendar = after.screens.find((s) => s.step === 'connect-calendar');

  assert.equal(calendar.addedPr, 400);
  assert.equal(calendar.updatedPr, 455);
  assert.equal(calendar.updatedAt, T1);
  assert.equal(after.screens.find((s) => s.step === 'welcome').updatedPr, 400, 'unchanged screens keep their dates');
  assert.equal(readFileSync(path.join(data, 'baseline/web/onboarding/connect-calendar.jpg'), 'utf8'), 'calendar-v2');

  const histDir = path.join(data, 'history/web/onboarding/connect-calendar');
  const files = readdirSync(histDir).sort();

  assert.deepEqual(files, ['20261124T120000Z-ddddddd.jpg', '20261124T120000Z-ddddddd.json']);
  const entry = JSON.parse(readFileSync(path.join(histDir, files[1]), 'utf8'));

  assert.equal(entry.kind, 'replaced');
  assert.equal(entry.currentFromPr, 400);
  assert.equal(entry.endedByPr, 455);
  assert.equal(readFileSync(path.join(histDir, files[0]), 'utf8'), 'calendar-v1');

  const gone = JSON.parse(readFileSync(path.join(data, 'history/web/onboarding/first-meeting/20261124T120000Z-ddddddd.json'), 'utf8'));

  assert.equal(gone.kind, 'removed');
  assert.ok(!existsSync(path.join(data, 'baseline/web/onboarding/first-meeting.jpg')));
});

test('case 8: an unchanged run writes nothing', () => {
  const data = seedBaseline();
  const manifest = path.join(data, 'baseline/web/manifest.json');
  const before = readFileSync(manifest, 'utf8');
  const summary = publishBaseline({ data, shots: makeShots(ONBOARDING), platform: 'web', commit: 'eeeeeee', subject: 'fix(api): z (#460)', date: T1 });

  assert.deepEqual(summary, { new: 0, changed: 0, unchanged: 4, removed: 0 });
  assert.equal(readFileSync(manifest, 'utf8'), before);
  assert.ok(!existsSync(path.join(data, 'history')));
});

test('case 8: refuses to remove most of the baseline unless asked', () => {
  const data = seedBaseline();
  const run = makeShots([ONBOARDING[0]]);

  assert.throws(() => publishBaseline({ data, shots: run, platform: 'web', commit: 'f', date: T1 }), /refusing to remove 3 of 4/);
  assert.doesNotThrow(() => publishBaseline({ data, shots: run, platform: 'web', commit: 'f', date: T1, allowMassRemoval: true }));
});

test('two tests claiming one screen name is an error; a retry of the same test is not', () => {
  const clash = makeShots([
    { ...ONBOARDING[0], testTitle: 'a', worker: 0 },
    { ...ONBOARDING[0], testTitle: 'b', worker: 1 },
  ]);

  assert.throws(() => readShots(clash), /taken by two tests/);
  const retry = makeShots([
    { ...ONBOARDING[0], worker: 0 },
    { ...ONBOARDING[0], worker: 1 },
  ]);

  assert.equal(readShots(retry).length, 1);
});

test('design publish validates targets and copies the files', () => {
  const data = tempDir('data-');
  const dir = tempDir('design-');

  mkdirSync(path.join(dir, 'a'));
  writeFileSync(path.join(dir, 'a/index.html'), '<h1>A</h1>');
  writeFileSync(path.join(dir, 'a/welcome.png'), 'png');
  writeFileSync(
    path.join(dir, 'design.json'),
    JSON.stringify({
      options: [{ id: 'a', title: 'Like Otter', html: 'a/index.html' }],
      targets: [{ platform: 'web', flow: 'onboarding', step: 'welcome', option: 'a', image: 'a/welcome.png' }],
    })
  );
  assert.deepEqual(publishDesign({ data, dir, repo: 'jurnie-frontend', branch: 'feature/x', date: T1 }), { options: 1, targets: 1 });
  assert.ok(existsSync(path.join(data, 'design/jurnie-frontend/feature~x/a/welcome.png')));

  writeFileSync(
    path.join(dir, 'design.json'),
    JSON.stringify({ options: [{ id: 'a' }], targets: [{ platform: 'web', flow: 'onboarding', step: 'welcome', option: 'b', image: 'a/welcome.png' }] })
  );
  assert.throws(() => publishDesign({ data, dir, repo: 'jurnie-frontend', branch: 'feature/x' }), /unknown option "b"/);

  writeFileSync(
    path.join(dir, 'design.json'),
    JSON.stringify({ options: [{ id: 'a' }], targets: [{ platform: 'web', flow: 'onboarding', step: 'welcome', option: 'a', image: '../../etc/passwd.png' }] })
  );
  assert.throws(() => publishDesign({ data, dir, repo: 'jurnie-frontend', branch: 'feature/x' }), /missing or outside/);
});

test('cleanup removes the branch and its mockups', () => {
  const data = seedBaseline();

  publishBranch({ data, shots: makeShots(ONBOARDING), repo: 'jurnie-frontend', platform: 'web', branch: 'feature/x', commit: 'b', date: T1 });
  mkdirSync(path.join(data, 'design/jurnie-frontend/feature~x'), { recursive: true });
  assert.deepEqual(cleanup({ data, repo: 'jurnie-frontend', branch: 'feature/x' }).removed, [
    'branches/jurnie-frontend/feature~x',
    'design/jurnie-frontend/feature~x',
  ]);
  assert.ok(existsSync(path.join(data, 'baseline/web/manifest.json')), 'the baseline stays');
  assert.throws(() => cleanup({ data, repo: '../x', branch: 'y' }), /not a plain repository name/);
});

test('case 8: a baseline run that covers several merges credits every PR', () => {
  const data = seedBaseline();
  const run = makeShots([ONBOARDING[0], { ...ONBOARDING[1], body: 'calendar-v3' }, ONBOARDING[2], ONBOARDING[3]]);

  publishBaseline({ data, shots: run, platform: 'web', commit: 'eeeeeee3333', subject: 'fix(x): last one (#458)', prs: '457,458', date: T1 });
  const calendar = readBaseline(data, 'web').screens.find((s) => s.step === 'connect-calendar');

  assert.deepEqual(calendar.updatedPr, [457, 458]);
  const histDir = path.join(data, 'history/web/onboarding/connect-calendar');
  const entry = JSON.parse(readFileSync(path.join(histDir, readdirSync(histDir).find((f) => f.endsWith('.json'))), 'utf8'));

  assert.deepEqual(entry.endedByPr, [457, 458]);
  assert.equal(prsFor({ prs: '459', subject: '' }), 459);
  assert.equal(prsFor({ prs: '', subject: 'feat: y (#460)' }), 460);
});
