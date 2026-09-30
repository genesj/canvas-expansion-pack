// ==UserScript==
// @name         Canvas Bulk Tools
// @namespace    http://tampermonkey.net/
// @version      2026-09-30.9
// @description  Bulk tools for Canvas: share, review, and remove item bank shares; move, indent, publish, unpublish, and remove many module items at once; rename every module at once; add fudge points to a New Quiz for many students at once.
// @author       Gene Smith-James
// @match        https://canvas.lanecc.edu/courses/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=lanecc.edu
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * Layout
 *   1. Config               hosts and global switches
 *   2. Core helpers         DOM, timing, page info, batching
 *   3. Canvas REST client   same-origin calls using your Canvas login
 *   4. Shared UI            stylesheet (theme colors at the top), launch buttons, dialogs
 *   5. Feature: Item Bank Sharing   (Item Banks page)
 *   6. Feature: Modules Batch Edit  (Modules page / course home)
 *   7. Feature: Bulk Fudge Points   (Gradebook page, New Quiz column menus)
 *   8. Bootstrap            decides which features run on this page
 *
 * Adding a feature
 *   Write a factory that returns { name, matches(path), early?(), init() }
 *   and add it to FEATURES in section 8. `early` runs at document-start
 *   (before the page's own scripts); `init` runs once the DOM is ready.
 *   Keep feature state inside its factory, and prefix ids/classes with
 *   `cbt-<feature>-` so features can't collide.
 *
 * Security model
 *   - Every change goes through Canvas or New Quizzes APIs as the signed-in
 *     user, so the servers enforce permissions. The script never grants
 *     anything the user couldn't already do by hand.
 *   - Captured quiz-service tokens live only inside this closure. They are
 *     never written to storage, the DOM, or the console, and are only sent
 *     to the hosts in CONFIG (or, for grading, an *.instructure.com host
 *     New Quizzes names itself).
 *   - Nothing is ever inserted as HTML; all text from the APIs goes in
 *     through textContent.
 *   - Results carried across a reload (sessionStorage) expire after two
 *     minutes and are deleted as soon as they're read.
 *
 * Chrome extension (Manifest V3) notes. The code is already shaped for these:
 *   - Item Bank Sharing reads the quiz service's auth headers by wrapping
 *     window.fetch / XMLHttpRequest. That only works in the page's own JS
 *     context, so the content script must declare "world": "MAIN" and
 *     "run_at": "document_start". Nothing here uses chrome.* APIs, so the
 *     whole file can run in MAIN world as-is. If chrome.storage or messaging
 *     is added later, split installCapture() into its own MAIN-world script
 *     and pass captured values to the isolated world with window.postMessage.
 *   - Bulk Fudge Points calls both quiz hosts directly (headers only, no
 *     cookies), so they must be in "host_permissions"; it needs no page capture.
 *   - The stylesheet (STYLES) is plain CSS with no JS interpolation, so it
 *     can move verbatim into a styles.css listed under content_scripts.css.
 *   - Hosts live only in CONFIG; they map to manifest "matches" and
 *     "host_permissions" (canvas.lanecc.edu plus the two quiz hosts).
 *   - No GM_* APIs, unsafeWindow, eval, or inline event handlers, so there
 *     are no Tampermonkey-only or CSP-blocked dependencies.
 *   - Each feature factory maps cleanly to its own module/file if wanted.
 */

(() => {
  'use strict';

  // ==================================================================
  // 1. Config
  // ==================================================================
  const CONFIG = {
    debug: false, // true = log every Canvas request to the console (F12)
    quizApi: 'https://lanecc.quiz-api-pdx-prod.instructure.com/api',
    quizLti: 'https://lanecc.quiz-lti-pdx-prod.instructure.com/api',
  };

  // ==================================================================
  // 2. Core helpers
  // ==================================================================
  // Captured before any feature wraps window.fetch, so our own requests
  // never pass through (or get recorded by) the capture layer.
  const nativeFetch = window.fetch.bind(window);

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const plural = n => (n === 1 ? '' : 's');
  const debug = (...args) => { if (CONFIG.debug) console.debug('[Canvas Bulk Tools]', ...args); };
  const courseId = () => location.pathname.match(/\/courses\/(\d+)/)?.[1];
  const chunk = (list, size) =>
    Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

  const domReady = () => new Promise(resolve => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve, { once: true });
    else resolve();
  });

  async function waitFor(test, timeoutMs = 10_000, intervalMs = 250) {
    const find = typeof test === 'string' ? () => document.querySelector(test) : test;
    const deadline = Date.now() + timeoutMs;
    let found = find();
    while (!found && Date.now() < deadline) {
      await sleep(intervalMs);
      found = find();
    }
    return found;
  }

  // Carries a small result across a reload. Entries expire, and reading one deletes it.
  const sessionStore = (prefix, ttlMs = 2 * 60_000) => ({
    key: () => `${prefix}-${courseId()}`,
    take() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(this.key()));
        this.clear();
        return saved && Date.now() - saved.at < ttlMs ? saved.value : null;
      } catch { return null; }
    },
    write(value) {
      try { sessionStorage.setItem(this.key(), JSON.stringify({ at: Date.now(), value })); return true; } catch { return false; }
    },
    clear() { try { sessionStorage.removeItem(this.key()); } catch { /* ignore */ } },
  });

  // Runs fn over items with at most `limit` in flight; results keep input order.
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // Runs fn over items one at a time with a pause between (not after the last).
  // fn returning false stops early. Returns how many items were started.
  async function paced(items, pauseMs, fn) {
    for (let i = 0; i < items.length; i++) {
      if (await fn(items[i], i) === false) return i;
      if (pauseMs && i < items.length - 1) await sleep(pauseMs);
    }
    return items.length;
  }

  // Tracks write jobs in progress so leaving the page (or pressing Esc) asks first.
  const job = (() => {
    let active = 0;
    let installed = false;
    const onUnload = e => { if (active) { e.preventDefault(); e.returnValue = ''; } };
    return {
      get active() { return active > 0; },
      start() {
        if (!installed) { addEventListener('beforeunload', onUnload); installed = true; }
        active++;
      },
      end() { active = Math.max(0, active - 1); },
    };
  })();

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  function btn(text, onClick, className = '') {
    const b = el('button', { type: 'button', className: `cbt-btn ${className}`.trim(), textContent: text });
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // ==================================================================
  // 3. Canvas REST client
  // ==================================================================
  // Only same-origin paths; a pagination link to anywhere else is ignored.
  const sameOriginPath = url => {
    if (!url) return null;
    const u = new URL(url, location.origin);
    return u.origin === location.origin ? u.pathname + u.search : null;
  };

  const canvas = {
    csrfToken() {
      const m = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    },

    async request(method, path, body) {
      const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
      if (method !== 'GET') headers['X-CSRF-Token'] = this.csrfToken();
      const init = { method, credentials: 'same-origin', headers };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const r = await nativeFetch(path, init);
      debug(method, path.split('?')[0], r.status);
      return r;
    },

    check(r, path) {
      if (!r.ok) throw new Error(`${path.split('?')[0]} returned ${r.status}`);
      return r;
    },

    async json(r) {
      return JSON.parse((await r.text()).replace(/^while\(1\);/, ''));
    },

    async get(path) {
      return this.json(this.check(await this.request('GET', path), path));
    },

    async getAll(path, maxPages = 100) {
      const out = [];
      let url = /[?&]per_page=/.test(path) ? path : `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
      for (let i = 0; url && i < maxPages; i++) {
        const r = this.check(await this.request('GET', url), path);
        out.push(...await this.json(r));
        url = sameOriginPath((r.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1]);
      }
      return out;
    },

    async errorText(r) {
      if (r.status === 401 || r.status === 403) return `Canvas didn't allow this (${r.status})`;
      try {
        const j = await this.json(r);
        let first = Array.isArray(j.errors) ? j.errors[0]
          : j.errors && typeof j.errors === 'object' ? Object.values(j.errors).flat()[0]
          : j.errors;
        if (first && typeof first === 'object') first = first.message;
        return first || j.message || `error ${r.status}`;
      } catch {
        return `error ${r.status}`;
      }
    },
  };

  // ==================================================================
  // 4. Shared UI
  // ==================================================================
  const STYLES = String.raw`
    /* ================= Theme ================= */
    :root {
      --cbt-launch:          #08a600;  /* launch buttons while closed */
      --cbt-launch-text:     #FFFFFF;
      --cbt-launch-border:   #C7CDD1;
      --cbt-launch-on:       #0374B5;  /* launch buttons while open */
      --cbt-launch-on-text:  #FFFFFF;

      --cbt-primary:         #0374B5;  /* confirm buttons, focus rings */
      --cbt-danger:          #D01A19;  /* destructive actions, failures */
      --cbt-warning:         #BF4D00;
      --cbt-success:         #0B874B;
      --cbt-checkbox:        #0374B5;
      --cbt-selected-row:    #E5F2F8;
      --cbt-module-bg:       #F5F5F5;  /* module headers in the Move picker */
      --cbt-notice-bg:       #F5F9FC;

      --cbt-text:            #2D3B45;
      --cbt-muted:           #6B7780;
      --cbt-border:          #C7CDD1;
      --cbt-border-light:    #E0E4E7;
      --cbt-hover:           #F5F5F5;

      --cbt-font: "Lato", "Helvetica Neue", Arial, sans-serif;
      --cbt-outside-gap: 30px;  /* module checkboxes sit this far left of the module box */
    }

    /* ================= Shared ================= */
    .cbt {
      box-sizing: border-box;
      color: var(--cbt-text);
      font: 14px/1.45 var(--cbt-font);
    }
    .cbt[hidden], .cbt [hidden], .cbt-launch[hidden] { display: none !important; }
    .cbt :focus-visible, .cbt-launch:focus-visible {
      outline: 2px solid var(--cbt-primary);
      outline-offset: 2px;
    }

    /* Launch buttons: green while closed, blue while open */
    .cbt-launch {
      display: inline-flex;
      align-items: center;
      vertical-align: middle;
      min-height: 2.375rem;
      margin-right: 6px;
      padding: 0 0.75rem;
      background: var(--cbt-launch);
      color: var(--cbt-launch-text);
      border: 1px solid var(--cbt-launch-border);
      border-radius: 4px;
      font: 400 1rem/1.5 var(--cbt-font);
      cursor: pointer;
    }
    .cbt-launch:hover { filter: brightness(.92); }
    .cbt-launch[aria-pressed="true"] {
      background: var(--cbt-launch-on);
      border-color: var(--cbt-launch-on);
      color: var(--cbt-launch-on-text);
    }
    /* Fallback when the page's own toolbar button can't be found */
    .cbt-launch.cbt-floating {
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 10000;
      margin: 0;
      box-shadow: 0 2px 6px rgba(0, 0, 0, .25);
    }

    .cbt-btn {
      padding: 6px 12px;
      background: var(--cbt-hover);
      border: 1px solid var(--cbt-border);
      border-radius: 4px;
      color: var(--cbt-text);
      font: inherit;
      cursor: pointer;
    }
    .cbt-btn.cbt-primary {
      background: var(--cbt-primary);
      border-color: var(--cbt-primary);
      color: #fff;
      font-weight: 600;
    }
    .cbt-btn.cbt-primary.cbt-danger {
      background: var(--cbt-danger);
      border-color: var(--cbt-danger);
    }
    .cbt-btn:disabled { opacity: .5; cursor: default; }

    .cbt-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
    .cbt-hint { margin: 4px 0 0; font-size: 13px; color: var(--cbt-muted); }
    .cbt-sub  { display: block; font-size: 12px; color: var(--cbt-muted); }
    .cbt .cbt-ok   { color: var(--cbt-success); }
    .cbt .cbt-warn { color: var(--cbt-warning); }

    .cbt-list {
      list-style: none;
      margin: 8px 0 0;
      padding: 4px 10px;
      max-height: 40vh;
      overflow: auto;
      border: 1px solid var(--cbt-border-light);
      border-radius: 4px;
    }
    .cbt-list li { margin: 6px 0; overflow-wrap: anywhere; }

    /* Launch-button menus (Batch Edit ▾) */
    .cbt-launch-caret { margin-left: 6px; font-size: .8em; }
    .cbt-menu {
      position: fixed;
      z-index: 10001;
      min-width: 240px;
      padding: 4px 0;
      background: #fff;
      border: 1px solid var(--cbt-border);
      border-radius: 4px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, .2);
    }
    .cbt-menu-item {
      display: block;
      width: 100%;
      padding: 8px 14px;
      background: none;
      border: 0;
      color: var(--cbt-text);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .cbt-menu .cbt-menu-item:hover,
    .cbt-menu .cbt-menu-item:focus { background: var(--cbt-selected-row); outline: none; }
    .cbt-menu-label { font-weight: 600; }

    /* Short notes in the corner after a reload */
    .cbt-toast {
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 10000;
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: min(480px, calc(100vw - 48px));
      padding: 10px 8px 10px 14px;
      background: #fff;
      border: 1px solid var(--cbt-border);
      border-left: 4px solid var(--cbt-success);
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, .2);
    }
    .cbt-toast-x {
      padding: 2px 8px;
      background: none;
      border: 0;
      border-radius: 4px;
      color: var(--cbt-text);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
    }
    .cbt-toast-x:hover { background: var(--cbt-hover); }

    /* Modal dialogs (preview, progress, results) */
    .cbt-dialog {
      width: min(560px, calc(100vw - 32px));
      padding: 20px;
      border: 0;
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, .3);
    }
    .cbt-dialog::backdrop { background: rgba(45, 59, 69, .5); }
    .cbt-dialog h2 { font-size: 20px; margin: 0 0 6px; }
    .cbt-dialog h3 { font-size: 15px; margin: 14px 0 0; }
    .cbt-dialog progress { width: 100%; margin-top: 8px; }

    /* Text boxes, number boxes, dropdowns and checkboxes inside the tools */
    .cbt input[type=checkbox] { accent-color: var(--cbt-checkbox); }
    .cbt input[type=number],
    .cbt input[type=text],
    .cbt select {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      border: 1px solid var(--cbt-border);
      border-radius: 4px;
      font: inherit;
    }

    /* ================= Item Bank Sharing ================= */
    #cbt-bank-panel {
      position: fixed;
      right: 24px;
      bottom: 76px;
      z-index: 10000;
      width: 400px;
      max-width: calc(100vw - 48px);
      max-height: calc(100vh - 110px);
      overflow: auto;
      padding: 16px;
      background: #fff;
      border: 1px solid var(--cbt-border);
      border-radius: 6px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, .2);
    }
    #cbt-bank-panel h2 { font-size: 18px; margin: 0 0 4px; }
    #cbt-bank-panel label { display: block; font-weight: 600; margin: 10px 0 4px; }
    #cbt-bank-panel .cbt-bank-status { font-size: 13px; color: var(--cbt-muted); margin-bottom: 12px; }
    #cbt-bank-panel .cbt-bank-row { display: flex; gap: 6px; }
    #cbt-bank-panel input[type=text],
    #cbt-bank-panel select { flex: 1; }
    #cbt-bank-panel .cbt-bank-checklist {
      max-height: 180px;
      overflow: auto;
      margin-top: 4px;
      padding: 4px 8px;
      border: 1px solid var(--cbt-border-light);
      border-radius: 4px;
    }
    #cbt-bank-panel .cbt-bank-checklist label {
      display: flex;
      gap: 6px;
      align-items: baseline;
      margin: 2px 0;
      font-weight: 400;
    }
    #cbt-bank-shares label { margin: 6px 0; }
    #cbt-bank-log {
      margin-top: 12px;
      padding: 8px;
      max-height: 160px;
      overflow: auto;
      background: var(--cbt-hover);
      border-radius: 4px;
      font-size: 12px;
      white-space: pre-wrap;
    }
    #cbt-bank-log:empty { display: none; }

    /* ================= Module Bulk Edit ================= */
    body.cbt-mod-on #cbt-mod-toggle.cbt-floating { display: none; }
    body.cbt-mod-on { padding-bottom: 110px; } /* keep the bar off the last items */

    .cbt-mod-check {
      width: 18px;
      height: 18px;
      margin: 0 8px 0 6px;
      flex: none;
      align-self: center;
      cursor: pointer;
      accent-color: var(--cbt-checkbox);
    }
    body.cbt-mod-on .cbt-mod-has-outside { position: relative; }
    .cbt-mod-check.cbt-mod-outside {
      position: absolute;
      left: calc(-1 * var(--cbt-outside-gap));
      top: 50%;
      transform: translateY(-50%);
      margin: 0;
    }
    body.cbt-mod-on li[id^="context_module_item_"] .ig-row {
      cursor: pointer;
      user-select: none; /* Shift-click selects a range, not text */
    }
    body.cbt-mod-on li[id^="context_module_item_"]:not(.cbt-mod-selected):hover .ig-row {
      background: var(--cbt-hover) !important;
    }
    body.cbt-mod-on li.cbt-mod-selected,
    body.cbt-mod-on li.cbt-mod-selected .ig-row {
      background: var(--cbt-selected-row) !important;
    }

    #cbt-mod-bar {
      position: fixed;
      left: 50%;
      bottom: 16px;
      transform: translateX(-50%);
      z-index: 10000;
      width: min(900px, calc(100vw - 32px));
      background: #fff;
      border: 1px solid var(--cbt-border);
      border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, .2);
    }
    #cbt-mod-bar .cbt-mod-main {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      padding: 8px 12px;
    }
    #cbt-mod-bar .cbt-mod-selall {
      display: flex;
      align-items: center;
      gap: 4px;
      margin: 0;
      font-weight: 600;
      white-space: nowrap;
      cursor: pointer;
    }
    #cbt-mod-bar .cbt-mod-selall .cbt-mod-check { margin-left: 0; }
    #cbt-mod-bar .cbt-mod-tools {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 2px;
      margin: 0 auto;
    }
    #cbt-mod-bar .cbt-mod-tool {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      min-width: 70px;
      padding: 6px 8px;
      background: none;
      border: 1px solid transparent;
      border-radius: 4px;
      color: var(--cbt-text);
      font: inherit;
      cursor: pointer;
    }
    #cbt-mod-bar .cbt-mod-tool i { font-size: 18px; line-height: 1; }
    #cbt-mod-bar .cbt-mod-tool:hover:not(:disabled) {
      background: var(--cbt-hover);
      border-color: var(--cbt-border);
    }
    #cbt-mod-bar .cbt-mod-tool.cbt-danger { color: var(--cbt-danger); }
    #cbt-mod-bar .cbt-mod-tool:disabled { opacity: .4; cursor: default; }
    .cbt-mod-count { font-size: 13px; color: var(--cbt-muted); white-space: nowrap; }
    #cbt-mod-bar .cbt-mod-x {
      padding: 4px 8px;
      background: none;
      border: 0;
      border-radius: 4px;
      color: var(--cbt-text);
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
    }
    #cbt-mod-bar .cbt-mod-x:hover { background: var(--cbt-hover); }
    #cbt-mod-bar .cbt-mod-notice {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 12px;
      background: var(--cbt-notice-bg);
      border-bottom: 1px solid var(--cbt-border-light);
      border-radius: 8px 8px 0 0;
    }
    #cbt-mod-bar .cbt-mod-notice > div { flex: 1; }
    #cbt-mod-bar .cbt-mod-notice .cbt-mod-x { font-size: 16px; }
    #cbt-mod-bar details { margin-top: 4px; }
    #cbt-mod-bar summary { color: var(--cbt-danger); cursor: pointer; }
    #cbt-mod-bar .cbt-list { max-height: 120px; }

    #cbt-mod-dialog details.cbt-mod-details { margin-top: 10px; }

    /* Rename modules */
    .cbt-rename-list {
      list-style: none;
      max-height: 55vh;
      overflow: auto;
      margin: 10px 0 0;
      padding: 0;
      border: 1px solid var(--cbt-border-light);
      border-radius: 4px;
    }
    .cbt-rename-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 6px 10px;
      border-top: 1px solid var(--cbt-border-light);
    }
    .cbt-rename-row:first-child { border-top: 0; }
    .cbt-rename-row.cbt-changed { background: var(--cbt-selected-row); }
    .cbt-rename-row.cbt-invalid input { border-color: var(--cbt-danger); }
    .cbt-rename-num { flex: none; width: 2em; padding-top: 7px; color: var(--cbt-muted); text-align: right; }
    .cbt-rename-field { flex: 1; min-width: 0; }
    .cbt-rename-was { margin-top: 2px; }
    #cbt-mod-dialog details.cbt-mod-details summary { color: var(--cbt-primary); cursor: pointer; }

    /* Move: the miniature Modules view */
    .cbt-mod-tree {
      max-height: 50vh;
      overflow: auto;
      margin-top: 8px;
      border: 1px solid var(--cbt-border);
      border-radius: 4px;
    }
    .cbt-mod-tree-module + .cbt-mod-tree-module { border-top: 1px solid var(--cbt-border); }
    .cbt-mod-tree-head {
      display: flex;
      align-items: stretch;
      background: var(--cbt-module-bg);
    }
    .cbt-mod-tree-toggle {
      flex: none;
      width: 36px;
      padding: 0;
      background: none;
      border: 0;
      color: var(--cbt-text);
      cursor: pointer;
    }
    .cbt-mod-tree-dest,
    .cbt-mod-tree-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 38px;
      padding: 6px 12px;
      box-sizing: border-box;
      background: none;
      border: 0;
      color: var(--cbt-text);
      font: inherit;
      text-align: left;
    }
    .cbt-mod-tree-dest { cursor: pointer; }
    .cbt-mod-tree-head .cbt-mod-tree-dest { padding-left: 0; font-weight: 700; }
    .cbt-mod-tree-item { border-top: 1px solid var(--cbt-border-light); }
    .cbt-mod-tree-dest:hover { background: var(--cbt-selected-row); }
    .cbt-mod-tree-item.cbt-chosen,
    .cbt-mod-tree-head.cbt-chosen {
      background: var(--cbt-selected-row);
      box-shadow: inset 4px 0 0 var(--cbt-primary);
    }
    .cbt-mod-tree-head:hover { background: var(--cbt-selected-row); }
    .cbt-mod-tree-head .cbt-mod-tree-dest:hover { background: none; }
    .cbt-mod-tree-subheader { font-weight: 700; }
    .cbt-mod-tree i { flex: none; width: 18px; font-size: 16px; text-align: center; }
    .cbt-mod-tree-title { min-width: 0; overflow-wrap: anywhere; }
    .cbt-mod-tree-moving { color: var(--cbt-muted); font-style: italic; }
    .cbt-mod-tree-tag {
      margin-left: auto;
      padding: 0 8px;
      border: 1px solid var(--cbt-border-light);
      border-radius: 10px;
      font-size: 12px;
      font-style: normal;
    }
    .cbt-mod-tree-marker {
      margin: 4px 12px 4px 44px;
      padding: 6px 10px;
      border: 2px dashed var(--cbt-primary);
      border-radius: 4px;
      color: var(--cbt-primary);
      font-size: 13px;
      font-weight: 600;
      text-align: center;
    }
    .cbt-mod-tree-empty {
      padding: 8px 12px 8px 44px;
      border-top: 1px solid var(--cbt-border-light);
      color: var(--cbt-muted);
      font-style: italic;
    }

    /* ================= Bulk Fudge Points ================= */
    #cbt-fudge-dialog { width: min(680px, calc(100vw - 32px)); }
    .cbt-fudge-quiz { margin: 0; color: var(--cbt-muted); }
    .cbt-fudge-points {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 14px;
      font-weight: 600;
    }
    .cbt-fudge-points input[type=number] { width: 110px; }
    .cbt-fudge-scroll {
      max-height: 45vh;
      overflow: auto;
      margin-top: 10px;
      border: 1px solid var(--cbt-border-light);
      border-radius: 4px;
    }
    .cbt-fudge-table { width: 100%; border-collapse: collapse; }
    .cbt-fudge-table th,
    .cbt-fudge-table td {
      padding: 6px 10px;
      border-top: 1px solid var(--cbt-border-light);
      text-align: left;
    }
    .cbt-fudge-table th {
      position: sticky;
      top: 0;
      z-index: 1;
      border-top: 0;
      background: var(--cbt-module-bg);
      font-weight: 600;
    }
    .cbt-fudge-table .cbt-num { text-align: right; white-space: nowrap; }
    .cbt-fudge-table .cbt-check-cell { width: 1%; }
    .cbt-fudge-table tbody tr { cursor: pointer; }
    .cbt-fudge-table tbody tr:hover { background: var(--cbt-hover); }
    .cbt-fudge-table tr.cbt-fudge-off td { color: var(--cbt-muted); }
    .cbt-fudge-change { font-weight: 600; }
    .cbt-fudge-dialog-details { margin-top: 10px; }
    .cbt-fudge-dialog-details summary { color: var(--cbt-primary); cursor: pointer; }
    .cbt-fudge-error { color: var(--cbt-danger); }
  `;

  function injectStyles() {
    if (document.getElementById('cbt-styles')) return;
    document.head.append(el('style', { id: 'cbt-styles', textContent: STYLES }));
  }

  const launch = {
    create(id, label, onClick) {
      const b = el('button', { type: 'button', id, className: 'cbt-launch', textContent: label });
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', onClick);
      return b;
    },
    setPressed(b, pressed, label) {
      b.setAttribute('aria-pressed', String(pressed));
      if (label) b.textContent = label;
    },
    dock(b, anchor) {
      b.classList.remove('cbt-floating');
      if (b.nextElementSibling !== anchor) anchor.before(b);
    },
    float(b) {
      if (b.isConnected && b.classList.contains('cbt-floating')) return;
      b.classList.add('cbt-floating');
      document.body.append(b);
    },
  };

  function launchMenu(id, label, items) {
    const text = el('span', { textContent: label });
    const caret = el('span', { className: 'cbt-launch-caret', ariaHidden: 'true', textContent: '▾' });
    const button = launch.create(id, '', () => (override ? override.onClick() : menu.hidden ? open() : close(true)));
    button.replaceChildren(text, caret);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');

    const entries = items.map(item => {
      const b = el('button', { type: 'button', role: 'menuitem', tabIndex: -1, className: 'cbt-menu-item' },
        el('span', { className: 'cbt-menu-label', textContent: item.label }),
        item.hint ? el('span', { className: 'cbt-sub', textContent: item.hint }) : '');
      b.addEventListener('click', () => { close(false); item.onSelect(); });
      return b;
    });
    const menu = el('div', { className: 'cbt cbt-menu', role: 'menu', hidden: true, ariaLabel: label }, ...entries);
    let override = null;

    function open() {
      const r = button.getBoundingClientRect();
      menu.style.top = `${r.bottom + 4}px`;
      menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 260))}px`;
      if (!menu.isConnected) document.body.append(menu);
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      entries[0]?.focus();
      document.addEventListener('pointerdown', onOutside, true);
      addEventListener('scroll', onScroll, true);
    }
    function close(refocus) {
      if (menu.hidden) return;
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onOutside, true);
      removeEventListener('scroll', onScroll, true);
      if (refocus) button.focus();
    }
    const onOutside = e => { if (!menu.contains(e.target) && !button.contains(e.target)) close(false); };
    const onScroll = e => { if (!menu.contains(e.target)) close(false); };

    menu.addEventListener('keydown', e => {
      const i = entries.indexOf(document.activeElement);
      const go = n => { e.preventDefault(); entries[(n + entries.length) % entries.length].focus(); };
      if (e.key === 'ArrowDown') go(i + 1);
      else if (e.key === 'ArrowUp') go(i - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(entries.length - 1);
      else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') close(false);
    });

    return {
      button,
      setOverride(next) {
        override = next;
        close(false);
        text.textContent = next ? next.label : label;
        caret.hidden = !!next;
        launch.setPressed(button, !!next);
      },
    };
  }

  // A modal <dialog> that can't be dismissed with Esc while a job is running.
  function modal(id) {
    const node = el('dialog', { id, className: 'cbt cbt-dialog' });
    node.addEventListener('cancel', e => { if (job.active) e.preventDefault(); });
    document.body.append(node);
    return {
      node,
      get open() { return node.open; },
      show(...children) {
        node.replaceChildren(...children);
        if (!node.open) node.showModal();
      },
      close() { node.close(); },
    };
  }

  function toast(message, ms = 10_000) {
    const dismiss = el('button', { type: 'button', className: 'cbt-toast-x', textContent: '×', ariaLabel: 'Dismiss' });
    const note = el('div', { className: 'cbt cbt-toast', role: 'status' }, el('span', { textContent: message }), dismiss);
    dismiss.addEventListener('click', () => note.remove());
    document.body.append(note);
    setTimeout(() => note.remove(), ms);
  }

  // ==================================================================
  // 5. Feature: Item Bank Sharing
  // ==================================================================
  function createItemBankFeature() {
    const PAGE_RE = /\/courses\/\d+\/(item_)?banks/;
    const PERM_LABEL = { edit: 'can edit', read: 'can view' };
    const REMOVED = 'removed_access';
    const PAUSE_WRITE_MS = 300;
    const SCAN_CONCURRENCY = 4;
    const MISSES_BEFORE_FLOAT = 5;
    const FLOATING_RECHECK_TICKS = 5;
    // People search only offers these roles, so a bank (and its answer key)
    // can't be shared with a student by picking the wrong name.
    const SHAREABLE_ROLES = ['teacher', 'ta', 'designer'];

    const MODES = {
      person: { label: 'Share with a person', action: 'Share banks' },
      course: { label: 'Share with this course', action: 'Share with course' },
      review: { label: 'Review or remove current shares', action: 'Remove access', danger: true },
    };

    // ---- Auth capture (runs at document-start) ----
    const API_HOST = new URL(CONFIG.quizApi).host;
    const LTI_HOST = new URL(CONFIG.quizLti).host;
    const auth = {
      api: { Authorization: null, Authtype: null },
      lti: { Authorization: null, Authtype: null },
      courseId: null,
    };
    let onCapture = () => {};
    let captureQueued = false;

    const slotFor = url => (url.includes(API_HOST) ? auth.api : url.includes(LTI_HOST) ? auth.lti : null);

    // `headers` is an iterable of [name, value] pairs, or a function returning one
    // (so non-quiz requests never pay to build a Headers object).
    function record(url, headers) {
      url = String(url || '');
      const slot = slotFor(url);
      if (!slot) return;
      if (slot === auth.api) {
        const m = url.match(/[?&]course_id=([^&#]+)/);
        if (m) auth.courseId = decodeURIComponent(m[1]);
      }
      for (const [name, value] of (typeof headers === 'function' ? headers() : headers) || []) {
        const k = name.toLowerCase();
        if (k === 'authorization') slot.Authorization = value;
        else if (k === 'authtype') slot.Authtype = value;
      }
      if (!captureQueued) {
        captureQueued = true;
        setTimeout(() => { captureQueued = false; onCapture(); }, 0);
      }
    }

    function installCapture() {
      const pageFetch = window.fetch;
      window.fetch = function (input, init) {
        try {
          const isRequest = input instanceof Request;
          record(isRequest ? input.url : input,
            () => new Headers(init?.headers || (isRequest ? input.headers : undefined)));
        } catch { /* never break the page */ }
        return pageFetch.apply(this, arguments);
      };

      const xhrUrls = new WeakMap();
      const { open, setRequestHeader } = XMLHttpRequest.prototype;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { xhrUrls.set(this, String(url)); record(url); } catch { /* never break the page */ }
        return open.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function (key, value) {
        try { record(xhrUrls.get(this), [[key, value]]); } catch { /* never break the page */ }
        return setRequestHeader.apply(this, arguments);
      };
    }

    function bankCourseId() {
      if (auth.courseId) return auth.courseId;
      const hit = performance.getEntriesByType('resource').map(e => e.name)
        .find(n => n.includes(API_HOST) && n.includes('course_id='));
      return hit ? new URL(hit).searchParams.get('course_id') : null;
    }

    function quizFetch(service, path, { method = 'GET', body } = {}) {
      const [base, slot] = service === 'lti' ? [CONFIG.quizLti, auth.lti] : [CONFIG.quizApi, auth.api];
      const headers = {
        Authtype: slot.Authtype || auth.api.Authtype || 'Signature',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      // Falls back to the item-bank token when the name service's own token
      // hasn't been seen yet (same vendor, same behavior as before).
      const token = slot.Authorization || auth.api.Authorization;
      if (token) headers.Authorization = token;
      return nativeFetch(base + path, {
        method,
        credentials: 'omit',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }

    const shareApi = {
      async list(bankId) {
        const r = await quizFetch('api', `/banks/${bankId}/shared_banks`);
        if (!r.ok) throw new Error(`could not read current shares (${r.status})`);
        const data = await r.json();
        return Array.isArray(data) ? data : (data.shared_banks || data.data || []);
      },

      async find(bankId, entityType, entityIds) {
        return (await this.list(bankId))
          .find(s => s.entity_type === entityType && entityIds.includes(s.entity_id)) || null;
      },

      update: (bankId, shareId, permission) =>
        quizFetch('api', `/banks/${bankId}/shared_banks/${shareId}`,
          { method: 'PATCH', body: { shared_bank: { permission } } }),

      // NOTE: `entityType` (camelCase) is sent as-is, alongside snake_case keys.
      // Kept unchanged because it works in production; see the audit notes.
      create: (bankId, entityId, entityType, permission) =>
        quizFetch('api', `/banks/${bankId}/shared_banks`, {
          method: 'POST',
          body: { shared_bank: { entity_id: entityId, entityType, bank_id: String(bankId), permission } },
        }),

      async upsert(bank, entityType, matchIds, postId, permission) {
        const existing = await this.find(bank.id, entityType, matchIds);
        if (existing?.permission === permission) return { result: 'unchanged' };
        const r = existing
          ? await this.update(bank.id, existing.id, permission)
          : await this.create(bank.id, postId, entityType, permission);
        if (!r.ok) return { result: 'failed', status: r.status };
        return { result: existing && existing.permission !== REMOVED ? 'changed' : 'added' };
      },
    };

    async function lookupNames(path, ids) {
      const out = {};
      const endpoint = path.split('?')[0];
      for (const batch of chunk(ids, 40)) {
        const qs = batch.map(id => `uuid[]=${encodeURIComponent(id)}`).join('&');
        try {
          const r = await quizFetch('lti', `/${path}${path.includes('?') ? '&' : '?'}${qs}`);
          if (!r.ok) { log(`Name lookup (${endpoint}) was refused (${r.status}).`); continue; }
          const data = await r.json();
          (Array.isArray(data) ? data : []).forEach(x => { out[x.uuid] = x; });
        } catch (e) {
          log(`Name lookup (${endpoint}) failed: ${e.message}`);
        }
      }
      return out;
    }

    // Name fallback for shares the name service couldn't resolve. Covers every
    // role (so a student who somehow has access still shows by name) but only
    // asks Canvas for names and UUIDs, not emails.
    async function rosterByUuid() {
      const users = await canvas.getAll(`/api/v1/courses/${courseId()}/users?include[]=uuid`);
      return Object.fromEntries(users.filter(u => u.uuid).map(u => [u.uuid, { full_name: u.name }]));
    }

    let coursePromise = null;
    const courseInfo = () => (coursePromise ??= canvas.get(`/api/v1/courses/${courseId()}`)
      .catch(e => { coursePromise = null; throw e; }));

    let me = null;
    async function whoAmI() {
      if (me) return me;
      me = { uuid: null, email: null };
      const [self, profile] = await Promise.all([
        canvas.get('/api/v1/users/self?include[]=uuid').catch(() => null),
        canvas.get('/api/v1/users/self/profile').catch(() => null),
      ]);
      me.uuid = self?.uuid || null;
      me.email = (profile?.primary_email || profile?.login_id || '').toLowerCase() || null;
      return me;
    }

    // ---- UI ----
    const ui = {};
    let people = [];
    let banks = [];
    let groups = [];
    let busy = false;
    let anchorMisses = 0;
    let floatingTicks = 0;

    function buildUI() {
      ui.launch = launch.create('cbt-bank-launch', 'Bulk Permissions Editor', togglePanel);
      ui.launch.hidden = true;

      ui.status = el('div', { className: 'cbt-bank-status' });
      ui.target = el('select', { id: 'cbt-bank-target' },
        ...Object.entries(MODES).map(([value, m]) => el('option', { value, textContent: m.label })));
      ui.courseHint = el('div', { className: 'cbt-hint', hidden: true,
        textContent: 'Gives teachers in this course access. Banks already shared with this course are switched to the permission below. TAs still need to be added as people.' });

      ui.term = el('input', { type: 'text', id: 'cbt-bank-term', placeholder: 'Name or email' });
      ui.search = btn('Find', searchPeople);
      ui.person = el('select', { id: 'cbt-bank-person' },
        el('option', { textContent: 'Search for a teacher, TA, or designer in this course' }));
      ui.personBox = el('div', {},
        el('label', { htmlFor: 'cbt-bank-term', textContent: 'Person' }),
        el('div', { className: 'cbt-bank-row' }, ui.term, ui.search),
        el('div', { className: 'cbt-bank-row', style: 'margin-top:6px' }, ui.person));

      ui.perm = el('select', { id: 'cbt-bank-perm' },
        el('option', { value: 'edit', textContent: 'Can edit' }),
        el('option', { value: 'read', textContent: 'Can view' }));
      ui.permBox = el('div', {}, el('label', { htmlFor: 'cbt-bank-perm', textContent: 'Permission' }), ui.perm);

      ui.loadBanks = btn('Load banks', loadBanks);
      ui.toggleAll = btn('Select none', toggleAllBanks);
      ui.banks = el('div', { className: 'cbt-bank-checklist', textContent: 'No banks loaded yet.' });

      ui.scan = btn('Scan shares', scanShares);
      ui.shares = el('div', { id: 'cbt-bank-shares', className: 'cbt-bank-checklist',
        textContent: 'Load banks, then scan to see who has access.' });
      ui.reviewBox = el('div', { hidden: true },
        el('label', { textContent: 'Who has access' }),
        el('div', { className: 'cbt-bank-row' }, ui.scan),
        el('div', { className: 'cbt-hint', textContent: 'Scans the checked banks. Removing someone only affects banks that are still checked.' }),
        ui.shares);

      ui.share = btn(MODES.person.action, runAction, 'cbt-primary');
      ui.log = el('div', { id: 'cbt-bank-log', role: 'log', ariaLive: 'polite' });

      ui.panel = el('div', { id: 'cbt-bank-panel', className: 'cbt', hidden: true,
        role: 'dialog', ariaLabel: 'Bulk share item banks' },
        el('h2', { textContent: 'Bulk Permissions Editor' }),
        ui.status,
        el('label', { htmlFor: 'cbt-bank-target', textContent: 'What do you want to do?' }),
        ui.target,
        ui.courseHint,
        ui.personBox,
        ui.permBox,
        el('label', { textContent: 'Banks' }),
        el('div', { className: 'cbt-bank-row' }, ui.loadBanks, ui.toggleAll),
        ui.banks,
        ui.reviewBox,
        el('div', { className: 'cbt-actions' }, btn('Close', togglePanel), ui.share),
        ui.log);

      ui.target.addEventListener('change', onTargetChange);
      ui.term.addEventListener('keydown', e => { if (e.key === 'Enter') searchPeople(); });
      ui.person.addEventListener('change', syncControls);
      ui.banks.addEventListener('change', syncControls);
      ui.shares.addEventListener('change', syncControls);

      document.body.append(ui.panel);
      onCapture = refreshStatus;
      syncControls();
      syncVisibility();
      setInterval(syncVisibility, 1000);
    }

    function syncControls() {
      if (!ui.panel) return;
      const mode = ui.target.value;
      ui.target.disabled = ui.search.disabled = ui.loadBanks.disabled = ui.perm.disabled = busy;
      ui.person.disabled = busy || !people.length;
      ui.toggleAll.disabled = ui.scan.disabled = busy || !banks.length;
      let ready = !busy && !!auth.api.Authorization && !!ui.banks.querySelector('input:checked');
      if (mode === 'person') ready &&= people.length > 0;
      if (mode === 'review') ready &&= !!ui.shares.querySelector('input:checked');
      ui.share.disabled = !ready;
    }

    function setBusy(value) {
      busy = value;
      syncControls();
    }

    const findBankButton = () => [...document.querySelectorAll('button, a')].find(b =>
      b !== ui.launch && !ui.panel.contains(b) && b.textContent.replace(/[+\s]/g, '') === 'Bank');

    // Scans the page only when the button isn't docked; while floating, only every few ticks.
    function placeLaunch() {
      const floating = ui.launch.classList.contains('cbt-floating');
      if (ui.launch.isConnected && !floating) return;
      if (floating && ++floatingTicks % FLOATING_RECHECK_TICKS) return;
      const anchor = findBankButton();
      if (anchor) {
        anchorMisses = 0;
        launch.dock(ui.launch, anchor);
      } else if (++anchorMisses >= MISSES_BEFORE_FLOAT) {
        launch.float(ui.launch);
      }
    }

    function syncVisibility() {
      const onPage = PAGE_RE.test(location.pathname);
      if (onPage) placeLaunch();
      ui.launch.hidden = !onPage || !ui.launch.isConnected;
      if (!onPage) ui.panel.hidden = true;
      launch.setPressed(ui.launch, !ui.panel.hidden);
    }

    function togglePanel() {
      ui.panel.hidden = !ui.panel.hidden;
      launch.setPressed(ui.launch, !ui.panel.hidden);
      if (ui.panel.hidden) return;
      refreshStatus();
      (ui.target.value === 'person' ? ui.term : ui.target).focus();
    }

    function onTargetChange() {
      const mode = ui.target.value;
      ui.personBox.hidden = mode !== 'person';
      ui.courseHint.hidden = mode !== 'course';
      ui.permBox.hidden = mode === 'review';
      ui.reviewBox.hidden = mode !== 'review';
      ui.share.textContent = MODES[mode].action;
      ui.share.classList.toggle('cbt-danger', !!MODES[mode].danger);
      syncControls();
    }

    function refreshStatus() {
      if (!ui.panel || ui.panel.hidden) return;
      const connected = !!auth.api.Authorization;
      ui.status.replaceChildren(
        connected
          ? el('span', { className: 'cbt-ok', textContent: 'Connected to item banks. ' })
          : el('span', { className: 'cbt-warn', textContent: 'Not connected yet: click "Share" on any bank, then close that dialog. ' }),
        bankCourseId() ? '' : el('span', { className: 'cbt-warn', textContent: 'Bank course not detected yet. ' }),
        connected && !auth.lti.Authorization
          ? 'To show names when reviewing shares, open any bank\u2019s Share dialog once.' : '');
      syncControls();
    }

    function log(message) {
      ui.log.textContent += message + '\n';
      ui.log.scrollTop = ui.log.scrollHeight;
    }

    const checkedBanks = () => [...ui.banks.querySelectorAll('input:checked')].map(cb => banks[Number(cb.value)]);
    const checkedGroups = () => [...ui.shares.querySelectorAll('input:checked')].map(cb => groups[Number(cb.value)]);
    const bankName = b => b.title || b.id;

    async function searchPeople() {
      if (busy) return;
      const term = ui.term.value.trim();
      if (term.length < 2) return log('Type at least 2 characters to search.');
      setBusy(true);
      try {
        const roles = SHAREABLE_ROLES.map(r => `&enrollment_type[]=${r}`).join('');
        const users = await canvas.get(`/api/v1/courses/${courseId()}/users?search_term=${encodeURIComponent(term)}` +
          `${roles}&include[]=uuid&include[]=email&include[]=avatar_url&per_page=20`);
        people = Array.isArray(users) ? users.filter(u => u.uuid) : [];
        ui.person.replaceChildren(...(people.length
          ? people.map((u, i) => el('option', { value: i, textContent: `${u.name} (${u.email || u.login_id || 'no email'})` }))
          : [el('option', { textContent: 'No match. Only teachers, TAs, and designers in this course can be added.' })]));
        log(people.length ? `Found ${people.length} match(es) for "${term}".` : `No teacher, TA, or designer matched "${term}".`);
      } catch (e) {
        log('Search failed: ' + e.message);
      } finally {
        setBusy(false);
      }
    }

    async function loadBanks() {
      const bankCourse = bankCourseId();
      if (!auth.api.Authorization) return log('No token yet. Click "Share" on any bank, close it, then try again.');
      if (!bankCourse) return log('Bank course not detected. Reload the Item Banks page and try again.');
      setBusy(true);
      banks = [];
      groups = [];
      ui.shares.replaceChildren('Load banks, then scan to see who has access.');
      try {
        for (let page = 1; page <= 50; page++) {
          const r = await quizFetch('api', `/banks?page=${page}&course_id=${encodeURIComponent(bankCourse)}`);
          if (!r.ok) throw new Error(`bank list returned ${r.status}${r.status === 401 ? ' (token expired, reload the page)' : ''}`);
          const data = await r.json();
          const list = Array.isArray(data) ? data : (data.banks || data.data || []);
          banks.push(...list);
          const total = Number(r.headers.get('total'));
          const perPage = Number(r.headers.get('per-page'));
          if (!list.length || (total && banks.length >= total) || (perPage && list.length < perPage)) break;
        }
        ui.banks.replaceChildren(...(banks.length
          ? banks.map((b, i) => el('label', {}, el('input', { type: 'checkbox', checked: true, value: i }), b.title || `Bank ${b.id}`))
          : ['No banks found in this course.']));
        ui.toggleAll.textContent = 'Select none';
        log(`Loaded ${banks.length} bank(s).`);
      } catch (e) {
        log('Could not load banks: ' + e.message);
      } finally {
        setBusy(false);
      }
    }

    function toggleAllBanks() {
      const boxes = [...ui.banks.querySelectorAll('input[type=checkbox]')];
      const anyChecked = boxes.some(b => b.checked);
      boxes.forEach(b => { b.checked = !anyChecked; });
      ui.toggleAll.textContent = anyChecked ? 'Select all' : 'Select none';
      syncControls();
    }

    function runAction() {
      const mode = ui.target.value;
      return mode === 'review' ? removeShares() : shareBanks(mode);
    }

    async function shareBanks(mode) {
      const selected = checkedBanks();
      if (!selected.length) return;
      const permission = ui.perm.value;
      setBusy(true);
      try {
        if (mode === 'course') await shareWithCourse(selected, permission);
        else await shareWithPerson(selected, permission);
      } catch (e) {
        log('Sharing stopped: ' + e.message);
      } finally {
        setBusy(false);
      }
    }

    async function applyShares(selected, entityType, matchIds, postId, permission) {
      const label = PERM_LABEL[permission];
      const counts = { added: 0, changed: 0, unchanged: 0, failed: 0 };
      for (const [i, b] of selected.entries()) {
        const name = bankName(b);
        let wrote = true;
        try {
          const { result, status } = await shareApi.upsert(b, entityType, matchIds, postId, permission);
          counts[result]++;
          wrote = result !== 'unchanged';
          log({
            added: `✅ ${name} (shared, ${label})`,
            changed: `🔁 ${name} (changed to ${label})`,
            unchanged: `➖ ${name} (already ${label})`,
            failed: `❌ ${name} (${status})`,
          }[result]);
        } catch (e) {
          counts.failed++;
          log(`❌ ${name} (${e.message})`);
        }
        // Pause only after a write, and not after the last bank.
        if (wrote && i < selected.length - 1) await sleep(PAUSE_WRITE_MS);
      }
      log(`Done: ${counts.added} shared, ${counts.changed} changed, ${counts.unchanged} already set` +
          (counts.failed ? `, ${counts.failed} failed.` : '.'));
    }

    async function shareWithPerson(selected, permission) {
      const u = people[Number(ui.person.value)];
      if (!u) return;
      const label = PERM_LABEL[permission];
      if (!confirm(`Share ${selected.length} bank(s) with ${u.name} (${label})?\n\n` +
                   `Banks already shared with ${u.name} will be switched to ${label}.`)) return;
      const user = { uuid: u.uuid, full_name: u.name, email: u.email, avatar_image_url: u.avatar_url };
      const reg = await quizFetch('lti', '/users', { method: 'POST', body: user });
      log(`Registered ${u.name} with item banks (${reg.status}).`);
      await applyShares(selected, 'user', [user.uuid], user.uuid, permission);
    }

    async function shareWithCourse(selected, permission) {
      const bankCourse = bankCourseId();
      if (!bankCourse) throw new Error('bank course not detected; reload the Item Banks page');
      const course = await courseInfo();
      if (!course.uuid) throw new Error("couldn't look up this course in Canvas");
      const label = PERM_LABEL[permission];
      if (!confirm(`Share ${selected.length} bank(s) with the course "${course.name}" (${label})?\n\n` +
                   `Banks already shared with this course will be switched to ${label}.`)) return;
      await applyShares(selected, 'course', [bankCourse, course.uuid], course.uuid, permission);
    }

    async function scanShares() {
      const selected = checkedBanks();
      if (!selected.length) return log('Check at least one bank to scan.');
      setBusy(true);
      groups = [];
      ui.shares.replaceChildren('Scanning…');
      try {
        const bankCourse = bankCourseId();
        const [self, thisCourse] = await Promise.all([whoAmI(), courseInfo().catch(() => ({}))]);
        const isThisCourse = id => id === bankCourse || (!!thisCourse.uuid && id === thisCourse.uuid);

        // Reads run a few at a time; results keep bank order.
        let done = 0;
        const lists = await mapLimit(selected, SCAN_CONCURRENCY, async b => {
          try {
            return await shareApi.list(b.id);
          } catch (e) {
            log(`❌ Couldn't scan ${bankName(b)} (${e.message})`);
            return [];
          } finally {
            if (++done % 10 === 0) ui.shares.replaceChildren(`Scanning… ${done} of ${selected.length} banks`);
          }
        });

        const byEntity = new Map();
        selected.forEach((b, i) => {
          for (const s of lists[i]) {
            if (s.permission === REMOVED) continue;
            const id = s.entity_type === 'course' && thisCourse.uuid && s.entity_id === thisCourse.uuid
              ? (bankCourse || s.entity_id) : s.entity_id;
            const key = `${s.entity_type}:${id}`;
            if (!byEntity.has(key)) byEntity.set(key, { type: s.entity_type, id, shares: [] });
            byEntity.get(key).shares.push({ ...s, bankTitle: bankName(b) });
          }
        });
        groups = [...byEntity.values()];

        ui.shares.replaceChildren('Looking up names…');
        const idsOf = type => groups.filter(g => g.type === type).map(g => g.id);
        const [users, courses] = await Promise.all([
          lookupNames('users', idsOf('user')),
          lookupNames('contexts?context_type=Course', idsOf('course')),
        ]);
        if (groups.some(g => g.type === 'user' && !users[g.id])) {
          try {
            for (const [uuid, info] of Object.entries(await rosterByUuid())) users[uuid] ??= info;
          } catch { /* names stay unknown */ }
        }

        for (const g of groups) {
          const info = g.type === 'user' ? users[g.id] : courses[g.id];
          let name = g.type === 'user' ? info?.full_name : info?.title;
          if (g.type === 'course' && isThisCourse(g.id)) name = `${name || thisCourse.name || 'This course'} (this course)`;
          g.name = name || `Unknown (${String(g.id).slice(0, 8)}…)`;
          const email = (info?.email || '').toLowerCase();
          g.isSelf = g.type === 'user' &&
            ((!!self.uuid && g.id === self.uuid) || (!!self.email && email === self.email));
        }
        groups.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'course' ? -1 : 1));

        ui.shares.replaceChildren(...(groups.length ? groups.map(renderGroup) : ['No one else has access to the checked banks.']));
        log(`Scanned ${selected.length} bank(s): ${groups.length} person/course share(s) found.`);
      } catch (e) {
        ui.shares.replaceChildren('Scan failed.');
        log('Scan failed: ' + e.message);
      } finally {
        setBusy(false);
      }
    }

    function renderGroup(g, i) {
      const n = g.shares.length;
      const perms = [...new Set(g.shares.map(s => PERM_LABEL[s.permission] || s.permission))].join(' / ');
      const kind = g.type === 'course' ? 'Course' : 'Person';
      return el('label', { title: g.shares.map(s => s.bankTitle).join('\n') },
        el('input', { type: 'checkbox', value: i, disabled: g.isSelf }),
        el('span', {},
          el('strong', { textContent: g.name + (g.isSelf ? ' (you)' : '') }),
          el('span', { className: 'cbt-sub', textContent:
            `${kind}, ${n} bank${plural(n)}, ${perms}${g.isSelf ? '. Your own access can’t be removed here.' : ''}` })));
    }

    async function removeShares() {
      const keep = new Set(checkedBanks().map(b => String(b.id)));
      const chosen = checkedGroups().filter(g => !g.isSelf);
      const jobs = chosen.flatMap(g => g.shares.filter(s => keep.has(String(s.bank_id))).map(s => ({ g, s })));
      if (!jobs.length) return log('Nothing to remove: none of the chosen shares are on checked banks.');

      const perGroup = new Map();
      jobs.forEach(({ g }) => perGroup.set(g, (perGroup.get(g) || 0) + 1));
      const summary = [...perGroup].map(([g, n]) => `• ${g.name}: ${n} bank${plural(n)}`).join('\n');
      if (!confirm(`Remove access?\n\n${summary}\n\nThis can be undone by sharing again.`)) return;

      setBusy(true);
      let ok = 0, failed = 0;
      try {
        await paced(jobs, PAUSE_WRITE_MS, async ({ g, s }) => {
          const r = await shareApi.update(s.bank_id, s.id, REMOVED);
          if (r.ok) ok++;
          else failed++;
          log(`${r.ok ? '🗑️' : '❌'} ${g.name} removed from ${s.bankTitle}${r.ok ? '' : ` (${r.status})`}`);
        });
        log(`Done: ${ok} removed${failed ? `, ${failed} failed` : ''}. Rescanning to confirm…`);
      } catch (e) {
        log('Removal stopped: ' + e.message);
      } finally {
        setBusy(false);
      }
      // Rescan instead of trusting the responses: revoking access is worth verifying.
      await scanShares();
    }

    return {
      name: 'Item Bank Sharing',
      matches: path => PAGE_RE.test(path),
      early: installCapture,
      init: buildUI,
    };
  }

  // ==================================================================
  // 6. Feature: Modules Batch Edit
  // ==================================================================
  function createModulesBatchEditFeature() {
    const PAGE_RE = /^\/courses\/\d+(\/modules)?\/?$/;
    const MAX_INDENT = 5;
    const PAUSE_MS = 200;
    const LOAD_CONCURRENCY = 4;

    const SEL = {
      page: '#context_modules',
      toolbarAnchor: '.add_module_link',
      editorOnly: '.add_module_link, .ig-admin',
      module: id => document.getElementById(`context_module_${id}`),
      moduleHeader: '.ig-header',
      item: id => document.getElementById(`context_module_item_${id}`),
      itemPrefix: 'context_module_item_',
      anyItem: 'li[id^="context_module_item_"]',
      itemRow: '.ig-row',
      dragHandle: '.ig-handle',
      rowPassThrough: '.ig-handle, .ig-admin, button, input, select, textarea',
    };

    const state = { modules: [], unpublishable: {}, canEdit: true, order: [], index: new Map() };
    const selected = new Set();

    const indentOf = item => Number(item.indent) || 0;
    const itemPath = item => `/api/v1/courses/${courseId()}/modules/${item.module_id}/items/${item.id}`;
    const updateItem = (item, fields) => canvas.request('PUT', itemPath(item), { module_item: fields });
    const moduleById = id => state.modules.find(m => String(m.id) === String(id));

    // Each action: plan(item, module) → { skip } | { change }, run(item) → Response.
    // Or planAll(picked, values) for actions that plan the whole selection at once.
    // Optional prepare(picked) loads anything plan() needs before the preview opens.
    const ACTIONS = [
      {
        id: 'move', enabled: true,
        short: 'Move', icon: 'icon-updown',
        label: 'Move', button: 'Move', done: 'moved',
        note: 'Moved items keep their indent and stay in the order they appear on the page.',
        collapseDetails: true,
        controls: moveControls,
        planAll: planMove,
      },
      {
        id: 'indent-in', enabled: true,
        short: 'Indent', icon: 'icon-indent',
        label: 'Increase indent', button: 'Indent', done: 'indented',
        plan: item => indentOf(item) >= MAX_INDENT
          ? { skip: `already at the maximum indent (${MAX_INDENT})` }
          : { change: `indent ${indentOf(item)} → ${indentOf(item) + 1}` },
        run: item => updateItem(item, { indent: Math.min(MAX_INDENT, indentOf(item) + 1) }),
      },
      {
        id: 'indent-out', enabled: true,
        short: 'Outdent', icon: 'icon-outdent',
        label: 'Decrease indent', button: 'Outdent', done: 'outdented',
        plan: item => indentOf(item) <= 0
          ? { skip: 'already at no indent' }
          : { change: `indent ${indentOf(item)} → ${indentOf(item) - 1}` },
        run: item => updateItem(item, { indent: Math.max(0, indentOf(item) - 1) }),
      },
      {
        id: 'publish', enabled: true,
        short: 'Publish', icon: 'icon-publish',
        label: 'Publish', button: 'Publish', done: 'published',
        note: 'Publishing a module item also publishes the assignment, quiz, page, or discussion it points to.',
        plan: (item, module) => {
          if (item.published === undefined) return { skip: "can't be published from Modules" };
          if (item.published) return { skip: 'already published' };
          return { change: module.published === false
            ? 'publish (the module itself is still unpublished, so students won’t see it yet)'
            : 'publish' };
        },
        run: item => updateItem(item, { published: true }),
      },
      {
        id: 'unpublish', enabled: true,
        short: 'Unpublish', icon: 'icon-unpublish',
        label: 'Unpublish', button: 'Unpublish', done: 'unpublished',
        note: 'Unpublishing a module item also unpublishes the assignment, quiz, page, or discussion it points to.',
        prepare: loadUnpublishable,
        plan: item => {
          if (item.published === undefined) return { skip: "can't be unpublished from Modules" };
          if (!item.published) return { skip: 'already unpublished' };
          const why = cantUnpublish(item);
          return why ? { skip: `can't be unpublished: ${why}` } : { change: 'unpublish' };
        },
        run: item => updateItem(item, { published: false }),
      },
      {
        id: 'remove', enabled: true, danger: true,
        short: 'Remove', icon: 'icon-trash',
        label: 'Remove from module', button: 'Remove', done: 'removed',
        note: 'This only takes items off the Modules page. The assignments, quizzes, pages, and files stay in the course.',
        plan: () => ({ change: 'remove from module' }),
        run: item => canvas.request('DELETE', itemPath(item)),
      },
    ].filter(a => a.enabled);

    function cantUnpublish(item) {
      const map = state.unpublishable[item.type];
      if (!map || map.get(String(item.content_id)) !== false) return null;
      return item.type === 'Discussion' ? 'students have replied' : 'students have submitted';
    }

    // Loads "can this be unpublished?" only for the published items being unpublished.
    // Assignments are fetched by id; quizzes and discussions (no id filter in the API)
    // only if the selection contains one. A failed lookup just means Canvas decides.
    async function loadUnpublishable(picked) {
      const cid = courseId();
      const u = state.unpublishable;
      const items = picked.map(r => r.item).filter(i => i.published);
      const missing = type => [...new Set(items.filter(i => i.type === type).map(i => String(i.content_id)))]
        .filter(id => !u[type]?.has(id));

      async function loadInto(type, field, paths) {
        const map = (u[type] ??= new Map());
        for (const path of paths) {
          try {
            for (const x of await canvas.getAll(path)) map.set(String(x.id), x[field]);
          } catch (e) {
            debug('unpublish check failed', path, e);
          }
        }
      }

      const assignmentIds = missing('Assignment');
      await Promise.all([
        assignmentIds.length && loadInto('Assignment', 'unpublishable', chunk(assignmentIds, 50).map(ids =>
          `/api/v1/courses/${cid}/assignments?${ids.map(id => `assignment_ids[]=${encodeURIComponent(id)}`).join('&')}`)),
        missing('Quiz').length && loadInto('Quiz', 'unpublishable', [`/api/v1/courses/${cid}/quizzes`]),
        missing('Discussion').length && loadInto('Discussion', 'can_unpublish', [`/api/v1/courses/${cid}/discussion_topics`]),
      ]);
    }

    // ---- Move picker ----
    const ITEM_ICONS = {
      Assignment: 'icon-assignment', Quiz: 'icon-quiz', Discussion: 'icon-discussion',
      Page: 'icon-document', File: 'icon-paperclip', ExternalUrl: 'icon-link', ExternalTool: 'icon-link',
    };

    function moveControls(picked) {
      const n = picked.length;
      const moving = new Set(picked.map(r => String(r.item.id)));
      const expanded = new Set(picked.map(r => String(r.module.id)));
      const listeners = [];
      let choice = null;

      const tree = el('div', { className: 'cbt-mod-tree' });
      const isChosen = (moduleId, where) => choice?.moduleId === moduleId && choice.where === where;
      const marker = () => el('div', { className: 'cbt-mod-tree-marker', textContent: `${n} item${plural(n)} will go here` });

      function choose(moduleId, where) {
        choice = { moduleId, where };
        expanded.add(moduleId);
        draw();
        tree.querySelector('.cbt-mod-tree-marker')?.scrollIntoView({ block: 'nearest' });
        listeners.forEach(fn => fn());
      }

      function toggleModule(moduleId) {
        if (expanded.has(moduleId)) expanded.delete(moduleId);
        else expanded.add(moduleId);
        draw();
      }

      function destination({ key, label, chosen, onClick, className = '', style = '' }, ...content) {
        const b = el('button', { type: 'button', className: `cbt-mod-tree-dest ${className}${chosen ? ' cbt-chosen' : ''}`,
          title: label, ariaLabel: label, style }, ...content);
        b.dataset.key = key;
        b.setAttribute('aria-pressed', String(chosen));
        b.addEventListener('click', onClick);
        return b;
      }

      function itemRows(m, item) {
        const moduleId = String(m.id);
        const id = String(item.id);
        const where = `after:${id}`;
        const style = `padding-left: ${44 + indentOf(item) * 20}px`;
        const icon = el('i', { className: ITEM_ICONS[item.type] || '', ariaHidden: 'true' });
        const title = el('span', { className: 'cbt-mod-tree-title', textContent: item.title });

        if (moving.has(id)) {
          return [el('div', { className: 'cbt-mod-tree-item cbt-mod-tree-moving', style },
            icon, title, el('span', { className: 'cbt-mod-tree-tag', textContent: 'moving' }))];
        }
        const chosen = isChosen(moduleId, where);
        const row = destination({
          key: `i${id}`,
          label: `Move after ${item.title}`,
          chosen,
          onClick: () => choose(moduleId, where),
          className: 'cbt-mod-tree-item' + (item.type === 'SubHeader' ? ' cbt-mod-tree-subheader' : ''),
          style,
        }, icon, title);
        return chosen ? [row, marker()] : [row];
      }

      function draw() {
        const focusKey = tree.contains(document.activeElement) ? document.activeElement.dataset.key : null;
        tree.replaceChildren(...state.modules.map(m => {
          const moduleId = String(m.id);
          const open = expanded.has(moduleId);
          const toggle = el('button', { type: 'button', className: 'cbt-mod-tree-toggle',
            ariaExpanded: String(open), ariaLabel: `${open ? 'Collapse' : 'Expand'} ${m.name}` },
            el('i', { className: open ? 'icon-mini-arrow-down' : 'icon-mini-arrow-right', ariaHidden: 'true' }));
          toggle.dataset.key = `t${moduleId}`;
          toggle.addEventListener('click', () => toggleModule(moduleId));

          const topChosen = isChosen(moduleId, 'top');
          return el('div', { className: 'cbt-mod-tree-module' },
            el('div', { className: 'cbt-mod-tree-head' + (topChosen ? ' cbt-chosen' : '') }, toggle,
              destination({
                key: `m${moduleId}`,
                label: `Move to the top of ${m.name}`,
                chosen: topChosen,
                onClick: () => choose(moduleId, 'top'),
              }, el('span', { className: 'cbt-mod-tree-title', textContent: m.name }))),
            topChosen ? marker() : '',
            ...(open ? m.items.flatMap(item => itemRows(m, item)) : []),
            open && !m.items.length ? el('div', { className: 'cbt-mod-tree-empty', textContent: 'No items yet' }) : '');
        }));
        if (focusKey) tree.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
      }
      draw();

      return {
        node: el('div', {},
          el('p', { className: 'cbt-hint', textContent: `Move ${n} item${plural(n)} to the top of a module, or right after an item:` }),
          tree),
        focus: tree.querySelector('.cbt-mod-tree-dest'),
        values: () => choice || {},
        onChange: fn => listeners.push(fn),
      };
    }

    // Plans a move as the fewest single-item PUTs: items already in the right
    // relative spot are skipped, and each run() places its item after the last
    // settled neighbour, tracking every list locally as it goes.
    function planMove(picked, { moduleId, where }) {
      const dest = moduleById(moduleId);
      if (!dest || !where) return { pending: 'Click where the items should go.' };
      const destId = String(dest.id);
      const sequence = picked.map(r => String(r.item.id));
      const moving = new Set(sequence);

      const current = dest.items.map(i => String(i.id));
      const staying = current.filter(id => !moving.has(id));
      const at = where === 'top' ? 0 : staying.indexOf(where.slice('after:'.length)) + 1;
      const target = [...staying.slice(0, at), ...sequence, ...staying.slice(at)];
      const pos = new Map(target.map((id, i) => [id, i]));

      let head = 0;
      while (head < current.length && current[head] === target[head]) head++;
      let tail = 0;
      while (tail < current.length - head &&
             current[current.length - 1 - tail] === target[target.length - 1 - tail]) tail++;
      const inPlace = id => pos.get(id) < head || pos.get(id) >= target.length - tail;

      const lists = new Map(state.modules.map(m => [String(m.id), m.items.map(i => String(i.id))]));
      const home = new Map(state.modules.flatMap(m => m.items.map(i => [String(i.id), String(m.id)])));
      const settled = new Set(sequence.filter(inPlace));
      const predecessor = id => {
        for (let j = pos.get(id) - 1; j >= 0; j--) {
          if (!moving.has(target[j]) || settled.has(target[j])) return target[j];
        }
        return null;
      };

      const change = [], skip = [];
      for (const { item, module } of picked) {
        const id = String(item.id);
        const row = { item, module, title: item.title };
        const spot = `position ${pos.get(id) + 1}`;
        if (settled.has(id)) {
          skip.push({ ...row, text: `already at ${spot}` });
          continue;
        }
        change.push({
          ...row,
          text: String(module.id) === destId ? `move to ${spot}` : `move to ${dest.name}, ${spot}`,
          run: async () => {
            const fromId = home.get(id);
            const from = lists.get(fromId).filter(x => x !== id);
            const to = fromId === destId ? from : [...lists.get(destId)];
            const pred = predecessor(id);
            const index = pred === null ? 0 : to.indexOf(pred) + 1;
            to.splice(index, 0, id);
            const res = await updateItem(item, { module_id: dest.id, position: index + 1 });
            if (res.ok) {
              lists.set(fromId, from);
              lists.set(destId, to);
              home.set(id, destId);
              settled.add(id);
            }
            return res;
          },
        });
      }
      return { change, skip };
    }

    // ---- Data ----
    // Modules come back with items inline; only modules Canvas deems too big are fetched separately.
    async function loadCourse() {
      const cid = courseId();
      const modules = await canvas.getAll(`/api/v1/courses/${cid}/modules?include[]=items`);
      await mapLimit(modules.filter(m => !Array.isArray(m.items)), LOAD_CONCURRENCY, async m => {
        m.items = await canvas.getAll(`/api/v1/courses/${cid}/modules/${m.id}/items`);
      });

      const items = modules.flatMap(m => m.items);
      state.canEdit = !items.length || items.some(i => 'published' in i);
      state.modules = modules;
      state.unpublishable = {};
      state.order = items.map(i => String(i.id));
      state.index = new Map(state.order.map((id, i) => [id, i]));

      for (const id of selected) if (!state.index.has(id)) selected.delete(id);
    }

    const store = sessionStore('cbt-modules');

    // ---- UI ----
    const ui = {};
    let bulkOn = false;
    let loaded = false;
    let busy = false;
    let stopRequested = false;
    let lastClicked = null;
    let observer = null;
    let outside = null;
    let session = 0;
    let decorateQueued = false;

    function buildUI() {
      ui.batch = launchMenu('cbt-mod-toggle', 'Batch Edit', [
        { label: 'Edit items', hint: 'Select items to move, indent, publish, or remove', onSelect: () => enterBulk() },
        { label: 'Rename modules…', hint: 'Rename every module at once', onSelect: showRename },
      ]);
      const anchor = document.querySelector(SEL.toolbarAnchor);
      if (anchor) launch.dock(ui.batch.button, anchor);
      else launch.float(ui.batch.button);

      ui.selAll = el('input', { type: 'checkbox', className: 'cbt-mod-check' });
      ui.selAll.addEventListener('change', () => {
        if (ui.selAll.checked) state.order.forEach(id => selected.add(id));
        else selected.clear();
        sync();
      });
      ui.tools = ACTIONS.map(a => {
        const b = el('button', { type: 'button', className: 'cbt-mod-tool' + (a.danger ? ' cbt-danger' : '') },
          el('i', { className: a.icon || '', ariaHidden: 'true' }),
          el('span', { textContent: a.short }));
        b.addEventListener('click', () => showPreview(a));
        return b;
      });
      ui.count = el('span', { className: 'cbt-mod-count' });
      ui.exit = el('button', { type: 'button', className: 'cbt-mod-x', textContent: '×',
        title: 'Exit Bulk Edit', ariaLabel: 'Exit Bulk Edit' });
      ui.exit.addEventListener('click', exitBulk);
      ui.notice = el('div', { className: 'cbt-mod-notice', hidden: true, role: 'status' });
      ui.bar = el('div', { id: 'cbt-mod-bar', className: 'cbt', hidden: true, role: 'region', ariaLabel: 'Bulk Edit' },
        ui.notice,
        el('div', { className: 'cbt-mod-main' },
          el('label', { className: 'cbt-mod-selall' }, ui.selAll, 'Select all'),
          el('div', { className: 'cbt-mod-tools', role: 'group' }, ...ui.tools),
          ui.count,
          ui.exit));

      document.body.append(ui.bar);
      ui.dialog = modal('cbt-mod-dialog');
    }

    async function enterBulk(saved) {
      const mine = ++session;
      bulkOn = true;
      document.body.classList.add('cbt-mod-on');
      ui.batch.setOverride({ label: 'Exit Bulk Edit', onClick: exitBulk });
      ui.bar.hidden = false;
      (saved?.selected || []).forEach(id => selected.add(String(id)));

      busy = true;
      sync('Loading modules…');
      try {
        await loadCourse();
      } catch (e) {
        if (mine !== session) return;
        busy = false;
        sync('Could not load modules: ' + e.message, true);
        return;
      }
      if (mine !== session) return; // exited (or re-entered) while loading
      busy = false;
      loaded = true;

      decorate();
      observer = new MutationObserver(queueDecorate);
      ui.page = document.querySelector(SEL.page);
      observer.observe(ui.page, { childList: true, subtree: true });

      ui.page.addEventListener('click', onRowClick, true);
      if (!state.canEdit) sync("You don't have permission to edit these modules.", true);
      ui.selAll.focus();
    }

    function exitBulk() {
      session++;
      bulkOn = false;
      loaded = false;
      busy = false;
      observer?.disconnect();
      observer = null;
      ui.page?.removeEventListener('click', onRowClick, true);
      document.body.classList.remove('cbt-mod-on');
      document.querySelectorAll('.cbt-mod-check.cbt-mod-injected').forEach(cb => cb.remove());
      document.querySelectorAll('li.cbt-mod-selected').forEach(li => li.classList.remove('cbt-mod-selected'));
      document.querySelectorAll('.cbt-mod-has-outside').forEach(n => n.classList.remove('cbt-mod-has-outside'));
      outside = null;
      selected.clear();
      lastClicked = null;
      ui.bar.hidden = true;
      ui.notice.hidden = true;
      ui.batch.setOverride(null);
      store.clear();
    }

    // Coalesces page mutations into one pass per frame, and ignores the
    // mutations our own checkbox insertions cause.
    function queueDecorate(records) {
      const ours = records.every(r => !r.removedNodes.length &&
        [...r.addedNodes].every(n => n.classList?.contains('cbt-mod-check')));
      if (ours || decorateQueued) return;
      decorateQueued = true;
      requestAnimationFrame(() => { decorateQueued = false; decorate(); });
    }

    function pageCheckbox(label) {
      const cb = el('input', { type: 'checkbox', className: 'cbt-mod-check cbt-mod-injected', ariaLabel: label });
      // Keep Canvas's own row handlers (drag, open item) from seeing these clicks.
      ['click', 'mousedown', 'pointerdown'].forEach(t => cb.addEventListener(t, e => e.stopPropagation()));
      return cb;
    }

    function decorate() {
      if (!bulkOn || !loaded) return;
      let added = false;
      for (const m of state.modules) {
        for (const item of m.items) {
          const li = SEL.item(item.id);
          if (!li || li.querySelector('.cbt-mod-check[data-id]')) continue;
          if (outside === null) outside = roomOutside(li, SEL.module(m.id) || li);
          const id = String(item.id);
          const cb = pageCheckbox(`Select ${item.title}`);
          cb.dataset.id = id;
          cb.addEventListener('click', e => toggleItem(id, cb.checked, e.shiftKey));
          if (outside) placeOutside(cb, li);
          else {
            const row = li.querySelector(SEL.itemRow) || li;
            const handle = row.querySelector(SEL.dragHandle);
            if (handle) handle.after(cb);
            else row.prepend(cb);
          }
          added = true;
        }
      }

      for (const m of state.modules) {
        const head = SEL.module(m.id)?.querySelector(SEL.moduleHeader);
        if (!head || head.querySelector(':scope > .cbt-mod-check')) continue;
        const cb = pageCheckbox(`Select all items in ${m.name}`);
        cb.dataset.mod = m.id;
        cb.disabled = !m.items.length;
        cb.addEventListener('change', () => {
          for (const i of m.items) {
            if (cb.checked) selected.add(String(i.id));
            else selected.delete(String(i.id));
          }
          sync();
        });
        if (outside) placeOutside(cb, head);
        else head.prepend(cb);
        added = true;
      }

      if (added) alignModuleChecks();
      sync();
    }

    function placeOutside(cb, container) {
      cb.classList.add('cbt-mod-outside');
      container.classList.add('cbt-mod-has-outside');
      container.append(cb);
    }

    // Lines module checkboxes up with item checkboxes. All writes happen after
    // all reads, so this forces one layout instead of one per module.
    function alignModuleChecks() {
      const ref = [...document.querySelectorAll('.cbt-mod-check[data-id]')].find(cb => cb.offsetWidth > 0);
      if (!ref) return;
      const boxes = [...document.querySelectorAll('.cbt-mod-check[data-mod]')];
      if (!outside) boxes.forEach(cb => { cb.style.marginLeft = ''; });
      const x = ref.getBoundingClientRect().left;
      const moves = boxes.map(cb => (outside
        ? ['left', x - cb.parentElement.getBoundingClientRect().left]
        : ['marginLeft', Math.max(0, parseFloat(getComputedStyle(cb).marginLeft) + x - cb.getBoundingClientRect().left)]));
      boxes.forEach((cb, i) => { cb.style[moves[i][0]] = `${moves[i][1]}px`; });
    }

    // True when there's visible room to the left of the module box for the checkboxes.
    function roomOutside(li, moduleEl) {
      const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cbt-outside-gap')) || 30;
      const x = moduleEl.getBoundingClientRect().left - gap;
      if (x < 4) return false;
      for (let n = li.parentElement; n && n !== document.documentElement; n = n.parentElement) {
        if (getComputedStyle(n).overflowX === 'visible') continue;
        if (n === moduleEl || moduleEl.contains(n)) return false;
        if (n.getBoundingClientRect().left > x) return false;
      }
      return true;
    }

    function toggleItem(id, on, extendRange) {
      if (extendRange && lastClicked !== null) {
        const a = state.index.get(lastClicked);
        const b = state.index.get(id);
        if (a !== undefined && b !== undefined) {
          for (const x of state.order.slice(Math.min(a, b), Math.max(a, b) + 1)) {
            if (on) selected.add(x);
            else selected.delete(x);
          }
        }
      }
      if (on) selected.add(id);
      else selected.delete(id);
      lastClicked = id;
      sync();
    }

    function onRowClick(e) {
      if (busy || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
      const li = e.target.closest(SEL.anyItem);
      if (!li || e.target.closest(SEL.rowPassThrough)) return;
      const id = li.id.slice(SEL.itemPrefix.length);
      if (!state.index.has(id)) return;
      e.preventDefault();
      e.stopPropagation();
      toggleItem(id, !selected.has(id), e.shiftKey);
    }

    function sync(message, warn) {
      document.querySelectorAll('.cbt-mod-check[data-id]').forEach(cb => {
        const on = selected.has(cb.dataset.id);
        cb.checked = on;
        cb.closest(SEL.anyItem)?.classList.toggle('cbt-mod-selected', on);
      });
      for (const m of state.modules) {
        const box = SEL.module(m.id)?.querySelector('.cbt-mod-check[data-mod]');
        if (!box) continue;
        const n = m.items.reduce((sum, i) => sum + selected.has(String(i.id)), 0);
        box.checked = n > 0 && n === m.items.length;
        box.indeterminate = n > 0 && n < m.items.length;
      }

      const total = state.order.length;
      ui.selAll.checked = total > 0 && selected.size === total;
      ui.selAll.indeterminate = selected.size > 0 && selected.size < total;
      ui.selAll.disabled = busy || !total;
      ui.tools.forEach(b => { b.disabled = busy || !selected.size || !state.canEdit; });

      if (message !== undefined) {
        ui.count.textContent = message;
        ui.count.classList.toggle('cbt-warn', !!warn);
      } else if (!busy && state.canEdit) {
        ui.count.textContent = `${selected.size} selected`;
        ui.count.classList.remove('cbt-warn');
      }
    }

    const planList = rows => el('ul', { className: 'cbt-list' }, ...rows.map(r => el('li', {},
      el('span', { textContent: r.title }),
      el('span', { className: 'cbt-sub', textContent: `${r.module} · ${r.text}` }))));

    const selectedRows = () => state.modules.flatMap(module =>
      module.items.filter(i => selected.has(String(i.id))).map(item => ({ item, module })));

    function planAction(action, picked, values) {
      if (action.planAll) return action.planAll(picked, values);
      const change = [], skip = [];
      for (const { item, module } of picked) {
        const p = action.plan(item, module);
        const row = { item, module, title: item.title, text: p.skip || p.change };
        if (p.skip) skip.push(row);
        else change.push({ ...row, run: () => action.run(item, module) });
      }
      return { change, skip };
    }

    async function showPreview(action) {
      const picked = selectedRows();
      if (action.prepare) {
        busy = true;
        sync('Checking items…');
        try { await action.prepare(picked); } finally { busy = false; sync(); }
      }
      const controls = action.controls?.(picked);
      const rows = list => planList(list.map(r => ({ ...r, module: r.module.name })));
      const heading = el('h2');
      const body = el('div');
      let plan;
      const confirmBtn = btn(action.button, () => apply(action, plan.change, plan.skip),
        'cbt-primary' + (action.danger ? ' cbt-danger' : ''));
      const cancelBtn = btn('Cancel', () => ui.dialog.close());

      function render() {
        plan = planAction(action, picked, controls?.values());
        const { change = [], skip = [], pending } = plan;
        const n = change.length;
        const total = pending ? picked.length : n;
        heading.textContent = total ? `${action.label}: ${total} item${plural(total)}` : 'Nothing to change';
        confirmBtn.textContent = n ? `${action.button} ${n} item${plural(n)}` : action.button;
        confirmBtn.disabled = !n;
        const lists = [
          n ? rows(change) : '',
          skip.length ? el('h3', { textContent: `Skipped (${skip.length})` }) : '',
          skip.length ? rows(skip) : '',
        ];
        body.replaceChildren(
          pending ? el('p', { className: 'cbt-hint', textContent: pending }) : '',
          !pending && !n ? el('p', { className: 'cbt-hint', textContent: `None of the selected items can be changed with ${action.label}.` }) : '',
          action.note && n ? el('p', { className: 'cbt-hint', textContent: action.note }) : '',
          ...(action.collapseDetails && (n || skip.length)
            ? [el('details', { className: 'cbt-mod-details' },
                el('summary', { textContent: `Show each item (${n + skip.length})` }), ...lists)]
            : lists));
      }
      controls?.onChange(render);
      render();

      ui.dialog.show(heading, controls?.node || '', body, el('div', { className: 'cbt-actions' }, cancelBtn, confirmBtn));
      (controls?.focus || cancelBtn).focus();
    }

    async function apply(action, change, skip) {
      stopRequested = false;
      busy = true;
      sync('Working…');

      const progress = el('progress', { max: change.length, value: 0 });
      const status = el('p', { className: 'cbt-hint', role: 'status' });
      const stopBtn = btn('Stop', () => {
        stopRequested = true;
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping…';
      });
      ui.dialog.show(el('h2', { textContent: `${action.label}…` }), progress, status,
        el('div', { className: 'cbt-actions' }, stopBtn));
      stopBtn.focus();

      let ok = 0, done = 0;
      const failed = [];
      job.start();
      try {
        await paced(change, PAUSE_MS, async r => {
          if (stopRequested) return false;
          status.textContent = `${done} of ${change.length} done`;
          try {
            const res = await r.run();
            if (res.ok) ok++;
            else failed.push({ title: r.title, module: r.module.name, text: await canvas.errorText(res) });
          } catch (e) {
            failed.push({ title: r.title, module: r.module.name, text: e.message });
          }
          progress.value = ++done;
        });
      } finally {
        job.end();
      }

      const parts = [`${ok} ${action.done}`];
      if (failed.length) parts.push(`${failed.length} failed`);
      if (skip.length) parts.push(`${skip.length} skipped`);
      if (done < change.length) parts.push(`${change.length - done} not attempted`);
      const notice = { text: `${stopRequested ? 'Stopped' : 'Done'}: ${parts.join(', ')}.`, failed };

      // Reload so the page shows Canvas's real state; the notice and selection survive it.
      if (ok && store.write({ selected: [...selected], notice })) return location.reload();

      busy = false;
      sync();
      const closeBtn = btn(ok ? 'Reload page' : 'OK', () => (ok ? location.reload() : ui.dialog.close()), 'cbt-primary');
      ui.dialog.show(
        el('h2', { textContent: notice.text }),
        failed.length ? el('h3', { textContent: "These couldn't be changed:" }) : '',
        failed.length ? planList(failed) : '',
        el('div', { className: 'cbt-actions' }, closeBtn));
      closeBtn.focus();
    }

    function showNotice(notice) {
      const dismiss = el('button', { type: 'button', className: 'cbt-mod-x', textContent: '×',
        title: 'Dismiss', ariaLabel: 'Dismiss' });
      dismiss.addEventListener('click', () => { ui.notice.hidden = true; });
      const n = notice.failed?.length || 0;
      ui.notice.replaceChildren(
        el('div', {},
          el('strong', { textContent: notice.text }),
          n ? el('details', {},
            el('summary', { textContent: `${n} item${plural(n)} couldn't be changed` }),
            planList(notice.failed)) : ''),
        dismiss);
      ui.notice.hidden = false;
    }

    // ---- Rename modules ----
    async function showRename() {
      const title = () => el('h2', { textContent: 'Rename modules' });
      ui.dialog.show(title(), el('progress'), el('p', { className: 'cbt-hint', textContent: 'Loading modules…' }),
        el('div', { className: 'cbt-actions' }, btn('Cancel', () => ui.dialog.close())));
      let modules;
      try {
        modules = await canvas.getAll(`/api/v1/courses/${courseId()}/modules`);
      } catch (e) {
        if (ui.dialog.open) ui.dialog.show(title(), el('p', { textContent: `Couldn't load modules: ${e.message}.` }),
          el('div', { className: 'cbt-actions' }, btn('Close', () => ui.dialog.close(), 'cbt-primary')));
        return;
      }
      if (!ui.dialog.open) return;

      const rows = modules.map((m, i) => {
        const input = el('input', { type: 'text', value: m.name, ariaLabel: `Name for module ${i + 1}` });
        const was = el('span', { className: 'cbt-sub cbt-rename-was', textContent: `Was: ${m.name}` });
        const row = el('li', { className: 'cbt-rename-row' },
          el('span', { className: 'cbt-rename-num', textContent: i + 1 }),
          el('div', { className: 'cbt-rename-field' }, input, was));
        input.addEventListener('input', refresh);
        input.addEventListener('keydown', e => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          rows[i + 1]?.input.focus();
        });
        return { m, input, was, row, name: () => input.value.trim() };
      });
      const changes = () => rows.filter(r => r.name() && r.name() !== r.m.name.trim());
      const status = el('p', { className: 'cbt-hint', role: 'status' });
      const save = btn('', () => saveNames(changes().map(r => ({ module: r.m, name: r.name() }))), 'cbt-primary');

      function refresh() {
        let blank = 0, n = 0;
        for (const r of rows) {
          const v = r.name();
          const changed = v !== r.m.name.trim();
          r.row.classList.toggle('cbt-changed', changed);
          r.row.classList.toggle('cbt-invalid', !v);
          r.was.hidden = !changed;
          if (!v) blank++;
          else if (changed) n++;
        }
        save.disabled = !n || blank > 0;
        save.textContent = n ? `Save ${n} change${plural(n)}` : 'Save';
        status.textContent = blank ? `Module names can't be blank (${blank} empty).` : '';
      }
      refresh();

      ui.dialog.show(title(),
        el('p', { className: 'cbt-hint', textContent: 'Edit any names, then save. Enter moves to the next one.' }),
        rows.length ? el('ol', { className: 'cbt-rename-list' }, ...rows.map(r => r.row))
          : el('p', { textContent: 'This course has no modules yet.' }),
        status,
        el('div', { className: 'cbt-actions' }, btn('Cancel', () => ui.dialog.close()), save));
      rows[0]?.input.focus();
    }

    async function saveNames(list) {
      const progress = el('progress', { max: list.length, value: 0 });
      const status = el('p', { className: 'cbt-hint', role: 'status' });
      ui.dialog.show(el('h2', { textContent: 'Renaming modules…' }), progress, status);

      let ok = 0;
      const failed = [];
      job.start();
      try {
        await paced(list, PAUSE_MS, async ({ module, name }, i) => {
          status.textContent = `${i} of ${list.length} done`;
          const row = { title: name, module: `was “${module.name}”` };
          try {
            const res = await canvas.request('PUT', `/api/v1/courses/${courseId()}/modules/${module.id}`, { module: { name } });
            if (res.ok) ok++;
            else failed.push({ ...row, text: await canvas.errorText(res) });
          } catch (e) {
            failed.push({ ...row, text: e.message });
          }
          progress.value = i + 1;
        });
      } finally {
        job.end();
      }

      const result = { text: `Renamed ${ok} module${plural(ok)}${failed.length ? `, ${failed.length} failed` : ''}.`, failed };
      if (ok && store.write({ rename: result })) return location.reload();
      showRenameResult(result);
    }

    function showRenameResult({ text, failed }) {
      if (!failed.length) return toast(text);
      const close = btn('Close', () => ui.dialog.close(), 'cbt-primary');
      ui.dialog.show(el('h2', { textContent: text }),
        el('h3', { textContent: "These couldn't be renamed:" }), planList(failed),
        el('div', { className: 'cbt-actions' }, close));
      close.focus();
    }

    async function init() {
      if (!await waitFor(SEL.page) || !document.querySelector(SEL.editorOnly)) return;
      buildUI();
      const saved = store.take();
      if (!saved) return;
      if (saved.rename) return showRenameResult(saved.rename);
      await enterBulk(saved);
      if (saved.notice) showNotice(saved.notice);
    }

    return {
      name: 'Modules Batch Edit',
      matches: path => PAGE_RE.test(path),
      init,
    };
  }

  // ==================================================================
  // 7. Feature: Bulk Fudge Points
  // ==================================================================
  function createFudgePointsFeature() {
    const PAGE_RE = /^\/courses\/\d+\/gradebook\/?$/;
    const CONCURRENCY = 4;
    const PAUSE_MS = 200;
    const MENU_WAIT_MS = 3000;
    const SYNC_WAIT_MS = 30_000;
    const SYNC_POLL_MS = 2000;

    const SEL = {
      columnHeader: '.slick-header-column',
      menu: '[role="menu"]',
      menuItem: '[role="menuitem"]',
      insertAfter: /^(set default grade|curve grades)$/i,
    };

    const round = n => Math.round(n * 1e4) / 1e4;
    const fmt = n => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

    // Extracts the JSON object that follows `marker` in an HTML page.
    function jsonAfter(text, marker) {
      const at = text.indexOf(marker);
      const start = at < 0 ? -1 : text.indexOf('{', at + marker.length);
      if (start < 0) return null;
      let depth = 0, inString = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (ch === '\\') i++;
          else if (ch === '"') inString = false;
        } else if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
        }
      }
      return null;
    }

    // The results endpoint reads camelCase but serves snake_case.
    const camelKey = k => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    function camelize(v) {
      if (Array.isArray(v)) return v.map(camelize);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [camelKey(k), camelize(x)]));
      return v;
    }
    function toSaveFormat(item) {
      const { grading_method, ...rest } = item; // eslint-disable-line no-unused-vars
      return { errors: {}, graderId: null, ...camelize(rest) };
    }

    function changedItems(before, after) {
      const score = list => new Map(list.map(i => [String(i.item_id), Number(i.score)]));
      const a = score(before), b = score(after);
      return [...new Set([...a.keys(), ...b.keys()])].filter(id => a.get(id) !== b.get(id));
    }

    function quizIdFrom(launchInfo) {
      const entry = launchInfo.entry_path || {};
      for (const [key, value] of Object.entries(entry)) {
        if (/^(assignment|quiz)_?id$/i.test(key) && /^\d+$/.test(String(value))) return String(value);
      }
      const path = String(launchInfo.launch_url || '').split('?')[0];
      return path.match(/\/(\d+)(?:\/|$)/)?.[1] || null;
    }

    function launchSummary(launchInfo) {
      const address = String(launchInfo.launch_url || '').split('?')[0].replace(/^https?:\/\/[^/]+/, '') || 'none';
      return `it opened "${address}" with entry details ${JSON.stringify(launchInfo.entry_path ?? null)}`;
    }

    // Grading tokens are only ever sent to an https *.instructure.com host,
    // even if the service names some other host.
    function quizApiBase(host) {
      const raw = host || CONFIG.quizApi;
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (url.protocol !== 'https:' || !/\.instructure\.com$/i.test(url.hostname)) {
        throw new Error(`New Quizzes pointed to an unexpected server (${url.hostname})`);
      }
      return `${url.origin}/api`;
    }

    const nq = {
      async request(url, headers, { method = 'GET', body } = {}) {
        let r;
        try {
          r = await nativeFetch(url, {
            method,
            // Token auth only; never send Canvas cookies to the quiz hosts.
            credentials: 'omit',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
        } catch (e) {
          debug('New Quizzes', method, url.split('?')[0], 'blocked:', e);
          throw new Error(`the browser blocked the request to ${new URL(url).host} (${e.message})`);
        }
        debug('New Quizzes', method, url.split('?')[0], r.status);
        return r;
      },

      async json(url, headers, opts, what) {
        const r = await this.request(url, headers, opts);
        if (!r.ok) throw new Error(`${what} failed (${r.status})`);
        return r.json();
      },

      // Canvas embeds the signed LTI launch in the quiz's launch page.
      async launchDetails(assignmentId) {
        const c = courseId();
        const pages = [
          `/courses/${c}/assignments/${assignmentId}/launch?assignment_id=${assignmentId}` +
            '&content_only=true&display=borderless&new_quizzes_native_experience_sessionless=true&sessionless_launch=true',
          `/courses/${c}/assignments/${assignmentId}`,
        ];
        const tried = [];
        for (const page of pages) {
          try {
            const r = await nativeFetch(page, { credentials: 'same-origin', redirect: 'manual', headers: { Accept: 'text/html' } });
            debug('New Quizzes launch page', page.split('?')[0], r.type, r.status);
            if (!r.ok) { tried.push(r.type === 'opaqueredirect' ? 'redirected' : r.status); continue; }
            const found = jsonAfter(await r.text(), '"NEW_QUIZZES":');
            if (found?.params && found.signature) return found;
            tried.push('no launch details on the page');
          } catch (e) {
            debug('New Quizzes launch page', page.split('?')[0], 'blocked:', e);
            tried.push(e.message);
          }
        }
        throw new Error(`Canvas didn't provide this quiz's launch details (${tried.join('; ')})`);
      },

      async canvasPass() {
        const course = await canvas.get(`/api/v1/courses/${courseId()}`);
        const contexts = [course.account_id, course.root_account_id]
          .filter(Boolean).map(id => `&context_type=account&context_id=${id}`).concat('');
        for (const ctx of contexts) {
          const r = await canvas.request('POST', `/api/v1/jwts?canvas_audience=false&workflows[]=new_quizzes_native_launch${ctx}`);
          if (!r.ok) continue;
          const { token } = await canvas.json(r);
          if (token) return token;
        }
        throw new Error("Canvas didn't issue a New Quizzes pass");
      },

      async connect(assignmentId, onStep) {
        const launchInfo = await onStep('Reading the quiz’s launch details', () => this.launchDetails(assignmentId));
        const pass = await onStep('Getting a pass from Canvas', () => this.canvasPass());
        const j = await onStep('Opening New Quizzes', async () => {
          const res = await this.json(`${CONFIG.quizLti}/native/launch`,
            { Authorization: `Bearer ${pass}`, 'x-domain': launchInfo.params.tool_consumer_instance_guid },
            { method: 'POST', body: { params: launchInfo.params, signature: launchInfo.signature } },
            'Opening New Quizzes');
          if (!res.access_token) throw new Error("New Quizzes didn't return a login");
          return res;
        });
        const quizId = await onStep('Finding the quiz in New Quizzes', async () => {
          const id = quizIdFrom(j);
          if (!id) throw new Error(`New Quizzes didn't say which quiz this is (${launchSummary(j)})`);
          return id;
        });
        return {
          quizId: String(quizId),
          headers: {
            Authorization: `Bearer ${j.access_token}`,
            'x-domain': j.current_user?.account_uuid || launchInfo.params.tool_consumer_instance_guid,
          },
        };
      },

      lti(conn, path, what) {
        return this.json(`${CONFIG.quizLti}${path}`, conn.headers, undefined, what);
      },

      async participants(conn) {
        const seen = new Map();
        for (let page = 1; page <= 100; page++) {
          const list = await this.lti(conn, `/assignments/${conn.quizId}/participants?page=${page}`, 'Listing students');
          const fresh = (Array.isArray(list) ? list : []).filter(p => !seen.has(p.id));
          if (!fresh.length) break;
          fresh.forEach(p => seen.set(p.id, p));
        }
        return [...seen.values()];
      },

      async attempt(conn, participantSessionId) {
        const g = await this.lti(conn, `/participant_sessions/${participantSessionId}/grade`, 'Opening the attempt');
        return {
          sessionId: String(g.quiz_api_quiz_session_id),
          base: quizApiBase(g.host),
          headers: { Authorization: g.token, AuthType: 'Signature' },
        };
      },

      async result(att) {
        const s = await this.json(`${att.base}/quiz_sessions/${att.sessionId}?anonymous_grading=false`,
          att.headers, undefined, 'Reading the attempt');
        return s.authoritative_result || null;
      },

      itemResults(att, resultId) {
        return this.json(`${att.base}/quiz_sessions/${att.sessionId}/results/${resultId}/session_item_results`,
          att.headers, undefined, 'Reading question scores');
      },

      // Re-reads the attempt right before writing (so the new total is based on
      // current fudge points, not the ones shown in the dialog), then verifies.
      async addFudge(att, delta) {
        const before = await this.result(att);
        if (!before) throw new Error('this attempt has no score yet');
        const items = await this.itemResults(att, before.id);
        const target = round(Number(before.fudge_points || 0) + delta);

        const r = await this.request(`${att.base}/quiz_sessions/${att.sessionId}/results`, att.headers,
          { method: 'POST', body: { results: items.map(toSaveFormat), fudge_points: target } });
        if (!r.ok) throw new Error(`New Quizzes refused the change (${r.status})`);

        const after = await this.result(att);
        if (!after || Math.abs(Number(after.fudge_points) - target) > 1e-6) {
          throw new Error(`saved, but fudge points read back as ${fmt(after?.fudge_points)} instead of ${fmt(target)}`);
        }
        const moved = changedItems(items, await this.itemResults(att, after.id));
        if (moved.length) {
          const err = new Error(`${moved.length} question score${plural(moved.length)} changed; check this student in SpeedGrader`);
          err.fatal = true;
          throw err;
        }
        return { before, after };
      },
    };

    const nameOf = p => p.user?.full_name || `Student ${p.canvas_user_id || p.id}`;
    const latestAttempt = p => (p.participant_sessions || [])
      .filter(s => s.submitted_at)
      .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at))[0];

    async function loadStudents(assignmentId, onProgress) {
      const step = async (label, fn) => {
        onProgress(`${label}…`);
        try { return await fn(); } catch (e) { throw new Error(`${label}: ${e.message}`); }
      };
      const conn = await nq.connect(assignmentId, step);
      const people = await step('Finding students', () => nq.participants(conn));

      const skipped = [];
      const candidates = [];
      for (const p of people) {
        const ps = latestAttempt(p);
        if (ps) candidates.push({ name: nameOf(p), userId: String(p.canvas_user_id), ps });
        else skipped.push({ name: nameOf(p), why: "hasn't submitted" });
      }

      let read = 0;
      const rows = await mapLimit(candidates, CONCURRENCY, async c => {
        try {
          const att = await nq.attempt(conn, c.ps.id);
          const result = await nq.result(att);
          if (!result) return { ...c, skip: 'no score yet' };
          if (result.status && result.status !== 'graded') return { ...c, skip: `not fully graded yet (${result.status.replace(/_/g, ' ')})` };
          return { ...c, att, result, checked: true };
        } catch (e) {
          return { ...c, skip: e.message };
        } finally {
          onProgress(`Reading scores… ${++read} of ${candidates.length}`);
        }
      });

      rows.filter(r => r.skip).forEach(r => skipped.push({ name: r.name, why: r.skip }));
      const students = rows.filter(r => !r.skip).sort((a, b) => a.name.localeCompare(b.name));
      skipped.sort((a, b) => a.name.localeCompare(b.name));
      return { students, skipped };
    }

    // ---- Gradebook menu hook ----
    // Assignments are looked up one at a time, only when their column menu is
    // opened, and cached (instead of downloading every assignment up front).
    const quizCache = new Map();
    let menuWatch = 0;

    const isNewQuiz = a => a.is_quiz_lti_assignment === true ||
      ((a.submission_types || []).includes('external_tool') && /quiz-lti/.test(a.external_tool_tag_attributes?.url || ''));

    function quizInfo(assignmentId) {
      if (!quizCache.has(assignmentId)) {
        quizCache.set(assignmentId, canvas.get(`/api/v1/courses/${courseId()}/assignments/${assignmentId}`)
          .then(a => (isNewQuiz(a) ? a : null))
          .catch(e => {
            quizCache.delete(assignmentId); // retry next time
            debug('Bulk Fudge Points could not read assignment', assignmentId, e);
            return null;
          }));
      }
      return quizCache.get(assignmentId);
    }

    function onHeaderClick(e) {
      if (!e.isTrusted) return;
      const header = e.target.closest?.(SEL.columnHeader);
      const trigger = e.target.closest?.('button');
      if (!header || !trigger) return;
      const id = `${header.id} ${header.className}`.match(/assignment_(\d+)/)?.[1];
      if (id) watchForMenu(id, trigger);
    }

    async function watchForMenu(assignmentId, trigger) {
      const watch = ++menuWatch;
      const quiz = await quizInfo(assignmentId);
      if (!quiz || watch !== menuWatch) return;
      const menu = await waitFor(() => {
        if (watch !== menuWatch) return 'stale';
        return [...document.querySelectorAll(SEL.menu)].find(m =>
          !m.querySelector('.cbt-fudge-item') &&
          [...m.querySelectorAll(SEL.menuItem)].some(i => SEL.insertAfter.test(i.textContent.trim())));
      }, MENU_WAIT_MS, 50);
      if (menu instanceof Element) addMenuItem(menu, quiz, trigger);
    }

    // Clones Canvas's own menu row so the new item matches its styling.
    function addMenuItem(menu, quiz, trigger) {
      const anchor = [...menu.querySelectorAll(SEL.menuItem)].filter(i => SEL.insertAfter.test(i.textContent.trim())).pop();

      let row = anchor;
      while (row.parentElement !== menu && row.parentElement.querySelectorAll(SEL.menuItem).length === 1) {
        row = row.parentElement;
      }

      const copy = row.cloneNode(true);
      [copy, ...copy.querySelectorAll('[id]')].forEach(n => n.removeAttribute('id'));
      copy.classList.add('cbt-fudge-item');
      const item = copy.matches(SEL.menuItem) ? copy : copy.querySelector(SEL.menuItem);
      item.removeAttribute('aria-disabled');
      const label = [...walkText(item)].find(t => SEL.insertAfter.test(t.nodeValue.trim()));
      if (label) label.nodeValue = 'Add Fudge Points…';
      else item.textContent = 'Add Fudge Points…';

      const choose = e => {
        e.preventDefault();
        e.stopPropagation();
        openDialog(quiz);
        // Close Canvas's menu the way it expects to be closed.
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        setTimeout(() => { if (menu.isConnected) trigger.click(); }, 0);
      };
      item.addEventListener('click', choose);
      item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') choose(e); });
      row.after(copy);
    }

    function* walkText(node) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) yield walker.currentNode;
    }

    // ---- UI ----
    const ui = {};
    let visit = 0;
    let stopRequested = false;

    const studentTable = (headings, rows) =>
      el('div', { className: 'cbt-fudge-scroll' }, el('table', { className: 'cbt-fudge-table' },
        el('thead', {}, el('tr', {}, ...headings)),
        el('tbody', {}, ...rows)));
    const th = (text, className = '') => el('th', { className, textContent: text });
    const td = (text, className = '') => el('td', { className, textContent: text });

    const heading = quiz => [
      el('h2', { textContent: 'Add fudge points' }),
      el('p', { className: 'cbt-fudge-quiz', textContent: quiz.name }),
    ];

    async function openDialog(quiz) {
      const mine = ++visit;
      const status = el('p', { className: 'cbt-hint', role: 'status', textContent: 'Starting…' });
      const cancel = btn('Cancel', () => ui.dialog.close());
      ui.dialog.show(...heading(quiz), el('progress'), status, el('div', { className: 'cbt-actions' }, cancel));
      cancel.focus();
      try {
        const loaded = await loadStudents(quiz.id, text => { if (mine === visit) status.textContent = text; });
        if (mine === visit) showSetup(quiz, loaded);
      } catch (e) {
        if (mine !== visit) return;
        const close = btn('Close', () => ui.dialog.close(), 'cbt-primary');
        ui.dialog.show(...heading(quiz),
          el('p', { className: 'cbt-fudge-error', textContent: `Couldn't load this quiz.` }),
          el('p', { textContent: e.message }),
          el('p', { className: 'cbt-hint', textContent: 'Setting debug: true in CONFIG logs each step to the browser console (F12).' }),
          el('div', { className: 'cbt-actions' }, close));
        close.focus();
      }
    }

    function showSetup(quiz, loaded) {
      const { students, skipped } = loaded;
      const points = el('input', { type: 'number', step: 'any', value: loaded.points ?? '1', id: 'cbt-fudge-points' });
      const all = el('input', { type: 'checkbox', ariaLabel: 'Select all students' });
      const delta = () => {
        const n = round(Number(points.value));
        return points.value.trim() && Number.isFinite(n) ? n : NaN;
      };
      const next = btn('', () => {
        loaded.points = points.value;
        showReview(quiz, loaded, students.filter(s => s.checked), delta());
      }, 'cbt-primary');

      const rows = students.map(s => {
        const box = el('input', { type: 'checkbox', checked: s.checked, ariaLabel: `Include ${s.name}` });
        const after = el('td', { className: 'cbt-num' });
        const tr = el('tr', {},
          el('td', { className: 'cbt-check-cell' }, box),
          td(s.name),
          td(fmt(s.result.fudge_points), 'cbt-num'),
          td(`${fmt(s.result.score)} / ${fmt(s.result.points_possible)}`, 'cbt-num'),
          after);
        box.addEventListener('change', () => { s.checked = box.checked; refresh(); });
        tr.addEventListener('click', e => { if (e.target !== box) { box.checked = !box.checked; box.dispatchEvent(new Event('change')); } });
        return { s, tr, box, after };
      });

      function refresh() {
        const d = delta();
        const valid = Number.isFinite(d) && d !== 0;
        let n = 0;
        for (const r of rows) {
          if (r.s.checked) n++;
          r.tr.classList.toggle('cbt-fudge-off', !r.s.checked);
          r.after.replaceChildren(r.s.checked && valid
            ? el('span', { className: 'cbt-fudge-change', textContent: fmt(round(r.s.result.score + d)) })
            : '—');
        }
        all.checked = n > 0 && n === students.length;
        all.indeterminate = n > 0 && n < students.length;
        next.disabled = !valid || !n;
        next.textContent = valid && n ? `Review ${n} change${plural(n)}` : 'Review changes';
      }
      all.addEventListener('change', () => { rows.forEach(r => { r.s.checked = all.checked; r.box.checked = all.checked; }); refresh(); });
      points.addEventListener('input', refresh);
      refresh();

      ui.dialog.show(...heading(quiz),
        el('label', { className: 'cbt-fudge-points', htmlFor: points.id }, 'Points to add', points),
        el('p', { className: 'cbt-hint', textContent:
          'Adds to any fudge points a student already has. Use a negative number to take points away. ' +
          'Applies to each student’s latest attempt.' }),
        el('strong', { textContent: 'This feature is experimental; back up your grades before using.' }),
        students.length
          ? studentTable([el('th', { className: 'cbt-check-cell' }, all), th('Student'),
              th('Fudge now', 'cbt-num'), th('Score now', 'cbt-num'), th('After', 'cbt-num')], rows.map(r => r.tr))
          : el('p', { textContent: 'No one has a graded attempt to add points to yet.' }),
        skipped.length ? el('details', { className: 'cbt-fudge-dialog-details' },
          el('summary', { textContent: `Not included (${skipped.length})` }),
          el('ul', { className: 'cbt-list' }, ...skipped.map(s => el('li', {},
            el('span', { textContent: s.name }), el('span', { className: 'cbt-sub', textContent: s.why }))))) : '',
        el('div', { className: 'cbt-actions' }, btn('Cancel', () => ui.dialog.close()), next));
      points.focus();
      points.select();
    }

    function showReview(quiz, loaded, chosen, delta) {
      const n = chosen.length;
      const verb = delta > 0 ? 'Add' : 'Remove';
      const pts = `${fmt(Math.abs(delta))} point${plural(Math.abs(delta))}`;
      const back = btn('Back', () => showSetup(quiz, loaded));
      const go = btn(`${verb} ${pts} for ${n} student${plural(n)}`, () => run(quiz, chosen, delta), 'cbt-primary');
      ui.dialog.show(...heading(quiz),
        el('h3', { textContent: `${verb} ${pts} ${delta > 0 ? 'to' : 'from'} ${n} student${plural(n)}` }),
        studentTable([th('Student'), th('Fudge points', 'cbt-num'), th('Score', 'cbt-num')],
          chosen.map(s => el('tr', {},
            td(s.name),
            el('td', { className: 'cbt-num' }, `${fmt(s.result.fudge_points)} → `,
              el('span', { className: 'cbt-fudge-change', textContent: fmt(round(Number(s.result.fudge_points || 0) + delta)) })),
            el('td', { className: 'cbt-num' }, `${fmt(s.result.score)} → `,
              el('span', { className: 'cbt-fudge-change', textContent: fmt(round(s.result.score + delta)) }),
              ` / ${fmt(s.result.points_possible)}`)))),
        el('p', { className: 'cbt-hint', textContent:
          'Each save is read back to confirm it. If a question’s score ever changes, it stops right away so nothing else is touched.' }),
        el('div', { className: 'cbt-actions' }, back, go));
      back.focus();
    }

    // Gradebook scores for just these students (not the whole class).
    async function gradebookScores(assignmentId, userIds) {
      const cid = courseId();
      const scores = new Map();
      for (const ids of chunk(userIds, 50)) {
        const qs = ids.map(id => `student_ids[]=${encodeURIComponent(id)}`).join('&');
        const subs = await canvas.getAll(`/api/v1/courses/${cid}/students/submissions?assignment_ids[]=${assignmentId}&${qs}`);
        for (const sub of subs) scores.set(String(sub.user_id), sub.score);
      }
      return scores;
    }

    async function run(quiz, chosen, delta) {
      stopRequested = false;
      const done = [], failed = [];
      let halted = null;

      const progress = el('progress', { max: chosen.length, value: 0 });
      const status = el('p', { className: 'cbt-hint', role: 'status' });
      const stop = btn('Stop', () => { stopRequested = true; stop.disabled = true; stop.textContent = 'Stopping…'; });
      ui.dialog.show(...heading(quiz), progress, status, el('div', { className: 'cbt-actions' }, stop));
      stop.focus();

      let before = null;
      job.start();
      try {
        before = await gradebookScores(quiz.id, chosen.map(s => s.userId)).catch(() => null);
        await paced(chosen, PAUSE_MS, async (s, i) => {
          if (stopRequested) return false;
          status.textContent = `${s.name} (${i + 1} of ${chosen.length})`;
          try {
            await nq.addFudge(s.att, delta);
            done.push(s);
          } catch (e) {
            failed.push({ name: s.name, why: e.message });
            if (e.fatal) { halted = s.name; return false; }
          } finally {
            progress.value = i + 1;
          }
        });
      } finally {
        job.end();
      }

      const summary = { quiz: { id: quiz.id, name: quiz.name }, total: chosen.length, done: done.length, failed, halted };
      if (!done.length || !store.write(summary)) return showResults(summary);

      // Wait (briefly) for the Gradebook to pick up the new scores, so the reload shows them.
      const reloadNow = btn('Reload now', () => location.reload());
      ui.dialog.show(...heading(quiz),
        el('h3', { textContent: `Saved ${done.length} student${plural(done.length)}.` }),
        el('progress'),
        el('p', { className: 'cbt-hint', role: 'status', textContent: 'Waiting for the Gradebook to show the new scores, then reloading…' }),
        el('div', { className: 'cbt-actions' }, reloadNow));
      reloadNow.focus();
      if (before) {
        const ids = done.map(s => s.userId);
        const deadline = Date.now() + SYNC_WAIT_MS;
        while (Date.now() < deadline) {
          await sleep(SYNC_POLL_MS);
          const now = await gradebookScores(quiz.id, ids).catch(() => null);
          if (now && ids.every(id => now.get(id) !== before.get(id))) break;
        }
      }
      location.reload();
    }

    const store = sessionStore('cbt-fudge');

    const summaryText = ({ total, done, failed, halted }) => {
      const notRun = total - done - failed.length;
      const parts = [`${done} updated`];
      if (failed.length) parts.push(`${failed.length} failed`);
      if (notRun) parts.push(`${notRun} not attempted`);
      return `${halted ? 'Stopped' : 'Done'}: ${parts.join(', ')}.`;
    };

    function showResults(summary) {
      const { quiz, failed, halted } = summary;
      const close = btn('Close', () => ui.dialog.close(), 'cbt-primary');
      ui.dialog.show(...heading(quiz),
        el('h3', { textContent: summaryText(summary) }),
        halted ? el('p', { className: 'cbt-fudge-error', textContent: `Stopped after ${halted} so nothing else is changed until you’ve looked.` }) : '',
        failed.length ? el('ul', { className: 'cbt-list' }, ...failed.map(f => el('li', {},
          el('span', { textContent: f.name }), el('span', { className: 'cbt-sub cbt-fudge-error', textContent: f.why })))) : '',
        el('div', { className: 'cbt-actions' }, close));
      close.focus();
    }

    function showAfterReload(summary) {
      if (summary.failed.length || summary.halted) return showResults(summary);
      toast(`Fudge points for ${summary.quiz.name}: ${summaryText(summary)}`);
    }

    function init() {
      ui.dialog = modal('cbt-fudge-dialog');
      ui.dialog.node.addEventListener('close', () => { if (!job.active) visit++; });
      document.addEventListener('click', onHeaderClick, true);
      const saved = store.take();
      if (saved) showAfterReload(saved);
    }

    return {
      name: 'Bulk Fudge Points',
      matches: path => PAGE_RE.test(path),
      init,
    };
  }

  // ==================================================================
  // 8. Bootstrap
  // ==================================================================
  const FEATURES = [
    createItemBankFeature(),
    createModulesBatchEditFeature(),
    createFudgePointsFeature(),
  ];

  const active = FEATURES.filter(f => f.matches(location.pathname));
  if (!active.length) return;

  active.forEach(f => f.early?.());

  domReady().then(() => {
    injectStyles();
    for (const f of active) {
      Promise.resolve()
        .then(f.init)
        .catch(e => console.error(`[Canvas Bulk Tools] ${f.name} failed to start:`, e));
    }
  });
})();
