const summaryEl = document.getElementById("summary");
const countsEl = document.getElementById("counts");
const listEl = document.getElementById("list");
const form = document.getElementById("quick-add");
const textEl = document.getElementById("text");
const dueEl = document.getElementById("due");

function renderCounts(counts) {
  countsEl.innerHTML = `
    <span class="pill open">${counts.open} open</span>
    ${counts.overdue ? `<span class="pill overdue">${counts.overdue} overdue</span>` : ""}
  `;
  summaryEl.textContent =
    counts.open === 0 ? "Nothing open right now." : `${counts.open} open · ${counts.kept} kept`;
}

function renderList(promises) {
  const upcoming = sortPromises(promises)
    .filter((promise) => promise.status === Status.OPEN)
    .slice(0, 4);

  if (!upcoming.length) {
    listEl.innerHTML = `<div class="empty"><p>Highlight text on a page and choose “Save as promise”, or add one above.</p></div>`;
    return;
  }

  listEl.innerHTML = upcoming
    .map((promise) => {
      const late = isOverdue(promise);
      return `
        <article class="card promise ${late ? "overdue" : ""}">
          <p class="quote">${escapeHtml(promise.text)}</p>
          <div class="source">
            <span>${escapeHtml(hostnameFromUrl(promise.url) || promise.title)}</span>
            <span class="due ${late ? "late" : ""}">${escapeHtml(formatDue(promise.dueAt))}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

async function refresh() {
  const promises = await getPromises();
  renderCounts(countByStatus(promises));
  renderList(promises);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await addPromise({
    text: textEl.value,
    title: tab?.title,
    url: tab?.url,
    dueAt: dueAtFromDateInput(dueEl.value),
    source: "manual",
  });
  form.reset();
  await refresh();
});

document.getElementById("open-inbox").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) refresh();
});

refresh();
