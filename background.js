importScripts("shared.js");

const MENU_SAVE = "save-promise";
const MENU_OPEN = "open-inbox";
const BADGE_ALARM = "refresh-badge";

async function updateBadge() {
  const promises = await getPromises();
  const overdue = countByStatus(promises).overdue;
  await chrome.action.setBadgeBackgroundColor({ color: "#9f1239" });
  try {
    await chrome.action.setBadgeTextColor({ color: "#fff7ed" });
  } catch {
    /* Chrome 109 and below */
  }
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
  if (area === "local" && changes[STORAGE_KEY]) updateBadge();
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
