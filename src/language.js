// Caption language: set it in the call app's own menus, accept Meet's "Change language" nudge,
// and notice when the caption text is in the wrong alphabet (e.g. Russian speech recognised as English).
(function (root) {
  const CFG = root.IR_CONFIG;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const byId = (id) => CFG.languages.find((l) => l.id === id);

  const CLICKABLE = 'button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="tab"],[role="option"],[role="combobox"],[aria-haspopup],li,a';
  // label = aria-label + aria-labelledby + own text; dropdowns also take their parent's text
  // (Meet draws "Язык встречи" as a floating label next to the list, not inside it)
  const labelOf = (el) => {
    let t = (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '');
    const ids = el.getAttribute('aria-labelledby');
    if (ids) for (const id of ids.split(/\s+/)) { const l = document.getElementById(id); if (l) t += ' ' + l.textContent; }
    if (el.matches('[role="combobox"],[aria-haspopup],select') && el.parentElement) t += ' ' + (el.parentElement.textContent || '').slice(0, 120);
    return t.replace(/\s+/g, ' ').trim();
  };
  const visible = (el) => !!el && el.isConnected && !el.closest('#ir-root') && (el.offsetParent !== null || getComputedStyle(el).position === 'fixed');

  function find(re, sel = CLICKABLE) {
    const all = [...document.querySelectorAll(sel)].filter(visible);
    // prefer the most specific (shortest label) match: "Captions" tab rather than the whole dialog
    return all.filter((el) => re.test(labelOf(el)) || re.test(el.getAttribute('aria-label') || ''))
      .sort((a, b) => labelOf(a).length - labelOf(b).length)[0] || null;
  }

  async function pickOption(lang) {
    // native <select>
    for (const sel of document.querySelectorAll('select')) {
      if (!visible(sel)) continue;
      const opt = [...sel.options].find((o) => lang.re.test(o.textContent));
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
    }
    const opt = [...document.querySelectorAll('[role="option"],[role="menuitemradio"],[role="menuitem"],li')]
      .filter(visible).find((el) => lang.re.test((el.textContent || el.getAttribute('aria-label') || '').trim()));
    if (!opt) return false;
    if (opt.getAttribute('aria-selected') !== 'true' && opt.getAttribute('aria-checked') !== 'true') opt.click();
    return true;
  }

  function closeDialogs() {
    const esc = () => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    esc();
    const x = find(/^(close|закрыть|закрити|done|готово)$/i);
    if (x) x.click();
  }

  async function runPath(path, lang) {
    let picked = false;
    for (const step of path) {
      if (step.click) {
        const el = find(step.click);
        if (!el) { if (step.optional) continue; return false; }
        el.click(); await sleep(600);
      } else if (step.open) {
        const el = find(step.open, '[role="combobox"],[aria-haspopup="listbox"],[aria-haspopup="true"],select,button,[role="button"]');
        if (!el && step.required) return false;
        if (el && el.tagName !== 'SELECT') { el.click(); await sleep(600); }
      } else if (step.option) {
        picked = await pickOption(lang); await sleep(500);
        if (!picked) return false;
      } else if (step.close) {
        closeDialogs(); await sleep(300);
      }
    }
    return picked;
  }

  // Returns { ok, message }
  async function setLanguage(platformId, langId) {
    const lang = byId(langId);
    if (!lang || !lang.re) return { ok: true, message: 'Keeping the call’s caption language.' };
    for (const path of (CFG.languagePaths[platformId] || [])) {
      try { if (await runPath(path, lang)) return { ok: true, message: `Caption language: ${lang.label}` }; }
      catch (_) { /* try the next path */ }
      closeDialogs(); await sleep(300);
    }
    return { ok: false, message: `Couldn’t switch the caption language to ${lang.label} automatically — set it in the call’s caption settings.` };
  }

  // Meet's own detection asks "Change language?" — just accept it.
  function acceptNudge() {
    const b = find(CFG.languageNudge, 'button,[role="button"]');
    if (b) { b.click(); return true; }
    return false;
  }

  // Which alphabet the captions are in: 'cyrillic' | 'latin' | null (not enough text)
  function scriptOf(text) {
    const cyr = (text.match(/[Ѐ-ӿ]/g) || []).length;
    const lat = (text.match(/[A-Za-z]/g) || []).length;
    if (cyr + lat < 40) return null;
    if (cyr / (cyr + lat) > 0.8) return 'cyrillic';
    if (lat / (cyr + lat) > 0.8) return 'latin';
    return null;   // mixed: people switch languages, don't nag
  }
  function wrongLanguage(langId, text) {
    const lang = byId(langId);
    if (!lang || !lang.script) return false;
    const s = scriptOf(text);
    return !!s && s !== lang.script;
  }

  root.IR_LANG = { setLanguage, acceptNudge, wrongLanguage, scriptOf, byId };
})(globalThis);
