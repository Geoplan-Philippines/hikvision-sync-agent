// Generates build/icon.ico (256x256) from public/assets/app-logo-only.png.
// Pure Node (zlib only): decodes the RGBA PNG, upscales with premultiplied
// bilinear sampling, and packs the result as a PNG-in-ICO — the format
// electron-builder consumes for the Windows app / installer / shortcut icon.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'public', 'assets', 'app-logo-only.png');
const OUT_DIR = join(root, 'build');
const OUT = join(OUT_DIR, 'icon.ico');
const SIZE = 256;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (colorType !== 6 || bitDepth !== 8) throw new Error('Expected 8-bit RGBA PNG');
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const value = raw[rp++];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let recon;
      if (filter === 0) recon = value;
      else if (filter === 1) recon = value + a;
      else if (filter === 2) recon = value + b;
      else if (filter === 3) recon = value + ((a + b) >> 1);
      else if (filter === 4) recon = value + paeth(a, b, c);
      else throw new Error('Unknown filter ' + filter);
      out[y * stride + x] = recon & 0xff;
    }
  }
  return { width, height, data: out };
}

// Premultiplied bilinear scale into a square SIZE canvas, aspect preserved, centered.
function scaleSquare(src) {
  const { width: sw, height: sh, data } = src;
  const scale = Math.min(SIZE / sw, SIZE / sh);
  const dw = Math.round(sw * scale), dh = Math.round(sh * scale);
  const offX = Math.floor((SIZE - dw) / 2), offY = Math.floor((SIZE - dh) / 2);
  const dst = Buffer.alloc(SIZE * SIZE * 4, 0);
  const sample = (sx, sy) => {
    sx = Math.max(0, Math.min(sw - 1, sx));
    sy = Math.max(0, Math.min(sh - 1, sy));
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
    const fx = sx - x0, fy = sy - y0;
    const at = (x, y) => {
      const i = (y * sw + x) * 4;
      const a = data[i + 3] / 255;
      return [data[i] * a, data[i + 1] * a, data[i + 2] * a, data[i + 3]];
    };
    const p00 = at(x0, y0), p10 = at(x1, y0), p01 = at(x0, y1), p11 = at(x1, y1);
    const out = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const top = p00[k] * (1 - fx) + p10[k] * fx;
      const bot = p01[k] * (1 - fx) + p11[k] * fx;
      out[k] = top * (1 - fy) + bot * fy;
    }
    return out;
  };
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const [pr, pg, pb, pa] = sample((x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5);
      const di = ((y + offY) * SIZE + (x + offX)) * 4;
      const a = pa / 255;
      dst[di] = a > 0 ? Math.round(pr / a) : 0;
      dst[di + 1] = a > 0 ? Math.round(pg / a) : 0;
      dst[di + 2] = a > 0 ? Math.round(pb / a) : 0;
      dst[di + 3] = Math.round(pa);
    }
  }
  return dst;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(rgba) {
  const stride = SIZE * 4;
  const raw = Buffer.alloc(SIZE * (stride + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function wrapIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0; // 0 => 256
  entry[2] = 0; entry[3] = 0; entry[4] = 1; // color planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12);
  return Buffer.concat([header, entry, png]);
}

const decoded = decodePng(readFileSync(SOURCE));
const ico = wrapIco(encodePng(scaleSquare(decoded)));
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, ico);
console.log(`Wrote ${OUT} (${SIZE}x${SIZE}, ${ico.length} bytes) from ${decoded.width}x${decoded.height} source.`);
