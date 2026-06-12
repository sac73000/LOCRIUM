# LOCRIUM

A privacy-focused, lightweight Chromium-based desktop browser built with Electron.

Dark mode by default. SearXNG as the default search engine. No telemetry, no cloud accounts, no tracking.

---

## Project Structure

```
LOCRIUM/
├── src/
│   ├── main.js                       ← Electron main process (tabs, IPC, security, service lifecycle)
│   ├── preload.js                    ← Safe contextBridge API exposed as window.locrium
│   ├── content-preload.js            ← Minimal preload for BrowserView page content
│   ├── main/
│   │   ├── searchServiceManager.js   ← In-process HTTP search service (127.0.0.1:8080)
│   │   ├── searchServiceUpdater.js   ← Checks/applies search service updates
│   │   └── browserUpdater.js        ← Browser auto-update via electron-updater
│   └── renderer/
│       ├── index.html               ← Browser chrome UI (tabs, nav, panels)
│       ├── style.css                ← Dark-mode-first styles
│       └── app.js                   ← Renderer logic (tabs, panels, health panel)
├── resources/
│   └── blocklist.txt                ← Domain blocklist for ad/tracker filtering
├── build/
│   └── icon.ico                     ← App icon (LOCRIUM branded, multi-resolution)
├── package.json                     ← Scripts, electron-builder config, publish config
└── README.md                        ← This file
```

---

## Agent API (localhost:7717)

LOCRIUM exposes a full HTTP control API for automation agents (OpenClaw and any other local script or program). It binds **only** to `127.0.0.1` — it is never exposed to your LAN or the internet.

### Security

| Setting | Default | How to change |
|---|---|---|
| Port | `7717` | Set env var `LOCRIUM_API_PORT` before launching |
| Auth | None | Set env var `LOCRIUM_API_KEY`; pass it as `X-Locrium-Key` header |
| Bind address | `127.0.0.1` | Hard-coded, cannot be changed |

### Base URL

```
http://127.0.0.1:7717
```

---

### Read endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/status` | Health check — version, tab count, active tab ID |
| GET | `/api/tabs` | List all open tabs (id, url, title, incognito) |
| GET | `/api/url` | Current tab URL |
| GET | `/api/page` | **Best for agents** — url, title, description, text, links in one call |
| GET | `/api/metadata` | All meta/og/twitter tags, canonical, lang, charset |
| GET | `/api/text` | `document.body.innerText` of current page |
| GET | `/api/html` | Full `outerHTML` of current page |
| GET | `/api/links?limit=N` | All `<a href>` elements: href, text, rel (default limit 300) |
| GET | `/api/screenshot` | PNG screenshot (Content-Type: image/png) |
| GET | `/api/cookies` | Cookies for the current URL |
| GET | `/api/cookies?name=x` | Single cookie by name |
| GET | `/api/storage` | `localStorage` and `sessionStorage` as JSON |
| GET | `/api/search?q=…` | Search via built-in multi-engine service, returns JSON results |

---

### Action endpoints

| Method | Endpoint | Body | Description |
|---|---|---|---|
| POST | `/api/navigate` | `{ url, wait?, tabId? }` | Navigate to URL; `wait: true` blocks until page finishes loading |
| POST | `/api/new-tab` | `{ url?, incognito? }` | Open a new tab, returns `{ id }` |
| POST | `/api/close-tab` | `{ id? }` | Close tab by id (omit = close active tab) |
| POST | `/api/back` | — | Go back |
| POST | `/api/forward` | — | Go forward |
| POST | `/api/reload` | — | Reload current page |
| POST | `/api/exec` | `{ js, tabId? }` | Run arbitrary JS, returns `{ result }` |
| POST | `/api/find` | `{ selector, attrs?, limit? }` | CSS selector → array of `{ tag, id, class, text, html, value, href, src, ...attrs }` |
| POST | `/api/click` | `{ selector }` | Click element by CSS selector |
| POST | `/api/type` | `{ selector, text, clear? }` | Type into input; `clear: true` replaces existing value |
| POST | `/api/scroll` | `{ selector?, x?, y?, behavior? }` | Scroll to element or position |
| POST | `/api/wait` | `{ selector, timeout? }` | Wait for CSS selector to appear (max 30 s) |
| POST | `/api/cookies` | `{ name, value, url?, … }` | Set a cookie |
| DELETE | `/api/cookies` | `{ name? }` | Remove cookie(s) for current URL |

All POST bodies are JSON. `tabId` is optional on any endpoint — omit to target the active tab.

---

### Example: agent search-and-read loop

```python
import requests, time

BASE = "http://127.0.0.1:7717"

# 1. Search
results = requests.get(f"{BASE}/api/search", params={"q": "latest AI papers"}).json()

# 2. Navigate to first result (wait for load)
first_url = results["results"][0]["url"]
requests.post(f"{BASE}/api/navigate", json={"url": first_url, "wait": True})

# 3. Grab full page snapshot
page = requests.get(f"{BASE}/api/page").json()
print(page["title"])
print(page["text"][:2000])

# 4. Find all outbound links
for link in page["links"]:
    print(link["href"], link["text"])
```

### Example: fill and submit a form

```python
BASE = "http://127.0.0.1:7717"

requests.post(f"{BASE}/api/navigate", json={"url": "https://example.com/login", "wait": True})
requests.post(f"{BASE}/api/type",     json={"selector": "input[name=email]",    "text": "me@example.com", "clear": True})
requests.post(f"{BASE}/api/type",     json={"selector": "input[name=password]", "text": "hunter2",        "clear": True})
requests.post(f"{BASE}/api/click",    json={"selector": "button[type=submit]"})
requests.post(f"{BASE}/api/wait",     json={"selector": ".dashboard", "timeout": 8000})

page = requests.get(f"{BASE}/api/page").json()
```

---

## Local Search Service

LOCRIUM bundles a lightweight local search service that runs as part of the Electron main process.

### Architecture

| Property | Value |
|---|---|
| Address | `127.0.0.1:8080` (loopback only — not exposed to LAN) |
| Protocol | HTTP/1.1 |
| Process model | In-process Node.js `http.Server` (no Docker, no Python, no WSL required) |
| Lifecycle | Started when the browser launches, stopped gracefully when it exits |

### Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Local search home page |
| `GET /search?q=<query>` | HTML search results page |
| `GET /search?q=<query>&format=json` | JSON search results |
| `GET /api/search?q=<query>` | JSON search results (programmatic) |
| `GET /health` | JSON health status |

### MVP vs Full SearXNG

The bundled MVP search service returns placeholder results that link out to DuckDuckGo, Wikipedia, and GitHub. To replace it with a real SearXNG backend:

1. Bundle SearXNG (Python) or a standalone SearXNG binary in `resources/`.
2. Update `searchServiceManager.js` `start()` to spawn the subprocess instead of creating an in-process HTTP server.
3. Proxy requests through to SearXNG's endpoints.
4. Note: SearXNG is AGPL-3.0 licensed — review distribution obligations at https://searxng.org/license

### Health Panel

Click the **🔌** (plug) button in the top-right navigation bar to open the Health & Search Service panel. From there you can:

- View real-time service status (running / stopped, port, version, uptime)
- Start, stop, or restart the search service manually
- Run a live health check (HTTP ping to `/health`)
- Check for browser and search service updates
- View browser version info (Electron, Chromium, Node.js)

---

## Quick Start (Windows)

### 1. Prerequisites

- **Node.js** v18 or higher: https://nodejs.org/
- **Git** (optional): https://git-scm.com/
- Windows 10 or 11 (64-bit)

### 2. Install dependencies

Open a terminal (Command Prompt or PowerShell) in the `LOCRIUM/` folder:

```cmd
npm install
```

This downloads Electron and all dependencies. Takes 1–3 minutes first time.

### 3. Run in development mode

```cmd
npm start
```

The browser window opens immediately. No build step needed.

### 4. Build the Windows installer and portable EXE

```cmd
npm run build:release
```

Output is placed in `dist/`. You'll always find exactly:
- `LocriumSetup.exe` — NSIS installer (recommended for distribution)
- `Locrium.exe` — Portable executable (no install required)

### 5. Build individual targets

```cmd
npm run build:installer   # NSIS installer only
npm run build:portable    # Portable EXE only
npm run build:unpack      # Unpacked directory (for testing without installer)
```

---

## Quick Start (Linux)

### 1. Prerequisites

- **Node.js** v18 or higher — install via your distro's package manager or https://nodejs.org/
- A desktop environment (GNOME, KDE, XFCE, etc.) — Electron requires a display server
- **libgtk-3**, **libnss3**, **libasound2** — usually already present on most desktops

Ubuntu/Debian one-liner:
```bash
sudo apt install -y libgtk-3-0 libnss3 libasound2 libxss1 libgbm1
```

Fedora/RHEL:
```bash
sudo dnf install -y gtk3 nss alsa-lib libXScrnSaver mesa-libgbm
```

### 2. Download the pre-built package

Download `LOCRIUM-Linux-v1.2.1.tar.gz` from the Releases page, then:

```bash
tar -xzf LOCRIUM-Linux-v1.2.1.tar.gz
cd LOCRIUM-linux-x64
chmod +x LOCRIUM
./LOCRIUM
```

That's it — no install step, no package manager, runs straight from the folder.

### 3. Optional: add to your application launcher

```bash
# Create a desktop entry
cat > ~/.local/share/applications/locrium.desktop << EOF
[Desktop Entry]
Type=Application
Name=LOCRIUM
Comment=Privacy-focused desktop browser
Exec=/path/to/LOCRIUM-linux-x64/LOCRIUM
Icon=/path/to/LOCRIUM-linux-x64/resources/app/build/icon.png
Categories=Network;WebBrowser;
Terminal=false
EOF
```

### 4. Build from source on Linux

```bash
cd LOCRIUM
npm install
npm start                          # Run in dev mode
node_modules/.bin/electron-packager . LOCRIUM --platform=linux --arch=x64 --out=dist --overwrite
```

### Linux-specific notes

| Topic | Detail |
|---|---|
| Sandbox | Electron's renderer sandbox (`--no-sandbox`) may be needed on some distros. If the app fails to start, run: `./LOCRIUM --no-sandbox` |
| Wayland | Runs on XWayland by default. For native Wayland: `./LOCRIUM --enable-features=UseOzonePlatform --ozone-platform=wayland` |
| Agent API | Works identically to Windows — `localhost:7717` |
| Search service | Works identically to Windows — `localhost:8888` |
| Data storage | Settings/bookmarks/history stored in `~/.config/locrium/` |

---

## Release Workflow

Follow these steps for every public release:

### Step 1 — Bump the version

```cmd
npm run version:patch     # 1.0.0 → 1.0.1  (bug fix)
npm run version:minor     # 1.0.0 → 1.1.0  (new feature)
npm run version:major     # 1.0.0 → 2.0.0  (breaking change)
```

This updates `package.json`, creates a git commit, and tags the release (e.g. `v1.0.1`).
To skip the git tag: `node scripts/version-bump.js patch --no-tag`

### Step 2 — Build the release artefacts

```cmd
npm run build:release
```

Both output files are written to `dist/` with consistent names regardless of version:

| File | Type |
|------|------|
| `dist/LocriumSetup.exe` | NSIS installer |
| `dist/Locrium.exe` | Portable EXE |

The EXE metadata embedded in both files (visible in Windows → Properties → Details):

| Field | Value |
|-------|-------|
| Product Name | LOCRIUM |
| Company Name | Locrium Technologies |
| File Description | Privacy-Focused Desktop Browser |
| Version | Matches `package.json` |

### Step 3 — Sign the artefacts (optional but recommended)

Code signing reduces SmartScreen and Smart App Control warnings. You need a valid
Authenticode certificate (EV certificates build reputation fastest).

**Option A — Automatic signing during build:**

Set the environment variables before running `build:release`:

```cmd
set LOCRIUM_CERT_PATH=C:\certs\locrium.pfx
set LOCRIUM_CERT_PASS=YourCertPassword
npm run build:release
```

`electron-builder` will call `scripts/sign.js` automatically for each binary.
If `LOCRIUM_CERT_PATH` is not set, the build proceeds unsigned without error.

**Option B — Manual signing after build:**

```cmd
set LOCRIUM_CERT_PATH=C:\certs\locrium.pfx
set LOCRIUM_CERT_PASS=YourCertPassword
scripts\sign.bat
```

Or via Node (cross-platform):

```cmd
npm run sign
```

Both options call `signtool.exe` with SHA-256 + RFC 3161 timestamp
(`http://timestamp.digicert.com`) and verify the signature afterwards.

> **Security note:** Never commit `LOCRIUM_CERT_PATH` or `LOCRIUM_CERT_PASS` to
> source control. Keep your PFX file off the build machine when not in use.

### Step 4 — Distribute

Upload `dist/LocriumSetup.exe` and `dist/Locrium.exe` to your distribution channel
(GitHub Releases, website, etc.).

### Smart App Control notes

Windows Smart App Control and SmartScreen build reputation per publisher over time.
To build reputation as quickly as possible:

- Use a consistent `appId` (`com.locrium.browser`) — already set
- Use the same code-signing certificate for every release
- Use an EV (Extended Validation) certificate if budget allows — EV certificates
  immediately establish SmartScreen reputation without requiring multiple installs
- Keep the `productName`, `companyName`, and `executableName` identical across releases

---

---

## Features

### Core browsing
- Multiple tabs with close/new tab controls
- Back, forward, reload, stop, home buttons
- Address bar that auto-detects URLs vs. search queries
- Tab title and favicon updates
- Loading progress indicator
- `target="_blank"` links open in new tabs

### Search
- Default search engine: **SearXNG** at `http://localhost:8080`
- Change the URL in Settings → Search Engine
- Plain text typed in address bar becomes a SearXNG search query

### Privacy
- Built-in tracker/ad domain blocklist (`resources/blocklist.txt`)
- Private / incognito tabs (isolated in-memory session)
- Block third-party cookies toggle
- JavaScript enable/disable per new tab
- Image loading enable/disable per new tab
- Clear browsing data: cookies, cache, local storage, history
- No analytics, no crash reporting, no cloud sync
- Chromium anti-telemetry flags set at startup

### Security
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on all views
- Preload script exposes only a safe, narrow API via `contextBridge`
- Permissions (camera, microphone, geolocation, notifications) are **denied by default**
- Sensitive permissions prompt the user before allowing
- Navigation to `javascript:` URLs is blocked in BrowserViews
- No navigation allowed from the renderer window itself

### UI
- Dark mode by default (toggle in Settings)
- Clean, minimal browser chrome
- Tabs on top, nav bar below
- Bookmarks bar with up to 20 pinned sites
- Settings, History, Downloads, Bookmarks panels (slide-in from right)
- Notice bar for status messages

### Downloads
- File save dialog on every download
- Download progress bar
- "Open" and "Show in Folder" buttons for completed downloads
- Configurable download folder

### Keyboard shortcuts

| Shortcut        | Action              |
|-----------------|---------------------|
| `Ctrl+T`        | New tab             |
| `Ctrl+W`        | Close tab           |
| `Ctrl+Shift+N`  | New private tab     |
| `Ctrl+L`        | Focus address bar   |
| `F5` / `Ctrl+R` | Reload              |
| `Alt+Left`      | Back                |
| `Alt+Right`     | Forward             |
| `Ctrl++`        | Zoom in             |
| `Ctrl+-`        | Zoom out            |
| `Ctrl+0`        | Reset zoom          |
| `F12`           | Toggle DevTools     |
| `Escape`        | Close panels        |

---

## Customization

### Change the browser name

1. Open `package.json`
2. Change `"productName": "LOCRIUM"` to your name
3. Change `"appId"` to something unique like `"com.yourdomain.yourbrowser"`
4. Change `"shortcutName"` in the `nsis` block

### Change the default homepage

Open Settings panel in the browser, or edit `package.json`:
```json
// In electron-store defaults in src/main.js:
homepage: 'https://your-homepage.com'
```

### Change the SearXNG URL

In the browser: Settings → Search Engine URL

Or in `src/main.js`, in the `settingsStore` defaults:
```js
searxngUrl: 'http://your-searxng-host:8080'
```

### Replace the app icon

LOCRIUM ships with a branded default icon (`build/icon.ico`) containing all standard Windows sizes (16×16, 32×32, 48×48, 128×128, and 256×256). To use your own icon:

1. Create a multi-resolution `.ico` file (256×256 minimum; include 16, 32, 48, 128, and 256 px for best results)
2. Replace `build/icon.ico` with your file (keep the same filename)
3. Rebuild: `npm run build:release`

Free online ICO converters: https://www.icoconverter.com/

### Update the ad/tracker blocklist

Edit `resources/blocklist.txt`. One domain per line. Lines starting with `#` are comments.

For a full list, download from:
- https://github.com/StevenBlack/hosts (use the "domains-only" format)
- https://easylist.to/easylist/easylist.txt (requires parsing for domains only)

### Change the default dark/light mode

In `src/main.js`, find `settingsStore` defaults:
```js
darkMode: true,  // set to false for light mode default
```

---

## Data Storage

All data is stored locally in your Windows user profile:

| Data       | Location                                     |
|------------|----------------------------------------------|
| Settings   | `%APPDATA%\locrium\settings.json`       |
| Bookmarks  | `%APPDATA%\locrium\bookmarks.json`      |
| History    | `%APPDATA%\locrium\history.json`        |
| Downloads  | `%APPDATA%\locrium\downloads.json`      |

No data is sent anywhere. No account required.

---

## Electron Limitations vs. Chrome

| Feature                   | Chrome              | LOCRIUM (Electron)              |
|---------------------------|---------------------|--------------------------------------|
| Extensions                | Full Web Store      | Not supported (would need custom API)|
| PDF viewing               | Built-in            | Requires plugin or workaround        |
| Print                     | Full support        | Basic (Electron print API)           |
| DRM content (Netflix)     | Supported           | Requires Widevine CDM, not included  |
| Hardware video decoding   | Full                | Depends on Electron build flags      |
| Sync across devices       | Google Account      | Not available (by design)            |
| Update mechanism          | Auto-update         | Manual rebuild                       |
| Memory usage              | Optimized           | Higher (Electron overhead ~100MB)    |
| Chromium version          | Latest              | Tied to Electron release             |
| Safe Browsing             | Google-backed       | Disabled (privacy choice)            |
| Push notifications        | Full                | Blocked by default (privacy choice)  |

---

## TODO / Future extensions

- [ ] Reader mode (strip ads, clean article view)
- [ ] Per-tab JavaScript toggle via session recreation
- [ ] Extension API (would require significant architecture work)
- [ ] Sync bookmarks via local network (e.g. Syncthing)
- [ ] RSS reader integration
- [ ] Keyboard-driven navigation (Vimium-style)
- [ ] Full EasyList integration parser
- [ ] Auto-update via electron-updater
- [ ] Password manager (local, encrypted)
- [ ] Tab grouping
- [ ] Sidebar (pinned sites / notes)

---

## Development Notes

- The renderer (`src/renderer/`) has no access to Node.js APIs — security is enforced by contextIsolation
- All renderer-to-main communication goes through `window.locrium` (the contextBridge API in `preload.js`)
- BrowserViews are used for tab content, not `<webview>` tags (more secure and performant)
- The blocklist is loaded from disk at startup — you can hot-reload it by restarting the app
- Settings are persisted via `electron-store`, which writes to JSON files in `%APPDATA%`

---

## License

MIT — use, fork, and modify freely.
