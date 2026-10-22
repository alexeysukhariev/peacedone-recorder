const $ = (id) => document.getElementById(id);
const DEFAULTS = { autoStart: false, autoCaptions: true, myName: '', showIndicator: true };

async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...settings };
  $('myName').value = s.myName; $('autoStart').checked = s.autoStart; $('autoCaptions').checked = s.autoCaptions; $('showIndicator').checked = s.showIndicator;
  $('pathLabel').value = await IR_FOLDER.getPath();
}
async function saveSettings() {
  await chrome.storage.local.set({ settings: { myName: $('myName').value.trim() || DEFAULTS.myName, autoStart: $('autoStart').checked, autoCaptions: $('autoCaptions').checked, showIndicator: $('showIndicator').checked } });
}
['myName', 'autoStart', 'autoCaptions', 'showIndicator'].forEach((id) => $(id).addEventListener('change', saveSettings));
$('pathLabel').addEventListener('change', () => IR_FOLDER.remember($('pathLabel').value));

async function renderHelper() {
  if (!IR_CONFIG.features.folderHelper) { const card = document.getElementById('helperState').closest('.card'); if (card) card.hidden = true; return; }
  const st = await IR_FOLDER.status();
  const pending = await IR_SAVE.pending();
  const el = $('helperState');
  if (st.state === 'no-helper') {
    el.innerHTML = 'Not installed — transcripts go to Downloads. Install once: run <code>python helper\\install.py</code> in the extension folder (README → “Folder helper”), then reload this page.';
    el.className = 'small warn-text';
  } else {
    el.textContent = '✓ Installed and running.' + (st.state === 'bad-folder' ? ` Last folder problem: ${st.error}.` : '');
    el.className = 'small ok';
  }
  $('flush').hidden = st.state === 'no-helper' || !pending.length;
  $('flush').textContent = `Copy ${pending.length} pending transcript${pending.length === 1 ? '' : 's'} to their folders`;
}

$('test').onclick = async () => {
  const dir = $('pathLabel').value.trim();
  if (!dir) { $('folderMsg').textContent = 'Type a folder path first.'; return; }
  const r = await IR_FOLDER.test(dir);
  $('folderMsg').textContent = r.ok ? `✓ Wrote and removed a test file in ${r.dir}` : `✗ ${r.helperError ? 'Helper not installed.' : r.error}`;
  if (r.ok) IR_FOLDER.remember(dir);
  renderHelper();
};
$('flush').onclick = async () => {
  const r = await IR_SAVE.saveAllPending('copied after the folder became available');
  $('folderMsg').textContent = `Copied ${r.filter((x) => x.ok && x.savedTo === 'folder').length} of ${r.length} pending transcript(s).`;
  renderHelper();
};

PD_MASCOT.injectStyles();
document.getElementById('mascotSlot').appendChild(PD_MASCOT.create(110, 'idle').el);
loadSettings();
renderHelper();
