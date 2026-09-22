# tasks.

Speak your tasks on your phone and send them to Craft.

Open the page, tap the text box, use the keyboard microphone, and say something like:

> Work. Send Sam the invoice on Friday. Chase the quote next Tuesday. My space. Book the dentist tomorrow.

Each sentence becomes a task. Start with **"Work"** or **"My space"** (or "personal") to switch space, with or without a pause: "Work check emails tomorrow" works. The switch applies to the tasks that follow, and "my space" mid-sentence also starts a new task. "Work on…", "work out…" and "work through…" go to Work but keep those words in the task. Ending a task with "for work" or "in my space" moves just that one. The first date in a task becomes its schedule date. Check the list, then tap **Add**. Tasks go into each space's inbox.

## Setup

In Craft, open **Imagine**, create an API connection for each space, and paste its API URL into the page's settings. The URLs are stored in the browser on that device only and never in this repo: anyone with one can write to that space.

## Files

- `index.html`: the page and its styles
- `app.js`: settings, the review list, and sending to Craft
- `parse.js`: turns dictated text into tasks (no browser or Craft dependency)

A static site with no build step, hosted on GitHub Pages.
