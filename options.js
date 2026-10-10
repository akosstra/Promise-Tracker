const settingsForm = document.getElementById("settings-form");
const settingsStatusEl = document.getElementById("settings-status");
const settingsFields = {
  endpoint: document.getElementById("endpoint"),
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  language: document.getElementById("language"),
  chunkSeconds: document.getElementById("chunkSeconds"),
  consent: document.getElementById("consent"),
  includeMic: document.getElementById("includeMic"),
};

function showSettingsStatus(message) {
  settingsStatusEl.textContent = message;
}

async function loadSettings() {
  const settings = await getTranscriptionSettings();
  settingsFields.endpoint.value = settings.endpoint;
  settingsFields.apiKey.value = settings.apiKey;
  settingsFields.model.value = settings.model;
  settingsFields.language.value = settings.language;
  settingsFields.chunkSeconds.value = settings.chunkSeconds;
  settingsFields.consent.checked = settings.consent;
  settingsFields.includeMic.checked = settings.includeMic;
}

// Offscreen documents can't show permission prompts, so the mic permission is
// requested here, on an extension page, where Chrome can show it. The grant
// applies to the whole extension origin, including the offscreen document.
settingsFields.includeMic.addEventListener("change", async () => {
  if (!settingsFields.includeMic.checked) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    showSettingsStatus("Microphone access granted. Save to apply.");
  } catch {
    settingsFields.includeMic.checked = false;
    showSettingsStatus(
      "Microphone access was blocked. Allow it for this extension in Chrome’s site settings (lock icon in the address bar), then tick the box again.",
    );
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const endpoint = settingsFields.endpoint.value.trim();
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    showSettingsStatus("Enter a full endpoint URL, for example https://api.openai.com/v1/audio/transcriptions.");
    return;
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    showSettingsStatus("Use https. Plain http is only allowed for localhost.");
    return;
  }

  await saveTranscriptionSettings({
    endpoint,
    apiKey: settingsFields.apiKey.value.trim(),
    model: settingsFields.model.value.trim() || DEFAULT_TRANSCRIPTION_SETTINGS.model,
    language: settingsFields.language.value.trim().toLowerCase(),
    chunkSeconds: Math.min(60, Math.max(5, Number(settingsFields.chunkSeconds.value) || 15)),
    consent: settingsFields.consent.checked,
    includeMic: settingsFields.includeMic.checked,
  });
  showSettingsStatus(
    settingsFields.consent.checked
      ? "Saved. Open a meeting tab and use the popup to start."
      : "Saved. Transcription stays off until you tick the box above.",
  );
});

loadSettings();
