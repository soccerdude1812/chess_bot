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
    const evalBarToggle = document.getElementById('toggle-evalbar');
    const hintArrow = document.getElementById('hint-arrow');
    const hintSubtle = document.getElementById('hint-subtle');
    const speedBtns = {
      instant: document.getElementById('speed-instant'),
      fast: document.getElementById('speed-fast'),
      human: document.getElementById('speed-human'),
      slow: document.getElementById('speed-slow')
    };
    const statusText = document.getElementById('status-text');

    // Load current state
    chrome.storage.local.get(['enabled', 'mode', 'myColor', 'targetElo', 'showEvalBar', 'hintStyle', 'moveSpeed'], (data) => {
      if (chrome.runtime.lastError) {
        statusText.textContent = 'Storage error';
        return;
      }
      const enabled = !!data.enabled;
      const mode = data.mode || 'suggest';
      const color = data.myColor || 'auto';
      const elo = data.targetElo || 2700;
      const hint = data.hintStyle || 'arrow';
      const speed = data.moveSpeed || 'human';

      toggleEl.checked = enabled;
      evalBarToggle.checked = data.showEvalBar !== false;
      setActiveBtn([suggestBtn, autoBtn], mode === 'auto' ? autoBtn : suggestBtn);
      setActiveBtn([colorWhite, colorBlack, colorAuto],
        color === 'w' ? colorWhite : color === 'b' ? colorBlack : colorAuto);
      setActiveBtn([hintArrow, hintSubtle], hint === 'subtle' ? hintSubtle : hintArrow);
      setActiveBtn(Object.values(speedBtns), speedBtns[speed] || speedBtns.human);
      eloSlider.value = elo;
      eloDisplay.textContent = elo;
      updateStatus(enabled, mode, elo);
    });

    Object.keys(speedBtns).forEach((key) => {
      speedBtns[key].addEventListener('click', () => {
        chrome.storage.local.set({ moveSpeed: key });
        setActiveBtn(Object.values(speedBtns), speedBtns[key]);
      });
    });

    evalBarToggle.addEventListener('change', () => {
      chrome.storage.local.set({ showEvalBar: evalBarToggle.checked });
    });

    hintArrow.addEventListener('click', () => {
      chrome.storage.local.set({ hintStyle: 'arrow' });
      setActiveBtn([hintArrow, hintSubtle], hintArrow);
    });
    hintSubtle.addEventListener('click', () => {
      chrome.storage.local.set({ hintStyle: 'subtle' });
      setActiveBtn([hintArrow, hintSubtle], hintSubtle);
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
