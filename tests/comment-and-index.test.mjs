// Cases 9 and 10 of jurnie-frontend/specs/journey-map/tasks.md.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { buildIndex, buildSite } from '../src/build-site.mjs';
import { MARKER, renderComment } from '../src/comment.mjs';
import { normalizeConfig } from '../src/config.mjs';

// Jurnie, the tool's first user, compares against `dev`.
const config = normalizeConfig({ baseBranch: 'dev' });
import { publishBaseline, publishBranch, publishDesign } from '../src/publish.mjs';
import { makeShots, ONBOARDING, tempDir } from './helpers.mjs';

const T0 = '2026-11-20T10:00:00Z';
const T1 = '2026-11-24T12:00:00Z';
const SITE = 'https://example.pages.github.io';

/** dev has the 4 onboarding screens; a later merge changed the calendar step; a branch changes welcome and adds a step. */
function fixture() {
  const data = tempDir('data-');

  publishBaseline({ data, shots: makeShots(ONBOARDING), platform: 'web', commit: 'aaaaaaa', subject: 'feat(onboarding): journey (#400)', date: T0 });
  publishBaseline({
    data,
    shots: makeShots([ONBOARDING[0], { ...ONBOARDING[1], body: 'calendar-v2' }, ...ONBOARDING.slice(2)]),
    platform: 'web',
    commit: 'bbbbbbb',
    subject: 'feat(onboarding): calendar step (#455)',
    date: T1,
  });
  publishBranch({
    data,
    shots: makeShots([
      { ...ONBOARDING[0], body: 'welcome-v2' },
      { ...ONBOARDING[1], body: 'calendar-v2' },
      ONBOARDING[2],
      { flow: 'onboarding', step: 'invite-team', title: 'Invite | your team', body: 'invite', order: 3 },
    ]),
    repo: 'jurnie-frontend',
    platform: 'web',
    branch: 'feature/welcome',
    pr: 470,
    commit: 'c0ffee1234567',
    date: T1,
  });

  return data;
}

function addDesign(data) {
  const dir = tempDir('design-');

  mkdirSync(path.join(dir, 'a'));
  writeFileSync(path.join(dir, 'a/index.html'), '<h1>A</h1>');
  writeFileSync(path.join(dir, 'a/welcome.png'), 'png');
  writeFileSync(
    path.join(dir, 'design.json'),
    JSON.stringify({
      options: [{ id: 'a', title: 'Like Otter, summary first', html: 'a/index.html' }],
      targets: [{ platform: 'web', flow: 'onboarding', step: 'welcome', option: 'a', image: 'a/welcome.png' }],
    })
  );
  publishDesign({ data, dir, repo: 'jurnie-frontend', branch: 'feature/welcome', date: T1 });
}

test('case 9: the comment lists changed, new and removed screens with pinned images', () => {
  const data = fixture();
  const md = renderComment({ data, repo: 'jurnie-frontend', branch: 'feature/welcome', dataCommit: 'deadbeef', dataRepo: 'acme/journeys', config, siteUrl: `${SITE}/` });

  assert.ok(md.startsWith(MARKER));
  assert.match(md, /\*\*Web:\*\* 1 changed, 1 new, 1 removed/);
  assert.match(md, /\[Open this branch in the map\]\(https:\/\/example\.pages\.github\.io\/\?branch=jurnie-frontend\/feature~welcome&focus=onboarding\/welcome&platform=web\)/);
  assert.match(md, /#### Web: changed[\s\S]*`onboarding\/welcome`/);
  assert.match(
    md,
    /blob\/deadbeef\/baseline\/web\/onboarding\/welcome\.jpg\?raw=true[\s\S]*blob\/deadbeef\/branches\/jurnie-frontend\/feature~welcome\/web\/onboarding\/welcome\.jpg\?raw=true/
  );
  assert.match(md, /#### Web: new[\s\S]*`onboarding\/invite-team`<br>Invite \\\| your team/, 'pipes in titles are escaped');
  assert.match(md, /#### Web: no longer captured\n\n- `onboarding\/done` All set/);
  assert.doesNotMatch(md, /Design vs built/);
});

test('case 9: design vs built pairs a mockup with the screen it targets', () => {
  const data = fixture();

  addDesign(data);
  const md = renderComment({ data, repo: 'jurnie-frontend', branch: 'feature/welcome', dataCommit: 'deadbeef', dataRepo: 'acme/journeys', config });

  assert.match(md, /#### Design vs built/);
  assert.match(md, /design\/jurnie-frontend\/feature~welcome\/a\/welcome\.png\?raw=true[^|]*<br>Option Like Otter, summary first \| <img src="[^"]*branches\/jurnie-frontend\/feature~welcome\/web\/onboarding\/welcome\.jpg/);
});

test('case 9: a branch without changes says so in one line', () => {
  const data = fixture();

  publishBranch({ data, shots: makeShots([ONBOARDING[0], { ...ONBOARDING[1], body: 'calendar-v2' }, ...ONBOARDING.slice(2)]), repo: 'jurnie-frontend', platform: 'web', branch: 'fix/typo', commit: 'abc', date: T1 });
  const md = renderComment({ data, repo: 'jurnie-frontend', branch: 'fix/typo', dataCommit: 'deadbeef', dataRepo: 'acme/journeys', config });

  assert.match(md, /\*\*Web:\*\* no screen changes against dev\./);
  assert.doesNotMatch(md, /<img/);
});

test('case 9: long lists are capped', () => {
  const data = tempDir('data-');
  const many = Array.from({ length: 30 }, (_, i) => ({ flow: 'settings', step: `s-${i}`, body: `v${i}`, order: i }));

  publishBranch({ data, shots: makeShots(many), repo: 'jurnie-frontend', platform: 'web', branch: 'big', commit: 'x', date: T1 });
  const md = renderComment({ data, repo: 'jurnie-frontend', branch: 'big', dataCommit: 'd', dataRepo: 'acme/journeys', config, siteUrl: SITE, maxRows: 25 });

  assert.equal((md.match(/<img/g) ?? []).length, 25);
  assert.match(md, /…and 5 more, see \[the map\]/);
});

test('case 10: the index has flows in order, history, removed screens, branches and designs', () => {
  const data = fixture();

  addDesign(data);
  const index = buildIndex(data, T1);
  const web = index.platforms.web;

  assert.deepEqual(web.flows.map((f) => f.flow), ['onboarding']);
  assert.deepEqual(web.flows[0].steps.map((s) => s.step), ['welcome', 'connect-calendar', 'first-meeting', 'done']);
  const calendar = web.flows[0].steps[1];

  assert.equal(calendar.image, 'data/baseline/web/onboarding/connect-calendar.jpg');
  assert.equal(calendar.history.length, 1);
  assert.equal(calendar.history[0].endedByPr, 455);
  assert.match(calendar.history[0].image, /^data\/history\/web\/onboarding\/connect-calendar\/20261124T120000Z-bbbbbbb\.jpg$/);
  assert.deepEqual(web.removed, []);

  assert.equal(index.branches.length, 1);
  const branch = index.branches[0];

  assert.equal(branch.pr, 470);
  assert.equal(branch.platforms.web.screens.find((s) => s.step === 'welcome').image, 'data/branches/jurnie-frontend/feature~welcome/web/onboarding/welcome.jpg');
  assert.equal(branch.platforms.web.screens.find((s) => s.step === 'first-meeting').image, 'data/baseline/web/onboarding/first-meeting.jpg');
  assert.equal(branch.design.targets[0].image, 'data/design/jurnie-frontend/feature~welcome/a/welcome.png');
  assert.equal(branch.design.options[0].html, 'data/design/jurnie-frontend/feature~welcome/a/index.html');
});

test('case 10: removed screens stay browsable through history', () => {
  const data = fixture();

  publishBaseline({ data, shots: makeShots(ONBOARDING.slice(0, 3)), platform: 'web', commit: 'eeeeeee', subject: 'x (#480)', date: '2026-11-25T09:00:00Z' });
  const web = buildIndex(data).platforms.web;

  assert.deepEqual(web.removed.map((r) => r.step), ['done']);
  assert.equal(web.removed[0].history[0].kind, 'removed');
});

test('buildSite copies the viewer and data and writes index.json', () => {
  const data = fixture();
  const out = path.join(tempDir('site-'), '_site');

  buildSite({ data, out });
  assert.ok(existsSync(path.join(out, 'index.html')));
  assert.ok(existsSync(path.join(out, 'data/baseline/web/onboarding/welcome.jpg')));
  assert.equal(JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8')).branches.length, 1);
});
