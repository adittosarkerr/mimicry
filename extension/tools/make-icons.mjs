/**
 * Generates the extension's PNG icons without a build dependency.
 * Draws Mimic's mark — three ember dots on a sand rounded square — straight
 * into an RGBA buffer and encodes it as PNG with zlib.
 *
 *   node extension/tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded rectangle, used for antialiased edges. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const mix = (a, b, t) => a + (b - a) * t;
const cover = (d) => Math.min(Math.max(0.5 - d, 0), 1); // 1px antialiasing band

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size / 128; // design grid is 128×128

  const sand = [253, 246, 236];
  const sandDeep = [244, 227, 205];
  const ember = [249, 115, 22];
  const emberSoft = [251, 146, 60];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const i = (y * size + x) * 4;

      // Sand tile with a soft diagonal warmth.
      const tile = cover(sdRoundRect(px, py, size / 2, size / 2, size / 2 - 1, size / 2 - 1, 28 * s));
      const grad = Math.min(1, (px + py) / (size * 2));
      let r = mix(sand[0], sandDeep[0], grad);
      let g = mix(sand[1], sandDeep[1], grad);
      let b = mix(sand[2], sandDeep[2], grad);
      let a = tile;

      // Three dots, rising left to right — the same motif as the popup mark.
      const dots = [
        { cx: 40 * s, cy: 78 * s, rad: 11 * s, col: ember, alpha: 1 },
        { cx: 64 * s, cy: 64 * s, rad: 11 * s, col: emberSoft, alpha: 0.92 },
        { cx: 88 * s, cy: 50 * s, rad: 11 * s, col: emberSoft, alpha: 0.72 },
      ];

      for (const d of dots) {
        const inside = cover(Math.hypot(px - d.cx, py - d.cy) - d.rad) * d.alpha;
        if (inside <= 0) continue;
        r = mix(r, d.col[0], inside);
        g = mix(g, d.col[1], inside);
        b = mix(b, d.col[2], inside);
        a = Math.max(a, inside * tile);
      }

      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, buf);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${size}.png`), draw(size));
  console.log(`wrote icons/icon${size}.png`);
}
