// Canvas Expansion Pack: Modules Batch Edit (see the notes at the top of core.js).

(() => {
  'use strict';

  const {
    btn, canvas, chunk, courseId, debug, el, job, launch, launchMenu, mapLimit, paced,
    plural, sessionStore, toast, waitFor, addStyles, register, bulkEditor, moveTree, planList,
  } = window.__canvasExpansionPack;

  addStyles(String.raw`
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
  `);

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

    // Actions follow the shape described in bulk-edit.js; the group is the module.
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
      return moveTree({
        groups: state.modules.map(m => ({
          id: m.id,
          name: m.name,
          items: m.items.map(item => ({ id: item.id, title: item.title, icon: ITEM_ICONS[item.type],
            indent: indentOf(item), bold: item.type === 'SubHeader' })),
        })),
        moving: new Set(picked.map(r => String(r.item.id))),
        expand: picked.map(r => String(r.group.id)),
        count: picked.length,
        noun: 'item',
        groupNoun: 'module',
      });
    }

    // Plans a move as the fewest single-item PUTs: items already in the right
    // relative spot are skipped, and each run() places its item after the last
    // settled neighbour, tracking every list locally as it goes.
    function planMove(picked, { groupId, where }) {
      const dest = moduleById(groupId);
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
      for (const { item, group: module } of picked) {
        const id = String(item.id);
        const row = { item, group: module, title: item.title };
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
    let editor = null;
    let bulkOn = false;
    let loaded = false;
    let lastClicked = null;
    let observer = null;
    let outside = null;
    let session = 0;
    let decorateQueued = false;

    function buildUI() {
      ui.batch = launchMenu('cbt-mod-toggle', 'Batch Edit', [
        { label: 'Edit items', hint: 'Select items to move, indent, publish, or remove', onSelect: () => enterBulk() },
        { label: 'Rename items…', hint: 'Select items, then rename them together', onSelect: () => enterBulk(null, 'rename') },
        { label: 'Rename modules…', hint: 'Rename every module at once', onSelect: showRenameModules },
      ]);
      const anchor = document.querySelector(SEL.toolbarAnchor);
      if (anchor) launch.dock(ui.batch.button, anchor);
      else launch.float(ui.batch.button);

      editor = bulkEditor({
        key: 'mod',
        noun: 'item',
        actions: ACTIONS,
        extraTools: [{ short: 'Rename selected…', icon: 'icon-edit', onClick: showRenameItems }],
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
      ui.tools = editor.ui.tools;
      ui.renameTool = ui.tools.at(-1);
      ui.renameTool.hidden = true;
      ui.dialog = editor.dialog;
    }

    // mode 'edit' shows the edit tools; 'rename' shows only "Rename selected…".
    // Selecting items works the same way in both.
    async function enterBulk(saved, mode = 'edit') {
      const mine = ++session;
      bulkOn = true;
      const renaming = mode === 'rename';
      ui.tools.forEach(b => { b.hidden = (b === ui.renameTool) !== renaming; });
      document.body.classList.add('cbt-mod-on');
      ui.batch.setOverride({ label: renaming ? 'Exit Rename Items' : 'Exit Bulk Edit', onClick: exitBulk });
      editor.show();
      (saved?.selected || []).forEach(id => selected.add(String(id)));

      editor.setBusy(true, 'Loading modules…');
      try {
        await loadCourse();
      } catch (e) {
        if (mine !== session) return;
        editor.setBusy(false, 'Could not load modules: ' + e.message, true);
        return;
      }
      if (mine !== session) return; // exited (or re-entered) while loading
      loaded = true;
      editor.setBusy(false);

      decorate();
      observer = new MutationObserver(queueDecorate);
      ui.page = document.querySelector(SEL.page);
      observer.observe(ui.page, { childList: true, subtree: true });

      ui.page.addEventListener('click', onRowClick, true);
      if (!state.canEdit) sync("You don't have permission to edit these modules.", true);
      editor.ui.selAll.focus();
    }

    function exitBulk() {
      session++;
      bulkOn = false;
      loaded = false;
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
      editor.setBusy(false);
      editor.hide();
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
      if (editor.busy || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
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

      editor.syncBar({ selected: selected.size, total: state.order.length, canEdit: state.canEdit, message, warn });
    }

    const selectedRows = () => state.modules.flatMap(module =>
      module.items.filter(i => selected.has(String(i.id))).map(item => ({ item, group: module, title: item.title })));

    // ---- Rename (every module, or the selected items) ----
    // One text box per entry. entries: [{ name, context?, type?, save(name) → Response }]
    function renameDialog({ title, noun, hint, empty, entries, note }) {
      const rows = entries.map((entry, i) => {
        const input = el('input', { type: 'text', value: entry.name, maxLength: 255, ariaLabel: `Name for ${noun} ${i + 1}` });
        const was = el('span', { className: 'cbt-sub cbt-rename-was', textContent: `Was: ${entry.name}` });
        const row = el('li', { className: 'cbt-rename-row' },
          el('span', { className: 'cbt-rename-num', textContent: i + 1 }),
          el('div', { className: 'cbt-rename-field' }, input,
            entry.context ? el('span', { className: 'cbt-sub', textContent: entry.context }) : '', was));
        input.addEventListener('input', refresh);
        input.addEventListener('keydown', e => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          rows[i + 1]?.input.focus();
        });
        return { entry, was, row, input, old: entry.name.trim(), name: () => input.value.trim() };
      });
      const changes = () => rows.filter(r => r.name() && r.name() !== r.old);
      const status = el('p', { className: 'cbt-hint', role: 'status' });
      const warning = el('p', { className: 'cbt-hint cbt-warn', role: 'status' });
      const save = btn('', () => saveNames(noun, changes().map(r => ({ entry: r.entry, name: r.name() }))), 'cbt-primary');

      function refresh() {
        let blank = 0;
        for (const r of rows) {
          const v = r.name();
          const changed = v !== r.old;
          r.row.classList.toggle('cbt-changed', changed);
          r.row.classList.toggle('cbt-invalid', !v);
          r.was.hidden = !changed;
          if (!v) blank++;
        }
        const changed = changes();
        const n = changed.length;
        save.disabled = !n || blank > 0;
        save.textContent = n ? `Save ${n} change${plural(n)}` : 'Save';
        status.textContent = blank ? `Names can't be blank (${blank} empty).` : '';
        warning.textContent = note?.(changed.map(r => r.entry)) || '';
        warning.hidden = !warning.textContent;
      }
      refresh();

      ui.dialog.show(el('h2', { textContent: title }),
        el('p', { className: 'cbt-hint', textContent: hint }),
        rows.length ? el('ol', { className: 'cbt-rename-list' }, ...rows.map(r => r.row)) : el('p', { textContent: empty }),
        warning,
        status,
        el('div', { className: 'cbt-actions' }, btn('Cancel', () => ui.dialog.close()), save));
      rows[0]?.input.focus();
    }

    async function showRenameModules() {
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

      renameDialog({
        title: 'Rename modules',
        noun: 'module',
        hint: 'Edit any names, then save. Enter moves to the next one.',
        empty: 'This course has no modules yet.',
        entries: modules.map(m => ({
          name: m.name,
          save: name => canvas.request('PUT', `/api/v1/courses/${courseId()}/modules/${m.id}`, { module: { name } }),
        })),
      });
    }

    // Lists the checked items, in page order.
    function showRenameItems() {
      const picked = selectedRows();
      if (!picked.length) return;
      renameDialog({
        title: `Rename ${picked.length} item${plural(picked.length)}`,
        noun: 'item',
        hint: 'Edit any names, then save. Enter moves to the next one. ' +
          'Renaming an item also renames the assignment, quiz, page, or other content it points to.',
        entries: picked.map(({ item, group }) => ({
          name: item.title,
          context: group.name,
          type: item.type,
          save: title => updateItem(item, { title }),
        })),
        note: changed => (changed.some(e => e.type === 'Page')
          ? 'Renaming a page changes its web address. Course Links keep working; links pasted in as URLs may break.'
          : ''),
      });
    }

    async function saveNames(noun, list) {
      const progress = el('progress', { max: list.length, value: 0 });
      const status = el('p', { className: 'cbt-hint', role: 'status' });
      ui.dialog.show(el('h2', { textContent: `Renaming ${noun}s…` }), progress, status);

      let ok = 0;
      const failed = [];
      job.start();
      try {
        await paced(list, PAUSE_MS, async ({ entry, name }, i) => {
          status.textContent = `${i} of ${list.length} done`;
          const row = { title: name, context: `was “${entry.name}”` };
          try {
            const res = await entry.save(name);
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

      const result = { text: `Renamed ${ok} ${noun}${plural(ok)}${failed.length ? `, ${failed.length} failed` : ''}.`, failed };
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
      if (saved.notice) editor.showNotice(saved.notice);
    }

    return {
      name: 'Modules Batch Edit',
      matches: path => PAGE_RE.test(path),
      init,
    };
  }

  register(createModulesBatchEditFeature);
})();
