// Peacedone, the mascot-indicator. Four frames of the same original render (face never redrawn):
// idle (looks and smiles), blink, writing (notes the call), writing-blink. States: 'idle' | 'writing'.
// Floats in the air (no shadow), blinks every few seconds (sometimes twice); while writing also wiggles as if scribbling.
(function (root) {
  const FRAMES = ['idle', 'blink', 'writing', 'writing-blink'];
  const url = (f) => (root.chrome && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL(`assets/mascot/${f}.png`) : `../assets/mascot/${f}.png`);

  function create(size = 96, state = 'idle') {
    const el = document.createElement('div');
    el.className = 'pd-mascot';
    el.style.setProperty('--pd-size', size + 'px');
    el.dataset.state = state;
    for (const f of FRAMES) {
      const img = document.createElement('img');
      img.src = url(f); img.alt = f === 'idle' ? 'Peacedone' : ''; img.draggable = false;
      img.className = 'pd-f pd-' + f;
      el.appendChild(img);
    }
    let timer, alive = true;
    const blink = () => {
      el.classList.add('pd-blinking');
      setTimeout(() => el.classList.remove('pd-blinking'), 150);
    };
    const loop = () => {
      if (!alive) return;
      timer = setTimeout(() => {
        blink();
        if (Math.random() < 0.25) setTimeout(blink, 320);   // a double blink now and then
        loop();
      }, 2200 + Math.random() * 3600);
    };
    loop();
    return {
      el,
      set(stateName) { el.dataset.state = stateName; },
      blink,
      destroy() { alive = false; clearTimeout(timer); el.remove(); }
    };
  }

  // Styles are injected once per document/shadow root so the content script can use it too.
  const CSS = `
  .pd-mascot{position:relative;width:var(--pd-size);height:var(--pd-size);flex:none}   /* floats: no shadow */
  .pd-f{position:absolute;inset:0;width:100%;height:100%;opacity:0;user-select:none;pointer-events:none}
  .pd-mascot[data-state=idle] .pd-idle,
  .pd-mascot[data-state=idle].pd-blinking .pd-blink,
  .pd-mascot[data-state=writing] .pd-writing,
  .pd-mascot[data-state=writing].pd-blinking .pd-writing-blink{opacity:1}
  .pd-mascot[data-state=idle].pd-blinking .pd-idle,
  .pd-mascot[data-state=writing].pd-blinking .pd-writing{opacity:0}
  .pd-mascot[data-state=idle]{animation:pd-float 3.6s ease-in-out infinite}
  .pd-mascot[data-state=writing]{animation:pd-float 3.6s ease-in-out infinite}
  .pd-mascot[data-state=writing] .pd-f{animation:pd-scribble 1.1s ease-in-out infinite}
  @keyframes pd-float{0%,100%{transform:translateY(2%)}50%{transform:translateY(-4%)}}
  @keyframes pd-scribble{0%,100%{transform:rotate(0) translateY(0)}25%{transform:rotate(-1.6deg) translateY(-1%)}75%{transform:rotate(1.4deg) translateY(.5%)}}
  @media (prefers-reduced-motion: reduce){.pd-mascot{animation:none!important}}`;
  function injectStyles(target = document.head) {
    if (target.querySelector && target.querySelector('style[data-pd]')) return;
    const st = document.createElement('style'); st.dataset.pd = '1'; st.textContent = CSS;
    target.appendChild(st);
  }

  root.PD_MASCOT = { create, injectStyles };
})(globalThis);
