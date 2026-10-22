// Turning a stored session into files. Used by the service worker and by extension pages
// (popup/options re-save pending transcripts right after the user re-grants folder access).
(function (root) {
  const M = root.IR_MERGE, F = root.IR_FOLDER, CFG = root.IR_CONFIG;
  const LABELS = Object.fromEntries(Object.entries(CFG.platforms).map(([k, v]) => [k, v.label]));
  const DL_DIR = 'Peacedone';   // default without the helper: Downloads/Peacedone
  const key = (id) => 's:' + id;
  const get = async (k) => (await chrome.storage.local.get(k))[k];

  function files(s) {
    const base = M.baseName(s);
    const json = JSON.stringify({ format: 'interview-recorder/1', selectors: CFG.version, ...s }, null, 2);
    return [
      { name: base + '.md', text: M.toMarkdown(s, LABELS), mime: 'text/markdown' },
      { name: 'raw/' + base + '.json', text: json, mime: 'application/json' }
    ];
  }

  async function toDownloads(list) {
    for (const f of list) {
      await chrome.downloads.download({
        url: `data:${f.mime};charset=utf-8,` + encodeURIComponent(f.text),
        filename: `${DL_DIR}/${f.name}`, conflictAction: 'overwrite', saveAs: false
      });
    }
  }

  // final=true: the call is over (status -> ended, exported=true). final=false: snapshot while recording.
  async function saveSession(id, reason, final) {
    const s = await get(key(id));
    if (!s) return { ok: false, error: 'session not found' };
    const lines = (s.utterances || []).filter((u) => M.clean(u.text)).length;
    if (!lines) {
      if (final) await chrome.storage.local.remove(key(id));
      return { ok: false, empty: true };
    }
    if (final && s.status === 'recording') { s.status = 'ended'; s.endedAt = s.endedAt || s.updatedAt; }
    if (reason && !/^(call ended|stopped by user)$/.test(reason)) s.exportReason = reason;
    const list = files(s);
    let res;
    try { res = await F.write(list, s.folder); } catch (e) { res = { ok: false, reason: 'error', error: String(e) }; }
    if (res.ok) {
      Object.assign(s, { savedTo: 'folder', folder: res.folder, pendingFolder: false });
    } else if (!s.downloadedAt || s.downloadedAt < (s.updatedAt || 0)) {
      // Never lose a transcript: fall back to Downloads and remember to copy it to the folder later.
      try {
        await toDownloads(list);
        // without the folder helper (store build) Downloads IS the destination: nothing left to copy later
        Object.assign(s, { savedTo: 'downloads', downloadedAt: Date.now(), pendingFolder: !!CFG.features.folderHelper, folderError: res.reason || res.error });
      } catch (e) {
        s.folderError = String(e);
        await chrome.storage.local.set({ [key(id)]: s });
        return { ok: false, error: String(e) };
      }
    }
    s.savedAt = Date.now();
    if (final) s.exported = true;
    await chrome.storage.local.set({ [key(id)]: s });
    const where = s.savedTo === 'folder'
      ? `folder “${s.folder}” → ${list[0].name}`
      : `Downloads/${DL_DIR}/${list[0].name} (folder not available: ${res.reason || 'error'}${res.error ? ' — ' + res.error : ''})`;
    return { ok: true, savedTo: s.savedTo, where, files: list.map((f) => f.name), lines };
  }

  async function pending({ recordingToo = false } = {}) {
    const all = await chrome.storage.local.get(null);
    const stale = Date.now() - CFG.resumeWindowMs;
    return Object.entries(all).filter(([k, s]) => k.startsWith('s:') && s && (
      (s.status === 'ended' && !s.exported) || s.pendingFolder ||
      (s.status === 'recording' && (recordingToo || (s.updatedAt || 0) < stale))
    )).map(([, s]) => s);
  }

  async function saveAllPending(reason, opts) {
    const out = [];
    for (const s of await pending(opts)) out.push({ id: s.id, ...(await saveSession(s.id, s.status === 'recording' ? reason : null, true)) });
    return out;
  }

  async function prune(days = 14) {
    const all = await chrome.storage.local.get(null);
    const old = Date.now() - days * 864e5;
    const rm = Object.entries(all).filter(([k, s]) => k.startsWith('s:') && s && s.exported && (s.savedTo === 'folder' || (s.savedTo === 'downloads' && !s.pendingFolder)) && (s.savedAt || 0) < old).map(([k]) => k);
    if (rm.length) await chrome.storage.local.remove(rm);
  }

  root.IR_SAVE = { saveSession, saveAllPending, pending, prune, files };
})(globalThis);
