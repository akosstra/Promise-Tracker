/* Reads Google Meet's live captions and keeps a running transcript in chrome.storage.local.
 *
 * Runs only on meet.google.com, and only does anything while a Promise Tracker session is On for this
 * exact meeting. Nothing leaves the browser from here. Follow-ups are pulled out later, on call end
 * (background.js) or from the side panel.
 *
 * IMPORTANT: Meet has no captions API. This reads the caption overlay from the page, and Google can
 * change that markup at any time. Everything that touches Meet's DOM is in the SELECTORS block and in
 * readBlocks(), so a fix should stay small. If captions stop arriving, start there.
 */

const CAPTION_CONFIG = {
  pollMs: 300, // how often the caption overlay is read while a session is on
  settleMs: 1800, // a speaker's caption is treated as finished once it stops changing for this long
  tailWords: 3, // while someone is mid-sentence, the last few words are held back because Meet may still revise them
  mergeGapMs: 8000, // same speaker talking again within this gap continues the same transcript line
  maxLineChars: 600, // ...unless the line is already this long
  writeDebounceMs: 400,
  heartbeatMs: 5000, // how often "still capturing" is refreshed for the side panel
};

const CAPTION_SELECTORS = {
  // The overlay container. aria-label is English; the jsname is Meet's own hook and the fallback.
  region: ['[role="region"][aria-label*="aption" i]', '[jsname="dsyhDe"]'],
  captionsOffButton: 'button[aria-label*="Turn on captions" i]',
  captionsOnButton: 'button[aria-label*="Turn off captions" i]',
  // Controls that can sit inside the overlay and must not be read as speech.
  ignore: "button, [role='button'], select, [role='listbox'], [role='menu'], [role='tooltip']",
};

/* ---------- Pure logic (no DOM; exercised by the tests) ---------- */

function squashSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/* What has been added to a speaker's caption since we last saved it?
 * Meet grows a caption in place, scrolls old words off the front, and now and then corrects a word. */
function newCaptionText(committed, current) {
  const before = squashSpaces(committed);
  const text = squashSpaces(current);
  if (!text || text === before) return "";
  if (!before) return text;

  // Normal case: it just grew.
  if (text.startsWith(before)) return text.slice(before.length).trim();

  // Old words scrolled off the front: the tail of what we saved is the head of what's there now.
  for (let n = Math.min(before.length, text.length); n >= 8; n -= 1) {
    if (before.endsWith(text.slice(0, n))) return text.slice(n).trim();
  }

  // Earlier words were corrected in place. Keep what we saved and take only what lies beyond it.
  let common = 0;
  while (common < before.length && common < text.length && before[common] === text[common]) common += 1;
  if (common >= before.length * 0.5 && text.length > before.length) {
    let rest = text.slice(before.length);
    if (!/\s/.test(text[before.length - 1]) && !/^\s/.test(rest)) rest = rest.replace(/^\S*/, ""); // drop a half word
    return rest.trim();
  }

  // Something unrelated, such as a new caption block from the same person after a pause.
  return text;
}

/* Adds a finished piece of speech to the transcript, continuing the previous line when it's the same person. */
function appendCaption(lines, speaker, text, now, config = CAPTION_CONFIG) {
  const clean = squashSpaces(text);
  if (!clean) return false;

  const last = lines[lines.length - 1];
  if (last && last.speaker === speaker) {
    if (clean.length >= 20 && last.text.endsWith(clean)) return false; // Meet re-showed something we already have
    if (now - last.end <= config.mergeGapMs && last.text.length < config.maxLineChars) {
      last.text = `${last.text} ${clean}`;
      last.end = now;
      return true;
    }
  }
  lines.push({ at: now, end: now, speaker, text: clean });
  return true;
}

/* ---------- Reading Meet's page ---------- */

function findRegion() {
  for (const selector of CAPTION_SELECTORS.region) {
    const node = document.querySelector(selector);
    if (node) return node;
  }
  return null;
}

/* Text-bearing leaf elements inside a node, in reading order, skipping controls. */
function textLeaves(node) {
  const leaves = [];
  for (const el of node.querySelectorAll("*")) {
    if (el.children.length || el.closest(CAPTION_SELECTORS.ignore)) continue;
    const text = squashSpaces(el.textContent);
    if (text) leaves.push(text);
  }
  return leaves;
}

/* One entry per speaker currently on screen: [{ speaker, text }].
 * Each caption block is "avatar, name, then what they said". Blocks are found from the avatar image, which
 * survives Meet's changing class names far better than anything else. If there are no avatars, fall back to
 * the structure of the overlay. */
function readBlocks(region) {
  const blocks = [];
  const add = (node) => {
    const leaves = textLeaves(node);
    if (leaves.length >= 2) blocks.push({ speaker: leaves[0], text: leaves.slice(1).join(" ") });
  };

  const avatars = [...region.querySelectorAll("img")];
  if (avatars.length) {
    const seen = new Set();
    for (const img of avatars) {
      // Climb to the biggest element that still holds only this one avatar.
      let node = img;
      while (node.parentElement && node.parentElement !== region && node.parentElement.querySelectorAll("img").length === 1) {
        node = node.parentElement;
      }
      if (node === img) node = img.parentElement;
      if (!node || seen.has(node)) continue;
      seen.add(node);
      add(node);
    }
  } else {
    // No avatars: look for the shape of a caption block, "a name element, then the words". Searching from the top
    // down means a whole block is always matched before any part of it can be mistaken for one.
    const looksLikeBlock = (node) => {
      const kids = [...node.children].filter((kid) => !kid.matches(CAPTION_SELECTORS.ignore));
      if (kids.length < 2) return false;
      return textLeaves(kids[0]).length === 1 && kids.slice(1).some((kid) => textLeaves(kid).length >= 1);
    };
    const walk = (node, depth) => {
      if (depth > 6) return;
      if (looksLikeBlock(node)) {
        add(node);
        return;
      }
      for (const kid of node.children) if (!kid.matches(CAPTION_SELECTORS.ignore)) walk(kid, depth + 1);
    };
    walk(region, 0);
  }

  // Two blocks for one speaker on screen at once: keep the longer.
  const bySpeaker = new Map();
  for (const block of blocks) {
    const existing = bySpeaker.get(block.speaker);
    if (!existing || block.text.length >= existing.text.length) bySpeaker.set(block.speaker, block);
  }
  return [...bySpeaker.values()];
}

/* ---------- Session state ---------- */

let active = false;
let sessionStartedAt = null;
let live = emptyLive();
const speakers = new Map(); // name -> { text, committed, timer }
let pollId = null;
let writeId = null;
let triedEnable = false;
let status = { state: "", at: 0 };
let warnedNoBlocks = false;

function pageKey(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return "";
  }
}

function isThisMeeting(session) {
  return Boolean(session?.active && session.url && pageKey(session.url) === pageKey(location.href));
}

function scheduleWrite() {
  clearTimeout(writeId);
  writeId = setTimeout(writeNow, CAPTION_CONFIG.writeDebounceMs);
}

async function writeNow() {
  clearTimeout(writeId);
  live.updatedAt = Date.now();
  try {
    await chrome.storage.local.set({ [LIVE_KEY]: live });
  } catch (error) {
    console.warn("[Promise Tracker] could not save the transcript", error);
  }
}

function setStatus(state) {
  const now = Date.now();
  if (state === status.state && now - status.at < CAPTION_CONFIG.heartbeatMs) return;
  status = { state, at: now };
  chrome.storage.local.set({ [LIVE_STATUS_KEY]: status }).catch(() => {});
}

function commitSpeaker(name) {
  const entry = speakers.get(name);
  if (!entry) return;
  clearTimeout(entry.timer);
  const fresh = newCaptionText(entry.committed, entry.text);
  if (!fresh) return;
  entry.committed = entry.text;
  if (appendCaption(live.lines, name, fresh, Date.now())) scheduleWrite();
}

/* Meet keeps only the last couple of lines on screen, so while someone talks without pausing the start of
 * what they said scrolls away. Save everything except the last few words as it goes, so nothing is lost. */
function commitStable(name) {
  const entry = speakers.get(name);
  if (!entry) return;
  const words = squashSpaces(entry.text).split(" ");
  if (words.length <= CAPTION_CONFIG.tailWords) return;
  const stable = words.slice(0, -CAPTION_CONFIG.tailWords).join(" ");
  const fresh = newCaptionText(entry.committed, stable);
  if (!fresh) return;
  entry.committed = stable;
  if (appendCaption(live.lines, name, fresh, Date.now())) scheduleWrite();
}

function commitAll() {
  for (const name of speakers.keys()) commitSpeaker(name);
}

/* Meet only shows a button to turn captions on once you're in the call. Try once, when it appears. */
function tryEnableCaptions() {
  if (triedEnable) return;
  const button = document.querySelector(CAPTION_SELECTORS.captionsOffButton);
  if (!button) return;
  triedEnable = true;
  button.click();
}

function scan() {
  if (!active) return;

  const region = findRegion();
  if (!region) {
    // No overlay on screen: nobody is talking, or captions are off.
    for (const name of [...speakers.keys()]) {
      commitSpeaker(name);
      speakers.delete(name);
    }
    if (document.querySelector(CAPTION_SELECTORS.captionsOnButton)) setStatus("listening");
    else if (document.querySelector(CAPTION_SELECTORS.captionsOffButton)) {
      tryEnableCaptions();
      setStatus("captions-off");
    } else setStatus("waiting");
    return;
  }

  const blocks = readBlocks(region);
  if (!blocks.length) {
    if (!warnedNoBlocks && region.textContent.trim()) {
      warnedNoBlocks = true;
      console.warn("[Promise Tracker] found Meet's caption area but could not read speakers from it. Meet's markup may have changed.", region);
    }
    setStatus("listening");
    return;
  }

  setStatus("capturing");
  const now = new Set();
  for (const block of blocks) {
    now.add(block.speaker);
    let entry = speakers.get(block.speaker);
    if (!entry) {
      entry = { text: "", committed: "", timer: null };
      speakers.set(block.speaker, entry);
    }
    if (entry.text !== block.text) {
      entry.text = block.text;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => commitSpeaker(block.speaker), CAPTION_CONFIG.settleMs);
      commitStable(block.speaker);
    }
  }

  // Someone's caption left the screen: save what they said and start fresh next time they speak.
  for (const name of [...speakers.keys()]) {
    if (now.has(name)) continue;
    commitSpeaker(name);
    speakers.delete(name);
  }
}

/* ---------- Start and stop with the session ---------- */

async function begin(session) {
  active = true;
  triedEnable = false;
  warnedNoBlocks = false;
  speakers.clear();

  // After a page reload mid-call, carry on from what was already saved.
  const stored = await getLiveTranscript();
  if (stored.sessionStartedAt === session.startedAt) {
    live = stored;
  } else {
    live = emptyLive(session.startedAt);
    await writeNow();
  }
  sessionStartedAt = session.startedAt;

  clearInterval(pollId);
  pollId = setInterval(scan, CAPTION_CONFIG.pollMs);
  scan();
}

async function end() {
  active = false;
  clearInterval(pollId);
  pollId = null;
  commitAll();
  speakers.clear();
  await writeNow();
  status = { state: "idle", at: Date.now() };
  chrome.storage.local.set({ [LIVE_STATUS_KEY]: status }).catch(() => {});
}

async function applySession(session) {
  const shouldRun = isThisMeeting(session);
  if (shouldRun && (!active || session.startedAt !== sessionStartedAt)) {
    if (active) await end();
    await begin(session);
  } else if (!shouldRun && active) {
    await end();
  }
}

if (typeof chrome !== "undefined" && chrome.storage?.local && typeof document !== "undefined") {
  chrome.storage.local.get(SESSION_KEY).then((data) => applySession({ ...idleSession(), ...(data[SESSION_KEY] || {}) }));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SESSION_KEY]) {
      applySession({ ...idleSession(), ...(changes[SESSION_KEY].newValue || {}) });
    }
  });
  window.addEventListener("pagehide", () => {
    if (!active) return;
    commitAll();
    live.updatedAt = Date.now();
    chrome.storage.local.set({ [LIVE_KEY]: live });
  });
}

// Test hook. Harmless in the browser.
if (typeof globalThis !== "undefined") globalThis.__ptCaptions = { newCaptionText, appendCaption, readBlocks, CAPTION_CONFIG };
