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
//   - Each sentence (or line) is one task. "My space" in the middle of a
//     sentence also starts a new task, since dictation often runs tasks
//     together without a full stop.
//   - A sentence that starts with a workspace name ("Work check emails",
//     "My space, book the dentist", "Work.") switches workspace for it and
//     every task after it, until another one is named. Dictation rarely
//     puts a comma after it, so none is needed.
//   - "Work on / out / through ..." still switches to Work, but keeps the
//     words as the task, since there "work" is part of what to do.
//   - A task ending in "for work" / "in my space" goes there on its own,
//     without changing the workspace of the tasks after it.
//   - The first date phrase in a task becomes its schedule date and is
//     removed from the text.

export const SPACES = [
  { id: "my", label: "my space.", pattern: "my\\s*space|personal" },
  { id: "work", label: "work.", pattern: "work" },
  // Shared lists in Todoist, for people who don't use Craft.
  { id: "todoist", label: "joint.", pattern: "joint|shared" },
];

const spaceFor = (word) => {
  const w = word.toLowerCase();
  return SPACES.find(s => new RegExp(`^(?:${s.pattern})$`, "i").test(w))?.id;
};

const ANY_SPACE = SPACES.map(s => s.pattern).join("|");
const PREP = "(?:in|for|to|into|on)\\s+";
// "Work check emails", "Work, ...", "In my space: ...", "Work task ...", "Work."
const LEAD = new RegExp(`^(?:${PREP})?(${ANY_SPACE})\\b(?:\\s+(?:tasks?|space)\\b)?[\\s,:;.\\-–—]*`, "i");
// After a leading "work", these mean "work" is the task's own verb.
const WORK_AS_VERB = /^(?:on|out|through)\b/i;
// "... my space buy milk": a new task starts at "my space" unless it is the
// end of "for my space" / "in my space".
const MID_SPLIT = /(?<!\b(?:in|for|to|into|on))\s+(?=my\s*space\b)/i;
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
    .flatMap(s => s.split(MID_SPLIT))
    .map(s => s.trim())
    .filter(Boolean);

  let current = defaultSpace;
  const tasks = [];
  for (let s of sentences) {
    s = s.replace(/[.!?]+$/, "");
    const lead = s.match(LEAD);
    if (lead) {
      current = spaceFor(lead[1]);
      const rest = s.slice(lead[0].length);
      const bare = !/[,:;.\-–—]/.test(lead[0]) && !/\btasks?\b/i.test(lead[0]);
      if (!(current === "work" && bare && WORK_AS_VERB.test(rest))) s = rest;
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
