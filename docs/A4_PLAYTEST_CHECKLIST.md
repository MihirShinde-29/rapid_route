# A4 play-test checklist

Run it: `cd sim && npm run dev`, open http://localhost:5173/ (or the live build). Tick each box; note anything odd with the URL and sim clock.

## 1. Menu (start state)
- [ ] The city runs behind the menu; the sidebar shows the **Dispatch** tab with the how-to-play card.
- [ ] **Traffic panels** tab shows traffic, incidents, demand, OD matrix and routing proof; **Dispatch** switches back.
- [ ] Changing mode, shift or difficulty updates the best-score line ("No best score yet…" the first time).
- [ ] `?` opens the shortcuts overlay; Esc closes it.

## 2. Station placement (optional, before a shift)
- [ ] **Move a station** → click a hospital, fire or police station → hover: the lot highlights green/red and the coverage map previews it.
- [ ] Click a house or car park: the station is drawn there, the old one becomes an ordinary building, the note says where it moved.
- [ ] **Undo station move** puts it back. Esc cancels mid-way.
- [ ] Move one, then start the shift: after the reload the station is still at its new place and its units start from there.

## 3. Starting a shift
- [ ] **Start shift** for each shift: the page reloads, "Fast-forwarding…" shows, Start is greyed out, then the shift starts at 07:00 / 11:00 / 16:30 / 23:00 with traffic on the roads.
- [ ] Speed switches to 20×; the status line counts down "2:00 left".
- [ ] The button says **End shift** (Dispatcher) or **End session** (Sandbox).

## 4. Calls and alerts (Dispatcher)
- [ ] A new call: chime, pop-up "Medical call · Downtown" (or similar), a yellow pin over the address.
- [ ] Pan away from a waiting call: an arrow appears at the screen edge pointing towards it.
- [ ] Clicking the pop-up, the pin or the arrow selects the call and moves the camera there.
- [ ] The candidate list shows units of the right kind with ETAs, the first marked **fastest**.
- [ ] Assign by clicking a unit then **Assign selected unit**; also by **Enter** (sends the fastest). **Tab** steps through waiting calls.
- [ ] After assigning, the pin turns blue, the status line shows the unit and its ETA, and the cyan route line appears.
- [ ] The unit reaches the call in about its ETA (within ~20%).
- [ ] Let a call expire: a red "Missed" pop-up and a low tone; Missed calls goes up.

## 5. Units and sirens
- [ ] Cars ahead of a unit pull onto the shoulder, the unit passes, they merge back. Cross traffic waits at junctions for it.
- [ ] Close up: the unit's own siren lamps flash; zoomed out: a small red/blue beacon shows over it.
- [ ] **Follow** (or click a driving unit in the list, or press F) rides along; Esc stops.
- [ ] A unit on its way back appears in the candidate list as "on its way back" and can be sent; it turns round and goes.
- [ ] Sound: siren gets louder as the camera nears a unit; **M** or the Sound button mutes everything (siren, chime, clicks).

## 6. Accidents and closures
- [ ] Random accidents appear during the shift (about 1 an hour at rush hour on Normal), each with a crash call.
- [ ] Place an accident by hand during a shift: a crash call is created.
- [ ] Cars pass the accident one side at a time through the oncoming lane.
- [ ] The accident stays until the crash call is handled, then disappears from the map and the incident list.
- [ ] Lane closure (two clicks along a lane, with a preview) and road closure (click a street) still work; cars reroute.

## 7. Views
- [ ] **C** cycles coverage: all units, ambulance, fire, police, off. It goes redder as units get busy.
- [ ] **B** shows the boids view: yield reach along each unit's route, held junctions, steering arrows.
- [ ] **Space** pauses, **1–5** set 1×, 5×, 20×, 60×, 300×.

## 8. End of shift (end state)
- [ ] Let a shift run out (win), lose one by missing calls (2 on Hard, 3 on Normal, 4 on Easy), and end one early with End shift.
- [ ] The end screen shows the title, grade, "N points per call · X of Y reached within target", stats and the response chart (green within target, amber over, red × missed, white target ticks).
- [ ] Hover a bar: tooltip with the call, address and time. **Show as a table** lists the same calls.
- [ ] First finish says **New best score!**; a lower score afterwards shows the previous best instead.
- [ ] **Play Again** restarts the same mode, shift and difficulty; **Return to Menu** (or Esc) goes back, and the menu shows the best score.

## 9. Sandbox
- [ ] Calls are assigned automatically to the nearest unit; no pop-ups or chime for new calls.
- [ ] Place accidents and closures and watch units respond; there is no loss; End session shows the summary.

## 10. Difficulty
- [ ] Easy: 3 ambulances per hospital, 12 calls an hour, lose at 4 missed.
- [ ] Normal: 2 ambulances, 2 police per station, 20 calls an hour, lose at 3.
- [ ] Hard: 1 police car per station, 30 calls an hour, lose at 2.
- [ ] Does each feel right over a full 6-minute shift? Note if Normal is too easy or too hectic.

## 11. Robustness
- [ ] 300× for a minute at the PM rush: no freeze, perf readout stays sensible, no gridlock removals.
- [ ] Narrow window (phone width): the sidebar stacks under the map and stays usable.
- [ ] Reload mid-shift: the page comes back to the menu cleanly.
- [ ] No errors in the browser console (F12) during any of the above.

## Automated tests
`cd sim && npm test`: 63 tests, all should pass (about 1 minute). `npm run build` should finish without errors.
