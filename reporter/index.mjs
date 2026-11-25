// journeyboard/reporter: a journey board from the tests you already have, with no code changes.
//
//   // playwright.config.ts
//   reporter: [['list'], ['journeyboard/reporter']],
//   use: { screenshot: 'on' },
//
// Every passing test's screenshots become screens: the flow is the test file (`signup.spec.ts` → `signup`), the step
// is the test's title, and the board joins a file's tests with arrows in the order they appear in it. Like `snap`, it writes only when
// JOURNEYBOARD_SHOTS is set. Options: ['journeyboard/reporter', { tag: '@journey' }] keeps only tests with that tag.
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { shotsDir } from '../src/shots.mjs';

export function slug(text) {
  const out = String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return out || 'screen';
}

/** `tests/auth/sign-up.spec.ts` → `sign-up`. */
export function flowOf(file) {
  return slug(path.basename(file).replace(/\.(spec|test|e2e)?\.?[cm]?[jt]sx?$/, '').replace(/\.(spec|test)$/, ''));
}

export default class JourneyboardReporter {
  constructor(options = {}) {
    this.tag = options.tag ?? '';
    this.dir = options.dir ?? shotsDir();
    this.root = process.cwd();
  }

  printsToStdio() {
    return false;
  }

  onBegin(config) {
    this.root = config.rootDir ?? this.root;
  }

  onTestEnd(test, result) {
    if (!this.dir || result.status !== 'passed') return;
    if (this.tag && !(test.tags ?? []).includes(this.tag)) return;
    const images = result.attachments.filter((a) => /^image\/(png|jpeg)$/.test(a.contentType) && (a.path || a.body));

    if (!images.length) return;
    const file = path.relative(this.root, test.location.file).split(path.sep).join('/');
    const flow = flowOf(test.location.file);
    // Describe blocks and the test's own title; the file is already the flow.
    const titles = test.titlePath().slice(3).filter(Boolean);
    const base = slug(titles.join(' '));
    const manifest = path.join(this.dir, `${randomUUID()}.ndjson`);

    images.forEach((image, i) => {
      const step = images.length > 1 && image.name !== 'screenshot' ? `${base}-${slug(image.name)}` : base;
      const ext = image.contentType === 'image/jpeg' ? 'jpg' : 'png';
      const target = path.join(this.dir, flow, `${step}.${ext}`);

      mkdirSync(path.dirname(target), { recursive: true });

      if (image.path) copyFileSync(image.path, target);
      else writeFileSync(target, image.body);
      appendFileSync(
        manifest,
        `${JSON.stringify({
          flow,
          step,
          title: titles.join(' › '),
          // The whole file is one walk, in file order, so the board joins its tests with arrows.
          test: file,
          testTitle: '',
          order: test.location.line * 100 + i,
          ...(ext === 'png' ? { ext } : {}),
        })}\n`
      );
    });
  }
}
