// journeyboard/playwright: the `snap` fixture. A test calls `snap('flow/step', { title })` at each screen worth keeping.
//
// Pictures are written only when JOURNEYBOARD_SHOTS is set (the GitHub Action's workflow sets it), so local runs cost
// nothing extra. Each call writes `<dir>/<flow>/<step>.jpg` and a line in one `<dir>/<uuid>.ndjson` manifest per test.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { test as base } from '@playwright/test';

import { shotsDir } from '../src/shots.mjs';

export const JOURNEY = '@journey';

/** Elements with this attribute are always blacked out in screenshots: put it on names, emails, amounts. */
export const MASK_ATTRIBUTE = 'data-journeyboard-mask';

const NAME = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export { shotsDir };

/**
 * Adds `snap` to a Playwright `test` (yours, with your own fixtures, or Playwright's). Options, also settable per
 * project or file with `test.use({ journeyboard: { … } })`:
 *   requireTag  a tag every test using snap must carry, e.g. '@journey', so CI can run just those tests
 *   prepare     async (page, testInfo) => …, once before the test body: fix the clock, freeze animations
 *   beforeSnap  async (page) => …, before each picture: wait for fonts or images to settle
 *   mask        CSS selectors to black out on every picture (added to [data-journeyboard-mask])
 *   fullPage    whole scrollable page instead of the viewport (default false)
 *   quality     JPEG quality, 1–100 (default 80)
 *   maskColor   what masked elements are painted with (default a dark gray)
 */
export function withSnap(testBase, defaults = {}) {
  return testBase.extend({
    journeyboard: [{ ...defaults }, { option: true }],
    journeyShotsDir: [shotsDir(), { option: true }],
    snap: async ({ page, journeyboard, journeyShotsDir }, use, testInfo) => {
      const options = { ...defaults, ...journeyboard };

      if (options.requireTag && !testInfo.tags.includes(options.requireTag)) {
        throw new Error(
          `[journeyboard] "${testInfo.title}" uses snap() but is not tagged ${options.requireTag}. ` +
            `Declare it as test('…', { tag: '${options.requireTag}' }, async ({ page, snap }) => …).`
        );
      }

      if (options.prepare) await options.prepare(page, testInfo);

      const outDir = journeyShotsDir;
      // One manifest per test: CI shards run on separate machines and their folders are merged.
      const manifest = outDir ? path.join(outDir, `${randomUUID()}.ndjson`) : '';
      const testFile = path.relative(process.cwd(), testInfo.file).split(path.sep).join('/');
      const testTitle = testInfo.titlePath.slice(1).join(' › ');
      let order = 0;

      await use(async (name, call = {}) => {
        const match = NAME.exec(name);

        if (!match) {
          throw new Error(`[journeyboard] "${name}" must be flow/step in lower-case words joined by hyphens`);
        }

        if (call.from !== undefined && !NAME.test(call.from)) {
          throw new Error(`[journeyboard] from "${call.from}" must be flow/step in lower-case words joined by hyphens`);
        }

        if (!outDir) return;

        const [, flow, step] = match;
        const file = path.join(outDir, flow, `${step}.jpg`);
        const selectors = [`[${MASK_ATTRIBUTE}]`, ...(options.mask ?? [])];
        const mask = [
          ...selectors.map((selector) => page.locator(selector)),
          ...(call.mask ?? []).map((m) => (typeof m === 'string' ? page.locator(m) : m)),
        ];

        if (options.beforeSnap) await options.beforeSnap(page);
        mkdirSync(path.dirname(file), { recursive: true });
        await page.screenshot({
          path: file,
          type: 'jpeg',
          quality: options.quality ?? 80,
          fullPage: call.fullPage ?? options.fullPage ?? false,
          animations: 'disabled',
          caret: 'hide',
          scale: 'css',
          mask,
          maskColor: options.maskColor ?? '#2b2f36',
        });
        appendFileSync(
          manifest,
          `${JSON.stringify({
            flow,
            step,
            title: call.title ?? '',
            test: testFile,
            testTitle,
            order,
            ...(call.from ? { from: call.from } : {}),
          })}\n`
        );
        order += 1;
      });
    },
  });
}

export const test = withSnap(base);
export { expect } from '@playwright/test';
