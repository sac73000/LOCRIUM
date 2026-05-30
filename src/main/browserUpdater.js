/**
 * LOCRIUM — Browser Updater
 *
 * Handles checking for and downloading browser (Electron app) updates.
 * Uses electron-updater (part of electron-builder) when available.
 *
 * In development mode (not packaged), update checks are simulated so the
 * health panel's "Check for Updates" button still works without a real
 * update server.
 *
 * To make real updates work:
 *   1. Publish your release to a GitHub repo or your own S3-compatible bucket.
 *   2. Set `publish` in electron-builder config (see package.json).
 *   3. The updater will find and install updates automatically.
 *
 * TODO: Configure the publish URL in package.json when locrium.com is ready.
 */

'use strict';

const { app } = require('electron');

// electron-updater is an optional dependency — only present after install.
// We lazy-require it so the app doesn't crash if it's missing in dev.
let autoUpdater = null;
let _statusCb   = null;
let _ready      = false;

function init() {
  try {
    autoUpdater = require('electron-updater').autoUpdater;

    // Don't auto-download — let the user decide.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      emit({ checking: true, available: null, error: null });
    });

    autoUpdater.on('update-available', (info) => {
      emit({ checking: false, available: true, version: info.version, error: null });
    });

    autoUpdater.on('update-not-available', (info) => {
      emit({ checking: false, available: false, version: info.version, error: null });
    });

    autoUpdater.on('error', (err) => {
      emit({ checking: false, available: null, error: err.message });
    });

    autoUpdater.on('download-progress', (progress) => {
      emit({ downloading: true, percent: Math.round(progress.percent) });
    });

    autoUpdater.on('update-downloaded', (info) => {
      emit({ downloaded: true, version: info.version, error: null });
    });

    _ready = true;
    console.log('[Locrium Updater] Browser updater initialized');
  } catch (err) {
    // electron-updater not installed or app not packaged — expected in dev.
    console.log('[Locrium Updater] electron-updater not available (dev mode):', err.message);
    _ready = false;
  }
}

/**
 * Register a callback for status events.
 * @param {(status: object) => void} cb
 */
function onStatus(cb) {
  _statusCb = cb;
}

/**
 * Check for a new browser version.
 * @returns {Promise<object>}
 */
async function checkForUpdates() {
  if (!_ready || !autoUpdater) {
    // Simulate check in dev/unpackaged mode
    return {
      checking: false,
      available: false,
      version: app.getVersion(),
      error: 'Update checking requires a packaged build. Run `npm run build:win` first.',
      devMode: true,
    };
  }

  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Download the pending update (call after update-available event).
 * @returns {Promise<object>}
 */
async function downloadUpdate() {
  if (!_ready || !autoUpdater) {
    return { ok: false, error: 'Not available in dev mode' };
  }
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Quit and install the downloaded update.
 */
function quitAndInstall() {
  if (_ready && autoUpdater) {
    autoUpdater.quitAndInstall();
  }
}

function emit(data) {
  if (_statusCb) _statusCb(data);
}

module.exports = {
  init,
  onStatus,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
};
