/**
 * Draws the app icon and writes build/icon.png and build/icon.ico.
 *
 * SDA v1 shipped without one for its whole life. Issue #75 asked for an icon and
 * the maintainer's own v1.0 plan ended with "Still really need an icon :/".
 *
 * The mark matches .brand__mark in the interface: a red plate with a shield
 * notch cut out of it. Drawn with arithmetic and encoded by hand, so building
 * the icon pulls in no image library.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/* ------------------------------------------------------------------ PNG */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const forCrc = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(forCrc), 8 + data.length);
  return out;
}

/** Encodes RGBA pixels as a PNG. */
function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Each scanline carries a leading filter byte. Filter 0 keeps this simple.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- drawing */

const mix = (a, b, t) => a + (b - a) * t;

function roundedRectCoverage(x, y, size, inset, radius) {
  const lo = inset;
  const hi = size - inset;
  if (x < lo || x > hi || y < lo || y > hi) return false;

  // Distance into the nearest corner, if we are in one.
  const cx = x < lo + radius ? lo + radius : x > hi - radius ? hi - radius : x;
  const cy = y < lo + radius ? lo + radius : y > hi - radius ? hi - radius : y;
  return Math.hypot(x - cx, y - cy) <= radius;
}

/** The six-point shield outline, matching the clip-path in the stylesheet. */
function inShield(x, y, size) {
  const w = size * 0.34;
  const h = size * 0.5;
  const ox = (size - w) / 2;
  const oy = (size - h) / 2;
  const u = (x - ox) / w;
  const v = (y - oy) / h;
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;

  const poly = [
    [0.5, 0],
    [1, 0.16],
    [1, 0.5],
    [0.5, 1],
    [0, 0.5],
    [0, 0.16],
  ];

  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Renders the mark at one size, supersampled so the edges stay smooth. */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // samples per axis
  const inset = size * 0.06;
  const radius = size * 0.2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (!roundedRectCoverage(fx, fy, size, inset, radius)) continue;

          // Diagonal gradient: #ff6b6b -> #dc2828 -> #7a1212
          const t = Math.min(1, Math.max(0, (fx / size) * 0.5 + (fy / size) * 0.5));
          let pr;
          let pg;
          let pb;
          if (t < 0.45) {
            const k = t / 0.45;
            pr = mix(0xff, 0xdc, k);
            pg = mix(0x6b, 0x28, k);
            pb = mix(0x6b, 0x28, k);
          } else {
            const k = (t - 0.45) / 0.55;
            pr = mix(0xdc, 0x7a, k);
            pg = mix(0x28, 0x12, k);
            pb = mix(0x28, 0x12, k);
          }

          // A highlight along the top edge, the way the CSS inset shadow reads.
          const edge = Math.max(0, 1 - (fy - inset) / (size * 0.06));
          pr = mix(pr, 255, edge * 0.35);
          pg = mix(pg, 255, edge * 0.35);
          pb = mix(pb, 255, edge * 0.35);

          // The shield notch, punched dark rather than transparent.
          if (inShield(fx, fy, size)) {
            pr = mix(pr, 0x07, 0.82);
            pg = mix(pg, 0x07, 0.82);
            pb = mix(pb, 0x09, 0.82);
          }

          r += pr;
          g += pg;
          b += pb;
          a += 255;
        }
      }

      const samples = SS * SS;
      const i = (y * size + x) * 4;
      if (a > 0) {
        const hit = a / 255;
        px[i] = Math.round(r / hit);
        px[i + 1] = Math.round(g / hit);
        px[i + 2] = Math.round(b / hit);
        px[i + 3] = Math.round(a / samples);
      }
    }
  }
  return px;
}

/* ------------------------------------------------------------------ ICO */

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;

  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 256 is stored as 0
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/* ----------------------------------------------------------------- write */

const outDir = join('packages', 'desktop', 'build');
await mkdir(outDir, { recursive: true });

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const images = SIZES.map((size) => ({ size, png: encodePng(render(size), size) }));

await writeFile(join(outDir, 'icon.ico'), buildIco(images));
console.log(`icon.ico   ${SIZES.join(', ')} px`);

// electron-builder wants a 512 png for Linux and to derive the macOS icns.
const png512 = encodePng(render(512), 512);
await writeFile(join(outDir, 'icon.png'), png512);
console.log(`icon.png   512 px, ${png512.length} bytes`);

// A copy for the README and the web interface favicon.
await mkdir('assets', { recursive: true });
await writeFile(join('assets', 'icon.png'), encodePng(render(256), 256));
console.log('assets/icon.png  256 px');
