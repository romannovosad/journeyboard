// journeyboard.config.json: optional. Without it, a single repo with one `web` platform works as is.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { assertName } from './lib.mjs';

export const CONFIG_FILE = 'journeyboard.config.json';

export const DEFAULTS = Object.freeze({
  /** Shown in the site's header and the browser tab. */
  title: 'Journeys',
  /** The branch whose screens are "the app as it is now": PRs compare against it. */
  baseBranch: 'main',
  /** The GitHub owner (org or user) the repos below live under, for PR links. Optional. */
  owner: '',
  /** Where the screenshots live: `owner/repo`. Empty means the repo the action runs in. */
  dataRepo: '',
  /** The branch of `dataRepo` that holds them. */
  dataBranch: 'journeyboard-data',
  /** The site's address, for links from PR comments. Optional. */
  siteUrl: '',
  /** Platforms in the order the site shows them. `repo` is the code repo that publishes it (for PR links). */
  platforms: [{ id: 'web', label: 'Web' }],
  /**
   * When a screen counts as changed: more than `maxPixels` pixels differ from the base branch's picture by more
   * than `threshold` (0–254, out of 255) in some colour channel. Below that it is JPEG or anti-aliasing noise.
   * `maxPixels` stays 0 by default: a decimal point turning into a comma moves only about five pixels.
   */
  changes: Object.freeze({ threshold: 40, maxPixels: 0 }),
});

/**
 * Reads the config file (when there is one) over the defaults and checks it. `file` may be a path to the file or
 * to the folder holding it; a missing file is fine, a broken one is an error.
 */
export function loadConfig(file = CONFIG_FILE) {
  let resolved = file;

  if (resolved && existsSync(resolved) && !resolved.endsWith('.json')) {
    resolved = path.join(resolved, CONFIG_FILE);
  }
  const raw = resolved && existsSync(resolved) ? JSON.parse(readFileSync(resolved, 'utf8')) : {};

  return normalizeConfig(raw);
}

/** The board's card shape per platform: phone screenshots are tall, the rest wide. A platform's `shape` overrides it. */
const SHAPES = ['landscape', 'portrait'];
const PORTRAIT_IDS = new Set(['mobile', 'phone', 'ios', 'android', 'iphone']);

export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULTS, ...raw };
  const platforms = Array.isArray(config.platforms) && config.platforms.length ? config.platforms : DEFAULTS.platforms;

  config.platforms = platforms.map((p) => {
    const entry = typeof p === 'string' ? { id: p } : { ...p };

    assertName('platform', entry.id);

    if (entry.shape !== undefined && !SHAPES.includes(entry.shape)) {
      throw new Error(`${CONFIG_FILE}: platform "${entry.id}" has shape "${entry.shape}"; use ${SHAPES.join(' or ')}`);
    }

    return { label: pretty(entry.id), shape: PORTRAIT_IDS.has(entry.id) ? 'portrait' : 'landscape', ...entry };
  });

  for (const key of ['title', 'baseBranch', 'owner', 'dataRepo', 'dataBranch', 'siteUrl']) {
    if (typeof config[key] !== 'string') {
      throw new Error(`${CONFIG_FILE}: "${key}" must be a string`);
    }
  }

  config.changes = normalizeChanges(raw.changes);

  if (config.dataRepo && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(config.dataRepo)) {
    throw new Error(`${CONFIG_FILE}: "dataRepo" must be owner/repo, got "${config.dataRepo}"`);
  }

  return config;
}

function normalizeChanges(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${CONFIG_FILE}: "changes" must be an object like ${JSON.stringify(DEFAULTS.changes)}`);
  }
  const unknown = Object.keys(raw).filter((key) => !(key in DEFAULTS.changes));

  if (unknown.length) {
    throw new Error(`${CONFIG_FILE}: "changes" has unknown ${unknown.map((k) => `"${k}"`).join(', ')}; use threshold and maxPixels`);
  }
  const changes = { ...DEFAULTS.changes, ...raw };

  if (!Number.isInteger(changes.threshold) || changes.threshold < 0 || changes.threshold > 254) {
    throw new Error(`${CONFIG_FILE}: "changes.threshold" must be a whole number from 0 to 254, got ${JSON.stringify(changes.threshold)}`);
  }

  if (!Number.isInteger(changes.maxPixels) || changes.maxPixels < 0) {
    throw new Error(`${CONFIG_FILE}: "changes.maxPixels" must be a whole number, 0 or more, got ${JSON.stringify(changes.maxPixels)}`);
  }

  return changes;
}

/** Sorts platform ids the way the config lists them; unknown ones go last, alphabetically. */
export function platformOrder(config, ids) {
  const rank = new Map(config.platforms.map((p, i) => [p.id, i]));

  return [...ids].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || a.localeCompare(b));
}

export function platformLabel(config, id) {
  return config.platforms.find((p) => p.id === id)?.label ?? pretty(id);
}

function pretty(name) {
  return name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
