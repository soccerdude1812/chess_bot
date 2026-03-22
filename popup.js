const toggleEl = document.getElementById('toggle-enabled');
const suggestBtn = document.getElementById('mode-suggest');
const autoBtn = document.getElementById('mode-auto');
const statusText = document.getElementById('status-text');

// Load current state
chrome.storage.local.get(['enabled', 'mode'], (data) => {
  const enabled = data.enabled || false;
  const mode = data.mode || 'suggest';

  toggleEl.checked = enabled;
  updateModeButtons(mode);
  updateStatus(enabled, mode);
});

// Toggle engine
toggleEl.addEventListener('change', () => {
  const enabled = toggleEl.checked;
  chrome.storage.local.set({ enabled });
  chrome.storage.local.get(['mode'], (data) => {
    updateStatus(enabled, data.mode || 'suggest');
  });
});

// Mode buttons
suggestBtn.addEventListener('click', () => {
  chrome.storage.local.set({ mode: 'suggest' });
  updateModeButtons('suggest');
  updateStatus(toggleEl.checked, 'suggest');
});

autoBtn.addEventListener('click', () => {
  chrome.storage.local.set({ mode: 'auto' });
  updateModeButtons('auto');
  updateStatus(toggleEl.checked, 'auto');
});

function updateModeButtons(mode) {
  suggestBtn.classList.toggle('active', mode === 'suggest');
  autoBtn.classList.toggle('active', mode === 'auto');
}

function updateStatus(enabled, mode) {
  if (!enabled) {
    statusText.textContent = 'Disabled';
  } else if (mode === 'auto') {
    statusText.textContent = 'Auto-play active';
  } else {
    statusText.textContent = 'Suggesting moves';
  }
}
