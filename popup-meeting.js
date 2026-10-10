// Popup controls for meeting transcription. Wrapped in an IIFE so it can't
// collide with the top-level names in popup.js.
(() => {
  const toggle = document.getElementById("meeting-toggle");
  const statusEl = document.getElementById("meeting-status");

  async function render() {
    const [recording, settings] = await Promise.all([getRecording(), getTranscriptionSettings()]);

    if (recording) {
      toggle.textContent = "Stop transcribing";
      toggle.disabled = false;
      statusEl.textContent = recording.error
        ? `Listening to “${recording.title}”, but the last chunk failed: ${recording.error}`
        : `Listening to “${recording.title}”${settings.includeMic && !recording.warning ? " and your microphone" : ""}. Everyone in the call should know it’s being transcribed.`;
      if (recording.warning) statusEl.textContent += ` ${recording.warning}`;
      return;
    }

    toggle.textContent = "Transcribe this tab";
    if (!isTranscriptionConfigured(settings)) {
      toggle.disabled = true;
      statusEl.textContent = "Add a transcription endpoint in Settings to turn this on.";
      return;
    }
    toggle.disabled = false;
    statusEl.textContent = settings.includeMic
      ? "Open your meeting tab, then start. The tab and your microphone are transcribed."
      : "Open your meeting tab, then start. Only the tab’s audio is transcribed.";
  }

  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    const recording = await getRecording();
    let reply;
    if (recording) {
      reply = await chrome.runtime.sendMessage({ target: "background", type: "transcription:stop" });
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      reply = await chrome.runtime.sendMessage({
        target: "background",
        type: "transcription:start",
        tabId: tab?.id,
      });
    }
    await render();
    if (reply && !reply.ok) statusEl.textContent = reply.error || "Something went wrong.";
  });

  document.getElementById("meeting-settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes[RECORDING_KEY] || changes[TRANSCRIPTION_SETTINGS_KEY])) render();
  });

  render();
})();
