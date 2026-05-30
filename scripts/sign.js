'use strict';
/**
 * LOCRIUM Code Signing Hook
 *
 * Called automatically by electron-builder during a Windows build when
 * the `win.sign` field in package.json points here.
 *
 * Also callable manually via `npm run sign` (passes --manual flag which
 * triggers signing of the already-built dist/ artefacts without a build).
 *
 * Environment variables:
 *   LOCRIUM_CERT_PATH  — Absolute path to the PFX/P12 certificate file
 *   LOCRIUM_CERT_PASS  — Certificate password (keep this out of source control)
 *
 * If LOCRIUM_CERT_PATH is not set, signing is skipped silently so that
 * development builds work without a certificate.
 */

const path        = require('path');
const { execSync, spawnSync } = require('child_process');

const TIMESTAMP_URL = 'http://timestamp.digicert.com';

/**
 * Sign a single file using signtool.exe.
 * @param {string} filePath  Absolute path to the EXE/DLL to sign.
 * @param {string} certPath  Absolute path to the PFX certificate.
 * @param {string} certPass  Certificate password.
 */
function signFile(filePath, certPath, certPass) {
  const args = [
    'sign',
    '/f', certPath,
    '/p', certPass,
    '/tr', TIMESTAMP_URL,
    '/td', 'sha256',
    '/fd', 'sha256',
    '/q',
    filePath,
  ];

  const result = spawnSync('signtool.exe', args, { stdio: 'pipe' });

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString().trim() : '';
    const stdout = result.stdout ? result.stdout.toString().trim() : '';
    throw new Error(`signtool failed (exit ${result.status}):\n${stderr || stdout}`);
  }

  console.log(`[sign] Signed: ${path.basename(filePath)}`);
}

/**
 * Verify a signed file.
 * @param {string} filePath
 */
function verifyFile(filePath) {
  const result = spawnSync('signtool.exe', ['verify', '/pa', '/q', filePath], { stdio: 'pipe' });
  if (result.status !== 0) {
    console.warn(`[sign] WARNING: verification failed for ${path.basename(filePath)}`);
  } else {
    console.log(`[sign] Verified: ${path.basename(filePath)}`);
  }
}

// ── electron-builder hook export ─────────────────────────────────────────────

/**
 * electron-builder calls this function for each file that needs signing.
 * The `configuration` object has at minimum a `path` property.
 */
async function sign(configuration) {
  const certPath = process.env.LOCRIUM_CERT_PATH;
  const certPass = process.env.LOCRIUM_CERT_PASS || '';

  if (!certPath) {
    console.log('[sign] LOCRIUM_CERT_PATH not set — skipping code signing (dev build)');
    return;
  }

  const filePath = configuration.path;
  if (!filePath) {
    console.warn('[sign] No file path in configuration — skipping');
    return;
  }

  signFile(filePath, certPath, certPass);
}

module.exports = sign;

// ── Manual signing mode (npm run sign) ───────────────────────────────────────

if (require.main === module || process.argv.includes('--manual')) {
  const certPath = process.env.LOCRIUM_CERT_PATH;
  const certPass = process.env.LOCRIUM_CERT_PASS || '';

  if (!certPath) {
    console.error('[sign] ERROR: LOCRIUM_CERT_PATH environment variable is not set.');
    console.error('[sign] Set it to the absolute path of your PFX certificate, then re-run:');
    console.error('[sign]   set LOCRIUM_CERT_PATH=C:\\path\\to\\locrium.pfx');
    console.error('[sign]   set LOCRIUM_CERT_PASS=your-password');
    console.error('[sign]   npm run sign');
    process.exit(1);
  }

  const distDir  = path.join(__dirname, '..', 'dist');
  const targets  = [
    path.join(distDir, 'Locrium.exe'),
    path.join(distDir, 'LocriumSetup.exe'),
  ];

  let ok = true;
  for (const t of targets) {
    const fs = require('fs');
    if (!fs.existsSync(t)) {
      console.warn(`[sign] Skipping (not found): ${t}`);
      continue;
    }
    try {
      signFile(t, certPath, certPass);
      verifyFile(t);
    } catch (err) {
      console.error(`[sign] FAILED: ${err.message}`);
      ok = false;
    }
  }

  if (!ok) process.exit(1);
  console.log('[sign] All done.');
}
