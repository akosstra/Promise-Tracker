# Promise Tracker

Chrome extension (Manifest V3) that captures commitments as you browse, then tracks whether they were kept.

## What it does

- **Save selected text** via right-click → *Save as promise* (stores quote, page title, URL, time)
- **Popup** for a quick add, due date, and the next open items
- **Side panel inbox** with Open / Kept / Broken, due dates, delete, and JSON export
- **Overdue badge** on the toolbar icon (open promises past their due date)
- **On-page suggestions** for lines that look like commitments (`I will`, `we commit`, `by Friday`, …)
- **Meeting transcription** (opt-in): transcribe a meeting tab live and save detected commitments as promises

Everything is stored locally in `chrome.storage.local`. Nothing is sent to a server, except audio chunks when you turn on meeting transcription (see below).

## Load it in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this repository folder (the one that contains `manifest.json`)

Pin the extension, then:

- Highlight text on any http(s) page and right-click **Save as promise**
- Click the toolbar icon to add a promise from the current tab
- In the popup, use **Open inbox** for the full side panel

## Meeting transcription

1. Open the extension's **Settings** (popup → *Settings*) and enter an OpenAI-compatible transcription endpoint, API key and model. A local server such as `http://localhost:8000/v1/audio/transcriptions` works too and keeps audio on your machine.
2. Tick the consent box and save. Transcription stays off until you do.
3. Open the meeting tab (Meet, Teams, Zoom web, …), click the toolbar icon, then **Transcribe this tab**. The badge shows `REC` while listening.
4. Open the side panel: a **Meetings** section shows the live transcript. Lines that look like commitments get a **Save as promise** button, so nothing is added without your confirmation.

How it works: the service worker asks `chrome.tabCapture` for a stream ID, and an offscreen document records the tab audio in short chunks (default 15 s), skips silent ones, and posts the rest to your endpoint. Transcripts are stored in `chrome.storage.local` (newest 50 kept).

Notes:

- By default it captures **tab audio** (the other participants). Turn on **Also transcribe my microphone** in Settings to capture your own voice too; Chrome asks for microphone permission when you tick it. Lines are then labelled **You** / **Others**.
- Use headphones with the mic on, otherwise the call can leak from your speakers into your mic and show up twice.
- Microphone audio is sent to the same endpoint as the tab audio, in separate chunks, so usage roughly doubles while you and others both speak.
- Start it from the popup: `tabCapture` needs the extension to be invoked on the tab.
- Tell participants before recording. Many jurisdictions require consent.
- The API key is stored unencrypted in `chrome.storage.local`.

## Statuses

| Status | Meaning |
| --- | --- |
| Open | Still outstanding |
| Kept | Followed through |
| Broken | Not honored |

Optional due dates use the end of the selected local day. The badge counts only **open + overdue** items.

## Next ideas

- Reminders via `chrome.alarms` notifications
- Per-participant speaker labels (today it is only You / Others)
- Better extraction (who / deadline) with a confirm step
- Sync later, if you want a shared list
