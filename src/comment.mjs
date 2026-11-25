#!/usr/bin/env node
/**
 * Renders the PR's journey comment from the data branch.
 *
 *   journeyboard comment --data D --repo R --branch B --data-commit SHA --data-repo owner/repo [--site URL] [--config F]
 *
 * Prints Markdown. The first line is the marker the action uses to find and
 * update its own comment. Images point at the data branch commit that holds
 * them, so the comment keeps showing what that run saw, and they render for
 * anyone who can read the data repo (private repos included).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBoard } from './board.mjs';
import { loadConfig, normalizeConfig, platformLabel, platformOrder } from './config.mjs';
import { branchSlug, imageFile, parseArgs, readJson, required, screenKey } from './lib.mjs';

/** Kept from the tool's first home (Jurnie's journey map), so comments it already wrote are still found and updated. */
export const MARKER = '<!-- journey-map -->';
const WIDTH = 380;

export function renderComment({
  data,
  repo,
  branch,
  dataCommit,
  dataRepo,
  // Older names for the two above.
  journeysCommit,
  journeysRepo,
  siteUrl = '',
  maxRows = 25,
  config = normalizeConfig(),
}) {
  const commit = dataCommit ?? journeysCommit;
  const imagesRepo = dataRepo ?? journeysRepo;

  if (!commit || !imagesRepo) {
    throw new Error('renderComment needs dataCommit and dataRepo');
  }
  const base = config.baseBranch;
  const slug = branchSlug(branch);
  const record = readJson(path.join(data, 'branches', repo, slug, 'branch.json'), null);
  const design = readJson(path.join(data, 'design', repo, slug, 'design.json'), null);
  const img = (rel, alt) =>
    `<img src="https://github.com/${imagesRepo}/blob/${commit}/${rel.split('/').map(encodeURIComponent).join('/')}?raw=true" width="${WIDTH}" alt="${escapeAttr(alt)}">`;
  const site = siteUrl.replace(/\/$/, '');
  const lines = [MARKER, '### Journey map', ''];

  if (!record && !design) {
    lines.push('No screenshots were published for this branch.');

    return lines.join('\n');
  }
  const platforms = Object.entries(record?.platforms ?? {});
  const summary = platforms.map(([platform, p]) => {
    const count = (status) => p.screens.filter((s) => s.status === status).length;

    return `**${platformLabel(config, platform)}:** ${count('changed')} changed, ${count('new')} new, ${p.removed.length} removed`;
  });

  if (site) {
    // A query string, not a #fragment: a first visit goes through GitHub's sign-in, which drops the fragment.
    // The first marked screen as the board shows it (top lane first, then left to right), on the first platform
    // in a fixed order that has one. The platform goes in the link: web and desktop can share a screen name.
    const focus = platformOrder(config, Object.keys(record?.platforms ?? {})).flatMap((platform) => {
      const p = record?.platforms?.[platform];
      const card = p && buildBoard({ screens: p.screens }).cards.find((s) => s.status !== 'unchanged');

      return card ? [{ platform, card }] : [];
    })[0];
    const enc = (...parts) => parts.map(encodeURIComponent).join('/');
    const where = focus ? `&focus=${enc(focus.card.flow, focus.card.step)}&platform=${focus.platform}` : '';

    summary.push(`[Open this branch in the map](${site}/?branch=${enc(repo, slug)}${where})`);
  }
  lines.push(summary.join(' · '), '');

  const builtPath = (platform, screen) =>
    screen.status === 'unchanged'
      ? `baseline/${platform}/${screen.flow}/${imageFile(screen)}`
      : `branches/${repo}/${slug}/${platform}/${screen.flow}/${imageFile(screen)}`;
  // The baseline's own entry for a screen: its image type can differ from the branch's.
  const baseCache = new Map();
  const baseScreens = (platform) => {
    if (!baseCache.has(platform)) {
      const manifest = readJson(path.join(data, 'baseline', platform, 'manifest.json'), { screens: [] });

      baseCache.set(platform, new Map(manifest.screens.map((s) => [screenKey(s), s])));
    }

    return baseCache.get(platform);
  };
  const label = (s) => `\`${screenKey(s)}\`${s.title ? `<br>${escapeCell(s.title)}` : ''}`;
  const overflow = (rows, total) =>
    total > rows ? [`_…and ${total - rows} more${site ? `, see [the map](${site})` : ''}._`, ''] : [];

  if (design?.targets?.length) {
    lines.push('#### Design vs built', '', '| Screen | Design | Built |', '|---|---|---|');
    const optionTitle = new Map((design.options ?? []).map((o) => [o.id, o.title ?? o.id]));
    const targets = design.targets.slice(0, maxRows);

    for (const target of targets) {
      const run = record?.platforms?.[target.platform];
      const built = run?.screens.find((s) => s.flow === target.flow && s.step === target.step);
      const designCell = `${img(`design/${repo}/${slug}/${target.image}`, `Design ${target.option}`)}<br>Option ${escapeCell(optionTitle.get(target.option) ?? target.option)}`;
      const builtCell = built ? img(builtPath(target.platform, built), 'Built') : '_not captured by any test yet_';

      lines.push(`| ${label({ ...target, title: built?.title })} | ${designCell} | ${builtCell} |`);
    }
    lines.push('', ...overflow(targets.length, design.targets.length));
  }

  for (const [platform, p] of platforms) {
    // Rows in the order the board shows them: top lane first, each lane left to right.
    const place = new Map(buildBoard({ screens: p.screens }).cards.map((c, i) => [screenKey(c), i]));
    const inBoardOrder = (a, b) => (place.get(screenKey(a)) ?? Infinity) - (place.get(screenKey(b)) ?? Infinity);
    const changed = p.screens.filter((s) => s.status === 'changed').sort(inBoardOrder);
    const added = p.screens.filter((s) => s.status === 'new').sort(inBoardOrder);
    const name = platformLabel(config, platform);

    if (changed.length === 0 && added.length === 0 && p.removed.length === 0) {
      lines.push(`**${name}:** no screen changes against ${base}.`, '');
      continue;
    }

    if (changed.length) {
      lines.push(`#### ${name}: changed`, '', `| Screen | ${base} | This branch |`, '|---|---|---|');

      for (const s of changed.slice(0, maxRows)) {
        const before = baseScreens(platform).get(screenKey(s)) ?? s;

        lines.push(`| ${label(s)} | ${img(`baseline/${platform}/${s.flow}/${imageFile(before)}`, base)} | ${img(builtPath(platform, s), 'This branch')} |`);
      }
      lines.push('', ...overflow(Math.min(changed.length, maxRows), changed.length));
    }

    if (added.length) {
      lines.push(`#### ${name}: new`, '', '| Screen | This branch |', '|---|---|');

      for (const s of added.slice(0, maxRows)) {
        lines.push(`| ${label(s)} | ${img(builtPath(platform, s), 'This branch')} |`);
      }
      lines.push('', ...overflow(Math.min(added.length, maxRows), added.length));
    }

    if (p.removed.length) {
      lines.push(`#### ${name}: no longer captured`, '');

      for (const s of p.removed) {
        lines.push(`- \`${screenKey(s)}\`${s.title ? ` ${escapeCell(s.title)}` : ''}`);
      }
      lines.push('');
    }
  }

  if (platforms.length) {
    const when = platforms.map(([, p]) => p.publishedAt).sort().at(-1);

    lines.push(`<sub>Screens from ${record.commit?.slice(0, 7) ?? 'this branch'} at ${when}. Images need read access to ${imagesRepo}. Made with [journeyboard](https://github.com/romannovosad/journeyboard).</sub>`);
  }

  return lines.join('\n');
}

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/\n/g, ' ');
}

function escapeAttr(text) {
  return String(text).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);
}

export function cli(argv) {
  const args = parseArgs(argv);

  required(args, 'data', 'repo', 'branch', 'data-commit', 'data-repo');
  process.stdout.write(
    `${renderComment({
      data: args.data,
      repo: args.repo,
      branch: args.branch,
      dataCommit: args['data-commit'],
      dataRepo: args['data-repo'],
      siteUrl: args.site ?? '',
      config: loadConfig(args.config),
    })}\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(`comment.mjs: ${error.message}`);
    process.exit(1);
  }
}
