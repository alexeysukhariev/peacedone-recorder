// Content script: watches the platform's live-caption DOM, merges rewritten lines into utterances,
// persists the session to chrome.storage.local every few seconds and asks background.js to save files.
(() => {
  if (globalThis.__IR_LOADED) return;
  globalThis.__IR_LOADED = true;

  const CFG = globalThis.IR_CONFIG;
  const M = globalThis.IR_MERGE;

  const platformId = detectPlatform();
  if (!platformId) return;
  const P = CFG.platforms[platformId];

  function detectPlatform() {
    if (globalThis.IR_PLATFORM_OVERRIDE) return globalThis.IR_PLATFORM_OVERRIDE; // test builds only
    for (const [id, p] of Object.entries(CFG.platforms)) {
      if (p.hosts.some((r) => r.test(location.hostname)) && (!p.pathMustMatch || p.pathMustMatch.test(location.pathname))) return id;
    }
    return null;
  }

  // ---------- state ----------
  const DEFAULT_SETTINGS = { autoStart: false, autoCaptions: true, lastLang: 'auto', myName: '', showIndicator: true };
  let settings = { ...DEFAULT_SETTINGS };
  let session = null;
  let dirty = false;
  let lastFlush = 0;
  let elemMap = new WeakMap();          // caption DOM element -> utterance
  const liveEl = new Map();             // utterance id -> WeakRef(element)
  let manualStop = false;               // user pressed Stop: don't auto-start again in this call
  let everInCall = false, lastInCallAt = 0, inCallNow = false;
  let captionsSeenAt = 0, captionsOn = false;
  let observer = null, observed = null, scanTimer = null;
  let pendingTag = '';
  let indicatorHidden = false;
  let autoTries = 0, nextAutoAt = 0;   // auto-captions attempts in this call

  chrome.storage.local.get(['settings', 'pendingTag'], (r) => {
    settings = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
    pendingTag = r.pendingTag || '';
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.settings) settings = { ...DEFAULT_SETTINGS, ...(ch.settings.newValue || {}) };
  });

  // ---------- DOM helpers ----------
  const qsAny = (sels, root = document) => {
    for (const s of sels || []) { try { const el = root.querySelector(s); if (el) return el; } catch (_) {} }
    return null;
  };
  const visible = (el) => !!el && el.isConnected && (el.offsetParent !== null || getComputedStyle(el).position === 'fixed');
  const textOf = (el) => M.clean(el ? el.textContent : '');

  function findContainer() {
    for (const s of P.container) {
      let list; try { list = document.querySelectorAll(s); } catch (_) { continue; }
      for (const el of list) if (!el.closest('#ir-root') && visible(el)) return el;
    }
    return null;
  }

  function findBlocks(container) {
    for (const s of P.block || []) {
      let list; try { list = container.querySelectorAll(s); } catch (_) { continue; }
      if (list.length) return [...list];
      try { if (container.matches(s)) return [container]; } catch (_) {}
    }
    // Structural fallback: walk down single-child wrappers, treat children as lines.
    let node = container;
    while (node.children.length === 1 && node.children[0].children.length) node = node.children[0];
    return [...node.children].filter((c) => textOf(c));
  }

  function pick(el, sels) {
    for (const s of sels || []) {
      try {
        if (el.matches(s)) return el;
        const f = el.querySelector(s);
        if (f) return f;
      } catch (_) {}
    }
    return null;
  }

  function leafTexts(el) {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { const t = M.clean(c.textContent); if (t) out.push(t); }
        else if (c.nodeType === 1 && !/^(BUTTON|SCRIPT|STYLE|svg)$/i.test(c.tagName) && c.getAttribute('aria-hidden') !== 'true') walk(c);
      }
    };
    walk(el);
    return out;
  }

  function parseBlock(el) {
    const spEl = pick(el, P.speaker);
    let txEl = pick(el, P.text);
    if (txEl && spEl && txEl.contains(spEl) && txEl !== spEl) txEl = null;
    let speaker = textOf(spEl), text = '';
    if (txEl && txEl !== spEl) text = textOf(txEl);
    if (!text) {
      const parts = leafTexts(el);
      if (speaker && parts[0] === speaker) parts.shift();
      else if (!speaker && parts.length > 1 && parts[0].length <= 48 && !/[.!?…]$/.test(parts[0])) speaker = parts.shift();
      text = M.clean(parts.join(' '));
    }
    return { speaker, text };
  }

  function normSpeaker(name) {
    name = M.clean(name);
    if (!name) return '';
    if ((P.selfLabels || []).some((l) => l.toLowerCase() === name.toLowerCase())) return settings.myName || name;
    return name;
  }

  // ---------- caption ingest ----------
  function scan() {
    scanTimer = null;
    const c = findContainer();
    if (!c || !session) return;
    for (const el of findBlocks(c)) {
      const { speaker, text } = parseBlock(el);
      if (text) upsert(el, normSpeaker(speaker), text);
    }
  }

  function upsert(el, speaker, text) {
    const now = Date.now();
    let u = elemMap.get(el);
    if (u) {
      if (speaker && u.speaker !== speaker && u.speaker !== 'Speaker') u = null;   // element reused for someone else
      else {
        if (text === u.raw) return;
        const merged = M.mergeText(u.text, text);
        if (merged !== null) {
          if (speaker && u.speaker === 'Speaker') u.speaker = speaker;
          if (merged !== u.text) { markPause(u, now); u.text = merged; u.t1 = now; touch(); }
          u.raw = text;
          return;
        }
        u = null; // unrelated text => a new line rendered into an old element
      }
    }
    const who = speaker || lastSpeaker() || 'Speaker';
    // Same utterance re-rendered into a new element (virtual lists, repaint)?
    const recent = session.utterances.slice(-8).reverse();
    for (const r of recent) {
      if (r.speaker !== who || now - r.t1 > CFG.continuationWindowMs) continue;
      const ref = liveEl.get(r.id); const other = ref && ref.deref();
      const otherLive = other && other !== el && other.isConnected;
      const rel = M.relate(r.text, text);
      if (!rel) continue;
      if (otherLive && rel.kind !== 'same' && rel.kind !== 'contained') continue; // a separate line on screen
      if (!M.isContinuation(r.text, text)) continue;
      elemMap.set(el, r); liveEl.set(r.id, new WeakRef(el));
      if (rel.text !== r.text) { markPause(r, now); r.text = rel.text; r.t1 = now; touch(); }
      r.raw = text;
      return;
    }
    const nu = { id: session.utterances.length + 1, speaker: who, text, raw: text, t0: now, t1: now };
    session.utterances.push(nu);
    elemMap.set(el, nu); liveEl.set(nu.id, new WeakRef(el));
    touch();
    renderIndicator();
  }

  function markPause(u, now) {
    if (now - u.t1 < CFG.segmentGapMs) return;
    const w = M.clean(u.text).split(' ').length;
    (u.marks = u.marks || []).push({ w, t: now });
  }

  function lastSpeaker() { const u = session && session.utterances[session.utterances.length - 1]; return u ? u.speaker : ''; }
  function touch() { dirty = true; session.updatedAt = Date.now(); }

  function attachObserver(c) {
    if (observed === c) return;
    if (observer) observer.disconnect();
    observed = c;
    observer = new MutationObserver(() => { if (!scanTimer) scanTimer = setTimeout(scan, CFG.scanThrottleMs); });
    observer.observe(c, { childList: true, subtree: true, characterData: true });
  }

  // ---------- session lifecycle ----------
  const storageGet = (keys) => new Promise((res) => chrome.storage.local.get(keys, res));
  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }); } catch (_) { res(null); }
  });

  async function findResumable() {
    const all = await storageGet(null);
    const key = P.meetingKey ? P.meetingKey(location) : null;
    let best = null;
    for (const [k, s] of Object.entries(all)) {
      if (!k.startsWith('s:') || !s || s.platform !== platformId || s.status !== 'recording') continue;
      if (Date.now() - (s.updatedAt || 0) > CFG.resumeWindowMs) continue;
      if (key && s.meetingKey && key !== s.meetingKey) continue;
      if (!best || s.updatedAt > best.updatedAt) best = s;
    }
    return best;
  }

  let starting = false;
  async function startSession(reason, opts = {}) {
    if (session || starting) return;
    starting = true;
    try {
      const prev = await findResumable();
      if (prev) {
        session = prev;
        if (opts.folder) session.folder = opts.folder;
        if (opts.lang) { session.lang = opts.lang; langPending = true; }
        session.resumedAt = (session.resumedAt || []).concat(Date.now());
        toast('Transcript resumed after reload — earlier lines are kept.');
      } else {
        const now = Date.now();
        session = {
          v: 1, id: now.toString(36) + '-' + Math.random().toString(36).slice(2, 7),
          platform: platformId, url: location.origin + location.pathname,
          meetingKey: P.meetingKey ? P.meetingKey(location) : null,
          tag: opts.tag != null ? String(opts.tag) : (pendingTag || ''), folder: opts.folder || '',
          myName: settings.myName, startReason: reason, lang: opts.lang || settings.lastLang || 'auto',
          startedAt: now, updatedAt: now, endedAt: null, status: 'recording', utterances: []
        };
        if (pendingTag) { pendingTag = ''; chrome.storage.local.remove('pendingTag'); }
        autoTries = 0; nextAutoAt = Date.now(); // switch captions on right away
        langPending = session.lang && session.lang !== 'auto'; langTries = 0; wrongLang = false;
        toast('Peacedone is taking notes from the live captions. Tell the others — e.g. “Just so you know, I keep notes from the live captions.”', 14000);
      }
      elemMap = new WeakMap(); liveEl.clear();
      dirty = true; await flush();
      send({ type: 'session-start', id: session.id });
      scan();
    } finally { starting = false; renderIndicator(); }
  }

  async function flush() {
    if (!session || !dirty) return;
    dirty = false; lastFlush = Date.now();
    const copy = { ...session, utterances: session.utterances.map(({ raw, ...u }) => u) };
    await new Promise((res) => chrome.storage.local.set({ ['s:' + session.id]: copy }, res));
  }

  async function endSession(reason) {
    if (!session) return null;
    const s = session;
    s.endedAt = Date.now(); s.status = 'ended'; s.endReason = reason;
    dirty = true; await flush();
    session = null; elemMap = new WeakMap(); liveEl.clear();
    const r = await send({ type: 'save', id: s.id, reason, final: true });
    if (r && r.empty) toast('Nothing was captured — captions were off, so no file was saved.');
    else if (r && r.ok) toast(`Transcript saved: ${r.where}`);
    else toast('Could not save the transcript file. It is kept in the extension — open the popup to save it.');
    renderIndicator();
    return r;
  }

  // ---------- caption language ----------
  let langPending = false, langTries = 0, langBusy = false, langMsg = '', wrongLang = false, nextLangCheck = 0;
  // Works with or without a recording: the language is the call app's setting, not ours.
  async function applyLanguage(langId) {
    langId = langId || (session && session.lang) || settings.lastLang;
    if (langBusy || !globalThis.IR_LANG || !langId || langId === 'auto') return { ok: true };
    langBusy = true;
    try {
      const r = await IR_LANG.setLanguage(platformId, langId);
      langMsg = r.message; langTries++;
      if (r.ok || langTries >= 2) langPending = false;
      if (!r.ok && langTries >= 2) toast(r.message, 10000);
      nextLangCheck = Date.now() + CFG.wrongLanguageCheckMs;   // give the new language time before judging
      wrongLang = false;
      return r;
    } finally { langBusy = false; }
  }
  function languageTick(now, inRealCall) {
    if (!globalThis.IR_LANG) return;
    if (IR_LANG.acceptNudge()) { langMsg = 'Accepted the call’s “Change language” suggestion.'; nextLangCheck = now + CFG.wrongLanguageCheckMs; }
    if (!session) return;
    // Meet's settings work without captions; Teams/Zoom caption menus need captions on
    if (langPending && inRealCall && (captionsOn || platformId === 'meet') && !langBusy) applyLanguage();
    if (now >= nextLangCheck && session.utterances.length >= 3) {
      nextLangCheck = now + CFG.wrongLanguageCheckMs;
      const text = session.utterances.slice(-8).map((u) => u.text).join(' ').slice(-400);
      wrongLang = IR_LANG.wrongLanguage(session.lang, text);
    }
  }

  // ---------- main loop ----------
  let captionsMissingSince = 0;
  setInterval(() => {
    const now = Date.now();
    const c = findContainer();
    captionsOn = !!c;
    if (c) { captionsSeenAt = now; attachObserver(c); }
    const inRealCall = !!qsAny(P.inCall);
    inCallNow = inRealCall || captionsOn;
    autoCaptions(now, inRealCall);
    if (!inRealCall && !captionsOn) nextAutoAt = 0;
    if (inCallNow) {
      lastInCallAt = now;
      if (!everInCall) { everInCall = true; }
      if (!session && settings.autoStart && !manualStop) startSession('auto');
    } else if (everInCall && now - lastInCallAt > CFG.callEndedAfterMs) {
      everInCall = false; manualStop = false;
      if (session) endSession('call ended');
    }
    if (session && c) scan();
    languageTick(now, inRealCall);
    captionsMissingSince = session && inCallNow && !captionsOn ? (captionsMissingSince || now) : 0;
    if (dirty && now - lastFlush >= CFG.flushEveryMs) flush();
    renderIndicator();
  }, 1000);

  // A recording you started survives a reload of the call tab.
  findResumable().then((prev) => { if (prev && !session) startSession('resume'); });

  addEventListener('pagehide', () => { if (session) { dirty = true; flush(); } });

  // ---------- turning captions on ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function clickByText(re) {
    const items = document.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],button,[role="button"]');
    for (const el of items) {
      const label = (el.getAttribute('aria-label') || '') + ' ' + textOf(el);
      if (re.test(label) && !el.closest('#ir-root')) { el.click(); return true; }
    }
    return false;
  }
  // Only ever click a control we are sure turns captions ON (never risk switching them off).
  const labelOf = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + textOf(el)).trim();
  function isTurnOn(el) {
    const pressed = el.getAttribute('aria-pressed') ?? el.getAttribute('aria-checked');
    if (pressed === 'true') return false;
    const label = labelOf(el);
    if (CFG.captionsOffLabel.test(label)) return false;
    return pressed === 'false' || CFG.captionsOnLabel.test(label);
  }
  function closeMenus(more) {
    const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true });
    (document.activeElement || document.body).dispatchEvent(esc);
    if (more && more.getAttribute('aria-expanded') === 'true') more.click();
  }
  let enabling = false;
  async function enableCaptions() {
    if (findContainer()) return { ok: true, message: 'Captions are already on.' };
    if (enabling) return { ok: false, message: 'Already trying…' };
    enabling = true;
    try {
      if (platformId === 'teams') {
        const m = P.captionsMenu;
        const more = qsAny(m.more);
        if (more) { more.click(); await sleep(600); }
        if (clickByText(m.languageItem)) await sleep(600);
        const item = [...document.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],button,[role="button"]')]
          .find((el) => !el.closest('#ir-root') && m.captionsItem.test(labelOf(el)) && isTurnOn(el));
        if (item) item.click(); else closeMenus(more);
      } else {
        const btn = [...document.querySelectorAll((P.captionsButton || []).join(','))]
          .find((b) => !b.closest('#ir-root') && isTurnOn(b));
        if (btn) btn.click();
      }
      await sleep(1500);
      const ok = !!findContainer();
      return { ok, message: ok ? 'Captions are on.' : `Couldn't switch them on automatically. ${P.howToCaptions}` };
    } finally { enabling = false; }
  }

  // Auto: as soon as you are in a call and captions are off, switch them on (a few tries, then the warning stays).
  async function autoCaptions(now, inRealCall) {
    if (!session || !settings.autoCaptions || !inRealCall || captionsOn) { if (!inRealCall) autoTries = 0; return; }
    if (autoTries >= CFG.autoCaptionsTries || now < nextAutoAt || enabling) return;
    if (!nextAutoAt) { nextAutoAt = now + CFG.autoCaptionsFirstDelayMs; return; } // joined after Start: let the call UI settle
    autoTries++;
    nextAutoAt = now + CFG.autoCaptionsRetryMs;
    const r = await enableCaptions();
    if (r.ok) toast('Captions switched on automatically.', 5000);
    else if (autoTries >= CFG.autoCaptionsTries) toast(r.message, 12000);
  }

  // ---------- popup API ----------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    (async () => {
      switch (msg && msg.type) {
        case 'getState': return reply(state());
        case 'start': manualStop = false; await startSession('manual', { folder: msg.folder, tag: msg.tag, lang: msg.lang }); return reply(state());
        case 'setFolder':
          if (session) { session.folder = String(msg.folder || ''); touch(); await flush(); }
          return reply(state());
        case 'stop': manualStop = true; { const r = await endSession('stopped by user'); return reply({ ...state(), saved: r }); }
        case 'export': {
          if (!session) return reply({ ok: false, message: 'Not recording.' });
          dirty = true; await flush();
          return reply(await send({ type: 'save', id: session.id, reason: 'manual save (call still running)', final: false }));
        }
        case 'setTag':
          if (session) { session.tag = String(msg.tag || ''); touch(); await flush(); }
          else { pendingTag = String(msg.tag || ''); chrome.storage.local.set({ pendingTag }); }
          return reply(state());
        case 'enableCaptions': return reply(await enableCaptions());
        case 'setLanguage': {
          const lang = String(msg.lang || 'auto');
          settings.lastLang = lang; chrome.storage.local.set({ settings });
          if (session) { session.lang = lang; touch(); await flush(); wrongLang = false; }
          langTries = 0; langPending = false;
          // in the call already → switch the call app's language right now, recording or not
          const r = inCallNow && lang !== 'auto' ? await applyLanguage(lang) : { ok: true, message: '' };
          if (r && !r.ok && session) langPending = true;   // retry later (e.g. once captions are on)
          return reply({ ...state(), langResult: r });
        }
        case 'diag': return reply(diag());
        default: return reply(null);
      }
    })();
    return true;
  });

  // Which selectors match on the live page — to update selectors.js when a platform changes its markup.
  function diag() {
    const count = (sels, root = document) => Object.fromEntries((sels || []).map((s) => { try { return [s, root.querySelectorAll(s).length]; } catch (_) { return [s, 'bad']; } }));
    const c = findContainer();
    const blocks = c ? findBlocks(c) : [];
    return {
      platform: platformId, selectors: CFG.version, host: location.host,
      inCall: count(P.inCall), container: count(P.container),
      block: c ? count(P.block, c) : null, blocksFound: blocks.length,
      lastBlock: blocks.length ? parseBlock(blocks[blocks.length - 1]) : null,
      containerHTML: c ? c.outerHTML.slice(0, 1500) : null
    };
  }

  function state() {
    const s = session;
    return {
      platform: platformId, label: P.label, howToCaptions: P.howToCaptions,
      inCall: inCallNow, captionsOn, recording: !!s, starting,
      lines: s ? s.utterances.length : 0,
      participants: s ? [...new Set(s.utterances.map((u) => u.speaker))] : [],
      startedAt: s ? s.startedAt : null, tag: s ? s.tag : pendingTag, folder: s ? s.folder : null, sessionId: s ? s.id : null,
      captionsMissingMs: captionsMissingSince ? Date.now() - captionsMissingSince : 0,
      lang: s ? s.lang : (settings.lastLang || 'auto'), wrongLang, langMsg,
      autoStart: settings.autoStart, manualStop
    };
  }

  // ---------- on-page indicator (shadow DOM, never sent anywhere) ----------
  let root, ui;
  function ensureUI() {
    if (root) return;
    const host = document.createElement('div');
    host.id = 'ir-root';
    host.style.cssText = 'position:fixed;left:12px;bottom:84px;z-index:2147483647;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{all:initial}
      .wrap{font:12px/1.35 ui-rounded,"Segoe UI",system-ui,sans-serif;color:#16324a;display:flex;flex-direction:column;gap:6px;align-items:flex-start;max-width:340px}
      .pill{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.94);border:1px solid #dbe8f2;box-shadow:0 4px 16px rgba(22,50,74,.18);border-radius:999px;padding:3px 6px 3px 4px;backdrop-filter:blur(6px)}
      .x{all:unset;cursor:pointer;opacity:.6;padding:0 4px}.x:hover{opacity:1}
      .card{background:#fff;border:1px solid #dbe8f2;border-radius:14px;padding:10px 12px;box-shadow:0 6px 24px rgba(22,50,74,.18)}
      .warn{background:#fff6e5;border-color:#f5b544;color:#8a5300}
      .warn b{color:#8a5300}
      .btn{all:unset;cursor:pointer;margin-top:8px;display:inline-block;background:#e5383b;color:#fff;font-weight:600;border-radius:8px;padding:5px 12px}
      .prompt{width:268px;padding:12px;border-radius:18px;border-color:#eddedc;box-shadow:0 10px 32px rgba(22,50,74,.22);animation:pd-in .35s ease-out}
      @keyframes pd-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
      .prow{display:flex;align-items:center;gap:8px}
      .prow .t{flex:1;min-width:0} .prow b{display:block;font-size:14px} .sub{color:#5f7a90;font-size:12px;margin-top:2px}
      .prow .x{align-self:flex-start;font-size:16px}
      .fbtn{all:unset;box-sizing:border-box;cursor:pointer;display:flex;align-items:center;gap:8px;width:100%;margin-top:10px;padding:8px 10px;border:1px solid #eddedc;border-radius:12px;background:#fff;font-weight:600}
      .fbtn:hover{border-color:#e5383b} .fbtn span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .sbtn{all:unset;box-sizing:border-box;cursor:pointer;display:block;width:100%;margin-top:8px;padding:10px;text-align:center;background:#e5383b;color:#fff;font-weight:700;font-size:13px;border-radius:12px;box-shadow:0 4px 14px rgba(229,56,59,.3)}
      .sbtn[disabled]{opacity:.45;cursor:default}
      .lsel{display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 10px;border:1px solid #eddedc;border-radius:12px;font-weight:600}
      .lsel select{all:unset;flex:1;cursor:pointer;font:inherit}
      [hidden]{display:none!important}
    </style>
    <div class="wrap">
      <div class="card prompt" id="prompt" hidden>
        <div class="prow"><span id="pmBig"></span><div class="t"><b>Record this call?</b><div class="sub">I’ll take notes from the captions.</div></div><button class="x" id="pclose" title="Not now">×</button></div>
        <button class="fbtn" id="pfolder">📁 <span id="pfname">Choose folder</span></button>
        <label class="lsel">🌐 <select id="plang"></select></label>
        <button class="sbtn" id="pstart" disabled>● Start recording</button>
      </div>
      <div class="card" id="toast" hidden></div>
      <div class="card warn" id="lwarn" hidden><b>Captions are in the wrong language.</b><div id="lhow"></div><button class="btn" id="lfix">Fix language</button></div>
      <div class="card warn" id="warn" hidden><b>Captions are off — nothing is being recorded.</b><div id="how"></div><button class="btn" id="on">Turn on captions</button></div>
      <div class="pill" id="pill" hidden><span id="pm"></span><span id="ptxt"></span><button class="x" id="hide" title="Hide indicator">×</button></div>
    </div>`;
    (document.body || document.documentElement).appendChild(host);
    ui = Object.fromEntries(['toast', 'warn', 'how', 'on', 'pill', 'ptxt', 'hide', 'pm', 'prompt', 'pmBig', 'pclose', 'pfolder', 'pfname', 'pstart', 'lwarn', 'lhow', 'lfix', 'plang'].map((id) => [id, root.getElementById(id)]));
    if (globalThis.PD_MASCOT) {
      PD_MASCOT.injectStyles(root);
      ui.pm.appendChild(PD_MASCOT.create(30, 'writing').el);
      ui.pmBig.appendChild(PD_MASCOT.create(54, 'idle').el);
    }
    ui.pclose.onclick = () => { promptDismissed = true; renderIndicator(); };
    if (!CFG.features.folderHelper) ui.pfolder.disabled = true;
    ui.pfolder.onclick = async () => {
      if (!CFG.features.folderHelper) return;
      ui.pfname.textContent = 'Choosing…';
      const r = await send({ type: 'pickFolder', dir: promptFolder, fromPage: true });
      if (r && r.dir) promptFolder = r.dir;
      showPromptFolder();
      if (r && r.needHelper) toast('To save into any folder, Peacedone needs a tiny one-time helper — click the Peacedone icon in the toolbar.', 9000);
    };
    for (const l of CFG.languages) ui.plang.appendChild(Object.assign(document.createElement('option'), { value: l.id, textContent: l.label }));
    ui.plang.value = settings.lastLang || 'auto';
    ui.plang.onchange = () => { settings.lastLang = ui.plang.value; chrome.storage.local.set({ settings }); };
    ui.lfix.onclick = () => { langTries = 0; applyLanguage(); };
    ui.pstart.onclick = async () => {
      manualStop = false; promptDismissed = true;
      await startSession('manual', { folder: promptFolder, lang: ui.plang.value });
    };
    chrome.storage.local.get('recentFolders', (r) => { promptFolder = (r.recentFolders || [])[0] || ''; showPromptFolder(); });
    ui.hide.onclick = () => { indicatorHidden = true; renderIndicator(); };
    ui.on.onclick = async () => { const r = await enableCaptions(); if (!r.ok) toast(r.message, 9000); };
  }
  // "Record this call?" card: pops up by itself on a call page so Start is never forgotten.
  let promptDismissed = false, promptFolder = '';
  function showPromptFolder() {
    if (!ui) return;
    ui.pfname.textContent = promptFolder ? promptFolder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'Downloads › Peacedone';
    ui.pfolder.title = promptFolder || 'Choose another folder';
    ui.pstart.disabled = false;   // no folder → Downloads, recording is never blocked
  }
  function wantsPrompt() {
    if (session || starting || promptDismissed || manualStop) return false;
    const onMeetingPage = !!(P.meetingKey && P.meetingKey(location));
    return inCallNow || onMeetingPage;
  }

  let toastTimer;
  function toast(text, ms = 7000) {
    ensureUI(); ui.toast.textContent = text; ui.toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { ui.toast.hidden = true; }, ms);
  }
  function renderIndicator() {
    if (!session && !root && !wantsPrompt()) return;
    ensureUI();
    ui.prompt.hidden = !wantsPrompt();
    const show = settings.showIndicator && !indicatorHidden;
    ui.pill.hidden = !(session && show);
    if (session) ui.ptxt.textContent = `Peacedone is taking notes · ${session.utterances.length} lines`;
    const warn = session && captionsMissingSince && Date.now() - captionsMissingSince > CFG.noCaptionsWarnAfterMs;
    ui.warn.hidden = !warn;
    const L = session && globalThis.IR_LANG && IR_LANG.byId(session.lang);
    ui.lwarn.hidden = !(session && wrongLang && !warn);
    if (L) ui.lhow.textContent = `You chose ${L.label}, but the captions look like another language.`;
    ui.how.textContent = P.howToCaptions;
  }
})();
