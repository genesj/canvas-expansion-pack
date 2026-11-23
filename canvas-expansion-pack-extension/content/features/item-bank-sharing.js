// Canvas Expansion Pack: Item Bank Sharing (see the notes at the top of core.js).
//
// The Item Banks page's "Batch Edit ▾" menu and its panel: share banks with
// a person or this course, review or remove shares, and move a New Quiz's
// questions into a new bank of the same name.

(() => {
  'use strict';

  const {
    btn, canvas, chunk, courseId, debug, el, job, launch, launchMenu, mapLimit, nativeFetch, newQuizzes, paced, plural,
    sessionStore, toast,
    quizHosts, sleep, addStyles, register,
  } = window.__canvasExpansionPack;

  addStyles(String.raw`
    /* ================= Item Bank Sharing ================= */
    /* Docked, the button shares a flex row with the "Banks" heading and "+ Bank"
       (space-between), so margin-left:auto keeps it beside "+ Bank" instead of
       in the middle of the row. Outside a flex row the auto margin does nothing. */
    #cbt-bank-toggle:not(.cbt-floating) { align-self: center; margin-left: auto; margin-right: 12px; }
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
    /* Canvas's own stylesheet gives every text box a fixed 20px height and a
       bottom margin, and every checkbox a top margin, which beat the .cbt
       rules. Undo those inside the panel so boxes line up with their buttons. */
    #cbt-bank-panel input[type=text],
    #cbt-bank-panel select { height: auto; margin: 0; line-height: inherit; }
    #cbt-bank-panel input[type=checkbox] { margin: 0; }

    #cbt-bank-panel .cbt-bank-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    #cbt-bank-panel h2 { flex: 1; min-width: 0; margin: 0; font-size: 18px; }
    #cbt-bank-panel h3 { margin: 4px 0 6px; font-size: 15px; }
    /* The log button beside the title: a plain text symbol with no emoji
       form, so every browser draws it the same way. */
    #cbt-bank-panel .cbt-bank-icon {
      flex: none;
      min-width: 24px;
      padding: 0 4px;
      font-size: 18px;
      line-height: 24px;
      text-align: center;
    }
    #cbt-bank-panel .cbt-bank-logtoggle {
      background: none;
      border: 0;
      border-radius: 4px;
      color: var(--cbt-muted);
      font-family: inherit;
      cursor: pointer;
    }
    #cbt-bank-panel .cbt-bank-logtoggle:hover,
    #cbt-bank-panel .cbt-bank-logtoggle[aria-pressed="true"] { background: var(--cbt-hover); color: var(--cbt-text); }
    #cbt-bank-panel .cbt-bank-status { font-size: 13px; color: var(--cbt-muted); margin-top: 4px; }
    #cbt-bank-panel .cbt-bank-label { display: block; font-weight: 600; margin: 10px 0 4px; }
    #cbt-bank-panel .cbt-bank-row { display: flex; gap: 6px; }
    #cbt-bank-panel .cbt-bank-row + .cbt-bank-row { margin-top: 6px; }
    #cbt-bank-panel .cbt-bank-row input[type=text],
    #cbt-bank-panel .cbt-bank-row select { flex: 1; min-width: 0; }
    #cbt-bank-panel .cbt-bank-listbar { display: flex; align-items: center; gap: 6px; }
    #cbt-bank-panel .cbt-bank-listbar .cbt-hint { flex: 1; margin: 0; }
    #cbt-bank-panel .cbt-bank-selall { display: flex; align-items: center; gap: 6px; margin: 0; font-weight: 600; cursor: pointer; }
    #cbt-bank-panel .cbt-bank-count { margin-left: auto; font-size: 13px; color: var(--cbt-muted); white-space: nowrap; }
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
      cursor: pointer;
    }
    #cbt-bank-panel .cbt-bank-checklist input[type=checkbox] { flex: none; position: relative; top: 2px; }
    #cbt-bank-shares label { margin: 6px 0; }
    #cbt-bank-panel .cbt-bank-message:empty { display: none; }
    #cbt-bank-panel progress { width: 100%; margin-top: 8px; }
    #cbt-bank-panel .cbt-list { max-height: 240px; }
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
    #cbt-bank-log:empty::before { content: 'Nothing logged yet.'; color: var(--cbt-muted); }
  `);

  // ==================================================================
  // 5. Feature: Item Bank Sharing
  // ==================================================================
  function createItemBankFeature() {
    const PAGE_RE = /\/courses\/\d+\/(item_)?banks/;
    const PERM_LABEL = { edit: 'can edit', read: 'can view' };
    const REMOVED = 'removed_access';
    const PAUSE_WRITE_MS = 300;
    const SCAN_CONCURRENCY = 4;
    const FLOAT_AFTER_MS = 5000; // float the button if "+ Bank" hasn't appeared by then
    // People search only offers these roles, so a bank (and its answer key)
    // can't be shared with a student by picking the wrong name.
    const SHAREABLE_ROLES = ['teacher', 'ta', 'designer'];

    // The Batch Edit ▾ menu's entries, in order.
    const MODES = {
      person: { label: 'Share with a person', hint: 'Give a teacher, TA, or designer access' },
      course: { label: 'Share with this course', hint: 'Give this course’s teachers access' },
      review: { label: 'Review or remove access', hint: 'See who has access and remove it', danger: true },
      quiz: { label: 'Make a bank from a quiz', hint: 'Move a quiz’s questions into a new bank' },
    };

    // ---- Auth capture (runs at document-start) ----
    const auth = {
      api: { Authorization: null, Authtype: null },
      lti: { Authorization: null, Authtype: null },
      courseId: null,
    };
    let onCapture = () => {};
    let captureQueued = false;

    const slotFor = url => {
      const kind = quizHosts.learn(url);
      return kind ? auth[kind] : null;
    };

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
        .find(n => n.includes('course_id=') && quizHosts.learn(n) === 'api');
      return hit ? new URL(hit).searchParams.get('course_id') : null;
    }

    async function quizFetch(service, path, { method = 'GET', body } = {}) {
      const base = quizHosts.base(service);
      const slot = auth[service];
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

      // Ids are compared as strings: the service may send numbers where we hold strings.
      async find(bankId, entityType, entityIds) {
        const ids = entityIds.map(String);
        return (await this.list(bankId))
          .find(s => s.entity_type === entityType && ids.includes(String(s.entity_id))) || null;
      },

      update: (bankId, shareId, permission) =>
        quizFetch('api', `/banks/${bankId}/shared_banks/${shareId}`,
          { method: 'PATCH', body: { shared_bank: { permission } } }),

      // NOTE: `entityType` ('user' or 'course') is what tells the service whether
      // entity_id is a person or a course. It's camelCase while the other keys
      // (and the service's own responses, as `entity_type`) are snake_case,
      // most likely because it mirrors what New Quizzes' Share dialog sends.
      // It works in production, so don't rename it without checking that
      // request in DevTools first.
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
    // A "Batch Edit ▾" menu next to "+ Bank" picks the task, and the panel in
    // the bottom-right holds that task's controls. Each task goes from its
    // form to a preview, then runs with a progress bar and Stop, ending in a
    // one-line summary. The step-by-step log is hidden until "Show log" is
    // pressed (it's also mirrored to the console when cbt-debug is on).
    const ui = {};
    let people = [];
    let banks = [];
    let groups = [];
    let quizzes = [];
    let quizPlan = null; // { quiz, moves, skipped } for the quiz picked in "Move a New Quiz"
    let mode = 'person';
    let busy = false;    // a load or a job is running; controls are locked
    let running = false; // a job (writes) is running; the task can't be switched
    let banksFailed = false; // the automatic bank load failed; it's tried again next time a task is opened
    let reloadAfterRun = false; // set by a job that needs the page reloaded when it ends
    const store = sessionStore('cbt-banks'); // the summary carried across that reload
    let stopRequested = false;
    let placeTimer = null;
    const startedAt = Date.now();

    const NOT_CONNECTED = 'No item bank login yet. Click “Share” on any bank, close that dialog, then try again.';
    const NO_BANK_COURSE = 'The bank course wasn’t detected. Reload the Item Banks page and try again.';

    const nBanks = n => `${n} bank${plural(n)}`;
    const nEntries = n => `${n} entr${n === 1 ? 'y' : 'ies'}`;
    const fieldLabel = (text, htmlFor = '') => el(htmlFor ? 'label' : 'div', { className: 'cbt-bank-label', textContent: text, htmlFor });
    const emptyNote = text => el('div', { textContent: text });
    const row = (...children) => el('div', { className: 'cbt-bank-row' }, ...children);
    // One checklist row: the whole row is a <label>, so a click anywhere on it toggles the box.
    const checkRow = (input, ...content) => el('label', {}, input, el('span', { className: 'cbt-bank-text' }, ...content));
    // [title, sub] pairs → the title-over-grey-line list the Batch Edit dialogs use.
    const nameList = rows => el('ul', { className: 'cbt-list' }, ...rows.map(([title, sub]) => el('li', {},
      el('span', { textContent: title }),
      sub ? el('span', { className: 'cbt-sub', textContent: sub }) : '')));
    const describeMoves = moves => {
      const nStimuli = moves.filter(m => m.kind === 'Stimulus').length;
      const nItems = moves.length - nStimuli;
      return `${nItems} question${plural(nItems)}` + (nStimuli ? ` and ${nStimuli} stimul${nStimuli === 1 ? 'us' : 'i'}` : '');
    };

    function buildUI() {
      ui.menu = launchMenu('cbt-bank-toggle', 'Batch Edit',
        Object.entries(MODES).map(([key, m]) => ({ label: m.label, hint: m.hint, onSelect: () => openMode(key) })));
      ui.launch = ui.menu.button;
      ui.launch.hidden = true;

      ui.title = el('h2');
      ui.logToggle = el('button', { type: 'button', className: 'cbt-bank-icon cbt-bank-logtoggle', textContent: 'ⓘ', title: 'Show log', ariaLabel: 'Show log' });
      ui.logToggle.setAttribute('aria-pressed', 'false');
      ui.logToggle.addEventListener('click', toggleLog);
      ui.status = el('div', { className: 'cbt-bank-status' });

      ui.term = el('input', { type: 'text', id: 'cbt-bank-term', placeholder: 'Name or email' });
      ui.search = btn('Find', searchPeople);
      ui.person = el('select', { id: 'cbt-bank-person', ariaLabel: 'Person' },
        el('option', { textContent: 'Search for a teacher, TA, or designer in this course' }));
      ui.personBox = el('div', {}, fieldLabel('Person', 'cbt-bank-term'), row(ui.term, ui.search), row(ui.person));

      ui.perm = el('select', { id: 'cbt-bank-perm' },
        el('option', { value: 'edit', textContent: 'Can edit' }),
        el('option', { value: 'read', textContent: 'Can view' }));
      ui.permBox = el('div', {}, fieldLabel('Permission', 'cbt-bank-perm'), ui.perm);

      ui.selAll = el('input', { type: 'checkbox' });
      ui.selAll.addEventListener('change', () => setAllBanks(ui.selAll.checked));
      ui.count = el('span', { className: 'cbt-bank-count' });
      ui.banks = el('div', { className: 'cbt-bank-checklist' }, emptyNote('Banks load once the panel is connected.'));
      ui.banksBox = el('div', {}, fieldLabel('Banks'),
        el('div', { className: 'cbt-bank-listbar' },
          el('label', { className: 'cbt-bank-selall' }, ui.selAll, 'Select all'), ui.count),
        ui.banks);

      ui.scan = btn('Scan shares', scanShares);
      ui.shares = el('div', { id: 'cbt-bank-shares', className: 'cbt-bank-checklist' },
        emptyNote('Scan to see who has access to the checked banks.'));
      ui.reviewBox = el('div', {}, fieldLabel('Who has access'),
        el('div', { className: 'cbt-bank-listbar' },
          el('p', { className: 'cbt-hint', textContent: 'Scans the checked banks. Access is only removed from banks that are still checked.' }),
          ui.scan),
        ui.shares);

      ui.loadQuizzes = btn('Load quizzes', loadQuizzes);
      ui.quiz = el('select', { id: 'cbt-bank-quiz' },
        el('option', { value: '', textContent: 'Load the quizzes in this course first' }));
      ui.quizSummary = el('p', { className: 'cbt-hint' });
      ui.quizBox = el('div', {}, fieldLabel('Quiz', 'cbt-bank-quiz'), row(ui.quiz, ui.loadQuizzes),
        el('p', { className: 'cbt-hint', textContent: 'Makes a bank named after the quiz and links every question in the quiz to it.' }),
        ui.quizSummary);

      ui.message = el('p', { className: 'cbt-hint cbt-bank-message', role: 'status' });
      ui.go = btn('', showPreview, 'cbt-primary');
      ui.form = el('div', {},
        ui.personBox, ui.permBox, ui.quizBox, ui.banksBox, ui.reviewBox, ui.message,
        el('div', { className: 'cbt-actions' }, btn('Close', closePanel), ui.go));
      ui.step = el('div', { hidden: true }); // the preview, then the progress and summary
      ui.log = el('div', { id: 'cbt-bank-log', role: 'log', hidden: true });

      ui.panel = el('div', { id: 'cbt-bank-panel', className: 'cbt', hidden: true,
        role: 'dialog', ariaLabel: 'Batch Edit item banks' },
        el('div', { className: 'cbt-bank-head' }, ui.title, ui.logToggle),
        ui.status, ui.form, ui.step, ui.log);

      ui.term.addEventListener('keydown', e => { if (e.key === 'Enter') searchPeople(); });
      ui.person.addEventListener('change', syncControls);
      ui.banks.addEventListener('change', syncControls);
      ui.shares.addEventListener('change', syncControls);
      ui.quiz.addEventListener('change', readQuiz);

      document.body.append(ui.panel);
      onCapture = refreshStatus;
      showMode();
      watchPlacement();

      // After "Make a bank from a quiz", the page reloads so the new bank shows; say how it went.
      const saved = store.take();
      if (saved?.toast) toast(saved.toast, 20_000);
    }

    // Loads the banks without being asked, the first time a task that needs them
    // is open and the item bank login is known.
    function autoLoadBanks() {
      if (ui.panel.hidden || mode === 'quiz' || banks.length || busy || banksFailed) return;
      if (!auth.api.Authorization || !bankCourseId()) return; // the status line says what's missing
      loadBanks();
    }

    // ---- Opening, closing and switching tasks ----
    function openMode(key) {
      if (running) return; // the panel is showing a job; it can't be switched mid-run
      mode = key;
      ui.panel.hidden = false;
      launch.setPressed(ui.launch, true);
      showForm();
      showMode();
      banksFailed = false;
      refreshStatus(); // also starts the bank load when it's needed
      if (mode === 'quiz' && !quizzes.length && !busy) loadQuizzes();
      ({ person: ui.term, course: ui.perm, review: ui.scan, quiz: ui.quiz })[mode]?.focus();
    }

    function closePanel() {
      if (running) return;
      ui.panel.hidden = true;
      launch.setPressed(ui.launch, false);
      showForm();
    }

    function showMode() {
      const m = MODES[mode];
      ui.title.textContent = m.label;
      ui.personBox.hidden = mode !== 'person';
      ui.permBox.hidden = mode === 'review' || mode === 'quiz';
      ui.reviewBox.hidden = mode !== 'review';
      ui.quizBox.hidden = mode !== 'quiz';
      ui.banksBox.hidden = mode === 'quiz';
      ui.go.classList.toggle('cbt-danger', !!m.danger);
      setMessage('');
      syncControls();
    }

    function showForm() {
      ui.step.hidden = true;
      ui.step.replaceChildren();
      ui.form.hidden = false;
      syncControls();
    }

    function showStep(...children) {
      ui.form.hidden = true;
      ui.step.replaceChildren(...children);
      ui.step.hidden = false;
    }

    function toggleLog() {
      const show = ui.log.hidden;
      ui.log.hidden = !show;
      ui.logToggle.title = ui.logToggle.ariaLabel = show ? 'Hide log' : 'Show log';
      ui.logToggle.setAttribute('aria-pressed', String(show));
      if (show) ui.log.scrollTop = ui.log.scrollHeight;
    }

    // ---- State of the controls ----
    const bankBoxes = () => [...ui.banks.querySelectorAll('input[type=checkbox]')];
    const checkedBanks = () => bankBoxes().filter(cb => cb.checked).map(cb => banks[Number(cb.value)]);
    const checkedGroups = () => [...ui.shares.querySelectorAll('input:checked')].map(cb => groups[Number(cb.value)])
      .filter(g => g && !g.isSelf);
    const bankName = b => b.title || b.id;

    function syncControls() {
      if (!ui.panel) return;
      ui.term.disabled = ui.search.disabled = ui.perm.disabled = ui.loadQuizzes.disabled = busy;
      ui.person.disabled = busy || !people.length;
      ui.scan.disabled = busy || !banks.length;
      ui.quiz.disabled = busy || !quizzes.length;

      const boxes = bankBoxes();
      const n = boxes.filter(b => b.checked).length;
      boxes.forEach(b => { b.disabled = busy; });
      ui.selAll.disabled = busy || !boxes.length;
      ui.selAll.checked = boxes.length > 0 && n === boxes.length;
      ui.selAll.indeterminate = n > 0 && n < boxes.length;
      ui.count.textContent = boxes.length ? `${n} selected` : '';
      ui.shares.querySelectorAll('input[type=checkbox]').forEach(b => { b.disabled = busy || !!groups[Number(b.value)]?.isSelf; });

      ui.go.textContent = {
        person: n ? `Share ${nBanks(n)}…` : 'Share…',
        course: n ? `Share ${nBanks(n)} with this course…` : 'Share with this course…',
        review: 'Remove access…',
        quiz: 'Create bank and move…',
      }[mode];
      let ready = !busy && !!auth.api.Authorization;
      if (mode === 'quiz') ready &&= !!quizPlan?.moves.length;
      else ready &&= n > 0;
      if (mode === 'person') ready &&= people.length > 0;
      if (mode === 'review') ready &&= checkedGroups().length > 0;
      ui.go.disabled = !ready;
    }

    function setBusy(value) {
      busy = value;
      syncControls();
    }

    function setAllBanks(on) {
      bankBoxes().forEach(b => { b.checked = on; });
      syncControls();
    }

    // A one-line note under the form (problems in orange). Also goes to the log.
    function setMessage(text, warn = false) {
      ui.message.textContent = text;
      ui.message.classList.toggle('cbt-warn', warn);
      if (text) log(text);
    }

    function log(message) {
      debug('item banks:', message);
      if (!ui.log) return;
      ui.log.textContent += message + '\n';
      ui.log.scrollTop = ui.log.scrollHeight;
    }

    // Being connected is the normal state, so nothing shows for it. Anything
    // that needs the user to act appears as a line of text under the title.
    function refreshStatus() {
      if (!ui.panel || ui.panel.hidden) return;
      const connected = !!auth.api.Authorization;
      const namesHint = connected && !auth.lti.Authorization
        ? 'To show names when reviewing shares, open any bank’s Share dialog once.' : '';
      ui.status.replaceChildren(
        connected ? '' : el('span', { className: 'cbt-warn', textContent: 'Not connected yet: click “Share” on any bank, then close that dialog. ' }),
        bankCourseId() ? '' : el('span', { className: 'cbt-warn', textContent: 'Bank course not detected yet. ' }),
        mode === 'review' ? namesHint : '');
      ui.status.hidden = !ui.status.textContent;
      syncControls();
      autoLoadBanks();
    }

    // ---- Placing the launch button ----
    // Docks it just before "+ Bank". Canvas draws that toolbar after the page
    // loads and can redraw it, so a MutationObserver puts the button back
    // whenever it goes missing (and does nothing while it's in place). If
    // "+ Bank" hasn't appeared after a few seconds, the button floats in the
    // corner, and docks later if the toolbar turns up (checked at most once a second).
    // Canvas's "+ Bank" is an icon button: the "+" is an SVG (which can carry
    // its own <title>) and there may be screen-reader-only text beside the
    // label, so the button's whole textContent isn't just "Bank". Instead, look
    // for a text node that reads exactly "Bank" (or "+ Bank") inside a button,
    // link or role=button, and dock next to that control.
    const isBankLabel = text => /^\+?\s*bank$/i.test(text.trim());
    const ours = n => n === ui.launch || ui.panel.contains(n) || !!n.closest('.cbt-menu, .cbt');
    const BANK_BUTTON = '[data-automation="sdk-create-new-bank-button"]'; // New Quizzes' own "+ Bank"
    function findBankButton() {
      const exact = document.querySelector(BANK_BUTTON);
      if (exact) return exact;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: t => (isBankLabel(t.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
      });
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const control = t.parentElement?.closest('button, a, [role="button"]');
        if (control && !ours(control) && !t.parentElement.closest('svg')) return control;
      }
      // Fallback: a control whose accessible name is "Bank" / "Add bank" / "New bank" / "Create bank".
      const named = [...document.querySelectorAll('button[aria-label], a[aria-label], [role="button"][aria-label]')]
        .find(b => !ours(b) && /^(\+|add|new|create)?\s*(a\s+|new\s+)?bank$/i.test(b.getAttribute('aria-label').trim()));
      if (!named) debug('item banks: no "+ Bank" button found yet; frames on the page:', document.querySelectorAll('iframe').length,
        '; buttons on the page:',
        [...document.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent).trim()).filter(Boolean));
      return named || null;
    }

    // Makes the docked button the same height and text size as "+ Bank". In
    // InstUI the visible box is the button's inner content span, so measure that.
    function matchSize(anchor) {
      const box = anchor?.querySelector('[class*="baseButton__content"]') || anchor;
      const height = box?.getBoundingClientRect().height;
      if (!height) {
        Object.assign(ui.launch.style, { boxSizing: '', height: '', minHeight: '', fontSize: '', position: '', top: '' });
        return;
      }
      Object.assign(ui.launch.style, {
        boxSizing: 'border-box',
        height: `${height}px`,
        minHeight: '0',
        fontSize: getComputedStyle(anchor.querySelector('[class*="baseButton__children"]') || box).fontSize,
        position: 'relative',
        top: '0px',
      });
      // Line its top up with the visible "+ Bank" box. Centring in the row can
      // leave it a few pixels off, because "+ Bank"'s outer <button> isn't the same box.
      const shift = box.getBoundingClientRect().top - ui.launch.getBoundingClientRect().top;
      if (Math.abs(shift) < 40) ui.launch.style.top = `${Math.round(shift * 2) / 2}px`;
    }

    function queuePlace(delay = 0) {
      if (placeTimer) return;
      placeTimer = setTimeout(() => { placeTimer = null; placeLaunch(); }, delay);
    }

    function placeLaunch() {
      if (!PAGE_RE.test(location.pathname)) {
        ui.launch.hidden = true;
        closePanel();
        return;
      }
      const anchor = findBankButton();
      if (anchor) {
        launch.dock(ui.launch, anchor);
        matchSize(anchor);
        setTimeout(() => { if (anchor.isConnected) matchSize(anchor); }, 1000); // again once fonts have settled
      } else if (Date.now() - startedAt >= FLOAT_AFTER_MS) {
        launch.float(ui.launch);
        matchSize(null);
      }
      else queuePlace(500);
      ui.launch.hidden = !ui.launch.isConnected;
    }

    function watchPlacement() {
      placeLaunch();
      new MutationObserver(() => {
        if (!PAGE_RE.test(location.pathname)) { if (!ui.launch.hidden) queuePlace(); return; }
        if (!ui.launch.isConnected) queuePlace();
        else if (ui.launch.classList.contains('cbt-floating')) queuePlace(1000);
      }).observe(document.body, { childList: true, subtree: true });
    }

    // ---- Loading people, banks and shares ----
    async function searchPeople() {
      if (busy) return;
      const term = ui.term.value.trim();
      if (term.length < 2) return setMessage('Type at least 2 characters to search.', true);
      setMessage('');
      setBusy(true);
      try {
        const roles = SHAREABLE_ROLES.map(r => `&enrollment_type[]=${r}`).join('');
        const users = await canvas.get(`/api/v1/courses/${courseId()}/users?search_term=${encodeURIComponent(term)}` +
          `${roles}&include[]=uuid&include[]=email&include[]=avatar_url&per_page=20`);
        people = Array.isArray(users) ? users.filter(u => u.uuid) : [];
        ui.person.replaceChildren(...(people.length
          ? people.map((u, i) => el('option', { value: i, textContent: `${u.name} (${u.email || u.login_id || 'no email'})` }))
          : [el('option', { textContent: 'No match. Only teachers, TAs, and designers in this course can be added.' })]));
        log(people.length ? `Found ${people.length} match${people.length === 1 ? '' : 'es'} for “${term}”.`
          : `No teacher, TA, or designer matched “${term}”.`);
      } catch (e) {
        setMessage(`Search failed: ${e.message}.`, true);
      } finally {
        setBusy(false);
      }
    }

    async function fetchBanks(bankCourse) {
      const out = [];
      const seen = new Set();
      for (let page = 1; page <= 50; page++) {
        const r = await quizFetch('api', `/banks?page=${page}&course_id=${encodeURIComponent(bankCourse)}`);
        if (!r.ok) throw new Error(`bank list returned ${r.status}${r.status === 401 ? ' (login expired, reload the page)' : ''}`);
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.banks || data.data || []);
        // Stop when a page brings nothing new, so a server that ignores `page`
        // (or sends no paging headers) can't fill the list with repeats.
        const fresh = list.filter(b => !seen.has(String(b.id)));
        fresh.forEach(b => seen.add(String(b.id)));
        out.push(...fresh);
        const total = Number(r.headers.get('total'));
        const perPage = Number(r.headers.get('per-page'));
        if (!fresh.length || (total && out.length >= total) || (perPage && list.length < perPage)) break;
      }
      return out;
    }

    async function loadBanks() {
      const bankCourse = bankCourseId();
      if (!auth.api.Authorization) return setMessage(NOT_CONNECTED, true);
      if (!bankCourse) return setMessage(NO_BANK_COURSE, true);
      setMessage('');
      setBusy(true);
      banks = [];
      groups = [];
      // Clear the old checkboxes first, so a failed load can't leave them pointing at the wrong banks.
      ui.banks.replaceChildren(emptyNote('Loading banks…'));
      ui.shares.replaceChildren(emptyNote('Scan to see who has access to the checked banks.'));
      try {
        banks = await fetchBanks(bankCourse);
        ui.banks.replaceChildren(...(banks.length
          ? banks.map((b, i) => checkRow(el('input', { type: 'checkbox', checked: true, value: i }), b.title || `Bank ${b.id}`))
          : [emptyNote('No banks found in this course.')]));
        log(`Loaded ${nBanks(banks.length)}.`);
      } catch (e) {
        banks = [];
        banksFailed = true;
        ui.banks.replaceChildren(emptyNote('Banks couldn’t be loaded. Pick the task from Batch Edit again to retry.'));
        setMessage(`Couldn’t load banks: ${e.message}.`, true);
      } finally {
        setBusy(false);
      }
    }

    async function scanShares() {
      const selected = checkedBanks();
      if (!selected.length) return setMessage('Check at least one bank to scan.', true);
      setMessage('');
      setBusy(true);
      groups = [];
      ui.shares.replaceChildren(emptyNote('Scanning…'));
      let failedScans = 0;
      try {
        const bankCourse = bankCourseId();
        const [self, thisCourse] = await Promise.all([whoAmI(), courseInfo().catch(() => ({}))]);
        const sameId = (a, b) => a != null && b != null && String(a) === String(b);
        const isThisCourse = id => sameId(id, bankCourse) || sameId(id, thisCourse.uuid);

        // Reads run a few at a time; results keep bank order.
        let done = 0;
        const lists = await mapLimit(selected, SCAN_CONCURRENCY, async b => {
          try {
            return await shareApi.list(b.id);
          } catch (e) {
            failedScans++;
            log(`Couldn’t scan ${bankName(b)} (${e.message})`);
            return [];
          } finally {
            if (++done % 10 === 0) ui.shares.replaceChildren(emptyNote(`Scanning… ${done} of ${selected.length} banks`));
          }
        });

        const byEntity = new Map();
        selected.forEach((b, i) => {
          for (const s of lists[i]) {
            if (s.permission === REMOVED) continue;
            const id = String(s.entity_type === 'course' && sameId(s.entity_id, thisCourse.uuid)
              ? (bankCourse || s.entity_id) : s.entity_id);
            const key = `${s.entity_type}:${id}`;
            if (!byEntity.has(key)) byEntity.set(key, { type: s.entity_type, id, shares: [] });
            // Keep the bank id from the scan rather than relying on the share's own bank_id.
            byEntity.get(key).shares.push({ ...s, bankId: String(b.id), bankTitle: bankName(b) });
          }
        });
        groups = [...byEntity.values()];

        ui.shares.replaceChildren(emptyNote('Looking up names…'));
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
            (sameId(g.id, self.uuid) || (!!self.email && email === self.email));
        }
        groups.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'course' ? -1 : 1));

        ui.shares.replaceChildren(...(groups.length ? groups.map(renderGroup) : [emptyNote('No one else has access to the checked banks.')]));
        log(`Scanned ${nBanks(selected.length)}: ${groups.length} ${groups.length === 1 ? 'person or course has' : 'people or courses have'} access.`);
        if (failedScans) setMessage(`Couldn’t scan ${nBanks(failedScans)}. Show the log for details.`, true);
      } catch (e) {
        ui.shares.replaceChildren(emptyNote('Scan failed.'));
        setMessage(`Scan failed: ${e.message}.`, true);
      } finally {
        setBusy(false);
      }
    }

    function renderGroup(g, i) {
      const n = g.shares.length;
      const perms = [...new Set(g.shares.map(s => PERM_LABEL[s.permission] || s.permission))].join(' / ');
      const kind = g.type === 'course' ? 'Course' : 'Person';
      const label = checkRow(el('input', { type: 'checkbox', value: i, disabled: g.isSelf }),
        el('strong', { textContent: g.name + (g.isSelf ? ' (you)' : '') }),
        el('span', { className: 'cbt-sub', textContent:
          `${kind}, ${nBanks(n)}, ${perms}${g.isSelf ? '. Your own access can’t be removed here.' : ''}` }));
      label.title = g.shares.map(s => s.bankTitle).join('\n');
      if (g.isSelf) label.classList.add('cbt-bank-self');
      return label;
    }

    // ---- Preview, then run ----
    function showPreview() {
      setMessage('');
      if (!auth.api.Authorization) return setMessage(NOT_CONNECTED, true);
      return ({ person: previewPerson, course: previewCourse, review: previewRemove, quiz: previewQuiz })[mode]();
    }

    // Shows what will happen, with Back and the button that does it.
    function preview({ heading, hint, warn, list = [], button, danger, working, run }) {
      const go = btn(button, () => runJob(working, run), 'cbt-primary' + (danger ? ' cbt-danger' : ''));
      showStep(
        el('h3', { textContent: heading }),
        hint ? el('p', { className: 'cbt-hint', textContent: hint }) : '',
        warn ? el('p', { className: 'cbt-hint cbt-warn', textContent: warn }) : '',
        ...list,
        el('div', { className: 'cbt-actions' }, btn('Back', showForm), go));
      go.focus();
    }

    // Runs a job with a progress bar and Stop. run(ctx) returns the summary line.
    //   ctx.step(text)          what's happening now (progress bar goes indeterminate)
    //   ctx.progress(done, of)  "N of M done"
    //   ctx.note(text, warn)    a line kept under the progress bar
    //   ctx.stopped             true once Stop was pressed
    async function runJob(working, run) {
      stopRequested = false;
      running = true;
      setBusy(true);
      const heading = el('h3', { textContent: working });
      const bar = el('progress');
      const status = el('p', { className: 'cbt-hint', role: 'status' });
      const notes = el('div');
      const stop = btn('Stop', () => {
        stopRequested = true;
        stop.disabled = true;
        stop.textContent = 'Stopping…';
      });
      const actions = el('div', { className: 'cbt-actions' }, stop);
      showStep(heading, bar, status, notes, actions);
      stop.focus();
      log(working);

      const noteTexts = [];
      reloadAfterRun = false;
      const ctx = {
        step(text) { bar.removeAttribute('value'); status.textContent = text; log(text); },
        progress(done, total) { bar.max = Math.max(total, 1); bar.value = done; status.textContent = `${done} of ${total} done`; },
        note(text, warn = false) {
          notes.append(el('p', { className: 'cbt-hint' + (warn ? ' cbt-warn' : ''), textContent: text }));
          log(text);
          noteTexts.push(text);
        },
        get stopped() { return stopRequested; },
      };

      let summary;
      job.start();
      try {
        summary = await run(ctx);
      } catch (e) {
        summary = `Stopped: ${e.message}.`;
      } finally {
        job.end();
        running = false;
        setBusy(false);
      }
      log(summary);
      // Reload so Canvas's own list shows the change; the summary comes back as a toast.
      if (reloadAfterRun && store.write({ toast: [summary, ...noteTexts].join(' ') })) {
        heading.textContent = `${summary} Reloading…`;
        location.reload();
        return;
      }
      heading.textContent = summary;
      if (!bar.hasAttribute('value')) { bar.max = 1; bar.value = 1; }
      status.textContent = '';
      const ok = btn('OK', showForm, 'cbt-primary');
      actions.replaceChildren(ok);
      ok.focus();
    }

    const sharePreviewList = selected => [nameList(selected.map(b => [bankName(b)]))];

    function previewPerson() {
      const selected = checkedBanks();
      const u = people[Number(ui.person.value)];
      if (!selected.length || !u) return;
      const permission = ui.perm.value;
      const label = PERM_LABEL[permission];
      preview({
        heading: `Share ${nBanks(selected.length)} with ${u.name}`,
        hint: `${u.name} gets “${label}” access. Banks already shared with them are switched to “${label}”.`,
        list: sharePreviewList(selected),
        button: `Share ${nBanks(selected.length)}`,
        working: `Sharing ${nBanks(selected.length)} with ${u.name}…`,
        run: ctx => shareWithPerson(ctx, selected, u, permission),
      });
    }

    async function previewCourse() {
      const selected = checkedBanks();
      if (!selected.length) return;
      const bankCourse = bankCourseId();
      if (!bankCourse) return setMessage(NO_BANK_COURSE, true);
      let course;
      setBusy(true);
      try {
        course = await courseInfo();
      } catch (e) {
        return setMessage(`Couldn’t look up this course in Canvas: ${e.message}.`, true);
      } finally {
        setBusy(false);
      }
      if (!course?.uuid) return setMessage('Couldn’t look up this course in Canvas.', true);
      const permission = ui.perm.value;
      const label = PERM_LABEL[permission];
      preview({
        heading: `Share ${nBanks(selected.length)} with this course`,
        hint: `Teachers in ${course.name} get “${label}” access. Banks already shared with this course are switched to “${label}”.`,
        list: sharePreviewList(selected),
        button: `Share ${nBanks(selected.length)}`,
        working: `Sharing ${nBanks(selected.length)} with this course…`,
        run: ctx => applyShares(ctx, selected, 'course', [bankCourse, course.uuid], course.uuid, permission),
      });
    }

    async function shareWithPerson(ctx, selected, u, permission) {
      const user = { uuid: u.uuid, full_name: u.name, email: u.email, avatar_image_url: u.avatar_url };
      ctx.step(`Registering ${u.name} with item banks…`);
      const reg = await quizFetch('lti', '/users', { method: 'POST', body: user });
      if (!reg.ok) ctx.note(`Couldn’t register ${u.name} with item banks (${reg.status}). Shared anyway.`, true);
      return applyShares(ctx, selected, 'user', [user.uuid], user.uuid, permission);
    }

    async function applyShares(ctx, selected, entityType, matchIds, postId, permission) {
      const label = PERM_LABEL[permission];
      const counts = { added: 0, changed: 0, unchanged: 0, failed: 0 };
      let done = 0;
      ctx.progress(0, selected.length);
      for (const [i, b] of selected.entries()) {
        if (ctx.stopped) break;
        const name = bankName(b);
        let wrote = true;
        try {
          const { result, status } = await shareApi.upsert(b, entityType, matchIds, postId, permission);
          counts[result]++;
          wrote = result !== 'unchanged';
          log({
            added: `Shared: ${name} (${label})`,
            changed: `Changed: ${name} (now ${label})`,
            unchanged: `Already set: ${name} (${label})`,
            failed: `Failed: ${name} (${status})`,
          }[result]);
        } catch (e) {
          counts.failed++;
          log(`Failed: ${name} (${e.message})`);
        }
        ctx.progress(++done, selected.length);
        // Pause only after a write, and not after the last bank.
        if (wrote && i < selected.length - 1) await sleep(PAUSE_WRITE_MS);
      }
      const parts = [`${counts.added} shared`];
      if (counts.changed) parts.push(`${counts.changed} changed`);
      if (counts.unchanged) parts.push(`${counts.unchanged} already set`);
      if (counts.failed) parts.push(`${counts.failed} failed`);
      if (done < selected.length) parts.push(`${selected.length - done} not attempted`);
      return `${ctx.stopped ? 'Stopped' : 'Done'}: ${parts.join(', ')}.`;
    }

    function previewRemove() {
      const keep = new Set(checkedBanks().map(b => String(b.id)));
      const chosen = checkedGroups();
      const jobs = chosen.flatMap(g => g.shares.filter(s => keep.has(s.bankId)).map(s => ({ g, s })));
      if (!jobs.length) return setMessage('Nothing to remove: none of the chosen people or courses have access to a checked bank.', true);

      const touched = [...new Set(jobs.map(j => j.g))];
      const nPeople = touched.filter(g => g.type !== 'course').length;
      const nCourses = touched.length - nPeople;
      const who = [
        nPeople ? `${nPeople} ${nPeople === 1 ? 'person' : 'people'}` : '',
        nCourses ? `${nCourses} course${plural(nCourses)}` : '',
      ].filter(Boolean).join(' and ');
      preview({
        heading: `Remove access for ${who}`,
        hint: 'This can be undone by sharing again.',
        list: [nameList(touched.map(g => {
          const titles = jobs.filter(j => j.g === g).map(j => j.s.bankTitle);
          return [g.name, `${nBanks(titles.length)}: ${titles.join(' · ')}`];
        }))],
        button: `Remove ${jobs.length} share${plural(jobs.length)}`,
        danger: true,
        working: 'Removing access…',
        run: ctx => removeShares(ctx, jobs),
      });
    }

    async function removeShares(ctx, jobs) {
      let ok = 0, failed = 0, done = 0;
      ctx.progress(0, jobs.length);
      await paced(jobs, PAUSE_WRITE_MS, async ({ g, s }) => {
        if (ctx.stopped) return false;
        try {
          const r = await shareApi.update(s.bankId, s.id, REMOVED);
          if (r.ok) ok++;
          else failed++;
          log(r.ok ? `Removed: ${g.name} from ${s.bankTitle}` : `Failed: ${g.name} from ${s.bankTitle} (${r.status})`);
        } catch (e) {
          failed++;
          log(`Failed: ${g.name} from ${s.bankTitle} (${e.message})`);
        }
        ctx.progress(++done, jobs.length);
        return true;
      });
      const parts = [`${ok} removed`];
      if (failed) parts.push(`${failed} failed`);
      if (done < jobs.length) parts.push(`${jobs.length - done} not attempted`);
      const summary = `${ctx.stopped ? 'Stopped' : 'Done'}: ${parts.join(', ')}.`;
      // Rescan instead of trusting the responses: revoking access is worth verifying.
      ctx.step('Rescanning to confirm…');
      await scanShares();
      ctx.note('The “Who has access” list has been rescanned.');
      return summary;
    }

    // ---- Move a New Quiz's questions into a new bank ----
    // Does what the quiz editor's own "add to item bank" does, for every
    // question at once: each question stays in the quiz but now lives in the
    // bank, so the quiz uses the banked question instead of a copy.
    //   - The preview reads the quiz through Canvas's public New Quiz Items API.
    //   - The bank is created with the item bank login captured on this page.
    //   - The questions are moved with the quiz editor's own login, which
    //     New Quizzes hands out when the quiz is opened (newQuizzes.buildLogin).

    // Text of a question's HTML, for naming it in the log. DOMParser runs no scripts.
    const textOf = html => (new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent || '')
      .replace(/\s+/g, ' ').trim();
    const shortName = (title, html, fallback) => {
      const t = String(title || '').trim() || textOf(html);
      return t ? (t.length > 60 ? t.slice(0, 57) + '…' : t) : fallback;
    };

    // Sorts a quiz's entries into what will be moved and what's left alone.
    // Works on both the public API's rows and New Quizzes' own quiz_entries rows.
    function planQuizMove(rows) {
      const list = (Array.isArray(rows) ? rows : []).map(r => r?.quiz_entry ?? r).filter(Boolean)
        .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
      const moves = [];
      const skipped = [];
      list.forEach((r, i) => {
        const entry = r.entry || {};
        const kind = String(r.entry_type || '');
        const name = kind === 'Stimulus'
          ? `Stimulus: ${shortName(entry.title, entry.body, `#${i + 1}`)}`
          : shortName(entry.title, entry.item_body, `Question ${i + 1}`);
        const sourceId = entry.id ?? r.entry_id;
        const quizEntryId = r.id;
        if (kind === 'Item' || kind === 'Stimulus') {
          moves.push({ kind, name, sourceId: sourceId == null ? null : String(sourceId),
            quizEntryId: quizEntryId == null ? null : String(quizEntryId),
            underStimulus: r.stimulus_quiz_entry_id != null });
        } else if (kind === 'BankEntry') {
          skipped.push({ name, reason: 'already comes from a bank' });
        } else if (kind === 'Bank') {
          skipped.push({ name: entry.title ? `Random set from "${entry.title}"` : 'Random set from a bank',
            reason: 'already comes from a bank' });
        } else {
          skipped.push({ name, reason: `unknown entry type "${kind || 'none'}"` });
        }
      });
      return { moves, skipped };
    }

    async function loadQuizzes() {
      if (busy) return;
      setBusy(true);
      quizzes = [];
      quizPlan = null;
      ui.quizSummary.replaceChildren();
      ui.quiz.replaceChildren(el('option', { value: '', textContent: 'Loading quizzes…' }));
      try {
        const list = await canvas.getAll(`/api/quiz/v1/courses/${courseId()}/quizzes`);
        quizzes = (Array.isArray(list) ? list : []).filter(q => q?.id)
          .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
        ui.quiz.replaceChildren(
          el('option', { value: '', textContent: quizzes.length ? 'Choose a quiz' : 'No quizzes in this course' }),
          ...quizzes.map((q, i) => el('option', { value: String(i), textContent: q.title || `Quiz ${q.id}` })));
        log(`Found ${quizzes.length} quiz${quizzes.length === 1 ? '' : 'zes'} in this course.`);
      } catch (e) {
        ui.quiz.replaceChildren(el('option', { value: '', textContent: 'Couldn’t load quizzes. Try Load quizzes again.' }));
        setMessage(`Couldn’t load quizzes: ${e.message}.`, true);
      } finally {
        setBusy(false);
      }
    }

    async function readQuiz() {
      quizPlan = null;
      ui.quizSummary.replaceChildren();
      setMessage('');
      const quiz = ui.quiz.value === '' ? null : quizzes[Number(ui.quiz.value)];
      if (!quiz) return syncControls();
      setBusy(true);
      ui.quizSummary.textContent = 'Reading the quiz…';
      try {
        const items = await canvas.getAll(`/api/quiz/v1/courses/${courseId()}/quizzes/${quiz.id}/items`);
        quizPlan = { quiz, ...planQuizMove(items) };
        renderQuizSummary(quizPlan);
      } catch (e) {
        ui.quizSummary.textContent = 'Couldn’t read this quiz.';
        setMessage(`Couldn’t read “${quiz.title}”: ${e.message}.`, true);
      } finally {
        setBusy(false);
      }
    }

    function renderQuizSummary({ moves, skipped }) {
      const k = skipped.length;
      ui.quizSummary.textContent = moves.length
        ? `Will move ${describeMoves(moves)} into the new bank.` +
          (k ? ` ${nEntries(k)} already ${k === 1 ? 'comes' : 'come'} from a bank and will be left as ${k === 1 ? 'it is' : 'they are'}.` : '')
        : 'Every question in this quiz already comes from a bank.';
    }

    async function postToBanks(path, body, what) {
      const r = await quizFetch('api', path, { method: 'POST', body });
      if (!r.ok) throw Object.assign(new Error(`${what} failed (${r.status}${await errorDetail(r)})`), { status: r.status });
      return r.json().catch(() => ({}));
    }

    async function errorDetail(r) {
      const text = await r.text().catch(() => '');
      const detail = text.match(/"(?:message|error)"\s*:\s*"([^"]{1,150})"/)?.[1];
      return detail ? `: ${detail}` : '';
    }

    async function createBank(title, bankCourse, ctx) {
      const res = await postToBanks('/banks', { bank: { title, language: 'en' } }, 'Creating the bank');
      const id = res?.bank?.id ?? res?.id;
      if (id == null) throw new Error("the item bank service didn't say which bank it created");
      // Canvas's own Item Banks page shares a new bank with the course it was made in;
      // without that the bank belongs to you alone and this course's bank list doesn't show it.
      try {
        await postToBanks(`/banks/${id}/shared_banks`, {
          shared_bank: { entity_id: bankCourse, entityType: 'course', bank_id: String(id), permission: 'read' },
        }, 'Adding the bank to this course');
      } catch (e) {
        ctx.note(`${e.message}. The bank was made but may only show under your own banks.`, true);
      }
      return String(id);
    }

    async function countBankEntries(bankId) {
      let total = 0;
      for (let page = 1; page <= 50; page++) {
        const r = await quizFetch('api', `/banks/${bankId}/bank_entries?page=${page}&per_page=100`);
        if (!r.ok) return null;
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.bank_entries || data.data || []);
        if (!list.length) break;
        total += list.length;
        if (list.length < 100) break;
      }
      return total;
    }

    async function previewQuiz() {
      const plan = quizPlan;
      if (busy || !plan?.moves.length) return;
      const bankCourse = bankCourseId();
      if (!bankCourse) return setMessage(NO_BANK_COURSE, true);
      const title = String(plan.quiz.title || `Quiz ${plan.quiz.id}`).trim();

      setBusy(true);
      let existing = [];
      try {
        existing = (await fetchBanks(bankCourse)).filter(b => String(b.title || '').trim() === title);
      } catch { /* the warning below just won't show */ }
      setBusy(false);

      const k = plan.skipped.length;
      preview({
        heading: `Move ${describeMoves(plan.moves)} into a new bank`,
        hint: `Makes a bank named “${title}” and moves each question into it, the same as using “add to item bank” ` +
          'on it in the quiz editor. Each question stays in the quiz but now comes from the bank, so editing it in the bank changes it in the quiz.',
        warn: existing.length ? `This course already has a bank named “${title}”. A second bank with the same name will be made.` : '',
        list: k ? [fieldLabel(`Left as they are (${k})`), nameList(plan.skipped.map(s => [s.name, s.reason]))] : [],
        button: `Create bank and move ${describeMoves(plan.moves)}`,
        working: `Moving into “${title}”…`,
        run: ctx => moveQuizToBank(ctx, plan, title, bankCourse),
      });
    }

    async function moveQuizToBank(ctx, plan, title, bankCourse) {
      const n = plan.moves.length;
      let moved = 0, failed = 0, done = 0, total = n;
      let bankMade = false;
      let stimulusFailed = false;
      try {
        const step = (label, fn) => { ctx.step(label + '…'); return fn(); };
        const conn = await newQuizzes.connect(plan.quiz.id, step);
        ctx.step('Getting the quiz editor’s login…');
        const editor = await newQuizzes.buildLogin(conn, step);

        // New Quizzes' own ids for the questions (the public API's can differ).
        const fresh = planQuizMove(await newQuizzes.quizEntries(editor));
        if (!fresh.moves.length) throw new Error('Canvas listed no questions to move in this quiz');
        if (fresh.moves.length !== n) ctx.note(`The quiz now has ${nEntries(fresh.moves.length)} to move (the preview showed ${n}).`);
        if (ctx.stopped) return 'Stopped before anything was changed.';

        ctx.step(`Creating the bank “${title}”…`);
        const bankId = await createBank(title, bankCourse, ctx);
        bankMade = true;
        reloadAfterRun = true; // the new bank should appear in Canvas's list
        log('Bank created. Moving the questions…');

        total = fresh.moves.length;
        ctx.progress(0, total);
        await paced(fresh.moves, PAUSE_WRITE_MS, async (m, i) => {
          if (ctx.stopped) return false;
          const label = `${i + 1}/${total} ${m.name}`;
          try {
            if (!m.sourceId || !m.quizEntryId) throw new Error("Canvas didn't give this entry's id");
            await newQuizzes.moveToBank(editor, bankId, m);
            moved++;
            log(`Moved: ${label}`);
          } catch (e) {
            failed++;
            if (m.underStimulus) stimulusFailed = true;
            log(`Failed: ${label} (${e.message})`);
            if (e.status === 401) {
              ctx.note('A login expired. Reload the page and move the rest from the quiz editor, ' +
                'or delete the new bank and run this again.', true);
              ctx.progress(++done, total);
              return false;
            }
          }
          ctx.progress(++done, total);
          return true;
        });

        if (stimulusFailed) ctx.note('Some failed questions sit under a stimulus and may have moved with it. Check the bank’s count.', true);
        const inBank = await countBankEntries(bankId).catch(() => null);
        if (inBank != null) ctx.note(`The bank now holds ${nEntries(inBank)}.`);
        const parts = [`${moved} moved into “${title}”`];
        if (failed) parts.push(`${failed} failed`);
        if (done < total) parts.push(`${total - done} not attempted`);
        return `${ctx.stopped ? 'Stopped' : 'Done'}: ${parts.join(', ')}.`;
      } catch (e) {
        return `Stopped: ${e.message}.` + (bankMade ? '' : ' Nothing was changed.');
      }
    }


    return {
      name: 'Item Bank Sharing',
      matches: path => PAGE_RE.test(path),
      early: installCapture,
      init: buildUI,
    };
  }

  register(createItemBankFeature);
})();

