// Canvas Expansion Pack: Module Breadcrumbs (see the notes at the top of core.js).
//
// Moodle-style breadcrumbs on item pages: "Course > Quizzes > 2.1 Homework"
// becomes "Course > Week 2 > 2.1 Homework", with the module crumb linking to
// that module on the Modules page. The module comes from Canvas's module item
// sequence API (the one behind the Previous/Next footer). When the page was
// opened from Modules, the module_item_id in the URL picks the exact module;
// otherwise the first module holding the item is used. Items in no module
// keep Canvas's own breadcrumb. Read-only: nothing is ever written.
//
// Canvas builds its breadcrumb in two steps: the page arrives with a plain
// #breadcrumbs, then Canvas's newer header redraws it from those crumbs. The
// module lookup can finish before or after that redraw, so instead of making
// a one-off edit, every check brings the breadcrumb to the same end state:
// the crumbs between the course and the item are hidden, and exactly one
// crumb links to the module, whether ours or one Canvas copied from ours.

(() => {
    'use strict';
  
    const { canvas, courseId, debug, register } = window.__canvasExpansionPack;
  
    function createModuleBreadcrumbsFeature() {
      // /courses/1/<section>/<id>, optionally /edit. Pages use a slug, the rest a number.
      const PAGE_RE = /^\/courses\/\d+\/(assignments|quizzes|discussion_topics|files|external_tools)\/\d+(?:\/edit)?\/?$|^\/courses\/\d+\/(pages)\/([^/]+)(?:\/edit)?\/?$/;
      const ASSET_TYPES = {
        assignments: 'Assignment',
        quizzes: 'Quiz',
        discussion_topics: 'Discussion',
        pages: 'Page',
        files: 'File',
        external_tools: 'ExternalTool',
      };
      const MARK = 'data-cbt-crumb-module';
  
      let lookup = null; // Promise of { id, name } or null, started in early()
  
      // Which section and asset this page shows, e.g. { section: 'quizzes', assetId: '42' }.
      function pageAsset() {
        const parts = location.pathname.split('/');
        // ['', 'courses', '1', '<section>', '<id or slug>', ...]
        return { section: parts[3], assetId: decodeURIComponent(parts[4] || '') };
      }
  
      async function findModule() {
        const cid = courseId();
        const { section, assetId } = pageAsset();
        const moduleItemId = new URLSearchParams(location.search).get('module_item_id');
        const [type, id] = /^\d+$/.test(moduleItemId || '')
          ? ['ModuleItem', moduleItemId]
          : [ASSET_TYPES[section], assetId];
        if (!type || !id) return null;
  
        debug('module breadcrumbs: looking up', type, id);
        const seq = await canvas.get(`/api/v1/courses/${cid}/module_item_sequence`
          + `?asset_type=${type}&asset_id=${encodeURIComponent(id)}`);
        const moduleId = seq?.items?.find(i => i?.current)?.current?.module_id;
        const mod = moduleId && (seq.modules || []).find(m => String(m.id) === String(moduleId));
        return mod ? { id: mod.id, name: mod.name } : null;
      }
  
      const pathOf = a => {
        try { return new URL(a.getAttribute('href'), location.origin).pathname.replace(/\/+$/, ''); } catch { return null; }
      };
      const pathAndHash = a => {
        try { const u = new URL(a.getAttribute('href'), location.origin); return u.pathname + u.hash; } catch { return null; }
      };
  
      // Breadcrumb lists: any <ol>/<ul> in a breadcrumb container that links to the course.
      function crumbLists() {
        const course = `/courses/${courseId()}`;
        const roots = document.querySelectorAll('#breadcrumbs, [aria-label="breadcrumbs" i]');
        const lists = new Set();
        for (const root of roots) {
          for (const list of root.querySelectorAll('ol, ul')) {
            if ([...list.querySelectorAll(':scope > li a[href]')].some(a => pathOf(a) === course)) lists.add(list);
          }
        }
        return [...lists];
      }
  
      // A copy of `li` (the course crumb) that shows the module and links to it.
      function moduleCrumb(li, mod, href) {
        const copy = li.cloneNode(true);
        copy.setAttribute(MARK, String(mod.id));
        copy.style.removeProperty('display');
        copy.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
        copy.querySelectorAll('[aria-describedby]').forEach(n => n.removeAttribute('aria-describedby'));
        const link = copy.querySelector('a[href]');
        link.href = href;
        link.title = mod.name;
        // Put the name in the first piece of text and empty the rest.
        const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
        const texts = [];
        while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) texts.push(walker.currentNode);
        if (texts.length) {
          texts[0].nodeValue = mod.name;
          texts.slice(1).forEach(t => { t.nodeValue = ''; });
        } else {
          link.append(mod.name);
        }
        return copy;
      }
  
      const hide = li => { if (li.style.display !== 'none') li.style.display = 'none'; };
      const show = li => { if (li.style.display === 'none') li.style.removeProperty('display'); };
  
      // Brings one breadcrumb list to: ... > Course > Module > Item.
      function fix(list, mod) {
        const course = `/courses/${courseId()}`;
        const href = `${course}/modules#module_${mod.id}`;
        const items = [...list.children].filter(n => n.tagName === 'LI');
        const at = items.findIndex(li => [...li.querySelectorAll('a[href]')].some(a => pathOf(a) === course));
        if (at < 0) return 'no course crumb';
        // Everything after the course except the last crumb (the item itself).
        const middle = items.slice(at + 1, -1);
        const isModule = li => [...li.querySelectorAll('a[href]')].some(a => pathAndHash(a) === href);
        // Prefer a module crumb Canvas drew itself; then ours.
        const keep = middle.find(li => isModule(li) && !li.hasAttribute(MARK)) || middle.find(isModule);
        for (const li of middle) {
          if (li === keep) show(li);
          else if (li.hasAttribute(MARK)) li.remove();
          else hide(li);
        }
        if (keep) return keep.hasAttribute(MARK) ? 'ok (ours)' : 'ok (Canvas copied it)';
        items[at].after(moduleCrumb(items[at], mod, href));
        return 'added module crumb';
      }
  
      function apply(mod) {
        return crumbLists().map(list => fix(list, mod));
      }
  
      // What each breadcrumb list reads on screen right now, for the log.
      function snapshot() {
        return crumbLists().map(list => [...list.children]
          .filter(li => li.tagName === 'LI' && li.style.display !== 'none')
          .map(li => li.textContent.trim()).join(' > '));
      }
  
      async function init() {
        const mod = await lookup;
        if (!mod) { debug('module breadcrumbs: this item is in no module (or the lookup failed)'); return; }
        debug('module breadcrumbs: module is', mod.id, mod.name);
        debug('module breadcrumbs: before:', snapshot());
        debug('module breadcrumbs:', apply(mod));
        // Canvas redraws the breadcrumb after load, so check again after any change.
        let queued = false;
        let last = '';
        new MutationObserver(() => {
          if (queued) return;
          queued = true;
          requestAnimationFrame(() => {
            queued = false;
            const result = apply(mod).join(', ');
            if (result !== last && /added|Canvas/.test(result)) debug('module breadcrumbs (later):', result);
            last = result;
          });
        }).observe(document.body, { childList: true, subtree: true });
        setTimeout(() => debug('module breadcrumbs: 3s later:', snapshot()), 3000);
      }
  
      return {
        name: 'Module Breadcrumbs',
        matches: path => PAGE_RE.test(path),
        // Ask early so the answer is usually back by the time the DOM is ready.
        early() {
          lookup = findModule().catch(e => { debug('module breadcrumbs: lookup failed:', e); return null; });
        },
        init,
      };
    }
  
    register(createModuleBreadcrumbsFeature);
  })();
  