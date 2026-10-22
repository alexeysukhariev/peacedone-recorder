// Writing to the folder from Settings. Chrome extensions can't write outside Downloads on their own,
// so a tiny local helper (helper/peacedone-host.ps1, Chrome native messaging) writes the files to the full path
// the user typed. No network; the helper only accepts .md/.json/.txt names inside that folder.
(function (root) {
  const HOST = 'com.peacedone.recorder';

  function native(msg) {
    if (typeof chrome.runtime.sendNativeMessage !== 'function')   // an old copy loaded before v0.2: no permission
      return Promise.resolve({ ok: false, helperError: true, outdated: true, error: 'extension needs a reload' });
    return new Promise((res) => {
      try {
        chrome.runtime.sendNativeMessage(HOST, msg, (r) => {
          const e = chrome.runtime.lastError;
          const out = e ? { ok: false, helperError: true, error: e.message } : (r || { ok: false, error: 'empty reply' });
          if (!out.ok) chrome.storage.local.set({ lastHelperError: { at: new Date().toISOString(), cmd: msg.cmd, error: out.error } });
          res(out);
        });
      } catch (e) { res({ ok: false, helperError: true, error: String(e) }); }
    });
  }
  const getPath = async () => ((await chrome.storage.local.get('folderPath')).folderPath || '').trim();
  const setPath = (p) => chrome.storage.local.set({ folderPath: (p || '').trim() });

  // state: 'granted' | 'none' (no path) | 'no-helper' | 'bad-folder'
  async function status() {
    const dir = await getPath();
    const r = await native({ cmd: dir ? 'check' : 'ping', dir });
    if (r.helperError) return { state: 'no-helper', dir, error: r.error };
    if (!dir) return { state: 'none' };
    if (!r.ok) return { state: 'bad-folder', dir, error: r.error };
    return { state: r.writable ? 'granted' : 'bad-folder', dir, name: r.dir, error: r.exists ? 'not writable' : 'folder does not exist' };
  }

  // files: [{ name, text }]
  async function write(files, dirOverride) {
    const dir = (dirOverride || '').trim() || await getPath();
    if (!dir) return { ok: false, reason: 'no-folder' };
    const r = await native({ cmd: 'write', dir, files: files.map((f) => ({ name: f.name, text: f.text })) });
    if (r.ok) return { ok: true, folder: r.dir };
    return { ok: false, reason: r.helperError ? 'helper not installed' : 'folder error', error: r.error };
  }

  const test = (dir) => native({ cmd: 'test', dir });
  const check = (dir) => native({ cmd: 'check', dir });
  const pick = (dir) => native({ cmd: 'pick', dir });

  // Recent folders for the popup (first = last used, also the default for the next call).
  async function remember(dir) {
    dir = (dir || '').trim(); if (!dir) return;
    const { recentFolders = [] } = await chrome.storage.local.get('recentFolders');
    const list = [dir, ...recentFolders.filter((d) => d.toLowerCase() !== dir.toLowerCase())].slice(0, 8);
    await chrome.storage.local.set({ recentFolders: list, folderPath: dir });
  }
  const recent = async () => (await chrome.storage.local.get('recentFolders')).recentFolders || [];

  root.IR_FOLDER = { status, write, test, check, pick, getPath, setPath, remember, recent };
})(globalThis);
