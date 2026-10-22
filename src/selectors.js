// All platform DOM knowledge lives here. Platforms change their markup often:
// each list is tried in order, first match wins. When captions stop being picked up,
// open DevTools on the call, find the caption element and add its selector to the TOP of the list.
// `container` = element that holds the caption lines; `block` = one caption line/utterance inside it;
// `speaker` / `text` = parts of a block. If block/speaker/text selectors miss, content.js falls back
// to a structural parser (first short text = name, the rest = caption).

globalThis.IR_CONFIG = {
  version: '2026-10-20',
  // Chrome Web Store build turns this off (no native helper, files go to Downloads › Peacedone)
  features: { folderHelper: true },

  platforms: {
    meet: {
      label: 'Google Meet',
      hosts: [/^meet\.google\.com$/],
      // Meeting code in the path, e.g. /abc-defg-hij
      meetingKey: (loc) => (loc.pathname.match(/[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}/) || [null])[0],
      inCall: [
        'button[jsname="CQylAd"]',
        'button[aria-label*="Leave call" i]',
        'button[aria-label*="Покинуть" i]',
        'button[aria-label*="Вийти з виклику" i]',
        'button[aria-label*="Залишити" i]',
        '[data-ir-incall]'
      ],
      container: [
        'div[role="region"][aria-label*="aption" i]',
        'div[role="region"][aria-label*="убтитр" i]',
        'div[jsname="dsyhDe"]',
        'div.a4cQT',
        'div[jscontroller="KPn5nb"]'
      ],
      block: ['div.nMcdL', 'div.TBMuR', 'div[jsname="tgaKEf"]'],
      speaker: ['.NWpY1d', '.KcIKyf', '.zs7s8d', '.jxFHg'],
      text: ['.ygicle', '.bh44bd', '.iTTPOb', '.VbkSUe'],
      captionsButton: [
        'button[jsname="r8qRAd"]',
        'button[aria-label*="Turn on captions" i]',
        'button[aria-label*="captions" i]',
        'button[aria-label*="субтитр" i]'
      ],
      selfLabels: ['You', 'Вы', 'Ви', 'Ты', 'Ти'],
      howToCaptions: 'Click the CC button in the bottom bar (or press C). Pick the spoken language under Settings → Captions if needed.'
    },

    teams: {
      label: 'Microsoft Teams (web)',
      hosts: [/(^|\.)teams\.microsoft\.com$/, /(^|\.)teams\.live\.com$/, /(^|\.)teams\.cloud\.microsoft$/],
      meetingKey: () => null,
      inCall: [
        '#hangup-button',
        'button[data-tid="hangup-main-btn"]',
        'button[data-tid="call-hangup"]',
        'button[aria-label^="Leave" i]',
        'button[aria-label*="Покинуть" i]',
        'button[aria-label*="Вийти" i]',
        '[data-ir-incall]'
      ],
      container: [
        '[data-tid="closed-caption-v2-window-wrapper"]',
        '[data-tid="closed-captions-renderer"]',
        '[data-tid="closed-caption-renderer-wrapper"]',
        '[data-tid="closed-caption-v2-virtual-list-content"]',
        'div[role="log"][aria-label*="aption" i]',
        'div[role="log"][aria-label*="убтитр" i]'
      ],
      block: [
        '.fui-ChatMessageCompact',
        '[data-tid="closed-caption-message"]',
        '[data-tid^="closed-caption-item"]',
        '.ui-chat__item'
      ],
      speaker: ['[data-tid="author"]', '.ui-chat__message__author', '[class*="author" i]'],
      text: ['[data-tid="closed-caption-text"]', '.ui-chat__message__content', '[class*="captionText" i]'],
      captionsMenu: {
        more: ['#callingButtons-showMoreBtn', 'button[data-tid="more-button"]', 'button[aria-label^="More" i]', 'button[aria-label*="Ще" i]', 'button[aria-label*="Ещё" i]'],
        languageItem: /language and speech|мова й мовлення|язык и речь/i,
        captionsItem: /live captions|субтитр/i   // + must pass the "turns ON" check (see captionsOnLabel)
      },
      selfLabels: [],
      howToCaptions: 'More (···) → Language and speech → Turn on live captions. Check that the spoken language matches the call.'
    },

    zoom: {
      label: 'Zoom (web client)',
      hosts: [/(^|\.)zoom\.us$/, /(^|\.)zoom\.com$/],
      pathMustMatch: /\/wc\//,
      meetingKey: (loc) => (loc.pathname.match(/\/wc\/(?:join\/)?(\d{6,})/) || [null, null])[1],
      inCall: [
        'button.footer__leave-btn',
        '.footer__leave-btn-container button',
        'button[aria-label*="Leave" i]',
        '[data-ir-incall]'
      ],
      // Full transcript panel (has names) first, then the subtitle overlay (often without names).
      container: [
        '.lt-full-transcript__list',
        '.lt-full-transcript',
        '#live-transcription-subtitle',
        '.live-transcription-subtitle__box',
        '[class*="live-transcription-subtitle"]'
      ],
      block: ['.lt-full-transcript__item', '.live-transcription-subtitle__item'],
      speaker: ['.lt-full-transcript__display-name', '.live-transcription-subtitle__display-name', '[class*="display-name"]'],
      text: ['.lt-full-transcript__message', '.live-transcription-subtitle__text', '.live-transcription-subtitle__item'],
      captionsButton: ['button[aria-label*="captions" i]', 'button[aria-label*="Show Captions" i]', 'button[aria-label*="субтитр" i]'],
      selfLabels: ['Me', 'You'],
      howToCaptions: 'Click CC / Show Captions in the bottom bar. For speaker names open "View full transcript". The host may need to allow captions.'
    }
  },

  // ---------- Caption language ----------
  // Captions only recognise the language set in the call app (Meet's auto-detect covers 8 languages and only *suggests*
  // a switch; Teams needs Premium/Interpreter; Zoom has none). So Peacedone sets it: `re` matches the option text in the
  // platform's language list (in English / Russian / Ukrainian UI), `script` is used to spot a wrong language in the text.
  languages: [
    { id: 'auto', label: 'Keep call’s language' },   // don't touch the call's setting (only accept Meet's nudge)
    { id: 'en', label: 'English', re: /^\s*(english|английский|англійська)/i, script: 'latin' },
    { id: 'ru', label: 'Русский', re: /^\s*(russian|русский|російська)/i, script: 'cyrillic' },
    { id: 'uk', label: 'Українська', re: /^\s*(ukrainian|украинский|українська)/i, script: 'cyrillic' },
    { id: 'de', label: 'Deutsch', re: /^\s*(german|deutsch|немецкий|німецька)/i, script: 'latin' },
    { id: 'pl', label: 'Polski', re: /^\s*(polish|polski|польский|польська)/i, script: 'latin' },
    { id: 'es', label: 'Español', re: /^\s*(spanish|español|испанский|іспанська)/i, script: 'latin' },
    { id: 'fr', label: 'Français', re: /^\s*(french|français|французский|французька)/i, script: 'latin' }
  ],
  // Menu paths to the caption-language list. Each path is a list of steps; a step is tried by label text
  // (aria-label or visible text, EN/RU/UK). Paths are tried in order until one reaches the language option.
  //   click: open something   ·   open: the language dropdown   ·   option: pick the language   ·   close: Esc/Close
  languagePaths: {
    meet: [
      // the language list is already on screen (Settings → Captions open): just pick
      [{ open: /language of the meeting|meeting language|язык встречи|мова зустрічі/i, required: true }, { option: true }, { close: true }],
      [{ click: /caption(s)? settings|настройки субтитров|налаштування субтитрів/i }, { open: /language|язык|мова/i }, { option: true }, { close: true }],
      [{ click: /^(more options|другие действия|інші дії|ещё|ще)$/i }, { click: /^(settings|настройки|налаштування)$/i },
        { click: /^(captions|субтитры|субтитри)$/i, optional: true }, { open: /language|язык|мова/i }, { option: true }, { close: true }]
    ],
    teams: [
      [{ click: /caption(s)? settings|настройки субтитров|параметри субтитрів/i }, { click: /language settings|языковые параметры|параметри мови/i, optional: true },
        { open: /spoken language|язык речи|разговорный язык|мова мовлення/i }, { option: true },
        { click: /^(update|save|confirm|обновить|сохранить|оновити|зберегти)$/i, optional: true }, { close: true }],
      [{ click: /^(more|ещё|ще)$/i }, { click: /language and speech|язык и речь|мова й мовлення/i },
        { click: /language settings|spoken language|языковые параметры|мова мовлення/i, optional: true },
        { open: /spoken language|язык речи|разговорный язык|мова мовлення/i }, { option: true },
        { click: /^(update|save|confirm|обновить|сохранить|оновити|зберегти)$/i, optional: true }, { close: true }]
    ],
    zoom: [
      [{ click: /caption(s)? (settings|options)|more caption|параметры субтитров|налаштування субтитрів/i }, { click: /speaking language|язык речи|мова мовлення/i, optional: true },
        { option: true }, { close: true }]
    ]
  },
  // Meet's own auto-detect shows a nudge after ~30 s: Peacedone accepts it at once.
  languageNudge: /^(change language|изменить язык|змінити мову)$/i,
  wrongLanguageCheckMs: 15000,

  // Auto "turn captions on": a control is clicked only if it says it turns captions ON
  // (aria-pressed/aria-checked="false", or a label below) and never if it says "off/hide".
  captionsOnLabel: /turn on|show captions|show live captions|enable captions|start captions|включить|увімкн/i,
  captionsOffLabel: /turn off|hide captions|hide live captions|disable|stop captions|выключить|отключить|вимкн/i,
  autoCaptionsFirstDelayMs: 2000,
  autoCaptionsRetryMs: 8000,
  autoCaptionsTries: 4,

  // Timings (ms)
  segmentGapMs: 2500,        // pause inside one caption line => new timestamped line in the .md
  flushEveryMs: 2000,        // write to chrome.storage.local
  scanThrottleMs: 250,       // DOM scan after mutations
  noCaptionsWarnAfterMs: 8000,
  callEndedAfterMs: 6000,    // in-call markers gone this long => call ended
  resumeWindowMs: 10 * 60 * 1000,  // reload/crash within this window resumes the same session
  continuationWindowMs: 20000      // a new DOM line that continues a recent one is merged into it
};
