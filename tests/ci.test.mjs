import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { ciBaseline, ciBuild, ciCleanup, ciPr, prsFromMessages, settings } from '../src/ci.mjs';
import { MARKER } from '../src/comment.mjs';
import { makeShots, ONBOARDING, tempDir } from './helpers.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** A fake GitHub API: PRs with a state, issue comments, dispatches, workflow runs. Records every write. */
async function fakeGitHub({ prs = {}, pages = '' } = {}) {
  const comments = [];
  const writes = [];
  const server = http.createServer((req, res) => {
    let body = '';

    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      const url = new URL(req.url, 'http://x');
      let m;

      writes.push(req.method !== 'GET' ? { method: req.method, path: url.pathname, body: body && JSON.parse(body) } : null);

      if ((m = /^\/repos\/acme\/app\/pulls\/(\d+)$/.exec(url.pathname))) {
        return send(200, { number: Number(m[1]), state: prs[m[1]] ?? 'closed', merged: false });
      }

      if ((m = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(url.pathname))) {
        if (req.method === 'POST') {
          const c = { id: comments.length + 1, body: JSON.parse(body).body, user: { type: 'Bot' } };

          comments.push(c);
          return send(201, c);
        }
        return send(200, comments);
      }

      if ((m = /^\/repos\/acme\/app\/issues\/comments\/(\d+)$/.exec(url.pathname))) {
        comments[Number(m[1]) - 1].body = JSON.parse(body).body;
        return send(200, comments[Number(m[1]) - 1]);
      }

      if (url.pathname === '/repos/acme/app/pages') return pages ? send(200, { html_url: pages }) : send(404, { message: 'Not Found' });
      if (url.pathname === '/repos/acme/app/dispatches') return send(204);
      if (url.pathname.includes('/actions/workflows/')) return send(200, { workflow_runs: [] });

      return send(404, { message: 'not found' });
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));

  return { url: `http://127.0.0.1:${server.address().port}`, comments, writes, close: () => server.close() };
}

function setup(api, event, extra = {}) {
  const root = tempDir('ci-');
  const remotes = path.join(root, 'remotes');

  mkdirSync(path.join(remotes, 'acme'), { recursive: true });
  git(root, 'init', '-q', '--bare', path.join(remotes, 'acme', 'app.git'));
  const eventPath = path.join(root, 'event.json');
  const workspace = path.join(root, 'ws');

  mkdirSync(workspace);
  writeFileSync(eventPath, JSON.stringify(event));

  const env = (more = {}) => ({
    GITHUB_REPOSITORY: 'acme/app',
    GITHUB_SERVER_URL: pathToFileURL(remotes).href,
    GITHUB_API_URL: api.url,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: workspace,
    GITHUB_SHA: 'c0ffee0000000000000000000000000000000000',
    GITHUB_REF_NAME: 'main',
    GITHUB_WORKFLOW_REF: 'acme/app/.github/workflows/journeyboard.yml@refs/heads/main',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    JB_GITHUB_TOKEN: 'test-token',
    ...extra,
    ...more,
  });
  const remoteFiles = () =>
    git(root, '--git-dir', path.join(remotes, 'acme', 'app.git'), 'ls-tree', '-r', '--name-only', 'journeyboard-data').split('\n');

  return { root, workspace, eventPath, env, remoteFiles };
}

const quietly = async (fn) => {
  const log = console.log;

  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

test('prsFromMessages reads squash-merge subjects', () => {
  assert.deepEqual(prsFromMessages(['feat: a (#12)', 'fix: b (#3)\n\nbody', 'chore: no pr', 'feat: a again (#12)']), [3, 12]);
});

test('settings default to the repo the action runs in', () => {
  const s = settings({ GITHUB_REPOSITORY: 'acme/app', GITHUB_WORKSPACE: tempDir(), JB_TOKEN: 't' });

  assert.equal(s.config.dataRepo, 'acme/app');
  assert.equal(s.config.dataBranch, 'journeyboard-data');
  assert.equal(s.config.owner, 'acme');
  assert.equal(s.repo, 'app');
  assert.equal(s.platform, 'web');
  assert.equal(s.githubToken, 't');
});

test('settings: inputs win over the config file', () => {
  const ws = tempDir();

  writeFileSync(path.join(ws, 'journeyboard.config.json'), JSON.stringify({ dataRepo: 'acme/journeys', baseBranch: 'dev', platforms: ['desktop', 'web'] }));
  const s = settings({ GITHUB_REPOSITORY: 'acme/app', GITHUB_WORKSPACE: ws, JB_BASE_BRANCH: 'main', JB_REPO_NAME: 'frontend' });

  assert.equal(s.config.dataRepo, 'acme/journeys');
  assert.equal(s.config.baseBranch, 'main');
  assert.equal(s.platform, 'desktop');
  assert.equal(s.repo, 'frontend');
});

test('pr → baseline → cleanup, end to end against a local remote and a fake GitHub', async () => {
  const api = await fakeGitHub({ prs: { 7: 'open' } });

  try {
    // A PR on a repo with no data branch yet.
    const pr = { pull_request: { number: 7, head: { ref: 'feature/signup', sha: 'abc1234def' } } };
    const t = setup(api, pr);
    const shots = makeShots(ONBOARDING);

    await quietly(() => ciPr(settings(t.env({ JB_SHOTS: shots }))));
    let files = t.remoteFiles();

    assert.ok(files.includes('README.md'), 'the data branch was created');
    assert.ok(files.includes('branches/app/feature~signup/branch.json'));
    assert.ok(files.includes('branches/app/feature~signup/web/onboarding/welcome.jpg'));
    assert.equal(api.comments.length, 1);
    assert.ok(api.comments[0].body.startsWith(MARKER));
    assert.match(api.comments[0].body, /4 new/);
    assert.match(api.comments[0].body, /https:\/\/github\.com\/acme\/app\/blob\/[0-9a-f]{40}\/branches\/app\/feature~signup\/web\/onboarding\/welcome\.jpg\?raw=true/);

    // A second push to the same PR updates the one comment.
    await quietly(() => ciPr(settings(t.env({ JB_SHOTS: makeShots([{ ...ONBOARDING[0], body: 'v2' }, ...ONBOARDING.slice(1)]) }))));
    assert.equal(api.comments.length, 1);

    // The merge: those screens become the baseline.
    writeFileSync(t.eventPath, JSON.stringify({ head_commit: { message: 'feat: sign up (#7)' } }));
    await quietly(() => ciBaseline(settings(t.env({ JB_SHOTS: shots }))));
    files = t.remoteFiles();
    assert.ok(files.includes('baseline/web/manifest.json'));
    assert.ok(files.includes('baseline/web/onboarding/done.jpg'));
    // PR 7 is still "open" in the fake, so its branch stays until cleanup.
    assert.ok(files.includes('branches/app/feature~signup/branch.json'));

    // The PR closes.
    writeFileSync(t.eventPath, JSON.stringify(pr));
    await quietly(() => ciCleanup(settings(t.env())));
    assert.ok(!t.remoteFiles().some((f) => f.startsWith('branches/')));

    // The site builds from the data branch.
    const out = path.join(t.root, 'site');

    await quietly(() => ciBuild(settings(t.env({ JB_OUT: out }))));
    const index = JSON.parse(execFileSync('cat', [path.join(out, 'index.json')]).toString());

    assert.equal(index.platforms.web.flows[0].steps.length, 4);
    assert.equal(index.config.repo, 'app');
    assert.equal(index.config.owner, 'acme');
    assert.equal(index.platforms.web.flows[0].steps[0].addedPr, 7);
  } finally {
    api.close();
  }
});

test('pr skips a closed PR and a run without screenshots', async () => {
  const api = await fakeGitHub({ prs: { 8: 'open' } });

  try {
    const t = setup(api, { pull_request: { number: 9, head: { ref: 'x', sha: 'a' } } });

    await quietly(() => ciPr(settings(t.env({ JB_SHOTS: makeShots(ONBOARDING) }))));
    writeFileSync(t.eventPath, JSON.stringify({ pull_request: { number: 8, head: { ref: 'y', sha: 'b' } } }));
    await quietly(() => ciPr(settings(t.env({ JB_SHOTS: path.join(t.root, 'nothing-here') }))));
    assert.equal(api.comments.length, 0);
    assert.throws(() => t.remoteFiles());
  } finally {
    api.close();
  }
});

test('baseline sweeps branches whose PR closed', async () => {
  const api = await fakeGitHub({ prs: { 7: 'open' } });

  try {
    const t = setup(api, { pull_request: { number: 7, head: { ref: 'a', sha: 'a1' } } });

    await quietly(() => ciPr(settings(t.env({ JB_SHOTS: makeShots(ONBOARDING) }))));
    // Now #7 has closed, but its cleanup run never happened.
    const closedApi = await fakeGitHub({ prs: { 7: 'closed' } });

    try {
      writeFileSync(t.eventPath, JSON.stringify({ head_commit: { message: 'feat: other (#9)' } }));
      await quietly(() => ciBaseline(settings({ ...t.env({ JB_SHOTS: makeShots(ONBOARDING) }), GITHUB_API_URL: closedApi.url })));
      assert.ok(!t.remoteFiles().some((f) => f.startsWith('branches/')));
    } finally {
      closedApi.close();
    }
  } finally {
    api.close();
  }
});

test('pr links the board on the repo\'s GitHub Pages when the config names no site', async () => {
  const api = await fakeGitHub({ prs: { 7: 'open' }, pages: 'https://acme.github.io/app/' });

  try {
    const t = setup(api, { pull_request: { number: 7, head: { ref: 'feature/x', sha: 'abc' } } });

    await quietly(() => ciPr(settings(t.env({ JB_SHOTS: makeShots(ONBOARDING) }))));
    assert.match(api.comments[0].body, /\(https:\/\/acme\.github\.io\/app\/\?branch=app\/feature~x&/);
  } finally {
    api.close();
  }
});

test('pr comments without a board link when Pages is off', async () => {
  const api = await fakeGitHub({ prs: { 7: 'open' } });

  try {
    const t = setup(api, { pull_request: { number: 7, head: { ref: 'feature/x', sha: 'abc' } } });

    await quietly(() => ciPr(settings(t.env({ JB_SHOTS: makeShots(ONBOARDING) }))));
    assert.equal(api.comments.length, 1);
    assert.doesNotMatch(api.comments[0].body, /Open this branch/);
  } finally {
    api.close();
  }
});
