// Draw the OpenResearch DMG installer-window background to an opaque RGB PNG.
//
// The styled DMG (see scripts/package-macos-app.sh) shows the app icon on the
// left and an /Applications alias on the right; this background paints the brand
// mark and an arrow between them so "drag to install" reads at a glance. The
// icon labels ("OpenResearch", "Applications") are drawn by Finder, not here.
//
// Pure Node (no image deps), matching scripts/generate-icon.mjs: we emit a PNG
// by hand. Usage: node scripts/generate-dmg-background.mjs <out.png> [scale]
// scale 1 -> 640x400 (@1x), scale 2 -> 1280x800 (@2x). Requires Node >= 22.2.

import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/generate-dmg-background.mjs <out.png> [scale]');
  process.exit(1);
}
const SCALE = Number(process.argv[3] ?? 1);
// 640x400 and the arrow/mark geometry below are tuned to the window size and icon
// positions (WIN_W/WIN_H, APP_X/APPS_X) in scripts/package-macos-app.sh.
const W = 640 * SCALE, H = 400 * SCALE;
const SS = 3; // supersample factor per axis (anti-aliasing)
const s = SCALE; // logical-unit -> pixel scale (layout below is in @1x units)

const RED = [0x9a, 0x20, 0x36];
const RED_SOFT = [0xc0, 0x3a, 0x52];
// Gradient: warm near-white at the top easing to pure white lower down.
const TOP = [0xfb, 0xf1, 0xf3], BOT = [0xff, 0xff, 0xff];

// Brand mark (squircle + white triangle) centered near the top, in a 1024-space
// box so we can reuse the favicon geometry from generate-icon.mjs.
const MARK = { cx: 320, cy: 66, size: 60 };
const mX = 88, mY = 88, mW = 848, mH = 848, mR = 188;
const tA = [218.38, 230.31], tB = [218.38, 805.62], tC = [793.69, 805.62];

// Arrow from the app icon toward /Applications, vertically level with the icons.
const ARROW = { y: 182, x0: 258, shaftX1: 356, tipX: 392, shaftH: 13, headH: 42 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

// --- brand mark, evaluated in its own 1024x1024 space -----------------------
function markSquircle(px, py) {
  const cx = clamp(px, mX + mR, mX + mW - mR), cy = clamp(py, mY + mR, mY + mH - mR);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= mR * mR;
}
function edge(p, a, b) {
  return (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
}
function markTriangle(px, py) {
  const p = [px, py], d1 = edge(p, tA, tB), d2 = edge(p, tB, tC), d3 = edge(p, tC, tA);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
// Returns [r,g,b] of the mark at logical (lx,ly), or null if outside it.
function markColor(lx, ly) {
  const half = MARK.size / 2;
  if (lx < MARK.cx - half || lx > MARK.cx + half || ly < MARK.cy - half || ly > MARK.cy + half) return null;
  const ix = ((lx - (MARK.cx - half)) / MARK.size) * 1024;
  const iy = ((ly - (MARK.cy - half)) / MARK.size) * 1024;
  if (markTriangle(ix, iy)) return [255, 255, 255];
  if (markSquircle(ix, iy)) return RED;
  return null;
}

// --- arrow (rounded shaft + triangular head), logical coords ----------------
function inArrow(lx, ly) {
  const { y, x0, shaftX1, tipX, shaftH, headH } = ARROW;
  // shaft with rounded caps
  if (lx >= x0 && lx <= shaftX1 && Math.abs(ly - y) <= shaftH / 2) return true;
  const capR = shaftH / 2;
  if (Math.hypot(lx - x0, ly - y) <= capR) return true;
  // triangular head: linearly narrowing from headH at shaftX1 to 0 at tipX
  if (lx >= shaftX1 && lx <= tipX) {
    const t = (tipX - lx) / (tipX - shaftX1);
    if (Math.abs(ly - y) <= (headH / 2) * t) return true;
  }
  return false;
}

// --- compose ----------------------------------------------------------------
function sample(px, py) {
  const lx = px / s, ly = py / s;
  const base = lerp(TOP, BOT, clamp(ly / 400, 0, 1));
  const m = markColor(lx, ly);
  if (m) return m;
  if (inArrow(lx, ly)) {
    // subtle vertical shading on the arrow for a bit of depth
    return lerp(RED_SOFT, RED, clamp((ly - (ARROW.y - 22)) / 44, 0, 1));
  }
  return base;
}

const raw = Buffer.alloc(H * (W * 3 + 1)); // RGB + 1 filter byte per row
let o = 0;
for (let y = 0; y < H; y++) {
  raw[o++] = 0; // PNG filter: none
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += c[0]; g += c[1]; b += c[2];
      }
    }
    const n = SS * SS;
    raw[o++] = Math.round(r / n);
    raw[o++] = Math.round(g / n);
    raw[o++] = Math.round(b / n);
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit, RGB
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(out, png);
console.log(`wrote ${out} (${W}x${H}, ${png.length} bytes)`);
