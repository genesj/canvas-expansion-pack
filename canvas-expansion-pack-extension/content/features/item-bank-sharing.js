// Canvas Expansion Pack: Item Bank Sharing (see the notes at the top of core.js).
//
// The Item Banks page's "Bulk Item Bank Editor" panel: share banks with a
// person or this course, review or remove shares, and move a New Quiz's
// questions into a new bank of the same name.

(() => {
  'use strict';

  const {
    btn, canvas, chunk, courseId, el, job, launch, mapLimit, nativeFetch, newQuizzes, paced, plural, quizHosts,
    sleep, addStyles, register,
  } = window.__canvasExpansionPack;

  addStyles(String.raw`
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
    #cbt-bank-panel .cbt-bank-quiz-summary { margin-top: 8px; font-size: 13px; }
    #cbt-bank-panel .cbt-bank-quiz-summary ul { margin: 4px 0 0 18px; padding: 0; }
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
    const MISSES_BEFORE_FLOAT = 5;
    const FLOATING_RECHECK_TICKS = 5;
    // People search only offers these roles, so a bank (and its answer key)
    // can't be shared with a student by picking the wrong name.
    const SHAREABLE_ROLES = ['teacher', 'ta', 'designer'];

    const MODES = {
      person: { label: 'Share with a person', action: 'Share banks' },
      course: { label: 'Share with this course', action: 'Share with course' },
      review: { label: 'Review or remove current shares', action: 'Remove access', danger: true },
      quiz: { label: 'Move a New Quiz’s questions into a new bank', action: 'Create bank and move' },
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
    const ui = {};
    let people = [];
    let banks = [];
    let groups = [];
    let quizzes = [];
    let quizPlan = null; // { quiz, moves, skipped } for the quiz picked in "Move a New Quiz"
    let busy = false;
    let anchorMisses = 0;
    let floatingTicks = 0;

    function buildUI() {
      ui.launch = launch.create('cbt-bank-launch', 'Bulk Item Bank Editor', togglePanel);
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

      ui.loadQuizzes = btn('Load quizzes', loadQuizzes);
      ui.quiz = el('select', { id: 'cbt-bank-quiz' },
        el('option', { value: '', textContent: 'Load the New Quizzes in this course first' }));
      ui.quizSummary = el('div', { className: 'cbt-bank-quiz-summary' });
      ui.quizBox = el('div', { hidden: true },
        el('label', { htmlFor: 'cbt-bank-quiz', textContent: 'New Quiz' }),
        el('div', { className: 'cbt-bank-row' }, ui.quiz, ui.loadQuizzes),
        el('div', { className: 'cbt-hint', textContent:
          'Makes a bank with the quiz\u2019s name and moves every question into it, like using ' +
          '\u201cadd to item bank\u201d on each one in the quiz editor. The questions stay in the quiz, now linked to the bank.' }),
        ui.quizSummary);

      ui.share = btn(MODES.person.action, runAction, 'cbt-primary');
      ui.log = el('div', { id: 'cbt-bank-log', role: 'log', ariaLive: 'polite' });

      ui.panel = el('div', { id: 'cbt-bank-panel', className: 'cbt', hidden: true,
        role: 'dialog', ariaLabel: 'Bulk Item Bank Editor' },
        el('h2', { textContent: 'Bulk Item Bank Editor' }),
        ui.status,
        el('label', { htmlFor: 'cbt-bank-target', textContent: 'What do you want to do?' }),
        ui.target,
        ui.courseHint,
        ui.personBox,
        ui.permBox,
        ui.quizBox,
        ui.banksBox = el('div', {},
          el('label', { textContent: 'Banks' }),
          el('div', { className: 'cbt-bank-row' }, ui.loadBanks, ui.toggleAll),
          ui.banks),
        ui.reviewBox,
        el('div', { className: 'cbt-actions' }, btn('Close', togglePanel), ui.share),
        ui.log);

      ui.target.addEventListener('change', onTargetChange);
      ui.term.addEventListener('keydown', e => { if (e.key === 'Enter') searchPeople(); });
      ui.person.addEventListener('change', syncControls);
      ui.banks.addEventListener('change', syncControls);
      ui.shares.addEventListener('change', syncControls);
      ui.quiz.addEventListener('change', readQuiz);

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
      ui.loadQuizzes.disabled = busy;
      ui.quiz.disabled = busy || !quizzes.length;
      if (mode === 'quiz') {
        ui.share.disabled = busy || !auth.api.Authorization || !quizPlan?.moves.length;
        return;
      }
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
      ui.permBox.hidden = mode === 'review' || mode === 'quiz';
      ui.reviewBox.hidden = mode !== 'review';
      ui.quizBox.hidden = mode !== 'quiz';
      ui.banksBox.hidden = mode === 'quiz';
      if (mode === 'quiz' && !quizzes.length && !busy) loadQuizzes();
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

    async function fetchBanks(bankCourse) {
      const out = [];
      const seen = new Set();
      for (let page = 1; page <= 50; page++) {
        const r = await quizFetch('api', `/banks?page=${page}&course_id=${encodeURIComponent(bankCourse)}`);
        if (!r.ok) throw new Error(`bank list returned ${r.status}${r.status === 401 ? ' (token expired, reload the page)' : ''}`);
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
      if (!auth.api.Authorization) return log('No token yet. Click "Share" on any bank, close it, then try again.');
      if (!bankCourse) return log('Bank course not detected. Reload the Item Banks page and try again.');
      setBusy(true);
      banks = [];
      groups = [];
      // Clear the old checkboxes first, so a failed load can't leave them pointing at the wrong banks.
      ui.banks.replaceChildren('Loading banks…');
      ui.shares.replaceChildren('Load banks, then scan to see who has access.');
      try {
        banks = await fetchBanks(bankCourse);
        ui.banks.replaceChildren(...(banks.length
          ? banks.map((b, i) => el('label', {}, el('input', { type: 'checkbox', checked: true, value: i }), b.title || `Bank ${b.id}`))
          : ['No banks found in this course.']));
        ui.toggleAll.textContent = 'Select none';
        log(`Loaded ${banks.length} bank(s).`);
      } catch (e) {
        banks = [];
        ui.banks.replaceChildren('Banks couldn’t be loaded. Try Load banks again.');
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
      if (mode === 'quiz') return moveQuizToBank();
      return mode === 'review' ? removeShares() : shareBanks(mode);
    }

    async function shareBanks(mode) {
      const selected = checkedBanks();
      if (!selected.length) return;
      const permission = ui.perm.value;
      setBusy(true);
      job.start();
      try {
        if (mode === 'course') await shareWithCourse(selected, permission);
        else await shareWithPerson(selected, permission);
      } catch (e) {
        log('Sharing stopped: ' + e.message);
      } finally {
        job.end();
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
      log(reg.ok
        ? `Registered ${u.name} with item banks.`
        : `⚠️ Couldn't register ${u.name} with item banks (${reg.status}). Trying to share anyway.`);
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
        const sameId = (a, b) => a != null && b != null && String(a) === String(b);
        const isThisCourse = id => sameId(id, bankCourse) || sameId(id, thisCourse.uuid);

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
            const id = String(s.entity_type === 'course' && sameId(s.entity_id, thisCourse.uuid)
              ? (bankCourse || s.entity_id) : s.entity_id);
            const key = `${s.entity_type}:${id}`;
            if (!byEntity.has(key)) byEntity.set(key, { type: s.entity_type, id, shares: [] });
            // Keep the bank id from the scan rather than relying on the share's own bank_id.
            byEntity.get(key).shares.push({ ...s, bankId: String(b.id), bankTitle: bankName(b) });
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
            (sameId(g.id, self.uuid) || (!!self.email && email === self.email));
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
      const jobs = chosen.flatMap(g => g.shares.filter(s => keep.has(s.bankId)).map(s => ({ g, s })));
      if (!jobs.length) return log('Nothing to remove: none of the chosen shares are on checked banks.');

      const perGroup = new Map();
      jobs.forEach(({ g }) => perGroup.set(g, (perGroup.get(g) || 0) + 1));
      const summary = [...perGroup].map(([g, n]) => `• ${g.name}: ${n} bank${plural(n)}`).join('\n');
      if (!confirm(`Remove access?\n\n${summary}\n\nThis can be undone by sharing again.`)) return;

      setBusy(true);
      job.start();
      let ok = 0, failed = 0;
      try {
        await paced(jobs, PAUSE_WRITE_MS, async ({ g, s }) => {
          const r = await shareApi.update(s.bankId, s.id, REMOVED);
          if (r.ok) ok++;
          else failed++;
          log(`${r.ok ? '🗑️' : '❌'} ${g.name} removed from ${s.bankTitle}${r.ok ? '' : ` (${r.status})`}`);
        });
        log(`Done: ${ok} removed${failed ? `, ${failed} failed` : ''}. Rescanning to confirm…`);
      } catch (e) {
        log('Removal stopped: ' + e.message);
      } finally {
        job.end();
        setBusy(false);
      }
      // Rescan instead of trusting the responses: revoking access is worth verifying.
      await scanShares();
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
      ui.quiz.replaceChildren(el('option', { value: '', textContent: 'Loading New Quizzes…' }));
      try {
        const list = await canvas.getAll(`/api/quiz/v1/courses/${courseId()}/quizzes`);
        quizzes = (Array.isArray(list) ? list : []).filter(q => q?.id)
          .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
        ui.quiz.replaceChildren(
          el('option', { value: '', textContent: quizzes.length ? 'Choose a quiz' : 'No New Quizzes in this course' }),
          ...quizzes.map((q, i) => el('option', { value: String(i), textContent: q.title || `Quiz ${q.id}` })));
        log(`Found ${quizzes.length} New Quiz${quizzes.length === 1 ? '' : 'zes'} in this course.`);
      } catch (e) {
        ui.quiz.replaceChildren(el('option', { value: '', textContent: 'Couldn’t load quizzes. Try Load quizzes again.' }));
        log('Could not load New Quizzes: ' + e.message);
      } finally {
        setBusy(false);
      }
    }

    async function readQuiz() {
      quizPlan = null;
      ui.quizSummary.replaceChildren();
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
        log(`Could not read "${quiz.title}": ${e.message}`);
      } finally {
        setBusy(false);
      }
    }

    function renderQuizSummary({ moves, skipped }) {
      const nStimuli = moves.filter(m => m.kind === 'Stimulus').length;
      const nItems = moves.length - nStimuli;
      const parts = [
        el('div', { textContent: moves.length
          ? `Will move ${nItems} question${plural(nItems)}` +
            (nStimuli ? ` and ${nStimuli} stimul${nStimuli === 1 ? 'us' : 'i'}` : '') + ' into the new bank.'
          : 'Every question in this quiz already comes from a bank.' }),
      ];
      if (skipped.length) parts.push(
        el('div', { className: 'cbt-warn', textContent: `Left as they are (${skipped.length}):` }),
        el('ul', {}, ...skipped.map(s => el('li', { textContent: `${s.name}: ${s.reason}` }))));
      ui.quizSummary.replaceChildren(...parts);
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

    async function createBank(title, bankCourse) {
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
        log(`⚠️ ${e.message}. The bank was made but may only show under your own banks.`);
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

    async function moveQuizToBank() {
      const plan = quizPlan;
      if (busy || !plan?.moves.length) return;
      const bankCourse = bankCourseId();
      if (!auth.api.Authorization) return log('No token yet. Click "Share" on any bank, close it, then try again.');
      if (!bankCourse) return log('Bank course not detected. Reload the Item Banks page and try again.');
      const title = String(plan.quiz.title || `Quiz ${plan.quiz.id}`).trim();

      setBusy(true);
      let existing = [];
      try {
        existing = (await fetchBanks(bankCourse)).filter(b => String(b.title || '').trim() === title);
      } catch { /* the warning below just won't show */ }
      setBusy(false);

      const n = plan.moves.length;
      const ok = confirm(`Make a new item bank "${title}" and move ${n} entr${n === 1 ? 'y' : 'ies'} from the quiz into it?\n\n` +
        'Each question stays in the quiz but now comes from the bank, the same as using "add to item bank" ' +
        'on it in the quiz editor. Editing it in the bank will change it in the quiz.' +
        (plan.skipped.length ? `\n\n${plan.skipped.length} entr${plan.skipped.length === 1 ? 'y already comes' : 'ies already come'} from a bank and will be left as ${plan.skipped.length === 1 ? 'it is' : 'they are'}.` : '') +
        (existing.length ? `\n\nThis course already has a bank named "${title}". A second bank with the same name will be made.` : ''));
      if (!ok) return;

      setBusy(true);
      job.start();
      let moved = 0, failed = 0;
      let bankMade = false;
      try {
        const conn = await newQuizzes.connect(plan.quiz.id, (label, fn) => { log(label + '…'); return fn(); });
        const step = (label, fn) => { log(label + '…'); return fn(); };
        log('Getting the quiz editor’s login…');
        const editor = await newQuizzes.buildLogin(conn, step);

        // New Quizzes' own ids for the questions (the public API's can differ).
        const fresh = planQuizMove(await newQuizzes.quizEntries(editor));
        if (!fresh.moves.length) throw new Error('New Quizzes listed no questions to move in this quiz');
        if (fresh.moves.length !== n) log(`ℹ️ The quiz now has ${fresh.moves.length} entries to move (the preview showed ${n}).`);

        log(`Creating the bank "${title}"…`);
        const bankId = await createBank(title, bankCourse);
        bankMade = true;
        log('✅ Bank created. Moving the questions…');

        const total = fresh.moves.length;
        await paced(fresh.moves, PAUSE_WRITE_MS, async (m, i) => {
          const label = `${i + 1}/${total} ${m.name}`;
          try {
            if (!m.sourceId || !m.quizEntryId) throw new Error("New Quizzes didn't give this entry's id");
            await newQuizzes.moveToBank(editor, bankId, m);
            moved++;
            log(`✅ ${label}`);
          } catch (e) {
            failed++;
            log(`❌ ${label} (${e.message})` +
                (m.underStimulus ? '. It may already have moved with its stimulus; check the count below.' : ''));
            if (e.status === 401) {
              log('A login expired. Reload the page and move the rest from the quiz editor, ' +
                  'or delete the new bank and run this again.');
              return false;
            }
          }
          return true;
        });

        const inBank = await countBankEntries(bankId).catch(() => null);
        log(`Done: ${moved} of ${total} moved into "${title}"${failed ? `, ${failed} failed` : ''}.` +
            (inBank == null ? '' : ` The bank now holds ${inBank} entr${inBank === 1 ? 'y' : 'ies'}.`) +
            ' Reload the page to see the new bank.');
      } catch (e) {
        log('Stopped: ' + e.message + (bankMade ? '' : '. Nothing was changed.'));
      } finally {
        job.end();
        setBusy(false);
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
