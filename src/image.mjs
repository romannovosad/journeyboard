// Does a screen look different? Two screenshots of the same screen rarely match byte for byte: JPEG encoding and
// anti-aliasing shift faint pixels around edges. This decodes both and compares what a person would see.
// Node built-ins plus one vendored, dependency-free JPEG decoder (src/vendor/), so the GitHub Action runs without
// an `npm install`.
import { inflateSync } from 'node:zlib';

import decodeJpeg from './vendor/jpeg-js-decoder.cjs';

/**
 * True when `a` and `b` (image file contents) show the same screen: no more than `maxPixels` pixels differ by more
 * than `threshold` (0–254) in any channel. Different sizes, or an image that won't decode, count as different
 * unless the bytes are identical, so a doubt always errs towards "changed".
 */
export function sameScreen(a, b, { threshold, maxPixels }) {
  if (a.equals(b)) return true;
  let left;
  let right;

  try {
    left = decodeImage(a);
    right = decodeImage(b);
  } catch {
    return false;
  }

  if (left.width !== right.width || left.height !== right.height) return false;

  return changedPixels(left.data, right.data, threshold, maxPixels) <= maxPixels;
}

/** Decodes a JPEG or PNG (told apart by their first bytes, not the file name) to { width, height, data: RGBA }. */
export function decodeImage(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const image = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 200, maxMemoryUsageInMB: 2048 });

    return { width: image.width, height: image.height, data: image.data };
  }

  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return decodePng(bytes);
  throw new Error('not a JPEG or PNG');
}

/** Counts pixels whose largest channel difference exceeds `threshold`; stops once the count passes `limit`. */
function changedPixels(a, b, threshold, limit) {
  let count = 0;

  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > threshold ||
      Math.abs(a[i + 1] - b[i + 1]) > threshold ||
      Math.abs(a[i + 2] - b[i + 2]) > threshold ||
      Math.abs(a[i + 3] - b[i + 3]) > threshold
    ) {
      count += 1;

      if (count > limit) return count;
    }
  }

  return count;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channels per pixel for each PNG colour type: grey, RGB, palette, grey + alpha, RGBA. */
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * The PNGs browsers write: 8 bits per channel, not interlaced, any colour type. Anything else throws, and the
 * caller falls back to comparing bytes.
 */
function decodePng(bytes) {
  let offset = 8;
  let header;
  let palette;
  let transparency;
  const data = [];

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') header = body;
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }

  if (!header) throw new Error('PNG without a header');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [depth, colour, , , interlace] = header.subarray(8, 13);
  const channels = PNG_CHANNELS[colour];

  if (depth !== 8 || !channels || interlace !== 0 || (colour === 3 && !palette)) {
    throw new Error(`unsupported PNG (depth ${depth}, colour type ${colour}, interlace ${interlace})`);
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;

  if (raw.length < (stride + 1) * height) throw new Error('PNG data is short');
  const pixels = unfilter(raw, width, height, channels);
  const out = new Uint8Array(width * height * 4);

  for (let p = 0, s = 0; p < width * height; p += 1, s += channels) {
    const o = p * 4;

    if (colour === 3) {
      const index = pixels[s];

      out.set(palette.subarray(index * 3, index * 3 + 3), o);
      out[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    } else if (channels <= 2) {
      out[o] = out[o + 1] = out[o + 2] = pixels[s];
      out[o + 3] = channels === 2 ? pixels[s + 1] : 255;
    } else {
      out[o] = pixels[s];
      out[o + 1] = pixels[s + 1];
      out[o + 2] = pixels[s + 2];
      out[o + 3] = channels === 4 ? pixels[s + 3] : 255;
    }
  }

  return { width, height, data: out };
}

/** Reverses PNG's per-row filters (none, sub, up, average, Paeth). */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const at = y * stride;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? out[at + x - bpp] : 0;
      const up = y > 0 ? out[at - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[at - stride + x - bpp] : 0;
      let value;

      switch (filter) {
        case 0: value = row[x]; break;
        case 1: value = row[x] + left; break;
        case 2: value = row[x] + up; break;
        case 3: value = row[x] + ((left + up) >> 1); break;
        case 4: value = row[x] + paeth(left, up, upLeft); break;
        default: throw new Error(`PNG row filter ${filter}`);
      }
      out[at + x] = value & 0xff;
    }
  }

  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);

  if (pa <= pb && pa <= pc) return a;

  return pb <= pc ? b : c;
}
