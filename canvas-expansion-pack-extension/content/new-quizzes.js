// Canvas Expansion Pack: New Quizzes client (see the notes at the top of core.js).
//
// Signs in to New Quizzes the way Canvas's own launch does, then reads
// participants and attempts. Used by Bulk Fudge Points (which adds its one
// write), the Submission Log (which reads each attempt's event log) and Item
// Bank Sharing (which moves a quiz's questions into a bank with the quiz
// editor's login).
// The logins it gets are only kept by the caller, never stored, and only
// sent to https New Quizzes hosts (QUIZ_HOST_RE).

(() => {
  'use strict';

  const { QUIZ_HOST_RE, canvas, courseId, debug, nativeFetch, quizHosts, sleep } = window.__canvasExpansionPack;

  const httpError = (message, status) => Object.assign(new Error(message), { status });

  // Extracts the JSON object that follows `marker` in an HTML page.
  function jsonAfter(text, marker) {
    const at = text.indexOf(marker);
    const start = at < 0 ? -1 : text.indexOf('{', at + marker.length);
    if (start < 0) return null;
    let depth = 0, inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }

  function quizIdFrom(launchInfo) {
    const entry = launchInfo.entry_path || {};
    for (const [key, value] of Object.entries(entry)) {
      if (/^(assignment|quiz)_?id$/i.test(key) && /^\d+$/.test(String(value))) return String(value);
    }
    const path = String(launchInfo.launch_url || '').split('?')[0];
    return path.match(/\/(\d+)(?:\/|$)/)?.[1] || null;
  }

  function launchSummary(launchInfo) {
    const address = String(launchInfo.launch_url || '').split('?')[0].replace(/^https?:\/\/[^/]+/, '') || 'none';
    return `it opened "${address}" with entry details ${JSON.stringify(launchInfo.entry_path ?? null)}`;
  }

  // Grading tokens are only ever sent to an https New Quizzes host (QUIZ_HOST_RE),
  // even if the service names some other host.
  function quizApiBase(host) {
    if (!host) return quizHosts.base('api');
    const url = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`);
    if (url.protocol !== 'https:' || !QUIZ_HOST_RE.test(url.hostname)) {
      throw new Error(`New Quizzes pointed to an unexpected server (${url.hostname})`);
    }
    return `${url.origin}/api`;
  }

  // Claims of a signed login (a JWT, possibly after a word like "Bearer"), or null.
  function jwtClaims(value) {
    const s = String(value || '');
    if (s.length > 8192 || !/^(?:[A-Za-z]+ )?[\w-]+\.[\w-]+\.[\w-]*$/.test(s)) return null;
    try {
      const part = s.split(' ').pop().split('.')[1];
      return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    } catch { return null; }
  }

  // The quiz editor's login ("quiz.build" scope) anywhere inside an answer.
  // Searched for by what it is rather than by field name, since the launch
  // answer's layout isn't documented.
  function findBuildLogin(value, depth = 0) {
    if (value == null || depth > 6) return null;
    if (typeof value === 'string') {
      const claims = jwtClaims(value);
      // Skip a login that has expired or is about to.
      if (claims?.exp && claims.exp * 1000 < Date.now() + 60_000) return null;
      return claims?.scope === 'quiz.build'
        ? { token: value, quizId: claims.resource_id == null ? null : String(claims.resource_id) } : null;
    }
    if (typeof value === 'object') {
      for (const v of Object.values(value)) {
        const found = findBuildLogin(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  // A quiz.build login for this quiz kept in the page's storage by the quiz editor.
  function storedBuildLogin(quizId, extraStores = []) {
    for (const store of [() => sessionStorage, () => localStorage, ...extraStores]) {
      let st;
      try { st = store(); } catch { continue; }
      for (let i = 0; i < st.length; i++) {
        let found = null;
        try {
          const v = st.getItem(st.key(i));
          found = findBuildLogin(v) || (v && v[0] === '{' ? findBuildLogin(JSON.parse(v)) : null);
        } catch { /* not ours */ }
        if (found && quizId && found.quizId === String(quizId)) return found;
      }
    }
    return null;
  }

  function shapeOf(value, depth = 0) {
    if (value == null || depth > 5) return value === null ? null : typeof value;
    if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1), `…${value.length}`] : [];
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
    if (typeof value === 'string') {
      const claims = jwtClaims(value);
      return claims ? `login(scope=${claims.scope ?? '?'})` : `text(${value.length})`;
    }
    return typeof value;
  }

  const newQuizzes = {
    async request(url, headers, { method = 'GET', body } = {}) {
      let r;
      try {
        r = await nativeFetch(url, {
          method,
          // Token auth only; never send Canvas cookies to the quiz hosts.
          credentials: 'omit',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        debug('New Quizzes', method, url.split('?')[0], 'blocked:', e);
        throw new Error(`the browser blocked the request to ${new URL(url).host} (${e.message})`);
      }
      debug('New Quizzes', method, url.split('?')[0], r.status);
      return r;
    },

    async json(url, headers, opts, what) {
      const r = await this.request(url, headers, opts);
      if (!r.ok) throw httpError(`${what} failed (${r.status})`, r.status);
      return r.json();
    },

    // Canvas embeds the signed LTI launch in the quiz's launch page.
    async launchDetails(assignmentId) {
      const c = courseId();
      const pages = [
        `/courses/${c}/assignments/${assignmentId}/launch?assignment_id=${assignmentId}` +
          '&content_only=true&display=borderless&new_quizzes_native_experience_sessionless=true&sessionless_launch=true',
        `/courses/${c}/assignments/${assignmentId}`,
      ];
      const tried = [];
      for (const page of pages) {
        try {
          const r = await nativeFetch(page, { credentials: 'same-origin', redirect: 'manual', headers: { Accept: 'text/html' } });
          debug('New Quizzes launch page', page.split('?')[0], r.type, r.status);
          if (!r.ok) { tried.push(r.type === 'opaqueredirect' ? 'redirected' : r.status); continue; }
          const found = jsonAfter(await r.text(), '"NEW_QUIZZES":');
          if (found?.params && found.signature) return found;
          tried.push('no launch details on the page');
        } catch (e) {
          debug('New Quizzes launch page', page.split('?')[0], 'blocked:', e);
          tried.push(e.message);
        }
      }
      throw new Error(`Canvas didn't provide this quiz's launch details (${tried.join('; ')})`);
    },

    async canvasPass() {
      const course = await canvas.get(`/api/v1/courses/${courseId()}`);
      const contexts = [course.account_id, course.root_account_id]
        .filter(Boolean).map(id => `&context_type=account&context_id=${id}`).concat('');
      for (const ctx of contexts) {
        const r = await canvas.request('POST', `/api/v1/jwts?canvas_audience=false&workflows[]=new_quizzes_native_launch${ctx}`);
        if (!r.ok) continue;
        const { token } = await canvas.json(r);
        if (token) return token;
      }
      throw new Error("Canvas didn't issue a New Quizzes pass");
    },

    async connect(assignmentId, onStep) {
      const launchInfo = await onStep('Reading the quiz’s launch details', () => this.launchDetails(assignmentId));
      const pass = await onStep('Getting a pass from Canvas', () => this.canvasPass());
      const j = await onStep('Opening New Quizzes', async () => {
        const res = await this.json(`${quizHosts.base('lti')}/native/launch`,
          { Authorization: `Bearer ${pass}`, 'x-domain': launchInfo.params.tool_consumer_instance_guid },
          { method: 'POST', body: { params: launchInfo.params, signature: launchInfo.signature } },
          'Opening New Quizzes');
        if (!res.access_token) throw new Error("New Quizzes didn't return a login");
        return res;
      });
      const quizId = await onStep('Finding the quiz in New Quizzes', async () => {
        const id = quizIdFrom(j);
        if (!id) throw new Error(`New Quizzes didn't say which quiz this is (${launchSummary(j)})`);
        return id;
      });
      return {
        quizId: String(quizId),
        assignmentId: String(assignmentId),
        launch: j, // the whole launch answer; buildLogin() looks in it for the editor's login
        launchToken: j.launch_token || j.access_token, // asked for by View Log's login
        headers: {
          Authorization: `Bearer ${j.access_token}`,
          'x-domain': j.current_user?.account_uuid || launchInfo.params.tool_consumer_instance_guid,
        },
      };
    },

    lti(conn, path, what) {
      return this.json(`${quizHosts.base('lti')}${path}`, conn.headers, undefined, what);
    },

    async participants(conn) {
      const seen = new Map();
      for (let page = 1; page <= 100; page++) {
        const list = await this.lti(conn, `/assignments/${conn.quizId}/participants?page=${page}`, 'Listing students');
        const fresh = (Array.isArray(list) ? list : []).filter(p => !seen.has(p.id));
        if (!fresh.length) break;
        fresh.forEach(p => seen.set(p.id, p));
      }
      return [...seen.values()];
    },

    async attempt(conn, participantSessionId) {
      const g = await this.lti(conn, `/participant_sessions/${participantSessionId}/grade`, 'Opening the attempt');
      return {
        sessionId: String(g.quiz_api_quiz_session_id),
        base: quizApiBase(g.host),
        headers: { Authorization: g.token, AuthType: 'Signature' },
      };
    },

    async result(att) {
      const s = await this.json(`${att.base}/quiz_sessions/${att.sessionId}?anonymous_grading=false`,
        att.headers, undefined, 'Reading the attempt');
      return s.authoritative_result || null;
    },

    itemResults(att, resultId) {
      return this.json(`${att.base}/quiz_sessions/${att.sessionId}/results/${resultId}/session_item_results`,
        att.headers, undefined, 'Reading question scores');
    },

    // The login the quiz editor uses (what its "add to item bank" option sends
    // with). Canvas runs the editor on its own site and the editor keeps this
    // login in the tab's session storage. If this tab doesn't have one for the
    // quiz yet, the quiz's Build page is opened in a hidden frame on this site
    // so the editor fetches one; a same-site frame shares the tab's session storage.
    async buildLogin(conn, onStep = (label, fn) => fn()) {
      let found = findBuildLogin(conn.launch) || storedBuildLogin(conn.quizId);
      if (!found) found = await onStep('Opening the quiz editor in the background', () => this.editorLogin(conn));
      if (!found) {
        // For debugging only: the layout of the launch answer, with every value
        // replaced by its kind (and a login by its scope), never the value itself.
        debug('No quiz.build login. Quiz id from launch:', conn.quizId,
          'Launch answer layout:', JSON.stringify(shapeOf(conn.launch)));
        throw new Error("the quiz editor didn't give a login for editing this quiz. " +
          "Open the quiz's Build page in this tab once, then try again");
      }
      return {
        quizId: found.quizId || conn.quizId,
        base: quizHosts.base('api'),
        headers: { Authorization: found.token, AuthType: 'Signature' },
      };
    },

    async editorLogin(conn, timeoutMs = 45_000) {
      const frame = document.createElement('iframe');
      frame.src = `/courses/${courseId()}/assignments/${encodeURIComponent(conn.assignmentId)}` +
        `/build/${encodeURIComponent(conn.quizId)}?display=borderless`;
      frame.title = 'Quiz editor (loading in the background)';
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:800px;' +
        'border:0;visibility:hidden;pointer-events:none';
      document.body.append(frame);
      const frameStore = () => frame.contentWindow.sessionStorage;
      try {
        for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
          await sleep(500);
          const found = storedBuildLogin(conn.quizId, [frameStore]);
          if (found) return found;
        }
        debug('Quiz editor frame gave no quiz.build login within', timeoutMs, 'ms');
        return null;
      } finally {
        frame.remove();
      }
    },

    // Every entry in the quiz (questions, stimuli, bank questions, random sets), in pages.
    async quizEntries(editor) {
      const out = [];
      const seen = new Set();
      for (let page = 1; page <= 50; page++) {
        const data = await this.json(`${editor.base}/quizzes/${editor.quizId}/quiz_entries?page=${page}&per_page=100`,
          editor.headers, undefined, 'Reading the quiz’s questions');
        const rows = Array.isArray(data) ? data : (data?.quiz_entries || []);
        const fresh = rows.filter(r => !seen.has(String((r?.quiz_entry ?? r)?.id)));
        if (!fresh.length) break;
        fresh.forEach(r => seen.add(String((r?.quiz_entry ?? r)?.id)));
        out.push(...fresh);
      }
      return out;
    },

    async send(url, headers, opts, what) {
      const r = await this.request(url, headers, opts);
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        const detail = text.match(/"(?:message|error)"\s*:\s*"([^"]{1,150})"/)?.[1];
        throw httpError(`${what} was refused (${r.status}${detail ? `: ${detail}` : ''})`, r.status);
      }
      return r.json().catch(() => ({}));
    },

    // The quiz editor's "add to item bank", as the editor itself sends it:
    //   1. POST .../bank_entries/move_from_quiz_entry puts the question in the bank
    //      (the bank entry points at the same question, nothing is copied);
    //   2. PATCH the quiz entry so the quiz uses that bank entry instead of its
    //      own question. Without step 2 the quiz doesn't know it's banked.
    // `move` is { kind: 'Item' | 'Stimulus', sourceId: the question's id, quizEntryId }.
    async moveToBank(editor, bankId, move) {
      const base = `${editor.base}/banks/${encodeURIComponent(bankId)}`;
      const res = await this.send(
        `${base}/bank_entries/move_from_quiz_entry?source_quiz_id=${encodeURIComponent(editor.quizId)}`,
        editor.headers,
        { method: 'POST', body: { source_entry_id: String(move.sourceId), source_entry_type: move.kind } },
        'Adding it to the bank');
      let bankEntryId = (res?.bank_entry ?? res)?.id;
      // If the answer didn't name the new bank entry, find the one that holds this question.
      if (bankEntryId == null || String(bankEntryId) === String(move.sourceId)) {
        bankEntryId = await this.findBankEntry(editor, base, move.sourceId);
      }
      if (bankEntryId == null) throw new Error("added to the bank, but New Quizzes didn't say where, so the quiz wasn't linked");
      await this.send(
        `${editor.base}/quizzes/${encodeURIComponent(editor.quizId)}/quiz_entries/${encodeURIComponent(move.quizEntryId)}`,
        editor.headers,
        { method: 'PATCH', body: { quiz_entry: { entry_id: String(bankEntryId), entry_type: 'BankEntry' } } },
        'Linking the quiz to the bank');
      return String(bankEntryId);
    },

    async findBankEntry(editor, bankBase, itemId) {
      for (let page = 1; page <= 50; page++) {
        const rows = await this.json(`${bankBase}/bank_entries?page=${page}&per_page=100`,
          editor.headers, undefined, 'Reading the bank');
        const list = Array.isArray(rows) ? rows : (rows?.bank_entries || []);
        const hit = list.find(row => String(row?.entry?.id ?? row?.entry_id) === String(itemId));
        if (hit) return hit.id;
        if (list.length < 100) return null;
      }
      return null;
    },

    // The login View Log itself uses, one per attempt (sessionId is the
    // quiz-api session id). Neither the per-attempt grading login nor the
    // quiz-wide Moderate one can read the log (New Quizzes answers 401).
    async logLogin(conn, sessionId) {
      const q = `launch_token=${encodeURIComponent(conn.launchToken)}`;
      const r = await this.request(`${quizHosts.base('lti')}/quiz_sessions/${sessionId}/log?${q}`, conn.headers);
      if (!r.ok) throw httpError(`Opening View Log failed (${r.status})`, r.status);
      const j = await r.json();
      if (!j.token) throw new Error("New Quizzes didn't return a View Log login");
      return { base: quizApiBase(j.host), headers: { Authorization: j.token, AuthType: 'Signature' } };
    },

    // What Moderate > View Log shows for one attempt: started or resumed,
    // left or came back to the page, answered a question. `mod` is the
    // login from logLogin(); att only supplies the session id.
    async sessionEvents(att, mod) {
      const out = [];
      let url = `${mod.base}/quiz_sessions/${att.sessionId}/quiz_session_events`;
      for (let i = 0; url && i < 50; i++) {
        const r = await this.request(url, mod.headers);
        if (!r.ok) throw httpError(`Reading the quiz log failed (${r.status})`, r.status);
        const page = await r.json();
        out.push(...(Array.isArray(page) ? page : []));
        // Follow paging only if it's offered, and only on the same quiz host.
        const next = (r.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1];
        url = next && new URL(next, url).origin === new URL(url).origin ? new URL(next, url).href : null;
      }
      return out;
    },
  };

  Object.assign(window.__canvasExpansionPack, { newQuizzes });
})();
