#!/usr/bin/env node
/**
 * Writes screenshots into a checkout of the data branch. It only touches
 * files; committing and pushing is git.mjs's job (see ci.mjs).
 *
 *   publish.mjs branch   --data D --shots S --repo R --platform P --branch B [--pr N] --commit SHA [--date ISO]
 *   publish.mjs baseline --data D --shots S --platform P --commit SHA --subject "feat(x): y (#123)" [--prs 12,13] [--date ISO] [--allow-mass-removal]
 *   publish.mjs design   --data D --dir M --repo R --branch B [--date ISO]
 *   publish.mjs cleanup  --data D --repo R --branch B
 *
 * Layout of the data branch (see README.md):
 *   baseline/<platform>/manifest.json, baseline/<platform>/<flow>/<step>.jpg (or .png)
 *   history/<platform>/<flow>/<step>/<stamp>-<sha7>.{jpg,json}
 *   branches/<repo>/<slug>/branch.json, branches/<repo>/<slug>/<platform>/<flow>/<step>.jpg
 *   design/<repo>/<slug>/design.json and the mockup files
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertName,
  assertPlatform,
  assertRepo,
  branchSlug,
  compareScreens,
  imageFile,
  isDir,
  parseArgs,
  prsFor,
  publicScreen,
  readJson,
  readShots,
  required,
  screenKey,
  stamp,
  walk,
  writeJson,
} from './lib.mjs';

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function baselineDir(data, platform) {
  return path.join(data, 'baseline', platform);
}

export function readBaseline(data, platform) {
  return readJson(path.join(baselineDir(data, platform), 'manifest.json'), { platform, screens: [] });
}

/**
 * Compares a run's screens with the baseline by hash.
 * Returns { screens: [...with status new|changed|unchanged], removed: [...] }.
 */
export function classify(shots, baselineScreens) {
  const base = new Map(baselineScreens.map((s) => [screenKey(s), s]));
  const seen = new Set();
  const screens = shots.map((shot) => {
    const key = screenKey(shot);
    const before = base.get(key);

    seen.add(key);
    let status = 'new';

    if (before) {
      status = before.hash === shot.hash ? 'unchanged' : 'changed';
    }

    return { ...shot, status };
  });
  const removed = baselineScreens
    .filter((s) => !seen.has(screenKey(s)))
    .map(({ flow, step, title, test, testTitle, order, ext }) => ({ flow, step, title, test, testTitle, order, ...(ext ? { ext } : {}) }));

  return { screens, removed };
}

/** A PR run: replaces the branch's folder for this platform with its new and changed screens. */
export function publishBranch({ data, shots, repo, platform, branch, pr = null, commit, date = nowIso() }) {
  assertRepo(repo);
  assertPlatform(platform);
  const slug = branchSlug(branch);
  const run = readShots(shots);
  const baseline = readBaseline(data, platform);
  const { screens, removed } = classify(run, baseline.screens);
  const branchDir = path.join(data, 'branches', repo, slug);
  const platformDir = path.join(branchDir, platform);

  rmSync(platformDir, { recursive: true, force: true });

  for (const screen of screens) {
    if (screen.status !== 'unchanged') {
      const target = path.join(platformDir, screen.flow, imageFile(screen));

      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(screen.source, target);
    }
  }
  const branchFile = path.join(branchDir, 'branch.json');
  const existing = readJson(branchFile, { platforms: {} });
  const record = {
    repo,
    branch,
    slug,
    pr: pr === null ? (existing.pr ?? null) : Number(pr),
    commit,
    publishedAt: date,
    platforms: {
      ...existing.platforms,
      [platform]: {
        commit,
        publishedAt: date,
        baselineCommit: baseline.commit ?? null,
        screens: screens.map(publicScreen),
        removed,
      },
    },
  };

  writeJson(branchFile, record);

  return summarize(record.platforms[platform]);
}

export function summarize(platformRecord) {
  const count = (status) => platformRecord.screens.filter((s) => s.status === status).length;

  return {
    new: count('new'),
    changed: count('changed'),
    unchanged: count('unchanged'),
    removed: platformRecord.removed.length,
  };
}

/**
 * A run on the base branch (main, dev…): its screens become the baseline. The version a changed or
 * removed screen replaces moves to history, with when it was current and the
 * PR that replaced it.
 */
export function publishBaseline({ data, shots, platform, commit, subject = '', prs = null, date = nowIso(), allowMassRemoval = false }) {
  assertPlatform(platform);
  const run = readShots(shots);
  const pr = prsFor({ prs, subject });
  const baseline = readBaseline(data, platform);
  const { screens, removed } = classify(run, baseline.screens);
  const dir = baselineDir(data, platform);
  const previous = new Map(baseline.screens.map((s) => [screenKey(s), s]));

  if (
    !allowMassRemoval &&
    baseline.screens.length >= 4 &&
    removed.length > baseline.screens.length / 2
  ) {
    throw new Error(
      `refusing to remove ${removed.length} of ${baseline.screens.length} baseline screens in one run; pass --allow-mass-removal if that is intended`
    );
  }
  const archive = (old, kind) => {
    const histDir = path.join(data, 'history', platform, old.flow, old.step);
    const name = `${stamp(date)}-${String(commit).slice(0, 7)}`;
    const current = path.join(dir, old.flow, imageFile(old));
    const image = `${name}.${old.ext ?? 'jpg'}`;

    mkdirSync(histDir, { recursive: true });

    if (existsSync(current)) {
      renameSync(current, path.join(histDir, image));
    }
    writeJson(path.join(histDir, `${name}.json`), {
      kind,
      title: old.title,
      hash: old.hash,
      currentFrom: old.updatedAt ?? old.addedAt ?? null,
      currentFromPr: old.updatedPr ?? old.addedPr ?? null,
      endedAt: date,
      endedByPr: pr,
      endedByCommit: commit,
      image,
    });
  };
  const next = [];
  let written = 0;

  for (const screen of screens) {
    const old = previous.get(screenKey(screen));
    const target = path.join(dir, screen.flow, imageFile(screen));
    const { status, ...rest } = screen;
    const entry = publicScreen(rest);

    if (status === 'unchanged') {
      next.push({
        ...entry,
        addedAt: old.addedAt,
        addedPr: old.addedPr,
        updatedAt: old.updatedAt,
        updatedPr: old.updatedPr,
      });
      continue;
    }

    if (status === 'changed') {
      archive(old, 'replaced');
    }
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(screen.source, target);
    written += 1;
    next.push({
      ...entry,
      addedAt: old?.addedAt ?? date,
      addedPr: old?.addedPr ?? pr,
      updatedAt: date,
      updatedPr: pr,
    });
  }

  for (const gone of removed) {
    archive(previous.get(screenKey(gone)), 'removed');
  }

  if (written === 0 && removed.length === 0) {
    // Keep the manifest's own metadata stable so an unchanged run commits nothing.
    const sameMeta = JSON.stringify(baseline.screens) === JSON.stringify(next);

    if (sameMeta) {
      return { new: 0, changed: 0, unchanged: screens.length, removed: 0 };
    }
  }
  writeJson(path.join(dir, 'manifest.json'), {
    platform,
    commit,
    updatedAt: date,
    screens: next.sort(compareScreens),
  });

  return {
    new: screens.filter((s) => s.status === 'new').length,
    changed: screens.filter((s) => s.status === 'changed').length,
    unchanged: screens.filter((s) => s.status === 'unchanged').length,
    removed: removed.length,
  };
}

/**
 * Mockups from the design phase. `dir` holds design.json plus the files it
 * names:
 *   { "options": [{ "id": "a", "title": "…", "inspiredBy": "…", "html": "a/index.html" }],
 *     "targets": [{ "platform": "web", "flow": "…", "step": "…", "option": "a", "image": "a/summary.png" }] }
 * `image` is a PNG or JPEG of the mockup (render it with
 * `npx playwright screenshot --viewport-size=1440,900 file.html out.png`), so a PR can show it next to the build.
 */
export function publishDesign({ data, dir, repo, branch, date = nowIso() }) {
  assertRepo(repo);
  const slug = branchSlug(branch);
  const design = readJson(path.join(dir, 'design.json'));
  const options = design.options ?? [];
  const targets = design.targets ?? [];
  const ids = new Set();

  if (options.length === 0) {
    throw new Error('design.json lists no options');
  }

  for (const option of options) {
    assertName('option id', option.id);
    ids.add(option.id);

    if (option.html) {
      mustExist(dir, option.html);
    }
  }

  for (const target of targets) {
    assertPlatform(target.platform);
    assertName('flow', target.flow);
    assertName('step', target.step);

    if (!ids.has(target.option)) {
      throw new Error(`target ${target.flow}/${target.step} names unknown option "${target.option}"`);
    }

    if (!/\.(png|jpe?g)$/i.test(target.image ?? '')) {
      throw new Error(`target ${target.flow}/${target.step} needs an "image" (.png or .jpg)`);
    }
    mustExist(dir, target.image);
  }
  const out = path.join(data, 'design', repo, slug);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const file of walk(dir)) {
    if (file !== 'design.json') {
      mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
      copyFileSync(path.join(dir, file), path.join(out, file));
    }
  }
  writeJson(path.join(out, 'design.json'), { repo, branch, slug, publishedAt: date, options, targets });

  return { options: options.length, targets: targets.length };
}

function mustExist(dir, rel) {
  const resolved = path.resolve(dir, rel);

  if (!resolved.startsWith(path.resolve(dir) + path.sep) || !existsSync(resolved)) {
    throw new Error(`design file "${rel}" is missing or outside the design folder`);
  }
}

/** A closed PR: its screenshots and mockups go. */
export function cleanup({ data, repo, branch }) {
  assertRepo(repo);
  const slug = branchSlug(branch);
  const removed = [];

  for (const kind of ['branches', 'design']) {
    const dir = path.join(data, kind, repo, slug);

    if (isDir(dir)) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(`${kind}/${repo}/${slug}`);
    }
  }

  return { removed };
}

export function cli(argv) {
  const args = parseArgs(argv);
  const mode = args._[0];
  let result;

  required(args, 'data');

  switch (mode) {
    case 'branch':
      required(args, 'shots', 'repo', 'platform', 'branch', 'commit');
      result = publishBranch({
        data: args.data,
        shots: args.shots,
        repo: args.repo,
        platform: args.platform,
        branch: args.branch,
        pr: args.pr === undefined ? null : args.pr,
        commit: args.commit,
        date: args.date ?? nowIso(),
      });
      break;
    case 'baseline':
      required(args, 'shots', 'platform', 'commit');
      result = publishBaseline({
        data: args.data,
        shots: args.shots,
        platform: args.platform,
        commit: args.commit,
        subject: args.subject ?? '',
        prs: args.prs ?? null,
        date: args.date ?? nowIso(),
        allowMassRemoval: args['allow-mass-removal'] === true,
      });
      break;
    case 'design':
      required(args, 'dir', 'repo', 'branch');
      result = publishDesign({ data: args.data, dir: args.dir, repo: args.repo, branch: args.branch, date: args.date ?? nowIso() });
      break;
    case 'cleanup':
      required(args, 'repo', 'branch');
      result = cleanup({ data: args.data, repo: args.repo, branch: args.branch });
      break;
    default:
      throw new Error('usage: publish.mjs branch|baseline|design|cleanup …');
  }
  console.log(JSON.stringify({ mode, ...result }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(`publish.mjs: ${error.message}`);
    process.exit(1);
  }
}

