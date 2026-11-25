// `journeyboard design`: publishes design mockups for a branch from a developer's (or agent's) machine,
// with their own git credentials. Plain git, so any agent can do it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from './config.mjs';
import { checkoutData, gitEnv, publishAndPush } from './git.mjs';
import { parseArgs, required } from './lib.mjs';
import { publishDesign } from './publish.mjs';

const sh = (...args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

/** `git@github.com:acme/app.git` or `https://github.com/acme/app` → { host, slug: 'acme/app', ssh } */
export function parseRemote(url) {
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(url);

  if (ssh) return { host: ssh[1], slug: ssh[2], ssh: true };
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);

  if (https) return { host: https[1], slug: https[2], ssh: false };
  throw new Error(`can't read a GitHub repo from the remote "${url}"`);
}

export async function design(argv) {
  const args = parseArgs(argv);

  required(args, 'dir');
  const config = loadConfig(args.config);
  const origin = parseRemote(args.remote ?? sh('remote', 'get-url', 'origin'));
  const dataRepo = args['data-repo'] || config.dataRepo || origin.slug;
  const branch = args.branch || sh('rev-parse', '--abbrev-ref', 'HEAD');
  const repo = args.repo || origin.slug.split('/')[1];
  const remote = origin.ssh ? `git@${origin.host}:${dataRepo}.git` : `https://${origin.host}/${dataRepo}.git`;
  const dir = mkdtempSync(path.join(tmpdir(), 'journeyboard-design-'));
  const env = gitEnv();

  await checkoutData({ dir, remote, branch: config.dataBranch, env });
  const out = await publishAndPush({
    dir,
    branch: config.dataBranch,
    env,
    message: `design: ${repo} ${branch}`,
    apply: (data) => publishDesign({ data, dir: path.resolve(args.dir), repo, branch }),
  });

  console.log(
    `Published ${out.result.options} option(s), ${out.result.targets} target(s) for ${repo} ${branch} to ${dataRepo}@${config.dataBranch}` +
      (out.pushed ? ` (${out.commit.slice(0, 7)}).` : ': nothing changed.')
  );
}
