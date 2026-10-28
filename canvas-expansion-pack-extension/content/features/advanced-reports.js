// Canvas Expansion Pack: Advanced Reports (see the notes at the top of core.js).
//
// An "Advanced Reports ▾" menu on the Modules page, just right of Batch Edit.
// Reports are read-only: nothing is ever written. New reports go in REPORTS.
//
// Class Progress: Canvas's "View Progress" page shows one student at a time.
// This report loads every active student's module progress and due-date
// status into one sortable table, with a section filter, a name search and
// CSV downloads.
//
// Where the numbers come from:
//   - Module completion: the modules API with student_id, one call per
//     student (plus one per module whose items Canvas leaves out inline and
//     that has completion requirements).
//   - Due dates: the bulk submissions API, 50 students per request.
//     cached_due_date is that student's own due date after overrides, so
//     section dates and individual extensions count. Course Pacing publishes
//     its dates as overrides too, so paced courses should work the same way
//     (not yet checked on a paced course).
// Only published modules, items and assignments are counted, as students see them.
//
// The menu only appears where Canvas shows its own View Progress link,
// which Canvas limits to people who can see every student's grades.

(() => {
    'use strict';
  
    const {
      btn, canvas, chunk, courseId, debug, el, launch, launchMenu, mapLimit, modal, plural, sleep, waitFor,
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
      .cbt .cbt-pace-tools select,
      .cbt .cbt-pace-tools input[type=text] { width: auto; min-width: 200px; }
      .cbt-pace-spacer { flex: 1; }
      .cbt-pace-wrap {
        max-height: 60vh;
        overflow: auto;
        border: 1px solid var(--cbt-border-light);
        border-radius: 4px;
      }
      .cbt-pace-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .cbt-pace-table th,
      .cbt-pace-table td {
        padding: 6px 8px;
        border-bottom: 1px solid var(--cbt-border-light);
        text-align: left;
        white-space: nowrap;
      }
      .cbt-pace-table th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: #fff;
        box-shadow: inset 0 -1px 0 var(--cbt-border);
      }
      .cbt-pace-table .cbt-num { text-align: right; }
      .cbt-pace-table tbody tr:hover { background: var(--cbt-hover); }
      .cbt-pace-sort {
        padding: 0;
        background: none;
        border: 0;
        color: inherit;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      .cbt-pace-sort:hover { color: var(--cbt-primary); }
      .cbt-pace-table .cbt-pace-module { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
      .cbt-pace-table .cbt-pace-behind { color: var(--cbt-danger); font-weight: 600; }
      .cbt-pace-error { color: var(--cbt-danger); }
  
      .cbt-pace-table tbody tr { cursor: pointer; }
      .cbt-pace-table .cbt-pace-items tr { cursor: default; }
      .cbt-pace-table tbody tr.cbt-pace-open { background: var(--cbt-selected-row); }
      .cbt-pace-toggle {
        width: 20px;
        margin-right: 4px;
        padding: 0;
        background: none;
        border: 0;
        color: var(--cbt-muted);
        font: inherit;
        cursor: pointer;
      }
      .cbt-pace-table tr.cbt-pace-detail { cursor: default; background: var(--cbt-notice-bg); }
      .cbt-pace-table tr.cbt-pace-detail:hover { background: var(--cbt-notice-bg); }
      .cbt-pace-table tr.cbt-pace-detail > td { padding: 8px 12px 14px 32px; white-space: normal; }
      .cbt-pace-group h4 { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; font-size: 14px; }
      .cbt-pace-items { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--cbt-border-light); }
      .cbt-pace-table .cbt-pace-items th {
        position: static;
        box-shadow: none;
        background: var(--cbt-hover);
        font-weight: 600;
      }
      .cbt-pace-table .cbt-pace-items td,
      .cbt-pace-table .cbt-pace-items th { padding: 4px 8px; white-space: normal; }
      /* Fixed widths so every module's table lines up with the next */
      .cbt-pace-items { table-layout: fixed; }
      .cbt-pace-items th:nth-child(1) { width: 32%; }
      .cbt-pace-items th:nth-child(2) { width: 11%; }
      .cbt-pace-items th:nth-child(3) { width: 15%; }
      .cbt-pace-items th:nth-child(4) { width: 7%; }
      .cbt-pace-items th:nth-child(5),
      .cbt-pace-items th:nth-child(6) { width: 13%; }
      .cbt-pace-items th:nth-child(7) { width: 9%; }
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
      .cbt-pace-badge.cbt-pace-late { background: #FBEEE4; color: var(--cbt-warning); }
      .cbt-pace-badge.cbt-pace-behind { background: #FBE7E7; color: var(--cbt-danger); }
    `);
  
    // ==================================================================
    // Feature: Advanced Reports
    // ==================================================================
    function createAdvancedReportsFeature() {
      const PAGE_RE = /^\/courses\/\d+(\/modules)?\/?$/;
      const CONCURRENCY = 4;
      const SUBMISSION_CHUNK = 50; // students per bulk submissions request
      const MAX_PAGES = 200;
      const DAY_MS = 86_400_000;
  
      const SEL = {
        page: '#context_modules',
        progressLink: 'a[href$="/modules/progressions"]', // only shown to those who can see all grades
        batchEdit: '#cbt-mod-toggle',                     // Modules Batch Edit's menu button
        editorOnly: '.add_module_link',                   // where Batch Edit docks
      };
  
      // Assignment types that never get a submission and aren't graded work.
      const UNCOUNTED_TYPES = ['not_graded', 'wiki_page'];
      const TYPE_LABELS = {
        Assignment: 'Assignment', Quiz: 'Quiz', Discussion: 'Discussion', Page: 'Page', File: 'File',
        ExternalUrl: 'Link', ExternalTool: 'External tool',
      };
      const MODULE_STATES = { completed: 'Completed', started: 'Started', unlocked: 'Not started', locked: 'Locked' };
  
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
      async function load(token, onProgress) {
        const api = `/api/v1/courses/${courseId()}`;
        const [enrollments, sections, modules, assignments] = await Promise.all([
          getAll(`${api}/enrollments?type[]=StudentEnrollment&state[]=active`, token),
          getAll(`${api}/sections`, token),
          getAll(`${api}/modules?include[]=items`, token),
          getAll(`${api}/assignments`, token),
        ]);
        await mapLimit(modules.filter(m => !Array.isArray(m.items)), CONCURRENCY, async m => {
          m.items = await getAll(`${api}/modules/${m.id}/items`, token);
        });
  
        // Published modules and their published items, as students see them. Each
        // item keeps its requirement and the graded assignment behind it, if any.
        const assignmentFor = linkAssignments(assignments);
        const outline = modules
          .filter(m => m.published !== false)
          .sort((a, b) => a.position - b.position)
          .map(m => ({
            id: String(m.id),
            name: m.name,
            items: m.items
              .filter(i => i.published !== false && i.type !== 'SubHeader')
              .map(i => ({
                id: String(i.id),
                title: i.title,
                type: TYPE_LABELS[i.type] || i.type,
                url: i.html_url,
                requirement: i.completion_requirement ? requirementText(i.completion_requirement) : null,
                assignmentId: assignmentFor(i),
              })),
          }));
        for (const m of outline) m.requirements = new Set(m.items.filter(i => i.requirement).map(i => i.id));
        // Modules that count toward "Modules completed".
        const tracked = outline.filter(m => m.requirements.size);
        const inModules = new Set(outline.flatMap(m => m.items.map(i => i.assignmentId)).filter(Boolean));
        const loose = assignments
          .filter(a => a.published !== false && isCounted(a) && !inModules.has(String(a.id)))
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name).localeCompare(b.name))
          .map(a => ({ id: `a${a.id}`, title: a.name, type: a.is_quiz_assignment || a.quiz_id ? 'Quiz' : a.discussion_topic ? 'Discussion' : 'Assignment',
            url: a.html_url, requirement: null, assignmentId: String(a.id) }));
  
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
              lastActivity: null,
              submissions: [],
            });
          }
          const s = byUser.get(id);
          const section = sectionName.get(String(e.course_section_id));
          if (section && !s.sections.includes(section)) s.sections.push(section);
          const seen = e.last_activity_at ? Date.parse(e.last_activity_at) : null;
          if (seen && (!s.lastActivity || seen > s.lastActivity)) s.lastActivity = seen;
        }
        const students = [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
        const report = { students, outline, tracked, loose, hasSis: students.some(s => s.sisId) };
        if (!students.length) return { ...report, at: Date.now() };
  
        const groups = chunk(students, SUBMISSION_CHUNK);
        const steps = students.length + groups.length;
        let done = 0;
        const tick = () => onProgress(++done, steps);
        onProgress(0, steps);
  
        await mapLimit(students, CONCURRENCY, async s => {
          const theirs = await getAll(`${api}/modules?include[]=items&student_id=${s.id}`, token);
          // Items Canvas left out inline are only fetched for modules with requirements.
          for (const m of theirs) {
            if (!Array.isArray(m.items) && tracked.some(t => t.id === String(m.id))) {
              m.items = await getAll(`${api}/modules/${m.id}/items?student_id=${s.id}`, token);
            }
          }
          s.modules = summarizeModules(tracked, theirs);
          tick();
        });
  
        await mapLimit(groups, CONCURRENCY, async group => {
          const ids = group.map(s => `student_ids[]=${s.id}`).join('&');
          for (const sub of await getAll(`${api}/students/submissions?${ids}`, token)) {
            byUser.get(String(sub.user_id))?.submissions.push(sub);
          }
          tick();
        });
  
        const at = Date.now();
        const counted = new Set(assignments.filter(a => a.published !== false && isCounted(a)).map(a => String(a.id)));
        for (const s of students) {
          s.work = new Map(s.submissions
            .filter(sub => counted.has(String(sub.assignment_id)))
            .map(sub => [String(sub.assignment_id), workStatus(sub, at)]));
          delete s.submissions;
          s.due = summarizeDue(s.work, at);
        }
        debug('class progress: loaded', students.length, 'students,', tracked.length, 'modules,', counted.size, 'assignments');
        return { ...report, at };
      }
  
      const isCounted = a => !(a.submission_types || []).some(t => UNCOUNTED_TYPES.includes(t));
  
      // Finds the assignment behind a module item. Classic quizzes and graded
      // discussions point at their own ids, so those are matched through the assignment.
      function linkAssignments(assignments) {
        const ids = new Map();
        for (const a of assignments) {
          if (a.published === false || !isCounted(a)) continue;
          ids.set(`Assignment:${a.id}`, String(a.id));
          if (a.quiz_id) ids.set(`Quiz:${a.quiz_id}`, String(a.id));
          if (a.discussion_topic?.id) ids.set(`Discussion:${a.discussion_topic.id}`, String(a.id));
        }
        return item => ids.get(`${item.type}:${item.content_id}`) || null;
      }
  
      function requirementText(req) {
        switch (req.type) {
          case 'must_view': return 'View';
          case 'must_submit': return 'Submit';
          case 'must_contribute': return 'Contribute';
          case 'must_mark_done': return 'Mark done';
          case 'min_score': return `Score at least ${req.min_score}`;
          case 'min_percentage': return `Score at least ${req.min_percentage}%`;
          default: return String(req.type || 'Required').replace(/_/g, ' ');
        }
      }
  
      // Module completion for one student, against the modules being tracked.
      // A module Canvas doesn't return for this student (not assigned to them) isn't counted.
      function summarizeModules(tracked, theirs) {
        const out = { done: 0, total: 0, met: 0, required: 0, current: null, states: {}, visible: new Set(), metById: new Map() };
        for (const m of theirs) out.visible.add(String(m.id));
        for (const t of tracked) {
          const m = theirs.find(x => String(x.id) === t.id);
          if (!m) continue;
          out.total++;
          out.states[t.id] = m.state;
          if (m.state === 'completed') out.done++;
          else if (!out.current) out.current = t.name;
          for (const item of m.items || []) {
            if (!t.requirements.has(String(item.id))) continue;
            const met = !!item.completion_requirement?.completed;
            out.metById.set(String(item.id), met);
            out.required++;
            if (met) out.met++;
          }
        }
        return out;
      }
  
      // One student's status on one assignment.
      function workStatus(sub, now) {
        const dueAt = sub.cached_due_date ? Date.parse(sub.cached_due_date) : null;
        const done = !sub.missing && (!!sub.submitted_at || sub.workflow_state === 'graded');
        const status = sub.excused ? 'Excused'
          : !done ? (dueAt == null ? 'Not submitted' : dueAt > now ? 'Upcoming' : 'Overdue')
          : sub.late ? 'Late'
          : dueAt == null ? 'Done' : 'On time';
        const submittedAt = sub.submitted_at ? Date.parse(sub.submitted_at) : null;
        return { status, dueAt, submittedAt, graded: sub.workflow_state === 'graded' };
      }
  
      // Due-date totals for one student. Only work whose due date has passed is
      // counted; work with no due date, excused work and future work are left out.
      function summarizeDue(work, now) {
        const out = { due: 0, onTime: 0, late: 0, notDone: 0, oldest: null };
        for (const w of work.values()) {
          if (w.status === 'Excused' || w.dueAt == null || w.dueAt > now) continue;
          out.due++;
          if (w.status === 'Overdue') {
            out.notDone++;
            if (out.oldest == null || w.dueAt < out.oldest) out.oldest = w.dueAt;
          } else if (w.status === 'Late') out.late++;
          else out.onTime++;
        }
        out.daysBehind = out.oldest == null ? 0 : Math.floor((now - out.oldest) / DAY_MS);
        return out;
      }
  
      // Everything listed for one student, grouped by module: each item with a
      // requirement or a graded assignment assigned to them. Items with neither
      // (an unrequired page, say) aren't listed, since Canvas tracks nothing for them.
      function detailFor(s) {
        const row = item => {
          const met = item.requirement ? s.modules.metById.get(item.id) : undefined;
          const work = item.assignmentId ? s.work.get(item.assignmentId) : undefined;
          if (met === undefined && !work) return null;
          return { ...item, met, work };
        };
        const groups = report.outline
          .filter(m => s.modules.visible.has(m.id))
          .map(m => ({
            name: m.name,
            state: m.requirements.size ? MODULE_STATES[s.modules.states[m.id]] || '' : 'No requirements',
            rows: m.items.map(row).filter(Boolean),
          }));
        groups.push({ name: 'Not in a module', state: '', rows: report.loose.map(row).filter(Boolean) });
        return groups.filter(g => g.rows.length);
      }
  
      // ---- Formatting ----
      const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);
      const isoDate = t => {
        const d = new Date(t);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const shortDate = t => {
        const d = new Date(t);
        const opts = { month: 'short', day: 'numeric' };
        if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
        return d.toLocaleDateString(undefined, opts);
      };
      const dateTime = t => `${shortDate(t)}, ${new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  
      // Each column: what the table shows, what it sorts by, and what goes in the CSV.
      const COLUMNS = [
        { key: 'name', label: 'Student', text: s => s.name, sort: s => s.name.toLowerCase(),
          cell: s => el('a', { href: `/courses/${courseId()}/grades/${s.id}`, target: '_blank', rel: 'noopener', textContent: s.name }) },
        { key: 'sis', label: 'SIS ID', sis: true, text: s => s.sisId, sort: s => s.sisId },
        { key: 'section', label: 'Section', text: s => s.sections.join('; '), sort: s => s.sections.join('; ').toLowerCase() },
        { key: 'modules', label: 'Modules completed', num: true,
          text: s => (s.modules.total ? `${s.modules.done} of ${s.modules.total}` : '—'),
          sort: s => pct(s.modules.done, s.modules.total) ?? -1 },
        { key: 'requirements', label: 'Requirements met', num: true,
          text: s => (s.modules.required ? `${pct(s.modules.met, s.modules.required)}% (${s.modules.met}/${s.modules.required})` : '—'),
          sort: s => pct(s.modules.met, s.modules.required) ?? -1 },
        { key: 'current', label: 'Current module', className: 'cbt-pace-module',
          text: s => (s.modules.total ? s.modules.current || 'All complete' : '—'),
          sort: s => s.modules.current?.toLowerCase() ?? '' },
        { key: 'due', label: 'Due so far', num: true, text: s => String(s.due.due), sort: s => s.due.due },
        { key: 'onTime', label: 'On time', num: true, text: s => String(s.due.onTime), sort: s => s.due.onTime },
        { key: 'late', label: 'Late', num: true, text: s => String(s.due.late), sort: s => s.due.late },
        { key: 'notDone', label: 'Overdue', num: true, text: s => String(s.due.notDone), sort: s => s.due.notDone,
          warn: s => s.due.notDone > 0 },
        { key: 'behind', label: 'Days behind', num: true, text: s => String(s.due.daysBehind), sort: s => s.due.daysBehind,
          warn: s => s.due.daysBehind > 0 },
        { key: 'activity', label: 'Last activity', text: s => (s.lastActivity ? shortDate(s.lastActivity) : 'Never'),
          sort: s => s.lastActivity ?? 0 },
      ];
  
      // Spreadsheet apps run cells that start with these as formulas.
      const csvCell = v => {
        let s = v == null ? '' : String(v);
        if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
  
      function toCsv(rows, tracked) {
        const head = [
          'Student', ...sisHead(), 'Sections', 'Modules completed', 'Modules total', 'Requirements met',
          'Requirements total', 'Requirements %', 'Current module', 'Due so far', 'On time', 'Late', 'Overdue',
          'Days behind', 'Oldest overdue due date', 'Last activity', ...tracked.map(t => `Module: ${t.name}`),
        ];
        const lines = rows.map(s => [
          s.name, ...sisCell(s), s.sections.join('; '), s.modules.done, s.modules.total, s.modules.met, s.modules.required,
          pct(s.modules.met, s.modules.required) ?? '', s.modules.total ? s.modules.current || 'All complete' : '',
          s.due.due, s.due.onTime, s.due.late, s.due.notDone, s.due.daysBehind,
          s.due.oldest ? isoDate(s.due.oldest) : '', s.lastActivity ? isoDate(s.lastActivity) : '',
          ...tracked.map(t => MODULE_STATES[s.modules.states[t.id]] || ''),
        ]);
        return [head, ...lines].map(r => r.map(csvCell).join(',')).join('\r\n');
      }
  
      // The SIS ID column only appears when Canvas gave us SIS ids.
      const sisHead = () => (report.hasSis ? ['SIS ID'] : []);
      const sisCell = s => (report.hasSis ? [s.sisId] : []);
      const columns = () => COLUMNS.filter(c => !c.sis || report.hasSis);
  
      // One line per student per listed item, for filtering and pivot tables.
      function toDetailCsv(rows) {
        const head = ['Student', ...sisHead(), 'Sections', 'Module', 'Module status', 'Item', 'Type', 'Requirement',
          'Requirement met', 'Due date', 'Submitted', 'Status'];
        const lines = rows.flatMap(s => detailFor(s).flatMap(g => g.rows.map(r => [
          s.name, ...sisCell(s), s.sections.join('; '), g.name, g.state, r.title, r.type, r.requirement || '',
          r.met === undefined ? '' : r.met ? 'Yes' : 'No',
          r.work?.dueAt ? isoDate(r.work.dueAt) : '', r.work?.submittedAt ? isoDate(r.work.submittedAt) : '',
          r.work?.status || '',
        ])));
        return [head, ...lines].map(r => r.map(csvCell).join(',')).join('\r\n');
      }
  
      const STATUS_CLASS = {
        'On time': 'cbt-pace-good', Done: 'cbt-pace-good', Completed: 'cbt-pace-good', Yes: 'cbt-pace-good',
        Late: 'cbt-pace-late', Started: 'cbt-pace-late',
        Overdue: 'cbt-pace-behind',
      };
      const badge = text => el('span', { className: `cbt-pace-badge ${STATUS_CLASS[text] || ''}`.trim(), textContent: text });
  
      // The expanded view under a student's row: one small table per module.
      function detailView(s) {
        const groups = detailFor(s);
        if (!groups.length) return el('p', { className: 'cbt-hint', textContent: 'Nothing with a requirement or a due date is assigned to this student.' });
        return el('div', { className: 'cbt-pace-detail-body' }, ...groups.map(g => el('section', { className: 'cbt-pace-group' },
          el('h4', {}, el('span', { textContent: g.name }), g.state ? badge(g.state) : ''),
          el('table', { className: 'cbt-pace-items' },
            el('thead', {}, el('tr', {}, ...['Item', 'Type', 'Requirement', 'Met', 'Due', 'Submitted', 'Status']
              .map(h => el('th', { scope: 'col', textContent: h })))),
            el('tbody', {}, ...g.rows.map(r => el('tr', {},
              el('td', {}, r.url ? el('a', { href: r.url, target: '_blank', rel: 'noopener', textContent: r.title }) : r.title),
              el('td', { textContent: r.type }),
              el('td', { textContent: r.requirement || '—' }),
              el('td', {}, r.met === undefined ? '—' : badge(r.met ? 'Yes' : 'No')),
              el('td', { textContent: r.work?.dueAt ? dateTime(r.work.dueAt) : '—' }),
              el('td', { textContent: r.work?.submittedAt ? dateTime(r.work.submittedAt) : r.work?.graded ? 'Graded' : '—' }),
              el('td', {}, r.work ? badge(r.work.status) : '—'),
            )))))));
      }
  
      function download(name, text) {
        // The BOM makes Excel read names with accents correctly.
        const url = URL.createObjectURL(new Blob(['\ufeff', text], { type: 'text/csv;charset=utf-8' }));
        const a = el('a', { href: url, download: name });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
  
      // ---- UI ----
      const ui = {};
      const view = { sort: 'name', desc: false, section: '', search: '', open: new Set() };
      let report = null;
  
      const title = () => el('h2', { textContent: 'Class progress' });
  
      async function open() {
        launch.setPressed(ui.menu.button, true);
        const token = ++run;
        const progress = el('progress');
        const status = el('p', { className: 'cbt-hint', textContent: 'Loading the class list, modules and assignments…' });
        ui.dialog.show(title(), progress, status, el('div', { className: 'cbt-actions' }, btn('Cancel', () => ui.dialog.close())));
        try {
          report = await load(token, (done, total) => {
            progress.max = total;
            progress.value = done;
            status.textContent = `Loading student progress: ${done} of ${total} steps…`;
          });
          if (token === run) showReport();
        } catch (e) {
          if (e instanceof Cancelled || token !== run) return;
          run++; // stop any requests still running
          console.error('[Canvas Expansion Pack] Class Progress failed:', e);
          ui.dialog.show(title(),
            el('p', { className: 'cbt-pace-error', textContent: `Couldn't load the report: ${e.message}.` }),
            el('p', { className: 'cbt-hint', textContent: 'The report needs permission to see every student’s grades and progress.' }),
            el('div', { className: 'cbt-actions' }, btn('Try again', open), btn('Close', () => ui.dialog.close(), 'cbt-primary')));
        }
      }
  
      function visibleRows() {
        const col = COLUMNS.find(c => c.key === view.sort);
        const q = view.search.trim().toLowerCase();
        const rows = report.students.filter(s =>
          (!view.section || s.sections.includes(view.section)) && (!q || s.name.toLowerCase().includes(q)));
        return rows.sort((a, b) => {
          const x = col.sort(a);
          const y = col.sort(b);
          const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
          return (view.desc ? -c : c) || a.name.localeCompare(b.name);
        });
      }
  
      function showReport() {
        const { students, tracked, at } = report;
        if (!students.length) {
          ui.dialog.show(title(), el('p', { textContent: 'This course has no active students.' }),
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
  
        const fileName = kind => `class-progress-${kind}course-${courseId()}-${isoDate(at)}.csv`;
        const exportBtn = btn('Download summary CSV', () => download(fileName(''), toCsv(visibleRows(), tracked)), 'cbt-primary');
        const detailBtn = btn('Download detail CSV', () => download(fileName('detail-'), toDetailCsv(visibleRows())));
        const expandBtn = btn('Expand all', () => {
          const rows = visibleRows();
          const all = rows.every(s => view.open.has(s.id));
          for (const s of rows) all ? view.open.delete(s.id) : view.open.add(s.id);
          render();
        });
  
        const summary = el('p', { className: 'cbt-hint' });
        const headRow = el('tr');
        const body = el('tbody');
        const table = el('table', { className: 'cbt-pace-table' }, el('thead', {}, headRow), body);
  
        function render() {
          headRow.replaceChildren(...columns().map(c => {
            const sortBtn = btn(c.label + (view.sort === c.key ? (view.desc ? ' ▼' : ' ▲') : ''), () => {
              if (view.sort === c.key) view.desc = !view.desc;
              else { view.sort = c.key; view.desc = !!c.num; } // numbers start biggest first
              render();
            }, 'cbt-pace-sort');
            sortBtn.classList.remove('cbt-btn');
            const th = el('th', { scope: 'col', className: c.num ? 'cbt-num' : '' }, sortBtn);
            th.setAttribute('aria-sort', view.sort === c.key ? (view.desc ? 'descending' : 'ascending') : 'none');
            return th;
          }));
  
          const rows = visibleRows();
          body.replaceChildren(...rows.flatMap(s => {
            const isOpen = view.open.has(s.id);
            const toggle = el('button', { type: 'button', className: 'cbt-pace-toggle', textContent: isOpen ? '▾' : '▸',
              ariaLabel: `${isOpen ? 'Hide' : 'Show'} details for ${s.name}`, ariaExpanded: String(isOpen) });
            const flip = () => { isOpen ? view.open.delete(s.id) : view.open.add(s.id); render(); };
            toggle.addEventListener('click', flip);
            const tr = el('tr', { className: isOpen ? 'cbt-pace-open' : '' }, ...columns().map((c, i) => {
              const classes = [c.num && 'cbt-num', c.className, c.warn?.(s) && 'cbt-pace-behind'].filter(Boolean).join(' ');
              const td = el('td', { className: classes }, ...(i === 0 ? [toggle] : []), c.cell ? c.cell(s) : c.text(s));
              if (c.className === 'cbt-pace-module') td.title = c.text(s);
              return td;
            }));
            // Clicking anywhere on the row opens it, except on a link.
            tr.addEventListener('click', e => { if (!e.target.closest('a, button')) flip(); });
            if (!isOpen) return [tr];
            return [tr, el('tr', { className: 'cbt-pace-detail' }, el('td', { colSpan: columns().length }, detailView(s)))];
          }));
          expandBtn.textContent = rows.length && rows.every(s => view.open.has(s.id)) ? 'Collapse all' : 'Expand all';
          summary.textContent = `Showing ${rows.length} of ${students.length} student${plural(students.length)}. ` +
            `As of ${new Date(at).toLocaleString()}.`;
          exportBtn.disabled = detailBtn.disabled = expandBtn.disabled = !rows.length;
        }
        render();
  
        ui.dialog.show(
          title(),
          // el('p', { className: 'cbt-hint', textContent:
          //  `${tracked.length} module${plural(tracked.length)} with completion requirements. ` +
          //  '“Due so far” counts published assignments, quizzes and graded discussions whose due date (each student’s own, after overrides) has passed. ' +
          //  'Work with no submission is counted as done once it’s graded. ' +
           // '“Days behind” is how long ago the oldest overdue item was due. ' +
           // 'Click a student to see every requirement and assignment.' }),
          el('div', { className: 'cbt-pace-tools' }, sectionPick, search, expandBtn,
            el('span', { className: 'cbt-pace-spacer' }), detailBtn, exportBtn),
          summary,
          el('div', { className: 'cbt-pace-wrap' }, table),
          el('div', { className: 'cbt-actions' }, btn('Reload', open), btn('Close', () => ui.dialog.close())),
        );
      }
  
      const REPORTS = [
        { label: 'Class Progress', hint: 'View Progress for your entire class', onSelect: open },
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
  