/**
 * LOCRIUM — Preload script (renderer process bridge)
 *
 * Exposes a safe, minimal API to the renderer via contextBridge.
 * NO node APIs are exposed directly. All communication goes through IPC.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Channels the renderer is allowed to receive from main
const ALLOWED_RECEIVE = [
  'tab-updated',
  'active-tab-changed',
  'tabs-state',
  'download-started',
  'download-updated',
  'download-completed',
  'notice',
  'search-service-status',
  'browser-update-status',
  'privacy-status-updated',
  'high-security-changed',
  'fullscreen-changed',
  'md-convert-progress',
  'md-convert-combined',
];

contextBridge.exposeInMainWorld('locrium', {
  // ── Navigation ──
  navigate: (id, url) => ipcRenderer.invoke('navigate', { id, url }),
  goBack: (id) => ipcRenderer.invoke('go-back', { id }),
  goForward: (id) => ipcRenderer.invoke('go-forward', { id }),
  reload: (id) => ipcRenderer.invoke('reload', { id }),
  stopLoading: (id) => ipcRenderer.invoke('stop-loading', { id }),
  goHome: (id) => ipcRenderer.invoke('go-home', { id }),
  getNavState: (id) => ipcRenderer.invoke('get-nav-state', { id }),

  // ── Tabs ──
  newTab: (url, incognito) => ipcRenderer.invoke('new-tab', { url, incognito }),
  closeTab: (id) => ipcRenderer.invoke('close-tab', { id }),
  switchTab: (id) => ipcRenderer.invoke('switch-tab', { id }),
  getTabs: () => ipcRenderer.invoke('get-tabs'),
  getActiveTab: () => ipcRenderer.invoke('get-active-tab'),

  // ── Settings ──
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (updates) => ipcRenderer.invoke('save-settings', updates),
  chooseDownloadFolder: () => ipcRenderer.invoke('choose-download-folder'),

  // ── Bookmarks ──
  getBookmarks: () => ipcRenderer.invoke('get-bookmarks'),
  addBookmark: (url, title, favicon) => ipcRenderer.invoke('add-bookmark', { url, title, favicon }),
  removeBookmark: (url) => ipcRenderer.invoke('remove-bookmark', { url }),
  isBookmarked: (url) => ipcRenderer.invoke('is-bookmarked', { url }),

  // ── History ──
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  // ── Downloads ──
  getDownloads: () => ipcRenderer.invoke('get-downloads'),
  openDownload: (filePath) => ipcRenderer.invoke('open-download', { filePath }),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', { filePath }),

  // ── Privacy / clear data ──
  clearData: (opts) => ipcRenderer.invoke('clear-data', opts),

  // ── Privacy mode / anti-fingerprinting ──
  getPrivacyStatus:  () => ipcRenderer.invoke('get-privacy-status'),
  clearBlockedLog:   () => ipcRenderer.invoke('clear-blocked-log'),
  restartApp:        () => ipcRenderer.invoke('restart-app'),

  // ── High Security Mode (instant, no restart) ──
  getHighSecurity:    () => ipcRenderer.invoke('get-high-security'),
  toggleHighSecurity: (enabled) => ipcRenderer.invoke('toggle-high-security', { enabled }),

  // ── Per-site privacy controls ──
  getSitePrivacy:  (hostname) => ipcRenderer.invoke('get-site-privacy', { hostname }),
  setSitePrivacy:  (hostname, siteSettings) => ipcRenderer.invoke('set-site-privacy', { hostname, siteSettings }),

  // ── Fullscreen ──
  exitFullscreen: (id) => ipcRenderer.invoke('exit-fullscreen', { id }),

  // ── Popover (reserves space below navbar by pushing BrowserView down) ──
  popoverReserve: (h) => ipcRenderer.invoke('popover-reserve', { h }),
  popoverRelease: ()  => ipcRenderer.invoke('popover-release'),

  // ── Panel (shrinks BrowserView width from the right so slide-in panels are usable) ──
  panelOpen:  (w) => ipcRenderer.invoke('panel-open', { w }),
  panelClose: ()  => ipcRenderer.invoke('panel-close'),

  // ── Ad-block quick toggle ──
  getAdBlock:    ()         => ipcRenderer.invoke('get-ad-block'),
  toggleAdBlock: (enabled)  => ipcRenderer.invoke('toggle-ad-block', { enabled }),

  // ── Search engine log ──
  getEngineLog: () => ipcRenderer.invoke('get-engine-log'),

  // ── Dev tools & zoom ──
  toggleDevTools: (id) => ipcRenderer.invoke('toggle-devtools', { id }),
  zoomIn: (id) => ipcRenderer.invoke('zoom-in', { id }),
  zoomOut: (id) => ipcRenderer.invoke('zoom-out', { id }),
  zoomReset: (id) => ipcRenderer.invoke('zoom-reset', { id }),

  // ── JS / images ──
  toggleJs: (id, enabled) => ipcRenderer.invoke('toggle-js', { id, enabled }),

  // ── Window controls ──
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),

  // ── Private window ──
  newPrivateWindow: () => ipcRenderer.invoke('new-private-window'),

  // ── Search service control ──
  searchServiceStart:   () => ipcRenderer.invoke('search-service-start'),
  searchServiceStop:    () => ipcRenderer.invoke('search-service-stop'),
  searchServiceRestart: () => ipcRenderer.invoke('search-service-restart'),
  searchServiceHealth:  () => ipcRenderer.invoke('search-service-health'),
  searchServiceStatus:  () => ipcRenderer.invoke('search-service-status'),

  // ── Updates ──
  checkSearchUpdates:   () => ipcRenderer.invoke('check-search-updates'),
  applySearchUpdate:    (downloadUrl) => ipcRenderer.invoke('apply-search-update', { downloadUrl }),
  checkBrowserUpdates:  () => ipcRenderer.invoke('check-browser-updates'),
  downloadBrowserUpdate:() => ipcRenderer.invoke('download-browser-update'),
  getAppVersion:        () => ipcRenderer.invoke('get-app-version'),

  // ── Markdown converter ──
  openFileDialog:            (opts)        => ipcRenderer.invoke('open-file-dialog', opts || {}),
  expandPaths:               (inputPaths)  => ipcRenderer.invoke('expand-paths', { inputPaths }),
  convertToMarkdown:         (opts)        => ipcRenderer.invoke('convert-to-markdown', opts),
  openMarkdownOutputFolder:  ()            => ipcRenderer.invoke('open-markdown-output-folder'),

  // ── Event listeners ──
  on: (channel, callback) => {
    if (!ALLOWED_RECEIVE.includes(channel)) return;
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  off: (channel, callback) => {
    if (!ALLOWED_RECEIVE.includes(channel)) return;
    ipcRenderer.removeListener(channel, callback);
  },
});
