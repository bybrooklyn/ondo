#!/usr/bin/env node
/**
 * Generates icon16.png, icon32.png, icon48.png, icon128.png
 * in this directory using only Node.js built-ins (zlib + fs).
 * Run: node icons/generate_icons.js
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Colours (lime on dark) ────────────────────────────────────────────────────
const BG  = [13,  13,  13,  255]; // #0d0d0d
const FG  = [163, 230, 53,  255]; // #a3e635 lime

// ── Minimal PNG encoder ───────────────────────────────────────────────────────

function u32be(n) {
  return Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })());
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf  = u32be(data.length);
  const crcBuf  = u32be(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makePNG(size, pixelFn) {
  // IHDR
  const ihdr = Buffer.concat([u32be(size), u32be(size), Buffer.from([8, 2, 0, 0, 0])]);

  // Raw pixel data (RGBA → RGB for type 2, but we'll use type 6 = RGBA)
  const ihdr6 = Buffer.concat([u32be(size), u32be(size), Buffer.from([8, 6, 0, 0, 0])]);

  // Build scanlines
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte + RGBA
    row[0] = 0; // None filter
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      row[1 + x * 4]     = r;
      row[1 + x * 4 + 1] = g;
      row[1 + x * 4 + 2] = b;
      row[1 + x * 4 + 3] = a;
    }
    rows.push(row);
  }

  const raw  = Buffer.concat(rows);
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr6),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Draw an "O" letterform ─────────────────────────────────────────────────────

function drawO(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const pad = size * 0.08;

  // Outer radius (with rounded corners of the square icon)
  const outerR = size / 2 - pad;
  // Ring thickness: ~22% of size
  const ringW  = Math.max(2, size * 0.22);
  const innerR = outerR - ringW;

  const dx = x - cx + 0.5;
  const dy = y - cy + 0.5;
  const d  = Math.sqrt(dx * dx + dy * dy);

  // Anti-alias: smoothstep over 1px at each edge
  const aa = 1.0;
  const outerAlpha = smoothstep(outerR, outerR - aa, d);
  const innerAlpha = smoothstep(innerR - aa, innerR, d);

  const alpha = outerAlpha * innerAlpha;

  if (alpha < 0.01) return BG;

  // Blend FG over BG
  return [
    Math.round(FG[0] * alpha + BG[0] * (1 - alpha)),
    Math.round(FG[1] * alpha + BG[1] * (1 - alpha)),
    Math.round(FG[2] * alpha + BG[2] * (1 - alpha)),
    255,
  ];
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ── Write icons ────────────────────────────────────────────────────────────────

const sizes = [16, 32, 48, 128];
const dir   = __dirname;

sizes.forEach(sz => {
  const buf  = makePNG(sz, (x, y) => drawO(x, y, sz));
  const file = path.join(dir, `icon${sz}.png`);
  fs.writeFileSync(file, buf);
  console.log(`  ✓ icon${sz}.png  (${buf.length} bytes)`);
});

console.log('\nAll icons written to icons/');
