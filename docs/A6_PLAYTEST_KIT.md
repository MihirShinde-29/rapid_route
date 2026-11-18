# Dispatch — A6 playtest kit

Group Rapid Route. Use this for every session so the five sessions can be compared. Print one observer sheet (section 4) and one interview form (section 5) per subject.

## 1. Before each session

- **Subjects:** classmates outside our group, at least 5. Give each a code: S1, S2, … Don't write names on the sheets.
- **Build:** the live site with the subject's code in the address, on a laptop with a mouse:
  `https://mihirshinde-29.github.io/rapid_route/?playtest=S1`
  A red "● Playtest S1" badge in the bottom right shows the log is recording. Nothing is sent anywhere; the log stays in the browser.
- **Reset the game's memory** so every subject sees the first-run tutorial: open the browser console and run `localStorage.removeItem('dispatch.tutorialDone')`. Or use a fresh private window per subject; the log still works there but is lost if the window closes before you press **Save log**.
- Graphics on **high**, sound on at a normal volume, window maximised.
- Note the machine (laptop model, browser) on the observer sheet.

## 2. Script (read this, then stop talking)

> "This is Dispatch, a game about running an emergency dispatch centre. The city has live traffic, and emergency calls come in during your shift. Your job is to get the right units to the calls in time. I won't explain the controls; the game should. Please think aloud while you play: say what you're looking at, what you're trying to do, and anything that surprises or confuses you. There are no wrong answers; we're testing the game, not you. You can stop at any time, and we don't record your name. Play one shift, or stop whenever you like."

Aim for about 15–20 minutes of play, then the interview, so the sessions can be compared.

Then start the timer. **Don't help** unless they are completely stuck for about 2 minutes; if you do, write down exactly what you said and when.

Suggested setup if they ask: Dispatcher mode, AM rush, Normal, Clear weather. Let them choose otherwise.

## 3. During the session

- Write **what they did and said**, with the time from the badge. Quote them where you can.
- Watch especially for:
  - the first minute: do they find **Start shift**? Do they read the tutorial or skip it?
  - the first call: how long until they click it? Do they find the unit list and **Assign**, or press Enter?
  - calls that need two units (crash, fire): do they notice "1/2 arrived" and send the second one?
  - off-screen calls: do they use the edge arrows, the pins or the list?
  - camera: can they orbit, zoom and pan? Do they get lost?
  - ride-along (clicking a unit, F), coverage (C), weather, graphics, volume: found or not?
  - **performance:** the FPS readout is in the top right of the map. Note any stutter and what was on screen (zoomed in downtown, riding along, rain, many calls).
  - **visual glitches:** cars through each other, units stuck, flickering, missing models, people walking in the road.
- At the end, press **Save log** on the badge. It downloads `playtest-S1-<date>.json`. Then ask the interview questions.

## 4. Observer sheet (one per subject)

Subject: ____ Date: ________ Machine / browser: ______________________ Observer: ____

Setup chosen (mode, shift, difficulty, weather, graphics): ______________________________

| Time | What they did or said | Problem? (UI / difficulty / performance / glitch / none) |
|---|---|---|
| | | |
| | | |
| | | |
| | | |
| | | |
| | | |
| | | |
| | | |

Found on their own (tick): Start shift ☐ · tutorial read ☐ / skipped ☐ · assign a unit ☐ · Enter to send fastest ☐ · second unit for crash/fire ☐ · edge arrows ☐ · ride-along ☐ · coverage map ☐ · pause / speed ☐ · help (?) ☐

Helped by observer? ☐ No ☐ Yes, at ____ : "________________________________"

Result: grade ____ points ____ calls handled ____ missed ____ shift ended by: time ☐ / too many missed ☐ / quit ☐

## 5. Post-play interview (same questions, same order)

1. What was the most confusing or frustrating part? ______________________________
2. On a scale of 1–10, how intuitive were the controls? ____ Why? ____________________
3. Did you notice any visual glitches or lag? If so, when? ______________________________
4. Was it clear what you were meant to do when the shift started? ☐ Yes ☐ Partly ☐ No
5. Was the difficulty too easy, about right, or too hard? ☐ Easy ☐ Right ☐ Hard
6. Did you notice cars pulling over for your units? ☐ Yes ☐ No
7. What one change would make it better? ______________________________
8. Would you play another shift? ☐ Yes ☐ Maybe ☐ No

## 6. After all sessions

- Put the five JSON logs and scanned or typed sheets in one folder (don't commit names).
- For the report: one line on method, a table of the 1–10 scores and results, the problems seen by two or more subjects, the FPS dips from the logs (type `fps_dip`, with what was on screen), and 3–5 action items for A7, each tied to what was observed.
- What the log records, per entry `t` (seconds since the session started):
  `click` and `key` (what was used), `tutorial_step` / `tutorial_step_done` (seconds spent on each step), `call_call`, `call_assigned`, `call_arrived`, `call_resolved`, `call_missed` (with `simSecondsSinceCall`, so the time from call to assignment is there), `fps` every 5 s and `fps_dip` for any second under 40 fps (with graphics level, speed, riding along, weather, car count, draw calls), `shift_start`, `shift_end` (grade, points, missed), and `error`.
