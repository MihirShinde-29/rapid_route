# A4 report: schedule and known issues

Ready to paste into the A4 PDF. Release notes: `docs/A4_RELEASE_NOTES.md`; screenshots: `docs/screenshots/`.

## Schedule to the final

Semester weeks counted from Aug 31 (week 9 = Oct 26). Assets are procedural (built in code); we are not using AI-generated assets.

| Week | Engineering | Assets | Integration / milestone | Owner |
|---|---|---|---|---|
| W9 (Oct 26 – Nov 1), done | Emergency units in traffic; yielding (pull over, pass, merge back) and junction pre-emption; boids debug view; every building an address with its own entrance; trips door to door with left turns in and out; leisure trips; accidents and lane closures on one lane, passed one side at a time; dispatch core, scoring, difficulty, best scores; menu, HUD, end screen with response chart; random accidents; call alerts and edge arrows; shortcuts, ride along; coverage map; station placement; siren-aware unit ETAs | Ambulance, fire engine and police models; siren lights; station buildings; drawn entrances; block fill (sheds, kiosks, tanks, fences); siren audio, chime and UI sounds | MVP 2.0 integrated Oct 29, submitted Nov 2 | Both |
| W10 (Nov 2 – 8) | Mutual aid (send from further away when local units are busy); returning units can be reassigned mid-route | Anything left from A4 | Merge mid-week; play-test | Ananya: mutual aid; Mihir: reassignment, A4 fixes |
| W11 (Nov 9 – 15) | Multi-unit calls (crash needs police and ambulance; fire needs engine and ambulance); severity priority | UI icons; sound mix and volume settings | Merge end of week | Ananya: multi-unit; Mihir: sound and icons |
| W12 (Nov 16 – 22) | Ordinary cars reroute mid-trip when a closure appears; yielding tuning at intersections and on arterials | Polish: night lighting of units, call markers | Feature-complete build | Mihir: rerouting; Ananya: polish |
| W13 (Nov 23 – 29) | Thanksgiving, light week: performance pass (1000 cars plus units), difficulty tuning | Final UI pass | Final feature freeze Nov 29 | Both |
| W14 (Nov 30 – Dec 6) | Could-have only if ahead: adaptive signals, severity-weighted dispatch | Video recording, report figures | Release candidate Dec 6 | Both |
| **W15 (Dec 7 – 13): Buffer** | **No new features.** Bug fixes, documentation, README, final report and video | | Final submission | Both |

## Known issues (traffic and map side)

- **Unit ETAs are free-flow times.** A unit arrives within about -7% to +16% of its ETA at the morning peak (10th to 90th percentile). Returning units have their sirens off, so they drive like ordinary cars.
- **One lane per direction.** Making way for a siren is drawn as a 2 m move onto the shoulder; units pass only cars that have pulled over.
- **Lane closures are slow.** One side goes at a time, so a 65 m closure carries about 650–700 cars an hour in total. On a busy arterial at the peak, queues build. Cars reroute only when the incident is placed, not while they wait.
- **Blocked stretches keep 18 m from junctions** (the plan said 12 m), so the longest vehicle can stop before them.
- **A road closure still admits trips that start or end on that street.**
- **Coverage counts idle units at their stations only.** Returning units are left out, as they cannot be reassigned yet (W10).
- **Station placement is limited.** One move per shift, before it starts. A station can only go onto a building or car park on a block laid out lot by lot, not onto a park, the mall, a yard or a podium block. The old station building stays as an ordinary building.
- **Siren audio is one voice** (the unit nearest the camera). It starts after the first click or key press, as browsers require.
- **At 300× the browser drops sim time when it falls behind.** A step takes about 0.45 ms at the morning peak and about 0.55 ms with 12 units and two incidents, so 300× needs about 28 ms of simulation per frame.
- **Starting a shift reloads the page** at the shift's hour (with half an hour of traffic run first), unless the city is already there. A station move is carried over; anything else set before the reload (incidents, camera) is not.
- **Shifts are 4 to 8 sim hours** (the plan said 2). At 60× that is 4 to 8 real minutes; the night shift is the longest and quietest.
- **Random accidents can land on any street at least 48 m long** except a station's own street, weighted by the cars on it. In Dispatcher mode an unanswered crash call counts as missed like any other.
- **Best scores are kept in this browser only** (localStorage), per mode, shift and difficulty.
- **Call alerts stay 6 real seconds** whatever the sim speed; at 300× several calls can come in at once and only the newest 3 pop-ups show (every call is still in the list and has a pin).
- **The gridlock guard stays as a last resort.** It removes a car stopped for 3 minutes. It removed none in the tests or in a sweep of 5 scenarios with 24 units each, but it is still there.
- **After an error the page has to be reloaded.** The error panel shows what went wrong but cannot resume the simulation.
