// icon.png (128x128) for the Marketplace listing.
// Pure Node: draw a router glyph, then encode a PNG. No canvas dependency.
// Usage: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const S = 128;
const px = Buffer.alloc(S * S * 4);

function insideRounded(x, y, r) {
  const { x: rx, y: ry, w, h, rad } = r;
  if (x < rx || x >= rx + w || y < ry || y >= ry + h) return false;
  const cx = x < rx + rad ? rx + rad : x >= rx + w - rad ? rx + w - rad : null;
  const cy = y < ry + rad ? ry + rad : y >= ry + h - rad ? ry + h - rad : null;
  if (cx === null || cy === null) return true;
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function insideCircle(x, y, cx, cy, rad) {
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  return dx * dx + dy * dy <= rad * rad;
}

/** Distance from pixel center to the segment (x1,y1)-(x2,y2). */
function distToSeg(x, y, x1, y1, x2, y2) {
  const px0 = x + 0.5;
  const py0 = y + 0.5;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = ((px0 - x1) * dx + (py0 - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  return Math.hypot(px0 - qx, py0 - qy);
}

function paint(pred, [r, g, b, a = 255]) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!pred(x, y)) continue;
      const i = (y * S + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = a;
    }
  }
}

const TILE = [14, 116, 144]; // cyan-700, readable on the slate gallery banner
const LINE = [255, 255, 255];
const NODE = [255, 255, 255];
const HUB = [251, 191, 36]; // amber-400

paint((x, y) => insideRounded(x, y, { x: 0, y: 0, w: S, h: S, rad: 28 }), TILE);

const left = [
  [34, 36],
  [34, 64],
  [34, 92],
];
const hub = [96, 64];

paint((x, y) => left.some(([cx, cy]) => distToSeg(x, y, cx, cy, hub[0], hub[1]) <= 3.2), LINE);
for (const [cx, cy] of left) paint((x, y) => insideCircle(x, y, cx, cy, 7), NODE);
paint((x, y) => insideCircle(x, y, hub[0], hub[1], 13), HUB);
paint((x, y) => insideCircle(x, y, hub[0], hub[1], 5.5), TILE);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
