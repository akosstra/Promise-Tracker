const toggle = document.getElementById("listen-toggle");
const card = document.getElementById("listen-card");
const labelEl = document.getElementById("listen-label");
const titleEl = document.getElementById("meeting-title");
const hintEl = document.getElementById("listen-hint");
const listEl = document.getElementById("list");
const followupLabel = document.getElementById("followup-label");

let timerId = null;

function stopTimer() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

function renderSession(session, tab) {
  const name = meetingLabel(session.active ? session : null, tab);
  titleEl.textContent = name;
  toggle.checked = Boolean(session.active);
  card.classList.toggle("on", session.active);

  const onMeet = isMeetUrl(session.active ? session.url : tab?.url);
  if (session.active) {
    labelEl.textContent = `Listening · ${formatElapsed(session.startedAt)}`;
    hintEl.textContent = isMeetUrl(session.url)
      ? "Session is live. Meet's captions are becoming a transcript, and follow-ups land in the list when you switch off."
      : "Session is live. Live captions only work on Google Meet. Paste a transcript in the notes panel to find follow-ups.";
  } else {
    labelEl.textContent = "Off";
    hintEl.textContent = onMeet
      ? "Turn on when the call starts. Promise Tracker reads Meet's live captions and turns them into follow-ups."
      : "Open a Google Meet call to capture its captions, or turn on to start a session and paste a transcript later.";
  }
}

function renderFollowups(promises, session) {
  const items = sortPromises(promises).filter((promise) => {
    if (session.active && session.startedAt) {
      return promise.sessionStartedAt === session.startedAt || (!promise.sessionStartedAt && promise.createdAt >= session.startedAt);
    }
    return promise.status === Status.OPEN;
  });

  followupLabel.textContent = session.active ? `This call · ${items.length}` : `Open follow-ups · ${items.filter((p) => p.status === Status.OPEN).length}`;

  const visible = session.active ? items : items.slice(0, 5);

  if (!visible.length) {
    listEl.innerHTML = session.active
      ? `<div class="card empty"><p>Listening for promises and “catch you later”s. Nothing captured yet.</p></div>`
      : `<div class="card empty"><p>No open follow-ups. Turn listening on in your next meeting.</p></div>`;
    return;
  }

  listEl.innerHTML = visible
    .map((promise) => {
      const done = promise.status !== Status.OPEN;
      return `
        <label class="card todo ${done ? "done" : ""}">
          <input class="todo-check" type="checkbox" data-id="${promise.id}" ${done ? "checked" : ""} />
          <div class="todo-body">
            <p class="todo-text">${escapeHtml(promise.text)}</p>
            ${promiseMetaHtml(promise)}
          </div>
        </label>
      `;
    })
    .join("");
}

async function refresh() {
  const [session, promises, tab] = await Promise.all([getSession(), getPromises(), getActiveTab()]);
  renderSession(session, tab);
  renderFollowups(promises, session);

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
    }, 1000);
  }
}

toggle.addEventListener("change", async () => {
  const tab = await getActiveTab();
  if (toggle.checked) {
    await startListening(tab);
    if (tab?.id && chrome.sidePanel?.open) {
      try {
        await chrome.sidePanel.open({ tabId: tab.id });
      } catch {
        /* popup still works if the panel cannot open */
      }
    }
  } else {
    await stopListening();
  }
  await refresh();
});

listEl.addEventListener("change", async (event) => {
  const input = event.target.closest("input[data-id]");
  if (!input) return;
  await updatePromise(input.dataset.id, { status: input.checked ? Status.KEPT : Status.OPEN });
});

document.getElementById("open-inbox").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab?.id && chrome.sidePanel?.open) await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STORAGE_KEY] || changes[SESSION_KEY])) refresh();
});

refresh();
