# A4 release notes (MVP 2.0 alpha, since A3 on Oct 13)

Live build: https://mihirshinde-29.github.io/rapid_route/ · screenshots in `docs/screenshots/`.

## New

**The game**
- Menu over the live city with a how-to-play card: mode (Dispatcher or Sandbox), shift (AM rush, midday, PM rush, night; 2 sim hours each, played at 20×, about 6 real minutes) and difficulty (Easy, Normal, Hard). The shift starts at its own time of day, with half an hour of traffic already on the roads.
- Dispatcher: emergency calls (medical, fire, crime, crash) come in at real addresses. Select a call, see the free units that can take it with their ETAs (the fastest is marked), and send one (click, or Enter for the fastest). A unit driving back to its station can be sent to a new call from where it is. A call is missed if no unit gets there before it expires; too many missed calls lose the shift.
- Sandbox: units are sent automatically (nearest by ETA); place accidents and closures and watch the response. `End session` shows the same summary.
- Difficulty sets the call rate (12, 20, 30 an hour), the missed calls allowed (4, 3, 2), the number of units (Easy: 3 ambulances per hospital; Hard: 1 police car per station) and how often accidents happen.
- Random accidents during a shift, more at rush hour. Each blocks one lane and creates a crash call; it stays until the call is handled. An accident placed by hand during a shift also creates a crash call.
- End screen: grade (from the mean score per call), calls handled, missed calls, mean response, score, and a chart of each call's response time against its target (also as a table). The best score per mode, shift and difficulty is kept in the browser and shown on the menu and the end screen.
- Call alerts: a pop-up and a chime for each new call, a low tone for a missed one. Open calls have a pin on the map; waiting calls out of view get an arrow at the screen edge. Clicking a pop-up, pin or arrow selects the call and moves the camera there.
- Unit status line with destination and ETA; `Follow` on each unit and a cyan line along its route.
- The A3 traffic panels (traffic, incidents, demand, OD matrix, routing proof) moved to a second sidebar tab.

**Emergency units in traffic**
- Ambulances, fire engines and police cars drive in the traffic model with sirens, up to 1.3 times the speed limit.
- Cars make way: they pull onto the shoulder, the unit passes, they merge back. Junctions ahead of a unit are held for it.
- Unit ETAs account for the siren: a unit arrives in about its ETA whatever the traffic (median 1.00 of it at the morning peak).
- Units turn left into a call's driveway across traffic (they take short gaps with the siren on) instead of going round the block to avoid it: about 30% of unit trips now arrive with a left turn, up from 3–5%.
- Ride along with any unit; boids debug view (B) shows each unit's yield reach, held junctions and steering arrows.
- Coverage map (C): how fast the nearest free unit (at its station, or driving back) could reach each part of the city on live traffic, for all units or each kind.
- Station placement before a shift: move one station to another building, with the coverage map previewing the result.
- Procedural siren sound (louder near the camera), UI sounds, mute (M). Keyboard shortcuts with a help overlay (?).

**City**
- Every building, park, car park and station is an address with its own entrance. Trips run door to door, with left turns in and out of driveways on a gap in oncoming traffic, and leisure trips to parks and the mall.
- Accidents and lane closures block one lane; cars pass one side at a time through the oncoming lane, like a one-lane bridge.
- Emergency vehicle and station models, drawn entrances, and filler (sheds, kiosks, tanks, fences) in the space between buildings.
- OD matrix as 9 districts with live trip counts (grader feedback); incidents on any street with rerouting (grader feedback).

## Fixed
- OD panel was unreadable (572 × 572 zone pairs in about 260 px) and only redrew when the time period changed.
- Starting a shift moved the clock back without resetting the traffic on the road.
- Unit ETAs were about 1.7 times too high (they assumed ordinary driving).
- The unit list was rebuilt four times a second, so a click on `Follow` could be lost.
- Siren beacons over units rendered black and covered the unit model close up.

## Known issues
See `docs/A4_REPORT_MIHIR.md`.

## Tests
63 tests (Vitest), including: a unit passes a full queue; response with yielding is faster than without; pre-emption holds cross traffic; coverage times match single-source A*; unit ETAs match actual siren trips; the morning peak carries about 700 cars with 0 gridlock removals; call lifecycle, scoring, shift end and loss; random accidents create crash calls and stay until handled; a returning unit can be sent to a new call.
