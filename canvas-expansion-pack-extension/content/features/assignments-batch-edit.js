// Canvas Expansion Pack: Assignments Batch Edit (see the notes at the top of core.js).
//
// The Modules Batch Edit tools for the Assignments page: select assignments
// with checkboxes (Shift-click for a range, or a whole group), then move them
// to another spot or assignment group, publish, unpublish, or delete them.
// The bar, preview, apply loop and move picker come from bulk-edit.js.

(() => {
    'use strict';
  
    const {
      canvas, courseId, el, launch, sessionStore, waitFor, addStyles, register, bulkEditor, moveTree,
    } = window.__canvasExpansionPack;
  
    addStyles(String.raw`
      /* ================= Assignments Batch Edit ================= */
      body.cbt-asg-on { padding-bottom: 110px; } /* keep the bar off the last assignments */
      body.cbt-asg-on li.cbt-asg-row .ig-row {
        cursor: pointer;
        user-select: none; /* Shift-click selects a range, not text */
      }
      body.cbt-asg-on li.cbt-asg-row:not(.cbt-asg-selected):hover .ig-row {
        background: var(--cbt-hover) !important;
      }
      body.cbt-asg-on li.cbt-asg-selected .ig-row {
        background: var(--cbt-selected-row) !important;
      }
    `);
  
    function createAssignmentsBatchEditFeature() {
      const PAGE_RE = /^\/courses\/\d+\/assignments\/?$/;
      const PAUSE_MS = 200;
  
      // The Assignments index page (teacher view).
      const SEL = {
        page: '#ag-list',
        toolbarAnchor: '#addGroup, .new_assignment',
        editorOnly: '#addGroup, .new_assignment, #ag-list .ig-admin',
        group: id => document.getElementById(`assignment_group_${id}`),
        groupHeader: '.ig-header',
        item: id => document.getElementById(`assignment_${id}`),
        itemPrefix: 'assignment_',
        itemRow: '.ig-row',
        itemLayout: '.ig-row__layout',
        dragHandle: '.draggable-handle',
        rowPassThrough: '.draggable-handle, .ig-admin, button, input, select, textarea',
      };
  
      const state = { groups: [], order: [], index: new Map() };
      const selected = new Set();
  
      const cid = () => courseId();
      const assignmentPath = a => `/api/v1/courses/${cid()}/assignments/${a.id}`;
      const groupById = id => state.groups.find(g => String(g.id) === String(id));
  
      const ICONS = { quiz: 'icon-quiz', discussion: 'icon-discussion', page: 'icon-document' };
      const kindOf = a => {
        const types = a.submission_types || [];
        if (a.is_quiz_assignment || a.is_quiz_lti_assignment || types.includes('online_quiz')) return 'quiz';
        if (types.includes('discussion_topic')) return 'discussion';
        if (types.includes('wiki_page')) return 'page';
        return 'assignment';
      };
  
      // Actions follow the shape described in bulk-edit.js; the group is the assignment group.
      // Publish, unpublish and delete use the same calls as the Assignments page's own
      // buttons, so quizzes and graded discussions follow along the way they do there.
      const ACTIONS = [
        {
          id: 'move',
          short: 'Move', icon: 'icon-updown',
          label: 'Move', button: 'Move', done: 'moved',
          note: 'Moved assignments stay in the order they appear on the page.',
          collapseDetails: true,
          controls: moveControls,
          planAll: planMove,
        },
        {
          id: 'publish',
          short: 'Publish', icon: 'icon-publish',
          label: 'Publish', button: 'Publish', done: 'published',
          plan: a => (a.published ? { skip: 'already published' } : { change: 'publish' }),
          run: a => canvas.request('PUT', assignmentPath(a), { assignment: { published: true } }),
        },
        {
          id: 'unpublish',
          short: 'Unpublish', icon: 'icon-unpublish',
          label: 'Unpublish', button: 'Unpublish', done: 'unpublished',
          plan: a => {
            if (!a.published) return { skip: 'already unpublished' };
            if (a.unpublishable === false) return { skip: "can't be unpublished: students have submitted" };
            return { change: 'unpublish' };
          },
          run: a => canvas.request('PUT', assignmentPath(a), { assignment: { published: false } }),
        },
        {
          id: 'delete', danger: true,
          short: 'Delete', icon: 'icon-trash',
          label: 'Delete', button: 'Delete', done: 'deleted',
          confirmWord: 'delete',
          note: 'This deletes the assignments from the course, not just from this page. ' +
            'Their submissions and grades go with them, and quizzes and graded discussions are deleted too.',
          plan: a => ({ change: a.has_submitted_submissions ? 'delete (students have submitted)' : 'delete' }),
          run: a => canvas.request('DELETE', assignmentPath(a)),
        },
      ];
  
      // ---- Move ----
      function moveControls(picked) {
        return moveTree({
          groups: state.groups.map(g => ({
            id: g.id,
            name: g.name,
            items: g.assignments.map(a => ({ id: a.id, title: a.name, icon: ICONS[kindOf(a)] || 'icon-assignment' })),
          })),
          moving: new Set(picked.map(r => String(r.item.id))),
          expand: picked.map(r => String(r.group.id)),
          count: picked.length,
          noun: 'assignment',
          groupNoun: 'assignment group',
        });
      }
  
      // One request does the whole move: Canvas's own drag-and-drop endpoint
      // takes the destination group's full new order, and moves any assignment
      // in that list into the group.
      function planMove(picked, { groupId, where }) {
        const dest = groupById(groupId);
        if (!dest || !where) return { pending: 'Click where the assignments should go.' };
        const destId = String(dest.id);
        const sequence = picked.map(r => String(r.item.id));
        const moving = new Set(sequence);
  
        const current = dest.assignments.map(a => String(a.id));
        const staying = current.filter(id => !moving.has(id));
        const at = where === 'top' ? 0 : staying.indexOf(where.slice('after:'.length)) + 1;
        const target = [...staying.slice(0, at), ...sequence, ...staying.slice(at)];
        const pos = new Map(target.map((id, i) => [id, i]));
  
        const change = [], skip = [];
        for (const { item, group, title } of picked) {
          const id = String(item.id);
          const row = { item, group, title };
          const spot = `position ${pos.get(id) + 1}`;
          if (String(group.id) === destId && current.indexOf(id) === pos.get(id)) {
            skip.push({ ...row, text: `already at ${spot}` });
          } else {
            change.push({ ...row, text: String(group.id) === destId ? `move to ${spot}` : `move to ${dest.name}, ${spot}` });
          }
        }
        const runAll = () => canvas.request('POST', `/courses/${cid()}/assignment_groups/${dest.id}/reorder`,
          { order: target.join(',') });
        return { change, skip, runAll };
      }
  
      // ---- Data ----
      async function loadCourse() {
        const groups = await canvas.getAll(`/api/v1/courses/${cid()}/assignment_groups?include[]=assignments` +
          '&exclude_response_fields[]=description&exclude_response_fields[]=rubric');
        const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0);
        groups.sort(byPosition);
        for (const g of groups) (g.assignments ||= []).sort(byPosition);
  
        state.groups = groups;
        state.order = groups.flatMap(g => g.assignments.map(a => String(a.id)));
        state.index = new Map(state.order.map((id, i) => [id, i]));
        for (const id of selected) if (!state.index.has(id)) selected.delete(id);
      }
  
      const store = sessionStore('cbt-assignments');
  
      // ---- UI ----
      const ui = {};
      let editor = null;
      let bulkOn = false;
      let loaded = false;
      let lastClicked = null;
      let observer = null;
      let session = 0;
      let decorateQueued = false;
  
      function buildUI() {
        ui.launch = launch.create('cbt-asg-toggle', 'Batch Edit', () => (bulkOn ? exitBulk() : enterBulk()));
        const anchor = document.querySelector(SEL.toolbarAnchor);
        if (anchor) launch.dock(ui.launch, anchor);
        else launch.float(ui.launch);
  
        editor = bulkEditor({
          key: 'asg',
          noun: 'assignment',
          actions: ACTIONS,
          picked: selectedRows,
          onSelectAll: on => {
            if (on) state.order.forEach(id => selected.add(id));
            else selected.clear();
            sync();
          },
          onExit: exitBulk,
          onChange: sync,
          // Reload so the page shows Canvas's real state; the notice and selection survive it.
          afterApply: (notice, ok) => {
            if (!ok || !store.write({ selected: [...selected], notice })) return false;
            location.reload();
            return true;
          },
          pauseMs: PAUSE_MS,
        });
      }
  
      async function enterBulk(saved) {
        const mine = ++session;
        bulkOn = true;
        document.body.classList.add('cbt-asg-on');
        launch.setPressed(ui.launch, true, 'Exit Batch Edit');
        editor.show();
        (saved?.selected || []).forEach(id => selected.add(String(id)));
  
        editor.setBusy(true, 'Loading assignments…');
        try {
          await loadCourse();
        } catch (e) {
          if (mine !== session) return;
          editor.setBusy(false, 'Could not load assignments: ' + e.message, true);
          return;
        }
        if (mine !== session) return; // exited (or re-entered) while loading
        loaded = true;
        editor.setBusy(false);
  
        decorate();
        ui.page = document.querySelector(SEL.page) || document.body;
        observer = new MutationObserver(queueDecorate);
        observer.observe(ui.page, { childList: true, subtree: true });
        ui.page.addEventListener('click', onRowClick, true);
        if (state.order.length && !state.order.some(id => SEL.item(id))) {
          sync("Couldn't find the assignments on this page to add checkboxes.", true);
        }
        editor.ui.selAll.focus();
      }
  
      function exitBulk() {
        session++;
        bulkOn = false;
        loaded = false;
        observer?.disconnect();
        observer = null;
        ui.page?.removeEventListener('click', onRowClick, true);
        document.body.classList.remove('cbt-asg-on');
        document.querySelectorAll('.cbt-asg-injected').forEach(cb => cb.remove());
        document.querySelectorAll('li.cbt-asg-row').forEach(li => li.classList.remove('cbt-asg-row', 'cbt-asg-selected'));
        selected.clear();
        lastClicked = null;
        editor.setBusy(false);
        editor.hide();
        launch.setPressed(ui.launch, false, 'Batch Edit');
        store.clear();
      }
  
      // Coalesces page mutations into one pass per frame, and ignores the
      // mutations our own checkbox insertions cause.
      function queueDecorate(records) {
        const ours = records.every(r => !r.removedNodes.length &&
          [...r.addedNodes].every(n => n.classList?.contains('cbt-asg-injected')));
        if (ours || decorateQueued) return;
        decorateQueued = true;
        requestAnimationFrame(() => { decorateQueued = false; decorate(); });
      }
  
      function pageCheckbox(label) {
        const cb = el('input', { type: 'checkbox', className: 'cbt-bulk-check cbt-asg-injected', ariaLabel: label });
        // Keep Canvas's own handlers (drag, collapse the group, open the assignment) from seeing these clicks.
        ['click', 'mousedown', 'pointerdown', 'keydown'].forEach(t => cb.addEventListener(t, e => e.stopPropagation()));
        return cb;
      }
  
      function decorate() {
        if (!bulkOn || !loaded) return;
        for (const g of state.groups) {
          for (const a of g.assignments) {
            const li = SEL.item(a.id);
            if (!li || li.querySelector('.cbt-asg-injected[data-id]')) continue;
            const id = String(a.id);
            const cb = pageCheckbox(`Select ${a.name}`);
            cb.dataset.id = id;
            cb.addEventListener('click', e => toggleItem(id, cb.checked, e.shiftKey));
            li.classList.add('cbt-asg-row');
            const row = li.querySelector(SEL.itemRow) || li;
            const handle = row.querySelector(SEL.dragHandle);
            if (handle) handle.after(cb);
            else (row.querySelector(SEL.itemLayout) || row).prepend(cb);
          }
  
          const head = SEL.group(g.id)?.querySelector(SEL.groupHeader);
          if (!head || head.querySelector('.cbt-asg-injected[data-group]')) continue;
          const cb = pageCheckbox(`Select all assignments in ${g.name}`);
          cb.dataset.group = g.id;
          cb.disabled = !g.assignments.length;
          cb.addEventListener('change', () => {
            for (const a of g.assignments) {
              if (cb.checked) selected.add(String(a.id));
              else selected.delete(String(a.id));
            }
            sync();
          });
          head.prepend(cb);
        }
        sync();
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
  
      // Clicking anywhere on a row (except its own controls) toggles it.
      function onRowClick(e) {
        if (editor.busy || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
        const li = e.target.closest('li.cbt-asg-row');
        if (!li || e.target.closest(SEL.rowPassThrough)) return;
        const id = li.id.slice(SEL.itemPrefix.length);
        if (!state.index.has(id)) return;
        e.preventDefault();
        e.stopPropagation();
        toggleItem(id, !selected.has(id), e.shiftKey);
      }
  
      function sync(message, warn) {
        document.querySelectorAll('.cbt-asg-injected[data-id]').forEach(cb => {
          const on = selected.has(cb.dataset.id);
          cb.checked = on;
          cb.closest('li.cbt-asg-row')?.classList.toggle('cbt-asg-selected', on);
        });
        for (const g of state.groups) {
          const box = SEL.group(g.id)?.querySelector('.cbt-asg-injected[data-group]');
          if (!box) continue;
          const n = g.assignments.reduce((sum, a) => sum + selected.has(String(a.id)), 0);
          box.checked = n > 0 && n === g.assignments.length;
          box.indeterminate = n > 0 && n < g.assignments.length;
        }
        editor.syncBar({ selected: selected.size, total: state.order.length, message, warn });
      }
  
      const selectedRows = () => state.groups.flatMap(group =>
        group.assignments.filter(a => selected.has(String(a.id))).map(item => ({ item, group, title: item.name })));
  
      async function init() {
        // Only teachers and others who can edit see these controls.
        if (!await waitFor(SEL.editorOnly, 15_000)) return;
        buildUI();
        const saved = store.take();
        if (!saved) return;
        await enterBulk(saved);
        if (saved.notice) editor.showNotice(saved.notice);
      }
  
      return {
        name: 'Assignments Batch Edit',
        matches: path => PAGE_RE.test(path),
        init,
      };
    }
  
    register(createAssignmentsBatchEditFeature);
  })();
  