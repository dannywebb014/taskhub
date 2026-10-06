# tasks.

Speak or type your tasks on your phone. They're kept in lifeOS and show on every device you sign in on, or go to Craft or Todoist for a space you've connected.

Open the page, tap the text box, use the keyboard microphone, and say something like:

> Work. Send Sam the invoice on Friday. Chase the quote next Tuesday. My space. Book the dentist tomorrow.

Each sentence becomes a task. Start with **"Work"** or **"My space"** (or "personal") to switch space, with or without a pause: "Work check emails tomorrow" works. The switch applies to the tasks that follow, and "my space" mid-sentence also starts a new task. "Work on…", "work out…" and "work through…" go to Work but keep those words in the task. Ending a task with "for work" or "in my space" moves just that one. The first date in a task becomes its schedule date. A time with it ("call Sam tomorrow at 3pm", "gym 7am for 45 mins") becomes its time: on **Add** the task is blocked out on your main Google Calendar for an hour (or as long as you said), the same way calendar. blocks out a task, so it shows there too. Check the list, then tap **Add**. Tasks go into each space's inbox.

In the list of existing tasks, a task blocked out in calendar. shows its time next to its date ("Today · 15:00"), and changing its date takes the block along. Tap a task's name to rename it: Enter or tapping away saves, Escape cancels. The **→ tomorrow** button in the today. header moves everything due today or overdue to tomorrow; repeating tasks keep their repeat.

Say **"joint"** to send a task to Todoist instead of Craft, for lists shared with people who don't use Craft. Naming a project first puts it there: "joint house fix the gate" goes to the House project; anything else goes to Joint Reminders.

## Setup

None needed: with nothing connected, every space keeps its tasks in lifeOS (`lifeos/shared/hubtasks.js`, which needs `lifeos/sql/tasks.sql` run once). joint. tasks are shared with everyone in your food. household. Connecting a space below sends its new tasks there instead; tasks already in lifeOS still show.

In Craft, open **Imagine**, create an **All Documents** API connection for each space, and paste its API URL into the page's settings. A "Daily Notes and Tasks" connection can read every task but can only tick off the ones in the inbox and daily notes.

For Todoist, paste a personal API token from Todoist → Settings → Integrations → Developer.

For times, connect **Google Calendar** in settings with calendar.'s OAuth client ID (filled in for you if calendar. is set up in the same browser). Add `https://dannywebb014.github.io/taskhub/` to that client's authorised redirect URIs. Inside the lifeOS picker, sign-in goes through `/lifeos/`, which is already authorised.

Both are stored in the browser on that device only and never in this repo: the Craft URL can write to that space, and the Todoist token reaches that whole account.

## Files

- `index.html`: the page and its styles
- `app.js`: settings, the review list, and sending to Craft
- shared with calendar., from `lifeos/shared/`: `parse.js` (dictated text into tasks), `todoist.js` (the Todoist side) and `speech.js` (speaking into the page)
- `calendar.js`: Google sign-in and calendar.'s time blocks: reading, making and moving them

A static site with no build step, hosted on GitHub Pages. GitHub Pages lets browsers keep each file for ten minutes, so the page and every module it loads carry one release number (`?v=N`). Run `./bump.sh` before each commit to raise it everywhere, and a reopened app fetches the new code straight away.
