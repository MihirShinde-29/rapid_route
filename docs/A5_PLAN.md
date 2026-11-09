# Assignment 5 Plan: Beta Build

Group Rapid Route: Mihir Shinde, Ananya Das Hullumane Neelameghashyam

Status (Nov 9): planned, nothing built yet. Dates assume A5 is due **Mon Nov 23**; fix them once confirmed (if it is due Nov 16, see "If A5 is due sooner"). This plan pulls items forward from `docs/FINAL_PLAN.md` (W10–W12) so the Beta has the second pillar fully in the game and a more finished look. No feature freeze yet; no runtime LLMs; assets are procedural plus CC0 Kenney models.

## 1. What A5 asks for, and our answer

| Brief | What we build |
|---|---|
| Quick review of pillar 1 | **Pathfinding and Navigation**, done in A3–A4: A* on live travel times, units sent by lowest ETA, coverage map from multi-source shortest paths, unit ETAs within a median 1.00 of the real trip. Report only, plus the turn-round and closure rerouting fixes below. |
| Second pillar fully integrated | **Swarm and Boids** goes beyond "cars pull over on a straight street": cars make way at red lights and inside junctions, queues at closures and stopped buses react and flow round them, and several units on one call share the same street. |
| Interacts with the core loop | Yielding now shows up in the game: each unit card shows the cars that made way and the time saved, and the end screen shows the total time yielding saved over the shift. Multi-unit calls and severity mean the player has to think about who gets there fastest through traffic, which is where yielding matters. |
| Visual cohesion | Kenney Car Kit models for all vehicles (wheels spin and steer, body pitches and rolls), animated incidents (smoke, hazard lights, flares, blinking barriers) and on-scene animations (fire and hose, parked unit with lights, police tape). One colour pass so the city, models and UI match. |
| Stability, game loop intact | Start, Active and End unchanged in shape; all tests pass, with new ones for each sim change; play-test the Beta with 3+ people. |
| Performance check | A2 target: **60 FPS** with a few hundred cars plus up to ~50 units. FPS readout in the debug panel; measure at the AM peak (about 700 cars) plus 24 units with the new models and effects on. A graphics quality toggle (high / low) so we stay at 60 if the models cost too much. |
| PDF, 2 pages | Schedule, quick review, second pillar integration, new features, known issues, links. Same HTML-to-PDF setup as A4. |

## 2. Work split

| | Mihir (traffic, map, rendering) | Ananya (dispatch, game, UI) |
|---|---|---|
| Second pillar | Yielding at red lights and junctions; closure queues reroute; buses with stops; yield stats per unit | Multi-unit calls; yield stats in the unit card and end screen |
| Game depth | Turn-round for re-sent units; hospital trips | Severity; mutual aid |
| Visuals | Kenney pipeline and vehicles; incident animations; quality toggle; colour pass | On-scene animations; call and unit icons |
| Beta | FPS check | Play-test (3+ people), difficulty retune |
| Report | Quick review, second pillar, performance, known issues (sim side) | New features (game side), screenshots, known issues (game side) |

Each item is done when it works in the live build, has a test where it touches the sim, and has a line in the release notes.

## 3. Interface changes (agree on Mon Nov 9)

Mihir adds these to the sim first, with stubs, so Ananya can build against them the same day:

- **Calls need several units.** `Call.needs: UnitKind[]` (crash: police and ambulance; fire: engine and ambulance; medical: ambulance; crime: police) and `Call.units`. A call resolves when every needed unit has arrived; the score uses the last arrival. (Ananya owns the logic in `dispatch.ts`; the sim only needs to let several units target one site.)
- **Severity.** `Call.severity: 'low' | 'medium' | 'critical'`, set by Ananya's call generator.
- **Yield stats.** `sim.unitStats(unitId)` returns `{ carsYielded, junctionsHeld, savedS }`. `savedS` is the live-traffic ETA for the same route without a siren minus the actual trip time, so it is an honest estimate, not a guess.
- **Hospital trips.** A new unit state `to_hospital`: after a medical call, the ambulance drives to the nearest hospital with its siren on, then returns. The unit list shows it as busy.
- **Effects.** `view.effects` (new `render3d/effects.ts`, instanced particles and sprites). Mihir adds `incident(id, kind)` for accidents and closures; Ananya adds `onScene(callId, kind)` and `resolved(callId)` and calls them from the dispatch events.

## 4. Work items

### Mihir
1. **Yielding at red lights and inside junctions.** Cars waiting at a red light move to the side where there is room; cars inside a junction clear it before the unit arrives; units slow through a junction they cannot hold. Test: a unit behind a red-light queue gets through faster with yielding than without, and the peak still has no gridlock.
2. **Closure queues reroute.** Cars queued behind a lane or road closure re-plan if another route is faster by a margin. Test: at the peak, a closure on an arterial keeps a shorter queue than in A4.
3. **Buses.** A few bus lines on arterials with stops. A stopped bus blocks its lane like a short accident, so cars queue or pass on a gap; buses yield to units like other cars. Kenney bus model.
4. **Yield stats.** Count the cars that pulled over and the junctions held for each unit trip, and compute `savedS` as above. Test: `savedS` is positive on the yielding test route and close to the measured 265 s − 120 s.
5. **Turn-round.** A re-sent unit plans from where it is and may U-turn at the next safe spot (driveway or junction). Test: no re-sent unit drives more than one block the wrong way in a sweep.
6. **Hospital trips.** As in the interface. Test: an ambulance on a medical call ends at a hospital before returning.
7. **Kenney pipeline and vehicles.** Car Kit models in `sim/public/models/` with the licence, checked with the glTF validator; one instanced mesh per model; lights and siren lamps refitted; wheels spin with speed and the front ones steer; the body pitches when braking and rolls in turns. `docs/CREDITS.md`.
8. **Incident animations.** Accidents: smoke, hazard lights, flares, debris from the kit. Closures: blinking barrier lights and an arrow board. Fade in and out.
9. **FPS check and quality toggle.** FPS readout in the debug panel. Low quality turns off particles and shadows and uses the A4 vehicle models. Record FPS at the AM peak with 24 units on both settings.
10. **Colour pass.** Retune road, pavement and terrain colours to the Kenney palette.

### Ananya
1. **Multi-unit calls.** Crash and fire calls need two units; the call card shows which ones are still needed; the player sends each one (Enter sends the fastest for the next missing kind). Score from the last arrival. Test: a crash call stays open until both police and ambulance arrive.
2. **Severity.** Low, medium or critical, shown on the card and pin. Critical calls expire sooner and score more; the list sorts by severity, then time left. Test: a critical call expires before a low one placed at the same time.
3. **Mutual aid.** When no free unit of the right kind is near, offer busy-returning units and units from further stations, marked "mutual aid" with their ETA. Test: with every local unit busy, the call still gets a candidate.
4. **Yield stats in the UI.** The unit card shows "N cars made way, saved about M s"; the end screen adds "Yielding saved about X min this shift".
5. **On-scene animations.** Fire calls: flames and smoke on the building, the engine's hose spraying while on scene, dying down as the call resolves. Medical and crime calls: the unit parks at the entrance with its lights flashing and a pulsing marker; police tape for crime calls. A short effect when a call resolves.
6. **Icons.** Procedural icons for call kinds, severity and units in the list, pins and alerts.
7. **Play-test and retune.** 3+ people outside the group play one shift each on the Beta; note where they got stuck; retune call rates and unit counts for multi-unit calls and hospital trips.

## 5. Schedule

| Days | Mihir | Ananya | Together |
|---|---|---|---|
| Mon Nov 9 | Interface stubs (needs, severity, unitStats, to_hospital, effects) | Review the interface | Agree the interface and the due date |
| Tue Nov 10 – Wed Nov 11 | Yielding at red lights and junctions; yield stats | Multi-unit calls | |
| Thu Nov 12 – Fri Nov 13 | Closure rerouting; turn-round; hospital trips | Severity; mutual aid | |
| Sat Nov 14 – Sun Nov 15 | Kenney pipeline; incident animations | Yield stats in the UI; icons | **Merge 1** Sun: everything in the sim works with the A4 visuals |
| Mon Nov 16 – Wed Nov 18 | Kenney vehicles with animation; buses | On-scene animations | |
| Thu Nov 19 – Fri Nov 20 | FPS check, quality toggle, colour pass | Play-test, retune | **Merge 2** Fri: Beta candidate on the live site |
| Sat Nov 21 – Sun Nov 22 | Fixes; report (pillars, performance, known issues) | Fixes; report (features, screenshots) | Check the PDF is 2 pages; tag `beta` |
| Mon Nov 23 | | | **Submit** |

## 6. Report outline (2 pages)

1. Title, group, links (live build, repo).
2. **Quick review: pillar 1, Pathfinding and Navigation.** Three lines and the key numbers.
3. **Second pillar integration: Swarm and Boids.** Exactly where the rules act (straight streets, red lights, junctions, closures, buses), how they feed the game (response time, yield stats, end screen), and the measured numbers.
4. **New features since the Alpha (A4).** One list, game and visuals.
5. **Performance.** FPS at the AM peak with 24 units, high and low quality, against the 60 FPS target.
6. **Schedule to the final.** W11 to W15 from `FINAL_PLAN.md`, updated.
7. **Known issues.** Honest, short.
8. Two or three screenshots.

## 7. If A5 is due sooner (Nov 16)

Keep: yielding at red lights and junctions, yield stats in the game, closure rerouting, multi-unit calls, severity, incident animations, the FPS check and the report. Move to the final: Kenney vehicles, buses, on-scene animations, hospital trips, mutual aid, turn-round, icons, the colour pass.

## 8. Risks

- **Yielding at junctions causes deadlocks.** The A4 stress run found three; rerun it after every change, and keep the "stop the yield chain at a car that can't pull over" rule.
- **Kenney models cost too much or don't fit.** Measure FPS on the first model before converting the rest; the low quality setting keeps the A4 models.
- **Multi-unit calls and hospital trips tie up units.** Retune counts and call rates after the play-test.
- **Integration slips.** Two merges, not one at the end; the interface stubs go in on day 1.

## 9. Open questions

1. Confirm the A5 due date and whether the PDF has to include anything beyond the brief.
2. Ananya to agree to her items and the interface.
