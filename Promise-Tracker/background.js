importScripts("shared.js", "extract.js");

const MENU_SAVE = "save-promise";
const MENU_OPEN = "open-inbox";
const BADGE_ALARM = "refresh-badge";
const FLUSH_WAIT_MS = 2500; // after Off, give the Meet tab time to save the last caption before reading the transcript

async function updateBadge() {
  const [session, promises] = await Promise.all([getSession(), getPromises()]);
  try {
    await chrome.action.setBadgeTextColor({ color: "#fff7ed" });
  } catch {
    /* Chrome 109 and below */
  }

  if (session.active) {
    await chrome.action.setBadgeBackgroundColor({ color: "#0f5f56" });
    await chrome.action.setBadgeText({ text: "ON" });
    return;
  }

  const overdue = countByStatus(promises).overdue;
  await chrome.action.setBadgeBackgroundColor({ color: "#9f1239" });
  await chrome.action.setBadgeText({ text: overdue > 0 ? String(overdue) : "" });
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
  await updateBadge();
});

chrome.runtime.onStartup.addListener(updateBadge);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM) updateBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STORAGE_KEY] || changes[SESSION_KEY])) updateBadge();
});

/* When a call ends, turn what Meet's captions gave us into follow-ups, even if the side panel is closed. */
async function finalizeLiveSession(session) {
  await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS));

  const live = await getLiveTranscript();
  if (live.sessionStartedAt !== session.startedAt || !live.lines.length) return; // not a Meet call, or nothing was said

  let result;
  try {
    const outcome = await followUpsFromLive(live, session);
    result = {
      sessionStartedAt: session.startedAt,
      at: Date.now(),
      added: outcome.added.length,
      skipped: outcome.skipped,
      found: outcome.found,
      note: outcome.note,
    };
  } catch (error) {
    result = { sessionStartedAt: session.startedAt, at: Date.now(), error: error.message };
  }
  await chrome.storage.local.set({ [LIVE_RESULT_KEY]: result });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[SESSION_KEY]) return;
  const { oldValue, newValue } = changes[SESSION_KEY];
  const ended = oldValue?.active && (!newValue?.active || newValue.startedAt !== oldValue.startedAt);
  if (ended) finalizeLiveSession(oldValue).catch((error) => console.warn("Could not process the call transcript", error));
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

updateBadge();
