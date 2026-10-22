// Service worker: saves transcripts, recovers sessions after a closed tab or a crashed browser.
// No network access anywhere in this extension.
importScripts('selectors.js', 'merge.js', 'folder.js', 'save.js', 'installer.js');

const sessionKey = (id) => 's:' + id;
const get = (k) => chrome.storage.local.get(k).then((r) => (typeof k === 'string' ? r[k] : r));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg && msg.type) {
      case 'session-start': {
        if (!sender.tab) return reply(null);
        const key = 'tab:' + sender.tab.id;
        const prev = (await chrome.storage.session.get(key))[key];
        if (prev && prev !== msg.id) await IR_SAVE.saveSession(prev, 'a new call started in the same tab', true);
        await chrome.storage.session.set({ [key]: msg.id });
        setRecordingIcon(sender.tab.id, true);
        return reply({ ok: true });
      }
      case 'save':
        if (msg.final && sender.tab) setRecordingIcon(sender.tab.id, false);
        return reply(await IR_SAVE.saveSession(msg.id, msg.reason, msg.final));
      case 'pickFolder': {
        // Runs here, not in the popup: the Windows dialog takes focus and the popup may close.
        const r = await IR_FOLDER.pick(msg.dir);
        if (r.helperError) {                       // no helper yet → the popup explains and offers the installer
          await chrome.storage.local.set({ needHelper: true });
          if (msg.fromPage && chrome.action.openPopup) chrome.action.openPopup().catch(() => {});
          return reply({ ...r, needHelper: true });
        }
        if (r.dir) {
          await IR_FOLDER.remember(r.dir);
          if (msg.tabId != null) chrome.tabs.sendMessage(msg.tabId, { type: 'setFolder', folder: r.dir, onlyIfRecording: true }, { frameId: 0 }, () => void chrome.runtime.lastError);
        }
        reply(r);
        // The dialog stole focus and Chrome closed the popup — bring it back with the folder filled in.
        if (r.dir && !msg.fromPage && chrome.action.openPopup) setTimeout(() => chrome.action.openPopup().catch(() => {}), 150);
        return;
      }
      case 'saveAllPending': return reply(await IR_SAVE.saveAllPending(msg.reason || 'saved from popup'));
      default: return reply(null);
    }
  })().catch((e) => reply({ ok: false, error: String(e) }));
  return true;
});

// Toolbar icon: Peacedone with the notepad while this tab is being recorded.
function setRecordingIcon(tabId, on) {
  const p = on ? 'icons/rec-' : 'icons/';
  const path = Object.fromEntries([16, 32, 48, 128].map((s) => [s, `${p}${s}.png`]));
  chrome.action.setIcon({ tabId, path }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: on ? '●' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#ef4444' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: on ? 'Peacedone is taking notes' : 'Peacedone Recorder' }).catch(() => {});
}

// Tab closed mid-call: the content script had no chance to save.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const key = 'tab:' + tabId;
  const id = (await chrome.storage.session.get(key))[key];
  if (!id) return;
  await chrome.storage.session.remove(key);
  const s = await get(sessionKey(id));
  if (s && s.status === 'recording') await IR_SAVE.saveSession(id, 'tab closed during the call', true);
});

// Browser crashed / was closed with a call open: save whatever was persisted.
chrome.runtime.onStartup.addListener(() => IR_SAVE.saveAllPending('recovered after browser restart', { recordingToo: true }));
chrome.runtime.onInstalled.addListener(() => IR_SAVE.prune());
chrome.runtime.onStartup.addListener(() => IR_SAVE.prune());   // local copies of saved transcripts: kept 14 days
