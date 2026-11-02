// Canvas Expansion Pack: Advanced Reports (see the notes at the top of core.js).
//
// An "Advanced Reports ▾" menu on the Modules page, just right of Batch Edit.
// Reports are read-only: nothing is ever written. New reports go in REPORTS.
//
// Class Progress: Canvas's "View Progress" page shows one student at a time.
// This report shows the whole class as one grid: students down the side,
// every module completion requirement across the top (in module order), and
// Yes/No in each cell for whether the student has met it. A blank cell means
// the item isn't assigned to that student. It has a section filter, a name
// search and a CSV download laid out the same way.
//
// Where the data comes from: the modules API with student_id, one call per
// student (plus one per module whose items Canvas leaves out inline and that
// has completion requirements). Only published modules and items count, as
// students see them.
//
// Submission Log: Moodle-style logs, one student at a time. A search box
// (name or SIS ID) lists every active student; picking one loads their
// timeline: every submission attempt (with lateness and files), every
// grading (score and grader), and, from Canvas Analytics, each participation
// and their page views hour by hour, and for each New Quiz they submitted,
// what Moderate > View Log shows (started, left and came back to the page,
// answered or changed an answer). Submissions link to SpeedGrader. It can
// be filtered by event type and item, and downloaded as a CSV.
//
// Where the data comes from: enrollments (last activity, total activity
// time), the submissions API with submission_history for that one student,
// and the Analytics API (users/:id/activity), skipped quietly when the
// course doesn't have it. Quiz logs come from New Quizzes itself
// (quiz_session_events, signed in through content/new-quizzes.js like Bulk
// Fudge Points), loaded after the rest of the timeline is shown.
//
// The menu only appears where Canvas shows its own View Progress link,
// which Canvas limits to people who can see every student's grades.

(() => {
  'use strict';

  const {
    btn, canvas, chunk, courseId, debug, el, launch, launchMenu, mapLimit, modal, newQuizzes, plural, quizHosts, sleep, waitFor,
    addStyles, register,
  } = window.__canvasExpansionPack;

  addStyles(String.raw`
    /* ================= Class Progress ================= */
    #cbt-pace-dialog { width: min(1180px, calc(100vw - 32px)); }
    .cbt-pace-tools {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 12px 0 6px;
    }
    /* Section picker, search and Download CSV share one height */
    .cbt .cbt-pace-tools select,
    .cbt .cbt-pace-tools input[type=text],
    .cbt .cbt-pace-tools .cbt-btn {
      box-sizing: border-box;
      height: 36px;
      margin: 0;
      padding-top: 0;
      padding-bottom: 0;
      line-height: 34px;
      vertical-align: middle;
    }
    .cbt .cbt-pace-tools select,
    .cbt .cbt-pace-tools input[type=text] { width: auto; min-width: 200px; }
    .cbt-pace-spacer { flex: 1; }
    .cbt-pace-wrap {
      max-height: 60vh;
      overflow: auto;
      border: 1px solid var(--cbt-border-light);
      border-radius: 4px;
    }
    .cbt-pace-error { color: var(--cbt-danger); }

    /* The grid: one narrow column per requirement, student names stay put */
    .cbt-pace-grid { border-collapse: collapse; font-size: 13px; }
    .cbt-pace-grid th,
    .cbt-pace-grid td {
      padding: 6px 8px;
      border-bottom: 1px solid var(--cbt-border-light);
      text-align: left;
      white-space: nowrap;
    }
    .cbt-pace-grid th {
      position: sticky;
      top: 0;
      z-index: 1;
      min-width: 90px;
      max-width: 180px;
      background: #fff;
      box-shadow: inset 0 -1px 0 var(--cbt-border);
      font-size: 12px;
      white-space: normal;
      vertical-align: bottom;
    }
    /* Module names are cut at 30 characters; a narrow column cuts them sooner */
    .cbt-pace-grid th .cbt-sub {
      overflow: hidden;
      font-weight: 400;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    /* Long item titles stop at three lines; the full title is on hover */
    .cbt-pace-title {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      overflow: hidden;
    }
    .cbt-pace-type { margin-right: 4px; color: var(--cbt-muted); font-size: 13px; }
    .cbt-pace-grid tbody tr:hover td { background: var(--cbt-hover); }
    .cbt-pace-grid td.cbt-pace-cell { text-align: center; }
    .cbt-pace-grid th:first-child,
    .cbt-pace-grid td:first-child {
      position: sticky;
      left: 0;
      z-index: 1;
      background: #fff;
      white-space: nowrap;
      box-shadow: inset -1px 0 0 var(--cbt-border-light);
    }
    .cbt-pace-grid th:first-child { z-index: 2; }
    .cbt-pace-sort {
      padding: 0;
      background: none;
      border: 0;
      color: inherit;
      font: inherit;
      font-weight: 600;
      text-align: left;
      cursor: pointer;
    }
    .cbt-pace-sort:hover { color: var(--cbt-primary); }
    .cbt-pace-badge {
      display: inline-block;
      padding: 0 8px;
      border-radius: 10px;
      background: var(--cbt-hover);
      color: var(--cbt-muted);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .cbt-pace-badge.cbt-pace-good { background: #E6F4EC; color: var(--cbt-success); }
    .cbt-pace-badge.cbt-pace-warn { background: #FDF0E6; color: var(--cbt-warning); }
    .cbt-pace-badge.cbt-pace-bad { background: #FBE9E9; color: var(--cbt-danger); }

    /* ================= Submission Log ================= */
    .cbt-pace-grid .cbt-num { text-align: right; }
    .cbt-pace-grid td.cbt-log-detail { min-width: 240px; white-space: normal; }
    .cbt-pace-grid .cbt-log-when { color: var(--cbt-text); }
    .cbt-log-picker { position: relative; }
    .cbt .cbt-log-picker input[type=text] { width: 320px; }
    .cbt-log-list {
      position: absolute;
      top: calc(100% + 2px);
      left: 0;
      z-index: 3;
      width: max(100%, 360px);
      max-height: 320px;
      overflow: auto;
      margin: 0;
      padding: 4px 0;
      list-style: none;
      background: #fff;
      border: 1px solid var(--cbt-border);
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }
    .cbt-log-list.cbt-log-inline {
      position: static;
      width: auto;
      max-height: 50vh;
      margin-top: 6px;
      box-shadow: none;
    }
    .cbt-log-list li {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 6px 12px;
      cursor: pointer;
    }
    .cbt-log-list li.cbt-log-active,
    .cbt-log-list li:hover { background: var(--cbt-selected-row); }
    .cbt-log-list li.cbt-log-none { color: var(--cbt-muted); cursor: default; background: none; }
    .cbt-log-missing { margin: 4px 0; color: var(--cbt-danger); font-size: 13px; }
  `);

  // ==================================================================
  // Feature: Advanced Reports
  // ==================================================================
  function createAdvancedReportsFeature() {
    const PAGE_RE = /^\/courses\/\d+(\/modules)?\/?$/;
    const CONCURRENCY = 4;
    const MAX_PAGES = 200;

    const SEL = {
      page: '#context_modules',
      progressLink: 'a[href$="/modules/progressions"]', // only shown to those who can see all grades
      batchEdit: '#cbt-mod-toggle',                     // Modules Batch Edit's menu button
      editorOnly: '.add_module_link',                   // where Batch Edit docks
    };

    const MODULE_NAME_MAX = 30; // characters shown in a column header before "…"

    // Canvas's own icon-font classes for each kind of module item, as on the Modules page.
    const TYPE_ICONS = {
      Assignment: ['icon-assignment', 'Assignment'],
      Quiz: ['icon-quiz', 'Quiz'],
      NewQuiz: ['icon-quiz', 'Quiz'],
      Discussion: ['icon-discussion', 'Discussion'],
      Page: ['icon-document', 'Page'],
      File: ['icon-paperclip', 'File'],
      ExternalUrl: ['icon-link', 'Link'],
      ExternalTool: ['icon-link', 'External tool'],
    };

    class Cancelled extends Error {}
    let run = 0; // bumped whenever the dialog closes, so a load in progress stops

    // ---- Requests ----
    const nextPage = r => {
      const link = (r.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1];
      if (!link) return null;
      const u = new URL(link, location.origin);
      return u.origin === location.origin ? u.pathname + u.search : null;
    };

    // One GET, waiting and trying again when Canvas asks us to slow down
    // (it answers 403 "Rate Limit Exceeded", or 429, when too much runs at once).
    async function get(url, token) {
      for (let attempt = 1; ; attempt++) {
        if (token !== run) throw new Cancelled();
        const r = await canvas.request('GET', url);
        if (r.ok) return r;
        const throttled = r.status === 429 || (r.status === 403 && /rate limit/i.test(await r.clone().text()));
        if (!throttled || attempt >= 4) throw new Error(await canvas.errorText(r));
        debug('class progress: throttled, waiting before', url.split('?')[0]);
        await sleep(1000 * 2 ** attempt);
      }
    }

    // Like canvas.getAll, but it can be cancelled and it backs off when throttled.
    async function getAll(path, token) {
      const out = [];
      let url = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
      for (let i = 0; url && i < MAX_PAGES; i++) {
        const r = await get(url, token);
        out.push(...await canvas.json(r));
        url = nextPage(r);
      }
      return out;
    }

    // ---- Data ----
    // Every active student, with their sections, sorted by name. Shared by both reports.
    async function loadStudents(api, token) {
      const [enrollments, sections] = await Promise.all([
        getAll(`${api}/enrollments?type[]=StudentEnrollment&state[]=active`, token),
        getAll(`${api}/sections`, token),
      ]);
      const sectionName = new Map(sections.map(s => [String(s.id), s.name]));
      const byUser = new Map();
      for (const e of enrollments) {
        const id = String(e.user_id);
        if (!byUser.has(id)) {
          byUser.set(id, {
            id,
            name: e.user?.sortable_name || e.user?.name || `User ${id}`,
            // Canvas only includes SIS ids for roles allowed to read SIS data.
            sisId: String(e.sis_user_id || e.user?.sis_user_id || ''),
            sections: [],
            lastActivity: null, // the latest of their enrollments' last_activity_at
            activitySeconds: 0, // Canvas's "Total Activity" on the People page
          });
        }
        const s = byUser.get(id);
        const section = sectionName.get(String(e.course_section_id));
        if (section && !s.sections.includes(section)) s.sections.push(section);
        const last = e.last_activity_at ? Date.parse(e.last_activity_at) : null;
        if (last && (!s.lastActivity || last > s.lastActivity)) s.lastActivity = last;
        s.activitySeconds = Math.max(s.activitySeconds, e.total_activity_time || 0);
      }
      return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    async function load(token, onProgress) {
      const api = `/api/v1/courses/${courseId()}`;
      const [students, modules] = await Promise.all([
        loadStudents(api, token),
        getAll(`${api}/modules?include[]=items`, token),
      ]);
      await mapLimit(modules.filter(m => !Array.isArray(m.items)), CONCURRENCY, async m => {
        m.items = await getAll(`${api}/modules/${m.id}/items`, token);
      });

      // Every published requirement in a published module, in module order.
      const items = modules
        .filter(m => m.published !== false)
        .sort((a, b) => a.position - b.position)
        .flatMap(m => m.items
          .filter(i => i.published !== false && i.type !== 'SubHeader' && i.completion_requirement)
          .map(i => ({
            id: String(i.id),
            title: i.title,
            // New Quizzes are Assignment items with quiz_lti set.
            type: i.type === 'Assignment' && i.quiz_lti ? 'NewQuiz' : i.type,
            moduleId: String(m.id),
            moduleName: m.name,
          })));
      // Titles that repeat in other modules get the module name in the CSV header.
      const count = new Map();
      for (const i of items) count.set(i.title, (count.get(i.title) || 0) + 1);
      for (const i of items) i.csvLabel = count.get(i.title) > 1 ? `${i.moduleName}: ${i.title}` : i.title;
      const tracked = new Set(items.map(i => i.moduleId));

      const report = { students, items, hasSis: students.some(s => s.sisId), at: Date.now() };
      if (!students.length) return report;

      let done = 0;
      onProgress(0, students.length);
      await mapLimit(students, CONCURRENCY, async s => {
        const theirs = await getAll(`${api}/modules?include[]=items&student_id=${s.id}`, token);
        // Items Canvas left out inline are only fetched for modules with requirements.
        for (const m of theirs) {
          if (!Array.isArray(m.items) && tracked.has(String(m.id))) {
            m.items = await getAll(`${api}/modules/${m.id}/items?student_id=${s.id}`, token);
          }
        }
        // A module or item Canvas doesn't return for this student isn't assigned to them.
        s.visible = new Set(theirs.map(m => String(m.id)));
        s.met = new Map(theirs.flatMap(m => (m.items || [])
          .filter(i => i.completion_requirement)
          .map(i => [String(i.id), !!i.completion_requirement.completed])));
        onProgress(++done, students.length);
      });
      report.at = Date.now();
      debug('class progress: loaded', students.length, 'students,', items.length, 'requirements');
      return report;
    }

    const cellValue = (s, item) => {
      if (!s.visible.has(item.moduleId) || !s.met.has(item.id)) return '';
      return s.met.get(item.id) ? 'Yes' : 'No';
    };

    // ---- Formatting ----
    const isoDate = t => {
      const d = new Date(t);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const badge = text => el('span', { className: `cbt-pace-badge ${text === 'Yes' ? 'cbt-pace-good' : ''}`.trim(), textContent: text });

    const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
    function typeIcon(type) {
      const [icon, label] = TYPE_ICONS[type] || ['icon-module', type];
      return el('i', { className: `${icon} cbt-pace-type`, title: label, role: 'img', ariaLabel: label });
    }

    // The student columns before the grid. SIS ID only appears when Canvas gave us SIS ids.
    const STUDENT_COLUMNS = [
      { key: 'name', label: 'Student', text: s => s.name,
        cell: s => el('a', { href: `/courses/${courseId()}/grades/${s.id}`, target: '_blank', rel: 'noopener', textContent: s.name }) },
      { key: 'sis', label: 'SIS ID', sis: true, text: s => s.sisId },
      { key: 'section', label: 'Section', text: s => s.sections.join('; ') },
    ];

    const studentColumns = () => STUDENT_COLUMNS.filter(c => !c.sis || report.hasSis);

    // Spreadsheet apps run cells that start with these as formulas.
    const csvCell = v => {
      let s = v == null ? '' : String(v);
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    function toCsv(rows) {
      const cols = studentColumns();
      const head = [...cols.map(c => c.label), ...report.items.map(i => i.csvLabel)];
      const lines = rows.map(s => [...cols.map(c => c.text(s)), ...report.items.map(i => cellValue(s, i))]);
      return [head, ...lines].map(r => r.map(csvCell).join(',')).join('\r\n');
    }

    function download(name, text) {
      // The BOM makes Excel read names with accents correctly.
      const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }));
      const a = el('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    // ---- UI ----
    const ui = {};
    const view = { desc: false, section: '', search: '' };
    let report = null;

    const title = () => el('h2', { textContent: 'Class progress' });

    async function open() {
      launch.setPressed(ui.menu.button, true);
      const token = ++run;
      const progress = el('progress');
      const status = el('p', { className: 'cbt-hint', textContent: 'Loading the class list and modules…' });
      ui.dialog.show(title(), progress, status, el('div', { className: 'cbt-actions' }, btn('Cancel', () => ui.dialog.close())));
      try {
        report = await load(token, (done, total) => {
          progress.max = total;
          progress.value = done;
          status.textContent = `Loading student progress: ${done} of ${total} students…`;
        });
        if (token === run) showReport();
      } catch (e) {
        if (e instanceof Cancelled || token !== run) return;
        run++; // stop any requests still running
        console.error('[Canvas Expansion Pack] Class Progress failed:', e);
        ui.dialog.show(title(),
          el('p', { className: 'cbt-pace-error', textContent: `Couldn't load the report: ${e.message}.` }),
          el('p', { className: 'cbt-hint', textContent: 'The report needs permission to see every student’s progress.' }),
          el('div', { className: 'cbt-actions' }, btn('Try again', open), btn('Close', () => ui.dialog.close(), 'cbt-primary')));
      }
    }

    function visibleRows() {
      const q = view.search.trim().toLowerCase();
      return report.students
        .filter(s => (!view.section || s.sections.includes(view.section)) && (!q || s.name.toLowerCase().includes(q)))
        .sort((a, b) => (view.desc ? -1 : 1) * a.name.localeCompare(b.name));
    }

    function showReport() {
      const { students, items, at } = report;
      if (!students.length || !items.length) {
        const why = !students.length ? 'This course has no active students.'
          : 'No published module items in this course have completion requirements.';
        ui.dialog.show(title(), el('p', { textContent: why }),
          el('div', { className: 'cbt-actions' }, btn('Close', () => ui.dialog.close(), 'cbt-primary')));
        return;
      }

      const sections = [...new Set(students.flatMap(s => s.sections))].sort((a, b) => a.localeCompare(b));
      if (view.section && !sections.includes(view.section)) view.section = '';
      const sectionPick = el('select', { ariaLabel: 'Section' },
        el('option', { value: '', textContent: 'All sections' }),
        ...sections.map(name => el('option', { value: name, textContent: name })));
      sectionPick.value = view.section;
      sectionPick.hidden = sections.length < 2;
      sectionPick.addEventListener('change', () => { view.section = sectionPick.value; render(); });

      const search = el('input', { type: 'text', placeholder: 'Search students', ariaLabel: 'Search students', value: view.search });
      search.addEventListener('input', () => { view.search = search.value; render(); });

      const exportBtn = btn('Download CSV', () =>
        download(`class-progress-course-${courseId()}-${isoDate(at)}.csv`, toCsv(visibleRows())), 'cbt-primary');

      const summary = el('p', { className: 'cbt-hint' });
      const headRow = el('tr');
      const body = el('tbody');
      const table = el('table', { className: 'cbt-pace-grid' }, el('thead', {}, headRow), body);

      function render() {
        const cols = studentColumns();
        const sortBtn = btn(`Student ${view.desc ? '▼' : '▲'}`, () => { view.desc = !view.desc; render(); }, 'cbt-pace-sort');
        sortBtn.classList.remove('cbt-btn');
        headRow.replaceChildren(
          ...cols.map(c => {
            const th = el('th', { scope: 'col' }, c.key === 'name' ? sortBtn : c.label);
            if (c.key === 'name') th.setAttribute('aria-sort', view.desc ? 'descending' : 'ascending');
            return th;
          }),
          ...items.map(i => el('th', { scope: 'col', title: `${i.moduleName}: ${i.title}` },
            el('span', { className: 'cbt-sub', textContent: shorten(i.moduleName, MODULE_NAME_MAX) }),
            el('span', { className: 'cbt-pace-title' }, typeIcon(i.type), i.title))));

        const rows = visibleRows();
        body.replaceChildren(...rows.map(s => el('tr', {},
          ...cols.map(c => el('td', {}, c.cell ? c.cell(s) : c.text(s))),
          ...items.map(i => {
            const v = cellValue(s, i);
            return el('td', { className: 'cbt-pace-cell' }, v ? badge(v) : '');
          }))));
        summary.textContent = `${rows.length}/${students.length} students · ${new Date(at).toLocaleString()}`;
        exportBtn.disabled = !rows.length;
      }
      render();

      ui.dialog.show(
        title(),
        el('div', { className: 'cbt-pace-tools' }, sectionPick, search,
          el('span', { className: 'cbt-pace-spacer' }), exportBtn),
        summary,
        el('div', { className: 'cbt-pace-wrap' }, table),
        el('div', { className: 'cbt-actions' }, btn('Reload', open), btn('Close', () => ui.dialog.close())),
      );
    }

    // ==================================================================
    // Submission Log
    // ==================================================================
    // Every submission attempt and grading, plus course
    // activity from Canvas Analytics where the course has it, for one
    // student at a time, picked from a search box.

    const SUBMISSION_TYPES = {
      online_upload: 'File upload',
      online_text_entry: 'Text entry',
      online_url: 'Website URL',
      online_quiz: 'Quiz',
      basic_lti_launch: 'External tool', // how New Quizzes submit
      discussion_topic: 'Discussion post',
      media_recording: 'Media recording',
      student_annotation: 'Annotation',
    };
    const EVENT_KINDS = [
      { key: '', label: 'All events' },
      { key: 'submitted', label: 'Submissions' },
      { key: 'graded', label: 'Grading' },
      { key: 'participated', label: 'Participation' },
      { key: 'views', label: 'Page views' },
      { key: 'quiz', label: 'Quiz log' },
    ];

    // For requests the log can do without: Analytics turned off, or no right to list teachers.
    async function optional(promise) {
      try {
        return await promise;
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        debug('submission log: skipped an optional request:', e.message);
        return null;
      }
    }

    function assignmentType(a) {
      if (a.is_quiz_lti_assignment || /quiz-lti/i.test(a.external_tool_tag_attributes?.url || '')) return 'NewQuiz';
      if (a.is_quiz_assignment || a.quiz_id) return 'Quiz';
      if (a.discussion_topic || a.submission_types?.includes('discussion_topic')) return 'Discussion';
      return 'Assignment';
    }

    const pad = n => String(n).padStart(2, '0');
    const stamp = t => (t ? `${isoDate(t)} ${pad(new Date(t).getHours())}:${pad(new Date(t).getMinutes())}` : '');
    const shown = t => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
    const lateBy = sec => {
      if (!sec) return '';
      const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
      return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m || '<1'}m`;
    };
    const hoursMinutes = sec => (sec ? `${Math.floor(sec / 3600)}h ${pad(Math.floor((sec % 3600) / 60))}m` : '');

    // A submission's history as log events. Canvas saves a version each
    // time a submission changes, so one attempt can appear in several
    // versions: keep the first of each attempt, and each distinct grading.
    function submissionEvents(sub, a, graderName) {
      const versions = sub.submission_history?.length ? sub.submission_history : [sub];
      const events = [];
      const attempts = new Set();
      const gradings = new Set();
      for (const v of versions) {
        const attemptKey = v.attempt ?? v.submitted_at;
        if (v.submitted_at && !attempts.has(attemptKey)) {
          attempts.add(attemptKey);
          const late = v.seconds_late > 0 || !!v.late;
          const files = (v.attachments || []).map(f => f.display_name || f.filename).filter(Boolean);
          events.push({
            at: Date.parse(v.submitted_at),
            kind: 'submitted',
            label: `${v.attempt > 1 ? 'Resubmitted' : 'Submitted'}${late ? ' late' : ''}`,
            tone: late ? 'warn' : 'good',
            assignment: a,
            attempt: v.attempt || '',
            lateBy: late ? lateBy(v.seconds_late) : '',
            detail: [SUBMISSION_TYPES[v.submission_type] || v.submission_type, files.join(', '),
              v.submission_type === 'online_url' ? v.url : ''].filter(Boolean).join(' · '),
            by: '',
          });
        }
        const gradeKey = `${v.graded_at}|${v.score}|${v.excused}`;
        if (v.graded_at && (v.workflow_state === 'graded' || v.excused) && !gradings.has(gradeKey)) {
          gradings.add(gradeKey);
          const grade = v.excused ? 'Excused'
            : v.score != null ? `${v.score}${a.points != null ? ` / ${a.points}` : ''}` : v.grade || '';
          events.push({
            at: Date.parse(v.graded_at),
            kind: 'graded',
            label: 'Graded',
            tone: '',
            assignment: a,
            attempt: v.attempt || '',
            lateBy: '',
            detail: grade,
            by: graderName(v.grader_id),
          });
        }
      }
      return events;
    }

    // The class list, assignments and graders: enough to show the student picker.
    async function loadCourse(token) {
      const api = `/api/v1/courses/${courseId()}`;
      const [students, assignments, staff] = await Promise.all([
        loadStudents(api, token),
        getAll(`${api}/assignments?order_by=position`, token),
        optional(getAll(`${api}/users?enrollment_type[]=teacher&enrollment_type[]=ta&enrollment_type[]=designer`, token)),
      ]);
      const byId = new Map(assignments
        .filter(a => a.published !== false)
        .map(a => [String(a.id), {
          id: String(a.id), name: a.name, type: assignmentType(a), points: a.points_possible,
          discussionId: a.discussion_topic?.id ? String(a.discussion_topic.id) : null,
        }]));
      const staffName = new Map((staff || []).map(u => [String(u.id), u.name]));
      // A New Quiz's tool URL is on this school's quiz-lti host, which the quiz logs need.
      for (const a of assignments) if (assignmentType(a) === 'NewQuiz') quizHosts.learn(a.external_tool_tag_attributes?.url);
      return {
        students,
        assignments: [...byId.values()],
        byId,
        // Canvas records automatic quiz grading with a negative grader id.
        graderName: id => (id == null ? '' : id < 0 ? 'Automatic' : staffName.get(String(id)) || `User ${id}`),
        hasSis: students.some(s => s.sisId),
        quizCache: new Map(), // assignment id -> { at, promise of { conn, people } }
      };
    }

    // One student's submission history and course activity.
    async function loadStudentLog(s, token) {
      const api = `/api/v1/courses/${courseId()}`;
      const [subs, activity] = await Promise.all([
        getAll(`${api}/students/submissions?student_ids[]=${s.id}&include[]=submission_history`, token),
        loadActivity(s, token),
      ]);
      const events = [];
      const stats = { submitted: 0, attempts: 0, late: 0, missing: 0, missingItems: [] };
      for (const sub of subs) {
        const a = log.byId.get(String(sub.assignment_id));
        if (!a || String(sub.user_id) !== s.id) continue;
        const theirs = submissionEvents(sub, a, log.graderName);
        events.push(...theirs);
        const submits = theirs.filter(e => e.kind === 'submitted').length;
        if (submits) stats.submitted++;
        stats.attempts += submits;
        if (sub.late) stats.late++;
        if (sub.missing) { stats.missing++; stats.missingItems.push(a.name); }
      }
      debug('submission log: loaded', events.length, 'submission events for', s.id);
      return { events: [...events, ...(activity || [])], stats, analytics: activity !== null, at: Date.now() };
    }

    // Hour-by-hour page views and each participation, from Canvas Analytics.
    // Resolves to null when the course doesn't have Analytics.
    async function loadActivity(s, token) {
      const r = await optional(get(`/api/v1/courses/${courseId()}/analytics/users/${s.id}/activity`, token));
      if (!r) return null;
      const j = await canvas.json(r);
      const byAssignment = new Map(log.assignments.map(a => [a.id, a]));
      const byDiscussion = new Map(log.assignments.filter(a => a.discussionId).map(a => [a.discussionId, a]));
      const events = Object.entries(j.page_views || {}).map(([hour, n]) => ({
        at: Date.parse(hour), kind: 'views', label: 'Page views', tone: '', assignment: null,
        attempt: '', lateBy: '', detail: `${n} page view${plural(n)} that hour`, by: '',
      }));
      for (const p of j.participations || []) {
        const path = p.url ? new URL(p.url, location.origin).pathname : '';
        // Tools calling Canvas's API on the student's behalf (e.g. New Quizzes
        // sending a grade via /api/lti/.../grade_passback) aren't the student.
        if (path.startsWith('/api/')) continue;
        const a = byAssignment.get(path.match(/\/assignments\/(\d+)/)?.[1])
          || byDiscussion.get(path.match(/\/discussion_topics\/(\d+)/)?.[1]);
        events.push({
          at: Date.parse(p.created_at), kind: 'participated', label: 'Participated', tone: '', assignment: a || null,
          attempt: '', lateBy: '', detail: a ? '' : path, by: '', url: path,
        });
      }
      return events;
    }

    // ---- New Quizzes logs (Moderate > View Log) ----
    const QUIZ_LOG_TTL_MS = 10 * 60_000; // New Quizzes logins don't last long; sign in again after this

    const browserOf = ua => {
      if (!ua) return '';
      const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari' : 'another browser';
      const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS'
        : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
      return os ? `${browser} on ${os}` : browser;
    };
    const awayFor = ms => {
      const sec = Math.max(0, Math.round(ms / 1000));
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
      return h ? `${h}h ${m}m` : m ? `${m}m ${x}s` : `${x}s`;
    };
    const humanize = type => {
      const t = String(type || 'event').replace(/_EVENT$/, '').replace(/_/g, ' ').toLowerCase();
      return t.charAt(0).toUpperCase() + t.slice(1);
    };

    // One attempt's View Log entries as timeline events. Times look like
    // "2026-09-29T05:27:15.435Z|221372.39"; the part before | is the server time.
    function quizLogEvents(raw, a, attempt) {
      const when = e => Date.parse(String(e.created_at || '').split('|')[0]) || Date.parse(e.event_data?.client_timestamp) || 0;
      const url = `/courses/${courseId()}/assignments/${a.id}`;
      const out = [];
      let started = false, leftAt = null, lastIp = null;
      const answered = new Set();
      for (const e of [...raw].sort((x, y) => when(x) - when(y))) {
        const d = e.event_data || {};
        const at = when(e);
        const ipNote = d.ip_address && lastIp && d.ip_address !== lastIp ? `new IP address ${d.ip_address}` : '';
        if (d.ip_address) lastIp = d.ip_address;
        let label, tone = '', detail = '';
        switch (e.event_type) {
          case 'SESSION_STARTED_OR_RESUMED_EVENT':
            label = started ? 'Resumed quiz' : 'Started quiz';
            tone = started ? '' : 'good';
            detail = [d.ip_address && `IP ${d.ip_address}`, browserOf(d.user_agent)].filter(Boolean).join(' · ');
            started = true;
            break;
          case 'PAGE_BLURRED_EVENT':
            label = 'Left the quiz';
            tone = 'warn';
            leftAt = at;
            break;
          case 'PAGE_FOCUSED_EVENT':
            label = 'Came back to the quiz';
            detail = leftAt ? `away ${awayFor(at - leftAt)}` : '';
            leftAt = null;
            break;
          case 'RESPONSE': {
            const key = d.item_id || d.position;
            label = answered.has(key) ? 'Changed answer' : 'Answered';
            answered.add(key);
            detail = d.position ? `Question ${d.position}` : '';
            break;
          }
          default:
            label = humanize(e.event_type);
        }
        if (ipNote && e.event_type !== 'SESSION_STARTED_OR_RESUMED_EVENT') detail = [detail, ipNote].filter(Boolean).join(' · ');
        out.push({ at, kind: 'quiz', label, tone, assignment: a, attempt, lateBy: '', detail, by: '', url });
      }
      return out;
    }

    // Signing in and listing a quiz's students, kept for a few minutes so
    // switching students doesn't sign in to every quiz again.
    function quizSession(a, token) {
      const cache = log.quizCache;
      const hit = cache.get(a.id);
      if (hit && Date.now() - hit.at < QUIZ_LOG_TTL_MS) return hit.promise;
      const step = async (label, fn) => {
        if (token !== run) throw new Cancelled();
        try { return await fn(); } catch (e) { throw new Error(`${label}: ${e.message}`); }
      };
      const promise = (async () => {
        const conn = await newQuizzes.connect(a.id, step);
        const people = await step('Finding students', () => newQuizzes.participants(conn));
        return { conn, people };
      })();
      promise.catch(() => cache.delete(a.id));
      cache.set(a.id, { at: Date.now(), promise });
      return promise;
    }

    async function loadQuizLog(s, a, token) {
      const { conn, people } = await quizSession(a, token);
      const p = people.find(x => String(x.canvas_user_id) === s.id);
      // Oldest attempt first, so the attempt numbers count up.
      const sessions = [...(p?.participant_sessions || [])]
        .sort((x, y) => (Date.parse(x.started_at || x.created_at || x.submitted_at) || 0) - (Date.parse(y.started_at || y.created_at || y.submitted_at) || 0)
          || Number(x.id) - Number(y.id));
      const events = [];
      for (const [i, ps] of sessions.entries()) {
        if (token !== run) throw new Cancelled();
        const att = await newQuizzes.attempt(conn, ps.id);
        events.push(...quizLogEvents(await newQuizzes.sessionEvents(att), a, ps.attempt || i + 1));
      }
      return events;
    }

    // Runs after the timeline is up; adds each New Quiz the student submitted.
    async function loadQuizLogs(s, data, token) {
      const quizzes = log.assignments.filter(a => a.type === 'NewQuiz' && data.events.some(e => e.kind === 'submitted' && e.assignment === a));
      if (!quizzes.length) return;
      data.quizzes = { done: 0, total: quizzes.length, failed: [], loading: true };
      const update = () => data.onQuizProgress?.();
      update();
      const found = [];
      await mapLimit(quizzes, 2, async a => {
        try {
          found.push(...await loadQuizLog(s, a, token));
        } catch (e) {
          if (e instanceof Cancelled) return;
          console.error('[Canvas Expansion Pack] Submission Log: quiz log failed for', a.name, e);
          data.quizzes.failed.push(`${a.name} (${e.message})`);
        } finally {
          data.quizzes.done++;
          update();
        }
      });
      if (token !== run) return;
      data.events.push(...found);
      data.quizzes.loading = false;
      data.onQuizDone?.();
    }

    // ---- UI ----
    const logView = { student: null, kind: '', item: '', newestFirst: true };
    let log = null; // the course: students, assignments, graders

    const logTitle = s => el('h2', { textContent: s ? `Submission log: ${s.name}` : 'Submission log' });
    const tone = (text, kind) => el('span', { className: `cbt-pace-badge ${kind ? `cbt-pace-${kind}` : ''}`.trim(), textContent: text });

    // Event columns, for the timeline CSV.
    const EVENT_COLUMNS = [
      { label: 'When', text: e => stamp(e.at) },
      { label: 'Event', text: e => e.label },
      { label: 'Item', text: e => e.assignment?.name || e.url || '' },
      { label: 'Item type', text: e => (e.assignment ? (TYPE_ICONS[e.assignment.type]?.[1] || e.assignment.type) : '') },
      { label: 'Attempt', text: e => e.attempt },
      { label: 'Late by', text: e => e.lateBy },
      { label: 'Details', text: e => (e.kind === 'participated' ? '' : e.detail) },
      { label: 'Graded by', text: e => e.by },
    ];

    function eventsCsv(s, events) {
      const who = [
        { label: 'Student', text: () => s.name },
        ...(log.hasSis ? [{ label: 'SIS ID', text: () => s.sisId }] : []),
        { label: 'Section', text: () => s.sections.join('; ') },
      ];
      const head = [...who.map(c => c.label), ...EVENT_COLUMNS.map(c => c.label)];
      const lines = events.map(e => [...who.map(c => c.text()), ...EVENT_COLUMNS.map(c => c.text(e))]);
      return [head, ...lines].map(r => r.map(csvCell).join(',')).join('\r\n');
    }

    // A search box over every student, matching names and SIS ids. inline: the
    // list is always shown under the box (the first screen); otherwise it drops
    // down while the box has focus (above a timeline).
    function studentPicker({ inline, placeholder }) {
      const listId = `cbt-log-list-${inline ? 'inline' : 'drop'}`;
      const input = el('input', { type: 'text', placeholder, ariaLabel: 'Search students', autocomplete: 'off' });
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-controls', listId);
      input.setAttribute('aria-autocomplete', 'list');
      const list = el('ul', { id: listId, className: `cbt-log-list ${inline ? 'cbt-log-inline' : ''}`.trim(), role: 'listbox', ariaLabel: 'Students' });
      let matches = [];
      let active = 0;

      const setOpen = open => {
        list.hidden = !open;
        input.setAttribute('aria-expanded', String(open));
      };
      function render() {
        const q = input.value.trim().toLowerCase();
        matches = log.students.filter(s => !q || s.name.toLowerCase().includes(q) || s.sisId.toLowerCase().includes(q));
        active = Math.min(active, Math.max(matches.length - 1, 0));
        list.replaceChildren(...matches.map((s, i) => {
          const li = el('li', { id: `${listId}-${i}`, role: 'option', className: i === active ? 'cbt-log-active' : '' },
            el('span', { textContent: s.name }),
            el('span', { className: 'cbt-sub', textContent: [s.sections.join('; '), s.sisId].filter(Boolean).join(' · ') }));
          li.setAttribute('aria-selected', String(i === active));
          li.addEventListener('pointerdown', e => e.preventDefault()); // keep focus in the box
          li.addEventListener('click', () => pickStudent(s));
          return li;
        }));
        if (!matches.length) list.replaceChildren(el('li', { className: 'cbt-log-none', textContent: 'No students match.' }));
        if (matches.length) input.setAttribute('aria-activedescendant', `${listId}-${active}`);
        else input.removeAttribute('aria-activedescendant');
        list.children[active]?.scrollIntoView?.({ block: 'nearest' });
      }
      input.addEventListener('input', () => { active = 0; render(); setOpen(true); });
      input.addEventListener('focus', () => { render(); setOpen(true); });
      input.addEventListener('blur', () => { if (!inline) setOpen(false); });
      input.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (list.hidden) setOpen(true);
          else if (matches.length) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
          render();
        } else if (e.key === 'Enter' && !list.hidden && matches[active]) {
          e.preventDefault();
          pickStudent(matches[active]);
        } else if (e.key === 'Escape' && !inline && !list.hidden) {
          e.preventDefault(); // close the list, not the dialog
          setOpen(false);
        }
      });
      render();
      setOpen(inline);
      return { node: el('div', { className: 'cbt-log-picker' }, input, list), input };
    }

    async function openLog() {
      launch.setPressed(ui.menu.button, true);
      const token = ++run;
      ui.dialog.show(logTitle(), el('progress'), el('p', { className: 'cbt-hint', textContent: 'Loading the class list…' }),
        el('div', { className: 'cbt-actions' }, btn('Cancel', () => ui.dialog.close())));
      try {
        const course = await loadCourse(token);
        if (token !== run) return;
        log = course;
        showPicker();
      } catch (e) {
        if (e instanceof Cancelled || token !== run) return;
        run++; // stop any requests still running
        console.error('[Canvas Expansion Pack] Submission Log failed:', e);
        ui.dialog.show(logTitle(),
          el('p', { className: 'cbt-pace-error', textContent: `Couldn't load the report: ${e.message}.` }),
          el('p', { className: 'cbt-hint', textContent: 'The report needs permission to see every student’s submissions.' }),
          el('div', { className: 'cbt-actions' }, btn('Try again', openLog), btn('Close', () => ui.dialog.close(), 'cbt-primary')));
      }
    }

    function showPicker() {
      logView.student = null;
      if (!log.students.length) {
        ui.dialog.show(logTitle(), el('p', { textContent: 'This course has no active students.' }),
          el('div', { className: 'cbt-actions' }, btn('Close', () => ui.dialog.close(), 'cbt-primary')));
        return;
      }
      const picker = studentPicker({ inline: true, placeholder: 'Search by name or SIS ID' });
      ui.dialog.show(
        logTitle(),
        el('p', { className: 'cbt-hint', textContent: `Pick a student to see their submissions, grades and course activity. ${log.students.length} student${plural(log.students.length)}.` }),
        picker.node,
        el('div', { className: 'cbt-actions' }, btn('Close', () => ui.dialog.close())),
      );
      picker.input.focus();
    }

    async function pickStudent(s) {
      logView.student = s.id;
      const token = run;
      const picker = studentPicker({ inline: false, placeholder: 'Switch to another student' });
      ui.dialog.show(logTitle(s), el('div', { className: 'cbt-pace-tools' }, picker.node),
        el('progress'), el('p', { className: 'cbt-hint', textContent: 'Loading their submissions and activity…' }),
        el('div', { className: 'cbt-actions' }, btn('Cancel', () => ui.dialog.close())));
      try {
        const data = await loadStudentLog(s, token);
        if (token !== run || logView.student !== s.id) return;
        showStudentLog(s, data);
        loadQuizLogs(s, data, token);
      } catch (e) {
        if (e instanceof Cancelled || token !== run || logView.student !== s.id) return;
        console.error('[Canvas Expansion Pack] Submission Log failed:', e);
        ui.dialog.show(logTitle(s),
          el('p', { className: 'cbt-pace-error', textContent: `Couldn't load this student's log: ${e.message}.` }),
          el('div', { className: 'cbt-actions' }, btn('Try again', () => pickStudent(s)), btn('Pick another student', showPicker),
            btn('Close', () => ui.dialog.close(), 'cbt-primary')));
      }
    }

    function showStudentLog(s, data) {
      const all = data.events;
      const picker = studentPicker({ inline: false, placeholder: 'Switch to another student' });

      const kindPick = el('select', { ariaLabel: 'Events' },
        ...EVENT_KINDS.map(k => el('option', { value: k.key, textContent: k.label })));
      kindPick.value = logView.kind;
      kindPick.addEventListener('change', () => { logView.kind = kindPick.value; render(); });

      const used = log.assignments.filter(a => all.some(e => e.assignment === a));
      if (logView.item && !used.some(a => a.id === logView.item)) logView.item = '';
      const itemPick = el('select', { ariaLabel: 'Item' },
        el('option', { value: '', textContent: 'All items' }),
        ...used.map(a => el('option', { value: a.id, textContent: a.name })));
      itemPick.value = logView.item;
      itemPick.hidden = !used.length;
      itemPick.addEventListener('change', () => { logView.item = itemPick.value; render(); });

      const visibleEvents = () => all
        .filter(e => (!logView.kind || e.kind === logView.kind) && (!logView.item || e.assignment?.id === logView.item))
        .sort((x, y) => (logView.newestFirst ? y.at - x.at : x.at - y.at));

      const fileName = s.name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');
      const exportBtn = btn('Download CSV', () =>
        download(`submission-log-${fileName}-course-${courseId()}-${isoDate(data.at)}.csv`, eventsCsv(s, visibleEvents())),
        'cbt-primary');

      const { submitted, attempts, late, missing, missingItems } = data.stats;
      const facts = [
        s.sections.join('; '),
        `${submitted} submitted (${attempts} attempt${plural(attempts)})`, `${late} late`, `${missing} missing`,
        s.lastActivity ? `last active ${shown(s.lastActivity)}` : 'no course activity recorded',
        s.activitySeconds ? `${hoursMinutes(s.activitySeconds)} total activity` : '',
      ].filter(Boolean).join(' · ');

      const headRow = el('tr');
      const body = el('tbody');
      const table = el('table', { className: 'cbt-pace-grid' }, el('thead', {}, headRow), body);
      const count = el('p', { className: 'cbt-hint' });

      // New Quizzes logs arrive after the rest. Redraw with them, unless the
      // switch-student box is in use; then offer a button instead.
      const quizNote = el('p', { className: 'cbt-hint', role: 'status' });
      function showQuizNote() {
        const q = data.quizzes;
        if (!q) { quizNote.hidden = true; return; }
        quizNote.hidden = false;
        const failed = q.failed.length ? `Couldn't load the quiz log for ${q.failed.join('; ')}.` : '';
        if (q.loading) quizNote.replaceChildren(`Loading New Quizzes logs: ${q.done} of ${q.total} quiz${q.total === 1 ? '' : 'zes'}…`);
        else quizNote.replaceChildren(failed);
        quizNote.hidden = !quizNote.textContent;
      }
      data.onQuizProgress = () => { if (logView.student === s.id) showQuizNote(); };
      data.onQuizDone = () => {
        if (logView.student !== s.id) return;
        if (document.activeElement === picker.input && picker.input.value) {
          quizNote.hidden = false;
          quizNote.replaceChildren('Quiz logs are ready. ', btn('Show them', () => showStudentLog(s, data)));
        } else {
          showStudentLog(s, data);
        }
      };
      showQuizNote();

      // Submissions and grades open SpeedGrader; participation opens the page they used.
      function itemCell(e) {
        const a = e.assignment;
        if (e.kind === 'submitted' || e.kind === 'graded') {
          return el('a', { href: `/courses/${courseId()}/gradebook/speed_grader?assignment_id=${a.id}&student_id=${s.id}`,
            target: '_blank', rel: 'noopener', title: 'Open in SpeedGrader' }, typeIcon(a.type), a.name);
        }
        if (e.url) return el('a', { href: e.url, target: '_blank', rel: 'noopener' }, a ? typeIcon(a.type) : '', a ? a.name : e.url);
        return '';
      }

      function render() {
        const whenBtn = btn(`When ${logView.newestFirst ? '▼' : '▲'}`, () => { logView.newestFirst = !logView.newestFirst; render(); },
          'cbt-pace-sort');
        whenBtn.classList.remove('cbt-btn');
        const whenTh = el('th', { scope: 'col' }, whenBtn);
        whenTh.setAttribute('aria-sort', logView.newestFirst ? 'descending' : 'ascending');
        headRow.replaceChildren(whenTh, ...['Event', 'Item', 'Attempt', 'Late by', 'Details', 'Graded by']
          .map(label => el('th', { scope: 'col', textContent: label })));
        const events = visibleEvents();
        body.replaceChildren(...events.map(e => el('tr', {},
          el('td', { className: 'cbt-log-when', title: stamp(e.at), textContent: shown(e.at) }),
          el('td', {}, tone(e.label, e.tone)),
          el('td', {}, itemCell(e)),
          el('td', { className: 'cbt-num', textContent: e.attempt }),
          el('td', { textContent: e.lateBy }),
          el('td', { className: 'cbt-log-detail', textContent: e.kind === 'participated' ? '' : e.detail }),
          el('td', { textContent: e.by }))));
        if (!events.length) body.replaceChildren(el('tr', {}, el('td', { colSpan: 7, textContent: 'Nothing to show.' })));
        count.textContent = `${events.length} event${plural(events.length)} · loaded ${new Date(data.at).toLocaleString()}`;
        exportBtn.disabled = !events.length;
      }
      render();

      ui.dialog.show(
        logTitle(s),
        el('div', { className: 'cbt-pace-tools' }, picker.node, kindPick, itemPick,
          el('span', { className: 'cbt-pace-spacer' }), exportBtn),
        el('p', { className: 'cbt-hint', textContent: facts }),
        missingItems.length ? el('p', { className: 'cbt-log-missing', textContent: `Missing: ${missingItems.join(', ')}` }) : '',
        data.analytics ? '' : el('p', { className: 'cbt-hint', textContent: 'Course Analytics isn’t available here, so page views and participation are left out.' }),
        quizNote,
        count,
        el('div', { className: 'cbt-pace-wrap' }, table),
        el('div', { className: 'cbt-actions' }, btn('Reload', () => pickStudent(s)), btn('Close', () => ui.dialog.close())),
      );
    }

    const REPORTS = [
      { label: 'Class Progress', hint: 'View Progress for your entire class', onSelect: open },
      { label: 'Submission Log', hint: 'Every submission, grade and visit for one student', onSelect: openLog },
    ];

    // Right of Batch Edit when it's there; otherwise where Batch Edit would
    // go (before + Module), or beside View Progress for those who can't edit.
    function place(button) {
      const batch = document.querySelector(SEL.batchEdit);
      if (batch && !batch.classList.contains('cbt-floating')) { if (batch.nextElementSibling !== button) batch.after(button); return; }
      launch.dock(button, document.querySelector(SEL.editorOnly) || document.querySelector(SEL.progressLink));
    }

    async function init() {
      if (!await waitFor(SEL.page) || !await waitFor(SEL.progressLink)) return;
      // Batch Edit adds its button as the page loads; give it a moment so ours lands after it.
      if (document.querySelector(SEL.editorOnly)) await waitFor(SEL.batchEdit, 3000);
      ui.menu = launchMenu('cbt-reports-toggle', 'Advanced Reports', REPORTS);
      place(ui.menu.button);
      ui.dialog = modal('cbt-pace-dialog');
      ui.dialog.node.addEventListener('close', () => {
        run++;
        launch.setPressed(ui.menu.button, false);
      });
    }

    return {
      name: 'Advanced Reports',
      matches: path => PAGE_RE.test(path),
      init,
    };
  }

  register(createAdvancedReportsFeature);
})();
