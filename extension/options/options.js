document.addEventListener('DOMContentLoaded', () => {
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response) => {
    if (!response) return;
    const { settings, threshold } = response;
    document.getElementById('serverUrl').value = settings.serverUrl || 'http://localhost:3456';
    document.getElementById('emailAddress').value = settings.emailAddress || '';
    document.getElementById('threshold').value = threshold;
  });

  document.getElementById('save').addEventListener('click', () => {
    const serverUrl = document.getElementById('serverUrl').value.trim();
    const emailAddress = document.getElementById('emailAddress').value.trim();
    const threshold = parseInt(document.getElementById('threshold').value) || 70;

    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response) => {
      const existing = response?.settings || {};
      const updated = {
        ...existing,
        serverUrl,
        emailAddress,
        emailEnabled: !!emailAddress,
      };

      chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: updated });
      chrome.runtime.sendMessage({ type: 'SAVE_THRESHOLD', threshold });

      const msg = document.getElementById('savedMsg');
      msg.style.display = 'inline';
      setTimeout(() => { msg.style.display = 'none'; }, 2000);
    });
  });
});
