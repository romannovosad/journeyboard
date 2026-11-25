// Cases 17, 18 and 20 of jurnie-frontend/specs/journey-map/tasks.md (amendment 1, the journey board).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildIndex } from '../src/build-site.mjs';
import { buildBoard, edgesFor } from '../src/board.mjs';
import { renderComment } from '../src/comment.mjs';
import { readShots } from '../src/lib.mjs';
import { publishBaseline, publishBranch, publishDesign } from '../src/publish.mjs';
import { makeShots, tempDir } from './helpers.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeConfig } from '../src/config.mjs';

// Jurnie's three platforms, in its order.
const JURNIE = normalizeConfig({ baseBranch: 'dev', platforms: ['web', 'desktop', 'mobile'] });

const WALK = 'tests/onboarding/web-journey.spec.ts';
const INSTALL = 'tests/onboarding/install.spec.ts';

/**
 * One test walks a → b → c → meetings/list. A second test branches off b to install. In a third, `c` names
 * `from: onboarding/b`, the arrow the walk already makes. `onboarding/gone` names a screen nobody captures.
 */
const SCREENS = [
  { flow: 'onboarding', step: 'a', test: WALK, testTitle: 'walk', order: 0 },
  { flow: 'onboarding', step: 'b', test: WALK, testTitle: 'walk', order: 1 },
  { flow: 'onboarding', step: 'c', test: WALK, testTitle: 'walk', order: 2, from: 'onboarding/b' },
  { flow: 'meetings', step: 'list', test: WALK, testTitle: 'walk', order: 3 },
  { flow: 'onboarding', step: 'install', test: INSTALL, testTitle: 'install', order: 0, from: 'onboarding/b' },
  { flow: 'onboarding', step: 'install-done', test: INSTALL, testTitle: 'install', order: 1 },
  { flow: 'settings', step: 'orphan', test: 'tests/x.spec.ts', testTitle: 'x', order: 0, from: 'onboarding/gone' },
];

const pairs = (arrows) => arrows.map((a) => `${a.from} → ${a.to}`);

test('case 17: arrows follow the walk and from, each once, none to a screen nobody captures', () => {
  assert.deepEqual(pairs(edgesFor(SCREENS)).sort(), [
    'onboarding/a → onboarding/b',
    'onboarding/b → onboarding/c',
    'onboarding/b → onboarding/install',
    'onboarding/c → meetings/list',
    'onboarding/install → onboarding/install-done',
  ]);
});

test('case 17: readShots keeps from and refuses one that is not flow/step', () => {
  const shots = makeShots([
    { flow: 'onboarding', step: 'b', body: 'b', test: WALK, testTitle: 'walk', order: 0 },
    { flow: 'onboarding', step: 'install', body: 'i', test: INSTALL, testTitle: 'install', order: 0, from: 'onboarding/b' },
  ]);

  assert.equal(readShots(shots).find((s) => s.step === 'install').from, 'onboarding/b');
  assert.equal('from' in readShots(shots).find((s) => s.step === 'b'), false, 'no from, no field');

  const bad = makeShots([{ flow: 'onboarding', step: 'x', body: 'x', from: 'Onboarding/B' }]);

  assert.throws(() => readShots(bad), /from "Onboarding\/B"/);
});

test('case 18: lanes in walking order, a fork stacks, no overlaps, the same every time', () => {
  const board = buildBoard({ screens: SCREENS });
  const card = (key) => board.cards.find((c) => c.key === key);

  assert.deepEqual(board.lanes.map((l) => l.flow), ['onboarding', 'meetings', 'settings']);
  assert.deepEqual([card('onboarding/a').col, card('onboarding/b').col, card('onboarding/c').col], [0, 1, 2]);
  assert.equal(card('onboarding/install').col, card('onboarding/c').col, 'c and install share a column');
  assert.notEqual(card('onboarding/install').row, card('onboarding/c').row, 'on different rows');
  assert.equal(card('onboarding/install-done').row, card('onboarding/install').row, 'a chain stays on its row');
  assert.equal(card('onboarding/c').row, card('onboarding/b').row, 'the main walk stays straight');

  const cells = board.cards.map((c) => `${c.col},${c.row}`);

  assert.equal(new Set(cells).size, cells.length, 'no two cards share a cell');

  for (const lane of board.lanes) {
    for (const c of board.cards.filter((x) => x.flow === lane.flow)) {
      assert.ok(c.row >= lane.row && c.row < lane.row + lane.rows, `${c.key} sits inside its lane`);
    }
  }
  assert.ok(board.lanes.every((l, i) => i === 0 || l.row === board.lanes[i - 1].row + board.lanes[i - 1].rows));
  assert.deepEqual(buildBoard({ screens: [...SCREENS].reverse() }), board, 'input order does not matter');
});

test('case 18: a cycle made with from still lays out', () => {
  const board = buildBoard({
    screens: [
      { flow: 'x', step: 'a', test: 't1', order: 0, from: 'x/c' },
      { flow: 'x', step: 'b', test: 't1', order: 1 },
      { flow: 'x', step: 'c', test: 't2', order: 0, from: 'x/b' },
    ],
  });

  assert.equal(board.cards.length, 3);
  assert.equal(board.arrows.length, 3, 'every arrow is still drawn');
});

/** dev has the walk; the branch changes b and adds a screen off b; a mockup targets b, another a screen not built. */
function branchFixture() {
  const data = tempDir('data-');
  const walk = [
    { flow: 'onboarding', step: 'a', body: 'a', test: WALK, testTitle: 'walk', order: 0 },
    { flow: 'onboarding', step: 'b', body: 'b', test: WALK, testTitle: 'walk', order: 1 },
    { flow: 'onboarding', step: 'c', body: 'c', test: WALK, testTitle: 'walk', order: 2 },
  ];

  publishBaseline({ data, shots: makeShots(walk), platform: 'web', commit: 'aaaaaaa', subject: 'x (#400)', date: '2026-11-20T10:00:00Z' });
  publishBranch({
    data,
    shots: makeShots([
      walk[0],
      { ...walk[1], body: 'b2' },
      walk[2],
      { flow: 'onboarding', step: 'install', body: 'i', test: INSTALL, testTitle: 'install', order: 0, from: 'onboarding/b' },
    ]),
    repo: 'jurnie-frontend',
    platform: 'web',
    branch: 'feature/install',
    pr: 480,
    commit: 'c0ffee1',
    date: '2026-11-24T12:00:00Z',
  });
  const dir = tempDir('design-');

  mkdirSync(path.join(dir, 'a'));
  writeFileSync(path.join(dir, 'a/b.png'), 'png');
  writeFileSync(path.join(dir, 'a/later.png'), 'png');
  writeFileSync(
    path.join(dir, 'design.json'),
    JSON.stringify({
      options: [{ id: 'a', title: 'Like Linear' }],
      targets: [
        { platform: 'web', flow: 'onboarding', step: 'b', option: 'a', image: 'a/b.png' },
        { platform: 'web', flow: 'onboarding', step: 'later', option: 'a', image: 'a/later.png' },
      ],
    })
  );
  publishDesign({ data, dir, repo: 'jurnie-frontend', branch: 'feature/install', date: '2026-11-24T12:00:00Z' });

  return data;
}

test('case 20: a branch board marks its screens, places the new one through its arrow, mockups by their target', () => {
  const index = buildIndex(branchFixture(), 'now');
  const dev = index.platforms.web.board;
  const board = index.branches[0].boards.web;
  const card = (key) => board.cards.find((c) => c.key === key);

  assert.deepEqual(dev.cards.map((c) => c.key), ['onboarding/a', 'onboarding/b', 'onboarding/c']);
  assert.equal(dev.cards[0].image, 'data/baseline/web/onboarding/a.jpg');

  assert.equal(card('onboarding/b').status, 'changed');
  assert.equal(card('onboarding/b').image, 'data/branches/jurnie-frontend/feature~install/web/onboarding/b.jpg');
  assert.equal(card('onboarding/install').status, 'new');
  assert.equal(card('onboarding/a').status, 'unchanged');
  assert.equal(card('onboarding/install').col, card('onboarding/b').col + 1, 'the new screen hangs off b');
  assert.ok(board.arrows.some((a) => a.from === 'onboarding/b' && a.to === 'onboarding/install'));

  const [mockup, unbuilt] = board.mockups;

  assert.equal(mockup.target, 'onboarding/b');
  assert.equal(mockup.col, card('onboarding/b').col, 'the mockup sits by its target');
  assert.equal(mockup.image, 'data/design/jurnie-frontend/feature~install/a/b.png');
  assert.equal(unbuilt.target, 'onboarding/later');
  assert.equal(board.lanes.at(-1).flow, null, 'a mockup with no screen yet gets its own lane');
  assert.ok(unbuilt.row >= board.lanes.at(-1).row);

  const cells = [...board.cards, ...board.mockups].map((c) => `${c.col},${c.row}`);

  assert.equal(new Set(cells).size, cells.length, 'no overlaps with mockups either');
});

test('case 20: a design-only branch puts its mockups on the dev board', () => {
  const data = branchFixture();
  const index = buildIndex(data, 'now');

  // The same mockups for a branch that has no screenshots yet.
  publishDesign({ data, dir: path.join(data, 'design/jurnie-frontend/feature~install'), repo: 'jurnie-frontend', branch: 'feature/idea' });
  const idea = buildIndex(data, 'now').branches.find((b) => b.branch === 'feature/idea');

  assert.deepEqual(idea.boards.web.cards.map((c) => c.key), index.platforms.web.board.cards.map((c) => c.key));
  assert.ok(idea.boards.web.cards.every((c) => c.status === 'unchanged'));
  assert.equal(idea.boards.web.mockups[0].target, 'onboarding/b');
});

test('case 20: the comment links the board, focused on the first changed screen', () => {
  const md = renderComment({ data: branchFixture(), repo: 'jurnie-frontend', branch: 'feature/install', dataCommit: 'd', dataRepo: 'acme/journeys', config: JURNIE, siteUrl: 'https://example.pages.github.io/' });

  assert.match(md, /\[Open this branch in the map\]\(https:\/\/example\.pages\.github\.io\/\?branch=jurnie-frontend\/feature~install&focus=onboarding\/b&platform=web\)/);
});

test('case 20: the link names the platform whose screen changed, whichever CI job published first', () => {
  const data = tempDir('data-');
  const screens = (welcome) => [{ flow: 'onboarding', step: 'welcome', body: welcome }, { flow: 'onboarding', step: 'next', body: 'n' }];

  publishBaseline({ data, shots: makeShots(screens('w1')), platform: 'web', commit: 'a' });
  publishBaseline({ data, shots: makeShots(screens('w1')), platform: 'desktop', commit: 'a' });
  // Desktop publishes first and changes nothing; web changes the shared screen name.
  publishBranch({ data, shots: makeShots(screens('w1')), repo: 'jurnie-frontend', platform: 'desktop', branch: 'feat/x', commit: 'b' });
  publishBranch({ data, shots: makeShots(screens('w2')), repo: 'jurnie-frontend', platform: 'web', branch: 'feat/x', commit: 'b' });
  const md = renderComment({ data, repo: 'jurnie-frontend', branch: 'feat/x', dataCommit: 'd', dataRepo: 'acme/journeys', config: JURNIE, siteUrl: 'https://s' });
  const query = new URL(/\]\((https:\/\/s[^)]*)\)/.exec(md)[1]).searchParams;

  assert.equal(query.get('focus'), 'onboarding/welcome');
  assert.equal(query.get('platform'), 'web');
});

test('case 20: the link survives a branch name with characters a query string reads differently', () => {
  const data = tempDir('data-');

  publishBranch({ data, shots: makeShots([{ flow: 'x', step: 'a', body: 'a' }]), repo: 'jurnie-frontend', platform: 'web', branch: 'fix/a+b c', commit: 'x' });
  const md = renderComment({ data, repo: 'jurnie-frontend', branch: 'fix/a+b c', dataCommit: 'd', dataRepo: 'acme/journeys', config: JURNIE, siteUrl: 'https://s' });
  const href = /\]\((https:\/\/s[^)]*)\)/.exec(md)[1];
  const query = new URL(href).searchParams;

  assert.equal(query.get('branch'), 'jurnie-frontend/fix~a+2bb+20c');
  assert.equal(query.get('focus'), 'x/a');
});
