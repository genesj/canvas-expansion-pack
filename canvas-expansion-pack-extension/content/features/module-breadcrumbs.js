// Canvas Expansion Pack: Module Breadcrumbs (see the notes at the top of core.js).
//
// Moodle-style breadcrumbs on item pages: "Course > Quizzes > 2.1 Homework"
// becomes "Course > Week 2 > 2.1 Homework", with the module crumb linking to
// that module on the Modules page. The module comes from Canvas's module item
// sequence API (the one behind the Previous/Next footer). When the page was
// opened from Modules, the module_item_id in the URL picks the exact module;
// otherwise the first module holding the item is used. Items in no module
// keep Canvas's own breadcrumb. Read-only: nothing is ever written.

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
  
      // A breadcrumb link to `path`: one in a short list that also links to the
      // course. The course menu on the left has both links too, but many more,
      // which rules it out. Works for the classic #breadcrumbs and the newer
      // React header alike, since it doesn't rely on their markup.
      function crumbLink(path) {
        const course = `/courses/${courseId()}`;
        for (const a of document.querySelectorAll(`a[href*="${path}"]`)) {
          if (a.closest(`[${MARK}]`) || pathOf(a) !== path) continue;
          const list = a.closest('ol, ul, nav');
          if (!list) continue;
          const links = [...list.querySelectorAll('a[href]')].filter(l => !l.closest(`[${MARK}]`));
          if (links.length <= 5 && links.some(l => pathOf(l) === course)) return { a, list };
        }
        return null;
      }
  
      // The list entry holding `a` (the list's own child, so separators inside it come along).
      const entryOf = (a, list) => {
        let n = a;
        while (n.parentElement && n.parentElement !== list) n = n.parentElement;
        return n;
      };
  
      // A copy of `entry` that shows the module and links to it.
      function moduleEntry(entry, mod) {
        const copy = entry.cloneNode(true);
        copy.setAttribute(MARK, String(mod.id));
        copy.style.removeProperty('display');
        copy.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
        const link = copy.querySelector('a[href]');
        link.href = `/courses/${courseId()}/modules#module_${mod.id}`;
        link.title = mod.name;
        link.removeAttribute('aria-current');
        // Put the name in the first piece of text and empty the rest (truncation spans etc.).
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
  
      // Hides Canvas's category crumb and puts a module crumb after it. Canvas's
      // own nodes are only hidden, never changed, so React can keep managing
      // them. If there's no category crumb, the module goes after the course.
      // Returns true once the module crumb is on the page.
      function apply(mod) {
        const cid = courseId();
        const category = crumbLink(`/courses/${cid}/${pageAsset().section}`);
        const found = category || crumbLink(`/courses/${cid}`);
        if (!found) return !!document.querySelector(`[${MARK}]`);
        const entry = entryOf(found.a, found.list);
        const next = entry.nextElementSibling;
        if (!next?.hasAttribute(MARK)) {
          found.list.querySelectorAll(`[${MARK}]`).forEach(n => n.remove());
          entry.after(moduleEntry(entry, mod));
        }
        if (category && entry.style.display !== 'none') entry.style.display = 'none';
        return true;
      }
  
      async function init() {
        const mod = await lookup;
        if (!mod) { debug('module breadcrumbs: this item is in no module (or the lookup failed)'); return; }
        debug('module breadcrumbs: module', mod.id, mod.name);
        let shown = apply(mod);
        // The newer header is drawn by React after load and may redraw later,
        // so keep watching and put the module crumb back whenever it goes.
        let queued = false;
        new MutationObserver(() => {
          if (queued) return;
          queued = true;
          requestAnimationFrame(() => { queued = false; shown = apply(mod) || shown; });
        }).observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { if (!shown) debug('module breadcrumbs: no breadcrumb found on this page'); }, 10_000);
      }
  
      return {
        name: 'Module Breadcrumbs',
        matches: path => PAGE_RE.test(path),
        // Ask early so the answer is usually back by the time the DOM is ready.
        early() {
          lookup = findModule().catch(e => { debug('module breadcrumbs:', e); return null; });
        },
        init,
      };
    }
  
    register(createModuleBreadcrumbsFeature);
  })();
  