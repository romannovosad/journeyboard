import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

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

/** An 8-bit RGBA PNG, `width` × `height`, with `pixel(x, y)` → [r, g, b, a]. Built here so tests need no image library. */
export function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);

  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none

    for (let x = 0; x < width; x += 1) {
      Buffer.from(pixel(x, y)).copy(raw, y * (width * 4 + 1) + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);

  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, adaptive filtering, not interlaced

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);

  length.writeUInt32BE(body.length);
  crc.writeUInt32BE(crc32(typed));

  return Buffer.concat([length, typed, crc]);
}

function crc32(bytes) {
  let c = 0xffffffff;

  for (const byte of bytes) {
    c ^= byte;

    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }

  return (c ^ 0xffffffff) >>> 0;
}
