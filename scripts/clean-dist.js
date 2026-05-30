'use strict';
/**
 * LOCRIUM dist/ cleanup — keeps exactly the two distributable artefacts
 *
 * Removes everything from dist/ that is not:
 *   - Locrium.exe      (portable)
 *   - LocriumSetup.exe (NSIS installer)
 *
 * electron-builder produces additional build artefacts (update manifests,
 * intermediate .7z packages, unpacked directories, etc.) that are only
 * needed for auto-update pipelines. This script cleans them after a
 * build:release run so that the dist/ directory contains only the two
 * end-user distributable files.
 *
 * Usage (called automatically by build:release):
 *   node scripts/clean-dist.js
 *
 * Set LOCRIUM_KEEP_ALL_DIST=1 to skip cleanup (useful for update pipelines).
 */

const fs   = require('fs');
const path = require('path');

const KEEP = new Set(['Locrium.exe', 'LocriumSetup.exe']);
const DIST = path.join(__dirname, '..', 'dist');

if (process.env.LOCRIUM_KEEP_ALL_DIST === '1') {
  console.log('[clean-dist] LOCRIUM_KEEP_ALL_DIST=1 — skipping cleanup');
  process.exit(0);
}

if (!fs.existsSync(DIST)) {
  console.warn('[clean-dist] dist/ directory not found — nothing to clean');
  process.exit(0);
}

let removed = 0;
let kept    = 0;

for (const entry of fs.readdirSync(DIST, { withFileTypes: true })) {
  if (KEEP.has(entry.name)) {
    console.log(`[clean-dist] keep  → ${entry.name}`);
    kept++;
    continue;
  }

  const fullPath = path.join(DIST, entry.name);
  try {
    if (entry.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
    console.log(`[clean-dist] rm    → ${entry.name}`);
    removed++;
  } catch (err) {
    console.warn(`[clean-dist] could not remove ${entry.name}: ${err.message}`);
  }
}

console.log(`[clean-dist] done — kept ${kept}, removed ${removed}`);

if (kept === 0) {
  console.warn('[clean-dist] WARNING: no distributable artefacts found in dist/');
  console.warn('[clean-dist] Expected: Locrium.exe and LocriumSetup.exe');
}
