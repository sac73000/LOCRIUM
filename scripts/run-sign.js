'use strict';
/**
 * LOCRIUM sign runner — cross-platform wrapper for scripts/sign.bat
 *
 * Called via `npm run sign`. On Windows it spawns sign.bat directly using
 * cmd.exe so all Windows environment variable expansion works correctly.
 * On non-Windows hosts it falls back to the Node.js sign.js manual mode,
 * which calls signtool.exe via spawnSync (useful from WSL or CI runners that
 * have signtool on PATH).
 *
 * Usage:
 *   npm run sign
 *
 * Required environment variables (same for both paths):
 *   LOCRIUM_CERT_PATH  — Full path to PFX/P12 certificate
 *   LOCRIUM_CERT_PASS  — Certificate password
 */

const path    = require('path');
const { spawn } = require('child_process');

const isWindows  = process.platform === 'win32';
const scriptsDir = __dirname;

if (isWindows) {
  // Spawn sign.bat via cmd.exe to preserve % variable expansion
  const batPath = path.join(scriptsDir, 'sign.bat');
  const proc = spawn('cmd.exe', ['/c', batPath], {
    stdio: 'inherit',
    env:   process.env,
  });
  proc.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[run-sign] sign.bat exited with code ${code}`);
      process.exit(code);
    }
  });
} else {
  // Non-Windows: delegate to sign.js manual mode (requires signtool on PATH)
  console.log('[run-sign] Non-Windows host — delegating to sign.js --manual');
  const signPath = path.join(scriptsDir, 'sign.js');
  // Re-use sign.js by requiring it and calling the manual block
  process.argv.push('--manual');
  require(signPath);
}
