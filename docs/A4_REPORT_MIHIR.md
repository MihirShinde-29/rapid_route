# A4 report: schedule and known issues

Ready to paste into the A4 PDF. Release notes: `docs/A4_RELEASE_NOTES.md`; screenshots: `docs/screenshots/`.

## Schedule to the final

Full plan with work items, risks and cut order: `docs/FINAL_PLAN.md`. Semester weeks counted from Aug 31 (week 9 = Oct 26). Assets are procedural (built in code), plus CC0 low-poly vehicle and building models from Kenney from W11; we are not using AI-generated assets.

| Week | Engineering | Assets | Integration / milestone | Owner |
|---|---|---|---|---|
| W9 (Oct 26 – Nov 1), done | Emergency units in traffic; yielding (pull over, pass, merge back) and junction pre-emption; boids debug view; every building an address with its own entrance; trips door to door with left turns in and out; leisure trips; accidents and lane closures on one lane, passed one side at a time; dispatch core, scoring, difficulty, best scores; menu, HUD, end screen with response chart; random accidents; call alerts and edge arrows; reassigning returning units; shortcuts, ride along; coverage map; station placement; siren-aware unit ETAs | Ambulance, fire engine and police models; siren lights; station buildings; drawn entrances; block fill (sheds, kiosks, tanks, fences); siren audio, chime and UI sounds | MVP 2.0 integrated Oct 29, submitted Nov 2 | Both |
| W10 (Nov 2 – 8) | Mid-crit feedback; mutual aid (send from further away when local units are busy); smarter turn-round for re-sent units; cars queued at a closure reroute | Incident animations (smoke, hazard lights, flares) | Play-test with 3+ outside players | Ananya: mutual aid, play-test; Mihir: turn-round, closure rerouting |
| W11 (Nov 9 – 15) | Multi-unit calls (crash: police and ambulance; fire: engine and ambulance); severity priority; ambulances take patients to hospital | Icons; sound mix; on-scene animations; Kenney model pipeline | Merge end of week | Ananya: multi-unit, severity; Mihir: hospital trips, sound, icons |
| W12 (Nov 16 – 22) | Cars reroute mid-trip on live costs; yielding tuned at junctions and on arterials; first-shift tutorial | Kenney vehicles (animated) and buildings; night lighting; rain and fog; buses | Feature-complete build | Mihir: rerouting, yielding, vehicles; Ananya: tutorial, buildings |
| W13 (Nov 23 – 29) | Thanksgiving, light week: performance (1000 cars plus units), difficulty tuning, experiments for the report (yielding on/off, ETA accuracy, dispatch policy) | UI pass; pedestrians, parked cars, ambient sound; quality setting | Feature freeze Nov 29 | Mihir: performance, experiments; Ananya: tuning, map |
| W14 (Nov 30 – Dec 6) | Could-have only if ahead: adaptive signals, two-lane arterials | Video, report figures, final slides | Release candidate Dec 6 | Both |
| **W15 (Dec 7 – 13): Buffer** | **No new features.** Bug fixes, documentation, README, final report and video | | Final submission | Both |

## Known issues (traffic and map side)

- **Unit ETAs are free-flow times.** A unit arrives within about -7% to +16% of its ETA at the morning peak (10th to 90th percentile). Returning units have their sirens off, so they drive like ordinary cars.
- **One lane per direction.** Making way for a siren is drawn as a 2 m move onto the shoulder; units pass only cars that have pulled over.
- **Lane closures are slow.** One side goes at a time, so a 65 m closure carries about 650–700 cars an hour in total. On a busy arterial at the peak, queues build. Cars reroute only when the incident is placed, not while they wait. Fix planned for W10.
- **Blocked stretches keep 18 m from junctions** (the plan said 12 m), so the longest vehicle can stop before them.
- **A road closure still admits trips that start or end on that street.**
- **Coverage counts a returning unit from its next junction**, without the time it needs to get there or turn round.
- **Station placement is limited.** One move per shift, before it starts. A station can only go onto a building or car park on a block laid out lot by lot, not onto a park, the mall, a yard or a podium block. The old station building stays as an ordinary building.
- **Siren audio is one voice** (the unit nearest the camera). It starts after the first click or key press, as browsers require.
- **At 300× the browser drops sim time when it falls behind.** A step takes about 0.45 ms at the morning peak and about 0.55 ms with 12 units and two incidents, so 300× needs about 28 ms of simulation per frame.
- **Starting a shift reloads the page** at the shift's hour (with half an hour of traffic run first), unless the city is already there. A station move is carried over; anything else set before the reload (incidents, camera) is not.
- **A unit sent while driving back turns round at its next junction** (no U-turn mid-street), so its first few hundred metres can go the wrong way. Fix planned for W10.
- **Random accidents can land on any street at least 48 m long** except a station's own street, weighted by the cars on it. In Dispatcher mode an unanswered crash call counts as missed like any other, and its accident then clears 20 minutes later.
- **Best scores are kept in this browser only** (localStorage), per mode, shift and difficulty.
- **Call alerts stay 6 real seconds** whatever the sim speed; at 300× several calls can come in at once and only the newest 3 pop-ups show (every call is still in the list and has a pin).
- **The gridlock guard stays as a last resort.** It removes a car stopped for 3 minutes. It removed none in the tests or in a sweep of 5 scenarios with 24 units each, but it is still there.
- **After an error the page has to be reloaded.** The error panel shows what went wrong but cannot resume the simulation.
