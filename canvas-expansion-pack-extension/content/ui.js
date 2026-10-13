// Canvas Expansion Pack: shared UI (see the notes at the top of core.js).

(() => {
    'use strict';
  
    const { el, job } = window.__canvasExpansionPack;
  
    // ==================================================================
    // 4. Shared UI
    // ==================================================================
    const styles = [String.raw`
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
    `];
  
    // Each feature file adds its own CSS here as it loads.
    const addStyles = css => { styles.push(css); };
  
    function injectStyles() {
      if (document.getElementById('cbt-styles')) return;
      document.head.append(el('style', { id: 'cbt-styles', textContent: styles.join('\n') }));
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
  
    Object.assign(window.__canvasExpansionPack, { addStyles, injectStyles, launch, launchMenu, modal, toast });
  })();
  