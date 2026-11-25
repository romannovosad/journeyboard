import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { checkoutData, gitEnv, publishAndPush } from '../src/git.mjs';
import { publishBranch } from '../src/publish.mjs';
import { makeShots, ONBOARDING, tempDir } from './helpers.mjs';

const env = gitEnv({ identity: { name: 't', email: 't@t' } });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString().trim();
const fast = { pause: () => 10 };

function bareRemote() {
  const root = tempDir('push-');
  const remote = path.join(root, 'remote.git');

  git(root, 'init', '-q', '--bare', remote);

  return { root, remote };
}

test('the first run creates the data branch as an orphan', async () => {
  const { root, remote } = bareRemote();
  const dir = path.join(root, 'a');
  const { created } = await checkoutData({ dir, remote, branch: 'journeyboard-data', env });

  assert.equal(created, true);
  assert.ok(existsSync(path.join(dir, 'README.md')));
  assert.equal(git(root, '--git-dir', remote, 'ls-tree', '--name-only', 'journeyboard-data'), 'README.md');

  const again = await checkoutData({ dir: path.join(root, 'b'), remote, branch: 'journeyboard-data', env });

  assert.equal(again.created, false);
});

test('two publishes racing for the data branch both land', async () => {
  const { root, remote } = bareRemote();
  const branch = 'data';

  await checkoutData({ dir: path.join(root, 'seed'), remote, branch, env });
  await checkoutData({ dir: path.join(root, 'a'), remote, branch, env });
  await checkoutData({ dir: path.join(root, 'b'), remote, branch, env });

  const publish = (clone, name, shots) =>
    publishAndPush({
      dir: path.join(root, clone),
      branch,
      env,
      message: `branch ${name}`,
      ...fast,
      apply: (data) =>
        publishBranch({ data, shots, repo: 'web-app', platform: 'web', branch: name, commit: 'abc1234' }),
    });

  await Promise.all([
    publish('a', 'feature/a', makeShots(ONBOARDING)),
    publish('b', 'feature/b', makeShots([{ ...ONBOARDING[0], body: 'changed' }, ...ONBOARDING.slice(1)])),
  ]);

  const files = git(root, '--git-dir', remote, 'ls-tree', '-r', '--name-only', branch).split('\n');

  assert.ok(files.includes('branches/web-app/feature~a/branch.json'));
  assert.ok(files.includes('branches/web-app/feature~b/branch.json'));
});

test('a publish that changes nothing pushes nothing', async () => {
  const { root, remote } = bareRemote();
  const branch = 'data';
  const dir = path.join(root, 'a');

  await checkoutData({ dir, remote, branch, env });
  const before = git(root, '--git-dir', remote, 'rev-parse', branch);
  const out = await publishAndPush({ dir, branch, env, message: 'noop', apply: () => ({}), ...fast });

  assert.equal(out.pushed, false);
  assert.equal(git(root, '--git-dir', remote, 'rev-parse', branch), before);
});
