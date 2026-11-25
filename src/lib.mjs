// Shared helpers for journeyboard. Node built-ins only.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Image types a screenshot can be stored as. JPEG is what `snap` writes; PNG is what Playwright attaches. */
export const IMAGE_EXTS = ['jpg', 'png'];

/** A flow or step name: lower-case words joined by hyphens, e.g. `connect-calendar`. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A repo name as it appears in a path: `web-app`. */
const REPO = /^[A-Za-z0-9._-]+$/;

export function assertName(kind, value) {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new Error(`${kind} "${value}" must be lower-case words joined by hyphens (e.g. connect-calendar)`);
  }
}

/** A `flow/step` reference, as in snap's `from`. */
export function assertKey(kind, value) {
  const parts = typeof value === 'string' ? value.split('/') : [];

  if (parts.length !== 2 || !parts.every((p) => NAME.test(p))) {
    throw new Error(`${kind} "${value}" must be flow/step in lower-case words joined by hyphens`);
  }
}

/** A platform id is a name like any other (`web`, `desktop`, `ios`). Which ones exist, and their labels, is config. */
export function assertPlatform(value) {
  assertName('platform', value);
}

/** The file name of a screen's image: `<step>.jpg`, or `<step>.png` for a screen captured as PNG. */
export function imageFile(screen) {
  return `${screen.step}.${screen.ext ?? 'jpg'}`;
}

export function assertRepo(value) {
  if (typeof value !== 'string' || !REPO.test(value) || value.startsWith('.')) {
    throw new Error(`repo "${value}" is not a plain repository name`);
  }
}

/**
 * A branch name as a single path segment, one-to-one: `feature/journey-map` →
 * `feature~journey-map`, `fix/a b` → `fix~a+20b`.
 */
export function branchSlug(branch) {
  if (typeof branch !== 'string' || branch.trim() === '') {
    throw new Error('branch is required');
  }
  // Distinct branches must never share a folder: cleanup of one would delete the other. A git ref can't contain
  // `~`, so `/` becomes `~`; any other character outside [A-Za-z0-9._-] (`+` included) becomes `+` and its UTF-8
  // bytes in hex.
  const slug = branch.replace(/\//g, '~').replace(/[^A-Za-z0-9._~-]/g, (ch) =>
    [...Buffer.from(ch, 'utf8')].map((b) => `+${b.toString(16).padStart(2, '0')}`).join('')
  );

  if (slug.startsWith('.')) {
    return `_${slug}`;
  }

  return slug;
}

/** The PR number at the end of a squash-merge subject: `feat(x): y (#123)` → 123. */
export function prFromSubject(subject) {
  const match = /\(#(\d+)\)\s*$/.exec(subject ?? '');

  return match ? Number(match[1]) : null;
}

/**
 * The PRs a baseline run covers. `--prs "12,13"` (every PR merged since the last baseline) wins over the head
 * commit's subject. One PR is a number, several an array, none null.
 */
export function prsFor({ prs, subject }) {
  if (prs !== undefined && prs !== null && String(prs).trim() !== '') {
    const list = [...new Set(String(prs).split(',').map((p) => p.trim()).filter((p) => /^\d+$/.test(p)).map(Number))];

    if (list.length === 1) return list[0];
    if (list.length > 1) return list;
  }

  return prFromSubject(subject);
}

export function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function readJson(file, fallback = undefined) {
  if (!existsSync(file)) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`missing ${file}`);
  }

  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Every file under `dir`, as paths relative to it, sorted. */
export function walk(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const out = [];
  const visit = (rel) => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  };

  visit('');

  return out.sort();
}

export function isDir(p) {
  return existsSync(p) && statSync(p).isDirectory();
}

/** `flow/step` key for a screen. */
export const screenKey = (s) => `${s.flow}/${s.step}`;

/** Orders screens by flow, then by the test that took them and the order of the calls in it. */
export function compareScreens(a, b) {
  return (
    a.flow.localeCompare(b.flow) ||
    (a.test ?? '').localeCompare(b.test ?? '') ||
    (a.testTitle ?? '').localeCompare(b.testTitle ?? '') ||
    (a.order ?? 0) - (b.order ?? 0) ||
    a.step.localeCompare(b.step)
  );
}

/**
 * Reads a capture folder: `*.ndjson` manifests (one per test, any depth) plus
 * `<flow>/<step>.jpg` (or `.png`, when the manifest line says `"ext": "png"`) files. Returns one entry per screen with its
 * hash. A screen taken twice by the same test (a retry) keeps the last entry; a
 * screen name claimed by two different tests is an error, so a flow can't be
 * silently overwritten.
 */
export function readShots(shotsDir) {
  const manifests = walk(shotsDir).filter((f) => f.endsWith('.ndjson'));

  if (manifests.length === 0) {
    throw new Error(`no *.ndjson manifest under ${shotsDir}`);
  }
  const byKey = new Map();

  for (const manifest of manifests) {
    const lines = readFileSync(path.join(shotsDir, manifest), 'utf8').split('\n').filter(Boolean);

    for (const line of lines) {
      const entry = JSON.parse(line);

      assertName('flow', entry.flow);
      assertName('step', entry.step);

      if (entry.from !== undefined) {
        assertKey('from', entry.from);
      }
      const key = screenKey(entry);
      const previous = byKey.get(key);

      if (previous && (previous.test !== entry.test || previous.testTitle !== entry.testTitle)) {
        throw new Error(
          `screen ${key} is taken by two tests: "${previous.testTitle}" (${previous.test}) and "${entry.testTitle}" (${entry.test})`
        );
      }
      byKey.set(key, entry);
    }
  }

  return [...byKey.values()]
    .map((entry) => {
      const ext = entry.ext ?? 'jpg';

      if (!IMAGE_EXTS.includes(ext)) {
        throw new Error(`screen ${screenKey(entry)} has image type "${ext}"; use one of ${IMAGE_EXTS.join(', ')}`);
      }
      const file = path.join(shotsDir, entry.flow, `${entry.step}.${ext}`);

      if (!existsSync(file)) {
        throw new Error(`manifest names ${screenKey(entry)} but ${file} is missing`);
      }

      return {
        flow: entry.flow,
        step: entry.step,
        title: entry.title ?? '',
        test: entry.test ?? '',
        testTitle: entry.testTitle ?? '',
        order: entry.order ?? 0,
        // Where a branching test starts (snap's `from`). Only present when set, so older manifests stay the same.
        ...(entry.from ? { from: entry.from } : {}),
        // Only present for PNG, so a JPEG-only data branch reads exactly as before.
        ...(ext !== 'jpg' ? { ext } : {}),
        source: file,
        hash: sha256(file),
      };
    })
    .sort(compareScreens);
}

/** Strips the local-only `source` field before a screen is written to a manifest. */
export function publicScreen({ source: _source, ...rest }) {
  return rest;
}

/** Compact timestamp for history file names: 2026-11-24T10:20:30Z → 20261124T102030Z. */
export function stamp(dateIso) {
  return dateIso.replace(/[-:]/g, '').replace(/\.\d+/, '');
}

/** Parses `--key value` pairs; a bare `--flag` is `true`. */
export function parseArgs(argv) {
  const args = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];

      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(arg);
    }
  }

  return args;
}

export function required(args, ...keys) {
  for (const key of keys) {
    if (args[key] === undefined || args[key] === true || args[key] === '') {
      throw new Error(`--${key} is required`);
    }
  }
}
