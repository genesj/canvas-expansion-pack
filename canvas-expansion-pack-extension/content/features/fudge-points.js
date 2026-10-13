// Canvas Expansion Pack: Bulk Fudge Points (see the notes at the top of core.js).

(() => {
    'use strict';
  
    const {
      QUIZ_HOST_RE, btn, canvas, chunk, courseId, debug, el, job, launch, mapLimit, modal,
      nativeFetch, paced, plural, quizHosts, sessionStore, sleep, toast, waitFor, addStyles, register,
    } = window.__canvasExpansionPack;
  
    addStyles(String.raw`
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
    `);
  
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
      const httpError = (message, status) => Object.assign(new Error(message), { status });
      // The New Quizzes logins are fetched when the dialog opens and expire after a while.
      const isExpired = e => e.status === 401 || e.status === 403;
      const EXPIRED_TEXT = 'Fudge Points session expired. Close this window and choose Add Fudge Points again from the column menu.';
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
  
      // Grading tokens are only ever sent to an https New Quizzes host (QUIZ_HOST_RE),
      // even if the service names some other host.
      function quizApiBase(host) {
        if (!host) return quizHosts.base('api');
        const url = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`);
        if (url.protocol !== 'https:' || !QUIZ_HOST_RE.test(url.hostname)) {
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
          if (!r.ok) throw httpError(`${what} failed (${r.status})`, r.status);
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
            const res = await this.json(`${quizHosts.base('lti')}/native/launch`,
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
          return this.json(`${quizHosts.base('lti')}${path}`, conn.headers, undefined, what);
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
          if (!r.ok) throw httpError(`New Quizzes refused the change (${r.status})`, r.status);
  
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
      const submittedAttempts = p => (p.participant_sessions || [])
        .filter(s => s.submitted_at)
        .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at));
  
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
          const attempts = submittedAttempts(p);
          const ps = attempts[0]; // the latest
          if (ps) candidates.push({ name: nameOf(p), userId: String(p.canvas_user_id), ps, attempts: attempts.length });
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
      // Points go on the latest attempt, which may not be the one the quiz's scoring policy counts.
      const nameCell = s => el('td', {}, s.name, s.attempts > 1
        ? el('span', { className: 'cbt-sub cbt-warn', textContent: `${s.attempts} attempts: only the latest is changed` })
        : '');
      const multiAttemptNote = list => (list.some(s => s.attempts > 1)
        ? el('p', { className: 'cbt-hint cbt-warn', textContent:
            'Some students have more than one attempt. Fudge points go on the latest attempt and the scores shown are ' +
            'from that attempt. If this quiz keeps the highest or average score, their Gradebook score may not change.' })
        : '');
  
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
          // A New Quiz's tool URL is on this school's quiz-lti host.
          quizHosts.learn(quiz.external_tool_tag_attributes?.url);
          const loaded = await loadStudents(quiz.id, text => { if (mine === visit) status.textContent = text; });
          if (mine === visit) showSetup(quiz, loaded);
        } catch (e) {
          if (mine !== visit) return;
          const close = btn('Close', () => ui.dialog.close(), 'cbt-primary');
          ui.dialog.show(...heading(quiz),
            el('p', { className: 'cbt-fudge-error', textContent: `Couldn't load this quiz.` }),
            el('p', { textContent: e.message }),
            el('p', { className: 'cbt-hint', textContent: 'For details, open the console (F12), run localStorage.setItem(\'cbt-debug\', \'1\'), reload, and try again.' }),
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
            nameCell(s),
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
          multiAttemptNote(students),
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
          multiAttemptNote(chosen),
          studentTable([th('Student'), th('Fudge points', 'cbt-num'), th('Score', 'cbt-num')],
            chosen.map(s => el('tr', {},
              nameCell(s),
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
        let expired = false;
  
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
              // An expired login fails for everyone left, so stop instead of trying each one.
              if (isExpired(e)) {
                expired = true;
                failed.push({ name: s.name, why: `session expired (${e.message})` });
                return false;
              }
              failed.push({ name: s.name, why: e.message });
              if (e.fatal) { halted = s.name; return false; }
            } finally {
              progress.value = i + 1;
            }
          });
        } finally {
          job.end();
        }
  
        const summary = { quiz: { id: quiz.id, name: quiz.name }, total: chosen.length, done: done.length, failed, halted, expired };
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
  
      const summaryText = ({ total, done, failed, halted, expired }) => {
        const notRun = total - done - failed.length;
        const parts = [`${done} updated`];
        if (failed.length) parts.push(`${failed.length} failed`);
        if (notRun) parts.push(`${notRun} not attempted`);
        return `${halted || expired ? 'Stopped' : 'Done'}: ${parts.join(', ')}.`;
      };
  
      function showResults(summary) {
        const { quiz, failed, halted, expired } = summary;
        const close = btn('Close', () => ui.dialog.close(), 'cbt-primary');
        ui.dialog.show(...heading(quiz),
          el('h3', { textContent: summaryText(summary) }),
          halted ? el('p', { className: 'cbt-fudge-error', textContent: `Stopped after ${halted} so nothing else is changed until you’ve looked.` }) : '',
          expired ? el('p', { className: 'cbt-fudge-error', textContent: EXPIRED_TEXT }) : '',
          failed.length ? el('ul', { className: 'cbt-list' }, ...failed.map(f => el('li', {},
            el('span', { textContent: f.name }), el('span', { className: 'cbt-sub cbt-fudge-error', textContent: f.why })))) : '',
          el('div', { className: 'cbt-actions' }, close));
        close.focus();
      }
  
      function showAfterReload(summary) {
        if (summary.failed.length || summary.halted || summary.expired) return showResults(summary);
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
  
    register(createFudgePointsFeature);
  })();
  