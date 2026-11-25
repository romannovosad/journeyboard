import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function tempDir(prefix = 'journeys-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * Writes a capture folder the way the Playwright fixture does: one ndjson
 * manifest per worker plus `<flow>/<step>.jpg`. Each screen is
 * { flow, step, title?, body, test?, testTitle?, order?, from?, worker? }; `body` is
 * the file's content, so equal bodies mean equal hashes.
 */
export function makeShots(screens) {
  const dir = tempDir('shots-');
  const byWorker = new Map();

  screens.forEach((s, i) => {
    const file = path.join(dir, s.flow, `${s.step}.jpg`);

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, s.body);
    const worker = s.worker ?? 0;
    const line = JSON.stringify({
      flow: s.flow,
      step: s.step,
      title: s.title ?? s.step,
      test: s.test ?? 'tests/onboarding/web-journey.spec.ts',
      testTitle: s.testTitle ?? 'onboarding',
      order: s.order ?? i,
      ...(s.from ? { from: s.from } : {}),
    });

    byWorker.set(worker, [...(byWorker.get(worker) ?? []), line]);
  });

  for (const [worker, lines] of byWorker) {
    writeFileSync(path.join(dir, `${worker}.ndjson`), `${lines.join('\n')}\n`);
  }

  return dir;
}

export const ONBOARDING = [
  { flow: 'onboarding', step: 'welcome', title: 'Welcome', body: 'welcome-v1' },
  { flow: 'onboarding', step: 'connect-calendar', title: 'Connect your calendar', body: 'calendar-v1' },
  { flow: 'onboarding', step: 'first-meeting', title: 'Your first meeting', body: 'meeting-v1' },
  { flow: 'onboarding', step: 'done', title: 'All set', body: 'done-v1' },
];
