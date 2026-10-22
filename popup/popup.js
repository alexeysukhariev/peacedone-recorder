const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let tabId = params.has('tabId') ? Number(params.get('tabId')) : null; // ?tabId= is used by headless tests
let last = null, renderedOnce = false, savedUntil = 0;
const CALL_URL = /^https:\/\/(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|[\w.-]*zoom\.(us|com)\/wc)/;

async function activeTab() {
  if (tabId != null) return tabId;
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t ? t.id : null;
}

function ask(msg) {
  return new Promise(async (res) => {
    const id = await activeTab();
    if (id == null) return res(null);
    chrome.tabs.sendMessage(id, msg, { frameId: 0 }, (r) => { void chrome.runtime.lastError; res(r || null); });
  });
}

// ---------- folder: one button, shows the chosen folder; the Windows dialog does the choosing ----------
let folderOk = false, lastCheck = null;
// Popup files are read from disk, so this code also runs inside an old copy that lacks "nativeMessaging".
const HELPER = IR_CONFIG.features.folderHelper;
const OUTDATED = HELPER && typeof chrome.runtime.sendNativeMessage !== 'function';
// An old unpacked copy (loaded before the helper existed) can't reach the helper: offer to remove it.
$('fixCopy') && ($('fixCopy').onclick = () => { if (chrome.management && chrome.management.uninstallSelf) chrome.management.uninstallSelf({ showConfirmDialog: true }); else chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id }); });
const loadFolders = () => IR_FOLDER.recent();
function showFolder(dir) {
  $('folder').value = dir || '';
  const parts = (dir || '').replace(/[\\/]+$/, '').split(/[\\/]/);
  $('folderName').textContent = dir ? parts.pop() : 'Downloads › Peacedone';
  $('folderPath').textContent = dir ? '…\\' + parts.slice(-2).join('\\') : '';
  $('pick').title = dir || 'Choose a folder';
}
async function checkFolder() {
  const dir = $('folder').value.trim();
  const hint = $('folderHint');
  hint.textContent = ''; folderOk = false;
  if (!HELPER) { $('pick').classList.add('static'); $('pick').title = 'Transcripts are saved to Downloads › Peacedone'; renderButtons(); return; }
  if (OUTDATED) {
    hint.textContent = 'This is an old copy of Peacedone — it can’t save to folders. Remove it, the other copy works.';
  } else if (dir) {
    const r = await IR_FOLDER.check(dir); lastCheck = r;
    if (r.outdated) hint.textContent = 'This is an old copy of Peacedone. Remove it — the other copy works.';
    else if (r.helperError) hint.textContent = 'Saving to Downloads › Peacedone (folder helper not installed)';
    else if (r.ok && r.writable) folderOk = true;
    else hint.textContent = r.ok && r.exists ? 'Folder is read-only' : 'Folder not found';
  }
  hint.className = 'hint warn-text';
  $('fixCopy').hidden = !OUTDATED;
  renderButtons();
}
async function setFolder(dir) {
  showFolder(dir);
  await checkFolder();
  if (dir && folderOk) await IR_FOLDER.remember(dir);
  if (dir && last && last.recording) await ask({ type: 'setFolder', folder: dir });
}
$('pick').onclick = async () => {
  if (!HELPER) return;   // store build: Downloads › Peacedone only
  if (OUTDATED) return checkFolder();
  // The dialog takes focus, so Chrome may close this popup; the background keeps the choice and reopens it.
  $('folderName').textContent = 'Choosing…';
  let r;
  try { r = await chrome.runtime.sendMessage({ type: 'pickFolder', dir: $('folder').value.trim(), tabId: await activeTab() }); }
  catch (e) { r = { ok: false, error: 'background: ' + e.message }; }
  if (r && r.dir) return setFolder(r.dir);
  showFolder($('folder').value);
  if (r && r.needHelper) return showHelperCard();
  if (!r) { $('folderHint').textContent = 'No answer from the extension — reload it in chrome://extensions'; $('folderHint').className = 'hint warn-text'; }
  else if (r.error) { $('folderHint').textContent = 'Can’t open the folder dialog: ' + r.error; $('folderHint').className = 'hint warn-text'; }
};

// ---------- one-time folder helper: download → open → we notice it by ourselves ----------
let helperPoll;
function showHelperCard() {
  $('helperCard').hidden = false; $('folderHint').textContent = '';
  chrome.storage.local.remove('needHelper');
}
function watchForHelper() {
  clearInterval(helperPoll);
  helperPoll = setInterval(async () => {
    const st = await IR_FOLDER.status();
    if (st.state !== 'no-helper') {        // installed: hide the card and go straight to choosing the folder
      clearInterval(helperPoll);
      $('helperCard').hidden = true;
      $('pick').click();
    }
  }, 1500);
}
$('installHelper').onclick = async () => {
  $('installHelper').disabled = true;
  $('helperText').textContent = 'Downloading…';
  try {
    const id = await IR_INSTALLER.download();
    const opened = await new Promise((res) => {
      const done = (d) => {
        if (d.id !== id || !d.state) return;
        if (d.state.current === 'complete') { chrome.downloads.onChanged.removeListener(done); try { chrome.downloads.open(id); res(true); } catch (_) { res(false); } }
        if (d.state.current === 'interrupted') { chrome.downloads.onChanged.removeListener(done); res(false); }
      };
      chrome.downloads.onChanged.addListener(done);
      setTimeout(() => res(false), 8000);
    });
    $('helperText').textContent = opened
      ? 'A setup window opened — wait for “installed”. I’ll notice it here.'
      : 'Open “Peacedone-Helper-Setup.cmd” in Chrome’s downloads (top right). If Chrome asks, choose Keep. I’ll notice it here.';
    $('installHelper').textContent = 'Download again';
  } catch (e) {
    $('helperText').textContent = 'Couldn’t download the setup: ' + e.message;
  }
  $('installHelper').disabled = false;
  watchForHelper();
};
$('helperLater').onclick = () => { $('helperCard').hidden = true; clearInterval(helperPoll); };

// ---------- render ----------
function renderButtons() {
  const rec = last && last.recording;
  $('toggle').textContent = rec ? '■ Stop' : '● Start';
  $('toggle').className = rec ? 'danger' : 'primary';
  $('toggle').disabled = false;   // never block recording: no folder → Downloads
  $('save').hidden = !rec;
}

PD_MASCOT.injectStyles();
const mascot = PD_MASCOT.create(92, 'idle');
$('mascotSlot').appendChild(mascot.el);
// Hidden helper for broken selectors: Alt+click Peacedone → diagnostics to clipboard.
mascot.el.addEventListener('click', async (e) => {
  if (!e.altKey) return;
  const r = await ask({ type: 'diag' });
  const text = r ? JSON.stringify(r, null, 1) : 'No answer from the page.';
  $('diagOut').textContent = text; $('diagOut').hidden = false;
  try { await navigator.clipboard.writeText(text); } catch (_) {}
});

function say(title, meta, mood) {
  $('statusText').textContent = title;
  $('meta').textContent = meta || '';
  $('meta').hidden = !meta;
  $('status').dataset.mood = mood || 'calm';
  $('dot').className = 'dot ' + (mood === 'rec' ? 'rec' : 'idle');
  mascot.set(mood === 'rec' ? 'writing' : 'idle');
}

function render(s) {
  last = s;
  $('call').hidden = !s; $('nocall').hidden = !!s;
  if (!s) { if (!renderedOnce) say("Hi, I'm Peacedone!", 'I record your calls in Meet, Teams and Zoom.'); return; }
  renderedOnce = true;
  const off = s.recording && s.inCall && !s.captionsOn && s.captionsMissingMs > IR_CONFIG.noCaptionsWarnAfterMs;
  const time = s.recording ? IR_MERGE.clock(Date.now() - s.startedAt) : '';
  const L = IR_CONFIG.languages.find((l) => l.id === s.lang);
  if (off) say('Captions are off', 'I can’t hear the call without them.', 'alert');
  else if (s.recording && s.wrongLang) say('Wrong caption language', `The captions don’t look like ${L ? L.label : 'the chosen language'}.`, 'alert');
  else if (s.recording && s.lines) say('Recording your call', `${time} · ${s.lines} lines`, 'rec');
  else if (s.recording) say('Recording your call', `${time} · listening…`, 'rec');
  else if (Date.now() < savedUntil) say('Transcript saved ✓', 'It’s in your folder.');
  else say('Ready to record your call', 'Press Start and I’ll take notes.');
  $('enableCaps').hidden = !off;
  $('fixLang').hidden = !(s.recording && s.wrongLang && !off);
  // like the company field: before Start the choice is the user's; during recording it mirrors the session
  if (s.lang && document.activeElement !== $('lang') && (s.recording || !langTouched)) $('lang').value = s.lang;
  // Before Start the field belongs to the user; during recording it mirrors the session.
  if ((s.recording || !$('tag').value) && document.activeElement !== $('tag') && s.tag) $('tag').value = s.tag;
  if (s.recording && s.folder && $('folder').value !== s.folder) { showFolder(s.folder); checkFolder(); }
  renderButtons();
}

async function refresh() { render(await ask({ type: 'getState' })); }

$('toggle').onclick = async () => {
  $('toggle').disabled = true;
  $('result').textContent = '';
  let r;
  if (last && last.recording) {
    r = await ask({ type: 'stop' });
    const sv = r && r.saved;
    if (sv && sv.ok && sv.savedTo === 'folder') savedUntil = Date.now() + 6000;
    else if (sv && sv.ok) $('result').textContent = 'Saved to Downloads › Peacedone';
    else if (sv && sv.empty) $('result').textContent = 'Nothing was said — no file.';
    else if (sv) $('result').textContent = 'Not saved yet — kept in the extension.';
  } else {
    const folder = $('folder').value.trim();
    await IR_FOLDER.remember(folder);
    r = await ask({ type: 'start', folder, tag: $('tag').value.trim(), lang: $('lang').value });
  }
  render(r);
};
$('save').onclick = async () => {
  const r = await ask({ type: 'export' });
  $('result').textContent = r && r.ok ? 'Saved ✓' : (r && r.empty ? 'Nothing yet.' : 'Not saved.');
  setTimeout(() => { $('result').textContent = ''; }, 3000);
};
$('enableCaps').onclick = async () => {
  const r = await ask({ type: 'enableCaptions' });
  $('capsMsg').textContent = r && !r.ok ? r.message : '';
  refresh();
};
// call language: captions only recognise the language set in the call app — Peacedone sets it there
for (const l of IR_CONFIG.languages) $('lang').appendChild(Object.assign(document.createElement('option'), { value: l.id, textContent: l.label }));
let langTouched = false;
$('lang').onchange = async () => {
  langTouched = true;
  const r = await ask({ type: 'setLanguage', lang: $('lang').value });
  const lr = r && r.langResult;
  $('result').textContent = lr && lr.message ? (lr.ok ? '✓ ' : '') + lr.message : '';
};
$('fixLang').onclick = () => ask({ type: 'setLanguage', lang: $('lang').value });
let tagTimer;
$('tag').oninput = () => { clearTimeout(tagTimer); tagTimer = setTimeout(() => ask({ type: 'setTag', tag: $('tag').value.trim() }), 300); };
$('settings').onclick = () => chrome.runtime.openOptionsPage();
document.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => { chrome.tabs.create({ url: b.dataset.open }); window.close(); }; });
$('reloadTab').onclick = async () => { chrome.tabs.reload(await activeTab()); window.close(); };

(async () => {
  // Never show an empty popup: draw the right state from the tab URL first, then ask the page.
  const id = await activeTab();
  let url = '';
  try { url = (await chrome.tabs.get(id)).url || ''; } catch (_) {}
  const callSite = CALL_URL.test(url);
  if (callSite) { $('nocallTitle').textContent = 'Connecting…'; $('services').hidden = true; $('reloadTab').hidden = false; }
  render(null);
  const recent = await loadFolders();
  showFolder(recent[0] || '');
  const s = await Promise.race([ask({ type: 'getState' }), new Promise((r) => setTimeout(() => r(null), 1500))]);
  if (!s && callSite) $('nocallTitle').textContent = 'Reload this tab to start';
  if (s && s.folder) showFolder(s.folder);
  render(s);
  checkFolder();
  const { needHelper } = await chrome.storage.local.get('needHelper');
  if (needHelper && !OUTDATED) { showHelperCard(); }
  setInterval(refresh, 1000);
})();
