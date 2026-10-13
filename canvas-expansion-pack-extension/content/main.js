// Canvas Expansion Pack: bootstrap. Must be the last file in SCRIPT_FILES (background.js).

(() => {
  'use strict';

  // ==================================================================
  // 8. Bootstrap
  // ==================================================================
  // Every feature file has registered by now. Take what's needed and remove
  // the shared object, so nothing of ours stays reachable from the page.
  const { features, domReady, injectStyles, debug } = window.__canvasExpansionPack;
  delete window.__canvasExpansionPack;

  // A feature whose factory throws is skipped; the others still run.
  const FEATURES = features.flatMap(create => {
    try { return [create()]; } catch (e) {
      console.error('[Canvas Expansion Pack] a feature failed to load:', e);
      return [];
    }
  });

  const active = FEATURES.filter(f => f.matches(location.pathname));
  debug('loaded; features for this page:', active.map(f => f.name).join(', ') || 'none');
  if (!active.length) return;

  active.forEach(f => f.early?.());

  domReady().then(() => {
    injectStyles();
    for (const f of active) {
      Promise.resolve()
        .then(f.init)
        .catch(e => console.error(`[Canvas Expansion Pack] ${f.name} failed to start:`, e));
    }
  });
})();
