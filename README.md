# tasks.

Speak your tasks on your phone and send them to Craft.

Open the page, tap the text box, use the keyboard microphone, and say something like:

> Work. Send Sam the invoice on Friday. Chase the quote next Tuesday. My space. Book the dentist tomorrow.

Each sentence becomes a task. Start with **"Work"** or **"My space"** (or "personal") to switch space, with or without a pause: "Work check emails tomorrow" works. The switch applies to the tasks that follow, and "my space" mid-sentence also starts a new task. "Work on…", "work out…" and "work through…" go to Work but keep those words in the task. Ending a task with "for work" or "in my space" moves just that one. The first date in a task becomes its schedule date. Check the list, then tap **Add**. Tasks go into each space's inbox.

Say **"joint"** to send a task to Todoist instead of Craft, for lists shared with people who don't use Craft. Naming a project first puts it there: "joint house fix the gate" goes to the House project; anything else goes to Joint Reminders.

## Setup

In Craft, open **Imagine**, create an **All Documents** API connection for each space, and paste its API URL into the page's settings. A "Daily Notes and Tasks" connection can read every task but can only tick off the ones in the inbox and daily notes.

For Todoist, paste a personal API token from Todoist → Settings → Integrations → Developer.

Both are stored in the browser on that device only and never in this repo: the Craft URL can write to that space, and the Todoist token reaches that whole account.

## Files

- `index.html`: the page and its styles
- `app.js`: settings, the review list, and sending to Craft
- `parse.js`: turns dictated text into tasks (no browser or Craft dependency)
- `todoist.js`: the Todoist side: projects, tasks, adding and closing

A static site with no build step, hosted on GitHub Pages.
