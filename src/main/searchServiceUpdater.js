/**
 * LOCRIUM — Search Service Updater
 *
 * Checks for updates to the local search service by polling a manifest
 * endpoint at locrium.com. Designed to be called on demand (from the health
 * panel or settings) rather than on a background timer.
 *
 * Update flow:
 *   1. Fetch https://locrium.com/search/latest.json
 *   2. Compare latest.version to the currently running version
 *   3. If newer, download the update package
 *   4. Stop the running service
 *   5. Extract and replace files
 *   6. Restart the service
 *   7. Run a health check
 *   8. Report result back to the caller
 *
 * NOTE: The download/replace steps are SCAFFOLDED but not fully implemented
 * because there is no real update server yet. When you publish locrium.com,
 * implement the download + extraction in `applyUpdate()`.
 */

'use strict';

const https   = require('https');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { app } = require('electron');

// ── Config ────────────────────────────────────────────────────────────────────

// TODO: Replace with the real manifest URL when locrium.com is live.
const UPDATE_MANIFEST_URL = 'https://locrium.com/search/latest.json';

// Local path where updated service files would be placed.
// In production, this lives next to the Electron binary.
const SERVICE_INSTALL_DIR = path.join(
  app ? app.getPath('userData') : os.homedir(),
  'locrium-search'
);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check if a newer version of the search service is available.
 * @param {string} currentVersion - e.g. '1.0.0'
 * @returns {Promise<{ available: boolean, current: string, latest: string|null, error: string|null }>}
 */
async function checkForUpdates(currentVersion) {
  let manifest = null;
  let error    = null;

  try {
    manifest = await fetchJson(UPDATE_MANIFEST_URL);
  } catch (err) {
    // Expected when locrium.com is not yet live.
    error = `Could not reach update server: ${err.message}`;
    return { available: false, current: currentVersion, latest: null, error };
  }

  const latest = manifest.version || null;
  if (!latest) {
    return { available: false, current: currentVersion, latest: null, error: 'Manifest missing version field' };
  }

  const available = isNewer(latest, currentVersion);
  return { available, current: currentVersion, latest, error: null, downloadUrl: manifest.download || null };
}

/**
 * Download, install, and restart the search service.
 *
 * @param {string} downloadUrl - URL of the update package
 * @param {object} searchServiceManager - the manager module (for restart)
 * @returns {Promise<{ success: boolean, error: string|null }>}
 */
async function applyUpdate(downloadUrl, searchServiceManager) {
  /*
   * TODO: Implement this when locrium.com update server is live.
   *
   * Steps:
   *   1. Download the package from `downloadUrl` to a temp file
   *   2. Verify a checksum/signature (add to manifest)
   *   3. Stop the search service via searchServiceManager.stop()
   *   4. Extract / overwrite files in SERVICE_INSTALL_DIR
   *   5. Restart via searchServiceManager.start()
   *   6. Run searchServiceManager.healthCheck()
   *   7. Return { success: true } or { success: false, error: '...' }
   */
  return {
    success: false,
    error:   'Update installation not yet implemented — update server not live. ' +
             'Set up locrium.com/search/latest.json and implement applyUpdate().',
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compare semver strings. Returns true if `a` is newer than `b`.
 */
function isNewer(a, b) {
  const parse = (v) => v.split('.').map(Number);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}

/**
 * Fetch JSON over HTTPS (or HTTP for local testing).
 */
function fetchJson(rawUrl) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(rawUrl);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      timeout:  8000,
      headers:  { 'User-Agent': 'LOCRIUM-Updater/1.0' },
    };
    const req = lib.request(options, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Invalid JSON in manifest')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

module.exports = {
  checkForUpdates,
  applyUpdate,
  UPDATE_MANIFEST_URL,
  SERVICE_INSTALL_DIR,
};
