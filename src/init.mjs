// `journeyboard init`: sets up a repo in one go. Writes the GitHub workflow and the config file, never overwrites
// either, and prints the one line to add to the Playwright config.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE } from './config.mjs';
import { parseArgs } from './lib.mjs';

export const ACTION_REF = 'romannovosad/journeyboard@v0';
const WORKFLOW = '.github/workflows/journeyboard.yml';
const SITE_WORKFLOW = '.github/workflows/journeyboard-site.yml';

const quiet = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};

/** The Playwright config nearest the repo root, as a path relative to it. */
export function findPlaywrightConfig(root) {
  const queue = [''];

  while (queue.length) {
    const rel = queue.shift();
    const dir = path.join(root, rel);
    let entries = [];

    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const hit = entries.find((e) => e.isFile() && /^playwright\.config\.[cm]?[jt]s$/.test(e.name));

    if (hit) return path.join(rel, hit.name);

    if (rel.split('/').filter(Boolean).length < 3) {
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') queue.push(path.join(rel, e.name));
      }
    }
  }

  return '';
}

export function workflowYaml({ baseBranch, playwrightConfig, packageDir }) {
  const cd = packageDir ? `\n        working-directory: ${packageDir}` : '';
  const lock = packageDir ? `${packageDir}/package-lock.json` : 'package-lock.json';
  const configFlag = playwrightConfig ? ` --config=${path.relative(packageDir || '.', playwrightConfig)}` : '';

  return `# journeyboard: every screen of the app, by user flow, versioned. https://github.com/romannovosad/journeyboard
# On a pull request: runs the tests, stores the screens it changes and comments on the PR with them.
# On a push to ${baseBranch}: the screens become the baseline; the ones they replace go into each screen's history.
name: journeyboard

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
  push:
    branches: [${baseBranch}]

permissions:
  contents: write       # screenshots go to the journeyboard-data branch of this repo
  pull-requests: write  # one comment per PR
  actions: read         # which merged PRs a baseline covers
  pages: read           # the board's address, for the link in the comment

concurrency:
  group: journeyboard-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  screens:
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: ${lock}
      - run: npm ci${cd}
      - run: npx playwright install --with-deps chromium${cd}
      - name: Run the tests, taking screenshots
        run: npx playwright test${configFlag}${cd}
        env:
          JOURNEYBOARD_SHOTS: \${{ runner.temp }}/journeyboard-shots
      # A fork's pull request gets a read-only token, so its screens are not published.
      - if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository
        uses: ${ACTION_REF}
        with:
          command: \${{ github.event_name == 'push' && 'baseline' || 'pr' }}
          shots: \${{ runner.temp }}/journeyboard-shots

  cleanup:
    if: github.event.action == 'closed' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: ${ACTION_REF}
        with:
          command: cleanup
`;
}

export function siteWorkflowYaml() {
  return `# journeyboard board site: rebuilds the board on GitHub Pages whenever new screens land.
# Turn Pages on once: Settings → Pages → Source: GitHub Actions.
name: journeyboard site

on:
  repository_dispatch:
    types: [journeyboard-data-pushed]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: journeyboard-site
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: ${ACTION_REF}
        with:
          command: build
          out: _site
      - uses: actions/upload-pages-artifact@v3
        with:
          path: _site

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
`;
}

/** Writes `file` under `root` unless it is already there; returns what it did, for the summary line. */
function writeOnce(root, file, content) {
  if (existsSync(path.join(root, file))) return `kept your ${file}`;
  mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
  writeFileSync(path.join(root, file), content);

  return `wrote ${file}`;
}

export function init(argv, root = process.cwd()) {
  const args = parseArgs(argv);
  const repoName = path.basename(quiet('git', ['rev-parse', '--show-toplevel']) || root);
  const head = quiet('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  const baseBranch = args.base || head || 'main';
  const playwrightConfig = args.config || findPlaywrightConfig(root);
  const packageDir = playwrightConfig && !existsSync(path.join(root, 'package.json')) ? path.dirname(playwrightConfig) : '';
  const done = [];

  if (!playwrightConfig) {
    console.log('No playwright.config.* found. journeyboard takes its screenshots with Playwright: https://playwright.dev/docs/intro');
    console.log('Set Playwright up first, then run this again (or pass --config path/to/playwright.config.ts).');
    process.exitCode = 1;

    return;
  }

  const config = { title: `${repoName} journeys`, baseBranch, platforms: [{ id: 'web', label: 'Web' }] };

  done.push(writeOnce(root, WORKFLOW, workflowYaml({ baseBranch, playwrightConfig, packageDir })));
  done.push(writeOnce(root, SITE_WORKFLOW, siteWorkflowYaml()));
  done.push(writeOnce(root, CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`));

  console.log(`journeyboard: ${done.join(', ')}.

Last step, in ${playwrightConfig}. Either:

  1. No code changes: every passing test's final screen goes on the board.
       reporter: [['list'], ['journeyboard/reporter']],
       use: { screenshot: 'on' },

  2. Exact control: name the screens yourself.
       import { test } from 'journeyboard/playwright';
       test('sign up', async ({ page, snap }) => {
         await page.goto('/signup');
         await snap('signup/email', { title: 'Enter your email' });
       });

Then: npm i -D journeyboard, commit, and open a pull request. The screens show up in a comment on it.

The board (every screen, by flow, with history): turn on GitHub Pages once, under
Settings → Pages → Source: GitHub Actions. Or: gh api -X POST repos/{owner}/{repo}/pages -f build_type=workflow`);
}
