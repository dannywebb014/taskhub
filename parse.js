// ─── Turning dictated text into tasks ────────────────────────────────
//
// Input is whatever iOS dictation produced, e.g.
//   "Work. Send Sam the invoice on Friday. Chase the quote. My space, book
//    the dentist tomorrow."
// Output is one task per sentence, each with a workspace and an optional
// schedule date. Nothing here talks to Craft, so it can be tested in Node.
//
// Rules, in order:
//   - Each sentence (or line) is one task.
//   - A sentence that starts with a workspace name followed by a pause
//     ("Work, ..." / "My space: ..." / "Work tasks ...") switches workspace
//     for it and every task after it, until another one is named.
//   - A sentence that is only a workspace name ("Work.") just switches.
//   - A task ending in "for work" / "in my space" goes there on its own,
//     without changing the workspace of the tasks after it.
//   - The first date phrase in a task becomes its schedule date and is
//     removed from the text.
//
// "Work on the report" is deliberately NOT treated as a workspace switch:
// without a pause after it, "work" is far more often a verb.

export const SPACES = [
  { id: "my", label: "My space", pattern: "my\\s*space|personal" },
  { id: "work", label: "Work", pattern: "work" },
];

const spaceFor = (word) => {
  const w = word.toLowerCase();
  return SPACES.find(s => new RegExp(`^(?:${s.pattern})$`, "i").test(w))?.id;
};

const ANY_SPACE = SPACES.map(s => s.pattern).join("|");
const PREP = "(?:in|for|to|into|on)\\s+";
// "Work, ...", "In my space: ...", "Work." on its own
const LEAD_PAUSE = new RegExp(`^(?:${PREP})?(${ANY_SPACE})(?:\\s+(?:tasks?|space))?\\s*(?:[,:;.\\-–—]+\\s*|$)`, "i");
// "Work task send the invoice", "My space tasks ..." — no pause needed
const LEAD_TASK = new RegExp(`^(?:${PREP})?(${ANY_SPACE})\\s+tasks?\\b[,:;.\\-–—]*\\s*`, "i");
// "... for work", "... in my space"
const TRAIL = new RegExp(`[\\s,]*\\b${PREP}(${ANY_SPACE})\\s*$`, "i");

const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const tidy = (s) => {
  const t = s
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g, "")
    .trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};

// Pull the first date phrase out of a task. Words that only make sense
// attached to the date ("on", "by", "for") go with it.
function takeDate(text, chrono, now) {
  const [hit] = chrono.en.GB.parse(text, now, { forwardDate: true });
  if (!hit) return { text, date: null };
  const date = isoDate(hit.start.date());
  const after = text.slice(hit.index + hit.text.length);
  // "Thursday's meeting" — the date is part of the wording, so keep it.
  if (/^['’]s\b/.test(after)) return { text, date };
  const before = text.slice(0, hit.index).replace(/\b(?:on|by|for|from|due|this)\s*$/i, "");
  return { text: `${before} ${after}`, date };
}

export function parseTasks(input, chrono, { now = new Date(), defaultSpace = SPACES[0].id } = {}) {
  const sentences = String(input ?? "")
    .split(/\n+|(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  let current = defaultSpace;
  const tasks = [];
  for (let s of sentences) {
    s = s.replace(/[.!?]+$/, "");
    const lead = s.match(LEAD_TASK) || s.match(LEAD_PAUSE);
    if (lead) {
      current = spaceFor(lead[1]);
      s = s.slice(lead[0].length);
    }
    let space = current;
    const trail = s.match(TRAIL);
    if (trail && trail.index > 0) {
      space = spaceFor(trail[1]);
      s = s.slice(0, trail.index);
    }
    const { text, date } = takeDate(s, chrono, now);
    const clean = tidy(text);
    if (clean) tasks.push({ text: clean, space, date });
  }
  return tasks;
}
