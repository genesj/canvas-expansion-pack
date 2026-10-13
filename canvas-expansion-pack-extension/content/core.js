/*
 * Canvas Expansion Pack: content scripts
 *
 * The content script is split into plain files that Chrome runs one after
 * another, in the order listed in SCRIPT_FILES in background.js:
 *   content/core.js                         config, helpers, Canvas REST client (this file)
 *   content/ui.js                           stylesheet (theme colors at the top), launch buttons, dialogs
 *   content/bulk-edit.js                    Batch Edit bar, preview, apply loop and move picker (Modules + Assignments)
 *   content/features/item-bank-sharing.js   Item Banks page
 *   content/features/modules-batch-edit.js  Modules page / course home; edit items, rename items, rename modules
 *   content/features/assignments-batch-edit.js  Assignments page; move, publish, unpublish, delete
 *   content/features/fudge-points.js        Gradebook page, New Quiz column menus
 *   content/features/module-breadcrumbs.js  item pages; Course > Module > Item breadcrumbs
 *   content/main.js                         decides which features run on this page and starts them
 *
 * How the files share code
 *   Every file is wrapped in its own (() => { ... })() so nothing leaks into
 *   the page's global scope. core.js puts one object on window
 *   (window.__canvasExpansionPack) holding the shared helpers; each later
 *   file copies what it needs into its own scope as it loads. main.js runs
 *   last and deletes that object, so once loading finishes nothing of ours
 *   is reachable from the page. All files run back to back at
 *   document_start, before any of the page's own scripts.
 *
 * Adding a feature
 *   Add a file under content/features/ that calls
 *   register(factory), where the factory returns
 *   { name, matches(path), early?(), init() }, and add its path to
 *   SCRIPT_FILES in background.js before content/main.js. `early` runs at
 *   document-start (before the page's own scripts); `init` runs once the DOM
 *   is ready. Keep feature state inside its factory, prefix ids/classes with
 *   `cbt-<feature>-` so features can't collide, and pass its CSS to
 *   addStyles().
 *
 * Security model
 *   - Every change goes through Canvas or New Quizzes APIs as the signed-in
 *     user, so the servers enforce permissions. The script never grants
 *     anything the user couldn't already do by hand.
 *   - Captured quiz-service tokens live only inside the Item Bank Sharing
 *     file's closure. They are never written to storage, the DOM, the
 *     console or the shared object, and are only sent to https New Quizzes
 *     hosts on instructure.com (see QUIZ_HOST_RE).
 *   - Nothing is ever inserted as HTML; all text from the APIs goes in
 *     through textContent.
 *   - Results carried across a reload (sessionStorage) expire after two
 *     minutes and are deleted as soon as they're read.
 *
 * Packaging (Chrome extension, Manifest V3)
 *   - Works on any Canvas site the user turns it on for. Clicking the
 *     toolbar icon asks Chrome for permission for that one host;
 *     background.js then registers these files as one content script with
 *     world "MAIN" and runAt "document_start" on https://<host>/courses/*.
 *     MAIN world is required: Item Bank Sharing reads the quiz service's
 *     auth headers by wrapping the page's own window.fetch / XMLHttpRequest.
 *   - Because it runs in the page's world, every request is an ordinary
 *     page request, governed by the quiz hosts' own CORS rules.
 *   - Nothing here uses chrome.* APIs (they aren't available in MAIN world).
 *     If chrome.storage or messaging is added later, add a second,
 *     isolated-world script and pass values across with window.postMessage.
 *   - No hosts are hardcoded. The Canvas host is whatever site the script
 *     was enabled on; the New Quizzes hosts are detected (see quizHosts).
 *   - Debug logging: run  localStorage.setItem('cbt-debug', '1')  in the
 *     console (F12) on a Canvas page and reload; removeItem to turn it off.
 */
(() => {
  'use strict';

  // ==================================================================
  // 1. Config
  // ==================================================================
  const CONFIG = {
    // Turn on with localStorage.setItem('cbt-debug', '1') in the console (F12), then reload.
    debug: (() => { try { return localStorage.getItem('cbt-debug') === '1'; } catch { return false; } })(),
  };

  // New Quizzes hosts are learned at runtime instead of being listed here:
  //   <school>.quiz-api-<region>-<env>.instructure.com   (item banks, grading)
  //   <school>.quiz-lti-<region>-<env>.instructure.com   (launch, names, participants)
  // Only https hosts matching this pattern are ever remembered, so tokens can
  // only be sent to Instructure's quiz servers.
  const QUIZ_HOST_RE = /^(?:[a-z0-9-]+\.)*quiz-(api|lti)-[a-z0-9-]+\.instructure\.com$/i;

  const quizHosts = {
    api: null, // e.g. 'https://school.quiz-api-pdx-prod.instructure.com/api'
    lti: null,

    // Returns 'api' or 'lti' if `url` is a New Quizzes URL (and remembers its
    // host); otherwise null. Cheap for ordinary URLs: no parsing unless
    // "quiz-" appears in it.
    learn(url) {
      url = String(url || '');
      if (!url.includes('quiz-')) return null;
      let u;
      try { u = new URL(url, location.href); } catch { return null; }
      const kind = u.protocol === 'https:' ? u.hostname.match(QUIZ_HOST_RE)?.[1].toLowerCase() : null;
      if (!kind) return null;
      this[kind] = `${u.origin}/api`;
      return kind;
    },

    // The base URL for one service. If only the other service has been seen,
    // its host is used with the service name swapped (same school and region).
    base(kind) {
      const other = kind === 'api' ? 'lti' : 'api';
      const known = this[kind] || this[other]?.replace(`quiz-${other}-`, `quiz-${kind}-`);
      if (!known) throw new Error("couldn't tell which New Quizzes server this school uses");
      return known;
    },
  };

  // ==================================================================
  // 2. Core helpers
  // ==================================================================
  // Captured before any feature wraps window.fetch, so our own requests
  // never pass through (or get recorded by) the capture layer.
  const nativeFetch = window.fetch.bind(window);

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const plural = n => (n === 1 ? '' : 's');
  // console.log, not console.debug: Chrome hides debug-level messages unless "Verbose" is ticked.
  const debug = (...args) => { if (CONFIG.debug) console.log('[Canvas Expansion Pack]', ...args); };
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
  // Shared with the other files (main.js deletes this once they've loaded)
  // ==================================================================
  const features = [];

  Object.defineProperty(window, '__canvasExpansionPack', {
    configurable: true, // so main.js can delete it
    value: {
      CONFIG, QUIZ_HOST_RE, quizHosts, nativeFetch,
      sleep, plural, debug, courseId, chunk, domReady, waitFor, sessionStore, mapLimit, paced, job,
      el, btn, canvas,
      features,
      register(factory) { features.push(factory); },
    },
  });
})();
