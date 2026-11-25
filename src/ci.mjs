// What the GitHub Action runs: `journeyboard ci <pr|baseline|cleanup|build>`.
// Settings come from journeyboard.config.json, overridden by the action's inputs (JB_* environment variables).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildSite } from './build-site.mjs';
import { MARKER, renderComment } from './comment.mjs';
import { loadConfig, normalizeConfig } from './config.mjs';
import { ACTIONS_BOT, checkoutData, gitEnv, publishAndPush } from './git.mjs';
import { githubClient } from './github.mjs';
import { branchSlug, prFromSubject, readJson, walk } from './lib.mjs';
import { cleanup, publishBaseline, publishBranch } from './publish.mjs';

const log = (line) => console.log(line);
const notice = (line) => console.log(`::notice title=journeyboard::${line}`);
const warning = (line) => console.log(`::warning title=journeyboard::${line}`);

/** Everything a CI command needs, from the environment. Exported for tests. */
export function settings(env = process.env) {
  const input = (name) => (env[`JB_${name}`] ?? '').trim();
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const configPath = input('CONFIG') || path.join(workspace, 'journeyboard.config.json');
  const file = loadConfig(configPath);
  const overrides = Object.fromEntries(
    [
      ['dataRepo', input('DATA_REPO')],
      ['dataBranch', input('DATA_BRANCH')],
      ['siteUrl', input('SITE_URL')],
      ['baseBranch', input('BASE_BRANCH')],
      ['title', input('TITLE')],
    ].filter(([, v]) => v)
  );
  const config = normalizeConfig({ ...file, ...overrides });
  const repository = env.GITHUB_REPOSITORY ?? '';
  const githubToken = input('GITHUB_TOKEN');

  if (!config.owner) config.owner = repository.split('/')[0] ?? '';
  if (!config.dataRepo) config.dataRepo = repository;

  return {
    config,
    repository,
    // The code repo's name as it appears in the data branch's paths (`branches/<repo>/…`).
    repo: input('REPO_NAME') || repository.split('/')[1] || 'app',
    platform: input('PLATFORM') || config.platforms[0].id,
    shots: path.resolve(workspace, input('SHOTS') || 'journeyboard-shots'),
    out: path.resolve(workspace, input('OUT') || '_site'),
    // Writes to the data repo; also used for the API when no separate token is given.
    token: input('TOKEN') || githubToken,
    githubToken: githubToken || input('TOKEN'),
    allowMassRemoval: input('ALLOW_MASS_REMOVAL') === 'true',
    prs: input('PRS'),
    dispatch: input('DISPATCH') !== 'false',
    comment: input('COMMENT') !== 'false',
    sha: env.GITHUB_SHA ?? '',
    server: env.GITHUB_SERVER_URL || 'https://github.com',
    api: env.GITHUB_API_URL || 'https://api.github.com',
    event: env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH) ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {},
    workflowRef: env.GITHUB_WORKFLOW_REF ?? '',
    refName: env.GITHUB_REF_NAME ?? '',
  };
}

/** The PR numbers in squash-merge subjects: `feat: x (#12)`. */
export function prsFromMessages(messages) {
  return [...new Set(messages.map((m) => prFromSubject(String(m).split('\n')[0])).filter(Boolean))].sort((a, b) => a - b);
}

function hasShots(dir) {
  return existsSync(dir) && walk(dir).some((f) => f.endsWith('.ndjson'));
}

async function openData(s) {
  const dir = mkdtempSync(path.join(tmpdir(), 'journeyboard-data-'));
  const env = gitEnv({ token: s.token, server: s.server, identity: ACTIONS_BOT });
  const remote = `${s.server.replace(/\/$/, '')}/${s.config.dataRepo}.git`;

  if (s.token) console.log(`::add-mask::${s.token}`);
  const { created } = await checkoutData({ dir, remote, branch: s.config.dataBranch, env });

  if (created) log(`Started the ${s.config.dataBranch} branch in ${s.config.dataRepo}.`);

  return { dir, env };
}

async function dispatchRebuild(s, api) {
  if (!s.dispatch) return;

  try {
    await api.post(`/repos/${s.config.dataRepo}/dispatches`, { event_type: 'journeyboard-data-pushed' });
  } catch (error) {
    warning(`Pushed, but could not ask ${s.config.dataRepo} to rebuild its site (${error.status ?? error.message}).`);
  }
}

/** The board's address: the config's siteUrl, else the data repo's GitHub Pages site if it has one. */
async function siteUrl(s) {
  if (s.config.siteUrl) return s.config.siteUrl;

  try {
    const pages = await githubClient({ token: s.token, api: s.api }).get(`/repos/${s.config.dataRepo}/pages`);

    return pages?.html_url ?? '';
  } catch {
    return '';
  }
}

async function upsertComment(s, api, pr, body) {
  const comments = await api.all(`/repos/${s.repository}/issues/${pr}/comments`);
  const mine = comments.find((c) => c.user?.type === 'Bot' && String(c.body ?? '').startsWith(MARKER));

  if (mine) {
    await api.patch(`/repos/${s.repository}/issues/comments/${mine.id}`, { body });
  } else {
    await api.post(`/repos/${s.repository}/issues/${pr}/comments`, { body });
  }
}

export async function ciPr(s = settings()) {
  const pr = s.event.pull_request;

  if (!pr) throw new Error('`pr` runs on a pull_request event');
  const api = githubClient({ token: s.githubToken, api: s.api });
  const fresh = await api.get(`/repos/${s.repository}/pulls/${pr.number}`);

  if (fresh.state !== 'open') {
    notice(`Skipped: PR #${pr.number} is ${fresh.merged ? 'merged' : fresh.state}.`);
    return;
  }

  if (!hasShots(s.shots)) {
    notice(`No screenshots in ${s.shots}. Did the tests run with JOURNEYBOARD_SHOTS set?`);
    return;
  }
  const branch = pr.head.ref;
  const { dir, env } = await openData(s);
  const out = await publishAndPush({
    dir,
    branch: s.config.dataBranch,
    env,
    message: `branch: ${s.repo} ${branch} (#${pr.number}) ${s.platform}`,
    apply: (data) =>
      publishBranch({
        data,
        shots: s.shots,
        repo: s.repo,
        platform: s.platform,
        branch,
        pr: pr.number,
        commit: pr.head.sha,
        tolerance: s.config.changes,
      }),
  });

  log(`Published ${s.platform}: ${JSON.stringify(out.result)}`);

  if (out.pushed) await dispatchRebuild(s, githubClient({ token: s.token, api: s.api }));

  if (s.comment) {
    const body = renderComment({
      data: dir,
      repo: s.repo,
      branch,
      dataCommit: out.commit,
      dataRepo: s.config.dataRepo,
      siteUrl: await siteUrl(s),
      config: s.config,
    });

    await upsertComment(s, api, pr.number, body);
  }
}

/** The PRs merged since the last successful run of this workflow on this branch, best effort. */
async function mergedPrs(s, api, hasBaseline) {
  if (s.prs) return s.prs;
  const subject = String(s.event.head_commit?.message ?? '').split('\n')[0];
  const fallback = prFromSubject(subject);

  if (!hasBaseline) return fallback ? String(fallback) : '';

  try {
    const file = /\.github\/workflows\/([^@]+)@/.exec(s.workflowRef)?.[1];
    const runs = file
      ? await api.get(
          `/repos/${s.repository}/actions/workflows/${encodeURIComponent(file)}/runs?branch=${encodeURIComponent(s.refName)}&status=success&per_page=1`
        )
      : null;
    const previous = runs?.workflow_runs?.[0]?.head_sha;

    if (!previous || previous === s.sha) return fallback ? String(fallback) : '';
    const compare = await api.get(`/repos/${s.repository}/compare/${previous}...${s.sha}`);

    return prsFromMessages((compare.commits ?? []).map((c) => c.commit?.message ?? '')).join(',');
  } catch (error) {
    warning(`Could not list the PRs merged since the last baseline (${error.status ?? error.message}); crediting this commit's own.`);

    return fallback ? String(fallback) : '';
  }
}

export async function ciBaseline(s = settings()) {
  if (!hasShots(s.shots)) {
    notice(`No screenshots in ${s.shots}. Did the tests run with JOURNEYBOARD_SHOTS set?`);
    return;
  }
  const api = githubClient({ token: s.githubToken, api: s.api });
  const { dir, env } = await openData(s);
  const prs = await mergedPrs(s, api, existsSync(path.join(dir, 'baseline', s.platform, 'manifest.json')));
  const subject = String(s.event.head_commit?.message ?? '').split('\n')[0];
  const out = await publishAndPush({
    dir,
    branch: s.config.dataBranch,
    env,
    message: `baseline: ${s.repo} ${s.platform} ${s.sha.slice(0, 7)}`,
    apply: (data) =>
      publishBaseline({
        data,
        shots: s.shots,
        platform: s.platform,
        commit: s.sha,
        subject,
        prs,
        allowMassRemoval: s.allowMassRemoval,
        tolerance: s.config.changes,
      }),
  });

  log(`Baseline ${s.platform}: ${JSON.stringify(out.result)}`);
  const swept = await sweepClosed(s, api, dir, env);

  if (out.pushed || swept) await dispatchRebuild(s, githubClient({ token: s.token, api: s.api }));
}

/** Removes branches whose PR has closed: a PR merged while its own publish ran can leave its folder behind. */
async function sweepClosed(s, api, dir, env) {
  const root = path.join(dir, 'branches', s.repo);
  const records = existsSync(root)
    ? readdirSync(root).map((slug) => readJson(path.join(root, slug, 'branch.json'), null)).filter(Boolean)
    : [];
  const closed = [];

  for (const record of records) {
    if (!record.pr) continue;

    try {
      const pr = await api.get(`/repos/${s.repository}/pulls/${record.pr}`);

      if (pr.state !== 'open') closed.push(record.branch);
    } catch (error) {
      if (error.status === 404) closed.push(record.branch);
    }
  }

  if (!closed.length) return false;
  const out = await publishAndPush({
    dir,
    branch: s.config.dataBranch,
    env,
    message: `cleanup: ${s.repo} ${closed.length} closed branch(es)`,
    apply: (data) => closed.map((branch) => cleanup({ data, repo: s.repo, branch })),
  });

  log(`Removed closed branches: ${closed.join(', ')}`);

  return out.pushed;
}

export async function ciCleanup(s = settings()) {
  const branch = s.event.pull_request?.head?.ref;

  if (!branch) throw new Error('`cleanup` runs on a pull_request event');
  const { dir, env } = await openData(s);
  const out = await publishAndPush({
    dir,
    branch: s.config.dataBranch,
    env,
    message: `cleanup: ${s.repo} ${branch}`,
    apply: (data) => cleanup({ data, repo: s.repo, branch }),
  });

  log(`Cleanup ${branchSlug(branch)}: ${JSON.stringify(out.result)}`);

  if (out.pushed) await dispatchRebuild(s, githubClient({ token: s.token, api: s.api }));
}

export async function ciBuild(s = settings()) {
  const { dir } = await openData(s);
  const index = buildSite({ data: dir, out: s.out, config: { repo: s.repo, ...s.config } });
  const screens = Object.values(index.platforms).reduce((n, p) => n + p.flows.reduce((m, f) => m + f.steps.length, 0), 0);

  log(`Built ${s.out}: ${screens} screens, ${index.branches.length} branches.`);
}

export async function ci(command) {
  const run = { pr: ciPr, baseline: ciBaseline, cleanup: ciCleanup, build: ciBuild }[command];

  if (!run) throw new Error('usage: journeyboard ci pr|baseline|cleanup|build');
  await run();
}
