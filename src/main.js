/**
 * LOCRIUM — Main Process
 *
 * Entry point for the Electron main process. Manages:
 *  - BrowserWindow creation
 *  - BrowserView (tab) lifecycle
 *  - IPC communication with the renderer
 *  - Settings, bookmarks, history, and downloads storage
 *  - Privacy and permission handling
 *  - Electron security best practices
 *  - Local search service lifecycle
 *  - Browser and search service update checking
 */

'use strict';

const {
  app,
  BrowserWindow,
  BrowserView,
  ipcMain,
  session,
  dialog,
  shell,
  protocol,
  nativeTheme,
  Menu,
  MenuItem,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── New modules ───────────────────────────────────────────────────────────────
const searchService        = require('./main/searchServiceManager');
const searchServiceUpdater = require('./main/searchServiceUpdater');
const browserUpdater       = require('./main/browserUpdater');

// ── Config & Storage ────────────────────────────────────────────────────────

const Store = require('electron-store');

const settingsStore = new Store({
  name: 'settings',
  defaults: {
    // Search service
    searxngUrl:            'http://127.0.0.1:8888',
    searchServicePort:     8888,
    homepage:              'http://127.0.0.1:8888/',

    // Privacy & Security
    blockTrackers:         true,   // Ad/tracker domain blocklist
    blockThirdPartyCookies:true,   // Block cross-site cookies
    sendDnt:               true,   // Send Do Not Track header
    resistFingerprinting:  true,   // Strip/normalise fingerprinting surfaces
    blockWebRTC:           true,   // Prevent WebRTC IP leaks
    forceHttpsUpgrade:     false,  // Redirect HTTP → HTTPS (off by default: breaks localhost)
    blockMixedContent:     true,   // Block HTTP on HTTPS pages
    denyNotifications:     true,   // Auto-deny notification requests
    denyGeolocation:       true,   // Auto-deny geolocation requests
    blockCameraMic:        true,   // Block camera/microphone
    blockAutoplay:         true,   // Require click before media plays (set at launch)
    javascriptEnabled:     true,
    imagesEnabled:         true,

    // Hardware
    disableGpu:            false,  // Disable GPU acceleration (requires restart)
    disableMediaKeys:      true,   // Prevent OS media key capture

    // Privacy Mode (anti-fingerprinting) — requires restart for full effect
    privacyModeEnabled:          false, // Master toggle: enables all FP protections + GPU disable
    blockWebGPU:                 true,  // Inject script to hide navigator.gpu
    blockWebGL:                  false, // Inject script to disable WebGL context creation
    resistCanvasFingerprinting:  true,  // Inject script to add noise to canvas read APIs
    blockKnownTrackingScripts:   true,  // Block requests to fingerprinting/tracking script CDNs

    // General
    downloadFolder:        app.getPath('downloads'),
    userAgent:             '',
    alwaysNewTab:          false,

    // Appearance
    darkMode:              true,

    // High Security Mode — instant toggle, no restart required
    highSecurityMode:      false,

    // Search profile — persisted across restarts
    searchProfile:         'standard',
  },
});

// ── Apply launch-time command-line switches (must run before app.whenReady) ──
// These affect the Chromium engine and cannot be changed at runtime.
// NOTE: privacyModeEnabled also disables GPU — change requires restart.
if (settingsStore.get('disableGpu') || settingsStore.get('privacyModeEnabled')) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}
if (settingsStore.get('blockAutoplay')) {
  app.commandLine.appendSwitch('autoplay-policy', 'user-gesture-required');
}
if (settingsStore.get('disableMediaKeys')) {
  app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
}

const bookmarksStore  = new Store({ name: 'bookmarks',     defaults: { items: [] } });
const historyStore    = new Store({ name: 'history',       defaults: { items: [] } });
const downloadsStore  = new Store({ name: 'downloads',     defaults: { items: [] } });
const sitePrivacyStore = new Store({ name: 'site-privacy', defaults: { sites: {} } });

// ── Ad / tracker block list ──────────────────────────────────────────────────

const BLOCK_LIST_PATH = path.join(__dirname, '..', 'resources', 'blocklist.txt');
let blockedDomains = new Set();

function loadBlocklist() {
  try {
    if (fs.existsSync(BLOCK_LIST_PATH)) {
      const lines = fs.readFileSync(BLOCK_LIST_PATH, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          blockedDomains.add(trimmed.toLowerCase());
        }
      }
      console.log(`[Locrium] Loaded ${blockedDomains.size} blocked domains`);
    }
  } catch (e) {
    console.warn('[Locrium] Could not load blocklist:', e.message);
  }
}

function isDomainBlocked(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (blockedDomains.has(hostname)) return true;
    const parts = hostname.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      if (blockedDomains.has(parts.slice(i).join('.'))) return true;
    }
  } catch (_) {}
  return false;
}

// ── Privacy blocklist (fingerprinting / tracking scripts) ────────────────────

const PRIVACY_BLOCKLIST_PATH = path.join(__dirname, '..', 'resources', 'privacy-blocklist.json');
let privacyBlockedDomains = new Set();

// Per-session diagnostics counters (reset on clear-blocked-log)
let privacyBlockedCount = 0;
const privacyBlockedLog = []; // capped at 300 entries

function loadPrivacyBlocklist() {
  try {
    if (fs.existsSync(PRIVACY_BLOCKLIST_PATH)) {
      const data = JSON.parse(fs.readFileSync(PRIVACY_BLOCKLIST_PATH, 'utf8'));
      const categories = data.categories || {};
      for (const domains of Object.values(categories)) {
        for (const d of domains) {
          privacyBlockedDomains.add(d.toLowerCase().trim());
        }
      }
      console.log(`[Locrium] Privacy blocklist loaded — ${privacyBlockedDomains.size} domains`);
    }
  } catch (e) {
    console.warn('[Locrium] Could not load privacy-blocklist.json:', e.message);
  }
}

function isPrivacyDomainBlocked(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (privacyBlockedDomains.has(hostname)) return true;
    const parts = hostname.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      if (privacyBlockedDomains.has(parts.slice(i).join('.'))) return true;
    }
  } catch (_) {}
  return false;
}

function logPrivacyBlock(url) {
  privacyBlockedCount++;
  if (privacyBlockedLog.length >= 300) privacyBlockedLog.shift();
  privacyBlockedLog.push({ url, ts: Date.now() });
}

// ── Per-site privacy helpers ──────────────────────────────────────────────────

const DEFAULT_SITE_PRIVACY = { disableJs: false, blockCookies: false, blockTrackers: false, spoofUserAgent: '' };

function getSitePrivacy(hostnameOrUrl) {
  let hostname = hostnameOrUrl;
  if (hostnameOrUrl.startsWith('http')) {
    try { hostname = new URL(hostnameOrUrl).hostname; } catch (_) { return DEFAULT_SITE_PRIVACY; }
  }
  const sites = sitePrivacyStore.get('sites') || {};
  return Object.assign({}, DEFAULT_SITE_PRIVACY, sites[hostname] || {});
}

function setSitePrivacy(hostname, newSettings) {
  const sites = sitePrivacyStore.get('sites') || {};
  sites[hostname] = Object.assign({}, DEFAULT_SITE_PRIVACY, sites[hostname] || {}, newSettings);
  sitePrivacyStore.set('sites', sites);
  return sites[hostname];
}

// ── Anti-fingerprinting script builder ───────────────────────────────────────
//
// Builds JavaScript that is injected into every page's MAIN world at dom-ready.
// Important limitations:
//   - Runs at dom-ready, not at navigation start — scripts loaded in <head>
//     before DOMContentLoaded may already have read fingerprint surfaces.
//   - This is best-effort protection, not a guarantee of anonymity.
//   - WebGL/WebGPU blocking will break 3D content, maps, and games.
//   - Canvas noise is invisible to humans but breaks exact fingerprint matching.

function buildAntiFpScript(s) {
  const on = !!s.privacyModeEnabled;
  const parts = [];

  // ── Block WebGPU ──────────────────────────────────────────────────────────
  // Hides navigator.gpu so pages cannot enumerate GPU capabilities.
  if (on || s.blockWebGPU) {
    parts.push(`(function(){
  /* LOCRIUM: WebGPU blocked — prevents GPU model/driver fingerprinting */
  try {
    Object.defineProperty(navigator, 'gpu', {
      get: function(){ return undefined; },
      configurable: false, enumerable: false
    });
  } catch(e) {}
})();`);
  }

  // ── Block WebGL ───────────────────────────────────────────────────────────
  // Returns null for all WebGL context requests. Breaks 3D content.
  if (on || s.blockWebGL) {
    parts.push(`(function(){
  /* LOCRIUM: WebGL blocked — prevents GPU renderer/vendor fingerprinting.
   * WARNING: This will break 3D graphics, WebGL games, some maps. */
  var _orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type) {
    if (type === 'webgl' || type === 'webgl2' ||
        type === 'experimental-webgl' || type === 'experimental-webgl2') {
      return null;
    }
    return _orig.apply(this, arguments);
  };
})();`);
  }

  // ── Canvas fingerprinting resistance ─────────────────────────────────────
  // Flips one bit in pixel data returned by canvas extraction APIs.
  // Invisible to users, but breaks exact fingerprint hash matching.
  // Does NOT block canvas drawing — only extraction calls are affected.
  if (on || s.resistCanvasFingerprinting) {
    parts.push(`(function(){
  /* LOCRIUM: Canvas FP resistance — flips one pixel bit in extraction calls.
   * Limitation: best-effort; does not stop all canvas-based fingerprinting. */
  function noisyPixel(canvas) {
    try {
      var ctx = canvas.getContext && canvas.getContext('2d');
      if (ctx && canvas.width > 0 && canvas.height > 0) {
        var d = ctx.getImageData(0, 0, 1, 1);
        d.data[0] ^= 1;
        ctx.putImageData(d, 0, 0);
      }
    } catch(e) {}
  }
  var _origURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function() {
    noisyPixel(this);
    return _origURL.apply(this, arguments);
  };
  var _origBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function() {
    noisyPixel(this);
    return _origBlob.apply(this, arguments);
  };
  var _origGID = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function() {
    var r = _origGID.apply(this, arguments);
    if (r && r.data && r.data.length > 0) r.data[0] ^= 1;
    return r;
  };
})();`);
  }

  return parts.join('\n');
}

// ── Session configuration ────────────────────────────────────────────────────

function configureSession(ses) {
  const settings = settingsStore.store;

  // ── Ad / tracker blocking ───────────────────────────────────────────────────
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const s = settingsStore.store;

    // Block WebRTC bootstrap requests (ICE, STUN, TURN)
    if (s.blockWebRTC) {
      const u = details.url || '';
      if (u.startsWith('stun:') || u.startsWith('turn:')) {
        callback({ cancel: true });
        return;
      }
    }
    // Tracker / ad domain blocklist (general)
    if (s.blockTrackers && isDomainBlocked(details.url)) {
      callback({ cancel: true });
      return;
    }
    // High Security Mode: block all third-party requests from tracking domains
    if (s.highSecurityMode && isDomainBlocked(details.url)) {
      callback({ cancel: true });
      return;
    }
    // Per-site tracker blocking (check initiator origin)
    if (details.initiator) {
      const sitep = getSitePrivacy(details.initiator);
      if (sitep.blockTrackers && isDomainBlocked(details.url)) {
        callback({ cancel: true });
        return;
      }
    }
    // Privacy blocklist — known fingerprinting/tracking script CDNs
    if (s.blockKnownTrackingScripts && isPrivacyDomainBlocked(details.url)) {
      logPrivacyBlock(details.url);
      callback({ cancel: true });
      return;
    }
    // HTTPS upgrade
    if (s.forceHttpsUpgrade) {
      try {
        const parsed = new URL(details.url);
        if (parsed.protocol === 'http:' &&
            parsed.hostname !== '127.0.0.1' &&
            parsed.hostname !== 'localhost') {
          parsed.protocol = 'https:';
          callback({ redirectURL: parsed.toString() });
          return;
        }
      } catch (_) {}
    }
    callback({});
  });

  // ── Header manipulation ─────────────────────────────────────────────────────
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const s = settingsStore.store;
    const h = details.requestHeaders;

    // Do Not Track
    if (s.sendDnt) {
      h['DNT'] = '1';
      h['Sec-GPC'] = '1'; // Global Privacy Control (newer standard)
    }

    // High Security Mode: add extra privacy headers and remove tracking headers
    if (s.highSecurityMode) {
      h['DNT'] = '1';
      h['Sec-GPC'] = '1';
      delete h['X-Client-Data'];
      delete h['Purpose'];
      delete h['Sec-CH-UA'];
      delete h['Sec-CH-UA-Mobile'];
      delete h['Sec-CH-UA-Platform'];
    }

    // Strip Referrer on cross-origin requests when fingerprinting resistance is on
    if (s.resistFingerprinting) {
      const origin = h['Origin'] || '';
      const referer = h['Referer'] || '';
      if (referer && origin && !referer.startsWith(origin)) {
        delete h['Referer'];
      }
      // Remove Chromium telemetry headers
      delete h['X-Client-Data'];
      delete h['Purpose'];
    }

    // Global user-agent override (lower priority — applied first so per-site can win)
    if (s.userAgent) {
      h['User-Agent'] = s.userAgent;
    }

    // Per-site user-agent spoof (highest priority — always overrides global UA)
    // Use the initiator when present; fall back to the request URL itself
    // so that main-frame (top-level document) requests are also covered.
    {
      const uaSource = details.initiator || details.url;
      if (uaSource) {
        const sitep = getSitePrivacy(uaSource);
        if (sitep.spoofUserAgent) {
          h['User-Agent'] = sitep.spoofUserAgent;
        }
      }
    }

    callback({ requestHeaders: h });
  });

  // ── Response header hardening ───────────────────────────────────────────────
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    const s = settingsStore.store;
    const h = { ...details.responseHeaders };

    // Block mixed content on HTTPS pages (override server header if needed)
    if (s.blockMixedContent) {
      const csp = h['content-security-policy'] || h['Content-Security-Policy'];
      if (!csp) {
        h['Content-Security-Policy'] = ['upgrade-insecure-requests'];
      }
    }

    // Remove tracking headers from responses
    if (s.resistFingerprinting || s.highSecurityMode) {
      delete h['X-Request-ID'];
      delete h['Server-Timing'];
    }

    // Per-site cookie blocking: strip Set-Cookie from blocked sites
    if (details.initiator) {
      const sitep = getSitePrivacy(details.initiator);
      if (sitep.blockCookies || s.highSecurityMode) {
        // Only block third-party cookies (initiator ≠ URL host)
        try {
          const reqHost = new URL(details.url).hostname;
          const initHost = new URL(details.initiator).hostname;
          if (reqHost !== initHost && !initHost.endsWith('.' + reqHost) && !reqHost.endsWith('.' + initHost)) {
            delete h['set-cookie'];
            delete h['Set-Cookie'];
          }
        } catch (_) {}
      }
    }

    // ── Per-site JavaScript disable: inject script-src 'none' CSP ──────────
    // Applies to document (main-frame) responses only to avoid blocking
    // subresources of other allowed sites sharing the session.
    try {
      const reqHostname = new URL(details.url).hostname;
      const sitepForHost = getSitePrivacy(reqHostname);
      if ((sitepForHost.disableJs || s.highSecurityMode) &&
          details.resourceType === 'mainFrame') {
        // Merge with existing CSP if present (pick first that exists)
        const existingKey = Object.keys(h).find((k) => k.toLowerCase() === 'content-security-policy');
        if (existingKey) {
          // Prepend script-src 'none'; retains other directives
          h[existingKey] = [`script-src 'none'; ${h[existingKey][0] || ''}`];
        } else {
          h['Content-Security-Policy'] = ["script-src 'none'"];
        }
      }
    } catch (_) {}

    callback({ responseHeaders: h });
  });
}

// ── Permission handling (deny by default) ───────────────────────────────────

function configurePermissions(ses, win) {
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const settings = settingsStore.store;
    const ALWAYS_ALLOWED = ['clipboard-read', 'clipboard-sanitized-write'];

    if (ALWAYS_ALLOWED.includes(permission)) { callback(true); return; }

    // High Security Mode: deny ALL sensitive permissions instantly, no dialog
    if (settings.highSecurityMode) { callback(false); return; }

    // Auto-deny based on individual settings
    if (permission === 'notifications' && settings.denyNotifications) { callback(false); return; }
    if (permission === 'geolocation'   && settings.denyGeolocation)    { callback(false); return; }
    if (permission === 'media'         && settings.blockCameraMic)      { callback(false); return; }

    // For any remaining sensitive permission, ask the user
    const SENSITIVE = ['media', 'geolocation', 'notifications', 'midi', 'pointerLock'];
    if (SENSITIVE.includes(permission) && win) {
      const origin = details.requestingUrl
        ? (() => { try { return new URL(details.requestingUrl).origin; } catch (_) { return 'this page'; } })()
        : 'this page';
      dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Allow', 'Deny'],
        defaultId: 1,
        title: 'Permission Request',
        message: `"${origin}" wants: ${permission}`,
        detail: 'LOCRIUM protects your privacy — deny unless you trust this site.',
      }).then(({ response }) => callback(response === 0));
      return;
    }

    callback(false); // deny everything else silently
  });

  ses.setPermissionCheckHandler((_webContents, permission) => {
    const settings = settingsStore.store;
    const ALWAYS_ALLOWED = ['clipboard-read', 'clipboard-sanitized-write'];
    if (ALWAYS_ALLOWED.includes(permission)) return true;
    // High Security Mode: hard-deny all sensitive permissions
    if (settings.highSecurityMode) return false;
    if (permission === 'notifications' && settings.denyNotifications) return false;
    if (permission === 'geolocation'   && settings.denyGeolocation)   return false;
    if (permission === 'media'         && settings.blockCameraMic)    return false;
    return false;
  });
}

// ── Main window ──────────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow() {
  loadBlocklist();
  loadPrivacyBlocklist();
  configureSession(session.defaultSession);
  configurePermissions(session.defaultSession, null); // will be rebound with win below

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hidden',
    frame: false,
    backgroundColor: '#0d0d1a',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      // Security best practices
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      // Renderer process preferences
      devTools: true,
    },
  });

  // Rebind permissions with win reference
  configurePermissions(session.defaultSession, mainWindow);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Apply dark mode immediately
  nativeTheme.themeSource = settingsStore.get('darkMode') ? 'dark' : 'light';

  // Remove default menu
  Menu.setApplicationMenu(null);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Resize/move: adjust BrowserViews to match content area
  mainWindow.on('resize', () => updateActiveViewBounds());
  mainWindow.on('move', () => updateActiveViewBounds());

  // ── BrowserWindow fullscreen (F11 / window chrome button, or triggered by HTML fullscreen) ──
  // When the OS-level window goes fullscreen the BrowserView must fill the entire
  // content area. If htmlFullscreenActive is set, this was triggered by a page
  // (e.g. YouTube) and the renderer was already notified — skip the duplicate event.
  mainWindow.on('enter-full-screen', () => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab) return;
    const [w, h] = mainWindow.getContentSize();
    activeTab.view.setBounds({ x: 0, y: 0, width: w, height: h });
    if (!htmlFullscreenActive) {
      sendToRenderer('fullscreen-changed', { tabId: activeTabId, fullscreen: true });
    }
  });

  mainWindow.on('leave-full-screen', () => {
    updateActiveViewBounds();
    if (!htmlFullscreenActive) {
      sendToRenderer('fullscreen-changed', { tabId: activeTabId, fullscreen: false });
    }
  });

  // ── Wire up search service status changes → renderer ──
  searchService.onStatusChange((status) => {
    sendToRenderer('search-service-status', status);
  });

  // ── Init browser updater ──
  browserUpdater.init();
  browserUpdater.onStatus((data) => {
    sendToRenderer('browser-update-status', data);
  });

  setupIPC();
}

// ── Tab management ───────────────────────────────────────────────────────────

/*
 * tabs: Array of { id, view, title, url, favicon, loading, incognito }
 * activeTabId: id of the currently visible tab
 */
let tabs = [];
let activeTabId = null;
let nextTabId = 0;
let htmlFullscreenActive = false; // true while a page-level fullscreen (e.g. YouTube) is live

const NAV_BAR_HEIGHT = 80; // px — matches renderer CSS
const TAB_BAR_HEIGHT = 36; // px

function getContentBounds() {
  if (!mainWindow) return { x: 0, y: 0, width: 800, height: 600 };
  const [w, h] = mainWindow.getContentSize();
  return {
    x: 0,
    y: NAV_BAR_HEIGHT + TAB_BAR_HEIGHT,
    width: w,
    height: h - NAV_BAR_HEIGHT - TAB_BAR_HEIGHT,
  };
}

function updateActiveViewBounds() {
  const activeTab = tabs.find((t) => t.id === activeTabId);
  if (!activeTab) return;
  activeTab.view.setBounds(getContentBounds());
}

function createTab(url, incognito = false) {
  const id = nextTabId++;

  // Private tabs use a fresh in-memory session
  let ses;
  if (incognito) {
    ses = session.fromPartition(`private-${id}`, { cache: false });
    configureSession(ses);
    configurePermissions(ses, mainWindow);
  } else {
    ses = session.defaultSession;
  }

  const settings = settingsStore.store;

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: ses,
      javascript: settings.javascriptEnabled,
      images: settings.imagesEnabled,
      preload: path.join(__dirname, 'content-preload.js'),
    },
  });

  mainWindow.addBrowserView(view);
  view.setBounds(getContentBounds());
  view.setAutoResize({ width: true, height: true });

  const tab = { id, view, title: 'New Tab', url: '', favicon: '', loading: false, incognito };
  tabs.push(tab);

  // ── View events ────────────────────────────────────────────────────────────

  // ── Anti-fingerprinting injection ────────────────────────────────────────
  view.webContents.on('dom-ready', () => {
    const afpScript = buildAntiFpScript(settingsStore.store);
    if (afpScript) {
      view.webContents.executeJavaScript(afpScript).catch(() => {});
    }
  });

  // ── Fullscreen fix ──────────────────────────────────────────────────────────
  // When a page requests fullscreen (YouTube, video sites, etc.),
  // expand the BrowserView to cover the entire window content area.
  // Because BrowserView always renders on top of the main renderer HTML,
  // we inject the "Exit Fullscreen" button directly into the page DOM so it
  // is always visible above the fullscreen content.

  const FS_OVERLAY_JS = `
  (function() {
    const ID = '__locrium_fs_btn__';
    if (document.getElementById(ID)) return;
    const btn = document.createElement('button');
    btn.id = ID;
    btn.textContent = '✕  Exit Fullscreen';
    Object.assign(btn.style, {
      position: 'fixed', top: '14px', right: '14px',
      zIndex: '2147483647', padding: '6px 14px',
      background: 'rgba(0,0,0,0.72)', color: '#fff',
      border: '1px solid rgba(255,255,255,0.25)', borderRadius: '8px',
      font: '600 12px/1.4 system-ui,sans-serif',
      cursor: 'pointer', backdropFilter: 'blur(6px)',
      transition: 'background 0.15s',
    });
    btn.onmouseenter = () => { btn.style.background = 'rgba(255,255,255,0.18)'; };
    btn.onmouseleave = () => { btn.style.background = 'rgba(0,0,0,0.72)'; };
    btn.onclick = () => { document.exitFullscreen && document.exitFullscreen(); btn.remove(); };
    document.body.appendChild(btn);
  })();
  `;

  const FS_CLEANUP_JS = `
  (function() {
    const btn = document.getElementById('__locrium_fs_btn__');
    if (btn) btn.remove();
  })();
  `;

  const enterFullscreen = () => {
    if (!mainWindow) return;
    if (htmlFullscreenActive) return; // guard against double-fire
    htmlFullscreenActive = true;
    sendToRenderer('fullscreen-changed', { tabId: id, fullscreen: true });
    view.webContents.executeJavaScript(FS_OVERLAY_JS).catch(() => {});

    // Step 1: immediately expand the view to fill the current window size.
    // This makes the video appear to go fullscreen right away, even before
    // the OS fullscreen animation completes.
    const [cw, ch] = mainWindow.getContentSize();
    view.setBounds({ x: 0, y: 0, width: cw, height: ch });

    // Step 2: request OS-level fullscreen so the window covers the entire screen.
    // The mainWindow 'enter-full-screen' event will then update bounds to true
    // screen dimensions.
    if (!mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(true);
    }
  };

  const leaveFullscreen = () => {
    if (!mainWindow) return;
    htmlFullscreenActive = false;
    view.webContents.executeJavaScript(FS_CLEANUP_JS).catch(() => {});
    sendToRenderer('fullscreen-changed', { tabId: id, fullscreen: false });
    // Restore window to normal before restoring view bounds.
    // The 'leave-full-screen' event on mainWindow will call updateActiveViewBounds.
    if (mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    } else {
      view.setBounds(getContentBounds());
    }
  };

  // Only listen for html-full-screen events (element.requestFullscreen — e.g. YouTube).
  // The non-html 'enter-full-screen' event also fires for the same request and would
  // cause enterFullscreen to run twice, so we omit those listeners here.
  view.webContents.on('enter-html-full-screen',  enterFullscreen);
  view.webContents.on('leave-html-full-screen',  leaveFullscreen);

  view.webContents.on('page-title-updated', (_e, title) => {
    tab.title = title || 'Untitled';
    sendToRenderer('tab-updated', { id, title: tab.title });
  });

  view.webContents.on('page-favicon-updated', (_e, favicons) => {
    tab.favicon = favicons[0] || '';
    sendToRenderer('tab-updated', { id, favicon: tab.favicon });
  });

  view.webContents.on('did-start-loading', () => {
    tab.loading = true;
    sendToRenderer('tab-updated', { id, loading: true });
  });

  view.webContents.on('did-stop-loading', () => {
    tab.loading = false;
    tab.url = view.webContents.getURL();
    sendToRenderer('tab-updated', { id, loading: false, url: tab.url });
  });

  view.webContents.on('did-navigate', (_e, navUrl) => {
    tab.url = navUrl;
    sendToRenderer('tab-updated', { id, url: navUrl });
    addHistory({ url: navUrl, title: tab.title, timestamp: Date.now() });
  });

  view.webContents.on('did-navigate-in-page', (_e, navUrl) => {
    tab.url = navUrl;
    sendToRenderer('tab-updated', { id, url: navUrl });
  });

  // Prevent navigation to dangerous Electron internals
  view.webContents.on('will-navigate', (event, navUrl) => {
    if (navUrl.startsWith('file://') || navUrl.startsWith('javascript:')) {
      if (!navUrl.startsWith('file://') || process.env.NODE_ENV === 'development') {
        event.preventDefault();
      }
    }
  });

  // New window requests (target="_blank", window.open, etc.)
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (settingsStore.get('alwaysNewTab')) {
      createTab(url);
      setActiveTab(tabs[tabs.length - 1].id);
    } else {
      createTab(url);
      setActiveTab(tabs[tabs.length - 1].id);
    }
    return { action: 'deny' };
  });

  // Download handling
  view.webContents.session.on('will-download', (event, item) => {
    handleDownload(item);
  });

  // Navigate to initial URL
  const destination = resolveUrl(url || settingsStore.get('homepage'));
  view.webContents.loadURL(destination);

  return tab;
}

function setActiveTab(id) {
  activeTabId = id;
  // Hide all views, then show active
  for (const t of tabs) {
    mainWindow.removeBrowserView(t.view);
  }
  const active = tabs.find((t) => t.id === id);
  if (active) {
    mainWindow.addBrowserView(active.view);
    active.view.setBounds(getContentBounds());
    sendToRenderer('active-tab-changed', {
      id,
      url: active.url,
      title: active.title,
      favicon: active.favicon,
      loading: active.loading,
      incognito: active.incognito,
    });
  }
}

function closeTab(id) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return;

  const tab = tabs[index];
  mainWindow.removeBrowserView(tab.view);
  tab.view.webContents.destroy();
  tabs.splice(index, 1);

  if (tabs.length === 0) {
    // Open a new blank tab when all are closed
    const newTab = createTab(settingsStore.get('homepage'));
    setActiveTab(newTab.id);
  } else if (activeTabId === id) {
    const nextTab = tabs[Math.min(index, tabs.length - 1)];
    setActiveTab(nextTab.id);
  }

  sendToRenderer('tabs-state', getTabsState());
}

function getTabsState() {
  return tabs.map(({ id, title, url, favicon, loading, incognito }) => ({
    id, title, url, favicon, loading, incognito,
  }));
}

// ── URL resolution ───────────────────────────────────────────────────────────

function resolveUrl(input) {
  if (!input || input === 'about:blank') return 'about:blank';

  const trimmed = input.trim();

  // Already a URL protocol
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;

  // Looks like a domain (has a dot and no spaces)
  if (!trimmed.includes(' ') && trimmed.includes('.') && !trimmed.startsWith('/')) {
    return 'https://' + trimmed;
  }

  // Treat as search query
  const searxngUrl = settingsStore.get('searxngUrl') || 'http://localhost:8888';
  return `${searxngUrl}/search?q=${encodeURIComponent(trimmed)}`;
}

// ── History ──────────────────────────────────────────────────────────────────

function addHistory(entry) {
  const items = historyStore.get('items') || [];
  items.unshift(entry);
  // Keep last 10 000 entries
  if (items.length > 10000) items.length = 10000;
  historyStore.set('items', items);
}

// ── Downloads ────────────────────────────────────────────────────────────────

function handleDownload(item) {
  const defaultPath = path.join(settingsStore.get('downloadFolder'), item.getFilename());

  dialog.showSaveDialog(mainWindow, {
    title: 'Save File',
    defaultPath,
  }).then(({ canceled, filePath }) => {
    if (canceled || !filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(filePath);

    const dlEntry = {
      id: Date.now(),
      filename: path.basename(filePath),
      path: filePath,
      url: item.getURL(),
      startTime: Date.now(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: 'in-progress',
    };

    const items = downloadsStore.get('items') || [];
    items.unshift(dlEntry);
    downloadsStore.set('items', items);
    sendToRenderer('download-started', dlEntry);

    item.on('updated', (_e, state) => {
      dlEntry.receivedBytes = item.getReceivedBytes();
      dlEntry.state = state;
      // Update stored entry
      const list = downloadsStore.get('items');
      const idx = list.findIndex((d) => d.id === dlEntry.id);
      if (idx !== -1) { list[idx] = dlEntry; downloadsStore.set('items', list); }
      sendToRenderer('download-updated', dlEntry);
    });

    item.once('done', (_e, state) => {
      dlEntry.state = state;
      dlEntry.receivedBytes = item.getTotalBytes();
      const list = downloadsStore.get('items');
      const idx = list.findIndex((d) => d.id === dlEntry.id);
      if (idx !== -1) { list[idx] = dlEntry; downloadsStore.set('items', list); }
      sendToRenderer('download-completed', dlEntry);
    });
  });
}

// ── IPC ──────────────────────────────────────────────────────────────────────

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function setupIPC() {
  // ── Navigation ──

  ipcMain.handle('navigate', (_e, { id, url }) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    const resolved = resolveUrl(url);
    tab.view.webContents.loadURL(resolved);
  });

  ipcMain.handle('go-back', (_e, { id }) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab && tab.view.webContents.canGoBack()) tab.view.webContents.goBack();
  });

  ipcMain.handle('go-forward', (_e, { id }) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab && tab.view.webContents.canGoForward()) tab.view.webContents.goForward();
  });

  ipcMain.handle('reload', (_e, { id }) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab) tab.view.webContents.reload();
  });

  ipcMain.handle('stop-loading', (_e, { id }) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab) tab.view.webContents.stop();
  });

  ipcMain.handle('go-home', (_e, { id }) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.view.webContents.loadURL(resolveUrl(settingsStore.get('homepage')));
  });

  // ── Tabs ──

  ipcMain.handle('new-tab', (_e, { url, incognito } = {}) => {
    const tab = createTab(url || settingsStore.get('homepage'), incognito || false);
    sendToRenderer('tabs-state', getTabsState());
    setActiveTab(tab.id);
    return tab.id;
  });

  ipcMain.handle('close-tab', (_e, { id }) => {
    closeTab(id);
  });

  ipcMain.handle('switch-tab', (_e, { id }) => {
    setActiveTab(id);
    sendToRenderer('tabs-state', getTabsState());
  });

  ipcMain.handle('get-tabs', () => getTabsState());

  ipcMain.handle('get-active-tab', () => {
    const t = tabs.find((tab) => tab.id === activeTabId);
    if (!t) return null;
    return { id: t.id, url: t.url, title: t.title, favicon: t.favicon, loading: t.loading, incognito: t.incognito };
  });

  ipcMain.handle('get-nav-state', (_e, { id }) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return { canGoBack: false, canGoForward: false };
    return {
      canGoBack: tab.view.webContents.canGoBack(),
      canGoForward: tab.view.webContents.canGoForward(),
    };
  });

  // ── Settings ──

  ipcMain.handle('get-settings', () => settingsStore.store);

  ipcMain.handle('save-settings', (_e, updates) => {
    // These settings are applied at Chromium startup and require an app restart
    const RESTART_KEYS = ['disableGpu', 'blockAutoplay', 'disableMediaKeys', 'privacyModeEnabled'];
    const requiresRestart = RESTART_KEYS.some(
      (k) => typeof updates[k] !== 'undefined' && updates[k] !== settingsStore.get(k)
    );

    settingsStore.set(updates);

    // Apply dark mode immediately
    if (typeof updates.darkMode !== 'undefined') {
      nativeTheme.themeSource = updates.darkMode ? 'dark' : 'light';
    }

    // Re-configure session headers (DNT, fingerprinting, etc.) live
    try { configureSession(session.defaultSession); } catch (_) {}

    return { settings: settingsStore.store, requiresRestart };
  });

  // ── Privacy mode IPC ──

  // Synchronous handler: content scripts can call this to get privacy settings
  // at preload time without async IPC. Used by dom-ready injection in main process.
  ipcMain.on('get-privacy-settings-sync', (e) => {
    const s = settingsStore.store;
    e.returnValue = {
      privacyModeEnabled:         !!s.privacyModeEnabled,
      blockWebGPU:                !!s.blockWebGPU,
      blockWebGL:                 !!s.blockWebGL,
      resistCanvasFingerprinting: !!s.resistCanvasFingerprinting,
      blockKnownTrackingScripts:  !!s.blockKnownTrackingScripts,
    };
  });

  ipcMain.handle('get-privacy-status', () => {
    const s = settingsStore.store;
    const gpuDisabledAtStartup = s.disableGpu || s.privacyModeEnabled;
    return {
      privacyModeEnabled:         !!s.privacyModeEnabled,
      blockWebGPU:                !!s.blockWebGPU,
      blockWebGL:                 !!s.blockWebGL,
      resistCanvasFingerprinting: !!s.resistCanvasFingerprinting,
      blockKnownTrackingScripts:  !!s.blockKnownTrackingScripts,
      gpuDisabledAtStartup,
      blockedCount:  privacyBlockedCount,
      blockedLog:    privacyBlockedLog.slice(-100),
    };
  });

  ipcMain.handle('clear-blocked-log', () => {
    privacyBlockedCount = 0;
    privacyBlockedLog.length = 0;
    return true;
  });

  ipcMain.handle('restart-app', () => {
    app.relaunch();
    app.exit(0);
  });

  // ── Bookmarks ──

  ipcMain.handle('get-bookmarks', () => bookmarksStore.get('items'));

  ipcMain.handle('add-bookmark', (_e, { url, title, favicon }) => {
    const items = bookmarksStore.get('items');
    if (items.find((b) => b.url === url)) return items; // already bookmarked
    items.push({ url, title, favicon, addedAt: Date.now() });
    bookmarksStore.set('items', items);
    return items;
  });

  ipcMain.handle('remove-bookmark', (_e, { url }) => {
    const items = bookmarksStore.get('items').filter((b) => b.url !== url);
    bookmarksStore.set('items', items);
    return items;
  });

  ipcMain.handle('is-bookmarked', (_e, { url }) => {
    return !!(bookmarksStore.get('items') || []).find((b) => b.url === url);
  });

  // ── History ──

  ipcMain.handle('get-history', () => historyStore.get('items'));

  ipcMain.handle('clear-history', () => {
    historyStore.set('items', []);
  });

  // ── Downloads ──

  ipcMain.handle('get-downloads', () => downloadsStore.get('items'));

  ipcMain.handle('open-download', (_e, { filePath }) => {
    shell.openPath(filePath);
  });

  ipcMain.handle('show-in-folder', (_e, { filePath }) => {
    shell.showItemInFolder(filePath);
  });

  // ── Privacy / clear data ──

  ipcMain.handle('clear-data', async (_e, { cookies, cache, localStorage: ls, history: hist }) => {
    const ses = session.defaultSession;
    if (cookies) await ses.clearStorageData({ storages: ['cookies'] });
    if (cache) await ses.clearCache();
    if (ls) await ses.clearStorageData({ storages: ['localstorage', 'indexdb', 'websql'] });
    if (hist) historyStore.set('items', []);
    return true;
  });

  // ── JS / images per-tab toggle ──

  ipcMain.handle('toggle-js', (_e, { id, enabled }) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    // Electron doesn't allow runtime JS toggle without recreation
    // Store preference and notify user it applies on reload
    tab.view.webContents.executeJavaScript(
      enabled ? '' : 'document.querySelectorAll("script").forEach(s => s.remove())'
    ).catch(() => {});
    sendToRenderer('notice', 'JavaScript setting applies on next page load.');
  });

  // ── High Security Mode (instant toggle, no restart) ──

  ipcMain.handle('get-high-security', () => {
    return { enabled: !!settingsStore.get('highSecurityMode') };
  });

  ipcMain.handle('toggle-high-security', (_e, { enabled }) => {
    settingsStore.set('highSecurityMode', !!enabled);
    // Re-configure the default session
    try { configureSession(session.defaultSession); } catch (_) {}
    // Also re-configure all active incognito partition sessions
    const seenSessions = new Set([session.defaultSession]);
    for (const t of tabs) {
      try {
        const tabSes = t.view.webContents.session;
        if (!seenSessions.has(tabSes)) {
          seenSessions.add(tabSes);
          configureSession(tabSes);
        }
      } catch (_) {}
    }
    sendToRenderer('high-security-changed', { enabled: !!enabled });
    return { enabled: !!enabled };
  });

  // ── Per-site privacy controls ──

  ipcMain.handle('get-site-privacy', (_e, { hostname }) => {
    return getSitePrivacy(hostname);
  });

  ipcMain.handle('set-site-privacy', (_e, { hostname, siteSettings }) => {
    return setSitePrivacy(hostname, siteSettings);
  });

  // ── Fullscreen control ──

  ipcMain.handle('exit-fullscreen', (_e, { id }) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.view.webContents.executeJavaScript('document.exitFullscreen && document.exitFullscreen()').catch(() => {});
    htmlFullscreenActive = false;
    if (mainWindow && mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    }
    tab.view.setBounds(getContentBounds());
    sendToRenderer('fullscreen-changed', { tabId: id, fullscreen: false });
  });

  // ── Popover space reservation ──
  // The renderer asks main to push the active BrowserView down when a floating
  // popover needs to be visible (BrowserView is a native layer always above HTML).

  ipcMain.handle('popover-reserve', (_e, { h }) => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab || !mainWindow) return;
    const b = getContentBounds();
    const reserve = Math.min(Math.ceil(h), b.height - 40); // never consume the whole view
    activeTab.view.setBounds({
      x: b.x,
      y: b.y + reserve,
      width: b.width,
      height: b.height - reserve,
    });
  });

  ipcMain.handle('popover-release', () => {
    updateActiveViewBounds();
  });

  // ── Panel space reservation ──
  // Shrinks the BrowserView from the right so slide-in panels are interactive.

  ipcMain.handle('panel-open', (_e, { w }) => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab || !mainWindow) return;
    const b = getContentBounds();
    const panelW = Math.min(Math.ceil(w), b.width - 100);
    activeTab.view.setBounds({
      x: b.x,
      y: b.y,
      width: b.width - panelW,
      height: b.height,
    });
  });

  ipcMain.handle('panel-close', () => {
    updateActiveViewBounds();
  });

  // ── Window controls ──

  ipcMain.handle('window-minimize', () => mainWindow.minimize());
  ipcMain.handle('window-maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.restore();
    else mainWindow.maximize();
  });
  ipcMain.handle('window-close', () => mainWindow.close());

  // ── Zoom ──

  ipcMain.handle('zoom-in', (_e, { id }) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab) tab.view.webContents.setZoomLevel(tab.view.webContents.getZoomLevel() + 0.5);
  });

  ipcMain.handle('zoom-out', (_e, { id }) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab) tab.view.webContents.setZoomLevel(tab.view.webContents.getZoomLevel() - 0.5);
  });

  ipcMain.handle('zoom-reset', (_e, { id }) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab) tab.view.webContents.setZoomLevel(0);
  });

  // ── New private window ──

  ipcMain.handle('new-private-window', () => {
    const tab = createTab(settingsStore.get('homepage'), true);
    sendToRenderer('tabs-state', getTabsState());
    setActiveTab(tab.id);
  });

  // ── Dev tools (debug) ──

  ipcMain.handle('toggle-devtools', (_e, { id }) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.view.webContents.isDevToolsOpened()) {
      tab.view.webContents.closeDevTools();
    } else {
      tab.view.webContents.openDevTools();
    }
  });

  // ── Choose download folder ──

  ipcMain.handle('choose-download-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Choose Download Folder',
      defaultPath: settingsStore.get('downloadFolder'),
    });
    if (!result.canceled && result.filePaths[0]) {
      settingsStore.set('downloadFolder', result.filePaths[0]);
      return result.filePaths[0];
    }
    return null;
  });

  // ── Search service control ──

  ipcMain.handle('search-service-start', async () => {
    try {
      const port = settingsStore.get('searchServicePort') || 8888;
      await searchService.start(port);
      return { ok: true, status: searchService.getStatus() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('search-service-stop', async () => {
    try {
      await searchService.stop();
      return { ok: true, status: searchService.getStatus() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('search-service-restart', async () => {
    try {
      await searchService.restart();
      return { ok: true, status: searchService.getStatus() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('search-service-health', async () => {
    return searchService.healthCheck();
  });

  ipcMain.handle('search-service-status', () => {
    return searchService.getStatus();
  });

  // ── Search engine log ──

  ipcMain.handle('get-engine-log', async () => {
    try {
      // Fetch from the local service's /api/engine-log endpoint
      const http2 = require('http');
      return new Promise((resolve) => {
        const req = http2.get(
          { host: '127.0.0.1', port: settingsStore.get('searchServicePort') || 8888, path: '/api/engine-log', timeout: 2000 },
          (res) => {
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch (_) { resolve({ log: [] }); }
            });
          }
        );
        req.on('error', () => resolve({ log: [] }));
        req.on('timeout', () => { req.destroy(); resolve({ log: [] }); });
      });
    } catch (_) { return { log: [] }; }
  });

  // ── Search service updater ──

  ipcMain.handle('check-search-updates', async () => {
    const current = searchService.SEARCH_SERVICE_VERSION;
    return searchServiceUpdater.checkForUpdates(current);
  });

  ipcMain.handle('apply-search-update', async (_e, { downloadUrl }) => {
    return searchServiceUpdater.applyUpdate(downloadUrl, searchService);
  });

  // ── Browser updater ──

  ipcMain.handle('check-browser-updates', async () => {
    return browserUpdater.checkForUpdates();
  });

  ipcMain.handle('download-browser-update', async () => {
    return browserUpdater.downloadUpdate();
  });

  ipcMain.handle('get-app-version', () => {
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
    };
  });

  // ── Markdown converter ────────────────────────────────────────────────────

  const markdownConverter = require('./main/markdownConverter');

  // Collect all supported files from a directory, up to maxDepth levels deep.
  const SUPPORTED_EXTS = new Set(['.pdf', '.docx', '.xlsx', '.html', '.htm', '.txt']);
  function expandDir(dirPath, maxDepth, depth) {
    const files = [];
    if (depth > maxDepth) return files;
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch (_) { return files; }
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...expandDir(full, maxDepth, depth + 1));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) files.push(full);
      }
    }
    return files;
  }

  function expandPaths(inputPaths) {
    const out = [];
    for (const p of inputPaths) {
      let stat;
      try { stat = fs.statSync(p); } catch (_) { continue; }
      if (stat.isDirectory()) {
        out.push(...expandDir(p, 3, 0));
      } else {
        const ext = path.extname(p).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) out.push(p);
      }
    }
    return [...new Set(out)]; // deduplicate
  }

  ipcMain.handle('open-file-dialog', async (_e, { mode } = {}) => {
    const isFolder = mode === 'folder';
    const result = await dialog.showOpenDialog(mainWindow, {
      title:      isFolder ? 'Choose a Folder to Convert' : 'Choose Files to Convert',
      properties: isFolder
        ? ['openDirectory']
        : ['openFile', 'multiSelections'],
      ...(!isFolder && {
        filters: [
          { name: 'Supported Formats', extensions: ['pdf', 'docx', 'xlsx', 'html', 'htm', 'txt'] },
          { name: 'Word Documents',    extensions: ['docx'] },
          { name: 'PDF Files',         extensions: ['pdf'] },
          { name: 'Excel Files',       extensions: ['xlsx'] },
          { name: 'HTML Files',        extensions: ['html', 'htm'] },
          { name: 'Text Files',        extensions: ['txt'] },
          { name: 'All Files',         extensions: ['*'] },
        ],
      }),
    });
    if (result.canceled) return { paths: [], folderName: null };
    const expanded = expandPaths(result.filePaths);
    const folderName = isFolder ? path.basename(result.filePaths[0]) : null;
    return { paths: expanded, folderName };
  });

  // Expand dragged-and-dropped paths (files and directories) to supported files.
  ipcMain.handle('expand-paths', (_e, { inputPaths }) => {
    const expanded = expandPaths(inputPaths || []);
    return { paths: expanded };
  });

  ipcMain.handle('convert-to-markdown', async (_e, { filePaths, combine }) => {
    const results = [];
    const pathMod = require('path');

    for (const filePath of filePaths) {
      sendToRenderer('md-convert-progress', { filePath, state: 'converting' });
      const result = await markdownConverter.convertFile(filePath);
      results.push({ filePath, ...result });
      sendToRenderer('md-convert-progress', {
        filePath,
        state:      result.success ? 'done' : 'error',
        markdown:   result.markdown,
        outputPath: result.outputPath,
        error:      result.error,
      });
    }

    if (combine && results.length > 1) {
      const succeeded = results
        .filter((r) => r.success)
        .map((r) => ({ name: pathMod.basename(r.filePath), markdown: r.markdown }));
      if (succeeded.length) {
        const combined = markdownConverter.writeCombined(succeeded);
        sendToRenderer('md-convert-combined', combined);
      }
    }

    return results;
  });

  ipcMain.handle('open-markdown-output-folder', async () => {
    const outputDir = markdownConverter.OUTPUT_DIR;
    fs.mkdirSync(outputDir, { recursive: true });
    shell.openPath(outputDir);
    return { ok: true };
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────

// Disable hardware acceleration to avoid some GPU bugs on Windows
// Comment this out if you want hardware acceleration
// app.disableHardwareAcceleration();

// Prevent Chromium from phoning home
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('safebrowsing-disable-auto-update');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-default-apps');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-translate');
app.commandLine.appendSwitch('metrics-recording-only');
app.commandLine.appendSwitch('no-first-run');
app.commandLine.appendSwitch('safebrowsing-disable-download-protection');

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  createWindow();

  // ── Wire up status callbacks so the renderer stays in sync ──────────────
  searchService.onStatusChange((status) => {
    sendToRenderer('search-service-status', status);
  });

  // ── Persist search profile to electron-store when user changes it ────────
  searchService.onProfileChange((profile) => {
    settingsStore.set('searchProfile', profile);
  });

  browserUpdater.onStatus((data) => {
    sendToRenderer('browser-update-status', data);
  });

  // ── Initialise browser updater (lazy-loads electron-updater) ────────────
  browserUpdater.init();

  // ── Start local search service ──────────────────────────────────────────
  const searchPort = settingsStore.get('searchServicePort') || 8888;
  try {
    // Restore persisted search profile before starting
    const savedProfile = settingsStore.get('searchProfile') || 'standard';
    searchService.setProfile(savedProfile);

    await searchService.start(searchPort);
    console.log(`[Locrium] Search service started on port ${searchPort} (profile: ${savedProfile})`);
    // Run an initial health check after a short delay to confirm it's up
    setTimeout(() => searchService.healthCheck(), 1500);
  } catch (err) {
    console.error('[Locrium] Failed to start search service:', err.message);
    // App continues — user can restart from the health panel
  }

  // Open initial tab
  const firstTab = createTab(settingsStore.get('homepage'));
  setActiveTab(firstTab.id);
  sendToRenderer('tabs-state', getTabsState());
});

app.on('before-quit', async () => {
  // Gracefully stop the search service before exiting
  try { await searchService.stop(); } catch (_) {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Prevent any navigation outside of the app shell
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    // Allow webviews inside BrowserViews — only restrict the main renderer
    const isRenderer = contents === mainWindow?.webContents;
    if (isRenderer && !url.startsWith('file://')) {
      event.preventDefault();
    }
  });
});
