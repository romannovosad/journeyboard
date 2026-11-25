import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { normalizeConfig, platformOrder } from '../src/config.mjs';
import { parseRemote, requestRebuild } from '../src/design.mjs';
import { findPlaywrightConfig, init, workflowYaml } from '../src/init.mjs';
import { readShots } from '../src/lib.mjs';
import Reporter, { flowOf, slug } from '../reporter/index.mjs';
import { tempDir } from './helpers.mjs';

test('config: defaults, string platforms, order, and bad values', () => {
  const c = normalizeConfig({ platforms: ['web', { id: 'ios', label: 'iPhone' }] });

  assert.deepEqual(c.platforms, [
    { id: 'web', label: 'Web', shape: 'landscape' },
    { id: 'ios', label: 'iPhone', shape: 'portrait' },
  ]);
  assert.equal(c.dataBranch, 'journeyboard-data');
  assert.deepEqual(platformOrder(c, ['android', 'ios', 'web']), ['web', 'ios', 'android']);
  assert.throws(() => normalizeConfig({ platforms: ['Web App'] }), /platform/);
  assert.throws(() => normalizeConfig({ dataRepo: 'nope' }), /owner\/repo/);
});

test('config: phone-like platforms get portrait cards on the board, and shape can be set', () => {
  const shapes = (platforms) => normalizeConfig({ platforms }).platforms.map((p) => p.shape);

  assert.deepEqual(shapes(['web', 'desktop', 'tablet', 'mobile', 'phone', 'ios', 'android', 'iphone']), [
    'landscape', 'landscape', 'landscape', 'portrait', 'portrait', 'portrait', 'portrait', 'portrait',
  ]);
  assert.deepEqual(shapes([{ id: 'kiosk', shape: 'portrait' }, { id: 'phone', shape: 'landscape' }]), ['portrait', 'landscape']);
  assert.throws(() => normalizeConfig({ platforms: [{ id: 'web', shape: 'square' }] }), /shape/);
});

test('reporter: names from the file and the titles', () => {
  assert.equal(flowOf('/x/tests/auth/sign-up.spec.ts'), 'sign-up');
  assert.equal(flowOf('/x/checkout.test.js'), 'checkout');
  assert.equal(slug('Pays with Mastercard — 3DS'), 'pays-with-mastercard-3ds');
  assert.equal(slug('Æble øl'), 'ble-l');
  assert.equal(slug('!!!'), 'screen');
});

test('reporter: a passing test with a screenshot becomes a screen readShots accepts', () => {
  const dir = tempDir('rep-');
  const shot = path.join(tempDir('img-'), 'a.png');

  writeFileSync(shot, 'png-bytes');
  const r = new Reporter({ dir });

  r.onBegin({ rootDir: '/repo' });
  const fake = (title, line, status = 'passed', attachments = [{ name: 'screenshot', contentType: 'image/png', path: shot }]) => [
    { titlePath: () => ['', 'chromium', 'signup.spec.ts', 'Sign up', title], location: { file: '/repo/tests/signup.spec.ts', line }, tags: [] },
    { status, attachments },
  ];

  r.onTestEnd(...fake('enters email', 10));
  r.onTestEnd(...fake('picks company', 20));
  r.onTestEnd(...fake('fails', 30, 'failed'));
  r.onTestEnd(...fake('no picture', 40, 'passed', []));

  const shots = readShots(dir);

  assert.deepEqual(shots.map((s) => `${s.flow}/${s.step}`), ['signup/sign-up-enters-email', 'signup/sign-up-picks-company']);
  assert.equal(shots[0].ext, 'png');
  assert.equal(shots[0].title, 'Sign up › enters email');
  assert.equal(shots[0].test, 'tests/signup.spec.ts');
});

test('reporter: does nothing without a shots folder, and filters by tag', () => {
  const dir = tempDir('rep-');
  const shot = path.join(dir, 'a.png');

  writeFileSync(shot, 'x');
  new Reporter({ dir: '' }).onTestEnd(
    { titlePath: () => ['', '', 'f', 't'], location: { file: '/f.spec.ts', line: 1 }, tags: [] },
    { status: 'passed', attachments: [{ name: 'screenshot', contentType: 'image/png', path: shot }] }
  );
  const tagged = new Reporter({ dir, tag: '@journey' });

  tagged.onTestEnd(
    { titlePath: () => ['', '', 'f', 't'], location: { file: '/f.spec.ts', line: 1 }, tags: [] },
    { status: 'passed', attachments: [{ name: 'screenshot', contentType: 'image/png', path: shot }] }
  );
  assert.ok(!existsSync(path.join(dir, 'f')));
});

test('design: reads GitHub remotes in both forms', () => {
  assert.deepEqual(parseRemote('git@github.com:acme/app.git'), { host: 'github.com', slug: 'acme/app', ssh: true });
  assert.deepEqual(parseRemote('https://github.com/acme/app'), { host: 'github.com', slug: 'acme/app', ssh: false });
  assert.deepEqual(parseRemote('https://x-access-token:abc@github.com/acme/app.git'), { host: 'github.com', slug: 'acme/app', ssh: false });
});

test('init: finds the Playwright config and writes the workflow and config once', () => {
  const root = tempDir('init-');

  mkdirSync(path.join(root, 'e2e'));
  writeFileSync(path.join(root, 'package.json'), '{}');
  writeFileSync(path.join(root, 'e2e', 'playwright.config.ts'), 'export default {}');
  assert.equal(findPlaywrightConfig(root), 'e2e/playwright.config.ts');

  const log = console.log;

  console.log = () => {};
  try {
    init(['--base', 'dev'], root);
    writeFileSync(path.join(root, 'journeyboard.config.json'), '{"title":"mine"}');
    init([], root);
  } finally {
    console.log = log;
  }
  const yml = readFileSync(path.join(root, '.github/workflows/journeyboard.yml'), 'utf8');

  assert.match(yml, /branches: \[dev\]/);
  assert.match(yml, /npx playwright test --config=e2e\/playwright\.config\.ts/);
  assert.match(yml, /uses: romannovosad\/journeyboard@v0/);
  assert.match(yml, /pages: read/);
  // A fork's PR gets a read-only token: run the tests, skip publishing.
  assert.match(yml, /if: github\.event_name == 'push' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  const site = readFileSync(path.join(root, '.github/workflows/journeyboard-site.yml'), 'utf8');

  assert.match(site, /types: \[journeyboard-data-pushed\]/);
  assert.match(site, /command: build/);
  assert.match(site, /actions\/deploy-pages@v5/);
  assert.equal(readFileSync(path.join(root, 'journeyboard.config.json'), 'utf8'), '{"title":"mine"}');
});

test('init: a Playwright project in a subfolder runs its commands there', () => {
  const yml = workflowYaml({ baseBranch: 'main', playwrightConfig: 'web/playwright.config.ts', packageDir: 'web' });

  assert.match(yml, /run: npm ci\n\s+working-directory: web/);
  assert.match(yml, /npx playwright test --config=playwright\.config\.ts\n\s+working-directory: web/);
  assert.match(yml, /cache-dependency-path: web\/package-lock\.json/);
});

test('design: asks the data repo to rebuild its site through gh, and shrugs when gh is missing', () => {
  const calls = [];

  assert.equal(requestRebuild('acme/journeys', (cmd, args) => calls.push([cmd, ...args])), true);
  assert.deepEqual(calls, [['gh', 'api', '-X', 'POST', 'repos/acme/journeys/dispatches', '-f', 'event_type=journeyboard-data-pushed']]);
  assert.equal(
    requestRebuild('acme/journeys', () => {
      throw new Error('spawn gh ENOENT');
    }),
    false
  );
});
