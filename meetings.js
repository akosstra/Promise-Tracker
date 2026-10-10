// Side panel "Meetings" section. Renders transcripts and lets the user confirm
// detected commitments as promises (same suggest-then-confirm flow as the
// on-page highlights). Wrapped in an IIFE so it can't collide with sidepanel.js.
(() => {
  const root = document.getElementById("meetings");
  const openIds = new Set();
  const seenLive = new Set();
  let latest = [];

  const timeLabel = (at) =>
    new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  const savedKey = (url, text) => `${url}|${text.trim().toLowerCase()}`;

  function renderSegment(session, segment, savedKeys, labelled) {
    const commitments = segment.commitments
      .map((sentence) => {
        const saved = savedKeys.has(savedKey(session.url, sentence));
        return `
          <div class="commitment">
            <span>${escapeHtml(sentence)}</span>
            <button class="btn small ghost" type="button" data-action="save-commitment"
              data-session="${session.id}" data-segment="${segment.id}"
              data-sentence="${segment.commitments.indexOf(sentence)}" ${saved ? "disabled" : ""}>
              ${saved ? "Saved" : "Save as promise"}
            </button>
          </div>`;
      })
      .join("");
    return `
      <div>
        <p class="segment"><time>${escapeHtml(timeLabel(segment.at))}</time>${labelled ? `<strong class="speaker ${segment.speaker === "you" ? "you" : ""}">${segment.speaker === "you" ? "You" : "Others"}</strong>` : ""}${escapeHtml(segment.text)}</p>
        ${commitments}
      </div>`;
  }

  function renderSession(session, liveId, savedKeys) {
    const live = session.id === liveId;
    if (live && !seenLive.has(session.id)) {
      seenLive.add(session.id);
      openIds.add(session.id);
    }
    const host = hostnameFromUrl(session.url);
    const found = session.segments.reduce((total, segment) => total + segment.commitments.length, 0);
    const lines = session.segments.length;
    const labelled = session.segments.some((segment) => segment.speaker === "you");
    const body = lines
      ? session.segments.map((segment) => renderSegment(session, segment, savedKeys, labelled)).join("")
      : `<p class="meta">${live ? "Listening… the first lines appear after a few seconds." : "No speech was captured."}</p>`;

    return `
      <details class="card meeting" data-id="${session.id}" ${openIds.has(session.id) ? "open" : ""}>
        <summary>
          <span class="meeting-title">${escapeHtml(session.title)}</span>
          <span class="meta">${escapeHtml(host || "Unknown page")} · ${escapeHtml(formatCaptured(session.startedAt))}</span>
          <span class="meta">${lines} ${lines === 1 ? "line" : "lines"}${found ? ` · ${found} possible ${found === 1 ? "promise" : "promises"}` : ""}</span>
          ${live ? '<span class="pill overdue">Live</span>' : ""}
        </summary>
        <div class="meeting-body">
          ${session.error ? `<p class="meeting-error">${escapeHtml(session.error)}</p>` : ""}
          ${body}
          <div class="status-row">
            <button class="btn small ghost" type="button" data-action="copy" data-session="${session.id}">Copy transcript</button>
            ${live ? "" : `<button class="btn small danger" type="button" data-action="delete-transcript" data-session="${session.id}">Delete</button>`}
          </div>
        </div>
      </details>`;
  }

  async function render() {
    const [sessions, recording, promises] = await Promise.all([
      getTranscripts(),
      getRecording(),
      getPromises(),
    ]);
    latest = sessions;
    const savedKeys = new Set(promises.map((promise) => savedKey(promise.url, promise.text)));
    root.innerHTML = sessions.length
      ? `<div class="field-label">Meetings</div>${sessions
          .map((session) => renderSession(session, recording?.sessionId, savedKeys))
          .join("")}`
      : "";
  }

  root.addEventListener(
    "toggle",
    (event) => {
      const details = event.target;
      if (!details.matches?.("details[data-id]")) return;
      if (details.open) openIds.add(details.dataset.id);
      else openIds.delete(details.dataset.id);
    },
    true,
  );

  root.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;
    const { action, session: sessionId, segment: segmentId, sentence } = button.dataset;
    const session = latest.find((item) => item.id === sessionId);
    if (!session) return;

    if (action === "delete-transcript") {
      await deleteTranscript(sessionId);
    }

    if (action === "copy") {
      const text = session.segments
        .map((segment) => `[${timeLabel(segment.at)}] ${segment.speaker === "you" ? "You" : "Others"}: ${segment.text}`)
        .join("\n");
      await navigator.clipboard.writeText(`${session.title}\n\n${text}`);
      button.textContent = "Copied";
    }

    if (action === "save-commitment") {
      const segment = session.segments.find((item) => item.id === segmentId);
      const text = segment?.commitments[Number(sentence)];
      if (!text) return;
      await addPromise({ text, title: session.title, url: session.url, source: "transcript" });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[TRANSCRIPTS_KEY] || changes[RECORDING_KEY] || changes[STORAGE_KEY]) render();
  });

  render();
})();
