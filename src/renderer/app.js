/**
 * LOCRIUM — Renderer process (UI logic)
 *
 * Communicates with the main process exclusively through window.locrium (preload API).
 * NO Node.js APIs are used here. All access is via the contextBridge.
 */

'use strict';

// ── State ────────────────────────────────────────────────────────────────────

let tabs = [];
let activeTabId = null;
let settings = {};
let progressTimer = null;

// ── DOM shortcuts ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const tabsContainer = $('tabs-container');
const addressBar     = $('address-bar');
const progressFill   = $('progress-fill');
const incognitoBadge = $('incognito-badge');
const lockIcon       = $('lock-icon');

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  settings = await window.locrium.getSettings();
  applyTheme(settings.darkMode);
  $('btn-theme-toggle').textContent = settings.darkMode ? '☀' : '🌙';

  // Load high security state
  const hsResult = await window.locrium.getHighSecurity();
  setHighSecurityUI(hsResult.enabled);

  // Load initial search service status → set badge
  const svcStatus = await window.locrium.searchServiceStatus();
  updateSearchBadge(svcStatus && svcStatus.running);

  // Load initial tab state from main process
  tabs = await window.locrium.getTabs();
  const active = await window.locrium.getActiveTab();
  if (active) {
    activeTabId = active.id;
    syncAddressBar(active.url);
    syncNavButtons(active.id);
  }
  renderTabs();
  renderBookmarksBar();

  registerEventListeners();
  registerIpcListeners();
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(dark) {
  document.body.classList.toggle('dark', !!dark);
  document.body.classList.toggle('light', !dark);
}

// ── Tab rendering ─────────────────────────────────────────────────────────────

function renderTabs() {
  tabsContainer.innerHTML = '';
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = `tab${tab.id === activeTabId ? ' active' : ''}${tab.incognito ? ' incognito' : ''}`;
    el.dataset.id = tab.id;

    // Favicon
    if (tab.favicon) {
      const img = document.createElement('img');
      img.className = 'tab-favicon';
      img.src = tab.favicon;
      img.onerror = () => { img.replaceWith(makeFaviconPlaceholder()); };
      el.appendChild(img);
    } else {
      el.appendChild(tab.loading ? makeLoadingDot() : makeFaviconPlaceholder());
    }

    // Title
    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = tab.title || tab.url || 'New Tab';
    el.appendChild(titleEl);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '&#x2715;';
    closeBtn.title = 'Close tab';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.appendChild(closeBtn);

    el.addEventListener('click', () => switchTab(tab.id));
    tabsContainer.appendChild(el);
  }
}

function makeLoadingDot() {
  const el = document.createElement('div');
  el.className = 'tab-loading-dot';
  return el;
}

function makeFaviconPlaceholder() {
  const el = document.createElement('div');
  el.className = 'tab-favicon-placeholder';
  return el;
}

// ── Address bar sync ──────────────────────────────────────────────────────────

function syncAddressBar(url) {
  if (!url || url === 'about:blank') {
    addressBar.value = '';
  } else {
    addressBar.value = url;
  }

  // Update lock icon
  if (url && url.startsWith('https://')) {
    lockIcon.textContent = '🔒';
    lockIcon.title = 'Secure connection';
  } else if (url && url.startsWith('http://')) {
    lockIcon.textContent = '⚠';
    lockIcon.title = 'Not secure';
    lockIcon.style.color = '#e0b452';
  } else {
    lockIcon.textContent = '🔒';
    lockIcon.title = '';
    lockIcon.style.color = '';
  }

  // Refresh per-site shield badge
  updateSiteShieldBadge(url);
}

async function syncNavButtons(id) {
  const state = await window.locrium.getNavState(id);
  $('btn-back').disabled    = !state.canGoBack;
  $('btn-forward').disabled = !state.canGoForward;
}

// ── Bookmarks bar ─────────────────────────────────────────────────────────────

async function renderBookmarksBar() {
  const bookmarks = await window.locrium.getBookmarks();
  const bar = $('bookmarks-bar');
  bar.innerHTML = '';
  for (const bm of bookmarks.slice(0, 20)) {
    const el = document.createElement('div');
    el.className = 'bmark-item';
    el.title = bm.url;
    if (bm.favicon) {
      const img = document.createElement('img');
      img.className = 'bmark-favicon';
      img.src = bm.favicon;
      img.onerror = () => img.remove();
      el.appendChild(img);
    }
    const t = document.createElement('span');
    t.className = 'bmark-title';
    t.textContent = bm.title || bm.url;
    el.appendChild(t);
    el.addEventListener('click', () => navigate(activeTabId, bm.url));
    bar.appendChild(el);
  }
}

// ── Navigation helpers ────────────────────────────────────────────────────────

function navigate(id, url) {
  window.locrium.navigate(id, url);
}

function closeTab(id) {
  window.locrium.closeTab(id);
}

function switchTab(id) {
  window.locrium.switchTab(id);
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function startProgress() {
  clearTimeout(progressTimer);
  progressFill.style.transition = 'none';
  progressFill.style.width = '10%';
  setTimeout(() => {
    progressFill.style.transition = 'width 8s ease';
    progressFill.style.width = '80%';
  }, 30);
}

function endProgress() {
  progressFill.style.transition = 'width 0.2s ease';
  progressFill.style.width = '100%';
  progressTimer = setTimeout(() => {
    progressFill.style.transition = 'none';
    progressFill.style.width = '0%';
  }, 350);
}

// ── IPC listeners (events from main process) ───────────────────────────────────

function registerIpcListeners() {
  window.locrium.on('tabs-state', (newTabs) => {
    tabs = newTabs;
    renderTabs();
  });

  window.locrium.on('active-tab-changed', (tab) => {
    // Dismiss site privacy popover on tab switch
    const pop = $('site-privacy-popover');
    if (!pop.classList.contains('hidden')) {
      pop.classList.add('hidden');
      window.locrium.popoverRelease();
    }
    activeTabId = tab.id;
    syncAddressBar(tab.url);
    syncNavButtons(tab.id);
    // Incognito badge
    if (tab.incognito) {
      incognitoBadge.classList.remove('hidden');
    } else {
      incognitoBadge.classList.add('hidden');
    }
    renderTabs();
    updateBookmarkButton(tab.url);
  });

  window.locrium.on('tab-updated', async (update) => {
    const tab = tabs.find((t) => t.id === update.id);
    if (!tab) return;
    Object.assign(tab, update);

    if (update.id === activeTabId) {
      if (update.url !== undefined) {
        syncAddressBar(update.url);
        syncNavButtons(update.id);
        updateBookmarkButton(update.url);
      }
      if (update.loading !== undefined) {
        if (update.loading) startProgress();
        else endProgress();
      }
    }
    renderTabs();
  });

  window.locrium.on('download-started', (dl) => {
    showNotice(`Downloading: ${dl.filename}`);
    if (!$('panel-downloads').classList.contains('hidden')) {
      renderDownloads();
    }
  });

  window.locrium.on('download-updated', (dl) => {
    if (!$('panel-downloads').classList.contains('hidden')) {
      updateDownloadItem(dl);
    }
  });

  window.locrium.on('download-completed', (dl) => {
    showNotice(`Download complete: ${dl.filename}`, 4000);
    if (!$('panel-downloads').classList.contains('hidden')) {
      updateDownloadItem(dl);
    }
  });

  window.locrium.on('notice', (msg) => showNotice(msg));

  // ── Search service status updates from main process ──
  window.locrium.on('search-service-status', (status) => {
    // Always update the navbar badge regardless of panel visibility
    updateSearchBadge(status && status.running);
    if (!$('panel-health').classList.contains('hidden')) {
      updateHealthPanel(status);
    }
  });

  // ── Browser update status from main process ──
  window.locrium.on('browser-update-status', (data) => {
    const el = $('browser-update-result');
    if (!el) return;
    if (data.available) {
      el.className = 'update-result ok';
      el.textContent = `Update available: v${data.version}`;
    } else if (data.available === false) {
      el.className = 'update-result';
      el.textContent = `Up to date (v${data.version})`;
    } else if (data.error) {
      el.className = 'update-result error';
      el.textContent = data.error;
    }
  });

  // ── High Security Mode: reflect live changes from any source ──
  window.locrium.on('high-security-changed', ({ enabled }) => {
    setHighSecurityUI(enabled);
    showNotice(enabled ? '🛡 High Security Mode ON' : '🔓 High Security Mode OFF', 3000);
  });

  // ── Fullscreen: show/hide the escape overlay ──
  window.locrium.on('fullscreen-changed', ({ fullscreen }) => {
    const overlay = $('fullscreen-overlay');
    if (fullscreen) overlay.classList.remove('hidden');
    else overlay.classList.add('hidden');
  });

  // ── Markdown converter: per-file progress ──
  window.locrium.on('md-convert-progress', (data) => {
    updateMdFileItem(data);
  });

  // ── Markdown converter: combined file written ──
  window.locrium.on('md-convert-combined', (data) => {
    const status = $('md-convert-status');
    if (data && data.success) {
      status.className = 'md-status-line ok';
      status.textContent = `Combined saved → ${data.outputPath}`;
    } else if (data && data.error) {
      status.className = 'md-status-line error';
      status.textContent = `Combine failed: ${data.error}`;
    }
  });
}

// ── UI event listeners ────────────────────────────────────────────────────────

function registerEventListeners() {
  // Window controls
  $('btn-minimize').addEventListener('click', () => window.locrium.minimize());
  $('btn-maximize').addEventListener('click', () => window.locrium.maximize());
  $('btn-close').addEventListener('click', () => window.locrium.close());

  // New tab buttons
  $('btn-new-tab').addEventListener('click', () => window.locrium.newTab());
  $('btn-private-tab').addEventListener('click', () => window.locrium.newTab(null, true));

  // Navigation
  $('btn-back').addEventListener('click', () => { if (activeTabId !== null) window.locrium.goBack(activeTabId); });
  $('btn-forward').addEventListener('click', () => { if (activeTabId !== null) window.locrium.goForward(activeTabId); });
  $('btn-home').addEventListener('click', () => { if (activeTabId !== null) window.locrium.goHome(activeTabId); });

  $('btn-reload').addEventListener('click', () => {
    if (activeTabId === null) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab && tab.loading) window.locrium.stopLoading(activeTabId);
    else window.locrium.reload(activeTabId);
  });

  // Address bar
  addressBar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeTabId !== null) navigate(activeTabId, addressBar.value.trim());
    }
    if (e.key === 'Escape') {
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab) syncAddressBar(tab.url);
      addressBar.blur();
    }
  });
  addressBar.addEventListener('focus', () => addressBar.select());

  // Bookmark button
  $('btn-bookmark').addEventListener('click', async () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || !tab.url) return;
    const isBookmarked = await window.locrium.isBookmarked(tab.url);
    if (isBookmarked) {
      await window.locrium.removeBookmark(tab.url);
      $('btn-bookmark').classList.remove('bookmarked');
      showNotice('Bookmark removed');
    } else {
      await window.locrium.addBookmark(tab.url, tab.title, tab.favicon);
      $('btn-bookmark').classList.add('bookmarked');
      showNotice('Bookmarked!');
    }
    renderBookmarksBar();
  });

  // Zoom
  $('btn-zoom-in').addEventListener('click', () => { if (activeTabId !== null) window.locrium.zoomIn(activeTabId); });
  $('btn-zoom-out').addEventListener('click', () => { if (activeTabId !== null) window.locrium.zoomOut(activeTabId); });

  // ── Theme toggle ──
  $('btn-theme-toggle').addEventListener('click', async () => {
    const newDark = !settings.darkMode;
    const result = await window.locrium.saveSettings({ darkMode: newDark });
    settings = (result && result.settings) ? result.settings : result;
    applyTheme(settings.darkMode);
    $('btn-theme-toggle').textContent = settings.darkMode ? '☀' : '🌙';
  });

  // ── High Security Mode toggle ──
  $('btn-high-security').addEventListener('click', async () => {
    const btn = $('btn-high-security');
    const isActive = btn.classList.contains('active');
    const result = await window.locrium.toggleHighSecurity(!isActive);
    setHighSecurityUI(result.enabled);
  });

  // ── Per-site shield button ──
  $('btn-site-shield').addEventListener('click', () => openSitePrivacyPopover());

  // Close site privacy popover
  $('site-popover-close').addEventListener('click', () => {
    $('site-privacy-popover').classList.add('hidden');
    window.locrium.popoverRelease();
  });

  // Save per-site settings
  $('sp-save').addEventListener('click', async () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || !tab.url) return;
    let hostname;
    try { hostname = new URL(tab.url).hostname; } catch (_) { return; }

    const sp = {
      disableJs:      $('sp-disable-js').checked,
      blockCookies:   $('sp-block-cookies').checked,
      blockTrackers:  $('sp-block-trackers').checked,
      spoofUserAgent: $('sp-spoof-ua').value,
    };
    await window.locrium.setSitePrivacy(hostname, sp);
    $('site-privacy-popover').classList.add('hidden');
    window.locrium.popoverRelease();
    updateSiteShieldBadge(tab.url);
    showNotice(`Site privacy settings saved for ${hostname}`);
  });

  // Close popover on outside click
  document.addEventListener('click', (e) => {
    const popover = $('site-privacy-popover');
    if (!popover.classList.contains('hidden') &&
        !popover.contains(e.target) &&
        e.target !== $('btn-site-shield')) {
      popover.classList.add('hidden');
      window.locrium.popoverRelease();
    }
  });

  // ── Fullscreen exit button ──
  $('btn-exit-fullscreen').addEventListener('click', () => {
    if (activeTabId !== null) window.locrium.exitFullscreen(activeTabId);
    $('fullscreen-overlay').classList.add('hidden');
  });

  // Panel toggles
  $('btn-settings').addEventListener('click', () => togglePanel('settings'));
  $('btn-history').addEventListener('click', () => { togglePanel('history'); if (!$('panel-history').classList.contains('hidden')) renderHistory(); });
  $('btn-downloads').addEventListener('click', () => { togglePanel('downloads'); if (!$('panel-downloads').classList.contains('hidden')) renderDownloads(); });
  $('btn-bookmarks-panel').addEventListener('click', () => { togglePanel('bookmarks'); if (!$('panel-bookmarks').classList.contains('hidden')) renderBookmarksPanel(); });
  $('btn-privacy').addEventListener('click', () => { togglePanel('privacy'); if (!$('panel-privacy').classList.contains('hidden')) openPrivacyPanel(); });
  $('btn-health').addEventListener('click', () => { togglePanel('health'); if (!$('panel-health').classList.contains('hidden')) openHealthPanel(); });
  $('btn-converter').addEventListener('click', () => togglePanel('converter'));

  // Close buttons on panels
  document.querySelectorAll('.panel-close').forEach((btn) => {
    btn.addEventListener('click', () => closePanel(btn.dataset.panel));
  });

  // Overlay click closes panels
  $('panel-overlay').addEventListener('click', () => closeAllPanels());

  // Settings panel controls
  $('btn-choose-folder').addEventListener('click', async () => {
    const folder = await window.locrium.chooseDownloadFolder();
    if (folder) $('set-download-folder').value = folder;
  });

  $('btn-save-settings').addEventListener('click', saveSettings);

  $('btn-clear-data').addEventListener('click', clearData);

  $('btn-clear-history').addEventListener('click', async () => {
    await window.locrium.clearHistory();
    renderHistory();
    showNotice('History cleared');
  });

  // History search filter
  $('history-search').addEventListener('input', renderHistory);

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);
}

// ── Panel management ──────────────────────────────────────────────────────────

// Panel widths must match the CSS (--panel-w = 380px, #panel-settings = 500px).
// The BrowserView is a native layer always above HTML, so we shrink it from the
// right to expose the panel underneath.
const PANEL_WIDTHS = { settings: 500 };
const DEFAULT_PANEL_WIDTH = 380;

function getPanelWidth(name) {
  return PANEL_WIDTHS[name] || DEFAULT_PANEL_WIDTH;
}

function togglePanel(name) {
  const panel = $(`panel-${name}`);
  if (panel.classList.contains('hidden')) {
    closeAllPanels();
    panel.classList.remove('hidden');
    $('panel-overlay').classList.remove('hidden');
    if (name === 'settings') populateSettings();
    window.locrium.panelOpen(getPanelWidth(name));
  } else {
    closePanel(name);
  }
}

const ALL_PANELS = ['settings', 'history', 'downloads', 'bookmarks', 'privacy', 'health', 'converter'];

function closePanel(name) {
  $(`panel-${name}`).classList.add('hidden');
  const anyOpen = ALL_PANELS.some((n) => !$(`panel-${n}`).classList.contains('hidden'));
  if (!anyOpen) {
    $('panel-overlay').classList.add('hidden');
    window.locrium.panelClose();
  }
}

function closeAllPanels() {
  ALL_PANELS.forEach((n) => $(`panel-${n}`).classList.add('hidden'));
  $('panel-overlay').classList.add('hidden');
  window.locrium.panelClose();
}

// ── Settings panel ─────────────────────────────────────────────────────────────

function populateSettings() {
  // Search
  $('set-searxng').value         = settings.searxngUrl         || 'http://127.0.0.1:8888';
  $('set-search-port').value     = settings.searchServicePort  || 8888;
  $('set-homepage').value        = settings.homepage           || 'http://127.0.0.1:8888/';

  // Privacy & Security
  $('set-block-trackers').checked   = settings.blockTrackers          !== false;
  $('set-block-cookies').checked    = settings.blockThirdPartyCookies !== false;
  $('set-dnt').checked              = settings.sendDnt                !== false;
  $('set-resist-fp').checked        = settings.resistFingerprinting   !== false;
  $('set-block-webrtc').checked     = settings.blockWebRTC            !== false;
  $('set-force-https').checked      = !!settings.forceHttpsUpgrade;
  $('set-block-mixed').checked      = settings.blockMixedContent      !== false;
  $('set-deny-notif').checked       = settings.denyNotifications      !== false;
  $('set-deny-geo').checked         = settings.denyGeolocation        !== false;
  $('set-block-media').checked      = settings.blockCameraMic         !== false;
  $('set-block-autoplay').checked   = settings.blockAutoplay          !== false;
  $('set-js').checked               = settings.javascriptEnabled      !== false;
  $('set-images').checked           = settings.imagesEnabled          !== false;

  // Hardware
  $('set-disable-gpu').checked       = !!settings.disableGpu;
  $('set-disable-media-keys').checked= settings.disableMediaKeys !== false;

  // General
  $('set-download-folder').value = settings.downloadFolder || '';
  $('set-useragent').value       = settings.userAgent      || '';
  $('set-always-new-tab').checked= !!settings.alwaysNewTab;

  // Appearance
  $('set-darkmode').checked = settings.darkMode !== false;

  // Search service controls
  $('btn-settings-svc-restart').onclick = async () => {
    $('settings-svc-status').textContent = 'Restarting…';
    $('settings-svc-status').className = 'update-result';
    const res = await window.locrium.searchServiceRestart();
    $('settings-svc-status').textContent = res.ok ? 'Running' : `Error: ${res.error}`;
    $('settings-svc-status').className = `update-result ${res.ok ? 'ok' : 'error'}`;
  };
  $('btn-settings-svc-stop').onclick = async () => {
    $('settings-svc-status').textContent = 'Stopping…';
    $('settings-svc-status').className = 'update-result';
    const res = await window.locrium.searchServiceStop();
    $('settings-svc-status').textContent = res.ok ? 'Stopped' : `Error: ${res.error}`;
    $('settings-svc-status').className = `update-result ${res.ok ? '' : 'error'}`;
  };

  // Anti-Fingerprinting / Privacy Mode
  $('set-privacy-mode').checked   = !!settings.privacyModeEnabled;
  $('set-block-webgpu').checked   = settings.blockWebGPU               !== false;
  $('set-block-webgl').checked    = !!settings.blockWebGL;
  $('set-resist-canvas').checked  = settings.resistCanvasFingerprinting !== false;
  $('set-block-fp-scripts').checked = settings.blockKnownTrackingScripts !== false;

  // Open privacy panel from settings
  const btnOpenPrivacy = $('btn-open-privacy-panel');
  if (btnOpenPrivacy) {
    btnOpenPrivacy.onclick = () => {
      closePanel('settings');
      togglePanel('privacy');
      openPrivacyPanel();
    };
  }

  // Restart banner
  $('restart-banner').classList.add('hidden');
  $('btn-restart-now').onclick = () => window.locrium.close();

  // Show restart banner when GPU/autoplay/privacy-mode toggles change
  ['set-disable-gpu', 'set-disable-media-keys', 'set-block-autoplay', 'set-privacy-mode'].forEach((id) => {
    const el = $(id);
    if (el) el.onchange = () => $('restart-banner').classList.remove('hidden');
  });
}

async function saveSettings() {
  const portVal = parseInt($('set-search-port').value, 10);
  const updates = {
    // Search
    searxngUrl:             $('set-searxng').value.trim(),
    searchServicePort:      isNaN(portVal) ? 8888 : portVal,
    homepage:               $('set-homepage').value.trim() || 'http://127.0.0.1:8888/',

    // Privacy & Security
    blockTrackers:          $('set-block-trackers').checked,
    blockThirdPartyCookies: $('set-block-cookies').checked,
    sendDnt:                $('set-dnt').checked,
    resistFingerprinting:   $('set-resist-fp').checked,
    blockWebRTC:            $('set-block-webrtc').checked,
    forceHttpsUpgrade:      $('set-force-https').checked,
    blockMixedContent:      $('set-block-mixed').checked,
    denyNotifications:      $('set-deny-notif').checked,
    denyGeolocation:        $('set-deny-geo').checked,
    blockCameraMic:         $('set-block-media').checked,
    blockAutoplay:          $('set-block-autoplay').checked,
    javascriptEnabled:      $('set-js').checked,
    imagesEnabled:          $('set-images').checked,

    // Anti-Fingerprinting / Privacy Mode
    privacyModeEnabled:          $('set-privacy-mode').checked,
    blockWebGPU:                 $('set-block-webgpu').checked,
    blockWebGL:                  $('set-block-webgl').checked,
    resistCanvasFingerprinting:  $('set-resist-canvas').checked,
    blockKnownTrackingScripts:   $('set-block-fp-scripts').checked,

    // Hardware
    disableGpu:             $('set-disable-gpu').checked,
    disableMediaKeys:       $('set-disable-media-keys').checked,

    // General
    userAgent:              $('set-useragent').value.trim(),
    alwaysNewTab:           $('set-always-new-tab').checked,

    // Appearance
    darkMode:               $('set-darkmode').checked,
  };

  const result = await window.locrium.saveSettings(updates);

  // save-settings now returns { settings, requiresRestart }
  if (result && result.settings) {
    settings = result.settings;
  } else {
    settings = result; // backwards compat
  }

  applyTheme(settings.darkMode);

  if (result && result.requiresRestart) {
    showNotice('Settings saved — restart required for some changes', 5000);
    $('restart-banner').classList.remove('hidden');
  } else {
    closePanel('settings');
    showNotice('Settings saved');
  }
}

async function clearData() {
  await window.locrium.clearData({
    cookies:      $('clear-cookies').checked,
    cache:        $('clear-cache').checked,
    localStorage: $('clear-ls').checked,
    history:      $('clear-hist-check').checked,
  });
  showNotice('Selected data cleared');
}

// ── History panel ─────────────────────────────────────────────────────────────

async function renderHistory() {
  const items = await window.locrium.getHistory();
  const query = $('history-search').value.toLowerCase();
  const filtered = query
    ? items.filter((i) => (i.url + ' ' + i.title).toLowerCase().includes(query))
    : items;

  const list = $('history-list');
  list.innerHTML = '';

  if (!filtered.length) {
    list.innerHTML = '<li style="color:var(--text-2);padding:16px;text-align:center">No history</li>';
    return;
  }

  for (const item of filtered.slice(0, 200)) {
    const li = document.createElement('li');
    li.className = 'list-item';

    const icon = document.createElement('span');
    icon.className = 'list-item-icon';
    icon.textContent = '🕐';
    li.appendChild(icon);

    const body = document.createElement('div');
    body.className = 'list-item-body';
    const t = document.createElement('div');
    t.className = 'list-item-title';
    t.textContent = item.title || item.url;
    const s = document.createElement('div');
    s.className = 'list-item-sub';
    s.textContent = item.url;
    body.appendChild(t);
    body.appendChild(s);
    li.appendChild(body);

    const time = document.createElement('span');
    time.className = 'list-item-sub';
    time.style.flexShrink = '0';
    time.textContent = formatTime(item.timestamp);
    li.appendChild(time);

    li.addEventListener('click', () => {
      if (activeTabId !== null) navigate(activeTabId, item.url);
      closePanel('history');
    });
    list.appendChild(li);
  }
}

// ── Downloads panel ───────────────────────────────────────────────────────────

async function renderDownloads() {
  const items = await window.locrium.getDownloads();
  const list = $('downloads-list');
  list.innerHTML = '';

  if (!items.length) {
    list.innerHTML = '<li style="color:var(--text-2);padding:16px;text-align:center">No downloads</li>';
    return;
  }

  for (const dl of items) {
    list.appendChild(buildDownloadItem(dl));
  }
}

function buildDownloadItem(dl) {
  const li = document.createElement('li');
  li.className = 'list-item';
  li.dataset.dlId = dl.id;
  li.style.flexDirection = 'column';
  li.style.alignItems = 'flex-start';
  li.style.gap = '4px';

  const top = document.createElement('div');
  top.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%';

  const icon = document.createElement('span');
  icon.className = 'list-item-icon';
  icon.textContent = dl.state === 'completed' ? '✓' : dl.state === 'cancelled' ? '✗' : '⬇';
  top.appendChild(icon);

  const body = document.createElement('div');
  body.className = 'list-item-body';
  const t = document.createElement('div');
  t.className = 'list-item-title';
  t.textContent = dl.filename;
  const s = document.createElement('div');
  s.className = 'list-item-sub';
  s.textContent = dl.state === 'completed'
    ? `${formatBytes(dl.totalBytes)} — ${formatTime(dl.startTime)}`
    : dl.state === 'in-progress'
    ? `${formatBytes(dl.receivedBytes)} / ${formatBytes(dl.totalBytes)}`
    : dl.state;
  body.appendChild(t);
  body.appendChild(s);
  top.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'list-item-actions';
  if (dl.state === 'completed') {
    const open = document.createElement('button');
    open.textContent = 'Open';
    open.addEventListener('click', (e) => { e.stopPropagation(); window.locrium.openDownload(dl.path); });
    actions.appendChild(open);
    const folder = document.createElement('button');
    folder.textContent = 'Folder';
    folder.addEventListener('click', (e) => { e.stopPropagation(); window.locrium.showInFolder(dl.path); });
    actions.appendChild(folder);
  }
  top.appendChild(actions);
  li.appendChild(top);

  if (dl.state === 'in-progress' && dl.totalBytes > 0) {
    const bar = document.createElement('div');
    bar.className = 'dl-progress';
    bar.style.width = '100%';
    const fill = document.createElement('div');
    fill.className = 'dl-progress-fill';
    fill.style.width = `${Math.round((dl.receivedBytes / dl.totalBytes) * 100)}%`;
    bar.appendChild(fill);
    li.appendChild(bar);
  }

  return li;
}

function updateDownloadItem(dl) {
  const existing = document.querySelector(`[data-dl-id="${dl.id}"]`);
  if (existing) {
    const fresh = buildDownloadItem(dl);
    existing.replaceWith(fresh);
  }
}

// ── Bookmarks panel ───────────────────────────────────────────────────────────

async function renderBookmarksPanel() {
  const items = await window.locrium.getBookmarks();
  const list = $('bookmarks-list');
  list.innerHTML = '';

  if (!items.length) {
    list.innerHTML = '<li style="color:var(--text-2);padding:16px;text-align:center">No bookmarks yet</li>';
    return;
  }

  for (const bm of items) {
    const li = document.createElement('li');
    li.className = 'list-item';

    const icon = document.createElement('span');
    icon.className = 'list-item-icon';
    if (bm.favicon) {
      const img = document.createElement('img');
      img.style.cssText = 'width:14px;height:14px;object-fit:contain';
      img.src = bm.favicon;
      img.onerror = () => { img.replaceWith(document.createTextNode('★')); };
      icon.appendChild(img);
    } else {
      icon.textContent = '★';
    }
    li.appendChild(icon);

    const body = document.createElement('div');
    body.className = 'list-item-body';
    const t = document.createElement('div');
    t.className = 'list-item-title';
    t.textContent = bm.title || bm.url;
    const s = document.createElement('div');
    s.className = 'list-item-sub';
    s.textContent = bm.url;
    body.appendChild(t);
    body.appendChild(s);
    li.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'list-item-actions';
    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.title = 'Remove bookmark';
    remove.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.locrium.removeBookmark(bm.url);
      renderBookmarksPanel();
      renderBookmarksBar();
    });
    actions.appendChild(remove);
    li.appendChild(actions);

    li.addEventListener('click', () => {
      if (activeTabId !== null) navigate(activeTabId, bm.url);
      closePanel('bookmarks');
    });
    list.appendChild(li);
  }
}

// ── Bookmark button sync ──────────────────────────────────────────────────────

async function updateBookmarkButton(url) {
  if (!url || url === 'about:blank') {
    $('btn-bookmark').classList.remove('bookmarked');
    return;
  }
  const isBookmarked = await window.locrium.isBookmarked(url);
  $('btn-bookmark').classList.toggle('bookmarked', isBookmarked);
  $('btn-bookmark').textContent = isBookmarked ? '★' : '☆';
}

// ── High Security Mode helpers ────────────────────────────────────────────────

let highSecurityEnabled = false;

function setHighSecurityUI(enabled) {
  highSecurityEnabled = enabled;
  const btn = $('btn-high-security');
  if (enabled) {
    btn.classList.add('active');
    btn.title = 'High Security Mode: ON — click to disable';
    btn.textContent = '🔒';
  } else {
    btn.classList.remove('active');
    btn.title = 'High Security Mode: OFF — click to enable';
    btn.textContent = '🔓';
  }
}

// ── Per-site privacy popover ─────────────────────────────────────────────────

async function openSitePrivacyPopover() {
  const popover = $('site-privacy-popover');
  if (!popover.classList.contains('hidden')) {
    popover.classList.add('hidden');
    window.locrium.popoverRelease();
    return;
  }
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab || !tab.url) { showNotice('No page loaded'); return; }

  let hostname;
  try { hostname = new URL(tab.url).hostname; } catch (_) { showNotice('No site loaded'); return; }

  $('site-popover-host').textContent = hostname;
  const sp = await window.locrium.getSitePrivacy(hostname);
  $('sp-disable-js').checked    = !!sp.disableJs;
  $('sp-block-cookies').checked = !!sp.blockCookies;
  $('sp-block-trackers').checked = !!sp.blockTrackers;
  // Set UA select
  const uaSelect = $('sp-spoof-ua');
  uaSelect.value = sp.spoofUserAgent || '';

  popover.classList.remove('hidden');
  // Push the BrowserView down so it doesn't cover the popover (native layer is always on top)
  const popoverH = Math.ceil(popover.getBoundingClientRect().height);
  window.locrium.popoverReserve(popoverH);
}

async function updateSiteShieldBadge(url) {
  const btn = $('btn-site-shield');
  if (!url || url === 'about:blank') {
    btn.classList.remove('has-overrides');
    return;
  }
  try {
    const hostname = new URL(url).hostname;
    const sp = await window.locrium.getSitePrivacy(hostname);
    const hasOverrides = sp.disableJs || sp.blockCookies || sp.blockTrackers || sp.spoofUserAgent;
    btn.classList.toggle('has-overrides', !!hasOverrides);
  } catch (_) {
    btn.classList.remove('has-overrides');
  }
}

// ── Notice bar ────────────────────────────────────────────────────────────────

let noticeTimeout = null;
function showNotice(msg, duration = 3000) {
  const bar = $('notice-bar');
  bar.textContent = msg;
  bar.classList.remove('hidden');
  clearTimeout(noticeTimeout);
  noticeTimeout = setTimeout(() => bar.classList.add('hidden'), duration);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

function handleKeyboard(e) {
  // Ctrl+T — new tab
  if (e.ctrlKey && e.key === 't') { e.preventDefault(); window.locrium.newTab(); }
  // Ctrl+W — close tab
  if (e.ctrlKey && e.key === 'w') { e.preventDefault(); if (activeTabId !== null) closeTab(activeTabId); }
  // Ctrl+Shift+N — private tab
  if (e.ctrlKey && e.shiftKey && e.key === 'N') { e.preventDefault(); window.locrium.newTab(null, true); }
  // F5 — reload
  if (e.key === 'F5') { e.preventDefault(); if (activeTabId !== null) window.locrium.reload(activeTabId); }
  // Ctrl+R — reload
  if (e.ctrlKey && e.key === 'r') { e.preventDefault(); if (activeTabId !== null) window.locrium.reload(activeTabId); }
  // Alt+Left — back
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); if (activeTabId !== null) window.locrium.goBack(activeTabId); }
  // Alt+Right — forward
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); if (activeTabId !== null) window.locrium.goForward(activeTabId); }
  // Ctrl+L — focus address bar
  if (e.ctrlKey && e.key === 'l') { e.preventDefault(); addressBar.focus(); addressBar.select(); }
  // F12 — devtools
  if (e.key === 'F12') { if (activeTabId !== null) window.locrium.toggleDevTools(activeTabId); }
  // Ctrl++ / Ctrl+= — zoom in
  if (e.ctrlKey && (e.key === '+' || e.key === '=')) { if (activeTabId !== null) window.locrium.zoomIn(activeTabId); }
  // Ctrl+- — zoom out
  if (e.ctrlKey && e.key === '-') { if (activeTabId !== null) window.locrium.zoomOut(activeTabId); }
  // Ctrl+0 — zoom reset
  if (e.ctrlKey && e.key === '0') { if (activeTabId !== null) window.locrium.zoomReset(activeTabId); }
  // Escape — close panels
  if (e.key === 'Escape') closeAllPanels();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ── Privacy panel ─────────────────────────────────────────────────────────────

function setBadge(id, on, warnIfOn = false) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('ps-on', 'ps-off', 'ps-warn');
  if (on) {
    el.classList.add(warnIfOn ? 'ps-warn' : 'ps-on');
    el.textContent = warnIfOn ? 'YES' : 'ON';
  } else {
    el.classList.add('ps-off');
    el.textContent = warnIfOn ? 'NO' : 'OFF';
  }
}

async function openPrivacyPanel() {
  const status = await window.locrium.getPrivacyStatus();
  refreshPrivacyPanel(status);

  $('btn-privacy-enable').onclick = async () => {
    const result = await window.locrium.saveSettings({ privacyModeEnabled: true });
    settings = (result && result.settings) ? result.settings : result;
    showNotice('Privacy Mode enabled — restart required for GPU changes', 5000);
    $('restart-banner').classList.remove('hidden');
    openPrivacyPanel();
  };

  $('btn-privacy-disable').onclick = async () => {
    const result = await window.locrium.saveSettings({ privacyModeEnabled: false });
    settings = (result && result.settings) ? result.settings : result;
    showNotice('Privacy Mode disabled — restart required for GPU changes', 5000);
    $('restart-banner').classList.remove('hidden');
    openPrivacyPanel();
  };

  $('btn-privacy-restart').onclick = () => window.locrium.restartApp();

  $('btn-clear-blocked-log').onclick = async () => {
    await window.locrium.clearBlockedLog();
    showNotice('Blocked request log cleared');
    openPrivacyPanel();
  };
}

function refreshPrivacyPanel(status) {
  if (!status) return;

  const privacyOn = !!status.privacyModeEnabled;
  const restartNeeded = privacyOn !== !!(settings.privacyModeEnabled);

  setBadge('ps-privacy-mode', privacyOn);
  setBadge('ps-gpu',     !!status.gpuDisabledAtStartup);
  setBadge('ps-webgpu',  !!status.blockWebGPU);
  setBadge('ps-webgl',   !!status.blockWebGL);
  setBadge('ps-canvas',  !!status.resistCanvasFingerprinting);
  setBadge('ps-scripts', !!status.blockKnownTrackingScripts);
  setBadge('ps-restart', restartNeeded, true);

  $('ps-blocked-count').textContent = status.blockedCount || '0';

  const logEl = $('privacy-blocked-log');
  const entries = status.blockedLog || [];
  if (!entries.length) {
    logEl.innerHTML = '<span class="privacy-log-empty">No requests blocked yet.</span>';
  } else {
    logEl.innerHTML = entries.slice().reverse().map((e) => {
      const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      let domain = e.url;
      try { domain = new URL(e.url).hostname; } catch (_) {}
      return `<span class="privacy-log-entry">[${time}] ${domain}</span>`;
    }).join('');
  }
}

// ── Health panel ──────────────────────────────────────────────────────────────

async function openHealthPanel() {
  // Load app version info
  const ver = await window.locrium.getAppVersion();
  if (ver) {
    $('hi-app-version').textContent = ver.appVersion   || '—';
    $('hi-electron').textContent    = ver.electronVersion || '—';
    $('hi-chrome').textContent      = ver.chromeVersion   || '—';
    $('hi-node').textContent        = ver.nodeVersion     || '—';
  }

  // Load search service status
  const status = await window.locrium.searchServiceStatus();
  updateHealthPanel(status);

  // Wire up action buttons (replace with onclick to avoid duplicate listeners)
  $('btn-svc-start').onclick   = svcAction('start');
  $('btn-svc-stop').onclick    = svcAction('stop');
  $('btn-svc-restart').onclick = svcAction('restart');
  $('btn-svc-health').onclick  = runHealthCheck;

  $('btn-check-browser-update').onclick = checkBrowserUpdate;
  $('btn-check-search-update').onclick  = checkSearchUpdate;

  $('btn-open-search').onclick = () => {
    if (activeTabId !== null) {
      navigate(activeTabId, 'http://127.0.0.1:8888/');
      closePanel('health');
    }
  };

  // Engine log
  $('btn-refresh-engine-log').onclick = () => renderEngineLog();
  renderEngineLog();
}

function svcAction(action) {
  return async () => {
    setBanner('unknown', 'Working…');
    let res;
    if (action === 'start')   res = await window.locrium.searchServiceStart();
    if (action === 'stop')    res = await window.locrium.searchServiceStop();
    if (action === 'restart') res = await window.locrium.searchServiceRestart();
    updateHealthPanel(res && res.status ? res.status : res);
  };
}

async function runHealthCheck() {
  setBanner('unknown', 'Running health check…');
  const health = await window.locrium.searchServiceHealth();
  // health = { timestamp, ok, error?, details? } from searchServiceManager.healthCheck()
  const isOk = health && (health.ok || (health.details && health.details.status === 'ok'));
  if (isOk) {
    setBanner('ok', 'Healthy — service is running');
    $('hi-svc-health').textContent = new Date().toLocaleTimeString();
  } else {
    setBanner('error', health && health.error ? health.error : 'Health check failed');
  }
}

function updateHealthPanel(status) {
  if (!status) return;
  const running = status.running;
  const svcUrl  = `http://127.0.0.1:${status.port || 8888}`;

  $('hi-svc-version').textContent = status.version || '—';
  $('hi-svc-status').textContent  = running ? 'Running' : 'Stopped';
  $('hi-svc-url').textContent     = running ? svcUrl : '—';
  $('hi-svc-start').textContent   = status.startTime
    ? new Date(status.startTime).toLocaleTimeString()
    : '—';

  if (running) {
    setBanner('ok', `Multi-engine search running on port ${status.port || 8888}`);
    updateSearchBadge(true);
  } else {
    setBanner('error', 'Search service is not running');
    updateSearchBadge(false);
  }
}

function setBanner(state, text) {
  const banner = $('health-status-banner');
  banner.className = `health-banner health-banner--${state}`;
  $('health-status-text').textContent = text;
}

// ── Search service badge (navbar) ─────────────────────────────────────────────

function updateSearchBadge(running) {
  const badge = $('search-svc-badge');
  if (running) {
    badge.className   = 'search-svc-badge search-svc-badge--ok';
    badge.title       = 'Local multi-engine search is running';
    badge.textContent = '● Local';
  } else if (running === false) {
    badge.className   = 'search-svc-badge search-svc-badge--error';
    badge.title       = 'Local search is not running — using external links';
    badge.textContent = '○ External';
  } else {
    badge.className   = 'search-svc-badge search-svc-badge--unknown';
    badge.title       = 'Checking search service…';
    badge.textContent = '● …';
  }
}

// ── Engine log ────────────────────────────────────────────────────────────────

async function renderEngineLog() {
  const container = $('engine-log-container');
  container.innerHTML = '<p class="engine-log-empty">Loading…</p>';
  try {
    const data = await window.locrium.getEngineLog();
    const entries = (data && data.log) || [];
    if (!entries.length) {
      container.innerHTML = '<p class="engine-log-empty">No engine queries yet. Try searching first.</p>';
      return;
    }
    // Show newest first
    const reversed = entries.slice().reverse();
    container.innerHTML = reversed.map((e) => {
      const time  = e.ts ? new Date(e.ts).toLocaleTimeString() : '—';
      const cls   = e.ok ? 'ok' : 'fail';
      const stat  = e.ok ? `${e.count} result${e.count !== 1 ? 's' : ''} · ${e.ms}ms` : (e.error || 'failed').slice(0, 60);
      const name  = (e.engine || '—').charAt(0).toUpperCase() + (e.engine || '').slice(1);
      return `<div class="engine-log-entry ${cls}">
        <span class="elog-time">${escHtml(time)}</span>
        <span class="elog-name">${escHtml(name)}</span>
        <span class="elog-query">${escHtml(e.query || '—')}</span>
        <span class="elog-stat ${cls}">${escHtml(stat)}</span>
      </div>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<p class="engine-log-empty">Could not load log: ${err.message}</p>`;
  }
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function checkBrowserUpdate() {
  const el = $('browser-update-result');
  el.className = 'update-result';
  el.textContent = 'Checking…';
  try {
    const res = await window.locrium.checkBrowserUpdates();
    if (res && res.available) {
      el.className = 'update-result ok';
      el.textContent = `Update available: v${res.latestVersion} — download from your release page`;
    } else if (res && res.available === false) {
      el.className = 'update-result ok';
      el.textContent = 'You are on the latest version';
    } else {
      el.className = 'update-result';
      el.textContent = res && res.message ? res.message : 'Check complete';
    }
  } catch (err) {
    el.className = 'update-result error';
    el.textContent = `Error: ${err.message}`;
  }
}

async function checkSearchUpdate() {
  const el = $('search-update-result');
  el.className = 'update-result';
  el.textContent = 'Checking…';
  try {
    const res = await window.locrium.checkSearchUpdates();
    if (res && res.available) {
      el.className = 'update-result ok';
      el.textContent = `Update available: v${res.latestVersion}`;
    } else if (res && res.available === false) {
      el.className = 'update-result ok';
      el.textContent = 'Search service is up to date';
    } else {
      el.className = 'update-result';
      el.textContent = res && res.message ? res.message : 'Check complete';
    }
  } catch (err) {
    el.className = 'update-result error';
    el.textContent = `Error: ${err.message}`;
  }
}

// ── Markdown Converter Panel ──────────────────────────────────────────────────

// State: map of filePath → { name, ext, badge, markdown, outputPath, error }
const _mdFiles = new Map();

function mdFileExt(filePath) {
  const m = filePath.match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : '?';
}

function mdFileName(filePath) {
  return filePath.replace(/\\/g, '/').split('/').pop();
}

function addMdFiles(paths) {
  for (const p of paths) {
    if (!_mdFiles.has(p)) {
      _mdFiles.set(p, { name: mdFileName(p), ext: mdFileExt(p), badge: 'queued', markdown: '', outputPath: null, error: null });
    }
  }
  renderMdFileList();
  $('md-file-section').classList.remove('hidden');
}

function renderMdFileList() {
  const list = $('md-file-list');
  list.innerHTML = '';
  for (const [fp, info] of _mdFiles) {
    const li = document.createElement('li');
    li.className = 'md-file-item';
    li.dataset.path = fp;

    const nameEl = document.createElement('span');
    nameEl.className = 'md-file-name';
    nameEl.title = fp;
    nameEl.textContent = info.name;

    const extEl = document.createElement('span');
    extEl.className = 'md-file-ext';
    extEl.textContent = info.ext;

    const badge = document.createElement('span');
    badge.className = `md-file-badge md-badge-${info.badge}`;
    badge.textContent = badgeLabel(info.badge);

    li.appendChild(nameEl);
    li.appendChild(extEl);
    li.appendChild(badge);

    if (info.error) {
      const err = document.createElement('div');
      err.className = 'md-file-error';
      err.textContent = info.error;
      li.style.flexWrap = 'wrap';
      li.appendChild(err);
    }

    if (info.badge === 'done') {
      li.style.cursor = 'pointer';
      li.title = 'Click to preview';
      li.addEventListener('click', () => showMdPreview(info));
    }

    list.appendChild(li);
  }
}

function badgeLabel(badge) {
  switch (badge) {
    case 'queued':     return 'Queued';
    case 'converting': return 'Converting…';
    case 'done':       return '✓ Done';
    case 'error':      return '✗ Error';
    default:           return badge;
  }
}

function updateMdFileItem(data) {
  const info = _mdFiles.get(data.filePath);
  if (!info) return;
  info.badge      = data.state;
  info.markdown   = data.markdown   || info.markdown;
  info.outputPath = data.outputPath || info.outputPath;
  info.error      = data.error      || null;
  renderMdFileList();

  // Auto-show preview for the last successfully converted file
  if (data.state === 'done' && info.markdown) {
    showMdPreview(info);
  }
}

function showMdPreview(info) {
  $('md-preview-name').textContent = info.name;
  $('md-preview').textContent      = info.markdown.slice(0, 8000); // cap for display
  $('md-preview-section').classList.remove('hidden');
}

function initConverterPanel() {
  const dropZone = $('md-drop-zone');

  // Drag-and-drop — expand directories via main process before queuing
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const rawPaths = [];
    for (const f of e.dataTransfer.files) {
      if (f.path) rawPaths.push(f.path);
    }
    if (!rawPaths.length) return;
    // Expand directories recursively on the main side
    const result = await window.locrium.expandPaths(rawPaths);
    const expanded = (result && result.paths) ? result.paths : rawPaths;
    if (expanded.length) addMdFiles(expanded);
  });

  // File chooser
  $('btn-md-choose').addEventListener('click', async () => {
    const result = await window.locrium.openFileDialog({ mode: 'files' });
    const paths = result && result.paths ? result.paths : [];
    if (paths.length) addMdFiles(paths);
  });

  // Folder chooser — recursively expands supported files from picked directory
  $('btn-md-choose-folder').addEventListener('click', async () => {
    const result = await window.locrium.openFileDialog({ mode: 'folder' });
    const paths  = result && result.paths ? result.paths : [];
    if (!paths.length) { showNotice('No supported files found in that folder'); return; }
    const folderName = result.folderName || 'folder';
    addMdFiles(paths);
    showNotice(`Found ${paths.length} file${paths.length !== 1 ? 's' : ''} in "${folderName}"`, 3000);
  });

  // Clear all
  $('btn-md-clear').addEventListener('click', () => {
    _mdFiles.clear();
    $('md-file-list').innerHTML = '';
    $('md-file-section').classList.add('hidden');
    $('md-preview-section').classList.add('hidden');
    $('md-convert-status').textContent = '';
    $('md-convert-status').className   = 'md-status-line';
  });

  // Convert
  $('btn-md-convert').addEventListener('click', async () => {
    const filePaths = [..._mdFiles.keys()];
    if (!filePaths.length) return;

    const btn = $('btn-md-convert');
    btn.disabled = true;
    btn.textContent = '⏳ Converting…';

    const status = $('md-convert-status');
    status.className   = 'md-status-line';
    status.textContent = `Converting ${filePaths.length} file${filePaths.length !== 1 ? 's' : ''}…`;

    // Reset all badges to queued before starting
    for (const info of _mdFiles.values()) info.badge = 'queued';
    renderMdFileList();

    const combine = $('md-combine').checked;
    const results = await window.locrium.convertToMarkdown({ filePaths, combine });

    const done  = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    btn.disabled = false;
    btn.textContent = '▶ Convert';

    if (failed === 0) {
      status.className   = 'md-status-line ok';
      status.textContent = `✓ ${done} file${done !== 1 ? 's' : ''} converted → Downloads\\LocriumMarkdown`;
    } else {
      status.className   = 'md-status-line error';
      status.textContent = `${done} succeeded, ${failed} failed`;
    }
  });

  // Open output folder
  $('btn-md-open-folder').addEventListener('click', () => {
    window.locrium.openMarkdownOutputFolder();
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
initConverterPanel();
