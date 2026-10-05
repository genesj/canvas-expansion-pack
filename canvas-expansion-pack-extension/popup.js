//This pop-up checks to see if this is a Canvas site, and if not, doesn't allow you to turn it on.

const $ = id => document.getElementById(id);

function fail(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

async function looksLikeCanvas(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => Boolean(
        document.querySelector('#application.ic-app') ||
        (typeof ENV === 'object' && ENV && 'DOMAIN_ROOT_ACCOUNT_ID' in ENV)),
    });
    return result === true;
  } catch { return false; }
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url = null;
  try { url = new URL(tab.url); } catch { /* no readable address */ }

  if (!url || url.protocol !== 'https:') {
    $('hint').textContent = 'Open your school\u2019s Canvas site in this tab, then click this icon again.';
    return;
  }

  const origins = [`https://${url.hostname}/*`];
  const enabled = await chrome.permissions.contains({ origins });

  if (!enabled && !(await looksLikeCanvas(tab.id))) {
    $('hint').textContent = 'This doesn\u2019t look like a Canvas page. Sign in to your school\u2019s Canvas site, open any course, then click this icon again.';
    return;
  }

  $('host').textContent = url.hostname;
  $('host').hidden = false;
  $('state').textContent = enabled ? 'On for this site' : 'Off for this site';
  $('state').className = enabled ? 'on' : 'off';
  $('state').hidden = false;
  $('hint').textContent = enabled
    ? 'If you don\u2019t see the tools on a course page, reload it.'
    : 'Only turn this on for your school\u2019s Canvas site. The page will reload, so save any work first.';

  const toggle = $('toggle');
  toggle.textContent = enabled ? 'Turn off and reload' : 'Turn on and reload';
  toggle.classList.toggle('off', enabled);
  toggle.hidden = false;

  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      // Must be the first thing awaited: Chrome only shows the permission
      // prompt in direct response to a click.
      const changed = enabled
        ? await chrome.permissions.remove({ origins })
        : await chrome.permissions.request({ origins });
      if (!changed) { toggle.disabled = false; return; }

      const reply = await chrome.runtime.sendMessage({ type: 'sync' });
      if (!reply?.ok) throw new Error(reply?.error || 'the extension did not respond');
      await chrome.tabs.reload(tab.id);
      window.close();
    } catch (e) {
      toggle.disabled = false;
      fail(`Couldn\u2019t ${enabled ? 'turn off' : 'turn on'}: ${e.message}`);
    }
  });
})().catch(e => fail(e.message));
