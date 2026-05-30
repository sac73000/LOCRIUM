/**
 * LOCRIUM — Multi-Engine Search Service
 *
 * Runs a lightweight local HTTP search aggregator bound to 127.0.0.1:8888.
 * Queries DuckDuckGo (Instant Answers), Wikipedia, GitHub, StackOverflow,
 * and Brave Search simultaneously, with a 4-second per-engine timeout.
 * All requests use Node.js built-ins only — no Python, Docker, or extra deps.
 *
 * Endpoints:
 *   GET /           → HTML homepage (search bar)
 *   GET /health     → JSON health status
 *   GET /search     → HTML results with transparency panel
 *   GET /api/search → JSON results
 *   GET /api/engine-log → JSON log of recent engine successes/failures
 */

'use strict';

const http   = require('http');
const https  = require('https');
const urlMod = require('url');

// ── Config ────────────────────────────────────────────────────────────────────

const SEARCH_SERVICE_VERSION = '2.0.0';
const DEFAULT_PORT           = 8888;
const BIND_HOST              = '127.0.0.1';
const ENGINE_TIMEOUT_MS      = 4000;
const ENGINE_LOG_MAX         = 200;

// ── State ─────────────────────────────────────────────────────────────────────

let server       = null;
let _port        = DEFAULT_PORT;
let _running     = false;
let _startTime   = null;
let _lastHealth  = null;
let _statusCb    = null;
let _engineLog      = [];          // circular log of engine query results
let _activeProfile  = 'standard'; // 'standard' | 'developer' | 'research'
let _profileCb      = null;        // callback(profile) when profile changes

// ── Engine definitions ────────────────────────────────────────────────────────

const ENGINES = {
  ddg:         { label: 'DuckDuckGo',  color: '#de5833' },
  wikipedia:   { label: 'Wikipedia',   color: '#3366cc' },
  github:      { label: 'GitHub',      color: '#58a6ff' },
  stackoverflow: { label: 'StackOverflow', color: '#f48024' },
  brave:       { label: 'Brave Search', color: '#fb542b' },
};

// Profile weights — higher = ranked earlier in merged results
const PROFILE_WEIGHTS = {
  standard:   { ddg: 1, wikipedia: 1, github: 1, stackoverflow: 1, brave: 1 },
  developer:  { ddg: 1, wikipedia: 0.6, github: 2, stackoverflow: 2, brave: 1 },
  research:   { ddg: 1, wikipedia: 2, github: 0.6, stackoverflow: 0.8, brave: 1 },
};

// ── Public API ────────────────────────────────────────────────────────────────

function onStatusChange(cb) { _statusCb = cb; }

function start(port) {
  return new Promise((resolve, reject) => {
    if (_running) { resolve(); return; }
    _port  = port || DEFAULT_PORT;
    server = http.createServer(handleRequest);
    server.on('error', (err) => { _running = false; _emit(); reject(err); });
    server.listen(_port, BIND_HOST, () => {
      _running   = true;
      _startTime = new Date().toISOString();
      _emit();
      resolve();
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!server || !_running) { _running = false; _emit(); resolve(); return; }
    server.close(() => {
      _running = false; _startTime = null; server = null; _emit(); resolve();
    });
  });
}

async function restart() { await stop(); await start(_port); }

async function healthCheck() {
  _lastHealth = { timestamp: new Date().toISOString(), ok: false, error: null };
  if (!_running) { _lastHealth.error = 'Service not running'; _emit(); return _lastHealth; }
  return new Promise((resolve) => {
    const req = http.get(
      { host: BIND_HOST, port: _port, path: '/health', timeout: 3000 },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            _lastHealth.ok      = json.status === 'ok';
            _lastHealth.details = json;
          } catch (_) { _lastHealth.ok = res.statusCode === 200; }
          _emit(); resolve(_lastHealth);
        });
      }
    );
    req.on('error', (err)  => { _lastHealth.error = err.message; _emit(); resolve(_lastHealth); });
    req.on('timeout', ()   => { req.destroy(); _lastHealth.error = 'Health check timed out'; _emit(); resolve(_lastHealth); });
  });
}

function getStatus() {
  return {
    running:    _running,
    version:    SEARCH_SERVICE_VERSION,
    port:       _port,
    host:       BIND_HOST,
    baseUrl:    `http://${BIND_HOST}:${_port}`,
    startTime:  _startTime,
    lastHealth: _lastHealth,
  };
}

// ── HTTP request handler ──────────────────────────────────────────────────────

function handleRequest(req, res) {
  const parsed   = urlMod.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin',  `http://${BIND_HOST}:${_port}`);
  res.setHeader('X-Content-Type-Options',        'nosniff');
  res.setHeader('X-Frame-Options',               'SAMEORIGIN');

  if (pathname === '/health')           return serveHealth(res);
  if (pathname === '/api/engine-log')   return serveEngineLog(res);
  if (pathname === '/api/search') {
    const q       = (parsed.query.q       || '').toString().trim();
    const profile = (parsed.query.profile || '').toString().toLowerCase() || _activeProfile;
    return serveSearchJson(res, q, profile);
  }
  if (pathname === '/search') {
    const q          = (parsed.query.q       || '').toString().trim();
    const reqProfile = (parsed.query.profile || _activeProfile).toString().toLowerCase();
    const profile    = PROFILE_WEIGHTS[reqProfile] ? reqProfile : _activeProfile;
    if (profile !== _activeProfile) {
      _activeProfile = profile;
      if (_profileCb) _profileCb(_activeProfile);
    }
    return serveSearchHtml(res, q, profile);
  }
  if (pathname === '/' || pathname === '') return serveHome(res);

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// ── Endpoint handlers ─────────────────────────────────────────────────────────

function serveHealth(res) {
  const body = JSON.stringify({
    status:    'ok',
    version:   SEARCH_SERVICE_VERSION,
    service:   'locrium-search',
    engines:   Object.keys(ENGINES),
    uptime:    _startTime ? Math.round((Date.now() - new Date(_startTime)) / 1000) : 0,
    timestamp: new Date().toISOString(),
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

function serveEngineLog(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ log: _engineLog.slice(-100) }));
}

async function serveSearchJson(res, query, profile) {
  const { results, meta } = await queryAllEngines(query, profile);
  const body = JSON.stringify({
    query,
    profile,
    results,
    meta,
    number_of_results: results.length,
    version: SEARCH_SERVICE_VERSION,
    engine:  'locrium-search-multi',
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function serveSearchHtml(res, query, profile) {
  if (!query) { return serveHome(res); }
  const startMs = Date.now();
  const { results, meta } = await queryAllEngines(query, profile);
  const elapsedMs = Date.now() - startMs;

  const esc = escapeHtml;

  const profileSelector = `
    <div class="profile-bar">
      <span class="profile-label">Search profile:</span>
      ${['standard','developer','research'].map((p) => `
        <a href="/search?q=${encodeURIComponent(query)}&profile=${p}"
           class="profile-btn${profile === p ? ' active' : ''}">
          ${p.charAt(0).toUpperCase() + p.slice(1)}
        </a>`).join('')}
    </div>`;

  const transparencyBar = `
    <div class="transparency-bar">
      <span class="t-summary">
        ${results.length} results from ${meta.enginesOk} engine${meta.enginesOk !== 1 ? 's' : ''}
        in ${elapsedMs}ms
        ${meta.enginesFailed > 0 ? `<span class="t-warn">· ${meta.enginesFailed} engine${meta.enginesFailed > 1 ? 's' : ''} timed out / failed</span>` : ''}
      </span>
      <div class="t-engine-pills">
        ${Object.entries(meta.engineStats).map(([key, s]) => {
          const info = ENGINES[key] || { label: key, color: '#888' };
          const cls  = s.ok ? 'pill-ok' : 'pill-fail';
          return `<span class="engine-pill ${cls}" style="--ec:${info.color}" title="${s.ok ? `${s.count} results in ${s.ms}ms` : s.error || 'failed'}">
            ${esc(info.label)} ${s.ok ? `<small>${s.ms}ms</small>` : '✗'}
          </span>`;
        }).join('')}
      </div>
    </div>`;

  const resultsHtml = results.length
    ? results.map((r) => {
        const info = ENGINES[r.engine] || { label: r.engine, color: '#888' };
        return `
        <article class="result">
          <div class="result-meta-row">
            <span class="result-url">${esc(r.url || '')}</span>
            <span class="engine-badge" style="--ec:${info.color}" title="${esc(info.label)} responded in ${r.engineMs != null ? r.engineMs + 'ms' : '—'}">${esc(info.label)}<small class="badge-ms">${r.engineMs != null ? ' ' + r.engineMs + 'ms' : ''}</small></span>
          </div>
          <h2 class="result-title"><a href="${esc(r.url || '')}">${esc(r.title || '')}</a></h2>
          <p class="result-snippet">${esc(r.content || '')}</p>
        </article>`;
      }).join('\n')
    : `<p class="no-results">No results found for "<strong>${esc(query)}</strong>". Try a different query or check your internet connection.</p>`;

  const html = buildPageHtml(esc(query), `
    ${profileSelector}
    ${transparencyBar}
    <p class="results-meta">Showing results for: <strong>${esc(query)}</strong></p>
    ${resultsHtml}
  `, profile);

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function serveHome(res) {
  const html = buildPageHtml('', `
    <div class="home-hero">
      <div class="home-logo">&#128737; LOCRIUM</div>
      <p class="home-tagline">Your private, local search aggregator</p>
      <p class="home-desc">Results from Wikipedia, GitHub, StackOverflow &amp; more — all local, no tracking.</p>
    </div>
  `, _activeProfile);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ── Multi-engine aggregator ───────────────────────────────────────────────────

async function queryAllEngines(query, profile) {
  if (!query) return { results: [], meta: { enginesOk: 0, enginesFailed: 0, engineStats: {} } };

  const profileKey = PROFILE_WEIGHTS[profile] ? profile : 'standard';
  const weights    = PROFILE_WEIGHTS[profileKey];

  const queries = [
    ['ddg',           () => queryDDG(query)],
    ['wikipedia',     () => queryWikipedia(query)],
    ['github',        () => queryGitHub(query)],
    ['stackoverflow', () => queryStackOverflow(query)],
    ['brave',         () => queryBrave(query)],
  ];

  const settled = await Promise.allSettled(
    queries.map(([key, fn]) => withTimeout(key, fn, ENGINE_TIMEOUT_MS))
  );

  const engineStats = {};
  let allResults    = [];
  let enginesOk     = 0;
  let enginesFailed = 0;

  settled.forEach(({ status, value, reason }, idx) => {
    const [key] = queries[idx];
    if (status === 'fulfilled' && value && value.results) {
      engineStats[key] = { ok: true, count: value.results.length, ms: value.ms };
      enginesOk++;
      value.results.forEach((r, i) => {
        allResults.push({ ...r, engine: key, engineRank: i, weight: weights[key] || 1, engineMs: value.ms });
      });
      _pushLog({ ts: new Date().toISOString(), engine: key, query, ok: true, count: value.results.length, ms: value.ms });
    } else {
      const err = reason ? String(reason.message || reason) : 'failed';
      engineStats[key] = { ok: false, error: err, ms: null };
      enginesFailed++;
      _pushLog({ ts: new Date().toISOString(), engine: key, query, ok: false, error: err });
    }
  });

  // Sort: lower engineRank + higher weight = higher in results
  allResults.sort((a, b) => {
    const scoreA = a.engineRank / a.weight;
    const scoreB = b.engineRank / b.weight;
    return scoreA - scoreB;
  });

  // Deduplicate by URL
  const seen  = new Set();
  const final = [];
  for (const r of allResults) {
    const key = r.url ? r.url.split('?')[0] : r.title;
    if (!seen.has(key)) { seen.add(key); final.push(r); }
  }

  return {
    results: final.slice(0, 30),
    meta: { enginesOk, enginesFailed, engineStats },
  };
}

function withTimeout(key, fn, ms) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${key}: timeout after ${ms}ms`)), ms);
    Promise.resolve()
      .then(() => fn())
      .then((r) => { clearTimeout(timer); resolve({ ...r, ms: Date.now() - t0 }); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

// ── Engine implementations ────────────────────────────────────────────────────

/** DuckDuckGo Instant Answers JSON API */
async function queryDDG(query) {
  const raw = await fetchJson(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    { 'Accept-Encoding': 'identity' }
  );

  const results = [];

  // Abstract (top answer)
  if (raw.AbstractText && raw.AbstractURL) {
    results.push({
      title:   raw.Heading || query,
      url:     raw.AbstractURL,
      content: raw.AbstractText.slice(0, 300),
    });
  }

  // Related topics
  if (Array.isArray(raw.RelatedTopics)) {
    for (const t of raw.RelatedTopics) {
      if (results.length >= 8) break;
      if (t.FirstURL && t.Text) {
        results.push({ title: t.Text.split(' - ')[0] || t.Text, url: t.FirstURL, content: t.Text });
      } else if (t.Topics) {
        for (const sub of t.Topics) {
          if (results.length >= 8) break;
          if (sub.FirstURL && sub.Text) {
            results.push({ title: sub.Text.split(' - ')[0] || sub.Text, url: sub.FirstURL, content: sub.Text });
          }
        }
      }
    }
  }

  // Definition
  if (raw.Definition && raw.DefinitionURL && results.length < 8) {
    results.push({ title: `${query} — Definition`, url: raw.DefinitionURL, content: raw.Definition });
  }

  return { results };
}

/** Wikipedia Search API */
async function queryWikipedia(query) {
  const raw = await fetchJson(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=6&srprop=snippet`,
    { 'Accept-Encoding': 'identity' }
  );

  const items = (raw.query && raw.query.search) || [];
  const results = items.map((item) => ({
    title:   item.title,
    url:     `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
    content: stripHtmlTags(item.snippet || ''),
  }));

  return { results };
}

/** GitHub Search API (unauthenticated, 10 req/min) */
async function queryGitHub(query) {
  const raw = await fetchJson(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=6&sort=stars`,
    {
      'Accept':          'application/vnd.github+json',
      'User-Agent':      'LOCRIUM-Browser/2.0',
      'Accept-Encoding': 'identity',
    }
  );

  const items   = raw.items || [];
  const results = items.map((item) => ({
    title:   `${item.full_name} ${item.description ? '— ' + item.description.slice(0, 80) : ''}`,
    url:     item.html_url,
    content: `⭐ ${item.stargazers_count} · ${item.language || 'Unknown language'}${item.description ? ' · ' + item.description.slice(0, 150) : ''}`,
  }));

  return { results };
}

/** StackExchange Search API (unauthenticated, compressed) */
async function queryStackOverflow(query) {
  const raw = await fetchJson(
    `https://api.stackexchange.com/2.3/search?order=desc&sort=votes&intitle=${encodeURIComponent(query)}&site=stackoverflow&pagesize=6&filter=default`,
    {
      'Accept-Encoding': 'identity',
      'User-Agent':      'LOCRIUM-Browser/2.0',
    }
  );

  const items   = (raw && raw.items) || [];
  const results = items.map((item) => ({
    title:   item.title,
    url:     item.link,
    content: `${item.is_answered ? '✓ Answered' : 'Unanswered'} · ${item.score} votes · ${item.answer_count} answer${item.answer_count !== 1 ? 's' : ''}`,
  }));

  return { results };
}

/** Brave Search — HTML scraping of lite endpoint */
async function queryBrave(query) {
  const html = await fetchHtml(
    `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`,
    {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml',
      'Accept-Encoding': 'identity',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  );

  // Extract all external <a href> links that look like real results (max 6).
  const results  = [];
  const linkRe   = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null && results.length < 6) {
    const url   = m[1];
    const title = stripHtmlTags(m[2]).trim().slice(0, 120);
    if (!url || !title || url.includes('brave.com') || url.includes('javascript:')) continue;
    if (results.some((r) => r.url === url)) continue;
    results.push({ title, url, content: '' });
  }

  return { results };
}

// ── HTTP fetch helpers ────────────────────────────────────────────────────────

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = { ...urlMod.parse(url), headers: headers || {}, timeout: ENGINE_TIMEOUT_MS };
    const req  = https.get(opts, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message} — ${body.slice(0, 80)}`)); }
      });
    });
    req.on('error',   (e) => reject(e));
    req.on('timeout', ()  => { req.destroy(); reject(new Error('fetch timeout')); });
  });
}

function fetchHtml(url, headers, _hops) {
  const hops = (_hops || 0);
  return new Promise((resolve, reject) => {
    const parsedUrl = urlMod.parse(url);
    if (!parsedUrl.hostname) return reject(new Error('fetchHtml: invalid URL'));
    const opts = {
      hostname: parsedUrl.hostname,
      path:     parsedUrl.path || '/',
      headers:  headers || {},
      timeout:  ENGINE_TIMEOUT_MS,
    };
    const req = https.get(opts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (hops >= 3) return reject(new Error('fetchHtml: too many redirects'));
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${parsedUrl.hostname}${res.headers.location}`;
        return fetchHtml(next, headers, hops + 1).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    });
    req.on('error',   (e) => reject(e));
    req.on('timeout', ()  => { req.destroy(); reject(new Error('fetch timeout')); });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtmlTags(str) {
  return String(str || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
}

function _pushLog(entry) {
  _engineLog.push(entry);
  if (_engineLog.length > ENGINE_LOG_MAX) _engineLog.shift();
}

function _emit() { if (_statusCb) _statusCb(getStatus()); }

// ── HTML page builder ─────────────────────────────────────────────────────────

function buildPageHtml(queryValue, bodyContent, activeProfile) {
  const esc = escapeHtml;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${queryValue ? esc(queryValue) + ' — ' : ''}LOCRIUM Search</title>
  <style>
    :root {
      --bg:      #0d0d1a;
      --surface: #13132b;
      --border:  #2a2a55;
      --accent:  #5865f2;
      --text:    #e8e8f0;
      --muted:   #a0a0c0;
      --dim:     #606080;
      --url:     #52e087;
      --warn:    #e0b452;
      --r:       6px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; font-size: 14px; }
    header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .logo { font-size: 15px; font-weight: 800; color: var(--accent); letter-spacing: 0.1em; white-space: nowrap; user-select: none; }
    .search-form { display: flex; flex: 1; max-width: 600px; gap: 8px; min-width: 200px; }
    .search-form input { flex: 1; padding: 8px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--r); color: var(--text); font-size: 14px; outline: none; transition: border-color 0.15s; }
    .search-form input:focus { border-color: var(--accent); }
    .search-form button { padding: 8px 18px; background: var(--accent); color: #fff; border: none; border-radius: var(--r); font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity 0.15s; white-space: nowrap; }
    .search-form button:hover { opacity: 0.85; }
    main { max-width: 760px; margin: 0 auto; padding: 20px 24px 40px; }

    /* Profile selector */
    .profile-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
    .profile-label { font-size: 11px; color: var(--dim); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
    .profile-btn { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 99px; border: 1px solid var(--border); color: var(--muted); text-decoration: none; transition: all 0.15s; }
    .profile-btn:hover { border-color: var(--accent); color: var(--accent); }
    .profile-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }

    /* Transparency bar */
    .transparency-bar { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 10px 14px; margin-bottom: 18px; display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
    .t-summary { font-size: 12px; color: var(--muted); flex: 1; min-width: 180px; }
    .t-warn { color: var(--warn); }
    .t-engine-pills { display: flex; gap: 6px; flex-wrap: wrap; }
    .engine-pill { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 99px; border: 1px solid var(--ec, #888); color: var(--ec, #888); display: inline-flex; align-items: center; gap: 4px; }
    .engine-pill small { font-size: 10px; opacity: 0.75; font-weight: 400; }
    .engine-pill.pill-fail { opacity: 0.45; text-decoration: line-through; }

    /* Results */
    .results-meta { font-size: 12px; color: var(--dim); margin-bottom: 18px; }
    .result { margin-bottom: 22px; padding-bottom: 22px; border-bottom: 1px solid var(--border); }
    .result:last-child { border-bottom: none; }
    .result-meta-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 3px; }
    .result-url { font-size: 11px; color: var(--url); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .engine-badge { font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--ec, #888); color: var(--ec, #888); white-space: nowrap; flex-shrink: 0; }
    .result-title a { font-size: 16px; font-weight: 600; color: var(--accent); text-decoration: none; }
    .result-title a:hover { text-decoration: underline; }
    .result-snippet { font-size: 13px; color: var(--muted); margin-top: 5px; line-height: 1.55; }
    .badge-ms { font-size: 10px; opacity: 0.75; }
    .no-results { color: var(--muted); line-height: 1.7; margin-top: 24px; }

    /* Home */
    .home-hero { text-align: center; padding: 60px 24px 40px; }
    .home-logo { font-size: 32px; font-weight: 800; color: var(--accent); letter-spacing: 0.1em; margin-bottom: 12px; }
    .home-tagline { font-size: 16px; color: var(--text); margin-bottom: 8px; }
    .home-desc { font-size: 13px; color: var(--muted); line-height: 1.6; max-width: 460px; margin: 0 auto; }

    footer { text-align: center; padding: 20px 24px; font-size: 11px; color: var(--dim); border-top: 1px solid var(--border); margin-top: 40px; }
  </style>
</head>
<body>
  <header>
    <a class="logo" href="/">&#128737; LOCRIUM</a>
    <form class="search-form" action="/search" method="get">
      <input type="hidden" name="profile" value="${esc(activeProfile || 'standard')}" />
      <input type="text" name="q" value="${esc(queryValue)}" placeholder="Search privately…" autofocus autocomplete="off" />
      <button type="submit">Search</button>
    </form>
  </header>
  <main>${bodyContent}</main>
  <footer>LOCRIUM Search Service v${SEARCH_SERVICE_VERSION} · Local at ${BIND_HOST}:${_port} · Privacy-first aggregator</footer>
</body>
</html>`;
}

// ── Profile persistence helpers ───────────────────────────────────────────────

function setProfile(profile) {
  if (PROFILE_WEIGHTS[profile]) _activeProfile = profile;
}

function getProfile() {
  return _activeProfile;
}

function onProfileChange(cb) {
  _profileCb = cb;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  start,
  stop,
  restart,
  healthCheck,
  getStatus,
  onStatusChange,
  setProfile,
  getProfile,
  onProfileChange,
  SEARCH_SERVICE_VERSION,
};
