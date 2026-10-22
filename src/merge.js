// Pure helpers shared by content.js, background.js and node tests. No DOM, no chrome.* here.
(function (root) {
  const normWord = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const words = (s) => (s || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function eqWords(a, ai, b, bi, n) {
    for (let k = 0; k < n; k++) if (normWord(a[ai + k]) !== normWord(b[bi + k])) return false;
    return true;
  }

  // How does a fresh reading `next` of a caption line relate to what we stored (`prev`)?
  // Platforms keep rewriting a line: it grows, last words get revised, old words scroll out of the front.
  // Returns { kind, text } or null when `next` is unrelated.
  function relate(prev, next) {
    prev = clean(prev); next = clean(next);
    if (!prev) return { kind: 'grew', text: next };
    if (!next) return { kind: 'contained', text: prev };
    const a = words(prev), b = words(next);
    const na = a.map(normWord).join(' '), nb = b.map(normWord).join(' ');
    if (na === nb) return { kind: 'same', text: next.length >= prev.length ? next : prev }; // punctuation/case
    if (nb.startsWith(na + ' ') || nb.includes(' ' + na + ' ') || nb.endsWith(' ' + na) || nb.startsWith(na))
      return { kind: 'grew', text: next };
    if (na.includes(nb)) {                                                   // view shrank / partial repaint:
      for (let i = a.length - b.length; i >= 0; i--) {                       // keep prev, take next's spelling
        if (eqWords(a, i, b, 0, b.length)) return { kind: 'contained', text: clean([...a.slice(0, i), ...b, ...a.slice(i + b.length)].join(' ')) };
      }
      return { kind: 'contained', text: prev };
    }

    // Anchor: first words of `next` found inside `prev` => prev[0..i) + next.
    // Covers front-trimmed text and revisions of the tail.
    for (let n = Math.min(4, b.length); n >= 2; n--) {
      for (let i = a.length - n; i >= 0; i--) {
        if (eqWords(a, i, b, 0, n)) return { kind: n >= 3 ? 'anchored' : 'anchored-weak', text: clean(a.slice(0, i).join(' ') + ' ' + next) };
      }
    }
    // Suffix of prev == prefix of next
    for (let k = Math.min(a.length, b.length, 3); k >= 2; k--) {
      if (eqWords(a, a.length - k, b, 0, k)) return { kind: k >= 3 ? 'overlap' : 'overlap-weak', text: clean(prev + ' ' + b.slice(k).join(' ')) };
    }
    // Common prefix => the line was revised
    let p = 0;
    while (p < a.length && p < b.length && normWord(a[p]) === normWord(b[p])) p++;
    if (p >= 2 && p >= Math.min(a.length, b.length) * 0.5) return { kind: 'revised', text: next };
    // Very short lines get rewritten wholesale ("Hi" -> "Hey there")
    if (a.length <= 3) return { kind: 'short', text: next };
    return null;
  }

  // Same DOM element re-read: accept any relation.
  function mergeText(prev, next) { const r = relate(prev, next); return r ? r.text : null; }

  // New DOM element: is it the same utterance re-rendered (not a new line)? Only strong relations,
  // so separate short replies ("Yes." / "Okay.") never overwrite each other.
  function isContinuation(prev, next) {
    const r = relate(prev, next);
    return !!r && ['same', 'grew', 'contained', 'anchored', 'overlap'].includes(r.kind);
  }

  const pad = (n) => String(n).padStart(2, '0');
  function clock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }
  function localStamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function localHM(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

  function slug(s) {
    return clean(s).replace(/[\\/:*?"<>|#%&{}$!'`@+=,;]+/g, '').replace(/\s+/g, '-')
      .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'call';
  }

  function baseName(session) {
    const d = new Date(session.startedAt);
    return `${localStamp(session.startedAt)}_${pad(d.getHours())}${pad(d.getMinutes())}_${session.platform}_${slug(session.tag)}`;
  }

  // Consecutive lines of one speaker with a short gap become one paragraph in the .md
  function paragraphs(utts, gapMs = 4000) {
    const out = [];
    for (const u of utts) {
      if (!clean(u.text)) continue;
      const last = out[out.length - 1];
      if (last && last.speaker === u.speaker && u.t0 - last.t1 <= gapMs) {
        last.text = clean(last.text + ' ' + u.text); last.t1 = Math.max(last.t1, u.t1);
      } else out.push({ speaker: u.speaker, text: clean(u.text), t0: u.t0, t1: u.t1 });
    }
    return out;
  }

  // One caption utterance split at the pauses recorded by content.js (marks: [{ w: wordIndex, t }]).
  function segments(u) {
    const w = clean(u.text).split(' ').filter(Boolean);
    const marks = (u.marks || []).filter((m) => m.w > 0 && m.w < w.length).sort((x, y) => x.w - y.w);
    const out = []; let from = 0, t = u.t0;
    for (const m of marks) { if (m.w > from) out.push({ t, text: w.slice(from, m.w).join(' ') }); from = m.w; t = m.t; }
    if (from < w.length) out.push({ t, text: w.slice(from).join(' ') });
    return out;
  }

  // Turns: consecutive utterances of one speaker; each turn = name heading + timestamped lines.
  function turns(utts) {
    const out = [];
    for (const u of utts) {
      const last = out[out.length - 1];
      const segs = segments(u);
      if (last && last.speaker === u.speaker) last.lines.push(...segs);
      else out.push({ speaker: u.speaker, t0: u.t0, lines: segs });
    }
    return out;
  }

  function toMarkdown(session, labels) {
    const utts = (session.utterances || []).filter((u) => clean(u.text));
    const t0 = utts.length ? Math.min(session.startedAt, utts[0].t0) : session.startedAt;
    const end = session.endedAt || (utts.length ? utts[utts.length - 1].t1 : Date.now());
    const people = [...new Set(utts.map((u) => u.speaker))];
    const label = (labels && labels[session.platform]) || session.platform;
    const L = [];
    L.push(`# Interview transcript — ${clean(session.tag) || label}`);
    L.push('');
    L.push(`- **Date:** ${localStamp(t0)} ${localHM(t0)}–${localHM(end)} (local time)`);
    L.push(`- **Platform:** ${label}`);
    if (clean(session.tag)) L.push(`- **Tag:** ${clean(session.tag)}`);
    L.push(`- **Participants (from captions):** ${people.join(', ') || '—'}`);
    L.push(`- **Duration:** ${clock(end - t0)}`);
    L.push(`- **Source:** platform live captions (machine speech recognition — names, numbers and terms may be misheard)`);
    if (session.exportReason) L.push(`- **Saved because:** ${session.exportReason}`);
    L.push('');
    L.push('---');
    for (const turn of turns(utts)) {
      L.push('', `### ${turn.speaker} · ${clock(turn.t0 - t0)}`, '');
      for (const seg of turn.lines) L.push(`- \`${clock(seg.t - t0)}\` ${seg.text}`);
    }
    L.push('');
    return L.join('\n');
  }

  const api = { relate, mergeText, isContinuation, toMarkdown, segments, turns, baseName, slug, clock, paragraphs, clean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.IR_MERGE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
