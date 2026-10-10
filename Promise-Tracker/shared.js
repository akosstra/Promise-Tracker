const STORAGE_KEY = "promises";
const SESSION_KEY = "session";
const SETTINGS_KEY = "settings";
const DRAFT_KEY = "transcriptDraft";
const CHECK_BELOW = 0.65;

// Live captions (Google Meet). The content script is the only writer of these three keys while a call is on.
const LIVE_KEY = "liveTranscript"; // { sessionStartedAt, lines: [{ at, end, speaker, text }], updatedAt }
const LIVE_STATUS_KEY = "captionStatus"; // { state, at } so the side panel can say what the Meet tab is doing
const LIVE_RESULT_KEY = "liveResult"; // outcome of the automatic follow-up pass when a call ends
const MEET_SELF_LABEL = "You"; // how Meet labels your own captions
const SELF_FALLBACK_NAME = "Me"; // used for "You" when no name is set, so the extractor can tell your lines apart

const Status = {
  OPEN: "open",
  KEPT: "kept",
  BROKEN: "broken",
};

function idleSession() {
  return {
    active: false,
    startedAt: null,
    endedAt: null,
    tabId: null,
    title: "",
    url: "",
    notes: "",
  };
}

function dueAtFromDateInput(value) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
}

function dateInputFromDueAt(dueAt) {
  if (!dueAt) return "";
  const date = new Date(dueAt);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function isOverdue(promise) {
  return promise.status === Status.OPEN && promise.dueAt != null && promise.dueAt < Date.now();
}

function countByStatus(promises) {
  return promises.reduce(
    (counts, promise) => {
      counts[promise.status] += 1;
      if (isOverdue(promise)) counts.overdue += 1;
      return counts;
    },
    { open: 0, kept: 0, broken: 0, overdue: 0 },
  );
}

function createPromise({
  text,
  title,
  url,
  dueAt,
  source,
  sessionStartedAt,
  kind,
  owner,
  who,
  quote,
  context,
  duePhrase,
  confidence,
  transcriptHash,
}) {
  const item = {
    id: crypto.randomUUID(),
    text: String(text || "").trim(),
    title: title || "Untitled meeting",
    url: url || "",
    createdAt: Date.now(),
    dueAt: dueAt ?? null,
    status: Status.OPEN,
    source: source || "manual",
    sessionStartedAt: sessionStartedAt ?? null,
  };
  // Optional fields, only set for items found in a transcript
  if (kind) item.kind = kind;
  if (owner) item.owner = owner;
  if (who) item.who = who;
  if (quote) item.quote = quote;
  if (context) item.context = context;
  if (duePhrase) item.duePhrase = duePhrase;
  if (typeof confidence === "number") item.confidence = confidence;
  if (transcriptHash) item.transcriptHash = transcriptHash;
  return item;
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/* Adds several promises in one write. Items already saved from the same transcript are skipped,
 * so running the same transcript twice does not duplicate the list. */
async function addPromises(partials) {
  const existing = await getPromises();
  const seen = new Set();
  for (const promise of existing) {
    if (promise.transcriptHash) seen.add(`${promise.transcriptHash}|${normalizeKey(promise.quote || promise.text)}`);
  }

  const added = [];
  let skipped = 0;
  for (const partial of partials) {
    const item = createPromise(partial);
    if (!item.text) continue;
    const key = `${item.transcriptHash || ""}|${normalizeKey(item.quote || item.text)}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    added.push(item);
  }

  if (added.length) await setPromises([...added, ...existing]);
  return { added, skipped };
}

function defaultSettings() {
  return { yourName: "", useAI: false, apiKey: "" };
}

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...defaultSettings(), ...(data[SETTINGS_KEY] || {}) };
}

async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

const KIND_LABELS = { promise: "Promise", circle_back: "Circle back", waiting_on: "Waiting on" };
const KIND_CLASSES = { promise: "promise", circle_back: "circle", waiting_on: "waiting" };

/* Small tag row under a follow-up: what kind it is, who, due wording. Empty for items added by hand. */
function promiseMetaHtml(promise) {
  const bits = [];
  if (KIND_LABELS[promise.kind]) {
    const who = promise.who ? ` · ${escapeHtml(promise.who)}` : "";
    bits.push(`<span class="tag ${KIND_CLASSES[promise.kind]}">${KIND_LABELS[promise.kind]}${who}</span>`);
  }
  if (typeof promise.confidence === "number" && promise.confidence < CHECK_BELOW) {
    bits.push(`<span class="tag maybe" title="Low confidence. Check this one.">Check</span>`);
  }
  if (promise.duePhrase) {
    bits.push(`<span class="due ${isOverdue(promise) ? "late" : ""}">${escapeHtml(promise.duePhrase)}</span>`);
  }
  return bits.length ? `<div class="todo-meta">${bits.join("")}</div>` : "";
}

/* The wording from the call, shown only when it adds something beyond the summary. */
function promiseDetailHtml(promise) {
  let detail = "";
  if (promise.quote && promise.quote !== promise.text) detail = `“${promise.quote}”`;
  else if (promise.context) detail = `After: “${promise.context}”`;
  return detail ? `<p class="todo-detail">${escapeHtml(detail)}</p>` : "";
}

async function getPromises() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function setPromises(promises) {
  await chrome.storage.local.set({ [STORAGE_KEY]: promises });
}

async function addPromise(partial) {
  const item = createPromise(partial);
  if (!item.text) return null;
  const promises = await getPromises();
  promises.unshift(item);
  await setPromises(promises);
  return item;
}

async function updatePromise(id, patch) {
  const promises = await getPromises();
  const next = promises.map((promise) => (promise.id === id ? { ...promise, ...patch } : promise));
  await setPromises(next);
  return next.find((promise) => promise.id === id) || null;
}

async function deletePromise(id) {
  const promises = (await getPromises()).filter((promise) => promise.id !== id);
  await setPromises(promises);
}

async function getSession() {
  const data = await chrome.storage.local.get(SESSION_KEY);
  return { ...idleSession(), ...(data[SESSION_KEY] || {}) };
}

async function setSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  return session;
}

async function startListening(tab) {
  const session = {
    active: true,
    startedAt: Date.now(),
    endedAt: null,
    tabId: tab?.id ?? null,
    title: tab?.title || "This meeting",
    url: tab?.url || "",
    notes: "",
  };
  // One write, so the Meet tab never sees a new session next to the previous call's transcript.
  await chrome.storage.local.set({
    [SESSION_KEY]: session,
    [LIVE_KEY]: emptyLive(session.startedAt),
    [LIVE_STATUS_KEY]: { state: "waiting", at: Date.now() },
    [LIVE_RESULT_KEY]: null,
  });
  return session;
}

async function stopListening() {
  const session = await getSession();
  return setSession({
    ...session,
    active: false,
    endedAt: Date.now(),
  });
}

/* ---------- Live captions ---------- */

function emptyLive(sessionStartedAt = null) {
  return { sessionStartedAt, lines: [], updatedAt: 0 };
}

async function getLiveTranscript() {
  const data = await chrome.storage.local.get(LIVE_KEY);
  const live = data[LIVE_KEY];
  return live && Array.isArray(live.lines) ? live : emptyLive();
}

function isMeetUrl(url) {
  return /^https:\/\/meet\.google\.com\//i.test(url || "");
}

/* Speaker names go in front of a colon, so the colon and line breaks can't appear inside one. */
function cleanSpeaker(name, yourName) {
  const raw = String(name || "").replace(/[:\n\r\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) return "Unknown";
  if (raw === MEET_SELF_LABEL) return (yourName || "").trim() || SELF_FALLBACK_NAME;
  return raw;
}

/* "[0:42] Priya: I'll send that over." One line per turn, the same shape the pasted-transcript parser reads. */
function formatLiveTranscript(live, { yourName = "" } = {}) {
  return (live?.lines || [])
    .map((line) => `[${formatElapsed(live.sessionStartedAt, line.at)}] ${cleanSpeaker(line.speaker, yourName)}: ${line.text}`)
    .join("\n");
}

/* Turns a captured call into follow-ups. Needs extract.js loaded alongside (side panel and background both do).
 * Items carry transcriptHash "live-<start>", so running this mid-call and again at the end never duplicates. */
async function followUpsFromLive(live, session) {
  const settings = await getSettings();
  const transcript = formatLiveTranscript(live, { yourName: settings.yourName });
  if (!transcript.trim()) return { empty: true, added: [], skipped: 0, found: 0, note: "" };

  const you = settings.yourName.trim() || SELF_FALLBACK_NAME;
  let found;
  let note = "";
  if (settings.useAI && settings.apiKey) {
    try {
      found = await extractWithAI(transcript, { ...settings, yourName: you });
    } catch (error) {
      note = `Claude was unavailable (${error.message}), so phrase matching was used instead.`;
      found = extractLocal(transcript, { yourName: you });
    }
  } else {
    found = extractLocal(transcript, { yourName: you });
  }

  const sameCall = session && session.startedAt === live.sessionStartedAt;
  const hash = `live-${live.sessionStartedAt}`;
  const { added, skipped } = await addPromises(
    found.map((item) => ({
      text: item.summary,
      quote: item.quote,
      context: item.context,
      kind: item.kind,
      owner: item.owner,
      who: item.who,
      duePhrase: item.duePhrase,
      dueAt: item.dueAt,
      confidence: item.confidence,
      title: sameCall ? session.title : "Live captions",
      url: sameCall ? session.url : "",
      source: "live-captions",
      sessionStartedAt: live.sessionStartedAt,
      transcriptHash: hash,
    })),
  );
  return { empty: false, added, skipped, found: found.length, note };
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function sortPromises(promises) {
  return [...promises].sort((a, b) => {
    const aOpen = a.status === Status.OPEN ? 0 : 1;
    const bOpen = b.status === Status.OPEN ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;

    const aOverdue = isOverdue(a) ? 0 : 1;
    const bOverdue = isOverdue(b) ? 0 : 1;
    if (aOverdue !== bOverdue) return aOverdue - bOverdue;

    const aDue = a.dueAt ?? Number.MAX_SAFE_INTEGER;
    const bDue = b.dueAt ?? Number.MAX_SAFE_INTEGER;
    if (aDue !== bDue) return aDue - bDue;

    return b.createdAt - a.createdAt;
  });
}

function formatDue(dueAt) {
  if (!dueAt) return "No due date";
  const date = new Date(dueAt);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatCaptured(createdAt) {
  return new Date(createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatElapsed(startedAt, now = Date.now()) {
  if (!startedAt) return "0:00";
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function meetingLabel(session, tab) {
  const title = session?.title || tab?.title || "";
  if (/meet\.google|zoom\.us|teams\.microsoft|webex/i.test(session?.url || tab?.url || "") || /meet|zoom|teams|call|sync/i.test(title)) {
    return title.replace(/\s*[|–—-]\s*(Google Meet|Zoom|Microsoft Teams).*$/i, "") || title;
  }
  return title || "This tab";
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function getActiveTab() {
  if (!chrome.tabs?.query) return { id: null, title: "This meeting", url: "" };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || { id: null, title: "This meeting", url: "" };
}

(function installPreviewChrome() {
  if (globalThis.chrome?.storage?.local) return;

  const memory = {
    promises: [],
    session: idleSession(),
  };
  const listeners = [];

  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return { [key]: memory[key] };
          return { ...memory };
        },
        async set(patch) {
          const changes = {};
          for (const [key, value] of Object.entries(patch)) {
            changes[key] = { oldValue: memory[key], newValue: value };
            memory[key] = value;
          }
          listeners.forEach((fn) => fn(changes, "local"));
        },
      },
      onChanged: {
        addListener(fn) {
          listeners.push(fn);
        },
      },
    },
    tabs: {
      async query() {
        return [{ id: 1, title: "Weekly product sync — Google Meet", url: "https://meet.google.com/abc-defg-hij" }];
      },
    },
    sidePanel: {
      async open() {},
    },
  };
})();
