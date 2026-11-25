// Git plumbing for the data branch: an authenticated checkout, and publish-commit-push with retries.
// The token never touches disk: it rides in GIT_CONFIG_* environment variables, as actions/checkout does.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Environment for git calls: an auth header for `server` when there is a token, and a fixed identity. */
export function gitEnv({ token = '', server = 'https://github.com', identity } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');

    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.${server.replace(/\/$/, '')}/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }

  if (identity) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = identity.name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = identity.email;
  }

  return env;
}

export const ACTIONS_BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };

async function git(dir, env, ...args) {
  const { stdout } = await run('git', args, { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 });

  return stdout.trim();
}

/**
 * Makes `dir` a checkout of `branch` from `remote` (a URL or a path). When the branch doesn't exist yet it is created
 * as an orphan holding only a README, and pushed, so the first run of a new setup needs no manual step.
 */
export async function checkoutData({ dir, remote, branch, env }) {
  mkdirSync(dir, { recursive: true });
  await git(dir, env, 'init', '-q');
  await git(dir, env, 'remote', 'add', 'origin', remote).catch(() => git(dir, env, 'remote', 'set-url', 'origin', remote));

  if (await fetchBranch(dir, env, branch)) {
    await git(dir, env, 'checkout', '-q', '-B', branch, `origin/${branch}`);

    return { created: false };
  }
  await git(dir, env, 'checkout', '-q', '--orphan', branch);
  writeFileSync(
    path.join(dir, 'README.md'),
    '# Screenshots for journeyboard\n\nWritten by CI. See https://github.com/romannovosad/journeyboard.\n'
  );
  await git(dir, env, 'add', 'README.md');
  await git(dir, env, 'commit', '-q', '-m', 'journeyboard: start the data branch');

  try {
    await git(dir, env, 'push', '-q', 'origin', `HEAD:${branch}`);
  } catch (error) {
    // Another run created it first: use theirs.
    if (!(await fetchBranch(dir, env, branch))) throw error;
    await git(dir, env, 'checkout', '-q', '-B', branch, `origin/${branch}`);
  }

  return { created: true };
}

async function fetchBranch(dir, env, branch) {
  try {
    await git(dir, env, 'fetch', '-q', '--depth', '1', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);

    return true;
  } catch (error) {
    if (/couldn't find remote ref|not found|does not exist/i.test(`${error.stderr ?? ''}${error.message}`)) return false;
    throw error;
  }
}

/**
 * Runs `apply` against a fresh copy of the remote branch, commits what it changed and pushes, starting again from the
 * remote's tip when another publish pushed first. There is never a merge to resolve: each attempt re-runs `apply`.
 * Returns { commit, pushed, result }; `pushed` is false when `apply` changed nothing.
 */
export async function publishAndPush({ dir, branch, env, message, apply, attempts = 5, pause = (n) => n * 3000 }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await fetchBranch(dir, env, branch);
    await git(dir, env, 'reset', '-q', '--hard', `origin/${branch}`);
    await git(dir, env, 'clean', '-fdq');

    const result = await apply(dir);

    await git(dir, env, 'add', '-A');
    const staged = await git(dir, env, 'diff', '--cached', '--name-only');

    if (!staged) {
      return { commit: await git(dir, env, 'rev-parse', 'HEAD'), pushed: false, result };
    }
    await git(dir, env, 'commit', '-q', '-m', message);

    try {
      await git(dir, env, 'push', '-q', 'origin', `HEAD:${branch}`);

      return { commit: await git(dir, env, 'rev-parse', 'HEAD'), pushed: true, result };
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(`could not push to ${branch} after ${attempts} attempts: ${error.stderr || error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pause(attempt)));
    }
  }

  throw new Error('unreachable');
}
