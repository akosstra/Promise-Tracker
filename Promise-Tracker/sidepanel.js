const toggle = document.getElementById("listen-toggle");
const sessionTop = document.getElementById("session-top");
const labelEl = document.getElementById("listen-label");
const titleEl = document.getElementById("meeting-title");
const notesEl = document.getElementById("notes");
const hintEl = document.getElementById("notes-hint");
const listEl = document.getElementById("list");
const form = document.getElementById("add-form");
const textEl = document.getElementById("text");

const transcriptEl = document.getElementById("transcript");
const nameEl = document.getElementById("your-name");
const analyzeBtn = document.getElementById("analyze");
const clearBtn = document.getElementById("clear-transcript");
const statusEl = document.getElementById("analyze-status");
const aiToggleEl = document.getElementById("use-ai");
const keyEl = document.getElementById("api-key");
const DEFAULT_STATUS = statusEl.textContent.trim();

const liveBlock = document.getElementById("live-block");
const liveStateEl = document.getElementById("live-state");
const liveFeedEl = document.getElementById("live-feed");
const liveAnalyzeBtn = document.getElementById("live-analyze");
const liveCopyBtn = document.getElementById("live-copy");
const liveDownloadBtn = document.getElementById("live-download");
const liveStatusEl = document.getElementById("live-status");
const STALE_SIGNAL_MS = 20000; // no word from the Meet tab for this long while a call is on

let filter = "open";
let timerId = null;
let notesSaveId = null;
let draftSaveId = null;

function stopTimer() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

function renderSession(session, tab) {
  toggle.checked = Boolean(session.active);
  sessionTop.classList.toggle("on", session.active);
  titleEl.textContent = meetingLabel(session.active ? session : null, tab);
  if (document.activeElement !== notesEl) notesEl.value = session.notes || "";

  if (session.active) {
    labelEl.textContent = `Listening · ${formatElapsed(session.startedAt)}`;
    hintEl.textContent = isMeetUrl(session.url)
      ? "Live session. Captions from this Google Meet call are collected below, and follow-ups are added when you switch off."
      : "Live session. Follow-ups you add now are tied to this call. Live captions only work on Google Meet, so paste a transcript below.";
  } else {
    labelEl.textContent = "Off";
    hintEl.textContent = "Turn listening on in a Google Meet tab to turn its live captions into follow-ups.";
  }
}

function renderList(promises, session) {
  const scoped = session.active
    ? promises.filter(
        (promise) =>
          promise.sessionStartedAt === session.startedAt ||
          (!promise.sessionStartedAt && promise.createdAt >= session.startedAt),
      )
    : promises;

  const visible = sortPromises(scoped).filter((promise) => filter === "all" || promise.status === filter);

  if (!visible.length) {
    listEl.innerHTML = `
      <div class="card empty">
        <h2>${session.active ? "No follow-ups yet" : "Inbox is clear"}</h2>
        <p>${
          session.active
            ? "When someone says “I’ll ping you later” or makes a promise, it will show up here as a checkbox."
            : "Paste a transcript above, turn the meeting switch on, or add a catch-up manually."
        }</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = visible
    .map((promise) => {
      const done = promise.status !== Status.OPEN;
      return `
        <article class="card todo ${done ? "done" : ""}">
          <input class="todo-check" type="checkbox" data-action="toggle" data-id="${promise.id}" ${done ? "checked" : ""} />
          <div class="todo-body">
            <p class="todo-text">${escapeHtml(promise.text)}</p>
            ${promiseMetaHtml(promise)}
            ${promiseDetailHtml(promise)}
          </div>
          <div class="todo-actions">
            <button class="btn small danger" type="button" data-action="delete" data-id="${promise.id}">Delete</button>
          </div>
        </article>
      `;
    })
    .join("");
}

/* ---------- Live captions ---------- */

const LIVE_STATES = {
  capturing: { label: "Capturing", css: "promise", hint: "" },
  listening: { label: "Captions on", css: "promise", hint: "Captions are on. Waiting for someone to speak." },
  "captions-off": {
    label: "Captions off",
    css: "maybe",
    hint: "Turn on captions in Meet (the CC button, or press C). They can't be read until they're on.",
  },
  waiting: { label: "Waiting for Meet", css: "maybe", hint: "Waiting for the Meet tab. Join the call and keep that tab open." },
  stale: { label: "No signal", css: "maybe", hint: "Not hearing from the Meet tab. Is it still open? Reload it if it stays like this." },
  ended: { label: "Call ended", css: "waiting", hint: "" },
};

let liveFeedSignature = "";
let lastLive = emptyLive();

function liveStateFor(session, status) {
  if (!session.active) return "ended";
  if (!status?.state || status.state === "idle") return "waiting";
  if (Date.now() - (status.at || 0) > STALE_SIGNAL_MS) return "stale";
  return status.state;
}

function renderLiveFeed(live, yourName) {
  const signature = `${live.sessionStartedAt}|${live.lines.length}|${live.updatedAt}`;
  if (signature === liveFeedSignature) return;
  liveFeedSignature = signature;

  const nearBottom = liveFeedEl.scrollHeight - liveFeedEl.scrollTop - liveFeedEl.clientHeight < 40;
  liveFeedEl.innerHTML = live.lines.length
    ? live.lines
        .map(
          (line) =>
            `<p><span class="t">${formatElapsed(live.sessionStartedAt, line.at)}</span><span class="who">${escapeHtml(cleanSpeaker(line.speaker, yourName))}</span> ${escapeHtml(line.text)}</p>`,
        )
        .join("")
    : `<p class="empty">Nothing captured yet.</p>`;
  if (nearBottom) liveFeedEl.scrollTop = liveFeedEl.scrollHeight;
}

function renderLive(session, live, status, result, settings) {
  lastLive = live;
  const belongsToCall = live.sessionStartedAt === session.startedAt;
  const show = live.lines.length > 0 || (session.active && isMeetUrl(session.url));
  liveBlock.hidden = !show;
  if (!show) return;

  const stateKey = liveStateFor(session, status);
  const state = LIVE_STATES[stateKey] || LIVE_STATES.waiting;
  liveStateEl.textContent = state.label;
  liveStateEl.className = `tag ${state.css}`;

  renderLiveFeed(live, settings.yourName);

  const hasLines = live.lines.length > 0;
  liveAnalyzeBtn.disabled = !hasLines;
  liveCopyBtn.disabled = !hasLines;
  liveDownloadBtn.disabled = !hasLines;

  // A message from a button press stays up for a few seconds, then the normal status line takes over again.
  if (Number(liveStatusEl.dataset.until || 0) > Date.now()) return;
  let message = session.active ? state.hint : "";
  if (!session.active && result && result.sessionStartedAt === live.sessionStartedAt) {
    message = describeCallResult(result);
  } else if (!session.active && hasLines && !belongsToCall) {
    message = "Transcript from your last call.";
  }
  liveStatusEl.textContent = message;
  liveStatusEl.classList.toggle("error", Boolean(result?.error) && !session.active && belongsToCall);
}

function describeCallResult(result) {
  if (result.error) return `Couldn't add follow-ups from the call: ${result.error}`;
  const note = result.note ? ` ${result.note}` : "";
  if (!result.found) return `Call ended. No promises or catch-up laters found in the transcript.${note}`;
  const noun = result.added === 1 ? "follow-up" : "follow-ups";
  if (!result.added) return `Call ended. All ${result.skipped} were already in your list.${note}`;
  return `Call ended. Added ${result.added} ${noun} from the transcript.${result.skipped ? ` ${result.skipped} were already in your list.` : ""}${note}`;
}

async function refreshLive() {
  const [session, data, settings] = await Promise.all([
    getSession(),
    chrome.storage.local.get([LIVE_KEY, LIVE_STATUS_KEY, LIVE_RESULT_KEY]),
    getSettings(),
  ]);
  const live = data[LIVE_KEY] && Array.isArray(data[LIVE_KEY].lines) ? data[LIVE_KEY] : emptyLive();
  renderLive(session, live, data[LIVE_STATUS_KEY], data[LIVE_RESULT_KEY], settings);
}

function setLiveMessage(message, isError = false) {
  liveStatusEl.dataset.until = String(Date.now() + 6000);
  liveStatusEl.textContent = message;
  liveStatusEl.classList.toggle("error", isError);
}

liveAnalyzeBtn.addEventListener("click", async () => {
  liveAnalyzeBtn.disabled = true;
  setLiveMessage("Finding follow-ups…");
  try {
    const [live, session] = await Promise.all([getLiveTranscript(), getSession()]);
    const outcome = await followUpsFromLive(live, session);
    if (outcome.empty) setLiveMessage("Nothing captured yet.");
    else if (!outcome.found) setLiveMessage(`No promises or catch-up laters found so far.${outcome.note ? ` ${outcome.note}` : ""}`);
    else setLiveMessage(`${describeAdded(outcome.added, outcome.skipped)}${outcome.note ? ` ${outcome.note}` : ""}`);
    filter = "open";
    syncFilterButtons();
    await refresh();
  } catch (error) {
    setLiveMessage(`Something went wrong: ${error.message}`, true);
  } finally {
    liveAnalyzeBtn.disabled = lastLive.lines.length === 0;
  }
});

liveCopyBtn.addEventListener("click", async () => {
  const settings = await getSettings();
  const text = formatLiveTranscript(await getLiveTranscript(), { yourName: settings.yourName });
  try {
    await navigator.clipboard.writeText(text);
    setLiveMessage("Transcript copied.");
  } catch {
    setLiveMessage("Couldn't copy. Use Download instead.", true);
  }
});

liveDownloadBtn.addEventListener("click", async () => {
  const [settings, live, session] = await Promise.all([getSettings(), getLiveTranscript(), getSession()]);
  const stamp = new Date(live.sessionStartedAt || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const name = (session.startedAt === live.sessionStartedAt ? meetingLabel(session, null) : "meeting").replace(/[^\w.-]+/g, "-").slice(0, 40);
  downloadText(`transcript-${name}-${stamp}.txt`, formatLiveTranscript(live, { yourName: settings.yourName }));
});

async function refresh() {
  const [session, promises, tab] = await Promise.all([getSession(), getPromises(), getActiveTab()]);
  renderSession(session, tab);
  renderList(promises, session);
  await refreshLive();

  stopTimer();
  if (session.active) {
    timerId = setInterval(async () => {
      const live = await getSession();
      if (!live.active) {
        stopTimer();
        refresh();
        return;
      }
      labelEl.textContent = `Listening · ${formatElapsed(live.startedAt)}`;
      refreshLive();
    }, 1000);
  }
}

/* ---------- Transcript ---------- */

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function describeAdded(added, skipped) {
  if (!added.length) {
    return skipped ? `Nothing new. All ${skipped} were already in your list from this transcript.` : "Nothing new found.";
  }
  const count = (kind) => added.filter((promise) => promise.kind === kind).length;
  const parts = [];
  if (count("promise")) parts.push(`${count("promise")} ${count("promise") === 1 ? "promise" : "promises"}`);
  if (count("circle_back")) parts.push(`${count("circle_back")} to circle back on`);
  if (count("waiting_on")) parts.push(`${count("waiting_on")} waiting on others`);
  const noun = added.length === 1 ? "follow-up" : "follow-ups";
  return `Added ${added.length} ${noun}: ${parts.join(", ")}.${skipped ? ` ${skipped} already in your list.` : ""}`;
}

function saveSettings() {
  return setSettings({
    yourName: nameEl.value.trim(),
    useAI: aiToggleEl.checked,
    apiKey: keyEl.value.trim(),
  });
}

async function initTranscriptPanel() {
  const [settings, data] = await Promise.all([getSettings(), chrome.storage.local.get(DRAFT_KEY)]);
  nameEl.value = settings.yourName;
  aiToggleEl.checked = settings.useAI;
  keyEl.value = settings.apiKey;
  transcriptEl.value = data[DRAFT_KEY] || "";
  if (settings.useAI) document.querySelector(".ai-settings").open = true;
}

async function analyzeTranscript() {
  const transcript = transcriptEl.value.trim();
  if (!transcript) {
    setStatus("Paste a transcript first.", true);
    return;
  }

  analyzeBtn.disabled = true;
  try {
    const settings = await saveSettings();
    let found;
    let note = "";

    if (settings.useAI && settings.apiKey) {
      setStatus("Asking Claude…");
      try {
        found = await extractWithAI(transcript, settings);
      } catch (error) {
        note = ` Claude was unavailable (${error.message}), so phrase matching was used instead.`;
        found = extractLocal(transcript, { yourName: settings.yourName });
      }
    } else {
      if (settings.useAI) note = " Add an API key to use Claude. Phrase matching was used instead.";
      found = extractLocal(transcript, { yourName: settings.yourName });
    }

    if (!found.length) {
      setStatus(`No promises or catch-up laters found.${note}`);
      return;
    }

    const session = await getSession();
    const hash = hashString(transcript);
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
        title: session.active ? session.title : "Pasted transcript",
        url: session.active ? session.url : "",
        source: "transcript",
        sessionStartedAt: session.active ? session.startedAt : null,
        transcriptHash: hash,
      })),
    );

    filter = "open";
    syncFilterButtons();
    await refresh();
    setStatus(`${describeAdded(added, skipped)}${note}`);
  } catch (error) {
    setStatus(`Something went wrong: ${error.message}`, true);
  } finally {
    analyzeBtn.disabled = false;
  }
}

analyzeBtn.addEventListener("click", analyzeTranscript);

clearBtn.addEventListener("click", async () => {
  transcriptEl.value = "";
  await chrome.storage.local.set({ [DRAFT_KEY]: "" });
  setStatus(DEFAULT_STATUS);
});

transcriptEl.addEventListener("input", () => {
  clearTimeout(draftSaveId);
  draftSaveId = setTimeout(() => chrome.storage.local.set({ [DRAFT_KEY]: transcriptEl.value }), 300);
});

[nameEl, aiToggleEl, keyEl].forEach((el) => el.addEventListener("change", saveSettings));

/* ---------- Session, notes, manual add ---------- */

toggle.addEventListener("change", async () => {
  const tab = await getActiveTab();
  if (toggle.checked) await startListening(tab);
  else await stopListening();
  await refresh();
});

notesEl.addEventListener("input", () => {
  clearTimeout(notesSaveId);
  notesSaveId = setTimeout(async () => {
    const session = await getSession();
    await setSession({ ...session, notes: notesEl.value });
  }, 250);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const [tab, session] = await Promise.all([getActiveTab(), getSession()]);
  await addPromise({
    text: textEl.value,
    title: session.title || tab?.title,
    url: session.url || tab?.url,
    source: "manual",
    sessionStartedAt: session.startedAt,
  });
  form.reset();
  filter = "open";
  syncFilterButtons();
  await refresh();
});

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    syncFilterButtons();
    refresh();
  });
});

function syncFilterButtons() {
  document.querySelectorAll(".filter").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  });
}

listEl.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action='delete']");
  if (!button) return;
  await deletePromise(button.dataset.id);
});

listEl.addEventListener("change", async (event) => {
  const input = event.target.closest("input[data-action='toggle']");
  if (!input) return;
  await updatePromise(input.dataset.id, { status: input.checked ? Status.KEPT : Status.OPEN });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_KEY] || changes[SESSION_KEY]) {
    if (changes[SESSION_KEY]) delete liveStatusEl.dataset.until;
    refresh();
  } else if (changes[LIVE_KEY] || changes[LIVE_STATUS_KEY] || changes[LIVE_RESULT_KEY] || changes[SETTINGS_KEY]) {
    if (changes[LIVE_RESULT_KEY]) delete liveStatusEl.dataset.until;
    refreshLive();
  }
});

syncFilterButtons();
initTranscriptPanel();
refresh();
