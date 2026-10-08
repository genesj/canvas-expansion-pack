/*
 * Canvas Expansion Pack: background service worker
 *
 * Keeps one dynamically registered content script in step with the sites the
 * user has turned the tools on for. The list of granted host permissions is
 * the only record of "enabled sites": nothing is written to storage, and
 * removing a site in Chrome's own extension settings turns the tools off too.
 */

const SCRIPT_ID = 'canvas-bulk-tools';
const SCRIPT_FILE = 'content.js'; // the main Canvas Expansion Pack script

// One sync at a time, so two events can't both try to register the script.
let queue = Promise.resolve();
const sync = () => (queue = queue.then(doSync, doSync));
const syncQuietly = () => sync().catch(e => console.error('[Canvas Expansion Pack] sync failed:', e));

async function doSync() {
  const { origins = [] } = await chrome.permissions.getAll();
  // "https://canvas.example.edu/*"  ->  "https://canvas.example.edu/courses/*"
  const matches = origins
    .filter(o => o.startsWith('https://') && o.endsWith('/*'))
    .map(o => `${o.slice(0, -1)}courses/*`);

  const registered = (await chrome.scripting.getRegisteredContentScripts()).some(s => s.id === SCRIPT_ID);
  if (!matches.length) {
    if (registered) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return;
  }

  const script = {
    id: SCRIPT_ID,
    js: [SCRIPT_FILE],
    matches,
    runAt: 'document_start', // before the page's own scripts (needed for Item Bank Sharing)
    world: 'MAIN',           // the page's world, so it can wrap window.fetch
    persistAcrossSessions: true,
  };
  if (registered) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

chrome.runtime.onInstalled.addListener(syncQuietly);
chrome.runtime.onStartup.addListener(syncQuietly);
chrome.permissions.onAdded.addListener(syncQuietly);
chrome.permissions.onRemoved.addListener(syncQuietly);

// The popup asks for a sync and waits for it, so it only reloads the tab
// once the script is registered (or unregistered).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'sync') return undefined;
  sync().then(
    () => sendResponse({ ok: true }),
    e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // answer asynchronously
});