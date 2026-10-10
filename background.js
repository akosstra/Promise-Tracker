importScripts("shared.js", "transcripts.js");

const MENU_SAVE = "save-promise";
const MENU_OPEN = "open-inbox";
const BADGE_ALARM = "refresh-badge";
const OFFSCREEN_URL = "offscreen.html";

async function updateBadge() {
  const [promises, recording] = await Promise.all([getPromises(), getRecording()]);
  const overdue = countByStatus(promises).overdue;
  // While a meeting is being transcribed the badge reads REC so it's never silent.
  await chrome.action.setBadgeBackgroundColor({ color: recording ? "#dc2626" : "#9f1239" });
  try {
    await chrome.action.setBadgeTextColor({ color: "#fff7ed" });
  } catch {
    /* Chrome 109 and below */
  }
  await chrome.action.setBadgeText({ text: recording ? "REC" : overdue > 0 ? String(overdue) : "" });
}

async function openInbox(tab) {
  if (!tab?.id) return;
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    console.warn("Could not open side panel", error);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SAVE,
      title: "Save as promise",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: MENU_OPEN,
      title: "Open Promise Tracker",
      contexts: ["page", "action"],
    });
  });

  await chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 30 });
  await clearStaleRecording();
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await clearStaleRecording();
  await updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM) updateBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STORAGE_KEY] || changes[RECORDING_KEY])) updateBadge();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_OPEN) {
    await openInbox(tab);
    return;
  }

  if (info.menuItemId !== MENU_SAVE) return;

  const text = (info.selectionText || "").trim();
  if (!text) return;

  await addPromise({
    text,
    title: tab?.title,
    url: info.pageUrl || tab?.url,
    source: "selection",
  });

  await openInbox(tab);
});

// ---- Meeting transcription -------------------------------------------------

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Capture meeting tab audio so it can be transcribed.",
  });
}

async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* nothing open */
  }
}

// A browser restart or extension reload destroys the offscreen document, so
// any saved recording state is stale.
async function clearStaleRecording() {
  const recording = await getRecording();
  if (!recording) return;
  await endTranscript(recording.sessionId, "Recording was interrupted.");
  await clearRecording();
}

let startingTranscription = false;

async function startTranscription(tabId) {
  if (startingTranscription) return { ok: false, error: "Already starting." };
  startingTranscription = true;
  let session = null;
  try {
    const settings = await getTranscriptionSettings();
    if (!isTranscriptionConfigured(settings)) {
      return { ok: false, error: "Set up transcription in Settings first." };
    }
    if (await getRecording()) return { ok: false, error: "Already transcribing a tab." };
    if (!tabId) return { ok: false, error: "No active tab to listen to." };

    const tab = await chrome.tabs.get(tabId);
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreen();
    session = await startTranscript({ title: tab.title, url: tab.url });

    const reply = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "start",
      streamId,
      sessionId: session.id,
      settings: {
        endpoint: settings.endpoint,
        apiKey: settings.apiKey,
        model: settings.model,
        language: settings.language,
        chunkSeconds: settings.chunkSeconds,
      },
      includeMic: Boolean(settings.includeMic),
    });
    if (!reply?.ok) throw new Error(reply?.error || "Could not start audio capture.");

    await setRecording({
      sessionId: session.id,
      tabId,
      title: tab.title || "this tab",
      startedAt: Date.now(),
      error: null,
      warning: reply.warning || null,
    });
    return { ok: true };
  } catch (error) {
    if (session) await deleteTranscript(session.id);
    await closeOffscreen();
    return { ok: false, error: error?.message || String(error) };
  } finally {
    startingTranscription = false;
  }
}

async function stopTranscription(error = null) {
  const recording = await getRecording();
  if (!recording) {
    await closeOffscreen();
    return { ok: true };
  }
  try {
    // Resolves after the offscreen document has flushed and delivered its last chunk.
    await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
  } catch {
    /* offscreen document already gone */
  }
  await endTranscript(recording.sessionId, error);
  await clearRecording();
  await closeOffscreen();
  return { ok: true };
}

async function handleMessage(message) {
  switch (message.type) {
    case "transcription:start":
      return startTranscription(message.tabId);
    case "transcription:stop":
      return stopTranscription();
    case "transcription:segment": {
      await appendSegment(message.sessionId, { text: message.text, at: message.at, speaker: message.speaker });
      const recording = await getRecording();
      if (recording?.error) await setRecording({ ...recording, error: null });
      return { ok: true };
    }
    case "transcription:error": {
      const recording = await getRecording();
      if (recording?.sessionId === message.sessionId) {
        await setRecording({ ...recording, error: message.error });
      }
      return { ok: true };
    }
    case "transcription:ended":
      return stopTranscription(message.error || null);
    default:
      return { ok: false, error: "Unknown message." };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "background") return;
  handleMessage(message).then(sendResponse, (error) =>
    sendResponse({ ok: false, error: error?.message || String(error) }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const recording = await getRecording();
  if (recording?.tabId === tabId) await stopTranscription();
});

updateBadge();
