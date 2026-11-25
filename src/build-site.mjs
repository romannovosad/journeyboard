#!/usr/bin/env node
/**
 * Builds the site: copies site/ and the data branch into an output folder and
 * writes index.json, the one file the viewer reads.
 *
 *   journeyboard build --data <data branch checkout> --out _site [--config journeyboard.config.json]
 *
 * index.json is generated here and never committed, so publishers only ever
 * write their own folders and concurrent pushes rebase cleanly.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBoard } from './board.mjs';
import { loadConfig, normalizeConfig, platformOrder } from './config.mjs';
import { compareScreens, imageFile, isDir, parseArgs, readJson, required, walk, writeJson } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** What a board card needs: where it sits in the walk, what to show, how it compares with the base branch. */
function cardOf(screen, image, status) {
  const { flow, step, title, test, testTitle, order, from } = screen;

  return { flow, step, title, test, testTitle, order, ...(from ? { from } : {}), image, status };
}

/**
 * A board as the viewer reads it: cards keep only what is drawn. The walk fields that placed them stay out, since
 * every branch repeats the base branch's cards and index.json is fetched on every visit.
 */
function slim(board) {
  return {
    ...board,
    cards: board.cards.map(({ key, flow, step, title, image, status, col, row }) => ({ key, flow, step, title, image, status, col, row })),
  };
}

/** Everything the viewer needs, with image paths relative to the site root. */
export function buildIndex(data, generatedAt = new Date().toISOString(), config = normalizeConfig()) {
  const { title, owner, baseBranch, platforms: platformList, repo = '' } = config;
  const index = { generatedAt, config: { title, owner, baseBranch, repo, platforms: platformList }, platforms: {}, branches: [] };
  const baseCards = {};
  const historyFor = (platform, flow, step) => {
    const dir = path.join(data, 'history', platform, flow, step);

    return walk(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const entry = readJson(path.join(dir, f));

        return { ...entry, image: `data/history/${platform}/${flow}/${step}/${entry.image}` };
      })
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  };

  const found = new Set(
    ['baseline', 'history'].flatMap((part) => {
      const dir = path.join(data, part);

      return isDir(dir) ? readdirSync(dir).filter((name) => isDir(path.join(dir, name))) : [];
    })
  );

  for (const platform of platformOrder(config, found)) {
    const manifestFile = path.join(data, 'baseline', platform, 'manifest.json');
    const historyRoot = path.join(data, 'history', platform);

    if (!existsSync(manifestFile) && !isDir(historyRoot)) {
      continue;
    }
    const manifest = readJson(manifestFile, { screens: [] });
    const flows = new Map();
    const live = new Set();

    for (const screen of [...manifest.screens].sort(compareScreens)) {
      live.add(`${screen.flow}/${screen.step}`);

      if (!flows.has(screen.flow)) {
        flows.set(screen.flow, { flow: screen.flow, steps: [] });
      }
      flows.get(screen.flow).steps.push({
        ...screen,
        image: `data/baseline/${platform}/${screen.flow}/${imageFile(screen)}`,
        history: historyFor(platform, screen.flow, screen.step),
      });
    }

    // Screens that were removed: still browsable through their history.
    const removed = [];

    for (const file of walk(historyRoot)) {
      const parts = file.split('/');

      if (parts.length !== 3 || !file.endsWith('.json')) {
        continue;
      }
      const [flow, step] = parts;
      const key = `${flow}/${step}`;

      if (live.has(key) || removed.some((r) => `${r.flow}/${r.step}` === key)) {
        continue;
      }
      const history = historyFor(platform, flow, step);

      removed.push({ flow, step, title: history[0]?.title ?? '', removedAt: history[0]?.endedAt, history });
    }

    baseCards[platform] = manifest.screens.map((s) =>
      cardOf(s, `data/baseline/${platform}/${s.flow}/${imageFile(s)}`, 'unchanged')
    );
    index.platforms[platform] = {
      updatedAt: manifest.updatedAt ?? null,
      commit: manifest.commit ?? null,
      flows: [...flows.values()],
      removed,
      board: slim(buildBoard({ screens: baseCards[platform] })),
    };
  }

  const designs = new Map();
  const designRoot = path.join(data, 'design');

  for (const file of walk(designRoot).filter((f) => f.split('/').length === 3 && f.endsWith('/design.json'))) {
    const [repo, slug] = file.split('/');
    const design = readJson(path.join(designRoot, file));
    const base = `data/design/${repo}/${slug}`;

    designs.set(`${repo}/${slug}`, {
      ...design,
      options: (design.options ?? []).map((o) => ({ ...o, html: o.html ? `${base}/${o.html}` : null })),
      targets: (design.targets ?? []).map((t) => ({ ...t, image: `${base}/${t.image}` })),
    });
  }

  const branchRoot = path.join(data, 'branches');

  for (const file of walk(branchRoot).filter((f) => f.split('/').length === 3 && f.endsWith('/branch.json'))) {
    const [repo, slug] = file.split('/');
    const record = readJson(path.join(branchRoot, file));
    const platforms = {};

    for (const [platform, p] of Object.entries(record.platforms ?? {})) {
      platforms[platform] = {
        ...p,
        screens: p.screens.map((s) => ({
          ...s,
          image:
            s.status === 'unchanged'
              ? `data/baseline/${platform}/${s.flow}/${imageFile(s)}`
              : `data/branches/${repo}/${slug}/${platform}/${s.flow}/${imageFile(s)}`,
        })),
      };
    }
    index.branches.push({ ...record, repo, slug, platforms, design: designs.get(`${repo}/${slug}`) ?? null });
    designs.delete(`${repo}/${slug}`);
  }

  // Mockups published before the branch had any screenshots.
  for (const [key, design] of designs) {
    const [repo, slug] = key.split('/');

    index.branches.push({ repo, slug, branch: design.branch ?? slug, pr: null, platforms: {}, design });
  }
  // Each branch on the board: its own run where it has one (new and changed screens marked), else the base screens,
  // with its mockups next to the screens they target.
  for (const branch of index.branches) {
    const targets = branch.design?.targets ?? [];
    const titles = new Map((branch.design?.options ?? []).map((o) => [o.id, o]));
    const platforms = new Set([...Object.keys(branch.platforms), ...targets.map((t) => t.platform)]);

    branch.boards = {};

    for (const platform of [...platforms].sort()) {
      const run = branch.platforms[platform];
      const screens = run ? run.screens.map((s) => cardOf(s, s.image, s.status)) : (baseCards[platform] ?? []);
      const mockups = targets
        .filter((t) => t.platform === platform)
        .map((t) => ({
          option: t.option,
          title: titles.get(t.option)?.title ?? '',
          html: titles.get(t.option)?.html ?? null,
          image: t.image,
          target: `${t.flow}/${t.step}`,
        }));

      branch.boards[platform] = slim(buildBoard({ screens, mockups }));
    }
  }

  index.branches.sort((a, b) => (b.publishedAt ?? b.design?.publishedAt ?? '').localeCompare(a.publishedAt ?? a.design?.publishedAt ?? ''));

  return index;
}

export function buildSite({ data, out, config = normalizeConfig() }) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(path.join(HERE, '..', 'site'), out, { recursive: true });

  if (isDir(data)) {
    for (const part of ['baseline', 'history', 'branches', 'design']) {
      if (isDir(path.join(data, part))) {
        cpSync(path.join(data, part), path.join(out, 'data', part), { recursive: true });
      }
    }
  }
  const index = buildIndex(data, undefined, config);

  writeJson(path.join(out, 'index.json'), index);
  // The same data as a script, so the site also works opened straight from a folder (a downloaded CI artifact).
  writeFileSync(path.join(out, 'index.js'), `window.JOURNEYBOARD_INDEX = ${JSON.stringify(index).replace(/</g, '\\u003c')};\n`);

  return index;
}

export function cli(argv) {
  const args = parseArgs(argv);

  required(args, 'data', 'out');
  const index = buildSite({ data: args.data, out: args.out, config: loadConfig(args.config) });
  const screens = Object.values(index.platforms).reduce((n, p) => n + p.flows.reduce((m, f) => m + f.steps.length, 0), 0);

  console.log(`built ${args.out}: ${screens} screens, ${index.branches.length} branches`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(`build-site.mjs: ${error.message}`);
    process.exit(1);
  }
}
