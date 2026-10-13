// Canvas Expansion Pack: shared Batch Edit toolkit (see the notes at the top of core.js).
//
// Used by Modules Batch Edit and Assignments Batch Edit. Each feature keeps its
// own page checkboxes and data; this file supplies the rest:
//   bulkEditor()  the floating bar, the preview dialog, the paced apply loop
//                 with Stop, and the results notice
//   moveTree()    the "where should these go?" picker used by Move
//   planList()    the title · context · change lists used in every dialog

(() => {
    'use strict';
  
    const { btn, canvas, el, job, modal, paced, plural, addStyles } = window.__canvasExpansionPack;
  
    addStyles(String.raw`
      /* ================= Batch Edit (shared) ================= */
      .cbt-bulk-check {
        width: 18px;
        height: 18px;
        margin: 0 8px 0 6px;
        flex: none;
        align-self: center;
        cursor: pointer;
        accent-color: var(--cbt-checkbox);
      }
  
      .cbt-bulk-bar {
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
      .cbt-bulk-bar .cbt-bulk-main {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
        padding: 8px 12px;
      }
      .cbt-bulk-bar .cbt-bulk-selall {
        display: flex;
        align-items: center;
        gap: 4px;
        margin: 0;
        font-weight: 600;
        white-space: nowrap;
        cursor: pointer;
      }
      .cbt-bulk-bar .cbt-bulk-selall .cbt-bulk-check { margin-left: 0; }
      .cbt-bulk-bar .cbt-bulk-tools {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 2px;
        margin: 0 auto;
      }
      .cbt-bulk-bar .cbt-bulk-tool {
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
      .cbt-bulk-bar .cbt-bulk-tool i { font-size: 18px; line-height: 1; }
      .cbt-bulk-bar .cbt-bulk-tool:hover:not(:disabled) {
        background: var(--cbt-hover);
        border-color: var(--cbt-border);
      }
      .cbt-bulk-bar .cbt-bulk-tool.cbt-danger { color: var(--cbt-danger); }
      .cbt-bulk-bar .cbt-bulk-tool:disabled { opacity: .4; cursor: default; }
      .cbt-bulk-count { font-size: 13px; color: var(--cbt-muted); white-space: nowrap; }
      .cbt-bulk-bar .cbt-bulk-x {
        padding: 4px 8px;
        background: none;
        border: 0;
        border-radius: 4px;
        color: var(--cbt-text);
        font-size: 20px;
        line-height: 1;
        cursor: pointer;
      }
      .cbt-bulk-bar .cbt-bulk-x:hover { background: var(--cbt-hover); }
      .cbt-bulk-bar .cbt-bulk-notice {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 8px 12px;
        background: var(--cbt-notice-bg);
        border-bottom: 1px solid var(--cbt-border-light);
        border-radius: 8px 8px 0 0;
      }
      .cbt-bulk-bar .cbt-bulk-notice > div { flex: 1; }
      .cbt-bulk-bar .cbt-bulk-notice .cbt-bulk-x { font-size: 16px; }
      .cbt-bulk-bar details { margin-top: 4px; }
      .cbt-bulk-bar summary { color: var(--cbt-danger); cursor: pointer; }
      .cbt-bulk-bar .cbt-list { max-height: 120px; }
  
      .cbt-dialog details.cbt-bulk-details { margin-top: 10px; }
      .cbt-dialog details.cbt-bulk-details summary { color: var(--cbt-primary); cursor: pointer; }
      .cbt-bulk-confirm {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
        padding: 8px 10px;
        border: 1px solid var(--cbt-danger);
        border-radius: 4px;
      }
      .cbt-bulk-confirm input { width: 120px; }
  
      /* Move: the miniature list of modules / assignment groups */
      .cbt-bulk-tree {
        max-height: 50vh;
        overflow: auto;
        margin-top: 8px;
        border: 1px solid var(--cbt-border);
        border-radius: 4px;
      }
      .cbt-bulk-tree-group + .cbt-bulk-tree-group { border-top: 1px solid var(--cbt-border); }
      .cbt-bulk-tree-head {
        display: flex;
        align-items: stretch;
        background: var(--cbt-module-bg);
      }
      .cbt-bulk-tree-toggle {
        flex: none;
        width: 36px;
        padding: 0;
        background: none;
        border: 0;
        color: var(--cbt-text);
        cursor: pointer;
      }
      .cbt-bulk-tree-dest,
      .cbt-bulk-tree-item {
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
      .cbt-bulk-tree-dest { cursor: pointer; }
      .cbt-bulk-tree-head .cbt-bulk-tree-dest { padding-left: 0; font-weight: 700; }
      .cbt-bulk-tree-item { border-top: 1px solid var(--cbt-border-light); }
      .cbt-bulk-tree-dest:hover { background: var(--cbt-selected-row); }
      .cbt-bulk-tree-item.cbt-chosen,
      .cbt-bulk-tree-head.cbt-chosen {
        background: var(--cbt-selected-row);
        box-shadow: inset 4px 0 0 var(--cbt-primary);
      }
      .cbt-bulk-tree-head:hover { background: var(--cbt-selected-row); }
      .cbt-bulk-tree-head .cbt-bulk-tree-dest:hover { background: none; }
      .cbt-bulk-tree-subheader { font-weight: 700; }
      .cbt-bulk-tree i { flex: none; width: 18px; font-size: 16px; text-align: center; }
      .cbt-bulk-tree-title { min-width: 0; overflow-wrap: anywhere; }
      .cbt-bulk-tree-moving { color: var(--cbt-muted); font-style: italic; }
      .cbt-bulk-tree-tag {
        margin-left: auto;
        padding: 0 8px;
        border: 1px solid var(--cbt-border-light);
        border-radius: 10px;
        font-size: 12px;
        font-style: normal;
      }
      .cbt-bulk-tree-marker {
        margin: 4px 12px 4px 44px;
        padding: 6px 10px;
        border: 2px dashed var(--cbt-primary);
        border-radius: 4px;
        color: var(--cbt-primary);
        font-size: 13px;
        font-weight: 600;
        text-align: center;
      }
      .cbt-bulk-tree-empty {
        padding: 8px 12px 8px 44px;
        border-top: 1px solid var(--cbt-border-light);
        color: var(--cbt-muted);
        font-style: italic;
      }
    `);
  
    // rows: [{ title, context, text }] → "title" over "context · text".
    const planList = rows => el('ul', { className: 'cbt-list' }, ...rows.map(r => el('li', {},
      el('span', { textContent: r.title }),
      el('span', { className: 'cbt-sub', textContent: `${r.context} · ${r.text}` }))));
  
    // ------------------------------------------------------------------
    // The bar, preview, apply loop and notice.
    //
    // Picked rows are { item, group, title }, where group is the module or
    // assignment group (anything with a .name).
    //
    // Each action: plan(item, group) → { skip } | { change }, run(item, group) → Response.
    // Or planAll(picked, values) → { change, skip, pending?, runAll? } for actions
    // that plan the whole selection at once. With runAll, one request does the
    // whole change list and its response counts for every row.
    // Optional: prepare(picked) loads anything plan() needs before the preview opens;
    // controls(picked) adds inputs to the preview; confirmWord makes the user type
    // that word before the button unlocks; danger, note, collapseDetails.
    //
    // options:
    //   key          short feature key; the bar and dialog get ids cbt-<key>-bar / -dialog
    //   noun         'item' or 'assignment', for headings and buttons
    //   actions      as above
    //   extraTools   [{ short, icon, onClick }] buttons that don't preview (Rename)
    //   picked()     the selected rows, in page order
    //   onSelectAll(on), onExit()
    //   onChange(message?, warn?)   busy state changed; redraw the page checkboxes and call syncBar
    //   afterApply(notice, ok)      return true if the feature reloads the page itself
    // ------------------------------------------------------------------
    function bulkEditor({ key, noun = 'item', actions, extraTools = [], picked, onSelectAll, onExit, onChange, afterApply, pauseMs = 200 }) {
      const ui = {};
      let busy = false;
      let stopRequested = false;
      const nouns = n => `${n} ${noun}${plural(n)}`;
  
      const tool = (short, icon, danger, onClick) => {
        const b = el('button', { type: 'button', className: 'cbt-bulk-tool' + (danger ? ' cbt-danger' : '') },
          el('i', { className: icon || '', ariaHidden: 'true' }),
          el('span', { textContent: short }));
        b.addEventListener('click', onClick);
        return b;
      };
  
      ui.selAll = el('input', { type: 'checkbox', className: 'cbt-bulk-check' });
      ui.selAll.addEventListener('change', () => onSelectAll(ui.selAll.checked));
      ui.tools = [
        ...actions.map(a => tool(a.short, a.icon, a.danger, () => showPreview(a))),
        ...extraTools.map(t => tool(t.short, t.icon, t.danger, t.onClick)),
      ];
      ui.count = el('span', { className: 'cbt-bulk-count' });
      ui.exit = el('button', { type: 'button', className: 'cbt-bulk-x', textContent: '×', title: 'Exit', ariaLabel: 'Exit' });
      ui.exit.addEventListener('click', onExit);
      ui.notice = el('div', { className: 'cbt-bulk-notice', hidden: true, role: 'status' });
      ui.bar = el('div', { id: `cbt-${key}-bar`, className: 'cbt cbt-bulk-bar', hidden: true, role: 'region', ariaLabel: 'Bulk Edit' },
        ui.notice,
        el('div', { className: 'cbt-bulk-main' },
          el('label', { className: 'cbt-bulk-selall' }, ui.selAll, 'Select all'),
          el('div', { className: 'cbt-bulk-tools', role: 'group' }, ...ui.tools),
          ui.count,
          ui.exit));
      document.body.append(ui.bar);
      const dialog = modal(`cbt-${key}-dialog`);
  
      function setBusy(value, message, warn) {
        busy = value;
        onChange(message, warn);
      }
  
      function syncBar({ selected, total, canEdit = true, message, warn }) {
        ui.selAll.checked = total > 0 && selected === total;
        ui.selAll.indeterminate = selected > 0 && selected < total;
        ui.selAll.disabled = busy || !total;
        ui.tools.forEach(b => { b.disabled = busy || !selected || !canEdit; });
  
        if (message !== undefined) {
          ui.count.textContent = message;
          ui.count.classList.toggle('cbt-warn', !!warn);
        } else if (!busy && canEdit) {
          ui.count.textContent = `${selected} selected`;
          ui.count.classList.remove('cbt-warn');
        }
      }
  
      function planAction(action, rows, values) {
        if (action.planAll) return action.planAll(rows, values);
        const change = [], skip = [];
        for (const { item, group, title } of rows) {
          const p = action.plan(item, group);
          const row = { item, group, title, text: p.skip || p.change };
          if (p.skip) skip.push(row);
          else change.push({ ...row, run: () => action.run(item, group) });
        }
        return { change, skip };
      }
  
      async function showPreview(action) {
        const rows = picked();
        if (action.prepare) {
          setBusy(true, 'Checking items…');
          try { await action.prepare(rows); } finally { setBusy(false); }
        }
        const controls = action.controls?.(rows);
        const list = r => planList(r.map(x => ({ ...x, context: x.group.name })));
        const heading = el('h2');
        const body = el('div');
        let plan;
        const confirmBtn = btn(action.button, () => apply(action, plan),
          'cbt-primary' + (action.danger ? ' cbt-danger' : ''));
        const cancelBtn = btn('Cancel', () => dialog.close());
  
        // A typed word guards actions that can't be undone.
        let confirmed = () => true;
        let confirmBox = '';
        if (action.confirmWord) {
          const input = el('input', { type: 'text', autocomplete: 'off', ariaLabel: `Type ${action.confirmWord} to confirm` });
          input.addEventListener('input', () => render());
          confirmed = () => input.value.trim().toLowerCase() === action.confirmWord;
          confirmBox = el('label', { className: 'cbt-bulk-confirm' },
            el('span', { textContent: `Type ${action.confirmWord} to confirm:` }), input);
        }
  
        function render() {
          plan = planAction(action, rows, controls?.values());
          const { change = [], skip = [], pending } = plan;
          const n = change.length;
          const total = pending ? rows.length : n;
          heading.textContent = total ? `${action.label}: ${nouns(total)}` : 'Nothing to change';
          confirmBtn.textContent = n ? `${action.button} ${nouns(n)}` : action.button;
          confirmBtn.disabled = !n || !confirmed();
          const lists = [
            n ? list(change) : '',
            skip.length ? el('h3', { textContent: `Skipped (${skip.length})` }) : '',
            skip.length ? list(skip) : '',
          ];
          body.replaceChildren(
            pending ? el('p', { className: 'cbt-hint', textContent: pending }) : '',
            !pending && !n ? el('p', { className: 'cbt-hint', textContent: `None of the selected ${noun}s can be changed with ${action.label}.` }) : '',
            action.note && n ? el('p', { className: 'cbt-hint', textContent: action.note }) : '',
            ...(action.collapseDetails && (n || skip.length)
              ? [el('details', { className: 'cbt-bulk-details' },
                  el('summary', { textContent: `Show each ${noun} (${n + skip.length})` }), ...lists)]
              : lists));
          if (confirmBox) confirmBox.hidden = !n;
        }
        controls?.onChange(render);
        render();
  
        dialog.show(heading, controls?.node || '', body, confirmBox,
          el('div', { className: 'cbt-actions' }, cancelBtn, confirmBtn));
        (controls?.focus || cancelBtn).focus();
      }
  
      async function apply(action, { change, skip, runAll }) {
        stopRequested = false;
        setBusy(true, 'Working…');
  
        const progress = el('progress', { max: change.length, value: 0 });
        const status = el('p', { className: 'cbt-hint', role: 'status' });
        const stopBtn = btn('Stop', () => {
          stopRequested = true;
          stopBtn.disabled = true;
          stopBtn.textContent = 'Stopping…';
        });
        dialog.show(el('h2', { textContent: `${action.label}…` }), progress, status,
          runAll ? '' : el('div', { className: 'cbt-actions' }, stopBtn));
        if (!runAll) stopBtn.focus();
  
        let ok = 0, done = 0;
        const failed = [];
        const fail = (r, text) => failed.push({ title: r.title, context: r.group.name, text });
        job.start();
        try {
          if (runAll) {
            status.textContent = `Saving ${nouns(change.length)}…`;
            try {
              const res = await runAll();
              if (res.ok) ok = change.length;
              else {
                const text = await canvas.errorText(res);
                change.forEach(r => fail(r, text));
              }
            } catch (e) {
              change.forEach(r => fail(r, e.message));
            }
            done = change.length;
            progress.value = done;
          } else {
            await paced(change, pauseMs, async r => {
              if (stopRequested) return false;
              status.textContent = `${done} of ${change.length} done`;
              try {
                const res = await r.run();
                if (res.ok) ok++;
                else fail(r, await canvas.errorText(res));
              } catch (e) {
                fail(r, e.message);
              }
              progress.value = ++done;
            });
          }
        } finally {
          job.end();
        }
  
        const parts = [`${ok} ${action.done}`];
        if (failed.length) parts.push(`${failed.length} failed`);
        if (skip.length) parts.push(`${skip.length} skipped`);
        if (done < change.length) parts.push(`${change.length - done} not attempted`);
        const notice = { text: `${stopRequested ? 'Stopped' : 'Done'}: ${parts.join(', ')}.`, failed };
  
        // The feature normally reloads so the page shows Canvas's real state.
        if (afterApply(notice, ok)) return;
  
        setBusy(false);
        const closeBtn = btn(ok ? 'Reload page' : 'OK', () => (ok ? location.reload() : dialog.close()), 'cbt-primary');
        dialog.show(
          el('h2', { textContent: notice.text }),
          failed.length ? el('h3', { textContent: "These couldn't be changed:" }) : '',
          failed.length ? planList(failed) : '',
          el('div', { className: 'cbt-actions' }, closeBtn));
        closeBtn.focus();
      }
  
      function showNotice(notice) {
        const dismiss = el('button', { type: 'button', className: 'cbt-bulk-x', textContent: '×',
          title: 'Dismiss', ariaLabel: 'Dismiss' });
        dismiss.addEventListener('click', () => { ui.notice.hidden = true; });
        const n = notice.failed?.length || 0;
        ui.notice.replaceChildren(
          el('div', {},
            el('strong', { textContent: notice.text }),
            n ? el('details', {},
              el('summary', { textContent: `${nouns(n)} couldn't be changed` }),
              planList(notice.failed)) : ''),
          dismiss);
        ui.notice.hidden = false;
      }
  
      return {
        ui,
        dialog,
        get busy() { return busy; },
        setBusy,
        syncBar,
        showNotice,
        show() { ui.bar.hidden = false; },
        hide() { ui.bar.hidden = true; ui.notice.hidden = true; },
      };
    }
  
    // ------------------------------------------------------------------
    // Move picker: a miniature list of groups (modules or assignment groups).
    // The user picks the top of a group, or a spot right after an entry.
    //   groups    [{ id, name, items: [{ id, title, icon?, indent?, bold? }] }]
    //   moving    ids being moved (shown greyed, can't be picked)
    //   expand    ids of groups to show open at first
    //   noun, groupNoun   'item' / 'module', or 'assignment' / 'assignment group'
    // values() → { groupId, where: 'top' | 'after:<id>' } once picked.
    // ------------------------------------------------------------------
    function moveTree({ groups, moving, expand, count, noun, groupNoun }) {
      const expanded = new Set(expand);
      const listeners = [];
      let choice = null;
  
      const tree = el('div', { className: 'cbt-bulk-tree' });
      const isChosen = (groupId, where) => choice?.groupId === groupId && choice.where === where;
      const marker = () => el('div', { className: 'cbt-bulk-tree-marker', textContent: `${count} ${noun}${plural(count)} will go here` });
  
      function choose(groupId, where) {
        choice = { groupId, where };
        expanded.add(groupId);
        draw();
        tree.querySelector('.cbt-bulk-tree-marker')?.scrollIntoView({ block: 'nearest' });
        listeners.forEach(fn => fn());
      }
  
      function toggleGroup(groupId) {
        if (expanded.has(groupId)) expanded.delete(groupId);
        else expanded.add(groupId);
        draw();
      }
  
      function destination({ key, label, chosen, onClick, className = '', style = '' }, ...content) {
        const b = el('button', { type: 'button', className: `cbt-bulk-tree-dest ${className}${chosen ? ' cbt-chosen' : ''}`,
          title: label, ariaLabel: label, style }, ...content);
        b.dataset.key = key;
        b.setAttribute('aria-pressed', String(chosen));
        b.addEventListener('click', onClick);
        return b;
      }
  
      function itemRows(g, item) {
        const groupId = String(g.id);
        const id = String(item.id);
        const where = `after:${id}`;
        const style = `padding-left: ${44 + (item.indent || 0) * 20}px`;
        const icon = el('i', { className: item.icon || '', ariaHidden: 'true' });
        const title = el('span', { className: 'cbt-bulk-tree-title', textContent: item.title });
  
        if (moving.has(id)) {
          return [el('div', { className: 'cbt-bulk-tree-item cbt-bulk-tree-moving', style },
            icon, title, el('span', { className: 'cbt-bulk-tree-tag', textContent: 'moving' }))];
        }
        const chosen = isChosen(groupId, where);
        const row = destination({
          key: `i${id}`,
          label: `Move after ${item.title}`,
          chosen,
          onClick: () => choose(groupId, where),
          className: 'cbt-bulk-tree-item' + (item.bold ? ' cbt-bulk-tree-subheader' : ''),
          style,
        }, icon, title);
        return chosen ? [row, marker()] : [row];
      }
  
      function draw() {
        const focusKey = tree.contains(document.activeElement) ? document.activeElement.dataset.key : null;
        tree.replaceChildren(...groups.map(g => {
          const groupId = String(g.id);
          const open = expanded.has(groupId);
          const toggle = el('button', { type: 'button', className: 'cbt-bulk-tree-toggle',
            ariaExpanded: String(open), ariaLabel: `${open ? 'Collapse' : 'Expand'} ${g.name}` },
            el('i', { className: open ? 'icon-mini-arrow-down' : 'icon-mini-arrow-right', ariaHidden: 'true' }));
          toggle.dataset.key = `t${groupId}`;
          toggle.addEventListener('click', () => toggleGroup(groupId));
  
          const topChosen = isChosen(groupId, 'top');
          return el('div', { className: 'cbt-bulk-tree-group' },
            el('div', { className: 'cbt-bulk-tree-head' + (topChosen ? ' cbt-chosen' : '') }, toggle,
              destination({
                key: `g${groupId}`,
                label: `Move to the top of ${g.name}`,
                chosen: topChosen,
                onClick: () => choose(groupId, 'top'),
              }, el('span', { className: 'cbt-bulk-tree-title', textContent: g.name }))),
            topChosen ? marker() : '',
            ...(open ? g.items.flatMap(item => itemRows(g, item)) : []),
            open && !g.items.length ? el('div', { className: 'cbt-bulk-tree-empty', textContent: `No ${noun}s yet` }) : '');
        }));
        if (focusKey) tree.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
      }
      draw();
  
      return {
        node: el('div', {},
          el('p', { className: 'cbt-hint', textContent: `Move ${count} ${noun}${plural(count)} to the top of ${/^[aeiou]/i.test(groupNoun) ? 'an' : 'a'} ${groupNoun}, or right after ${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}:` }),
          tree),
        focus: tree.querySelector('.cbt-bulk-tree-dest'),
        values: () => choice || {},
        onChange: fn => listeners.push(fn),
      };
    }
  
    Object.assign(window.__canvasExpansionPack, { bulkEditor, moveTree, planList });
  })();
  