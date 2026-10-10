# Promise Tracker

Chrome extension in the spirit of [Granola](https://www.granola.ai/), but narrower: it only keeps **promises** and **catch-up laters** from a call, then turns them into a checklist.

On **Google Meet** it reads the live captions, builds a transcript as the call goes, and adds the promises and catch-up laters to your list when you switch off. Anywhere else, you can paste a transcript and it pulls the commitments out of that.

## Google Meet live captions

1. Join a Meet call and click the toolbar icon on that tab
2. Flip **On**. The extension tries to switch Meet's captions on for you. If it can't, click the **CC** button in Meet (or press `C`)
3. Open the side panel. **Live captions** shows the transcript building up, with a status pill (Capturing, Captions off, …)
4. Flip **Off** when the call ends. A few seconds later the follow-ups appear in your list. You can also press **Find follow-ups** in the Live captions box at any point mid-call. Running it again later never duplicates items
5. **Copy** or **Download** gives you the transcript as text, one line per turn: `[12:40] Priya: I'll send the pricing by Friday.`

Things to know:

- **It reads the captions Meet shows on your screen.** There's no Meet captions API, so this depends on Meet's page layout, and Google can change that without notice. All of the Meet-specific code is in `meet-captions.js` (`CAPTION_SELECTORS` and `readBlocks`). If captions stop arriving, open DevTools on the Meet tab and look for a `Promise Tracker` warning in the console.
- Captions only exist from the moment they're on. Nothing said earlier can be recovered, and if your organisation has captions disabled there is nothing to read.
- Keep the Meet tab open for the whole call. It's the tab that collects the captions.
- Meet labels your own captions **You**. These become your name from the **Your name** box, or `Me` if you haven't set one. Setting your name is worth doing, because it's how "I'll…" from you is told apart from "I'll…" from someone else.
- The "You" label is matched in English, and the captions button and caption area are found by their English labels first. Other Meet languages may need `meet-captions.js` adjusted.
- Captions stay in this browser (`chrome.storage.local`). The only thing that ever leaves it is the transcript, and only if you've switched on **Use Claude instead**. Let people on the call know you're capturing a transcript, as you would for a recording.
- The transcript from the most recent call is kept until you start the next one.

## Right now

- Click the toolbar icon
- Flip **On** to start a meeting session (red live dot, elapsed time, badge reads `ON`)
- Flip **Off** to end it
- Side panel: notepad, live captions, transcript box, and follow-ups you can check off
- Add catch-ups by hand if you like

## Find follow-ups in a transcript

1. Open the side panel and paste a transcript into **Transcript**
2. Optionally type your name as it appears in the transcript (for example `Priya`). This is how the extension tells your promises from other people's
3. Click **Find follow-ups**

Each item lands in the follow-up list with a tag:

- **Promise**: someone said they would do something ("I'll send the pricing by Friday")
- **Circle back**: a topic was parked ("let's revisit that next week", "we'll look at that later", "put a pin in it")
- **Waiting on**: someone else owes you something ("Sam: I'll get that over to you tomorrow")
- **Check**: low confidence, worth a second look

Due wording such as "by Friday" or "tomorrow" is kept on the item and turned into a due date where it can be.

Works with `Name: text` lines, `[00:12] Name: text` lines, and Zoom/Teams style transcripts where the speaker and timestamp sit on their own line. Plain text with no speaker labels works too, and first-person promises are treated as yours.

Running the same transcript twice does not add duplicates.

### Phrase matching or Claude

By default, matching runs on your device and nothing is uploaded. It handles phrases like *circle back, come back to, get back to you, revisit, follow up, put a pin in, park that, take it offline, I'll / we'll / let me / remind me to*, and skips filler like "we'll see" and general habits like "we usually follow up".

Open **Use Claude instead** in the transcript box, switch it on and add an Anthropic API key to have Claude read the transcript, write a short summary for each item and catch phrasings the matcher misses. In that mode the transcript is sent to Anthropic's API, and the key is stored in this browser only (`chrome.storage.local`). If the call fails, the extension falls back to phrase matching and says so.

The model is set by `DEFAULT_MODEL` at the top of `extract.js`.

## Load it in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this folder (the one with `manifest.json`)
5. Click **Reload** if the extension was already loaded

Pin it, click the icon, and open the side panel.

## Next

- Zoom and Teams captions through the same pipeline
- Run the phrase matcher during the call so follow-ups appear live
- Clean note rewrite after the call
