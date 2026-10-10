const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "CODE", "PRE", "SVG", "CANVAS"]);
const MAX_HIGHLIGHTS = 12;
const MAX_TEXT = 120000;
const DISMISS_KEY = "pt-dismissed";

const PROMISE_RE =
  /\b((?:I|we|they|he|she)(?:'ll| will| promise(?: to)?| commit(?:ted)? to)|we commit(?:ted)? to|by (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|EOD|end of (?:day|week|month)|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?))\b/i;

function dismissedSet() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISS_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function persistDismissed(set) {
  sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...set]));
}

function sentenceFor(node, matchIndex) {
  const text = node.nodeValue;
  let start = matchIndex;
  let end = matchIndex;
  while (start > 0 && !".!?".includes(text[start - 1])) start -= 1;
  while (end < text.length && !".!?".includes(text[end])) end += 1;
  if (end < text.length) end += 1;
  return text.slice(start, end).trim();
}

function collectCandidates() {
  if (!document.body || document.body.innerText.length > MAX_TEXT) return [];

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName) || parent.closest(".pt-highlight, .pt-popover")) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!node.nodeValue || node.nodeValue.trim().length < 12) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const dismissed = dismissedSet();
  const seen = new Set();
  const found = [];

  while (walker.nextNode() && found.length < MAX_HIGHLIGHTS) {
    const node = walker.currentNode;
    const match = PROMISE_RE.exec(node.nodeValue);
    if (!match) continue;
    const sentence = sentenceFor(node, match.index);
    if (sentence.length < 12 || sentence.length > 280) continue;
    const key = sentence.toLowerCase();
    if (seen.has(key) || dismissed.has(key)) continue;
    seen.add(key);
    found.push({ node, match, sentence });
  }

  return found;
}

function wrapMatch(node, match) {
  const range = document.createRange();
  range.setStart(node, match.index);
  range.setEnd(node, match.index + match[0].length);

  const mark = document.createElement("span");
  mark.className = "pt-highlight";
  mark.setAttribute("role", "button");
  mark.tabIndex = 0;
  mark.title = "Save this as a promise";
  mark.textContent = match[0];
  range.deleteContents();
  range.insertNode(mark);
  return mark;
}

function closePopover() {
  document.querySelector(".pt-popover")?.remove();
}

function showPopover(anchor, sentence) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pt-popover";
  pop.innerHTML = `
    <p>${escapeHtml(sentence)}</p>
    <div class="pt-popover-actions">
      <button type="button" class="pt-save">Save promise</button>
      <button type="button" class="pt-dismiss">Dismiss</button>
    </div>
  `;
  document.body.appendChild(pop);

  const rect = anchor.getBoundingClientRect();
  const top = Math.min(window.scrollY + rect.bottom + 8, window.scrollY + window.innerHeight - pop.offsetHeight - 12);
  const left = Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - pop.offsetWidth - 12);
  pop.style.top = `${top}px`;
  pop.style.left = `${Math.max(8, left)}px`;

  pop.querySelector(".pt-save").addEventListener("click", async () => {
    await addPromise({
      text: sentence,
      title: document.title,
      url: location.href,
      source: "suggestion",
    });
    anchor.classList.add("pt-saved");
    anchor.title = "Saved";
    closePopover();
  });

  pop.querySelector(".pt-dismiss").addEventListener("click", () => {
    const dismissed = dismissedSet();
    dismissed.add(sentence.toLowerCase());
    persistDismissed(dismissed);
    anchor.remove();
    closePopover();
  });
}

function scan() {
  for (const candidate of collectCandidates()) {
    try {
      const mark = wrapMatch(candidate.node, candidate.match);
      const open = (event) => {
        event.preventDefault();
        event.stopPropagation();
        showPopover(mark, candidate.sentence);
      };
      mark.addEventListener("click", open);
      mark.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") open(event);
      });
    } catch {
      // Page DOM may reject the wrap; skip that match.
    }
  }
}

document.addEventListener("click", (event) => {
  if (!event.target.closest(".pt-popover, .pt-highlight")) closePopover();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", scan, { once: true });
} else {
  scan();
}
