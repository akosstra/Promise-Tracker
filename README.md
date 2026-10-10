# Promise Tracker

Chrome extension (Manifest V3) that captures commitments as you browse, then tracks whether they were kept.

## What it does

- **Save selected text** via right-click → *Save as promise* (stores quote, page title, URL, time)
- **Popup** for a quick add, due date, and the next open items
- **Side panel inbox** with Open / Kept / Broken, due dates, delete, and JSON export
- **Overdue badge** on the toolbar icon (open promises past their due date)
- **On-page suggestions** for lines that look like commitments (`I will`, `we commit`, `by Friday`, …)

Everything is stored locally in `chrome.storage.local`. Nothing is sent to a server.

## Load it in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this repository folder (the one that contains `manifest.json`)

Pin the extension, then:

- Highlight text on any http(s) page and right-click **Save as promise**
- Click the toolbar icon to add a promise from the current tab
- In the popup, use **Open inbox** for the full side panel

## Statuses

| Status | Meaning |
| --- | --- |
| Open | Still outstanding |
| Kept | Followed through |
| Broken | Not honored |

Optional due dates use the end of the selected local day. The badge counts only **open + overdue** items.

## Next ideas

- Reminders via `chrome.alarms` notifications
- Better extraction (who / deadline) with a confirm step
- Sync later, if you want a shared list
