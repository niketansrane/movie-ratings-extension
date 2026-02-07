'use strict';

/**
 * Package the extension into a .zip file ready for Chrome Web Store upload.
 * Usage: node scripts/package.js
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf-8'));
const version  = manifest.version;
const outName  = `netflix-ratings-overlay-v${version}.zip`;
const outPath  = path.join(root, 'dist', outName);

// Files / dirs to include
const include = [
  'manifest.json',
  'src/',
  'icons/',
  'LICENSE',
  'PRIVACY.md',
];

// Ensure dist/ exists
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

// Build the zip
const includeArgs = include.map(f => `"${f}"`).join(' ');

try {
  // Try using PowerShell Compress-Archive on Windows
  const tempDir = path.join(root, 'dist', '_pkg_temp');
  fs.mkdirSync(tempDir, { recursive: true });

  for (const item of include) {
    const src = path.join(root, item);
    const dst = path.join(tempDir, item);
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }

  // Remove any existing zip
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

  execSync(
    `powershell -Command "Compress-Archive -Path '${tempDir}\\*' -DestinationPath '${outPath}'"`,
    { cwd: root }
  );

  // Cleanup temp
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log(`✓ Packaged: dist/${outName}`);
} catch (err) {
  console.error('Packaging failed:', err.message);
  console.log('Tip: you can also zip manually — include: manifest.json, src/, icons/, LICENSE, PRIVACY.md');
  process.exit(1);
}
