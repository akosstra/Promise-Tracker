const listEl = document.getElementById("list");
const countsEl = document.getElementById("counts");
const summaryEl = document.getElementById("summary");
const form = document.getElementById("add-form");
const textEl = document.getElementById("text");
const dueEl = document.getElementById("due");

let filter = "open";

function renderCounts(counts) {
  countsEl.innerHTML = `
    <span class="pill open">${counts.open} open</span>
    <span class="pill kept">${counts.kept} kept</span>
    ${counts.overdue ? `<span class="pill overdue">${counts.overdue} overdue</span>` : ""}
  `;
  summaryEl.textContent = counts.overdue
    ? `${counts.overdue} overdue ${counts.overdue === 1 ? "promise" : "promises"}`
    : "Your captured commitments";
}

function statusButtons(promise) {
  return [Status.OPEN, Status.KEPT, Status.BROKEN]
    .map((status) => {
      const pressed = promise.status === status;
      return `<button class="btn small ghost" type="button" data-action="status" data-id="${promise.id}" data-status="${status}" aria-pressed="${pressed}">${status}</button>`;
    })
    .join("");
}

function renderList(promises) {
  const visible = sortPromises(promises).filter((promise) => filter === "all" || promise.status === filter);

  if (!visible.length) {
    listEl.innerHTML = `
      <div class="card empty">
        <h2>No ${filter === "all" ? "" : filter} promises</h2>
        <p>Select text on a page, right-click, and choose Save as promise. Suggested lines on the page can be saved with one click.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = visible
    .map((promise) => {
      const late = isOverdue(promise);
      const host = hostnameFromUrl(promise.url);
      const source = promise.url
        ? `<a href="${escapeHtml(promise.url)}" target="_blank" rel="noreferrer">${escapeHtml(host || promise.title)}</a>`
        : escapeHtml(promise.title);
      return `
        <article class="card promise ${late ? "overdue" : ""}" data-id="${promise.id}">
          <p class="quote">${escapeHtml(promise.text)}</p>
          <div class="source">
            ${source}
            <span>saved ${escapeHtml(formatCaptured(promise.createdAt))}</span>
          </div>
          <div class="status-row">
            ${statusButtons(promise)}
            <label class="due-edit">
              <span class="field-label">Due</span>
              <input type="date" data-action="due" data-id="${promise.id}" value="${dateInputFromDueAt(promise.dueAt)}" />
            </label>
            <span class="due ${late ? "late" : ""}">${late ? "Overdue" : ""}</span>
            <button class="btn small danger" type="button" data-action="delete" data-id="${promise.id}">Delete</button>
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
  filter = "open";
  syncFilterButtons();
  await refresh();
});

document.getElementById("export").addEventListener("click", async () => {
  const promises = await getPromises();
  downloadJson(`promise-tracker-${new Date().toISOString().slice(0, 10)}.json`, {
    exportedAt: new Date().toISOString(),
    promises,
  });
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
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id, status } = button.dataset;
  if (action === "delete") await deletePromise(id);
  if (action === "status") await updatePromise(id, { status });
});

listEl.addEventListener("change", async (event) => {
  const input = event.target.closest("input[data-action='due']");
  if (!input) return;
  await updatePromise(input.dataset.id, { dueAt: dueAtFromDateInput(input.value) });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) refresh();
});

syncFilterButtons();
refresh();
