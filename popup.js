document.addEventListener('DOMContentLoaded', () => {
  try {
    const toggleEl = document.getElementById('toggle-enabled');
    const suggestBtn = document.getElementById('mode-suggest');
    const autoBtn = document.getElementById('mode-auto');
    const colorWhite = document.getElementById('color-white');
    const colorBlack = document.getElementById('color-black');
    const colorAuto = document.getElementById('color-auto');
    const eloSlider = document.getElementById('elo-slider');
    const eloDisplay = document.getElementById('elo-display');
    const statusText = document.getElementById('status-text');

    // Load current state
    chrome.storage.local.get(['enabled', 'mode', 'myColor', 'targetElo'], (data) => {
      if (chrome.runtime.lastError) {
        statusText.textContent = 'Storage error';
        return;
      }
      const enabled = !!data.enabled;
      const mode = data.mode || 'suggest';
      const color = data.myColor || 'auto';
      const elo = data.targetElo || 2700;

      toggleEl.checked = enabled;
      setActiveBtn([suggestBtn, autoBtn], mode === 'auto' ? autoBtn : suggestBtn);
      setActiveBtn([colorWhite, colorBlack, colorAuto],
        color === 'w' ? colorWhite : color === 'b' ? colorBlack : colorAuto);
      eloSlider.value = elo;
      eloDisplay.textContent = elo;
      updateStatus(enabled, mode, elo);
    });

    // Engine toggle
    toggleEl.addEventListener('change', () => {
      chrome.storage.local.set({ enabled: toggleEl.checked });
      chrome.storage.local.get(['mode', 'targetElo'], (d) => {
        updateStatus(toggleEl.checked, d.mode || 'suggest', d.targetElo || 2700);
      });
    });

    // Mode buttons
    suggestBtn.addEventListener('click', () => {
      chrome.storage.local.set({ mode: 'suggest' });
      setActiveBtn([suggestBtn, autoBtn], suggestBtn);
      updateStatus(toggleEl.checked, 'suggest', parseInt(eloSlider.value));
    });
    autoBtn.addEventListener('click', () => {
      chrome.storage.local.set({ mode: 'auto' });
      setActiveBtn([suggestBtn, autoBtn], autoBtn);
      updateStatus(toggleEl.checked, 'auto', parseInt(eloSlider.value));
    });

    // Color buttons
    colorWhite.addEventListener('click', () => {
      chrome.storage.local.set({ myColor: 'w' });
      setActiveBtn([colorWhite, colorBlack, colorAuto], colorWhite);
    });
    colorBlack.addEventListener('click', () => {
      chrome.storage.local.set({ myColor: 'b' });
      setActiveBtn([colorWhite, colorBlack, colorAuto], colorBlack);
    });
    colorAuto.addEventListener('click', () => {
      chrome.storage.local.set({ myColor: 'auto' });
      setActiveBtn([colorWhite, colorBlack, colorAuto], colorAuto);
    });

    // ELO slider
    eloSlider.addEventListener('input', () => {
      eloDisplay.textContent = eloSlider.value;
    });
    eloSlider.addEventListener('change', () => {
      const elo = parseInt(eloSlider.value);
      chrome.storage.local.set({ targetElo: elo });
      eloDisplay.textContent = elo;
      updateStatus(toggleEl.checked, suggestBtn.classList.contains('active') ? 'suggest' : 'auto', elo);
    });

    function setActiveBtn(btns, active) {
      btns.forEach(b => b.classList.toggle('active', b === active));
    }

    function updateStatus(enabled, mode, elo) {
      if (!enabled) {
        statusText.textContent = 'Disabled';
      } else {
        statusText.textContent = (mode === 'auto' ? 'Auto-play' : 'Suggest') + ' \u2022 ' + elo + ' ELO';
      }
    }
  } catch (err) {
    document.getElementById('status-text').textContent = 'Error: ' + err.message;
  }
});
