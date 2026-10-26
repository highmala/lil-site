(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const requestedMode = params.get('ui');
  const mode = requestedMode === 'sliders' || requestedMode === 'buttons' ? requestedMode : 'xy';
  const sliders = document.getElementById('control-sliders');
  const buttons = document.getElementById('control-buttons');

  document.body.classList.add('control-mode-' + mode);
  if (mode !== 'xy') document.body.classList.add('control-mode-alt');
  sliders.hidden = mode !== 'sliders';
  buttons.hidden = mode !== 'buttons';

  function modeUrl(targetMode) {
    const url = new URL(window.location.href);
    if (targetMode === 'xy') url.searchParams.delete('ui');
    else url.searchParams.set('ui', targetMode);
    return url.pathname + url.search + url.hash;
  }

  document.querySelectorAll('#control-mode-selector a').forEach(function (link) {
    link.href = modeUrl(link.dataset.mode);
    if (link.dataset.mode === mode) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  document.querySelectorAll('#world-selector a').forEach(function (link) {
    const url = new URL(link.href, window.location.href);
    if (requestedMode) url.searchParams.set('ui', mode);
    else url.searchParams.delete('ui');
    link.href = url.pathname + url.search + url.hash;
  });

  if (mode === 'sliders') {
    [
      { id: 'control-x', axis: 'x', low: 'hum', high: 'glow' },
      { id: 'control-y', axis: 'y', low: 'sleep', high: 'play' }
    ].forEach(function (config) {
      const input = document.getElementById(config.id);

      function startAudio() { window.LILControls.startAudio(); }
      function update() {
        startAudio();
        const value = Number(input.value) / 1000;
        const target = window.LILControls.getTarget();
        target[config.axis] = value;
        window.LILControls.setPosition(target.x, target.y);
        input.setAttribute('aria-valuetext', Math.round(value * 100) + '% toward ' + config.high + ' from ' + config.low);
      }

      input.addEventListener('pointerdown', startAudio);
      input.addEventListener('touchstart', startAudio, { passive: true });
      input.addEventListener('keydown', startAudio);
      input.addEventListener('input', update);
      input.setAttribute('aria-valuetext', '50% toward ' + config.high + ' from ' + config.low);
    });
  }

  if (mode === 'buttons') {
    const quadrantButtons = Array.from(buttons.querySelectorAll('button[data-quadrant]'));
    const MARGIN = 0.04;

    function randomHalf(high) {
      const min = high ? 0.5 + MARGIN : MARGIN;
      return min + Math.random() * (0.5 - 2 * MARGIN);
    }

    function choose(button) {
      window.LILControls.startAudio();
      const quadrant = button.dataset.quadrant;
      const x = randomHalf(quadrant.charAt(1) === 'R');
      const y = randomHalf(quadrant.charAt(0) === 'T');
      window.LILControls.setPosition(x, y);
    }

    quadrantButtons.forEach(function (button) {
      button.addEventListener('pointerdown', function () { window.LILControls.startAudio(); });
      button.addEventListener('touchstart', function () { window.LILControls.startAudio(); }, { passive: true });
      button.addEventListener('click', function () { choose(button); });
    });

    document.addEventListener('keydown', function (event) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const index = ['1', '2', '3', '4'].indexOf(event.key);
      if (index === -1) return;
      event.preventDefault();
      window.LILControls.startAudio();
      choose(quadrantButtons[index]);
    });
  }
}());
