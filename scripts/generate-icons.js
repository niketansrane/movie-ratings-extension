const fs = require('fs');
const path = require('path');

// Simple PNG generator for extension icons
// Creates icons with a movie/star theme in Netflix red

function createPNG(size) {
  // PNG file structure
  const width = size;
  const height = size;

  // Create raw pixel data (RGBA)
  const pixels = [];
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = (size / 2) - 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= radius) {
        // Inside circle - Netflix red gradient
        const gradient = 1 - (dist / radius) * 0.3;
        const r = Math.floor(229 * gradient); // Netflix red
        const g = Math.floor(9 * gradient);
        const b = Math.floor(20 * gradient);

        // Add a simple star shape in the center
        const starAngle = Math.atan2(dy, dx);
        const starRadius = radius * 0.5;
        const points = 5;
        const starDist = dist / starRadius;

        // Simple star detection
        const angleNorm = ((starAngle + Math.PI) / (2 * Math.PI)) * points * 2;
        const isStarPoint = (angleNorm % 2) < 1;
        const starThreshold = isStarPoint ? 0.7 : 0.4;

        if (dist < starRadius * starThreshold) {
          // Gold star
          pixels.push(245, 197, 24, 255); // #f5c518 - IMDb gold
        } else {
          pixels.push(r, g, b, 255);
        }
      } else {
        // Outside circle - transparent
        pixels.push(0, 0, 0, 0);
      }
    }
  }

  return createPNGBuffer(width, height, pixels);
}

function createPNGBuffer(width, height, pixels) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type (RGBA)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = createChunk('IHDR', ihdr);

  // IDAT chunk (image data)
  const rawData = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    rawData[offset++] = 0; // filter byte
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rawData[offset++] = pixels[idx];     // R
      rawData[offset++] = pixels[idx + 1]; // G
      rawData[offset++] = pixels[idx + 2]; // B
      rawData[offset++] = pixels[idx + 3]; // A
    }
  }

  const zlib = require('zlib');
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = createChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type);
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);

  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  const table = makeCRCTable();

  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeCRCTable() {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
}

// Generate icons
const sizes = [16, 48, 128];
const iconsDir = path.join(__dirname, '..', 'icons');

sizes.forEach(size => {
  const png = createPNG(size);
  const filepath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filepath, png);
  console.log(`Created ${filepath}`);
});

console.log('Icons generated successfully!');
