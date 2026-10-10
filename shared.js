const STORAGE_KEY = "promises";

const Status = {
  OPEN: "open",
  KEPT: "kept",
  BROKEN: "broken",
};

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

function createPromise({ text, title, url, dueAt, source }) {
  return {
    id: crypto.randomUUID(),
    text: String(text || "").trim(),
    title: title || "Untitled page",
    url: url || "",
    createdAt: Date.now(),
    dueAt: dueAt ?? null,
    status: Status.OPEN,
    source: source || "manual",
  };
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

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
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
