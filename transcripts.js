// Storage helpers for meeting transcription. Load after shared.js.
// Used by: background.js (importScripts), popup, side panel, options page.

const TRANSCRIPTS_KEY = "transcripts";
const RECORDING_KEY = "recording";
const TRANSCRIPTION_SETTINGS_KEY = "transcriptionSettings";
const MAX_TRANSCRIPTS = 50;

const DEFAULT_TRANSCRIPTION_SETTINGS = {
  consent: false,
  // Any OpenAI-compatible /audio/transcriptions endpoint works (hosted or local).
  endpoint: "https://api.openai.com/v1/audio/transcriptions",
  apiKey: "",
  model: "whisper-1",
  language: "",
  chunkSeconds: 15,
  includeMic: false,
};

// navigator.locks is shared across every extension context, so the service
// worker, side panel and popup can't clobber each other's read-modify-write.
function withTranscriptLock(task) {
  return navigator.locks.request("promise-tracker-transcripts", task);
}

async function getTranscriptionSettings() {
  const data = await chrome.storage.local.get(TRANSCRIPTION_SETTINGS_KEY);
  return { ...DEFAULT_TRANSCRIPTION_SETTINGS, ...(data[TRANSCRIPTION_SETTINGS_KEY] || {}) };
}

async function saveTranscriptionSettings(settings) {
  await chrome.storage.local.set({
    [TRANSCRIPTION_SETTINGS_KEY]: { ...DEFAULT_TRANSCRIPTION_SETTINGS, ...settings },
  });
}

function isTranscriptionConfigured(settings) {
  return Boolean(settings && settings.consent && settings.endpoint);
}

async function getTranscripts() {
  const data = await chrome.storage.local.get(TRANSCRIPTS_KEY);
  return Array.isArray(data[TRANSCRIPTS_KEY]) ? data[TRANSCRIPTS_KEY] : [];
}

async function setTranscripts(transcripts) {
  await chrome.storage.local.set({ [TRANSCRIPTS_KEY]: transcripts });
}

function startTranscript({ title, url }) {
  return withTranscriptLock(async () => {
    const session = {
      id: crypto.randomUUID(),
      title: title || "Untitled meeting",
      url: url || "",
      startedAt: Date.now(),
      endedAt: null,
      error: null,
      segments: [],
    };
    const all = await getTranscripts();
    all.unshift(session);
    await setTranscripts(all.slice(0, MAX_TRANSCRIPTS));
    return session;
  });
}

function appendSegment(sessionId, { text, at, speaker }) {
  return withTranscriptLock(async () => {
    const clean = String(text || "").trim();
    if (!clean) return null;
    const all = await getTranscripts();
    const session = all.find((item) => item.id === sessionId);
    if (!session) return null;
    const segment = {
      id: crypto.randomUUID(),
      at: at || Date.now(),
      text: clean,
      speaker: speaker === "you" ? "you" : "others",
      commitments: findCommitments(clean),
    };
    session.segments.push(segment);
    // Tab and mic chunks finish at slightly different times; keep speech in order.
    session.segments.sort((a, b) => a.at - b.at);
    await setTranscripts(all);
    return segment;
  });
}

function endTranscript(sessionId, error = null) {
  return withTranscriptLock(async () => {
    const all = await getTranscripts();
    const session = all.find((item) => item.id === sessionId);
    if (!session) return;
    session.endedAt = session.endedAt || Date.now();
    if (error) session.error = error;
    await setTranscripts(all);
  });
}

function deleteTranscript(sessionId) {
  return withTranscriptLock(async () => {
    const all = await getTranscripts();
    await setTranscripts(all.filter((item) => item.id !== sessionId));
  });
}

async function getRecording() {
  const data = await chrome.storage.local.get(RECORDING_KEY);
  return data[RECORDING_KEY] || null;
}

async function setRecording(state) {
  await chrome.storage.local.set({ [RECORDING_KEY]: state });
}

async function clearRecording() {
  await chrome.storage.local.remove(RECORDING_KEY);
}
